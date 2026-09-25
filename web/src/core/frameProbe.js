/* ============================================================
 * core/frameProbe.js — 帧时采样器（纯逻辑，todos #21 的数据源）
 *
 * 为什么要有它：低性能设备（虚拟机/无独显）的帧率**在开发机上测不出来**
 * （AGENTS 约束 12：DevTools 的 CPU 降频只慢 JS 主线程，而 blur 的代价在合成器
 * 软件光栅化）。所以「用户说卡」必须靠设备自己回传实时帧时，而不是我们猜。
 *
 * 设计约束：
 *   1) 常开。模块被 import 即起一个全局 rAF 心跳（`global` 源），这样即使所有
 *      视觉引擎都停着，也能看到页面本身的真实帧间隔。
 *   2) 每帧开销可忽略：一次 Map.get + 两三次数值运算 + 一次 Float64Array 写入。
 *      不排序、不分配数组、不读 DOM。分位数只在**查询时**（打开诊断面板）才算。
 *   3) 引擎自己注册：调用方在自己的 rAF 回调里打 `frame('引擎名')`，
 *      两次打点的时间差就是该引擎的实际帧间隔。没有中央调度点，所以不要求引擎
 *      改造循环结构——一行埋点即可。
 *   4) 环形覆盖写入即是有界：每源 RING_CAP 帧（约 3 秒 @60fps），最坏
 *      24 源 × 180 × 8B ≈ 35KB。
 *
 * 时钟：rAF 回调形参与 performance.now() 同源同基准（timeOrigin 相对毫秒），
 * 所以不同源之间可以互相比较；`activeAt` 也用同一基准。
 * ============================================================ */
import { logCatch } from '../services/log.js';

/* 每源保留的帧数上限：约 3 秒 @60fps / 6 秒 @30fps，够算中位数与 p95 */
const RING_CAP = 180;
/* 超过这么多源就不再新建（埋点写错名/动态名时的保险，正常 8~10 个） */
const MAX_SOURCES = 24;
/* 距最近一次打点在 ACTIVE_MS 内 = 该循环「正在跑」 */
const ACTIVE_MS = 1200;
/* 单帧超过 GAP_MS 判定为「循环被挂起」（切后台/停播后重启），不计入帧时，只计 gaps */
const GAP_MS = 2000;
/* 内置心跳源名（诊断页把它和引擎分行显示） */
export const GLOBAL_SOURCE = 'global';

const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

const sources = new Map();
let heartbeatId = 0;
let heartbeatOn = false;

function makeSource(name) {
    return {
        name,
        label: '',
        builtin: false,
        ring: new Float64Array(RING_CAP),
        idx: 0,
        filled: 0,
        frames: 0,
        gaps: 0,
        lastTs: 0,
        activeAt: 0,
    };
}

function ensureSource(name) {
    let s = sources.get(name);
    if (s) return s;
    if (sources.size >= MAX_SOURCES) {
        /* 源数触顶：宁可不记也不再分配内存（说明有埋点用了不稳定的源名） */
        return null;
    }
    s = makeSource(name);
    sources.set(name, s);
    return s;
}

/**
 * 登记一个循环并给它可以显示的中文名（可选，纯为诊断页排版服务）。
 * @param {string} name  稳定标识，如 'pv' / 'lyricsLoop'
 * @param {string} label 显示名，如 'PV 主循环'
 * @param {boolean} [builtin] 是否内置源（内置心跳不计入「引擎数」）
 */
export function registerLoop(name, label, builtin = false) {
    const s = ensureSource(name);
    if (!s) return null;
    if (label) s.label = label;
    s.builtin = !!builtin;
    return s;
}

/**
 * 打点：在引擎自己的 rAF 回调里调用一次。
 * @param {string} name 引擎名（未登记过会自动建源）
 * @param {number} [ts] 直接透传 rAF 形参可省一次 performance.now()；缺省自取
 */
export function frame(name, ts) {
    if (!name) return;
    const s = ensureSource(name);
    if (!s) return;
    const t = (typeof ts === 'number' && ts > 0) ? ts : nowMs();
    s.frames++;
    s.activeAt = t;
    const prev = s.lastTs;
    s.lastTs = t;
    if (!prev) return;
    const d = t - prev;
    if (!(d > 0)) return;
    if (d > GAP_MS) { s.gaps++; return; }
    s.ring[s.idx] = d;
    s.idx = (s.idx + 1) % RING_CAP;
    if (s.filled < RING_CAP) s.filled++;
}

function percentile(sorted, p) {
    const n = sorted.length;
    if (!n) return 0;
    const i = Math.min(n - 1, Math.max(0, Math.ceil(n * p) - 1));
    return sorted[i];
}

/** 单源统计（查询时才排序，热路径不做任何分配） */
function statsOf(s) {
    const n = s.filled;
    const vals = new Array(n);
    for (let i = 0; i < n; i++) vals[i] = s.ring[i];
    vals.sort((a, b) => a - b);
    const medianMs = percentile(vals, 0.5);
    return {
        name: s.name,
        label: s.label || s.name,
        builtin: s.builtin,
        samples: n,
        frames: s.frames,
        gaps: s.gaps,
        medianMs,
        p95Ms: percentile(vals, 0.95),
        maxMs: n ? vals[n - 1] : 0,
        minMs: n ? vals[0] : 0,
        fps: medianMs > 0 ? 1000 / medianMs : 0,
        running: (nowMs() - s.activeAt) <= ACTIVE_MS,
        sinceLastMs: s.activeAt ? Math.max(0, nowMs() - s.activeAt) : -1,
    };
}

/** @param {string} name @returns {ReturnType<typeof statsOf>|null} */
export function getStats(name) {
    const s = sources.get(name);
    return s ? statsOf(s) : null;
}

/**
 * 全部源的统计。内置心跳排最前（它是「页面帧率」，其余是「引擎帧率」）。
 * @returns {Object[]}
 */
export function allStats() {
    const out = [];
    for (const s of sources.values()) out.push(statsOf(s));
    out.sort((a, b) => (b.builtin - a.builtin) || a.label.localeCompare(b.label));
    return out;
}

/**
 * 当前有几个 rAF 循环在跑。
 * @param {{includeBuiltin?:boolean}} [opts]
 * @returns {{total:number, engines:number, running:string[], idle:string[]}}
 */
export function running(opts = {}) {
    const includeBuiltin = opts.includeBuiltin !== false;
    const run = [];
    const idle = [];
    let engines = 0;
    for (const [name, s] of sources) {
        if (!includeBuiltin && s.builtin) continue;
        if (s.builtin && includeBuiltin) { run.push(name); continue; }
        if ((nowMs() - s.activeAt) <= ACTIVE_MS) { run.push(name); engines++; }
        else idle.push(name);
    }
    return { total: run.length, engines, running: run, idle };
}

/** 采样器自身状态（诊断页用来解释「中位数是最近 RING_CAP 帧」） */
export function probeInfo() {
    return { ringCap: RING_CAP, activeMs: ACTIVE_MS, gapMs: GAP_MS, maxSources: MAX_SOURCES, registered: sources.size, heartbeatOn };
}

/** 清掉某个源（或全部）的样本：档位刚改完、想从零开始看时使用 */
export function reset(name) {
    const list = name ? [sources.get(name)] : Array.from(sources.values());
    for (const s of list) {
        if (!s) continue;
        s.ring = new Float64Array(RING_CAP);
        s.idx = 0;
        s.filled = 0;
        s.frames = 0;
        s.gaps = 0;
        s.lastTs = 0;
    }
}

function heartbeat(ts) {
    /* 先续期再打点：单次打点抛错不会把常驻心跳弄死 */
    heartbeatId = requestAnimationFrame(heartbeat);
    try {
        frame(GLOBAL_SOURCE, ts);
    } catch (e) {
        logCatch('frameProbe', e);
    }
}

/** 启动内置心跳（幂等）。模块底部自动调用，保留导出便于测试与手动重启。 */
export function startHeartbeat() {
    if (heartbeatOn) return false;
    if (typeof requestAnimationFrame !== 'function') return false;
    heartbeatOn = true;
    heartbeatId = requestAnimationFrame(heartbeat);
    return true;
}

/** 停止内置心跳（只停内置源，引擎打点不受影响） */
export function stopHeartbeat() {
    if (!heartbeatOn) return false;
    heartbeatOn = false;
    if (heartbeatId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(heartbeatId);
    heartbeatId = 0;
    return true;
}

registerLoop(GLOBAL_SOURCE, '页面全局帧时（内置心跳）', true);
startHeartbeat();
