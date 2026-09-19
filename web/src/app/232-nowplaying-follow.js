/* ============================================================
 * 232-nowplaying-follow.js — 本机 Now Playing 接管（只读显示模式）
 * 读取用户配置的 now-playing 服务（主端点为 http://localhost:9863/api/query，
 * 兼容 kthri/now-playing 与通用 JSON 键集）。
 * ★ 语义（2026-09-14）：接管 = 只读显示。Aria 只是外部播放器的
 * 「歌词/进度/封面/状态显示屏」——检测到外部播放器换歌即锁定接管，
 * 由 WS/轮询喂入的虚拟时钟驱动 Aria 的歌词高亮与进度条；
 * 不再跨源搜索、不加载不发声，本地播放控制（播放/切歌/进度/音量/快捷键）
 * 全部让位（body.np-readonly 灰显）。要自主控制 Aria 就关掉 NPS 开关。
 *
 * 数据流：服务端探测本机播放器 → 本模块轮询 /api/query 或 WS 实时推送 →
 *         normalizeNowPlayingPayload 多键容错 → 变化检测 → 锁定接管（虚拟时钟）
 * 配置全部在设置面板「播放 → 本机 Now Playing 接管」分组，用户自行配置。
 *
 * ★ 关键健壮性设计（2026-09-13）：
 *   0) 双通道 0 延迟：优先走 ws://localhost:9863/api/ws/lyric 实时推送
 *      （切歌即推，无轮询间隔），WS 断线自动回退 8001 /proxy 轮询并重连。
 *   1) 一律经 8001 /proxy 转一层：本机 now-playing 服务多数不带 CORS 头，
 *      浏览器从 localhost:8001 直连 9863 会被同源策略直接拦死（表现为
 *      「服务明明启动了却读不到」）；转到同源代理后响应带 * CORS 头。
 *      （WS 不受 CORS 限制，直连即可。）
 *   2) 路径族自动探测：不同版本服务的接口在 /query、/api/main、/api/query
 *      等路径间摇摆，配置路径拉取失败时按序探测常见路径并写回配置，
 *      免去用户手动试地址。
 * ============================================================ */
import { normalizeNowPlayingPayload, nowPlayingKey } from '../services/nowPlayingNormalize.js';
import { saveSettings } from './180-boot-config.js';
import { logInfo, logWarn } from '../services/log.js';
import { setBlurBackground, setCoverImage } from './100-cover-background.js';    /* 切歌即时挂封面/背景 */
import { renderLyrics } from './20-lyrics-render.js';                            /* WS 歌词直取渲染入口 */
import { parseLrc } from '../parsers/lrcParser.js';                              /* LRC 文本→时间行 */
import { parseQrcLyric, parseQrcXml } from '../parsers/qrcParser.js';            /* QRC 逐字歌词（JSON行式/XML）→时间行 */
import { parseYrc } from '../parsers/yrcParser.js';                              /* YRC/QRC 内容式 [t,d](s,d)字 → 真实逐字 */
import { ensureWordTiming } from '../parsers/wordTiming.js';                      /* 行级歌词 → 逐字时间补全（无真实逐字时均分合成） */
import { startLyricsLoop } from './70-audio-engine.js';                          /* 接管显示循环（虚拟时钟驱动） */
import { PAUSE_ICON_PATH, PLAY_ICON_PATH } from './65-playback-position.js';     /* 接管时播放按钮图标跟随外部状态 */
import { playIcon, songArtistEl, songCover, songCover2, songTitleEl, totalTimeEl } from './30-dom-refs.js';
import { formatTime } from '../utils/formatters.js';                            /* 总时长显示 */
import { loadOnlineSong } from './175-track-index-online.js';                    /* 关闭接管时恢复接管前的 Aria 歌曲 */
import { LYRICS_VIRTUAL_SCROLL } from '../config/constants.js';                  /* 接管期间禁虚拟滚动（防歌词行被隐藏） */

/* ========== 轮询 / 跟播 ========== */

let pollTimer = null;
let lastKey = '';          /* 最近一次读到的曲目（含失败也更新，避免失败重放） */
let lastPlayedKey = '';    /* 最近一次触发跟播（锁定接管显示）的曲目 */
let lastFollowInfo = null; /* 最近一次完整曲目帧的归一化结果（供无歌名的 WS 状态帧补全身份） */
let prevUserPlaying = false; /* 锁定接管前 Aria 是否正在自主播放（解锁时恢复） */
let npSnapshot = null;     /* 接管前 Aria 自主状态快照（release 时完整恢复） */
let npCoverUrl = '';       /* 当前接管歌曲封面 URL（sync 每轮保真用） */
let _npIconPaused = null;  /* 已写入播放按钮图标的暂停态（脏检查用，null=未写） */
let _npSuppress = null;    /* Aria 自播压制监听（接管期间防自动恢复/榜单播放） */
let prevVirtualScroll = true; /* 接管前虚拟滚动开关（release 还原） */
let npKeepaliveTimer = null;  /* 接管保真定时器（周期性对抗 Aria 内部显示覆盖） */

/* ========== 接管只读显示模式 ==========
   锁定接管后 Aria 变为外部播放器的显示屏幕：__npDisplay 是外部播放器
   的「虚拟时钟」状态（audio 不加载歌曲，audio.currentTime 不可用），
   70 的歌词 rAF 循环与 65 的进度条优先读 __npClock() 驱动显示；
   本地播放控制全部让位（body.np-readonly 灰显 + 各控制入口短路）。 */
const npState = {
    active: false,
    seek: 0,           /* 外部播放器进度基准（秒），仅在「真实跳转」时重设 */
    seekAt: 0,         /* 记录 seek 时的 performance.now() */
    slew: 0,           /* 待补偿残差（秒）：小幅漂移在这里慢慢吸收，不动 seekAt */
    paused: true,      /* 外部播放器暂停态 */
    duration: 0,       /* 外部时长（秒） */
    lyrics: null,      /* 外部歌词行数组（{start,text,original,words?}） */
    lyricsSig: '',     /* 已注入歌词的签名（防重复渲染） */
    key: ''            /* 接管曲目身份键 */
};
function __npActive() {
    return npState.active === true;
}
/* ★ 虚拟时钟：基准 + 残差 + performance.now() 外推（并行于轮询的平滑时间源）。
   残差 slew 用来吸收「上报值的小幅漂移」，使时间轴保持连续 —— 见 applySeekCorrection。 */
function __npClock() {
    if (!npState.active) return -1;
    const base = npState.seek + (npState.slew || 0);
    if (npState.paused) return base;
    return base + (performance.now() - npState.seekAt) / 1000;
}

/* ========== 时间源校正（抖动治理核心） ==========
   ★ 实测本机 kthri/now-playing 有三路时间源，精度天差地别：
     · WS PlayerProgress.progress       → 毫秒（139428）
     · WS PlayerPauseState.seekbarCurrentPosition → 整数秒（139）
     · HTTP /api/query player.seekbarCurrentPosition → 整数秒（139）
   旧实现（npState.seek = info.seek; seekAt = now）对三者一律「无条件赋值」，
   于是每收到一个整数秒的粗值，就把平滑外推的时钟拽回整秒边界 → 每秒来回跳十来次
   = 用户看到的一顿一顿；而且**调低轮询间隔反而更糟**（粗值覆盖频率随之升高）。
   现在改为「校正」：
     · |差值| > SNAP_THRESHOLD → 判定为真实跳转（拖进度/切歌）→ 立即吸附并重置基准；
     · 毫秒源：小差值（> FINE_DEADBAND）走缓慢收敛，不重置基准；
     · 整数秒源：截断误差可达 1s，死区放到 COARSE_DEADBAND —— 只用来识别「大跳」，
       小差值一律忽略（否则会被截断值系统性往下拽约 0.5s）。
   收敛只改 slew、不动 seekAt，因此每一帧的位移都是亚毫秒级，视觉上连续无跳变。 */
const SNAP_THRESHOLD_S = 1.2;    /* 超过此差值视为真实跳转 */
const FINE_DEADBAND_S = 0.12;    /* 毫秒源：低于此差值视为噪声，忽略 */
const COARSE_DEADBAND_S = 1.0;   /* 整数秒源：必须大于截断误差 */
const SLEW_GAIN = 0.12;          /* 每次校正向目标收敛的比例 */

/**
 * 用上报进度校正虚拟时钟。返回是否发生了「真实跳转（吸附）」。
 * @param {number} reported 上报进度（秒）
 * @param {boolean} precise 来源是否为毫秒级（WS PlayerProgress）
 * @returns {boolean} 是否吸附（真实跳转）
 */
function applySeekCorrection(reported, precise) {
    if (typeof reported !== 'number' || !isFinite(reported) || reported < 0) return false;
    const now = performance.now();
    const predicted = __npClock();
    if (predicted < 0) {                       /* 尚未建立时钟：直接初始化 */
        npState.seek = reported; npState.seekAt = now; npState.slew = 0;
        return true;
    }
    const diff = reported - predicted;
    if (Math.abs(diff) > SNAP_THRESHOLD_S) {   /* 真实跳转：吸附 */
        npState.seek = reported; npState.seekAt = now; npState.slew = 0;
        return true;
    }
    if (Math.abs(diff) < (precise ? FINE_DEADBAND_S : COARSE_DEADBAND_S)) return false;
    /* 缓慢收敛：diff 已相对「含 slew 的当前预测值」，故直接按比例累加即可
       （误差按几何级数衰减，且时间轴始终连续） */
    npState.slew = (npState.slew || 0) + diff * SLEW_GAIN;
    return false;
}
/* 挂 Aria 命名空间（跨模块读取点：70 显示循环 / 65 进度条 / shortcutManager 短路） */
if (typeof window !== 'undefined' && window.Aria) {
    window.Aria.set('__npDisplay', npState);
    window.Aria.set('__npActive', __npActive);
    window.Aria.set('__npClock', __npClock);
}

/* 当前主封面显示地址（songCover/songCover2 兜底） */
function getCurrCover() {
    let c = '';
    for (const el of [songCover, songCover2]) {
        if (!el) continue;
        c = el.currentSrc || el.src || '';
        if (c) break;
    }
    return c;
}

/* 锁定接管显示：外部播放器换歌时切换显示源（不搜歌不发声）。
   立即快照 Aria 自主状态（release 完整恢复）；接管期间压制 Aria 自身
   自动播放（启动恢复/榜单自动播放等），防止"又从榜单选歌播放/换封面歌词"。 */
function lockNpDisplay(info, key) {
    const wasActive = npState.active;   /* 首轮接管才快照/记录原值，重复切歌不覆盖 */
    npState.active = true;
    npState.key = key;
    npState.seek = 0;
    npState.seekAt = performance.now();
    npState.paused = true;
    npState.lyrics = null;
    npState.lyricsSig = '';
    npState.duration = (typeof info.duration === 'number' && isFinite(info.duration) && info.duration > 0) ? info.duration : 0;
    const aud = (typeof globalThis !== 'undefined') ? globalThis.audio : null;
    /* 快照 Aria 自主状态（只记录首次接管，重复切歌不覆盖） */
    if (!npSnapshot) {
        npSnapshot = {
            playing: !!(aud && aud.getAttribute('src') && !aud.paused),
            src: (aud && aud.getAttribute('src')) ? aud.getAttribute('src') : '',
            position: (aud && isFinite(aud.currentTime)) ? aud.currentTime : 0,
            title: songTitleEl ? songTitleEl.textContent : '',
            artist: songArtistEl ? songArtistEl.textContent : '',
            totalTime: totalTimeEl ? totalTimeEl.textContent : '',
            cover: getCurrCover(),
            lyrics: (typeof globalThis !== 'undefined' && Array.isArray(globalThis.lyrics)) ? globalThis.lyrics : null,
            song: (typeof globalThis !== 'undefined' && globalThis.currentSongData) ? Object.assign({}, globalThis.currentSongData) : null
        };
    }
    /* Aria 若正在自主播放 → 静默暂停（接管只显示，避免两路音频交错） */
    if (aud && aud.getAttribute('src') && !aud.paused) {
        prevUserPlaying = true;
        try { aud.pause(); } catch (_e) {}
    }
    /* 接管期间压制 Aria 自身任何自动播放（启动恢复播放/榜单切歌等） */
    if (aud && !_npSuppress) {
        _npSuppress = () => { if (npState.active && !aud.paused) { try { aud.pause(); } catch (_e) {} } };
        aud.addEventListener('play', _npSuppress);
    }
    try {
        if (typeof document !== 'undefined') {
            document.body.classList.add('np-readonly'); /* 控件灰显禁用 */
            if (songTitleEl) songTitleEl.textContent = info.title || '';
            if (songArtistEl) songArtistEl.textContent = info.artist || '';
            if (totalTimeEl && npState.duration > 0) totalTimeEl.textContent = formatTime(npState.duration * 1000);
        }
    } catch (_e) {}
    /* 接管期间禁用歌词虚拟滚动：默认模式虚拟窗口只随用户滚轮更新，
       长歌词（>renderRange）播放滚动到后端时行会被 placeholder 隐藏"消失"，
       接管改为全量渲染。
       ★ 只在首轮接管记录原值：lockNpDisplay 每换一首歌都会跑，若无条件记录，
       第二次读到的就是被自己置成 false 的值 → release 时还原成 false，
       虚拟滚动被永久关掉（切歌后整页歌词全量渲染，长歌词明显变卡）。 */
    if (!wasActive) prevVirtualScroll = LYRICS_VIRTUAL_SCROLL.enabled;
    LYRICS_VIRTUAL_SCROLL.enabled = false;
    /* 清空 Aria 旧歌词层（接管只显示外部歌词；快照已保存 Aria 歌词供恢复） */
    try { renderLyrics([]); } catch (_e) {}
    /* 即时挂封面/背景（不等 poll 再刷） */
    if (info.cover) {
        npCoverUrl = info.cover;
        try { setCoverImage(info.cover); setBlurBackground(info.cover); } catch (_e) {}
    }
    try { startLyricsLoop(); } catch (_e) {} /* 启动显示循环（虚拟时钟驱动） */
    /* 1s 保真定时器：对抗 Aria 内部（开篇歌单自动播放等）对歌名/封面/歌词的异步覆盖 */
    if (!npKeepaliveTimer) {
        npKeepaliveTimer = setInterval(() => { npEnforceDisplay(lastFollowInfo); }, 1000);
    }
}

/* 恢复接管前的 Aria 自主状态：歌名/歌手/总时长/封面/歌词/播放（含播放链） */
function restoreSnapshot(snap) {
    if (!snap) return;
    const aud = (typeof globalThis !== 'undefined') ? globalThis.audio : null;
    try {
        if (songTitleEl) songTitleEl.textContent = snap.title || '';
        if (songArtistEl) songArtistEl.textContent = snap.artist || '';
        if (totalTimeEl && snap.totalTime) totalTimeEl.textContent = snap.totalTime;
    } catch (_e) {}
    /* 封面恢复 */
    if (snap.cover) { try { setCoverImage(snap.cover); } catch (_e) {} }
    /* 歌词层恢复（接管期间可能被 Aria 内部渲染覆盖，务必还原；无歌词时清空） */
    try {
        const back = (Array.isArray(snap.lyrics) && snap.lyrics.length) ? snap.lyrics : [];
        renderLyrics(back);
        if (typeof globalThis !== 'undefined' && globalThis.Aria && typeof globalThis.Aria.__lyricsRebuildChain === 'function') {
            globalThis.Aria.__lyricsRebuildChain();
        }
    } catch (_e) {}
    /* 播放恢复：接管前在播才恢复；src 仍在 → 原位续播；src 被换过 → 重载接管前歌曲 */
    if (snap.playing && aud) {
        const sameSrc = !!snap.src && aud.getAttribute('src') === snap.src;
        if (sameSrc) {
            try {
                if (aud.paused) {
                    if (snap.position > 0 && isFinite(snap.position) && isFinite(aud.duration) && snap.position < aud.duration) {
                        aud.currentTime = snap.position;
                    }
                    const pr = aud.play();
                    if (pr && typeof pr.catch === 'function') pr.catch(() => {});
                }
            } catch (_e) {}
        } else if (snap.song && typeof loadOnlineSong === 'function') {
            try { loadOnlineSong(snap.song); } catch (_e) {}
        }
    }
}

/* 释放接管：关闭 NPS 开关时恢复 Aria 自主（接管前状态完整还原） */
function releaseNpDisplay() {
    const snap = npSnapshot;
    npSnapshot = null;
    if (npState.active) {
        npState.active = false;
        npState.lyrics = null;
        npState.lyricsSig = '';
        npCoverUrl = '';
        /* ★ 清空切歌判等键：否则「关掉 NPS 再打开」时同一首外部歌的 key 没变，
           processNowPlayingUpdate 里 changed=false → 永不重新锁定接管，
           Aria 保持自由播放态（表现为"开关像失灵了"）。清空后下一轮轮询
           会把当前曲目重新识别为"换歌"并接管。 */
        lastKey = '';
        lastPlayedKey = '';
        _npIconPaused = null;   /* 图标交回 audio 事件管理；下次接管需重新写入 */
        LYRICS_VIRTUAL_SCROLL.enabled = prevVirtualScroll; /* 还原虚拟滚动 */
        if (npKeepaliveTimer) { clearInterval(npKeepaliveTimer); npKeepaliveTimer = null; } /* 停保真定时器 */
        try { if (typeof document !== 'undefined') document.body.classList.remove('np-readonly'); } catch (_e) {}
        /* 移除 Aria 自播压制 */
        const aud = (typeof globalThis !== 'undefined') ? globalThis.audio : null;
        if (_npSuppress && aud) {
            aud.removeEventListener('play', _npSuppress);
            _npSuppress = null;
        }
        if (snap) restoreSnapshot(snap);
    }
    prevUserPlaying = false;
}

function cfg() {
    return (typeof appSettings !== 'undefined' && appSettings.nowPlaying) ? appSettings.nowPlaying : null;
}

/* 已知的 now-playing 服务路径族（主流服务主端点是 /api/query，各发行版其余路径按序探测） */
const PROBE_PATHS = ['/api/query', '/api/query/track', '/api/main', '/api/query/song', '/query', '/api/now-playing', '/api/nowplaying', '/api/info'];

function proxyHref(url) {
    /* 本机页面（开发/桌面壳都是 localhost:8001）一律经 8001 /proxy 转发：
       now-playing 服务大多不带 CORS 头，直连 9863 会被浏览器同源策略拦死；
       server.py 对 localhost 来源放行且响应补 Access-Control-Allow-Origin: *。
       非本机页面（如 file:// 直开）回退直连。 */
    if (typeof location !== 'undefined' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(location.origin)) {
        return '/proxy?url=' + encodeURIComponent(url);
    }
    return url;
}

async function fetchJsonOnce(fetchUrl) {
    const ctl = new AbortController();
    const tid = setTimeout(() => ctl.abort(), 6000);
    try {
        const res = await fetch(fetchUrl, { signal: ctl.signal, headers: { Accept: 'application/json' } });
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        /* 服务未启动/端口占用/网络失败等常态，静默留痕即可 */
        return null;
    } finally {
        clearTimeout(tid);
    }
}

let lastProbeAt = 0;   /* 路径族探测冷却时间戳 */

async function fetchNowPlayingJson() {
    const c = cfg();
    if (!c || !c.url) return { reachable: false, raw: null };

    /* 先试配置路径：只要有 HTTP 响应就算「可达」——响应体歌名为空时属
       「播放器当前无曲目」，与「服务没启动」是两回事，文案要分开说清。
       ★ 返回原始负载（不在此归一化）：归一化统一放到 pollNowPlaying 做一次，
       避免对已归一化对象二次 normalize 丢掉 player 节点的 paused/seek。 */
    const raw = await fetchJsonOnce(proxyHref(c.url));
    if (raw) {
        return { reachable: true, raw };
    }

    /* 配置路径 404/超时/格式不符：常见路径族探测一次（10s 冷却，防轮询风暴），
       命中即写回配置并对本轮继续生效，免去手动试地址 */
    const now = Date.now();
    if (now - lastProbeAt < 10000) return { reachable: false, raw: null };
    lastProbeAt = now;
    const base = (c.url || '').trim().replace(/\/+$/, '');
    const origin = (base.match(/^(https?:\/\/[^/]+)/i) || [])[1];
    if (!origin) return { reachable: false, raw: null };
    for (const p of PROBE_PATHS) {
        if (base.endsWith(p)) continue;
        const hit = await fetchJsonOnce(proxyHref(origin + p));
        if (hit) {
            if (normalizeNowPlayingPayload(hit)) {
                c.url = origin + p;
                try { saveSettings(); } catch (e) { /* 静默 */ }
                logInfo('nowPlaying', `[接管] 探测到可用路径 ${c.url} 并已写回配置`);
            }
            return { reachable: true, raw: hit };
        }
    }
    return { reachable: false, raw: null };
}

/* 接管 = 只读显示：不再跨源搜索播放（旧 followPlay 链路已删除）。 */

/**
 * 轮询一次并（可选）锁定接管显示；同时刷新设置面板状态文本（试读也走这里，未切歌不重接管）。
 * @returns {Promise<object|null>} 解析出的当前歌曲信息
 */
export async function pollNowPlaying() {
    const c = cfg();
    if (!c || !c.url) return null;
    const statusEl = typeof document !== 'undefined' ? document.getElementById('nowPlayingStatus') : null;
    const { reachable, raw } = await fetchNowPlayingJson();

    if (!reachable) {
        /* 网络失败/404/探测全空 → 服务真没起来（或地址不对），与「没歌」要分开说 */
        if (statusEl) statusEl.textContent = '读取失败（服务未启动或地址不对，已自动尝试常见路径）';
        return null;
    }
    /* ★ 单次归一化（fetchNowPlayingJson 已返回原始负载）：player 节点的
       isPaused/seekbarCurrentPosition 必须保留给 syncNowPlayingState，
       二次归一化会把这两个字段丢掉 → 暂停/进度镜像失效。 */
    const info = raw ? normalizeNowPlayingPayload(raw) : null;
    if (!info) {
        /* 服务在线、响应正常，但当前没有可跟播的曲目（播放器未播放/无歌曲） */
        if (statusEl) statusEl.textContent = '服务已连接，当前播放器没有正在播放的歌曲';
        return null;
    }
    return processNowPlayingUpdate(info);
}

/**
 * 结果处理（轮询与 WS 消息共用）：刷新状态文本 + 切歌检测 + 锁定接管显示。
 * lastKey/lastPlayedKey 双通道共用，切歌判定天然去重，不会重复接管。
 */
async function processNowPlayingUpdate(info) {
    if (!info) return null;
    const statusEl = typeof document !== 'undefined' ? document.getElementById('nowPlayingStatus') : null;
    if (statusEl) statusEl.textContent = `${info.title}${info.artist ? ' - ' + info.artist : ''}`;

    const c = cfg();
    const key = nowPlayingKey(info);
    const changed = key !== lastKey;
    lastKey = key;
    /* 提前缓存最新完整曲目帧（必须在接管锁定之前）：WS 的
       PlayerPauseState/PlayerProgress 帧不含歌名，靠它补全身份。 */
    lastFollowInfo = info;
    /* ★ 接管 = 只读显示：检测到外部播放器换歌 → 锁定接管（不再跨源搜索播放）。
       封面/背景/标题在 lockNpDisplay 内即时设置。重复接管防抖由 lastPlayedKey 保证。
       autoFollow=false 则只显示状态不接管。 */
    if (c && c.enabled && c.autoFollow && changed && key !== lastPlayedKey) {
        lastPlayedKey = key;
        lockNpDisplay(info, key);
        if (statusEl) statusEl.textContent = `已接管显示：${info.title}${info.artist ? ' - ' + info.artist : ''}`;
        logInfo('nowPlaying', `[接管] 锁定只读显示: ${info.title} - ${info.artist}`);
    }
    /* ★ 状态镜像（暂停/续播/进度）→ 写入虚拟时钟，驱动 Aria 显示层跟随外部播放器 */
    if (c && c.enabled && lastPlayedKey === key) syncNowPlayingState(info);
    return info;
}

/* ★ WS 播放器状态帧处理（kthri/now-playing 事件型推送，0 延迟不靠轮询）：
   event='PlayerPauseState' → data:{isPaused, seekbarCurrentPosition(秒), ...}
   event='PlayerProgress'   → data:{progress(毫秒)}
   帧内无歌名 → 用 lastFollowInfo 补全身份，仅「当前跟播曲目」生效。
   NPS 上按暂停/续播/拖进度条，Aria 立即同步，不再等 2~5s 轮询间隔。 */
function handleWsStateFrame(evtData) {
    if (!evtData || typeof evtData !== 'object') return;
    if (!lastFollowInfo || !lastPlayedKey) return;
    if (lastPlayedKey !== nowPlayingKey(lastFollowInfo)) return; /* 仅跟播中 */
    const event = evtData.event;
    const node = (evtData.data && typeof evtData.data === 'object') ? evtData.data : evtData;
    if (!node || typeof node !== 'object') return;

    let ins = null;
    const isProgress = event === 'PlayerProgress'
        || (typeof node.progress === 'number' && typeof node.isPaused !== 'boolean' && typeof node.seekbarCurrentPosition !== 'number');
    if (isProgress) {
        /* progress 单位毫秒（实测 kthri：1128 → 1.128s）——三路时间源里唯一的高精度源，
           标记 seekPrecise 让它走细校正；整数秒的 seekbarCurrentPosition 只做粗跳识别。 */
        const s = (node.progress || 0) / 1000;
        if (!isFinite(s) || s <= 0) return;
        ins = { seek: s, seekPrecise: true };
    } else {
        const pausedSet = typeof node.isPaused === 'boolean';
        const seekNum = typeof node.seekbarCurrentPosition === 'number' && isFinite(node.seekbarCurrentPosition);
        if (!pausedSet && !seekNum) return;
        ins = { isPlaying: pausedSet ? !node.isPaused : undefined };
        if (pausedSet) ins.paused = node.isPaused;
        if (seekNum) ins.seek = node.seekbarCurrentPosition;   /* 整数秒：粗源，不标 precise */
        if (ins.isPlaying === undefined) delete ins.isPlaying;
    }
    if (!ins) return;
    syncNowPlayingState(Object.assign({}, lastFollowInfo, ins));
}

/* ★ 接管状态镜像：把外部播放器的暂停/续播/进度写入虚拟时钟（__npDisplay），
   由 70 的歌词 rAF / 65 的进度条读取驱动显示；不操作 audio（只显示不操控）。
   播放按钮图标跟随外部播放状态（点击仍无反应，本地控制已短路）。 */
function syncNowPlayingState(info) {
    if (!info || !npState.active) return;
    if (typeof info.paused === 'boolean') {
        const wasPaused = npState.paused;
        npState.paused = info.paused;
        if (wasPaused && !info.paused) {
            /* 暂停 → 续播：把「当前外推位置（含残差）」折进基准后重新计时，
               保持时间轴连续；否则残差会被重复计入造成跳变。 */
            const cur = __npClock();
            if (cur >= 0) {
                npState.seek = cur;
                npState.seekAt = performance.now();
                npState.slew = 0;
            }
        }
    }
    /* ★ 进度走「校正」而非「赋值」：小数差值缓慢吸收，大跳才吸附（见 applySeekCorrection）。
       seekPrecise=true 仅由 WS PlayerProgress（毫秒级）给出；整数秒源只做粗跳识别。 */
    if (typeof info.seek === 'number' && isFinite(info.seek) && info.seek >= 0) {
        applySeekCorrection(info.seek, info.seekPrecise === true);
    }
    if (typeof info.duration === 'number' && isFinite(info.duration) && info.duration > 0) {
        npState.duration = info.duration;
    }
    npEnforceDisplay(info);
}

/* 接管显示保真（每轮状态帧 + 1s 保真定时器调用）：
   Aria 内部（启动开篇歌单自动播放/上次队列恢复等）会异步覆盖歌名/封面/歌词，
   这里周期性地把外部显示写回。info 为最新完整曲目帧，null 时仅做无源保真。 */
function npEnforceDisplay(info) {
    if (!npState.active) return;
    /* 标题/歌手/总时长/播放按钮图标（★ 全部脏检查后再写：本函数被状态帧以
       最高 ~10 次/秒的频率调用（interval=0.1 + WS 帧），无条件重写会让
       playIcon.innerHTML 每帧重新解析整段 SVG、并触发无谓重排/重绘。） */
    try {
        if (info && info.title && songTitleEl && songTitleEl.textContent !== info.title) {
            songTitleEl.textContent = info.title;
        }
        if (info && info.artist && songArtistEl && songArtistEl.textContent !== info.artist) {
            songArtistEl.textContent = info.artist;
        }
        if (totalTimeEl && npState.duration > 0) {
            const tt = formatTime(npState.duration * 1000);
            if (totalTimeEl.textContent !== tt) totalTimeEl.textContent = tt;
        }
        if (playIcon && _npIconPaused !== npState.paused) {
            playIcon.innerHTML = npState.paused ? PLAY_ICON_PATH : PAUSE_ICON_PATH;
            _npIconPaused = npState.paused;
        }
    } catch (_e) {}
    /* 封面保真：覆盖了封面（启动自动恢复等）拉回 NPS 封面 */
    if (info && info.cover) npCoverUrl = info.cover;
    if (npCoverUrl) {
        try {
            const cur = getCurrCover();
            if (cur && cur !== npCoverUrl) setCoverImage(npCoverUrl);
        } catch (_e) {}
    }
    /* 歌词保真：歌词层行数 ≠ 外部歌词行数 → 写回（外部无歌词则清空，防 Aria 内部歌词残留） */
    try {
        const scan = typeof document !== 'undefined' ? document.getElementById('lyricsScroll') : null;
        const cnt = scan ? scan.querySelectorAll('.line').length : 0;
        const want = (npState.lyrics && npState.lyrics.length) ? npState.lyrics.length : 0;
        if (cnt !== want) {
            if (want) applyExternalLyrics(npState.lyrics, true);
            else renderLyrics([]);
        }
    } catch (_e) {}
    try { startLyricsLoop(); } catch (_e) {} /* 保证接管显示循环常驻 */
}

/* WS 歌词帧容错提取：在任意包裹层找「含 [mm:ss] 时间标签的 LRC 文本」
   或 {lines:[{time|start,text}]} 数组；找不到返回 null，不影响其它帧处理。
   QRC 逐字歌词（JSON 行式 / XML）由 ../parsers/qrcParser.js 的
   parseQrcLyric / parseQrcXml 解析（Node 单测覆盖）。
   ★ 输出一律经 ensureWordTiming 补齐逐字时间（真实逐字保留，行级则均分合成），
   否则 renderLyrics 会按纯文本渲染、逐字层根本不存在。 */
function extractWsLyrics(data) {
    if (!data || typeof data !== 'object') return null;
    /* ★ 显式逐字字段优先：服务端（如 kthri/now-playing）把行级与逐字分开放
       —— `lrc` 是行级，`karaokeLyric` 才是逐字。若不做这一步，通用的字符串
       walk 会先命中 `lrc`（内含 "t"/"c"/"tx"）而吃掉逐字分支，逐字永远用不上。
       内容式为 `[行起,行时长](字起,字时长)字…`，直接交给 parseYrc 拿到真实逐字。 */
    const explicit = (data.data && typeof data.data === 'object') ? data.data : data;
    for (const key of ['karaokeLyric', 'karaoke_lyric', 'yrc', 'qrc']) {
        const v = explicit[key];
        if (typeof v !== 'string' || !v.trim()) continue;
        const parsed = parseYrc(v);
        if (parsed && parsed.length >= 2 && parsed.some(l => l.words && l.words.length)) {
            return withWordTiming(parsed.map(l => ({
                start: l.start, end: l.end, text: l.original, original: l.original, words: l.words
            })));
        }
    }
    let lrcText = '';
    let qrcLines = null;
    let lineArr = null;
    const walk = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 6) return;
        if (lrcText || qrcLines || lineArr) return;
        for (const k of Object.keys(node)) {
            const v = node[k];
            if (lrcText || qrcLines || lineArr) return;
            if (typeof v === 'string') {
                if (v.includes('[') && /\[\d{1,2}:\d{1,2}[.:\d]*\]/.test(v)) {
                    lrcText = v; return;
                }
                /* QRC-lrc：{"t":..,"c":[{"tx":..}]}（可为多行拼接） */
                if (v.includes('"t"') && v.includes('"c"') && v.includes('"tx"')) {
                    const q = parseQrcLyric(v);
                    if (q) { qrcLines = q; return; }
                }
                /* QRC-XML 逐字（karaokeLyric）：hasLyric=false 时歌词常只在此 */
                if ((v.includes('<LyricInfo') || v.includes('<QrcInfos')) && v.includes('LyricTime')) {
                    const q = parseQrcXml(v);
                    if (q) { qrcLines = q; return; }
                }
            }
            if (Array.isArray(v)) {
                const lines = v.filter(it => it && typeof it === 'object'
                    && (typeof it.time === 'number' || typeof it.start === 'number') && typeof it.text === 'string');
                if (lines.length >= 2) { lineArr = lines; return; }
                continue;
            }
            if (v && typeof v === 'object') walk(v, depth + 1);
        }
    };
    walk(data, 0);
    let lines = null;
    if (lrcText) {
        const parsed = parseLrc(lrcText);   /* [time:ms, text] */
        if (parsed && parsed.length >= 2) {
            lines = parsed.map(l => ({ start: l.time, text: l.text, original: l.text }));
        }
    } else if (qrcLines) {
        lines = qrcLines; /* 已是 {start:ms, text, original} */
    } else if (lineArr) {
        lines = lineArr.slice(0, 300).map(l => {
            const s = (typeof l.time === 'number' ? l.time : l.start) || 0;
            return { start: s > 1000 ? s : s * 1000, text: l.text, original: l.text }; /* ms 与秒自适应 */
        });
    }
    return withWordTiming(lines);
}

/* 给外部歌词补逐字时间：真实逐字（含 time/duration）保留，行级按行区间均分合成。
   总时长取接管曲目 duration，用于末行的结束时间。详见 parsers/wordTiming.js */
function withWordTiming(lines) {
    if (!Array.isArray(lines) || lines.length < 2) return lines;
    const totalMs = npState.duration > 0 ? Math.round(npState.duration * 1000) : 0;
    return ensureWordTiming(lines, { totalMs });
}

/* 采用 WS 直取歌词：灌入 Aria 渲染层并重建弹簧（物理引擎随之适配新行）。
   仅当正在接管某曲目时采纳，避免覆盖用户自播歌曲的歌词；签名幂等防重复注入。
   force=true 时忽略签名（歌词保真重注用）。 */
function applyExternalLyrics(lines, force) {
    if (!lines || !Array.isArray(lines) || lines.length < 2) return;
    if (!lastPlayedKey || lastPlayedKey !== lastKey) return;
    /* 签名去重：服务端可能反复推送同一份歌词（含切歌瞬间），避免反复重建渲染层 */
    const sig = lines.length + '|' + String((lines[0] && (lines[0].original || lines[0].text)) || '');
    if (!force && npState.lyricsSig === sig) return;
    npState.lyricsSig = sig;
    try {
        renderLyrics(lines);
        npState.lyrics = lines; /* 同步到虚拟状态（供显示层/一致性） */
        if (typeof globalThis !== 'undefined' && globalThis.Aria && typeof globalThis.Aria.__lyricsRebuildChain === 'function') {
            globalThis.Aria.__lyricsRebuildChain();
        }
        logInfo('nowPlaying', `[接管] 已采用 NPS 歌词 ${lines.length} 行（WS 直取）`);
    } catch (_e) { /* 歌词注入失败不阻塞显示 */ }
}

/* ========== WebSocket 实时通道（0 延迟，断线回退轮询） ========== */

let ws = null;
let wsConnected = false;
let wsReconnectTimer = null;
const WS_RECONNECT_MS = 3000;

function wsUrl() {
    const c = cfg();
    if (!c || !c.url) return '';
    /* 取配置 URL 的 origin，把路径换成 /api/ws/lyric：http→ws / https→wss */
    const m = (c.url || '').match(/^(https?):\/\/([^/]+)/i);
    if (!m) return '';
    return `${m[1] === 'https' ? 'wss' : 'ws'}://${m[2]}/api/ws/lyric`;
}

/** 从 WS 消息里尽力提取歌曲信息：兼容直接负载或 {type,data} / {song} / {data:{...}} 各类包裹 */
function extractWsSong(evtData) {
    if (!evtData || typeof evtData !== 'object') return null;
    const direct = normalizeNowPlayingPayload(evtData);
    if (direct) return direct;
    for (const k of ['data', 'detail', 'payload', 'nowPlaying', 'now_playing', 'track', 'song', 'music', 'play']) {
        const node = evtData[k];
        if (node && typeof node === 'object') {
            const hit = normalizeNowPlayingPayload(node);
            if (hit) return hit;
        }
    }
    return null;
}

function scheduleWsReconnect() {
    const c = cfg();
    if (!c || !c.enabled || wsReconnectTimer) return;
    wsReconnectTimer = setTimeout(() => {
        wsReconnectTimer = null;
        connectWs();
    }, WS_RECONNECT_MS);
}

function disconnectWs() {
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        try { ws.close(); } catch (e) { /* 静默 */ }
        ws = null;
    }
    wsConnected = false;
}

function connectWs() {
    const c = cfg();
    if (!c || !c.enabled) return;
    if (wsConnected) return;   /* 已连接：仅保留低频轮询兜底，不重复建连 */
    const url = wsUrl();
    if (!url) return;
    disconnectWs();
    let socket;
    try {
        socket = new WebSocket(url);
    } catch (e) {
        logWarn('nowPlaying', '[WS] 连接异常:', e.message);
        return;
    }
    ws = socket;
    socket.onopen = () => {
        if (socket !== ws) return;
        wsConnected = true;
        logInfo('nowPlaying', `[WS] 已连接 ${url}（0 延迟推送接管，轮询低频兜底）`);
        /* ★ 关键：WS 在线也不再停轮询——WS 若只推歌词/进度帧（无歌名）会成为黑洞，
           导致"开关开了却永远不跟播"。改为轮询低频兜底(interval×3s)，双通道去重后幂等。 */
        pollLowFreq = true;
        schedulePollTimer();
    };
    socket.onmessage = (ev) => {
        if (socket !== ws) return;
        let payload = ev.data;
        /* ★ Blob 帧兼容：部分服务/浏览器下 WS 帧以 Blob 送达，JSON.parse 直接 throw，
           导致即使收到切歌帧也永远不跟播（表现正是"能读到状态但迟迟不切歌"） */
        if (payload && typeof payload === 'object' && typeof payload.text === 'function') {
            payload.text().then(txt => {
                let data = null;
                try { data = JSON.parse(txt); } catch (e) { /* 非 JSON 文本帧，跳过 */ }
                const info = extractWsSong(data);
                if (info) processNowPlayingUpdate(info);
                /* ★ 歌词提取对「每个帧」都尝试（不限于 !info）：
                   Lyric 帧常同时带 title/author（extractWsSong 会命中），
                   若只放在 !info 分支会被截胡 → 歌词永不注入（"歌词不切换"）。
                   状态帧处理仍只在「无歌名且无歌词」时兜底。 */
                const ly = extractWsLyrics(data);
                if (ly) applyExternalLyrics(ly);
                else if (!info) handleWsStateFrame(data);
            }).catch(() => { /* 文本解析失败忽略 */ });
            return;
        }
        let data = null;
        try { data = JSON.parse(ev.data); } catch (e) { /* 非 JSON 文本帧，跳过 */ }
        const info = extractWsSong(data);
        if (info) processNowPlayingUpdate(info);
        /* ★ 同上：歌词提取对所有帧尝试；无歌名无歌词的帧才走状态/进度镜像 */
        const ly = extractWsLyrics(data);
        if (ly) applyExternalLyrics(ly);
        else if (!info) handleWsStateFrame(data);
    };
    socket.onclose = () => {
        if (socket !== ws) { socket = null; return; }
        wsConnected = false;
        ws = null;
        pollLowFreq = false;
        logInfo('nowPlaying', '[WS] 连接断开，回退常规轮询并尝试重连');
        /* 恢复常规频率轮询（不要再立刻 connectWs：连接失败→关闭→再连 会形成紧循环），
           重连统一交给 scheduleWsReconnect 的 3s 定时器 */
        schedulePollTimer();
        scheduleWsReconnect();
    };
    socket.onerror = () => {
        try { socket.close(); } catch (e) { /* 静默 */ }
    };
}

/* ========== 轮询定时器 ========== */

let pollLowFreq = false;   /* WS 在线时轮询低频兜底开关（防 WS 黑洞导致永不跟播） */
let pollNextAt = 0;        /* 下一拍的计划时刻（performance.now() 时间基） */
let _ivDebounce = null;    /* 轮询间隔滑块防抖句柄（拖动中 input 连发，见设置绑定） */

/* 纯轮询调度（链式 setTimeout）：每轮按「跟播锁定」实时重算频率——
   跟播锁定期间用常规 interval（暂停/播放/进度即时到位），
   仅「WS 在线且未跟播」时才降为低频兜底。杜绝 setInterval 频率锁死、
   跟播锁定后仍以 15s 兜底档同步导致"在 NPS 上暂停/跳进度毫无反应"。
   支持亚秒间隔（设置面板 0.1s = 100ms）。
   ★ 固定时间基排期：下一拍 = 「上一拍的计划时刻 + 周期」，与本次请求耗时无关。
   旧实现是 await 请求返回后才 schedulePollTimer() → 实际周期 = 间隔 + 请求耗时 + 抖动，
   节拍不稳；请求被挂起（最长 6s 超时）时位置源整段断供，只能靠外推，随后一次性大跳。
   pollNextAt 已落后于当下 = 上一拍超时（请求慢/被挂起）→ 重新对齐而不补拍，避免风暴。 */
function schedulePollTimer() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    const c = cfg();
    const on = !!(c && c.enabled);
    if (!on || !c.interval || c.interval < 0.1) { pollNextAt = 0; return; }
    const following = !!(lastPlayedKey && lastPlayedKey === lastKey);
    const iv = (pollLowFreq && !following) ? Math.max(0.1, c.interval * 3) : c.interval;
    const period = iv * 1000;
    const now = performance.now();
    if (!pollNextAt || pollNextAt <= now) pollNextAt = now + period;
    pollTimer = setTimeout(async () => {
        pollTimer = null;
        pollNextAt += period;
        try { await pollNowPlaying(); } catch (_e) { /* 单轮失败不中断链 */ }
        schedulePollTimer(); /* 链式重排：频率随跟随态实时变化 */
    }, Math.max(0, pollNextAt - now));
}

function restartPollTimer() {
    const c = cfg();
    const on = !!(c && c.enabled);
    if (on) {
        pollNowPlaying(); /* 立即读一次（启动即接管 / WS 上线首拉 / 开关开启） */
        schedulePollTimer();
        connectWs();   /* WS 实时通道协同：onopen 后轮询自动转低频兜底 */
    } else {
        pollLowFreq = false;
        pollNextAt = 0;   /* 清排期基：下次开启从当下重新对齐，不用陈旧的计划时刻 */
        lastFollowInfo = null;
        releaseNpDisplay(); /* 关闭接管：恢复 Aria 自主（含接管前正在播放的歌） */
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        disconnectWs();
    }
}

/* ========== 设置面板绑定（initSettingsMisc 在启动时调用一次，无重复绑定） ========== */

function bindToggle(id, initialVal, onChange) {
    const el = typeof document !== 'undefined' ? document.getElementById(id) : null;
    if (!el) return;
    if (initialVal) el.classList.add('on');
    el?.addEventListener('click', () => {
        el.classList.toggle('on');
        onChange(el.classList.contains('on'));
    });
}

/* ★ 统一的 Now Playing 启用开关：右上角快捷开关与设置面板开关双向同步。
   任一开关翻转 → 落盘 + 重启轮询/WS + 刷新两端 UI 高亮态。 */
function setNpEnabled(on) {
    const c = cfg();
    if (!c) return;
    c.enabled = !!on;
    saveSettings();
    restartPollTimer();
    applyNpEnabledUI();
}
function applyNpEnabledUI() {
    const c = cfg();
    const on = !!(c && c.enabled);
    for (const id of ['npEnabled', 'npQuickToggle']) {
        const el = typeof document !== 'undefined' ? document.getElementById(id) : null;
        if (el) el.classList.toggle('on', on);
    }
}

export function initNowPlayingSettings() {
    const c = cfg();
    if (!c) return;

    const urlEl = typeof document !== 'undefined' ? document.getElementById('npUrl') : null;
    const ivEl = typeof document !== 'undefined' ? document.getElementById('npInterval') : null;
    const ivVal = typeof document !== 'undefined' ? document.getElementById('npIntervalVal') : null;
    const peekBtn = typeof document !== 'undefined' ? document.getElementById('npPeek') : null;

    if (urlEl) urlEl.value = c.url;
    if (ivEl) { ivEl.value = String(c.interval); }
    if (ivVal) ivVal.textContent = String(c.interval);

    bindToggle('npEnabled', c.enabled, (v) => setNpEnabled(v));
    bindToggle('npAutoFollow', c.autoFollow, (v) => {
        c.autoFollow = v;
        saveSettings();
    });
    /* ★ 右上角快捷开关：与设置面板 #npEnabled 共用状态（applyNpEnabledUI 双向同步） */
    bindToggle('npQuickToggle', c.enabled, (v) => setNpEnabled(v));

    urlEl?.addEventListener('change', () => {
        c.url = (urlEl.value || '').trim();
        saveSettings();
        /* ★ 地址变了必须重建 WS（wsConnected 时 connectWs 会直接 return，旧地址僵尸连接残留） */
        pollLowFreq = false;
        disconnectWs();
        restartPollTimer();
    });
    ivEl?.addEventListener('input', () => {
        const n = Math.min(30, Math.max(0.1, parseFloat(ivEl.value) || 2));
        ivEl.value = String(n);
        if (ivVal) ivVal.textContent = String(n);
        c.interval = n;
        saveSettings();
        /* ★ 防抖：拖动滑块时 input 会连发几十次，每次都 restartPollTimer()
           会立刻并发打出一串 /api/query 请求（还会反复重建 WS 连接）。
           等手停下来再重启轮询/WS。 */
        if (_ivDebounce) clearTimeout(_ivDebounce);
        _ivDebounce = setTimeout(() => {
            _ivDebounce = null;
            restartPollTimer();
        }, 250);
    });
    peekBtn?.addEventListener('click', () => {
        peekBtn.disabled = true;
        const st = typeof document !== 'undefined' ? document.getElementById('nowPlayingStatus') : null;
        if (st) st.textContent = '读取中...';
        pollNowPlaying().finally(() => { peekBtn.disabled = false; });
    });

    restartPollTimer();
}

/* 启动钩子由 200-settings-panel 的 initSettingsMisc 调用 initNowPlayingSettings() */