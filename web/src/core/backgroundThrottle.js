/* ============================================================
 * core/backgroundThrottle.js — 窗口不可见时自动轻量（todos #18）
 *
 * 定位：**外部观察者**。本模块不认识任何具体引擎，只维护一张由分片注册的
 * 「节流目标表」，在判定不可见时调用各目标自己的 pause/resume。
 * 这样做的理由：共享 rAF 闸是下一轮侵入式重构的对象，这一轮绝不去改那 4 个
 * 引擎文件（另有人在做，会撞车）。
 *
 * 桌面壳里的真相：浏览器只对「后台标签页」节流 rAF，而 Tauri 窗口被别的窗口
 * 遮挡 / 最小化 ≠ document.hidden，主窗口的绘制循环仍在满帧跑 —— 所以这是真需求。
 * 也正因为两种不可见代价不同，这里分两档：
 *   TIER_IDLE   失焦但画面仍可能可见（多屏场景）→ 只停「纯装饰」循环
 *               （PV 丝绸背景 canvas 是其中唯一存在的一个，也恰好是最贵的）
 *   TIER_HIDDEN 页面隐藏 / 最小化 → 连主歌词 rAF、各引擎自持循环一起停
 * 焦点判定刻意带宽限期（默认 1200ms）：Alt+Tab 途中、点一下任务栏又切回来时
 * 不该看到画面闪一下。
 *
 * 三条不侵犯用户设置的硬规则（本模块的全部风险都集中在这）：
 *   ① 只暂停「判定当时确实在跑」的目标（isBusy 为真），绝不替用户启动任何东西；
 *   ② pause() 之后复查 isBusy，仍为真说明这个目标压根没有可外部调用的停接口
 *      —— 不记账，于是恢复时也不会去 resume 一个我们其实没停下的东西；
 *   ③ 恢复时若实例已被换成新的（切了视觉模式 / 引擎重建）或已被别人重新跑起来，
 *      一律跳过，把状态交还给新实例自己管。
 * 所以「暂停了动画」不可能变成「关了动画」，也不可能反过来凭空多出动画。
 *
 * 不可见期间还会自动重启循环（切歌会让 20-lyrics-render 重新 start 引擎），
 * 所以节流期跑一个低频复核（默认 3s）——比挂进各分片的启动路径便宜得多，
 * 也保证了「恢复清单」始终等于「我们真正停掉的那一份」。
 * ============================================================ */
import { logCatch, logInfo } from '../services/log.js';

export const TIER_NONE = '';
export const TIER_IDLE = 'idle';
export const TIER_HIDDEN = 'hidden';

export const BG_THROTTLE_DEFAULTS = { enabled: true, blurGraceMs: 1200, reassertMs: 3000 };

/** 目标表：{id, tier, get, isBusy, pause, resume, skipWhen?} */
const _targets = [];
/** 我们真正停下来的目标：id -> 当时那个实例 */
const _paused = new Map();
const _listeners = new Set();

let _env = null;
let _installed = false;
let _tier = TIER_NONE;
let _occluded = false;
let _blurTimer = null;
let _reassertTimer = null;

function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

/** 偏好读 appSettings.playback.bgThrottle（缺省即用默认值，无需改 config/defaults.js） */
export function bgThrottlePrefs() {
    const p = Object.assign({}, BG_THROTTLE_DEFAULTS);
    try {
        const s = (typeof globalThis !== 'undefined' && globalThis.appSettings) || null;
        const cfg = s && s.playback && s.playback.bgThrottle;
        if (cfg && typeof cfg === 'object') {
            if (typeof cfg.enabled === 'boolean') p.enabled = cfg.enabled;
            const g = num(cfg.blurGraceMs, -1);
            if (g >= 0) p.blurGraceMs = Math.min(g, 60000);
            const r = num(cfg.reassertMs, -1);
            if (r >= 500) p.reassertMs = Math.min(r, 60000);
        }
    } catch (e) {
        logCatch('backgroundThrottle', e);
    }
    return p;
}

function call(fn, arg) {
    if (typeof fn !== 'function') return undefined;
    return fn(arg);
}

function safeBusy(t, inst) {
    try { return !!call(t.isBusy, inst); } catch (e) { logCatch('backgroundThrottle', e); return false; }
}

function safeSkip(t) {
    try { return !!call(t.skipWhen); } catch (e) { logCatch('backgroundThrottle', e); return false; }
}

function resolveInstance(t) {
    try { return t.get() || null; } catch (e) { logCatch('backgroundThrottle', e); return null; }
}

/**
 * 注册一个节流目标（同名覆盖，便于热重载/测试）。
 * @param {{id:string, tier:string, get:()=>any, isBusy:(inst:any)=>boolean,
 *          pause:(inst:any)=>void, resume:(inst:any)=>void, skipWhen?:()=>boolean}} target
 */
export function registerThrottleTarget(target) {
    if (!target || !target.id || typeof target.get !== 'function') return false;
    if (target.tier !== TIER_IDLE && target.tier !== TIER_HIDDEN) return false;
    const i = _targets.findIndex(t => t.id === target.id);
    if (i >= 0) {
        /* 换目标实现时旧账先作废：新目标的实例语义可能完全不同，不能拿旧账去 resume */
        _paused.delete(target.id);
        _targets[i] = target;
    } else {
        _targets.push(target);
    }
    return true;
}

export function unregisterThrottleTarget(id) {
    const i = _targets.findIndex(t => t.id === id);
    if (i < 0) return false;
    _targets.splice(i, 1);
    _paused.delete(id);
    return true;
}

export function isBackgroundThrottled() {
    return _tier !== TIER_NONE;
}

export function backgroundThrottleTier() {
    return _tier;
}

export function backgroundThrottleSnapshot() {
    let hidden = false;
    let focused = true;
    try {
        const doc = _env && _env.document;
        hidden = !!(doc && doc.hidden === true);
        focused = !(doc && typeof doc.hasFocus === 'function' && doc.hasFocus() === false);
    } catch (e) { logCatch('backgroundThrottle', e); }
    return {
        tier: _tier,
        hidden,
        focused,
        occluded: _occluded,
        paused: Array.from(_paused.keys()),
        targets: _targets.map(t => t.id),
    };
}

function emit(reason) {
    const snap = Object.assign({ reason: reason || '' }, backgroundThrottleSnapshot());
    _listeners.forEach(fn => {
        try { fn(snap); } catch (e) { logCatch('backgroundThrottle', e); }
    });
}

/**
 * 订阅节流档位/停启清单变化（诊断页与「画面为什么不动了」的反馈都靠它）。
 * @param {(snap:{tier:string,paused:string[],hidden:boolean,focused:boolean})=>void} listener
 * @returns {() => void} 取消订阅
 */
export function onBackgroundThrottleChange(listener) {
    if (typeof listener !== 'function') return () => {};
    _listeners.add(listener);
    return () => { _listeners.delete(listener); };
}

function computeTier() {
    if (!bgThrottlePrefs().enabled) return TIER_NONE;
    const doc = _env && _env.document;
    if (!doc) return TIER_NONE;
    if (doc.hidden === true) return TIER_HIDDEN;
    /* hasFocus 是现值：blur 事件丢得掉，现值丢不掉。宽限期只决定「何时开始降」 */
    if (_occluded && typeof doc.hasFocus === 'function' && doc.hasFocus() === false) return TIER_IDLE;
    return TIER_NONE;
}

/**
 * 单遍协调器：幂等，任何时候调用都把现实拉回目标档位。
 * @param {string} [reason] 广播里带的触发原因（调试用）
 * @param {string} [forceTier] 覆盖探测结果（卸载时用它把循环全部交还原主）
 */
export function syncBackgroundThrottle(reason, forceTier) {
    const want = forceTier === undefined ? computeTier() : forceTier;
    const before = _tier;
    let changed = false;

    for (const t of _targets) {
        const shouldPause = want !== TIER_NONE
            && (t.tier === want || (t.tier === TIER_IDLE && want === TIER_HIDDEN))
            && !safeSkip(t);
        const recorded = _paused.get(t.id) || null;

        if (shouldPause) {
            const inst = resolveInstance(t);
            /* 没在跑就不用碰：可能是我们上次停掉的，也可能是用户本来没开这个动画
               （规则①：本模块永远不替用户启动任何东西） */
            if (!safeBusy(t, inst)) continue;
            try { call(t.pause, inst); } catch (e) { logCatch('backgroundThrottle', e); continue; }
            if (safeBusy(t, inst)) continue;                     /* 规则②：停不住就不记账 */
            if (!recorded) changed = true;
            _paused.set(t.id, { inst });
        } else if (recorded) {
            _paused.delete(t.id);
            changed = true;
            const live = resolveInstance(t);
            if (!live && recorded.inst) continue;                            /* 实例已被销毁：没东西要恢复 */
            if (recorded.inst && live && recorded.inst !== live) continue;   /* 规则③：引擎已换新实例，交还自管 */
            if (safeBusy(t, live)) continue;                                 /* 规则③：期间被别人重启过，别再 start */
            try { call(t.resume, live); } catch (e) { logCatch('backgroundThrottle', e); }
        }
    }

    _tier = want;
    markRoot(_tier);
    if (_tier === TIER_NONE) stopReassert();
    else startReassert();
    if (changed || before !== want) emit(reason);
    return _tier;
}

function markRoot(tier) {
    try {
        const doc = _env && _env.document;
        const root = doc && doc.documentElement;
        if (!root || !root.classList) return;
        root.classList.toggle('is-bg-throttled', !!tier);
        if (typeof root.setAttribute === 'function') {
            if (tier) root.setAttribute('data-bg-throttle', tier);
            else root.removeAttribute('data-bg-throttle');
        }
    } catch (e) {
        logCatch('backgroundThrottle', e);
    }
}

function startReassert() {
    if (_reassertTimer || typeof setInterval !== 'function') return;
    _reassertTimer = setInterval(() => { syncBackgroundThrottle('reassert'); }, bgThrottlePrefs().reassertMs);
}

function stopReassert() {
    if (_reassertTimer && typeof clearInterval === 'function') clearInterval(_reassertTimer);
    _reassertTimer = null;
}

function clearBlurTimer() {
    if (_blurTimer && typeof clearTimeout === 'function') clearTimeout(_blurTimer);
    _blurTimer = null;
}

/* ---------------- 信号源：visibilitychange + window blur/focus + hasFocus 现值 ---------------- */

function onVisibility() {
    const doc = _env && _env.document;
    if (doc && doc.hidden === true) clearBlurTimer();
    syncBackgroundThrottle('visibilitychange');
}

function onBlur() {
    if (_occluded) return;
    const p = bgThrottlePrefs();
    if (typeof setTimeout !== 'function') { _occluded = true; syncBackgroundThrottle('blur'); return; }
    clearBlurTimer();
    _blurTimer = setTimeout(() => {
        _blurTimer = null;
        const doc = _env && _env.document;
        /* 宽限期到了仍拿不到焦点才算真被遮挡（切回来的场景这里直接放弃降档） */
        if (doc && typeof doc.hasFocus === 'function' && doc.hasFocus() === true) return;
        _occluded = true;
        syncBackgroundThrottle('blur');
    }, p.blurGraceMs);
}

function onFocus() {
    clearBlurTimer();
    _occluded = false;
    syncBackgroundThrottle('focus');
}

function onPageHide() {
    /* bfcache/退出：立刻恢复，别把「我们停掉的循环」留在页面上等着被忘掉 */
    _occluded = false;
    syncBackgroundThrottle('pagehide');
}

function bind(target, type, fn) {
    if (!target || typeof target.addEventListener !== 'function') return () => {};
    target.addEventListener(type, fn);
    return () => {
        if (typeof target.removeEventListener === 'function') target.removeEventListener(type, fn);
    };
}

function defaultEnv() {
    return {
        window: (typeof globalThis !== 'undefined' && globalThis.window) || null,
        document: (typeof globalThis !== 'undefined' && globalThis.document) || null,
    };
}

/**
 * 装配一次（重复调用只更新注入依赖）。
 * @param {{env?:{window:any,document:any}, silent?:boolean}} [deps]
 * @returns {() => void} 卸载
 */
export function installBackgroundThrottle(deps = {}) {
    _env = deps.env || _env || defaultEnv();
    if (_installed) return () => {};
    _installed = true;

    const unbinds = [
        bind(_env.document, 'visibilitychange', onVisibility),
        bind(_env.window, 'blur', onBlur),
        bind(_env.window, 'focus', onFocus),
        bind(_env.window, 'pagehide', onPageHide),
    ];
    syncBackgroundThrottle('install');
    if (!deps.silent) {
        logInfo('backgroundThrottle', '已装配节流目标：', _targets.map(t => t.id).join(', '));
    }
    return () => {
        _installed = false;
        clearBlurTimer();
        stopReassert();
        _occluded = false;
        unbinds.forEach(fn => { try { fn(); } catch (e) { logCatch('backgroundThrottle', e); } });
        /* 卸载必须把停下过的循环交还原主，不能给下一次装配留脏账 */
        syncBackgroundThrottle('uninstall', TIER_NONE);
    };
}
