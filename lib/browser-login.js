// 浏览器登录：拉起一个受控浏览器窗口，让用户在真实页面里完成登录，
// 登录成功后通过 CDP 读回 Cookie 交给 Host 使用。
//
// 为什么必须这么做：站点的 OAuth 回跳地址固定在它自己的域名上，改不成指向本地，
// 所以用不了「本地起回调服务器收 code」那一套；而会话 Cookie 往往是 HttpOnly，
// 页面脚本读不到。CDP 是唯一既能读到 HttpOnly Cookie、又不需要用户手动复制粘贴的通道。

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 默认给用户 5 分钟走完 OAuth 或注册。 */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
/** 浏览器启动后等 DevToolsActivePort 的上限。 */
const START_TIMEOUT_MS = 25_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 按优先级列出本机可能的 Chromium 系浏览器。 */
export function browserCandidates() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  return [
    path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
    local && path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
  ].filter(Boolean);
}

/** 各 Chromium 系浏览器的可执行文件候选，键为注册表 ProgId 里的关键字。 */
const BROWSER_EXES = {
  MSEdge: () => {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    return [
      path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
    ];
  },
  Chrome: () => {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    return [
      path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
      local && path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
    ].filter(Boolean);
  },
  Brave: () => {
    const local = process.env.LOCALAPPDATA || '';
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    return [
      local && path.join(local, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
      path.join(pf, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
    ].filter(Boolean);
  },
  Vivaldi: () => {
    const local = process.env.LOCALAPPDATA || '';
    return [local && path.join(local, 'Vivaldi\\Application\\vivaldi.exe')].filter(Boolean);
  },
};

/** ProgId 关键字 -> 给用户看的名字。 */
const BROWSER_LABELS = { MSEdge: 'Edge', Chrome: 'Chrome', Brave: 'Brave', Vivaldi: 'Vivaldi' };

/**
 * 读系统默认浏览器。
 * 用注册表 UserChoice 的 ProgId 判断，这比「找哪个 exe 存在」更贴近
 * 用户实际双击链接时打开的浏览器。
 */
export function defaultBrowser() {
  if (process.platform !== 'win32') return null;
  try {
    const key =
      'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice';
    const out = execFileSync('reg', ['query', key, '/v', 'ProgId'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const progId = (out.match(/ProgId\s+REG_SZ\s+(\S+)/) || [])[1] || '';
    if (!progId) return null;
    for (const [key, exes] of Object.entries(BROWSER_EXES)) {
      if (progId.includes(key)) return { name: BROWSER_LABELS[key] || key, progId, exes: exes() };
    }
    // Firefox 等非 Chromium：能识别但不是我们能挂 CDP 的
    if (/Firefox/i.test(progId)) return { name: 'Firefox', progId, exes: [] };
    return { name: progId, progId, exes: [] };
  } catch {
    return null;
  }
}

async function firstExisting(files) {
  for (const file of files) {
    try {
      await fs.access(file);
      return file;
    } catch {
      // 换下一个候选
    }
  }
  return '';
}

/**
 * 选一个能用来登录的浏览器：优先用户设置的默认浏览器。
 * 默认浏览器是 Firefox 之类挂不了 CDP 的，再退回家里的 Chromium 系。
 */
async function pickBrowser() {
  const preferred = defaultBrowser();
  if (preferred?.exes?.length) {
    const exe = await firstExisting(preferred.exes);
    if (exe) {
      // 记下用的是不是默认浏览器，便于界面提示与排查
      return exe;
    }
  }
  // 默认浏览器不可用（或不是 Chromium 系），退回家里的其它浏览器
  return await firstExisting(browserCandidates());
}

/** 极简 CDP 客户端：请求-响应配对，够用即可。 */
function connectCdp(wsUrl, openTimeoutMs = 12_000) {
  const WS = globalThis.WebSocket;
  if (typeof WS !== 'function') throw new Error('当前运行环境缺少 WebSocket，无法控制浏览器');

  const ws = new WS(wsUrl);
  const pending = new Map();
  let nextId = 0;

  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接浏览器调试端口超时')), openTimeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('无法连接浏览器调试端口'));
    });
  });
  // 没人 await 时不至于抛未处理拒绝
  opened.catch(() => {});

  ws.addEventListener('message', (event) => {
    let msg = null;
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    const waiter = msg?.id ? pending.get(msg.id) : null;
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message || '浏览器返回错误'));
    else waiter.resolve(msg.result);
  });

  const send = (method, params = {}, timeoutMs = 15_000) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        pending.delete(id);
        reject(error);
        return;
      }
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`浏览器命令超时：${method}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });

  return {
    opened,
    send,
    close() {
      try {
        ws.close();
      } catch {
        // 已断开
      }
    },
  };
}

async function httpJson(port, pathname) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`调试端口返回 ${res.status}`);
  return await res.json();
}

/** 读 DevToolsActivePort，并确认该端口真的活着。 */
async function livePort(profileDir) {
  try {
    const raw = await fs.readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8');
    const port = Number(String(raw).split('\n')[0].trim());
    if (!Number.isInteger(port) || port <= 0) return 0;
    await httpJson(port, '/json/version');
    return port;
  } catch {
    return 0;
  }
}

/**
 * 从页面的 CDP 连接读出站点 Cookie。
 * 页面级 target 才稳定支持 Network.getAllCookies，故不复用浏览器级连接。
 */
async function readSiteCookies(port, base) {
  const targets = await httpJson(port, '/json/list');
  const pages = (Array.isArray(targets) ? targets : []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!pages.length) return { cookies: [], pages: 0 };

  const host = new URL(base).hostname;
  const target = pages.find((p) => String(p.url || '').includes(host)) || pages[0];

  const cdp = connectCdp(target.webSocketDebuggerUrl, 6000);
  try {
    await cdp.opened;
    try {
      await cdp.send('Network.enable', {}, 6000);
    } catch {
      // 部分版本不 enable 也能 getAllCookies
    }
    const all = await cdp.send('Network.getAllCookies', {}, 8000);
    return { cookies: all?.cookies || [], pages: pages.length };
  } finally {
    cdp.close();
  }
}

/** 本机可用于浏览器登录的浏览器信息，供状态接口回报给界面。 */
export function browserLoginInfo() {
  const preferred = defaultBrowser();
  const usable = preferred?.exes?.length ? preferred : null;
  return {
    /** 系统默认浏览器名，如 Edge / Chrome / Firefox */
    defaultBrowser: preferred?.name || '',
    /** 默认浏览器是否可用于登录（Chromium 系才能挂 CDP） */
    defaultBrowserUsable: Boolean(usable),
    /** 是否有任意一个可用的浏览器 */
    supported:
      browserCandidates().some((file) => {
        try {
          return fs.existsSync(file);
        } catch {
          return false;
        }
      }) || Boolean(usable),
  };
}

function domainMatches(domain, base) {
  try {
    const host = new URL(base).hostname;
    const d = String(domain || '').replace(/^\./, '');
    return host === d || host.endsWith('.' + d);
  } catch {
    return false;
  }
}

/**
 * 浏览器登录用的独立 profile 目录。
 * 放在 DSH 数据目录下而不是系统临时目录：临时目录会被清理，
 * 放这里能让「下次免登录」真正成立，也便于用户自己删除以重置。
 */
export function defaultBrowserProfileDir() {
  const configured = String(process.env.DSH_HOME || '').trim();
  const home = configured
    ? path.resolve(configured.replace(/^~(?=$|[\\/])/, os.homedir()))
    : path.join(os.homedir(), '.dsh');
  return path.join(home, 'music-player', 'browser-profile');
}

/**
 * 一次浏览器登录会话。
 * 用法：start() -> 反复 poll() -> 成功或失败后 dispose()。
 */
export class BrowserLogin {
  constructor(options = {}) {
    this.base = options.base || 'https://dl.74520.xyz';
    /** 拿到 Cookie 后由调用方验证并接管登录态 */
    this.verify = options.verify || (async () => null);
    this.profileDir = options.profileDir || defaultBrowserProfileDir();
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

    this.child = null;
    this.port = 0;
    this.startedAt = 0;
    this.done = false;
    this.busy = false;
    /** 用户手动关掉浏览器窗口 */
    this.closed = false;
  }

  async start() {
    await fs.mkdir(this.profileDir, { recursive: true });

    // 上一次会话可能还在跑（比如插件热重载），能连上就直接复用
    this.port = await livePort(this.profileDir);
    if (this.port) {
      this.startedAt = Date.now();
      return { port: this.port, reused: true };
    }

    // 删掉失效的端口文件，否则 Chrome 不会重写
    await fs.rm(path.join(this.profileDir, 'DevToolsActivePort'), { force: true });

    const exe = await pickBrowser();
    if (!exe) {
      throw Object.assign(
        new Error('未找到可用于登录的 Chrome、Edge 或其它 Chromium 浏览器，请改用账号密码登录'),
        { code: 'no-browser' },
      );
    }

    this.child = spawn(
      exe,
      [
        '--remote-debugging-port=0',
        `--user-data-dir=${this.profileDir}`,
        '--remote-allow-origins=*',
        '--no-first-run',
        '--no-default-browser-check',
        // Edge 首启会弹「同步确认 / 新设备欢迎」把站点页面顶掉，必须关掉
        '--disable-sync',
        '--disable-features=Translate,msEdgeSyncConfirmation,EdgeSync,msEdgeFirstRunExperience',
        '--window-size=1040,780',
        this.base + '/',
      ],
      { stdio: 'ignore', detached: false, windowsHide: false },
    );
    this.child.on('exit', () => {
      this.closed = true;
    });
    this.startedAt = Date.now();

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const port = await livePort(this.profileDir);
      if (port) {
        this.port = port;
        return { port, reused: false };
      }
      if (this.closed) break;
      await sleep(300);
    }
    throw Object.assign(new Error('浏览器启动超时，请确认默认浏览器可以正常打开'), { code: 'browser-start-failed' });
  }

  get expired() {
    return this.startedAt > 0 && Date.now() - this.startedAt > this.timeoutMs;
  }

  /**
   * 读一次 Cookie 并尝试登录。
   * 返回 { authenticated, pending, user, quota }。
   */
  async poll() {
    if (this.done) return { authenticated: true, pending: false, already: true };
    if (this.expired) {
      throw Object.assign(new Error('浏览器登录超时，请重试'), { code: 'login-timeout' });
    }
    if (this.busy) return { authenticated: false, pending: true };
    this.busy = true;

    try {
      const port = await livePort(this.profileDir);
      if (!port) {
        if (this.closed) {
          throw Object.assign(new Error('浏览器窗口已关闭，登录未完成'), { code: 'login-cancelled' });
        }
        return { authenticated: false, pending: true };
      }
      this.port = port;

      const { cookies, pages } = await readSiteCookies(port, this.base);
      if (!pages) return { authenticated: false, pending: true };

      const mine = cookies.filter((c) => domainMatches(c.domain, this.base));
      if (!mine.length) return { authenticated: false, pending: true };

      const cookie = mine.map((c) => `${c.name}=${c.value}`).join('; ');
      const auth = await this.verify(cookie);
      if (auth?.authenticated) {
        this.done = true;
        // 供调用方在成功时接管登录态
        this.lastCookie = cookie;
        return { authenticated: true, pending: false, cookie, user: auth.user || null, quota: auth.quota || null };
      }
      return { authenticated: false, pending: true };
    } finally {
      this.busy = false;
    }
  }

  /** 关掉浏览器。登录成功时保留 profile，下次可免登录。 */
  async dispose() {
    this.done = true;
    if (this.port) {
      try {
        const version = await httpJson(this.port, '/json/version');
        const wsUrl = version?.webSocketDebuggerUrl;
        if (wsUrl) {
          const cdp = connectCdp(wsUrl, 5000);
          await cdp.opened;
          await cdp.send('Browser.close', {}, 4000).catch(() => {});
          cdp.close();
        }
      } catch {
        // 浏览器可能已经退出
      }
    }
    if (this.child && !this.child.killed) {
      try {
        this.child.kill();
      } catch {
        // 已退出
      }
    }
    this.child = null;
    this.port = 0;
  }
}
