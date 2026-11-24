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

    /**
     * 卡顿判定的等待时长。
     * 上游单连接限速，无损档常常贴着播放所需带宽跑，网络一抖就断流。
     * 4 秒足够区分「短暂抖动会自己恢复」与「真的供不上」，
     * 短了会误降档，长了用户已经听出明显停顿。
     */
    const STALL_TIMEOUT_MS = 4000;

    /**
     * 音质档位：balanced 优先流畅，lossless 优先无损，highest 取站点最高。
     * 默认 balanced —— 上游单连接限速，无损 FLAC 几乎贴着播放所需带宽，
     * 一有波动就断流；320k 有 4 倍余量，听感几乎无差。
     */
    const QUALITY_MODES_LIST = ['balanced', 'lossless', 'highest'];
    const QUALITY_LABELS = {
      balanced: '流畅优先（320k）',
      lossless: '无损优先（FLAC）',
      highest: '站点最高档',
    };
    const QUALITY_SHORT = { balanced: '320k', lossless: 'FLAC', highest: 'MAX' };

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
/* 音质档位：文字按钮，比图标更能说清当前档位 */
.mp-quality-btn { width: auto !important; padding: 0 5px !important; min-width: 30px; font-size: 10px; font-weight: 600; letter-spacing: .2px; }
.mp-quality-text { line-height: 1; }
.mp-hint { padding: 18px 14px; text-align: center; color: var(--dsw-alias-label-secondary, #6b7280); font-size: 12px; line-height: 1.7; }
.mp-error { color: #e11d48; font-size: 12px; padding: 6px 10px; line-height: 1.6; }
.mp-note { font-size: 11px; color: var(--dsw-alias-label-secondary, #6b7280); padding: 0 12px 8px; line-height: 1.5; }
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
/* 切分类时的轻量加载提示：旧数据继续显示，避免闪白 */
.mp-loading-bar {
  margin: 4px 10px 0; padding: 4px 8px; border-radius: 6px; font-size: 11px;
  color: var(--dsw-alias-label-secondary, #6b7280);
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12));
}
/* 收藏心形：默认是空心，已收藏变实心并染红，一眼能看出状态 */
.mp-fav-btn {
  flex: none; width: 22px; height: 22px; line-height: 22px; text-align: center;
  border-radius: 50%; cursor: pointer; font-size: 14px; user-select: none;
  color: var(--dsw-alias-label-secondary, #6b7280);
  transition: background .12s ease, color .12s ease, transform .12s ease;
}
.mp-fav-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16));
  transform: scale(1.08);
}
.mp-fav-btn[data-on="true"] { color: var(--dsw-alias-label-error, #e0245e); }
.mp-fav-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-border-strong, rgba(127,127,127,.55));
  outline-offset: 1px;
}
/* 播放条上的心形稍大一点，和两侧按钮对齐 */
.mp-fav-now { width: 24px; height: 24px; line-height: 24px; font-size: 15px; margin-right: 2px; }
/* 「我喜欢」面板顶部：数量 + 全部播放 */
.mp-fav-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 2px 10px 6px; font-size: 11px;
  color: var(--dsw-alias-label-secondary, #6b7280);
}
.mp-fav-playall { height: 24px; padding: 0 10px; border-radius: 12px; font-size: 11px; }
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

      /** 音质偏好：balanced=优先流畅 / lossless=优先无损 / highest=站点最高档 */
      const [qualityMode, setQualityMode] = useState('balanced');
      /** 卡顿自动降质的次数与提示，用于「已自动降到更低音质」的反馈 */
      const [autoDowngrade, setAutoDowngrade] = useState('');

      /**
       * 「我喜欢」：与站点网页端共用同一份数据，所以在插件里收藏，
       * 打开 dl.74520.xyz 也能看到；反之亦然。
       * favKeys 用 Set 做 O(1) 判断，favItems 才是列表数据。
       */
      const [favItems, setFavItems] = useState([]);
      const [favKeys, setFavKeys] = useState(() => new Set());
      const [favLoading, setFavLoading] = useState(false);
      const [favError, setFavError] = useState('');
      /** 正在请求中的 track_key，避免连点导致重复提交 */
      const favBusyRef = useRef(new Set());

      const audioRef = useRef(null);
      const rootRef = useRef(null);
      /** 最近一次成功播放的音质标识，用于判断还能不能降档 */
      const lastQualityRef = useRef('');
      /** 卡顿自愈：本曲已自动降档次数，避免反复重取链 */
      const stallFixRef = useRef(0);

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
       * 搜索结果不带音质信息，后端会自己走 parse → resolve 挑档，
       * 所以这里只把歌曲（含页面链接）和「要不要降档」交给后端。
       *
       * keepTime：卡顿自愈时从当前进度续播，避免从头开始。
       */
      const playAt = useCallback(
        async (list, position, opts = {}) => {
          const track = list[position];
          if (!track) return;
          const resumeAt = Number(opts.keepTime) || 0;
          setError('');
          setResolving(true);
          setCurrent(track);
          setIndex(position);
          if (!resumeAt) {
            setTime(0);
            setDuration(0);
          }
          try {
            // forceLowQuality：卡顿自动降级时，明确要求后端给低码率档
            const r = await api({
              type: 'resolve',
              track,
              quality: opts.quality || '',
              lowQuality: Boolean(opts.forceLowQuality),
            });
            const src = r?.src || '';
            if (!src) throw new Error('没有可用的播放地址');
            const el = audioRef.current;
            if (!el) return;
            el.src = src;
            el.volume = volume;
            if (resumeAt > 0.5) {
              // 等元数据就绪再跳转，否则 currentTime 会被忽略
              const seek = () => {
                try {
                  el.currentTime = resumeAt;
                } catch {
                  /* 忽略：无法跳转就从当前位置播 */
                }
                el.removeEventListener('loadedmetadata', seek);
              };
              el.addEventListener('loadedmetadata', seek);
            }
            lastQualityRef.current = r?.quality || '';
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

      /**
       * 卡顿自愈：上游对单连接限速，无损档常供不上，表现为「卡一下又恢复」。
       * 监听 waiting（缓冲耗尽），持续超过阈值且当前是无损档，就自动降一档并从原进度续播。
       * 只在本曲内自愈一次，不改用户选择的音质偏好。
       */
      useEffect(() => {
        const el = audioRef.current;
        if (!el) return;
        let timer = null;

        const clear = () => {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
        };

        const onWaiting = () => {
          clear();
          timer = setTimeout(() => {
            // 只有「正在播放却断流」才自愈；用户暂停不算
            if (el.paused || !current) return;
            if (stallFixRef.current >= 1) return;
            // 已经是低码率档就别再降了，避免降无可降时反复重取
            if (!/flac|lossless|hires/i.test(lastQualityRef.current)) return;
            const at = el.currentTime || 0;
            stallFixRef.current += 1;
            setAutoDowngrade('网络供不上无损，已自动降到更低音质');
            const i = queue.indexOf(current);
            playAt(queue, i >= 0 ? i : index, { forceLowQuality: true, keepTime: at });
          }, STALL_TIMEOUT_MS);
        };

        const onPlaying = () => clear();

        el.addEventListener('waiting', onWaiting);
        el.addEventListener('playing', onPlaying);
        el.addEventListener('canplay', onPlaying);
        return () => {
          clear();
          el.removeEventListener('waiting', onWaiting);
          el.removeEventListener('playing', onPlaying);
          el.removeEventListener('canplay', onPlaying);
        };
      }, [current, queue, index, playAt]);

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

      /**
       * 切换音质档位：循环 balanced → lossless → highest。
       * 切换后立即用新档位重取当前曲目，从原进度继续，方便直接听出差别。
       */
      const cycleQuality = useCallback(() => {
        const next = QUALITY_MODES_LIST[(QUALITY_MODES_LIST.indexOf(qualityMode) + 1) % QUALITY_MODES_LIST.length];
        setQualityMode(next);
        setError('');
        api({ type: 'quality', mode: next }).catch(() => {});
        const el = audioRef.current;
        const at = el ? el.currentTime || 0 : 0;
        if (current && queue.length) {
          // 换档意味着重新取链，允许再自愈一次
          stallFixRef.current = 0;
          const i = queue.indexOf(current);
          playAt(queue, i >= 0 ? i : index, { keepTime: at });
        }
      }, [qualityMode, current, queue, index, playAt]);

      /** 拉「我喜欢」列表。与站点共用，刷新页面后仍在。 */
      const loadFavorites = useCallback(async () => {
        setFavLoading(true);
        setFavError('');
        try {
          const data = await api({ type: 'favorites' });
          const items = Array.isArray(data?.items) ? data.items : [];
          setFavItems(items);
          setFavKeys(new Set(Array.isArray(data?.keys) ? data.keys : items.map((t) => t.trackKey)));
        } catch (e) {
          setFavError(e.message || '加载失败');
        } finally {
          setFavLoading(false);
        }
      }, []);

      /**
       * 从歌曲页链接里解析歌曲 ID。
       * 歌单曲目站点只给链接、不给 song_id，前端算 key 时也要能从链接里补出来，
       * 否则「已收藏」的高亮会和后端算出的键对不上。
       */
      const songIdFromUrl = (url) => {
        const text = String(url || '').trim();
        if (!text) return '';
        const qq = text.match(/songDetail\/([0-9A-Za-z]+)/);
        if (qq) return qq[1];
        const ne = text.match(/[?&]id=([0-9A-Za-z]+)/);
        if (ne) return ne[1];
        return '';
      };
      /** 曲目的唯一键，规则与后端一致：平台:歌曲ID，取不到 ID 才退回链接 */
      const trackKeyOf = (track) => {
        if (!track) return '';
        if (track.track_key) return String(track.track_key);
        if (track.trackKey) return String(track.trackKey);
        const sid = track.song_id || track.id || songIdFromUrl(track.url);
        if (track.platform && sid) return `${track.platform}:${sid}`;
        return String(track.url || '');
      };

      /**
       * 切换收藏。以服务端返回的 liked 为准更新本地状态，
       * 不做「先翻转再回滚」的乐观更新——收藏是低频操作，
       * 少一次状态抖动比快 200ms 更值得。
       */
      const toggleFavorite = useCallback(
        async (track) => {
          if (!track) return;
          const key = trackKeyOf(track);
          if (!key) return;
          // 同一首还在请求中，忽略连点
          if (favBusyRef.current.has(key)) return;
          favBusyRef.current.add(key);
          try {
            const r = await api({ type: 'favorite', track });
            setFavKeys((prev) => {
              const next = new Set(prev);
              if (r?.liked) next.add(r.trackKey || key);
              else next.delete(r.trackKey || key);
              return next;
            });
            // 列表同步：加入就插到最前，移除就过滤掉，避免整表重拉
            if (r?.liked) {
              const normalized = {
                trackKey: r.trackKey || key,
                title: track.title || '未命名歌曲',
                artist: track.artist || '',
                album: track.album || '',
                platform: track.platform || '',
                songId: track.song_id || track.id || '',
                url: track.url || '',
                cover: track.cover || '',
                duration: track.duration || 0,
              };
              setFavItems((prev) => [normalized, ...prev.filter((x) => x.trackKey !== normalized.trackKey)]);
            } else {
              setFavItems((prev) => prev.filter((x) => x.trackKey !== (r.trackKey || key)));
            }
            setError('');
          } catch (e) {
            setError(e.message || '收藏失败');
          } finally {
            favBusyRef.current.delete(key);
          }
        },
        [],
      );

      /** 某首歌是否已收藏。current 与列表项都可能用到。 */
      const isFavorite = useCallback(
        (track) => {
          if (!track) return false;
          const key = trackKeyOf(track);
          return key ? favKeys.has(key) : false;
        },
        [favKeys],
      );

      /** 拉发现广场数据；切分类时重新拉。 */
      const loadDiscover = useCallback(async (category) => {
        setDiscLoading(true);
        setDiscError('');
        try {
          const data = await api({ type: 'discover', category: category || '' });
          setDisc(data);
          // 选中态用「用户点的那个分类」，不要跟着后端回显跑。
          // 原因：站点对不认识的分类会静默回退成「全部」，
          // 若用回显值，按钮就会突然跳回「全部」，看起来像没点动。
          setDiscCategory(category || '全部');
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

      /**
       * 切到「喜欢」时拉一次列表。
       * 每次都拉、不做缓存：站点网页端可能刚收藏过，
       * 收藏列表通常很小（几十条），重拉比维护缓存一致性更省心。
       */
      useEffect(() => {
        if (tab !== 'fav' || !authed) return;
        if (favLoading) return;
        loadFavorites();
      }, [tab, authed, favLoading, loadFavorites]);

      // 已登出就不再展示旧数据，防止换账号后看到上一个账号的内容
      useEffect(() => {
        if (authed) return;
        setDisc(null);
        setOpenedPlaylist(null);
        setDiscCategory('全部');
        setFavItems([]);
        setFavKeys(new Set());
        setFavError('');
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

      /**
       * 曲目行右侧的心形收藏按钮。
       * 用 span + role=button 而不是 button：曲目行本身可点击播放，
       * 嵌套 button 在部分渲染器里会触发点击冒泡问题，这里显式 stopPropagation。
       * 定义必须放在所有使用它的面板之前（searchPane 就用到了）。
       */
      const favButton = (track, extraClass) =>
        h(
          'span',
          {
            className: 'mp-fav-btn' + (extraClass ? ' ' + extraClass : ''),
            role: 'button',
            tabIndex: 0,
            'data-on': isFavorite(track),
            title: isFavorite(track) ? '取消喜欢' : '喜欢（收藏到「我喜欢的音乐」）',
            'aria-label': isFavorite(track) ? '取消喜欢' : '喜欢',
            onClick: (e) => {
              e.stopPropagation();
              toggleFavorite(track);
            },
            onKeyDown: (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                toggleFavorite(track);
              }
            },
          },
          isFavorite(track) ? '♥' : '♡',
        );

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
                    favButton(item),
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
              favButton(item),
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

      /**
       * 收藏项用的是后端归一化后的字段名（trackKey/songId），
       * 而播放链路和其他列表都吃站点原始字段（track_key/song_id）。
       * 直接播放会取不到 songId，所以这里转一次。
       */
      const favToTrack = (item) => ({
        track_key: item.trackKey,
        title: item.title,
        artist: item.artist,
        album: item.album,
        platform: item.platform,
        song_id: item.songId,
        id: item.songId,
        url: item.url,
        cover: item.cover,
        duration: item.duration,
      });
      const favTracks = favItems.map(favToTrack);

      /** 「我喜欢」面板：与站点网页端同一份数据，这里改动会同步过去。 */
      const favPane = h(
        'div',
        { className: 'mp-body', style: { paddingTop: 6 } },
        error ? h('div', { className: 'mp-error' }, error) : null,
        favLoading && !favItems.length
          ? h('div', { className: 'mp-hint' }, '加载中…')
          : favTracks.length
            ? h(
                React.Fragment,
                null,
                h(
                  'div',
                  { className: 'mp-fav-head' },
                  h('span', null, `共 ${favTracks.length} 首`),
                  h(
                    'button',
                    {
                      className: 'mp-btn mp-fav-playall',
                      onClick: () => playList(favTracks, 0),
                      title: '从第一首开始播放',
                    },
                    '全部播放',
                  ),
                ),
                h(
                  'ul',
                  { className: 'mp-list' },
                  favTracks.map((item, i) =>
                    h(
                      'li',
                      {
                        key: item.track_key || `fav-${i}`,
                        className: 'mp-row',
                        'data-current': Boolean(current && current.track_key === item.track_key),
                        onClick: () => playList(favTracks, i),
                        title: `${item.title}${item.artist ? ' - ' + item.artist : ''}`,
                      },
                      h(
                        'div',
                        { className: 'mp-meta' },
                        h('div', { className: 'mp-row-title' }, item.title),
                        h('div', { className: 'mp-row-sub' }, item.artist || '未知歌手'),
                      ),
                      favButton(item),
                    ),
                  ),
                ),
              )
            : h(
                'div',
                { className: 'mp-hint' },
                '还没有喜欢的歌，点歌曲右侧的 ♡ 就能收藏到这里',
              ),
      );

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
                  // 只挡「重复点同一个分类」；换分类应当允许，否则加载中连点第二下没反应，
                  // 用户会以为筛选卡住了。
                  if (discCategory === c) return;
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
                // 切换分类时的加载条：不遮挡旧数据，但要让用户知道点击已被接收
                discLoading ? h('div', { className: 'mp-loading-bar' }, '加载中…') : null,
                // 榜单卡片。
                // 注意：站点的排行榜是「全站榜」，不随分类变化（各分类返回同一批），
                // 只有下方歌单会变。所以这里明确标注，避免用户以为筛选没生效。
                disc.charts?.length
                  ? h(
                      React.Fragment,
                      null,
                      h(
                        'div',
                        { className: 'mp-sec-title' },
                        '排行榜',
                        h('span', null, `全站 ${disc.charts.length} 个`),
                      ),
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
                // 推荐歌单。歌单才是真正随分类变化的部分，标题里带上分类名，
                // 让「点了分类之后哪里变了」一眼可见。
                disc.playlists?.length
                  ? h(
                      React.Fragment,
                      null,
                      h(
                        'div',
                        { className: 'mp-sec-title' },
                        discCategory && discCategory !== '全部' ? `${discCategory} · 推荐歌单` : '推荐歌单',
                        h('span', null, `${disc.playlists.length} 个`),
                      ),
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
              favButton(current, 'mp-fav-now'),
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
                {
                  className: 'mp-icon-btn mp-quality-btn',
                  title: `音质：${QUALITY_LABELS[qualityMode] || qualityMode}（点击切换）`,
                  onClick: cycleQuality,
                  disabled: resolving,
                },
                h('span', { className: 'mp-quality-text' }, QUALITY_SHORT[qualityMode] || '—'),
              ),
              h(
                'button',
                { className: 'mp-icon-btn', title: volume > 0 ? '静音' : '取消静音', onClick: () => setVolume(volume > 0 ? 0 : 1) },
                h(Icon, { name: 'volume', size: 15 }),
              ),
            ),
            autoDowngrade ? h('div', { className: 'mp-note' }, autoDowngrade) : null,
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
                        { className: 'mp-tab', 'data-active': tab === 'fav', onClick: () => setTab('fav') },
                        favItems.length ? `喜欢 · ${favItems.length}` : '喜欢',
                      ),
                      h(
                        'button',
                        { className: 'mp-tab', 'data-active': tab === 'queue', onClick: () => setTab('queue') },
                        queue.length ? `队列 · ${queue.length}` : '队列',
                      ),
                    ),
                    tab === 'search'
                      ? searchPane
                      : tab === 'discover'
                        ? (openedPlaylist ? openedPane : discoverPane)
                        : tab === 'fav'
                          ? favPane
                          : queuePane,
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
        h('audio', { ref: audioRef, className: 'mp-audio', preload: 'auto' }),
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
