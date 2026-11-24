// Host 半部：注册音乐站代理接口，登录态与前端保持一致。
//
// 前端不直接访问上游站点，原因有三：
//  1. 上游页面禁止被 iframe 嵌入，也不能跨域带 Cookie 调接口；
//  2. x-client-token 与登录 Cookie 属于敏感凭据，只应存在 Host 侧磁盘；
//  3. 音频直链通常校验 Referer，由 Host 转发才能稳定播放并支持拖动进度。

import { MusicSite, songIdFromUrl } from './lib/site.js';
import { BrowserLogin, browserLoginInfo } from './lib/browser-login.js';

export const name = 'music-player';
export const inject = ['webServer', 'connection'];

const ROUTE = '/api/music-player';
const AUDIO_ROUTE = '/api/music-player/audio';
const MAX_BODY_BYTES = 16 * 1024;
/** 浏览器登录轮询间隔，前端按这个节奏来问 */
const BROWSER_POLL_MS = 1500;

/** 已换取的音频地址登记表：只允许转发自己换到的链接，避免变成开放代理。 */
const audioRegistry = new Map();
const REGISTRY_LIMIT = 300;

function rememberAudio(url) {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  if (audioRegistry.size >= REGISTRY_LIMIT) {
    const oldest = audioRegistry.keys().next().value;
    if (oldest) audioRegistry.delete(oldest);
  }
  audioRegistry.set(id, url);
  return id;
}

function sendJson(res, status, value) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(value));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('请求内容过大'), { code: 'too-large' });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { code: 'bad-json' });
  }
}

/** 业务错误到 HTTP 状态码的映射。 */
function statusOf(error) {
  const code = error?.code;
  if (code === 'need-login' || code === 'auth-failed' || code === 'login-cancelled') return 401;
  if (code === 'too-large') return 413;
  if (code === 'bad-json' || code === 'invalid') return 400;
  if (code === 'no-browser') return 501;
  if (code === 'login-timeout' || code === 'browser-start-failed') return 504;
  if (code === 'upstream-timeout') return 504;
  return 502;
}

export function apply(ctx) {
  const site = new MusicSite();
  /** @type {BrowserLogin | null} 当前进行中的浏览器登录会话 */
  let browserLogin = null;

  /**
   * 音质偏好。
   *
   * 默认「balanced」：不追无损，优先能连续播。
   * 原因是上游站点对单连接限速（实测约 1.3~1.7 Mbps），
   * 而无损 FLAC 常在 900~1100 kbps，几乎吃满带宽；
   * 网络稍有抖动，浏览器缓冲就耗尽，表现为「卡一下再继续」。
   * 320k 只需约 320 kbps，有 4 倍余量，实际听感几乎无差。
   *
   * 'lossless' 才强制选最高档；'auto' 由后端按码率阈值筛选。
   */
  let qualityMode = 'balanced';

  const QUALITY_MODES = {
    // 只允许估算码率 <= 384 kbps 的档位（即 320k 及以下）
    balanced: { maxBitrate: 384, maxRank: 2 },
    // 只允许无损及以上
    lossless: { maxBitrate: Infinity, maxRank: 0 },
    // 完全不限制，选站点给的最高档
    highest: { maxBitrate: Infinity, maxRank: Infinity },
  };

  const authPayload = (auth) => ({
    authenticated: Boolean(auth?.authenticated),
    user: auth?.user || null,
    quota: auth?.quota || null,
  });

  /** 关掉浏览器登录会话，释放端口与子进程。 */
  const closeBrowserLogin = async () => {
    const session = browserLogin;
    browserLogin = null;
    if (session) await session.dispose().catch(() => {});
  };

  /** 每类操作对应一个处理函数，参数都从请求体取。 */
  const actions = {
    async status() {
      await site.ensureReady();
      return {
        authenticated: site.auth.authenticated,
        user: site.auth.user,
        quota: site.auth.quota,
        providers: site.auth.providers,
        requireLogin: site.auth.requireLogin,
        banned: site.auth.banned,
        upstream: site.base,
        /** 前端据此决定要不要显示「浏览器登录」按钮，并提示用的是哪个浏览器 */
        browserLoginSupported: browserLoginInfo().supported,
        browser: browserLoginInfo(),
        /** 当前音质偏好，前端用它回显选中的档位 */
        qualityMode,
      };
    },
    async login(body) {
      const auth = await site.login(body.account, body.password);
      return { authenticated: auth.authenticated, user: auth.user, quota: auth.quota };
    },
    /**
     * 打开浏览器登录。
     * 第 1 次调用负责拉起浏览器；之后由前端轮询 `browserPoll` 等结果。
     */
    async browserLogin() {
      // 已有会话就复用，避免连点开出一堆窗口
      if (browserLogin && !browserLogin.done) {
        return { started: true, pollMs: BROWSER_POLL_MS, alreadyRunning: true };
      }
      await closeBrowserLogin();
      const session = new BrowserLogin({
        base: site.base,
        // 只做验证：真正落盘在 browserPoll 成功那一刻统一处理
        verify: (cookie) => site.probeCookie(cookie),
      });
      try {
        await session.start();
      } catch (error) {
        await session.dispose().catch(() => {});
        throw error;
      }
      browserLogin = session;
      return { started: true, pollMs: BROWSER_POLL_MS };
    },
    /** 轮询浏览器登录结果；成功时接管登录态并关闭浏览器。 */
    async browserPoll() {
      const session = browserLogin;
      if (!session) {
        // 插件重载或会话已结束，让前端回到普通状态
        return { authenticated: site.auth.authenticated, pending: false, closed: true };
      }
      try {
        const result = await session.poll();
        if (result.authenticated && session.lastCookie) {
          const auth = await site.adoptCookie(session.lastCookie);
          await closeBrowserLogin();
          return { ...authPayload(auth), pending: false };
        }
        return { authenticated: false, pending: Boolean(result.pending) };
      } catch (error) {
        await closeBrowserLogin();
        throw error;
      }
    },
    async browserCancel() {
      await closeBrowserLogin();
      return { cancelled: true };
    },
    async logout() {
      await closeBrowserLogin();
      const auth = await site.logout();
      return { authenticated: auth.authenticated, user: auth.user, quota: auth.quota };
    },
    async search(body) {
      await site.ensureReady();
      const data = await site.search(body.query, body.platform, body.limit);
      return { items: normalizeItems(data) };
    },
    async home() {
      await site.ensureReady();
      return await site.home();
    },
    /** 发现广场：分类可切换，返回榜单卡片与推荐歌单。 */
    async discover(body) {
      await site.ensureReady();
      const data = await site.home(body.category);
      return {
        category: String(data?.category || '全部'),
        categories: Array.isArray(data?.categories) ? data.categories.map(String) : [],
        charts: (Array.isArray(data?.charts) ? data.charts : []).map((c) => ({
          key: String(c?.key || ''),
          title: String(c?.title || ''),
          subtitle: String(c?.subtitle || ''),
          platform: String(c?.platform || ''),
          platformLabel: String(c?.platform_label || ''),
          badge: String(c?.badge || ''),
          cover: String(c?.cover || ''),
          preview: (Array.isArray(c?.preview_tracks) ? c.preview_tracks : [])
            .slice(0, 3)
            .map((t) => `${t?.title || ''}${t?.artist ? ' · ' + t.artist : ''}`),
        })),
        playlists: (Array.isArray(data?.playlists) ? data.playlists : []).map((p) => ({
          id: String(p?.playlist_id || ''),
          platform: String(p?.platform || ''),
          platformLabel: String(p?.platform_label || ''),
          title: String(p?.title || ''),
          cover: String(p?.cover || ''),
          playCount: Number(p?.play_count || 0),
          trackCount: Number(p?.track_count || 0),
          creator: String(p?.creator || ''),
        })),
      };
    },
    /** 打开某个歌单，取回曲目列表。 */
    async playlist(body) {
      await site.ensureReady();
      const data = await site.playlist(body.platform, body.id, body.limit);
      return {
        title: String(data?.title || ''),
        cover: String(data?.cover || ''),
        total: Number(data?.total || 0),
        items: normalizeItems(data),
      };
    },
    async chart(body) {
      await site.ensureReady();
      return normalizeItems(await site.chart(body.platform));
    },
    async resolve(body) {
      await site.ensureReady();
      const track = body.track || {};
      // 搜索结果不带音质，走 parse → resolve 的完整链路。
      // 音质策略，优先级从高到低：
      //   1) 前端指定了具体音质标识 -> 只用那一档；
      //   2) lowQuality（卡顿自愈）-> 强制选低码率档，别再给无损；
      //   3) 否则按当前偏好模式过滤档位。
      const limits = body.lowQuality
        ? { maxBitrate: 200, maxRank: 3 }
        : QUALITY_MODES[qualityMode] || QUALITY_MODES.balanced;
      const data = await site.resolveTrack(track, body.quality, limits);
      const url = String(data?.url || '');
      if (!url) throw Object.assign(new Error('没有可用的播放地址'), { code: 'upstream-error' });
      // 不把原始地址交给前端，改发本地转发地址：既避开 Referer 校验，也避免暴露上游域
      return {
        src: `${AUDIO_ROUTE}?k=${rememberAudio(url)}`,
        format: data?.format || '',
        quality: data?.quality || '',
      };
    },
    /** 读/写音质偏好。 */
    async quality(body) {
      if (typeof body.mode === 'string') {
        if (body.mode in QUALITY_MODES) qualityMode = body.mode;
      }
      return { mode: qualityMode, modes: Object.keys(QUALITY_MODES) };
    },
    /** 「我喜欢」列表：与站点网页端共用同一份数据。 */
    async favorites() {
      await site.ensureReady();
      const data = await site.favorites();
      return {
        items: data.items.map((t) => ({
          trackKey: String(t?.track_key || ''),
          title: String(t?.title || ''),
          artist: String(t?.artist || ''),
          album: String(t?.album || ''),
          platform: String(t?.platform || ''),
          songId: String(t?.song_id || ''),
          url: String(t?.url || ''),
          cover: String(t?.cover || ''),
          duration: Number(t?.duration || 0) || 0,
        })),
        keys: data.keys,
      };
    },
    /** 切换收藏。站点按 track_key 自行判断加入还是移除。 */
    async favorite(body) {
      await site.ensureReady();
      const result = await site.toggleFavorite(body.track || {});
      return { liked: result.liked, trackKey: result.track_key, count: result.count };
    },
  };

  const web = ctx.get('webServer');
  const connection = ctx.get('connection');

  /** 准入检查：复用 Harness 的 Host/Origin 与登录态防护。 */
  const rejected = (req, res) => {
    const rejection = connection?.requestRejection?.(req);
    if (rejection === undefined || rejection === null || rejection === false) return false;
    res.statusCode = typeof rejection === 'number' ? rejection : rejection.statusCode || 401;
    res.end();
    return true;
  };

  if (!web) return;

  const dispose = web.register({
    kind: 'exact',
    path: ROUTE,
    async handler(req, res) {
      if (rejected(req, res)) return;
      try {
        if (req.method === 'GET') {
          return sendJson(res, 200, await actions.status());
        }
        if (req.method !== 'POST') return sendJson(res, 405, { error: '仅支持 GET 与 POST' });
        const contentType = String(req.headers['content-type'] || '').toLowerCase();
        if (!contentType.includes('application/json')) return sendJson(res, 415, { error: '请求需为 application/json' });
        const body = await readJsonBody(req);
        const action = actions[String(body.type || '')];
        if (!action) return sendJson(res, 400, { error: `未知操作：${body.type || '(空)'}` });
        return sendJson(res, 200, await action(body));
      } catch (error) {
        return sendJson(res, statusOf(error), { error: String(error?.message || error), code: String(error?.code || '') });
      }
    },
  });
  ctx.effect(() => dispose, 'music-player route');

  // 音频转发：支持 Range，浏览器才能拖动进度条。
  const disposeAudio = web.register({
    kind: 'exact',
    path: AUDIO_ROUTE,
    async handler(req, res) {
      if (rejected(req, res)) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405;
        return res.end();
      }
      const url = new URL(req.url || '/', 'http://localhost');
      const upstream = audioRegistry.get(String(url.searchParams.get('k') || ''));
      if (!upstream) {
        res.statusCode = 404;
        return res.end();
      }
      try {
        const headers = {
          // 上游 CDN 常校验来源，这里补齐站点自身的 Referer
          referer: site.base + '/',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36',
        };
        // resolve 给出的是站点自身的 /api/download?token=…，需要带登录 Cookie 才放行
        if (site.cookie) headers.cookie = site.cookie;
        if (req.headers.range) headers.range = String(req.headers.range);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        let upstreamRes;
        try {
          upstreamRes = await fetch(upstream, { headers, signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }

        if (!upstreamRes.ok && upstreamRes.status !== 206) {
          res.statusCode = upstreamRes.status === 403 || upstreamRes.status === 401 ? 403 : 502;
          return res.end();
        }

        res.statusCode = upstreamRes.status;
        for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
          const value = upstreamRes.headers.get(key);
          if (value) res.setHeader(key, value);
        }
        if (!res.getHeader('content-type')) res.setHeader('content-type', 'audio/mpeg');
        res.setHeader('cache-control', 'private, max-age=3600');

        if (req.method === 'HEAD') return res.end();

        // 直接把上游字节流转发到响应，避免整首歌读进内存
        const reader = upstreamRes.body?.getReader?.();
        if (!reader) {
          const buffer = Buffer.from(await upstreamRes.arrayBuffer());
          res.end(buffer);
          return;
        }
        const pump = async () => {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.write(Buffer.from(value))) {
              await new Promise((resolve) => res.once('drain', resolve));
            }
          }
          res.end();
        };
        req.on('close', () => {
          reader.cancel().catch(() => {});
        });
        await pump();
      } catch (error) {
        if (!res.headersSent) {
          res.statusCode = 502;
          res.end();
        } else {
          res.end();
        }
      }
    },
  });
  ctx.effect(() => disposeAudio, 'music-player audio route');

  // 插件被卸载/重载时，别留下孤儿浏览器进程
  ctx.effect(() => () => {
    if (browserLogin) {
      const session = browserLogin;
      browserLogin = null;
      session.dispose().catch(() => {});
    }
  }, 'music-player browser login cleanup');
}

/** 把站点返回的搜索/榜单结果统一成前端好用的结构。 */
export function normalizeItems(data) {
  const list = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
  return list.map((item) => {
    const url = String(item.url || '');
    // 歌单曲目没有 song_id，从链接里补一个，否则收藏时算出 `qqmusic:` 这种空键
    const songId = String(item.song_id || item.id || songIdFromUrl(url) || '');
    const platform = String(item.platform || '');
    // 只有真正拿到 ID 才拼 `平台:ID`；拿不到就留空，让上层退回用 url 当键
    const derived = platform && songId ? `${platform}:${songId}` : '';
    return {
      track_key: String(item.track_key || derived || ''),
      song_id: songId,
      platform,
      title: String(item.title || '未命名歌曲'),
      artist: String(item.artist || item.author || ''),
      album: String(item.album || ''),
      cover: String(item.cover || ''),
      duration: Number(item.duration || 0),
      /** 各音质条目的原始信息，取链时要用 */
      audio_qualities: Array.isArray(item.audio_qualities) ? item.audio_qualities : [],
      url,
    };
  });
}

