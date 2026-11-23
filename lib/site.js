// 音乐站的 Host 侧客户端：维护访问凭证、登录 Cookie，代理搜索/榜单/取音频直链。

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 上游站点。如需换镜像只改这一处。 */
export const UPSTREAM = 'https://dl.74520.xyz';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 凭证失效时最多重试一次。 */
const MAX_RETRY = 1;

/**
 * 站点用两道关卡：
 *  1. 页面内嵌的 x-client-token，随请求发到 X-Client-Token 头，防脚本直连；
 *  2. 登录后的会话 Cookie，决定能否搜索/取链。
 * 两者都要有，缺任何一个都会被 401/403 挡掉。
 */
export class MusicSite {
  constructor(options = {}) {
    this.base = options.base || UPSTREAM;
    this.timeoutMs = options.timeoutMs || 20_000;
    this.cookieFile = options.cookieFile || defaultCookieFile();
    /** @type {string} 站点页面下发的客户端凭证 */
    this.clientToken = '';
    /** @type {string} 登录会话 Cookie，持久化到磁盘 */
    this.cookie = '';
    /** @type {{ authenticated: boolean, user: any, quota: any, providers: any }} */
    this.auth = { authenticated: false, user: null, quota: null, providers: null };
    /** 正在进行的凭证预热，避免并发重复请求 */
    this.refreshing = null;
    this.loaded = false;
  }

  /** 读取磁盘上的 Cookie；只做一次。 */
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.cookieFile, 'utf8');
      const value = raw.trim();
      if (value) this.cookie = value;
    } catch {
      // 文件不存在属于首次使用，不算错误
    }
  }

  async saveCookie() {
    const dir = path.dirname(this.cookieFile);
    await fs.mkdir(dir, { recursive: true });
    // 只给当前用户读写：Cookie 等价于登录态
    await fs.writeFile(this.cookieFile, this.cookie, { encoding: 'utf8', mode: 0o600 });
  }

  async clearCookie() {
    this.cookie = '';
    try {
      await fs.rm(this.cookieFile, { force: true });
    } catch {
      // 清理失败不影响内存态已清空
    }
  }

  /** 带超时的 fetch，统一注入 UA 与凭证头。 */
  async request(pathname, init = {}) {
    const url = pathname.startsWith('http') ? pathname : this.base + pathname;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs || this.timeoutMs);
    const headers = {
      'user-agent': UA,
      accept: 'application/json, text/plain, */*',
      referer: this.base + '/',
      origin: this.base,
      ...(init.headers || {}),
    };
    if (this.clientToken) headers['x-client-token'] = this.clientToken;
    if (this.cookie) headers.cookie = this.cookie;

    try {
      const res = await fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
        redirect: 'manual',
      });
      this.captureCookies(res);
      const text = await res.text();
      return { status: res.status, text };
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw Object.assign(new Error('请求上游站点超时'), { code: 'upstream-timeout' });
      }
      throw Object.assign(new Error(`连接上游站点失败：${error?.message || error}`), { code: 'upstream-failed' });
    } finally {
      clearTimeout(timer);
    }
  }

  /** 合并上游下发的 Set-Cookie。 */
  captureCookies(res) {
    const list = res.headers.getSetCookie?.() ?? [];
    if (!list.length) return;
    const jar = parseCookies(this.cookie);
    for (const line of list) {
      const pair = line.split(';')[0] || '';
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (!name) continue;
      // 值为空通常表示服务端要求删除
      if (value === '' || /max-age=0/i.test(line)) jar.delete(name);
      else jar.set(name, value);
    }
    this.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** 拉取页面里的 x-client-token。 */
  async refreshClientToken() {
    const res = await this.request('/', { headers: { accept: 'text/html' } });
    const m = res.text.match(/name="x-client-token"\s+content="([^"]+)"/);
    this.clientToken = m ? m[1] : '';
    return this.clientToken;
  }

  /** 首次使用时预热：拿凭证 + 探测登录态。 */
  async ensureReady() {
    await this.load();
    if (!this.clientToken) await this.refreshClientToken();
    await this.refreshAuth();
  }

  /** 查询当前登录态。 */
  async refreshAuth() {
    const r = await this.request('/api/auth/me');
    const json = safeJson(r.text);
    const data = json?.data || {};
    this.auth = {
      authenticated: Boolean(data.authenticated),
      user: data.user || null,
      quota: data.quota || null,
      providers: data.providers || null,
      requireLogin: Boolean(data.require_login),
      banned: Boolean(data.banned),
    };
    return this.auth;
  }

  /**
   * 业务请求：凭证或登录态过期时自动刷新一次再重试。
   * 站点在 401/403 时既可能是 token 过期，也可能是登录态丢失，所以两者都刷。
   */
  async call(pathname, init = {}, attempt = 0) {
    if (!this.clientToken) {
      await this.load();
      await this.refreshClientToken();
    }
    const res = await this.request(pathname, init);
    if ((res.status === 401 || res.status === 403) && attempt < MAX_RETRY) {
      this.clientToken = '';
      await this.refreshClientToken();
      await this.refreshAuth();
      return this.call(pathname, init, attempt + 1);
    }
    return res;
  }

  /** 搜索歌曲。q 为关键词，platform='all' 时站点会聚合多个平台。 */
  async search(query, platform = 'all', limit = 12) {
    const params = new URLSearchParams({ q: String(query || ''), platform: String(platform || 'all'), limit: String(limit) });
    const r = await this.call('/api/music/search?' + params.toString());
    return unwrap(r, '搜索失败');
  }

  /**
   * 发现广场首页：分类列表 + 榜单卡片 + 推荐歌单。
   * category 传「全部」或不传即默认分类。
   */
  async home(category) {
    const cat = String(category || '').trim();
    const query = cat && cat !== '全部' ? '?' + new URLSearchParams({ category: cat }).toString() : '';
    const r = await this.call('/api/music/discover/home' + query);
    return unwrap(r, '获取发现页失败');
  }

  /** 某个歌单的曲目。 */
  async playlist(platform, id, limit = 100) {
    const params = new URLSearchParams({
      platform: String(platform || ''),
      playlist_id: String(id || ''),
      limit: String(limit || 100),
    });
    const r = await this.call('/api/music/discover/playlist?' + params.toString());
    return unwrap(r, '获取歌单失败');
  }

  /**
   * 解析歌曲页面链接，拿到音质列表。
   * 搜索接口不返回 audio_qualities，只有这里才有，且每条音质带 song_id/media_mid，
   * 后续取播放地址必须用它们。
   */
  async parse(url) {
    const r = await this.call('/api/parse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: String(url || '') }),
    });
    return unwrap(r, '解析歌曲失败');
  }

  /** 某个榜单的曲目。 */
  async chart(platform) {
    const r = await this.call('/api/music/discover/chart/' + encodeURIComponent(String(platform || '')));
    return unwrap(r, '获取榜单曲目失败');
  }

  /**
   * 取某首歌可播放的直链。
   * 站点将各音质标记为 lazy，真正播放前必须逐个 resolve。
   */
  async resolve(track, quality) {
    // 搜索接口返回的字段名是 id，规范化为 song_id 时前端可能原样回传，
    // 这里两种都认，避免参数变成空串导致 422。
    const songId = track.song_id || track.id || '';
    const body = {
      platform: track.platform || '',
      song_id: String(songId || ''),
      media_mid: track.media_mid || '',
      quality: quality || track.quality || '',
      format: track.format || 'mp3',
      title: track.title || 'audio',
      author: track.artist || track.author || '',
      for_play: true,
    };
    const r = await this.call('/api/music/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = unwrap(r, '获取播放地址失败');
    // 站点返回的是自身的相对地址 /api/download?token=…，补成绝对地址才能转发
    const raw = String(data?.url || '');
    if (raw && !/^https?:\/\//i.test(raw)) {
      data.url = this.base + (raw.startsWith('/') ? raw : '/' + raw);
    }
    return data;
  }

  /**
   * 为一首歌拿到最终可播放的地址。
   * 流程：搜索结果的页面链接 → /api/parse 拿音质列表 → 挑一档 → resolve 取直链。
   * 搜索接口本身不带音质信息，所以必须经过 parse。
   */
  async resolveTrack(track, preferredQuality) {
    const pageUrl = String(track?.url || '');
    let qualities = Array.isArray(track?.audio_qualities) ? track.audio_qualities.filter(Boolean) : [];

    // 搜索结果 timeline 里没有音质，用页面链接补
    if (!qualities.length && pageUrl) {
      const parsed = await this.parse(pageUrl);
      qualities = Array.isArray(parsed?.audio_qualities) ? parsed.audio_qualities.filter(Boolean) : [];
      // parse 回填更准确的元信息，title/author 会影响部分平台的取链结果
      track = { ...track, title: parsed?.title || track?.title, artist: parsed?.author || track?.artist };
    }
    if (!qualities.length) {
      throw Object.assign(new Error('这首歌没有可用音质'), { code: 'upstream-error' });
    }

    // 优先无损，其次高码率，最后兜底；用户显式指定则尊重指定。
    // 注意两点：
    // 1. 不能因为「某档已有直链」就跳过更高音质 —— site 给标准档预置了直链，
    //    按那个逻辑会永远播不出无损；
    // 2. 音质标识各平台不统一：QQ 用 flac/320mp3，网易云用 lossless/exhigh/higher/standard，
    //    所以这里同时按 quality 标识和 format 兜底判断档次。
    const ordered = [...qualities].sort((a, b) => qualityRank(a) - qualityRank(b));
    const preferred = preferredQuality ? ordered.find((q) => q.quality === preferredQuality) : null;
    const attempts = preferred ? [preferred, ...ordered.filter((q) => q !== preferred)] : ordered;

    // 逐档降级：某档没权限（站点返回「该歌曲暂不支持所选音质」）就换下一档，
    // 否则少数只给低音质的歌会直接播不了。
    let lastError = null;
    for (const chosen of attempts) {
      try {
        // 已有直链就不用再花一次配额
        if (chosen.url && !chosen.lazy) {
          const url = /^https?:\/\//i.test(chosen.url) ? chosen.url : this.base + chosen.url;
          return { url, format: chosen.format || '', quality: chosen.quality || '' };
        }
        const data = await this.resolve(
          {
            ...track,
            ...chosen,
            platform: chosen.platform || track?.platform,
            song_id: chosen.song_id || track?.song_id || track?.id,
            media_mid: chosen.media_mid || track?.media_mid || '',
            artist: track?.artist,
          },
          chosen.quality,
        );
        const url = String(data?.url || '');
        if (url) {
          return { url, format: data?.format || chosen.format || '', quality: data?.quality || chosen.quality || '' };
        }
        lastError = new Error('没有可用的播放地址');
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || Object.assign(new Error('这首歌暂时无法播放'), { code: 'upstream-error' });
  }

  /** 账号密码登录。成功后会保存 Cookie。 */
  async login(account, password) {
    const r = await this.call('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: String(account || ''), password: String(password || '') }),
    });
    const json = safeJson(r.text);
    if (r.status >= 400) {
      throw Object.assign(new Error(json?.detail || json?.msg || '登录失败'), { code: 'auth-failed' });
    }
    await this.saveCookie();
    await this.refreshAuth();
    return this.auth;
  }

  async logout() {
    try {
      await this.call('/api/auth/logout', { method: 'POST' });
    } catch {
      // 上游退出失败也要清掉本地登录态
    }
    await this.clearCookie();
    await this.refreshAuth();
    return this.auth;
  }

  /**
   * 只用给定 Cookie 试探登录态，不改动当前实例状态。
   * 浏览器登录轮询时用来判断「用户是否已经登好」。
   */
  async probeCookie(cookie) {
    const value = String(cookie || '').trim();
    if (!value) return { authenticated: false, user: null, quota: null };
    if (!this.clientToken) await this.refreshClientToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.base + '/api/auth/me', {
        headers: {
          'user-agent': UA,
          accept: 'application/json, text/plain, */*',
          referer: this.base + '/',
          ...(this.clientToken ? { 'x-client-token': this.clientToken } : {}),
          cookie: value,
        },
        signal: controller.signal,
        redirect: 'manual',
      });
      const json = safeJson(await res.text());
      const data = json?.data || {};
      return {
        authenticated: Boolean(data.authenticated),
        user: data.user || null,
        quota: data.quota || null,
      };
    } catch {
      return { authenticated: false, user: null, quota: null };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 接管一份来自浏览器的 Cookie。
   * 浏览器登录（OAuth）结束后用这个把登录态搬进来，之后与账号密码登录完全等价。
   * @returns {Promise<any>} 刷新后的登录态
   */
  async adoptCookie(cookie) {
    const value = String(cookie || '').trim();
    if (!value) throw Object.assign(new Error('浏览器没有提供有效的登录凭据'), { code: 'invalid' });
    await this.load();
    this.cookie = value;
    // 凭证可能也过期了，一并刷新，避免刚登录就 403
    this.clientToken = '';
    await this.refreshClientToken();
    const auth = await this.refreshAuth();
    if (!auth.authenticated) {
      // 没换成登录态就别落盘，避免留下半残 cookie
      this.cookie = '';
      return auth;
    }
    await this.saveCookie();
    return auth;
  }
}

/**
 * 音质档次排序：数字越小越高。
 * 各平台标识不统一（QQ 的 flac/320mp3、网易云的 lossless/exhigh/higher/standard），
 * 所以先看 quality 标识，认不出再看 format。
 */
export function qualityRank(entry) {
  const q = String(entry?.quality || '').toLowerCase();
  const f = String(entry?.format || '').toLowerCase();
  const byQuality = {
    flac: 0,
    lossless: 0,
    hires: 0,
    '320mp3': 1,
    exhigh: 1,
    '192mp3': 2,
    higher: 2,
    '128mp3': 3,
    standard: 3,
    '96aac': 4,
  };
  if (q in byQuality) return byQuality[q];
  // 认不出 quality 就按格式推断，避免无损被排到低优先级
  if (f === 'flac' || f === 'ape' || f === 'wav') return 0;
  if (f === 'm4a' || f === 'aac') return 4;
  return 5;
}

/** 解析 Cookie 字符串为 Map。 */
export function parseCookies(raw) {  const jar = new Map();
  for (const part of String(raw || '').split(';')) {
    const pair = part.trim();
    if (!pair) continue;
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
  return jar;
}

export function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 解包站点的 {code,msg,data} 信封。 */
export function unwrap(r, fallbackMessage) {
  const json = safeJson(r.text);
  if (r.status >= 400) {
    const detail = json?.detail;
    const message =
      (typeof detail === 'string' && detail) ||
      (Array.isArray(detail) && detail[0]?.msg) ||
      json?.msg ||
      fallbackMessage;
    throw Object.assign(new Error(message), { code: r.status === 401 || r.status === 403 ? 'need-login' : 'upstream-error' });
  }
  if (!json) throw Object.assign(new Error(fallbackMessage), { code: 'upstream-error' });
  return json.data ?? json;
}

/** Cookie 落盘位置：跟随 DSH 数据根目录。 */
export function defaultCookieFile() {
  const configured = String(process.env.DSH_HOME || '').trim();
  const home = configured ? path.resolve(configured.replace(/^~(?=$|[\\/])/, os.homedir())) : path.join(os.homedir(), '.dsh');
  return path.join(home, 'music-player', 'session.cookie');
}
