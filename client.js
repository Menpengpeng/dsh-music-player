window.__ModuleLoader__.load({
  id: 'dsh-music-player',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const API = '/api/music-player';

    // ===== 上游接口调用 =====
    /** 无参 GET 取状态；带参 POST 执行操作。 */
    async function api(payload) {
      const init = payload
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }
        : { method: 'GET' };
      const res = await fetch(API, init);
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        const error = new Error(json?.error || `请求失败（HTTP ${res.status}）`);
        error.code = json?.code || '';
        error.status = res.status;
        throw error;
      }
      return json;
    }

    /** 秒转 mm:ss。 */
    function formatTime(sec) {
      const n = Number(sec);
      if (!Number.isFinite(n) || n <= 0) return '0:00';
      return `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
    }

    const PLATFORMS = [
      { id: 'all', label: '全部' },
      { id: 'qqmusic', label: 'QQ' },
      { id: 'neteasemusic', label: '网易云' },
      { id: 'kugou', label: '酷狗' },
    ];

    // ===== 样式 =====
    // 只用 --dsw-alias-* 主题令牌，跟随宿主明暗切换；类名统一 mp- 前缀避免污染宿主。
    const STYLE_ID = 'mp-styles';
    const CSS = `
.mp-root { position: relative; display: flex; align-items: center; justify-content: center; }
.mp-icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 34px; height: 34px; border-radius: 8px; border: none; position: relative;
  background: transparent; color: var(--dsw-alias-label-secondary, #6b7280);
  cursor: pointer; flex: none; padding: 0;
}
.mp-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); color: var(--dsw-alias-label-primary, #111); }
.mp-icon-btn:disabled { opacity: .5; cursor: default; }
.mp-icon-btn[data-active="true"] { color: var(--dsw-alias-state-business-primary, #fa2d48); }
.mp-badge {
  position: absolute; top: 3px; right: 3px; width: 7px; height: 7px; border-radius: 50%;
  background: var(--dsw-alias-state-business-primary, #fa2d48); pointer-events: none;
}
.mp-panel {
  position: fixed; width: 350px; max-height: min(620px, calc(100vh - 100px));
  overflow: hidden; display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-base, #fff);
  border: 1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.22));
  border-radius: 14px; box-shadow: 0 14px 38px rgba(0,0,0,.22);
  color: var(--dsw-alias-label-primary, #111); font-size: 13px; z-index: 9999;
}
.mp-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.18)); }
.mp-head-title { font-weight: 600; font-size: 13px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mp-body { overflow-y: auto; padding: 8px; min-height: 0; }
.mp-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; cursor: pointer; }
.mp-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.10)); }
.mp-row[data-current="true"] { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16)); }
.mp-row-title { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mp-row-sub { font-size: 11px; color: var(--dsw-alias-label-secondary, #6b7280); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mp-input {
  flex: 1; min-width: 0; height: 30px; padding: 0 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.3));
  background: transparent; color: var(--dsw-alias-label-primary, #111); font-size: 13px; outline: none;
  box-sizing: border-box;
}
.mp-input:focus { border-color: var(--dsw-alias-state-business-primary, #fa2d48); }
.mp-btn {
  height: 30px; padding: 0 12px; border-radius: 8px; border: none; cursor: pointer;
  font-size: 13px; background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14));
  color: var(--dsw-alias-label-primary, #111); flex: none;
  display: inline-flex; align-items: center; justify-content: center;
}
.mp-btn:disabled { opacity: .55; cursor: default; }
.mp-btn-primary { background: var(--dsw-alias-state-business-primary, #fa2d48); color: #fff; }
.mp-now { display: flex; gap: 10px; padding: 10px 12px; align-items: center; border-top: 1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.18)); }
.mp-cover {
  width: 42px; height: 42px; border-radius: 8px; flex: none; object-fit: cover;
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16));
}
.mp-cover-ph { display: flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-secondary, #9ca3af); }
.mp-meta { flex: 1; min-width: 0; }
.mp-controls { display: flex; align-items: center; gap: 2px; flex: none; }
.mp-progress { display: flex; align-items: center; gap: 8px; padding: 0 12px 10px; }
.mp-progress input[type="range"] { flex: 1; min-width: 0; accent-color: var(--dsw-alias-state-business-primary, #fa2d48); }
.mp-time { font-size: 11px; color: var(--dsw-alias-label-secondary, #6b7280); font-variant-numeric: tabular-nums; flex: none; }
.mp-hint { padding: 18px 14px; text-align: center; color: var(--dsw-alias-label-secondary, #6b7280); font-size: 12px; line-height: 1.7; }
.mp-error { color: #e11d48; font-size: 12px; padding: 6px 10px; line-height: 1.6; }
.mp-tabs { display: flex; gap: 4px; padding: 8px 8px 0; }
.mp-tab {
  flex: 1; height: 26px; border-radius: 7px; border: none; cursor: pointer; font-size: 12px;
  background: transparent; color: var(--dsw-alias-label-secondary, #6b7280);
}
.mp-tab[data-active="true"] { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16)); color: var(--dsw-alias-label-primary, #111); font-weight: 600; }
.mp-list { list-style: none; margin: 0; padding: 0; }
.mp-audio { display: none; }

/* 发现广场 */
.mp-cats { display: flex; flex-wrap: wrap; gap: 5px; padding: 8px 10px 4px; }
.mp-cat {
  height: 24px; padding: 0 10px; border-radius: 12px; cursor: pointer; font-size: 11px;
  border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.28));
  background: transparent; color: var(--dsw-alias-label-secondary, #6b7280);
}
.mp-cat[data-active="true"] {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.18));
  color: var(--dsw-alias-label-primary, #111); font-weight: 600;
}
.mp-sec-title {
  font-size: 11px; font-weight: 600; padding: 8px 10px 4px;
  color: var(--dsw-alias-label-secondary, #6b7280);
  display: flex; align-items: center; justify-content: space-between;
}
.mp-charts { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; padding: 0 10px; }
.mp-chart {
  border-radius: 9px; overflow: hidden; cursor: pointer; min-width: 0;
  border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.2));
  background: var(--dsw-alias-bg-subtle, rgba(127,127,127,.05));
}
.mp-chart:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
.mp-chart-cover {
  width: 100%; height: 54px; display: block; object-fit: cover;
  background: var(--dsw-alias-bg-subtle, rgba(127,127,127,.1));
}
.mp-chart-body { padding: 5px 7px 7px; }
.mp-chart-title {
  font-size: 11.5px; font-weight: 600; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-primary, #111);
}
.mp-chart-sub {
  font-size: 10px; margin-top: 1px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-secondary, #6b7280);
}
.mp-pls { padding: 0 10px 6px; }
.mp-pl { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 8px; cursor: pointer; }
.mp-pl:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.10)); }
.mp-pl-cover {
  width: 34px; height: 34px; border-radius: 6px; flex: none; object-fit: cover;
  background: var(--dsw-alias-bg-subtle, rgba(127,127,127,.1));
}
.mp-pl-main { min-width: 0; flex: 1; }
.mp-pl-title {
  font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-primary, #111);
}
.mp-pl-sub {
  font-size: 10px; margin-top: 1px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-secondary, #6b7280);
}
.mp-back {
  font-size: 11px; padding: 2px 6px; border-radius: 6px; border: none; cursor: pointer;
  background: transparent; color: var(--dsw-alias-label-secondary, #6b7280);
}
.mp-back:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
`;

    /** 注入样式，插件卸载时移除。 */
    function useStyles() {
      useEffect(() => {
        let el = document.getElementById(STYLE_ID);
        const created = !el;
        if (!el) {
          el = document.createElement('style');
          el.id = STYLE_ID;
          el.textContent = CSS;
          document.head.appendChild(el);
        }
        return () => {
          if (created) el.remove();
        };
      }, []);
    }

    // ===== 图标 =====
    function Icon({ name, size = 16 }) {
      const common = {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      };
      if (name === 'music') {
        return h('svg', common, h('path', { d: 'M9 18V5l12-2v13' }), h('circle', { cx: 6, cy: 18, r: 3 }), h('circle', { cx: 18, cy: 16, r: 3 }));
      }
      if (name === 'play') return h('svg', { ...common, fill: 'currentColor', stroke: 'none' }, h('path', { d: 'M8 5v14l11-7z' }));
      if (name === 'pause') return h('svg', { ...common, fill: 'currentColor', stroke: 'none' }, h('path', { d: 'M6 4h4v16H6zM14 4h4v16h-4z' }));
      if (name === 'prev') return h('svg', { ...common, fill: 'currentColor', stroke: 'none' }, h('path', { d: 'M6 5h2v14H6zM20 5v14l-11-7z' }));
      if (name === 'next') return h('svg', { ...common, fill: 'currentColor', stroke: 'none' }, h('path', { d: 'M16 5h2v14h-2zM4 5v14l11-7z' }));
      if (name === 'close') return h('svg', common, h('path', { d: 'M6 6l12 12M18 6L6 18' }));
      if (name === 'search') return h('svg', common, h('circle', { cx: 11, cy: 11, r: 7 }), h('path', { d: 'M20 20l-3.5-3.5' }));
      if (name === 'volume') return h('svg', common, h('path', { d: 'M11 5L6 9H2v6h4l5 4z' }), h('path', { d: 'M15.5 8.5a5 5 0 010 7' }));
      return null;
    }

    // ===== 播放器 =====
    function MusicPlayer() {
      useStyles();

      const [open, setOpen] = useState(false);
      /** 面板定位：相对触发按钮计算，避免窄栏裁剪 */
      const [anchor, setAnchor] = useState(null);
      const [tab, setTab] = useState('search');

      const [status, setStatus] = useState(null);
      const [bootError, setBootError] = useState('');
      const [account, setAccount] = useState('');
      const [password, setPassword] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');

      const [query, setQuery] = useState('');
      const [platform, setPlatform] = useState('all');
      const [results, setResults] = useState([]);
      const [searched, setSearched] = useState(false);

      /** 浏览器登录：是否等待中、是否展开账号密码表单 */
      const [browserPending, setBrowserPending] = useState(false);
      const [showManual, setShowManual] = useState(false);

      /** 发现广场：分类、榜单、歌单、打开中的歌单 */
      const [disc, setDisc] = useState(null);
      const [discCategory, setDiscCategory] = useState('全部');
      const [discLoading, setDiscLoading] = useState(false);
      const [discError, setDiscError] = useState('');
      const [openedPlaylist, setOpenedPlaylist] = useState(null);

      /** 队列与当前曲目 */
      const [queue, setQueue] = useState([]);
      const [index, setIndex] = useState(-1);
      const [current, setCurrent] = useState(null);
      const [playing, setPlaying] = useState(false);
      const [time, setTime] = useState(0);
      const [duration, setDuration] = useState(0);
      const [volume, setVolume] = useState(1);
      const [resolving, setResolving] = useState(false);

      const audioRef = useRef(null);
      const rootRef = useRef(null);

      const authed = Boolean(status?.authenticated);
      const hasTrack = Boolean(current);

      /** 启动时拉一次登录态 */
      useEffect(() => {
        let alive = true;
        api()
          .then((s) => {
            if (alive) setStatus(s);
          })
          .catch((e) => {
            if (alive) setBootError(e.message || '连接上游站点失败');
          });
        return () => {
          alive = false;
        };
      }, []);

      /** 打开面板时按按钮位置定位；窗口变化时重算 */
      useEffect(() => {
        if (!open) {
          setAnchor(null);
          return;
        }
        const place = () => {
          const el = rootRef.current;
          if (!el) return;
          const r = el.getBoundingClientRect();
          const width = 350;
          // 面板贴右下：右侧不超出视口，左侧对齐按钮左缘（窄栏时整体右移）
          const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
          const bottom = Math.max(8, window.innerHeight - r.top + 8);
          setAnchor({ left, bottom });
        };
        place();
        window.addEventListener('resize', place);
        return () => window.removeEventListener('resize', place);
      }, [open]);

      /** 点面板外关闭 */
      useEffect(() => {
        if (!open) return;
        const onDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) {
            // 面板已挂到别处，需单独判断
            const panel = document.getElementById('mp-panel');
            if (panel && panel.contains(event.target)) return;
            setOpen(false);
          }
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
      }, [open]);

      /** 音频事件 */
      useEffect(() => {
        const el = audioRef.current;
        if (!el) return;
        const onTime = () => setTime(el.currentTime || 0);
        const onMeta = () => setDuration(el.duration || 0);
        const onPlay = () => setPlaying(true);
        const onPause = () => setPlaying(false);
        const onError = () => {
          setPlaying(false);
          setError('这首播放失败了，可能版权受限或需要会员；换一首试试');
        };
        el.addEventListener('timeupdate', onTime);
        el.addEventListener('loadedmetadata', onMeta);
        el.addEventListener('durationchange', onMeta);
        el.addEventListener('play', onPlay);
        el.addEventListener('pause', onPause);
        el.addEventListener('error', onError);
        return () => {
          el.removeEventListener('timeupdate', onTime);
          el.removeEventListener('loadedmetadata', onMeta);
          el.removeEventListener('durationchange', onMeta);
          el.removeEventListener('play', onPlay);
          el.removeEventListener('pause', onPause);
          el.removeEventListener('error', onError);
        };
      }, []);

      useEffect(() => {
        if (audioRef.current) audioRef.current.volume = volume;
      }, [volume]);

      /**
       * 播放某首：先向后端换取转发地址，再交给 audio。
       * 搜索结果不带音质信息，后端会自己走 parse → resolve 并挑最高可用音质，
       * 所以这里只把歌曲（含页面链接）原样交给后端即可。
       */
      const playAt = useCallback(
        async (list, position) => {
          const track = list[position];
          if (!track) return;
          setError('');
          setResolving(true);
          setCurrent(track);
          setIndex(position);
          setTime(0);
          setDuration(0);
          try {
            const r = await api({ type: 'resolve', track });
            const src = r?.src || '';
            if (!src) throw new Error('没有可用的播放地址');
            const el = audioRef.current;
            if (!el) return;
            el.src = src;
            el.volume = volume;
            await el.play();
          } catch (e) {
            setError(e.message || '播放失败');
            setPlaying(false);
            if (e.code === 'need-login') {
              setStatus((s) => ({ ...(s || {}), authenticated: false }));
            }
          } finally {
            setResolving(false);
          }
        },
        [volume],
      );

      /** 播完自动下一首；用 ref 保存最新实现，避免事件回调拿到旧闭包 */
      const nextRef = useRef(() => {});
      useEffect(() => {
        const el = audioRef.current;
        if (!el) return;
        const onEnded = () => nextRef.current();
        el.addEventListener('ended', onEnded);
        return () => el.removeEventListener('ended', onEnded);
      }, []);

      const playNext = useCallback(() => {
        if (!queue.length) return;
        playAt(queue, (index + 1) % queue.length);
      }, [queue, index, playAt]);

      const playPrev = useCallback(() => {
        if (!queue.length) return;
        playAt(queue, (index - 1 + queue.length) % queue.length);
      }, [queue, index, playAt]);

      useEffect(() => {
        nextRef.current = playNext;
      }, [playNext]);

      const playList = useCallback(
        (items, startIndex = 0) => {
          if (!items.length) return;
          setQueue(items);
          playAt(items, startIndex);
        },
        [playAt],
      );

      const toggle = useCallback(() => {
        const el = audioRef.current;
        if (!el || !current) return;
        if (el.paused) el.play().catch(() => setPlaying(false));
        else el.pause();
      }, [current]);

      /** 拉发现广场数据；切分类时重新拉。 */
      const loadDiscover = useCallback(async (category) => {
        setDiscLoading(true);
        setDiscError('');
        try {
          const data = await api({ type: 'discover', category: category || '' });
          setDisc(data);
          setDiscCategory(data?.category || category || '全部');
        } catch (e) {
          setDiscError(e.message || '加载失败');
        } finally {
          setDiscLoading(false);
        }
      }, []);

      /** 首次切到「发现」且还没数据时才拉，避免每次点标签都打接口。 */
      useEffect(() => {
        if (tab !== 'discover' || !authed) return;
        if (disc || discLoading) return;
        loadDiscover('');
      }, [tab, authed, disc, discLoading, loadDiscover]);

      // 已登出就不再展示旧数据，防止换账号后看到上一个账号的内容
      useEffect(() => {
        if (authed) return;
        setDisc(null);
        setOpenedPlaylist(null);
        setDiscCategory('全部');
      }, [authed]);

      /** 打开歌单，拿到曲目后直接可以播放。 */
      const openPlaylist = useCallback(async (item) => {
        setDiscError('');
        setOpenedPlaylist({ title: item.title, cover: item.cover, items: [], loading: true });
        try {
          const data = await api({ type: 'playlist', platform: item.platform, id: item.id });
          setOpenedPlaylist({
            title: data?.title || item.title,
            cover: data?.cover || item.cover,
            items: Array.isArray(data?.items) ? data.items : [],
            loading: false,
          });
        } catch (e) {
          setOpenedPlaylist(null);
          setDiscError(e.message || '打开歌单失败');
        }
      }, []);

      /** 打开榜单：复用现有 chart 接口。 */
      const openChart = useCallback(
        async (chart) => {
          setDiscError('');
          setOpenedPlaylist({ title: chart.title || '榜单', cover: chart.cover || '', items: [], loading: true });
          try {
            const items = await api({ type: 'chart', platform: chart.key });
            const list = Array.isArray(items) ? items : [];
            setOpenedPlaylist({
              title: chart.title || '榜单',
              cover: chart.cover || '',
              items: list,
              loading: false,
            });
          } catch (e) {
            setOpenedPlaylist(null);
            setDiscError(e.message || '打开榜单失败');
          }
        },
        [],
      );

      const doLogin = useCallback(async () => {
        setError('');
        if (!account.trim() || !password) {
          setError('请填写账号与密码');
          return;
        }
        setBusy(true);
        try {
          await api({ type: 'login', account: account.trim(), password });
          setPassword('');
          setStatus(await api());
          setTab('search');
        } catch (e) {
          setError(e.message || '登录失败');
        } finally {
          setBusy(false);
        }
      }, [account, password]);

      /**
       * 浏览器登录：Host 拉起浏览器，用户在里面登好，
       * 前端按 Host 给的节奏轮询，登录态由 Host 读回并落盘。
       */
      const startBrowserLogin = useCallback(async () => {
        setError('');
        setBusy(true);
        try {
          const r = await api({ type: 'browserLogin' });
          setBrowserPending(true);
          const interval = Number(r?.pollMs) || 1500;

          const deadline = Date.now() + 5 * 60 * 1000;
          const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

          while (Date.now() < deadline) {
            await sleep(interval);
            let poll;
            try {
              poll = await api({ type: 'browserPoll' });
            } catch (e) {
              // 用户关掉窗口、超时等，直接回到未登录
              setBrowserPending(false);
              setError(e.message || '浏览器登录未完成');
              return;
            }
            if (poll?.authenticated) {
              setStatus(await api());
              setBrowserPending(false);
              setShowManual(false);
              setTab('search');
              return;
            }
            if (poll?.closed) {
              setBrowserPending(false);
              setError('浏览器登录已中断，请重试');
              return;
            }
          }
          setBrowserPending(false);
          setError('浏览器登录超时，请重试');
          api({ type: 'browserCancel' }).catch(() => {});
        } catch (e) {
          setBrowserPending(false);
          setError(e.message || '无法打开浏览器');
        } finally {
          setBusy(false);
        }
      }, []);

      const doLogout = useCallback(async () => {
        setBusy(true);
        try {
          await api({ type: 'logout' });
          setStatus(await api());
          setResults([]);
          setQueue([]);
          setCurrent(null);
        } catch (e) {
          setError(e.message || '退出失败');
        } finally {
          setBusy(false);
        }
      }, []);

      const doSearch = useCallback(async () => {
        const q = query.trim();
        if (!q) return;
        setError('');
        setBusy(true);
        setSearched(true);
        try {
          const r = await api({ type: 'search', query: q, platform, limit: 20 });
          setResults(Array.isArray(r?.items) ? r.items : []);
        } catch (e) {
          setResults([]);
          setError(e.message || '搜索失败');
          if (e.code === 'need-login') setStatus((s) => ({ ...(s || {}), authenticated: false }));
        } finally {
          setBusy(false);
        }
      }, [query, platform]);

      const seek = useCallback((value) => {
        const el = audioRef.current;
        if (!el) return;
        el.currentTime = Number(value) || 0;
        setTime(Number(value) || 0);
      }, []);

      const stopAll = useCallback(() => {
        const el = audioRef.current;
        if (el) {
          el.pause();
          el.removeAttribute('src');
          el.load();
        }
        setPlaying(false);
        setCurrent(null);
      }, []);

      // ===== 视图 =====
      const title = authed
        ? status?.user?.nickname || status?.user?.account || '已登录'
        : '音乐站 · 未登录';

      const searchPane = h(
        React.Fragment,
        null,
        h(
          'div',
          { style: { display: 'flex', gap: 6, padding: '8px 8px 0' } },
          h('input', {
            className: 'mp-input',
            placeholder: '搜歌曲、歌手',
            value: query,
            onChange: (e) => setQuery(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter') doSearch();
            },
          }),
          h(
            'button',
            { className: 'mp-btn', disabled: busy, onClick: doSearch, title: '搜索' },
            h(Icon, { name: 'search', size: 15 }),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 4, padding: '8px 8px 0' } },
          PLATFORMS.map((p) =>
            h(
              'button',
              {
                key: p.id,
                className: 'mp-tab',
                'data-active': platform === p.id,
                onClick: () => setPlatform(p.id),
              },
              p.label,
            ),
          ),
        ),
        error ? h('div', { className: 'mp-error' }, error) : null,
        h(
          'div',
          { className: 'mp-body', style: { paddingTop: 6 } },
          results.length
            ? h(
                'ul',
                { className: 'mp-list' },
                results.map((item, i) =>
                  h(
                    'li',
                    {
                      key: item.track_key || `${item.platform}-${item.song_id}-${i}`,
                      className: 'mp-row',
                      'data-current': Boolean(current && current.track_key === item.track_key),
                      onClick: () => playList(results, i),
                      title: `${item.title}${item.artist ? ' - ' + item.artist : ''}`,
                    },
                    h(
                      'div',
                      { className: 'mp-meta' },
                      h('div', { className: 'mp-row-title' }, item.title),
                      h(
                        'div',
                        { className: 'mp-row-sub' },
                        [item.artist, item.album].filter(Boolean).join(' · ') || '未知歌手',
                      ),
                    ),
                    item.duration ? h('span', { className: 'mp-time' }, formatTime(item.duration)) : null,
                  ),
                ),
              )
            : h(
                'div',
                { className: 'mp-hint' },
                busy ? '搜索中…' : searched ? '没有搜到歌曲，换个关键词试试' : '输入关键词开始搜索',
              ),
        ),
      );

      const queuePane = h(
        'div',
        { className: 'mp-body' },
        error ? h('div', { className: 'mp-error' }, error) : null,
        queue.length
          ? h(
              'ul',
              { className: 'mp-list' },
              queue.map((item, i) =>
                h(
                  'li',
                  {
                    key: item.track_key || `q-${i}`,
                    className: 'mp-row',
                    'data-current': i === index,
                    onClick: () => playAt(queue, i),
                  },
                  h(
                    'div',
                    { className: 'mp-meta' },
                    h('div', { className: 'mp-row-title' }, item.title),
                    h('div', { className: 'mp-row-sub' }, item.artist || '未知歌手'),
                  ),
                ),
              ),
            )
          : h('div', { className: 'mp-hint' }, '队列是空的，先去搜索并播放一首'),
      );

      /** 封面加载失败时隐藏图片，避免面板里出现破图占位 */
      const hideBrokenImage = (e) => {
        const el = e && e.currentTarget;
        if (el && el.style) el.style.visibility = 'hidden';
      };

      /** 歌单/榜单展开后的曲目列表，复用和搜索一样的一行式样式 */
      const trackList = (items, keyPrefix) =>
        h(
          'ul',
          { className: 'mp-list' },
          items.map((item, i) =>
            h(
              'li',
              {
                key: item.track_key || `${keyPrefix}-${i}`,
                className: 'mp-row',
                'data-current': Boolean(current && item.track_key && current.track_key === item.track_key),
                onClick: () => playList(items, i),
                title: `${item.title}${item.artist ? ' - ' + item.artist : ''}`,
              },
              h(
                'div',
                { className: 'mp-meta' },
                h('div', { className: 'mp-row-title' }, item.title),
                h(
                  'div',
                  { className: 'mp-row-sub' },
                  [item.artist, item.album].filter(Boolean).join(' · ') || '未知歌手',
                ),
              ),
              item.duration ? h('span', { className: 'mp-time' }, formatTime(item.duration)) : null,
            ),
          ),
        );

      /** 播放量格式化：8562137 -> 856.2万 */
      const formatCount = (n) => {
        const v = Number(n) || 0;
        if (v >= 100000000) return (v / 100000000).toFixed(1) + '亿';
        if (v >= 10000) return (v / 10000).toFixed(1) + '万';
        return String(v);
      };

      // 已打开歌单/榜单：显示曲目，带返回按钮
      const openedPane = h(
        'div',
        { className: 'mp-body', style: { paddingTop: 6 } },
        discError ? h('div', { className: 'mp-error' }, discError) : null,
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px 4px' } },
          h('button', { className: 'mp-back', onClick: () => setOpenedPlaylist(null) }, '← 返回'),
          h(
            'div',
            {
              style: {
                fontSize: 12,
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            openedPlaylist?.title || '',
          ),
        ),
        openedPlaylist?.loading
          ? h('div', { className: 'mp-hint' }, '加载中…')
          : openedPlaylist?.items?.length
            ? trackList(openedPlaylist.items, 'pl')
            : h('div', { className: 'mp-hint' }, '这个歌单里没有可播放的曲目'),
      );

      const discoverPane = h(
        'div',
        { className: 'mp-body', style: { paddingTop: 0 } },
        discError ? h('div', { className: 'mp-error' }, discError) : null,
        // 分类切换
        h(
          'div',
          { className: 'mp-cats' },
          (disc?.categories || ['全部']).map((c) =>
            h(
              'button',
              {
                key: c,
                className: 'mp-cat',
                'data-active': discCategory === c,
                onClick: () => {
                  if (discCategory === c || discLoading) return;
                  loadDiscover(c);
                },
              },
              c,
            ),
          ),
        ),
        discLoading && !disc
          ? h('div', { className: 'mp-hint' }, '加载中…')
          : disc
            ? h(
                React.Fragment,
                null,
                // 榜单卡片
                disc.charts?.length
                  ? h(
                      React.Fragment,
                      null,
                      h('div', { className: 'mp-sec-title' }, '排行榜', h('span', null, `${disc.charts.length} 个`)),
                      h(
                        'div',
                        { className: 'mp-charts' },
                        disc.charts.map((c) =>
                          h(
                            'div',
                            {
                              key: c.key,
                              className: 'mp-chart',
                              title: c.subtitle || c.title,
                              onClick: () => openChart(c),
                            },
                            c.cover
                              ? h('img', { className: 'mp-chart-cover', src: c.cover, alt: '', loading: 'lazy', onError: hideBrokenImage })
                              : null,
                            h(
                              'div',
                              { className: 'mp-chart-body' },
                              h('div', { className: 'mp-chart-title' }, c.title),
                              h('div', { className: 'mp-chart-sub' }, c.platformLabel || c.subtitle || ''),
                            ),
                          ),
                        ),
                      ),
                    )
                  : null,
                // 推荐歌单
                disc.playlists?.length
                  ? h(
                      React.Fragment,
                      null,
                      h('div', { className: 'mp-sec-title' }, '推荐歌单', h('span', null, `${disc.playlists.length} 个`)),
                      h(
                        'div',
                        { className: 'mp-pls' },
                        disc.playlists.map((p) =>
                          h(
                            'div',
                            {
                              key: `${p.platform}-${p.id}`,
                              className: 'mp-pl',
                              title: p.title,
                              onClick: () => openPlaylist(p),
                            },
                            p.cover
                              ? h('img', { className: 'mp-pl-cover', src: p.cover, alt: '', loading: 'lazy', onError: hideBrokenImage })
                              : h('div', { className: 'mp-pl-cover' }),
                            h(
                              'div',
                              { className: 'mp-pl-main' },
                              h('div', { className: 'mp-pl-title' }, p.title),
                              h(
                                'div',
                                { className: 'mp-pl-sub' },
                                [
                                  p.platformLabel,
                                  p.playCount ? formatCount(p.playCount) + '播放' : '',
                                  p.trackCount ? `${p.trackCount} 首` : '',
                                ]
                                  .filter(Boolean)
                                  .join(' · '),
                              ),
                            ),
                          ),
                        ),
                      ),
                    )
                  : null,
                !disc.charts?.length && !disc.playlists?.length
                  ? h('div', { className: 'mp-hint' }, '这个分类下暂时没有内容')
                  : null,
              )
            : h('div', { className: 'mp-hint' }, '正在加载发现页…'),
      );

      const canBrowserLogin = status?.browserLoginSupported !== false;
      /** 默认浏览器名，用于提示文案；取不到时退回泛称 */
      const browserName = status?.browser?.defaultBrowser || '浏览器';

      const loginPane = h(
        'div',
        { className: 'mp-body' },
        bootError ? h('div', { className: 'mp-error' }, bootError) : null,
        h(
          'div',
          { className: 'mp-hint', style: { padding: '4px 4px 10px', textAlign: 'left' } },
          '该音乐站的搜索与播放需要登录。登录后 Cookie 存在本机 ~/.dsh/music-player/ 下，不会上传别处。注册需要站点发放的邀请码。',
        ),
        canBrowserLogin
          ? h(
              'button',
              {
                className: 'mp-btn mp-btn-primary',
                disabled: busy || browserPending,
                onClick: startBrowserLogin,
                style: { width: '100%' },
                title: '在系统浏览器中完成登录，登录态自动同步回来',
              },
              browserPending ? '等待浏览器完成登录…' : '在浏览器中登录',
            )
          : null,
        canBrowserLogin
          ? h(
              'div',
              { className: 'mp-hint', style: { padding: '6px 4px 0', textAlign: 'left' } },
              browserPending
                ? '已打开浏览器：请在里面登录，成功后本面板会自动进入搜索。'
                : `推荐：用${browserName}登录，支持 LINUX DO / GitHub 等第三方账号。`,
            )
          : null,
        canBrowserLogin
          ? h(
              'button',
              {
                className: 'mp-btn',
                style: { width: '100%', marginTop: 8 },
                onClick: () => {
                  setError('');
                  setShowManual((v) => !v);
                },
              },
              showManual ? '收起账号密码登录' : '改用账号密码登录',
            )
          : null,
        !canBrowserLogin || showManual
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 4px 0' } },
              h('input', {
                className: 'mp-input',
                placeholder: '手机号或邮箱',
                value: account,
                onChange: (e) => setAccount(e.target.value),
                autoComplete: 'username',
                style: { flex: 'none', width: '100%' },
              }),
              h('input', {
                className: 'mp-input',
                type: 'password',
                placeholder: '密码',
                value: password,
                onChange: (e) => setPassword(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') doLogin();
                },
                autoComplete: 'current-password',
                style: { flex: 'none', width: '100%' },
              }),
              h(
                'button',
                { className: 'mp-btn', disabled: busy || browserPending, onClick: doLogin, style: { width: '100%' } },
                busy ? '登录中…' : '登录',
              ),
            )
          : null,
        error ? h('div', { className: 'mp-error' }, error) : null,
      );

      const nowBar = hasTrack
        ? h(
            React.Fragment,
            null,
            h(
              'div',
              { className: 'mp-now' },
              current.cover
                ? h('img', { className: 'mp-cover', src: current.cover, alt: '', loading: 'lazy' })
                : h('div', { className: 'mp-cover mp-cover-ph' }, h(Icon, { name: 'music', size: 20 })),
              h(
                'div',
                { className: 'mp-meta' },
                h('div', { className: 'mp-row-title', title: current.title }, current.title),
                h('div', { className: 'mp-row-sub' }, current.artist || '未知歌手'),
              ),
              h(
                'div',
                { className: 'mp-controls' },
                h('button', { className: 'mp-icon-btn', title: '上一首', onClick: playPrev }, h(Icon, { name: 'prev', size: 15 })),
                h(
                  'button',
                  { className: 'mp-icon-btn', title: playing ? '暂停' : '播放', onClick: toggle, disabled: resolving },
                  h(Icon, { name: playing ? 'pause' : 'play', size: 17 }),
                ),
                h('button', { className: 'mp-icon-btn', title: '下一首', onClick: playNext }, h(Icon, { name: 'next', size: 15 })),
              ),
            ),
            h(
              'div',
              { className: 'mp-progress' },
              h('span', { className: 'mp-time' }, formatTime(time)),
              h('input', {
                type: 'range',
                min: 0,
                max: Math.max(1, Math.floor(duration || 0)),
                value: Math.min(time, duration || 0),
                onChange: (e) => seek(e.target.value),
                'aria-label': '播放进度',
              }),
              h('span', { className: 'mp-time' }, formatTime(duration)),
              h(
                'button',
                { className: 'mp-icon-btn', title: volume > 0 ? '静音' : '取消静音', onClick: () => setVolume(volume > 0 ? 0 : 1) },
                h(Icon, { name: 'volume', size: 15 }),
              ),
            ),
          )
        : null;

      const panel =
        open && anchor
          ? h(
              'div',
              {
                className: 'mp-panel',
                id: 'mp-panel',
                role: 'dialog',
                'aria-label': '音乐播放器',
                style: { left: anchor.left, bottom: anchor.bottom },
              },
              h(
                'div',
                { className: 'mp-head' },
                h(Icon, { name: 'music', size: 15 }),
                h('span', { className: 'mp-head-title' }, title),
                authed
                  ? h(
                      'button',
                      { className: 'mp-btn', onClick: doLogout, disabled: busy, title: '退出登录' },
                      '退出',
                    )
                  : null,
                h('button', { className: 'mp-icon-btn', title: '关闭', onClick: () => setOpen(false) }, h(Icon, { name: 'close', size: 15 })),
              ),
              authed
                ? h(
                    React.Fragment,
                    null,
                    h(
                      'div',
                      { className: 'mp-tabs' },
                      h('button', { className: 'mp-tab', 'data-active': tab === 'search', onClick: () => setTab('search') }, '搜索'),
                      h(
                        'button',
                        { className: 'mp-tab', 'data-active': tab === 'discover', onClick: () => setTab('discover') },
                        '发现',
                      ),
                      h(
                        'button',
                        { className: 'mp-tab', 'data-active': tab === 'queue', onClick: () => setTab('queue') },
                        queue.length ? `队列 · ${queue.length}` : '队列',
                      ),
                    ),
                    tab === 'search' ? searchPane : tab === 'discover' ? (openedPlaylist ? openedPane : discoverPane) : queuePane,
                  )
                : loginPane,
              nowBar,
            )
          : null;

      return h(
        'div',
        { className: 'mp-root', ref: rootRef },
        h(
          'button',
          {
            className: 'mp-icon-btn',
            'data-active': hasTrack || open,
            title: hasTrack ? `${playing ? '正在播放' : '已暂停'}：${current.title}` : '音乐播放器',
            'aria-label': '音乐播放器',
            'aria-expanded': open,
            onClick: () => {
              if (open && hasTrack) {
                // 面板已开时再点：有曲目就切换播放，否则收起
                toggle();
              } else {
                setOpen((v) => !v);
              }
            },
          },
          h(Icon, { name: 'music', size: 17 }),
          playing ? h('span', { className: 'mp-badge' }) : null,
        ),
        panel,
        h('audio', { ref: audioRef, className: 'mp-audio', preload: 'none' }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'music-player',
              order: 40,
              label: '音乐',
            },
            MusicPlayer,
          ),
        );
      },
    };
  },
});
