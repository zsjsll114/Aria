/* ============================================================
 * 291-phone-remote.js — 手机遥控器视图的服务端侧（todos #17）
 *
 * 只做两件事：
 *   1) 把主窗的播放状态推到内存总线 remote_bus（/api/remote/state）
 *   2) 长轮询取回手机发出的控制指令并作用到主窗（/api/remote/cmd）
 * 不画任何 UI —— 主界面看不出来有这个功能，是刻意的（入口只在手机页）。
 *
 * ★ 为什么是 HTTP 总线而不是照抄桌面歌词的 localStorage 通道：
 *   桌面歌词窗口与主窗同浏览器同源，localStorage + storage 事件天然可达；手机是另
 *   一台设备上的另一个浏览器，origin 为 http://<局域网IP>:8001，与主窗的
 *   http://localhost:8001 不共享任何 web storage —— 跨设备用 storage 物理上不成立。
 *   总线语义（谁写谁读、只在变化时推、接收端本地外推进度、字段命名）与本文件的
 *   currentPayload 一起，仍与 250-desktop-lyrics.js 保持同一份契约。
 *   详见 remote_bus.py 模块头。
 *
 * ★ 载荷里「变化」与「新鲜」是两件事：
 *   sig 决定 seq 是否递增（手机是否要重绘），pos 只随 publish 刷新（给中途接入的
 *   手机一个锚点）。所以 2s 心跳在没变化时 seq 不动 → 手机侧拿到 204，零流量。
 *
 * ★ 后端未接线时的自我抑制：
 *   /api/remote/* 是 server.py 的可选路由（未打补丁会 404）。首个 404 即永久停用本
 *   模块并留一条 logWarn，不留后台循环刷接口。
 * ============================================================ */
import { state } from '../infrastructure/state.js';
import { audio } from './20-lyrics-render.js';
import { togglePlayPause, updatePlaybackPosition } from './65-playback-position.js';
import { nextTrack, prevTrack } from './95-track-loading.js';
import { updateVolume } from './70-audio-engine.js';
import { loadPlaylistTrack } from './135-crossfade.js';
import { sanitizeImageUrl } from './100-cover-background.js';
import { logCatch, logInfo, logWarn } from '../services/log.js';

const BUS = '/api/remote';
const PUSH_HEARTBEAT_MS = 2000;   /* 心跳：只为刷新总线侧 at（在线判定），seq 一般不变 */
const CMD_WAIT_MS = 8000;         /* 长轮询单次挂起时长 */
const QUEUE_CAP = 200;            /* 队列随载荷下发，超出截断（手机页只显示这段） */
const LYRIC_CAP = 400;            /* 全曲歌词行上限 */

/* ---------- 状态读取 ---------- */

/* 位置一律直接问 audio：state.currentTime 只在 timeupdate/rAF 里刷新（~250ms 粒度），
   作外推锚点会带一个固定的负偏差，audio.currentTime 才是权威值 */
function posMs() {
    try { return Math.max(0, (audio && isFinite(audio.currentTime) ? audio.currentTime : 0) * 1000); }
    catch (e) { logCatch('phoneRemote', e); return 0; }
}

function durMs() {
    try { return (audio && isFinite(audio.duration) && audio.duration > 0) ? audio.duration * 1000 : 0; }
    catch (e) { logCatch('phoneRemote', e); return 0; }
}

/* 封面：主窗的 sanitizeImageUrl 只做「剥脏引号/换尺寸」，不做 scheme 白名单，
   所以这里再挡一层——手机页拿到的是 <img src>，不能让 javascript: 之类的东西过去。
   另外本地曲库的封面是相对路径（/local_music/…），手机页的 origin 与本机文件路径
   不同源，必须在这里补成绝对地址，否则手机上封面永远是占位符。 */
function coverUrl(raw) {
    const u = typeof sanitizeImageUrl === 'function' ? sanitizeImageUrl(raw || '') : (raw || '');
    if (typeof u !== 'string' || !u) return '';
    let abs;
    try { abs = new URL(u, location.href).href; }
    catch (e) { logCatch('phoneRemote', e); return ''; }
    return /^https?:\/\//i.test(abs) ? abs : '';
}

/* 主题色（手机页强调色跟随主窗）。与桌面歌词同样按 TTL 缓存：
   getComputedStyle 会强制 style recalc，不能进每 2s 的常态路径 */
let _th = { v: '#ffcc33', at: 0 };
function themeColor() {
    const now = Date.now();
    if (now - _th.at < 5000) return _th.v;
    _th.at = now;
    try {
        const v = getComputedStyle(document.documentElement).getPropertyValue('--theme-color').trim();
        if (v) _th.v = v;
    } catch (e) { logCatch('phoneRemote', e); }
    return _th.v;
}

function queueView() {
    const pl = Array.isArray(state.playlist) ? state.playlist : [];
    const out = [];
    for (let i = 0; i < pl.length && i < QUEUE_CAP; i++) {
        const t = pl[i] || {};
        out.push({
            i: i,
            t: String(t.title || t.song || t.name || '未知歌曲'),
            a: String(t.artist || t.singer || '未知歌手'),
            c: coverUrl(t.cover)
        });
    }
    return { q: out, qi: typeof state.currentTrackIndex === 'number' ? state.currentTrackIndex : 0, qn: pl.length };
}

/* 歌词：整首压缩行表（手机本地定位当前行，行切换因此零延迟、不必等本端推送）
   + 仅当前行的逐字数组（横屏第二屏的卡拉OK 填充要逐字，与桌面歌词同一做法） */
function lyricView() {
    const lyr = Array.isArray(state.lyrics) ? state.lyrics : [];
    const off = (typeof globalThis.lyricOffset === 'number') ? globalThis.lyricOffset : 0;
    const lines = [];
    for (let i = 0; i < lyr.length && i < LYRIC_CAP; i++) {
        const ln = lyr[i] || {};
        const txt = String(ln.original || ln.text || '').trim();
        if (!txt) continue;
        /* 行起始时间统一叠加歌词偏移：手机本地定位当前行时，全曲必须同一个时间基准，
           否则 ls/ln 与 lyr[] 两套数会在「设过偏移的歌」上算出不同的活动行 */
        lines.push({ t: Math.round((typeof ln.start === 'number' ? ln.start : 0) + off), x: txt });
    }
    const idx = typeof state.activeLineIndex === 'number' ? state.activeLineIndex : -1;
    const cur = lyr[idx] || null;
    const nxt = (idx >= 0 && lyr[idx + 1]) ? lyr[idx + 1] : null;
    let w = null;
    if (cur && Array.isArray(cur.words) && cur.words.length) {
        w = cur.words.map(x => ({ s: Math.round(x.start), e: Math.round(x.end), x: String(x.text) }));
    }
    return {
        l1: cur ? String(cur.original || cur.text || '').trim() : '',
        l2: nxt ? String(nxt.original || nxt.text || '').trim() : '',
        tr: cur ? String(cur.translation || '').trim() : '',
        w: w,
        /* 外推锚点：已叠加歌词偏移，与手机本地时钟对齐后直接可用 */
        ls: cur && typeof cur.start === 'number' ? cur.start + off : null,
        ln: nxt && typeof nxt.start === 'number' ? nxt.start + off : null,
        lyr: lines
    };
}

/* 队列指纹：sig 里必须带上队列内容，否则「拖拽排序 / 改名 / 删歌」这类
   数量不变的重排不会 bump seq，手机上的队列就停在旧顺序（245 支持拖拽排序，
   这不是假想场景）。FNV-1a：整串哈希 + 长度，O(n) 且不引入依赖。 */
function queueFingerprint(q) {
    const s = q.map(x => x.t + '\u0002' + x.a).join('\u0001');
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0) + ':' + s.length;
}

function buildPayload() {
    const csd = state.currentSongData || {};
    const q = queueView();
    const ly = lyricView();
    const p = Object.assign({
        t: String(csd.title || (q.q[q.qi] && q.q[q.qi].t) || ''),
        a: String(csd.artist || (q.q[q.qi] && q.q[q.qi].a) || ''),
        c: coverUrl(csd.cover || (q.q[q.qi] && q.q[q.qi].c) || ''),
        dur: Math.round(durMs()),
        pos: Math.round(posMs()),
        playing: !!(audio && !audio.paused && !state.isBuffering),
        buf: !!state.isBuffering,
        vol: typeof state.volume === 'number' ? Math.round(state.volume) : 0,
        th: themeColor(),
        qi: q.qi, qn: q.qn, q: q.q,
        li: typeof state.activeLineIndex === 'number' ? state.activeLineIndex : -1
    }, ly);
    /* sig 只含「该让手机重绘」的字段：故意排除 pos（外推量）与 lyr（整首不变），
       心跳时 sig 相同 → 总线 seq 不动 → 手机轮询得到 204 */
    p.qs = queueFingerprint(q.q);
    p.sig = [p.t, p.a, p.playing ? 1 : 0, p.buf ? 1 : 0, p.vol, p.qi, p.qn, p.qs, p.li, p.ls, p.dur].join('|');
    return p;
}

/* ---------- 推送 ---------- */

let _disabled = false;
let _pushFail = 0;
let _cmdFail = 0;
let _lastTitle = '';
let _pushTimer = null;

async function push() {
    if (_disabled || !audio) return;
    try {
        const payload = buildPayload();
        const res = await fetch(`${BUS}/state`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            cache: 'no-store',
            signal: AbortSignal.timeout(5000)
        });
        if (res.status === 404) { disable('server.py 未接 /api/remote/* —— 遥控器总线已停用'); return; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        _pushFail = 0;
        /* 只在换歌时留一行日志：sig 每次歌词行切换都会变，进环形缓冲会把取链轨迹挤掉 */
        if (payload.t !== _lastTitle) {
            _lastTitle = payload.t;
            logInfo('phoneRemote', '遥控器当前曲目:', payload.t, payload.a);
        }
    } catch (e) {
        _pushFail++;
        /* 总线就在同一台机器上，连续失败通常是 server 正在重启：退避而不是刷日志 */
        if (_pushFail === 3) logWarn('phoneRemote', '状态推送失败（第 3 次）:', e);
        if (_pushFail > 30) disable('状态推送连续失败超过上限，遥控器总线已停用');
    }
}

function disable(msg) {
    if (_disabled) return;
    _disabled = true;
    logWarn('phoneRemote', msg);
    try { clearInterval(_pushTimer); } catch (e) { logCatch('phoneRemote', e); }
    _pushTimer = null;
}

/* ---------- 指令执行 ---------- */

/* 「接管只读」模式（232-nowplaying-follow：主窗只显示系统外部播放器状态）下，
   本机 audio 不承载当前歌曲，任何遥控指令都会作用到错误的对象 —— 一律拒绝，
   与 70/230 对音量与进度的同类守卫保持一致。 */
function nowPlayingTakeover() {
    try { return !!(window.Aria && window.Aria.__npActive && window.Aria.__npActive()); }
    catch (e) { logCatch('phoneRemote', e); return false; }
}

let _npWarned = false;

function seekTo(ms) {
    if (!audio || !isFinite(audio.duration) || audio.duration <= 0) return;
    const sec = Math.max(0, Math.min(audio.duration - 0.05, ms / 1000));
    audio.currentTime = sec;
    /* 同步全局位置：歌词高亮/进度条原本等下一个 timeupdate（~250ms），
       手机拖完立刻回弹到旧位置就是这个延迟 */
    state.currentTime = sec * 1000;
    updatePlaybackPosition();
}

function execCmd(c) {
    const arg = Number(c.arg);
    switch (c.cmd) {
        case 'toggle': togglePlayPause(); break;
        case 'next': nextTrack(); break;
        case 'prev': prevTrack(); break;
        case 'vol':
            if (isFinite(arg)) updateVolume(arg);
            break;
        case 'seek':
            if (isFinite(arg)) seekTo(arg);
            break;
        case 'jump': {
            const pl = Array.isArray(state.playlist) ? state.playlist : [];
            const i = Math.round(arg);
            /* 不自己写 currentTrackIndex：loadPlaylistTrack 内部已负责索引与代际控制，
               重复赋值等于给同一个状态留两个写入者（约束 11） */
            if (isFinite(i) && i >= 0 && i < pl.length && i !== state.currentTrackIndex) {
                loadPlaylistTrack(i);
            }
            break;
        }
        default:
            /* 未知指令名：手机与主窗版本不一致时静默忽略即可（新协议字段向后兼容） */
            break;
    }
}

async function cmdLoop() {
    let lastId = 0;
    while (!_disabled) {
        try {
            const res = await fetch(`${BUS}/cmd?since=${lastId}&wait=${CMD_WAIT_MS}`, {
                cache: 'no-store',
                /* 服务端最长挂起 20s，这里给足余量再自己超时：挂死的 fetch 会让整条
                   指令通道静默失效（手机按了没反应，主窗却看不出任何异常） */
                signal: AbortSignal.timeout(CMD_WAIT_MS + 6000)
            });
            if (res.status === 404) { disable('server.py 未接 /api/remote/* —— 遥控器总线已停用'); return; }
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const j = await res.json();
            if (typeof j.lastId === 'number' && j.lastId > lastId) lastId = j.lastId;
            const cmds = Array.isArray(j.cmds) ? j.cmds : [];
            for (const c of cmds) {
                if (nowPlayingTakeover()) {
                    if (!_npWarned) { _npWarned = true; logWarn('phoneRemote', '接管只读模式：忽略遥控指令', c.cmd); }
                    continue;
                }
                try { execCmd(c); }
                catch (e) { logCatch('phoneRemote', e); }
            }
            _cmdFail = 0;
        } catch (e) {
            _cmdFail++;
            if (_cmdFail === 3) logWarn('phoneRemote', '指令轮询失败（第 3 次）:', e);
            if (_cmdFail > 30) { disable('指令轮询连续失败超过上限，遥控器总线已停用'); return; }
            await new Promise(r => setTimeout(r, 2000));   /* 断线退避：别在故障期空转 */
        }
    }
}

/* ---------- 启动 ---------- */

/* 媒体事件驱动即时推送（比定时器快一个数量级，且窗口切到后台被节流时仍然触发）：
   手机上「暂停」要立刻变灰，靠 2s 心跳会有明显延迟 */
if (audio) {
    ['play', 'pause', 'seeked', 'ended', 'loadedmetadata', 'durationchange'].forEach(ev => {
        audio.addEventListener(ev, () => { push(); });
    });
}

_pushTimer = setInterval(push, PUSH_HEARTBEAT_MS);
push();
cmdLoop();
logInfo('phoneRemote', '遥控器总线已接线（/api/remote）');

export { buildPayload, execCmd, BUS };
