/* ============================================================
 * core/tempoBoost.js — 长按临时加速（todos #13）
 *
 * 一句话：按住「加速键」（或长按播放按钮）把倍速临时抬一档，松手 / 失焦 /
 * 切歌 / 暂停任一路径都必须回到原来的倍速。难点全在「恢复」，所以本模块把
 * 所有会丢事件的路径收在一个状态机里，DOM 与倍速读写全部由调用方注入
 * （与 shortcutManager / stallDetector 同一分层约定：core 不 import app/*）。
 *
 * 与用户手动倍速的叠加规则（乘法叠加，非跳到定值）：
 *   boosted = min(maxRate, base × factor)，base 取按下瞬间的 currentPlaybackRate。
 *   · 用户 1× → 2×；1.5× → 3×；2× → 4×（被 maxRate 截住，等于再快一倍但封顶）；
 *   · boosted 与 base 视为相等（<1e-3）时整个 engage 直接不生效——已经到顶，
 *     不做无意义的写倍速 + 弹提示；
 *   · 释放时若 currentPlaybackRate 已不等于我们写进去的值，说明加速期间用户从
 *     右键菜单/设置里另选了倍速，此时把用户的值当新基准、绝不覆盖。
 *
 * 为什么走 applyPlaybackRate（由分片注入）而不是直接 audio.playbackRate：
 *   那个唯一 setter 会同步 currentPlaybackRate，保证「音频元素倍速 == 全局档位」
 *   这条不变量；95-track-loading / 135-crossfade 切歌时都是按 currentPlaybackRate
 *   重写的，绕过它就会出现「加速中切歌、新歌悄悄还是 2×」这类幽灵状态。
 *   代价是加速期间右键菜单的倍速子菜单会高亮在 boosted 档——这正好也是可见反馈。
 *
 * 恢复路径（缺一不可，全部在 installTempoBoost 里挂）：
 *   keyup · contextmenu（按住键点右键时系统根本不发 keyup）
 *   · window blur · document visibilitychange:hidden
 *   · pagehide · audio pause/emptied/loadstart/loadedmetadata（切歌）
 *   · 500ms 看门狗（只在加速期间存活）：用 document.hidden / hasFocus() 现值兜底
 *     ——blur 与 visibilitychange 在 Tauri 被遮挡/最小化时不保证成对触发；
 *     再加一条 maxHoldMs 硬顶（默认 2 分钟）兜住「什么事件都没漏、就是没松手」的极端。
 * ============================================================ */
import { logCatch } from '../services/log.js';

/** 看门狗周期：加速期间的失焦/隐藏兜底 */
const WATCHDOG_MS = 500;
/** 单次加速的最长时长：keyup 被系统整批吞掉（弹右键菜单、输入法切换）时最后一道闸 */
const MAX_HOLD_MS = 120000;
const RATE_EPS = 1e-3;

export const TEMPO_BOOST_DEFAULTS = { enabled: true, key: 'x', factor: 2, maxRate: 4, maxHoldMs: MAX_HOLD_MS };
/** 长按播放按钮判定为「加速」而非「点击播放/暂停」的阈值 */
export const TEMPO_BOOST_HOLD_MS = 400;

let _setRate = null;
let _readRate = null;
let _env = null;
let _installed = false;

const _sources = new Set();
const _listeners = new Set();
let _active = false;
let _baseRate = 1;
let _appliedRate = 0;
let _startedAt = 0;
let _watchdog = null;

function now() {
    return Date.now();
}

function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

/** 偏好读 appSettings.playback.tempoBoost（缺省即用默认值，无需改 config/defaults.js） */
export function tempoBoostPrefs() {
    const p = Object.assign({}, TEMPO_BOOST_DEFAULTS);
    try {
        const s = (typeof globalThis !== 'undefined' && globalThis.appSettings) || null;
        const cfg = s && s.playback && s.playback.tempoBoost;
        if (cfg && typeof cfg === 'object') {
            if (typeof cfg.enabled === 'boolean') p.enabled = cfg.enabled;
            const f = num(cfg.factor, 0);
            if (f > 1) p.factor = Math.min(f, 8);
            const m = num(cfg.maxRate, 0);
            if (m > 1) p.maxRate = Math.min(m, 8);
            const h = num(cfg.maxHoldMs, 0);
            if (h > 0) p.maxHoldMs = Math.min(h, 3600000);
            if (typeof cfg.key === 'string' && cfg.key) p.key = cfg.key;
        }
        /* 设置页若加了 tempoBoost 快捷键行，快捷键表优先（与其它键位同一来源） */
        const sc = s && s.shortcuts;
        if (sc && typeof sc.tempoBoost === 'string' && sc.tempoBoost) p.key = sc.tempoBoost;
    } catch (e) {
        logCatch('tempoBoost', e);
    }
    return p;
}

/** 叠加规则的唯一计算口（测试与 UI 提示共用） */
export function boostedRateFor(baseRate, prefs) {
    const p = prefs || tempoBoostPrefs();
    const base = num(baseRate, 1);
    if (!(base > 0)) return 0;
    return Math.min(num(p.maxRate, 4), base * num(p.factor, 2));
}

function readRate() {
    if (typeof _readRate !== 'function') return 1;
    try {
        const r = num(_readRate(), 1);
        return r > 0 ? r : 1;
    } catch (e) {
        logCatch('tempoBoost', e);
        return 1;
    }
}

function writeRate(rate) {
    if (typeof _setRate !== 'function') return false;
    try {
        _setRate(rate);
        return true;
    } catch (e) {
        logCatch('tempoBoost', e);
        return false;
    }
}

export function isTempoBoosting() {
    return _active;
}

export function tempoBoostInfo() {
    const p = tempoBoostPrefs();
    return {
        active: _active,
        baseRate: _baseRate,
        boostedRate: _appliedRate,
        heldMs: _active ? now() - _startedAt : 0,
        sources: Array.from(_sources),
        key: p.key,
        factor: p.factor,
    };
}

function emit(kind, reason) {
    const snap = Object.assign({ kind, reason: reason || '' }, tempoBoostInfo());
    _listeners.forEach(fn => {
        try { fn(snap); } catch (e) { logCatch('tempoBoost', e); }
    });
}

/**
 * 订阅加速状态变化（只在「进入/退出」两个跳变时广播，多路按压不重复广播）。
 * @param {(snap:{kind:string,active:boolean,baseRate:number,boostedRate:number})=>void} listener
 * @returns {() => void}
 */
export function onTempoBoostChange(listener) {
    if (typeof listener !== 'function') return () => {};
    _listeners.add(listener);
    return () => { _listeners.delete(listener); };
}

function startWatchdog() {
    if (_watchdog || typeof setInterval !== 'function') return;
    _watchdog = setInterval(watchdogTick, WATCHDOG_MS);
}

function stopWatchdog() {
    if (_watchdog && typeof clearInterval === 'function') clearInterval(_watchdog);
    _watchdog = null;
}

function watchdogTick() {
    try {
        if (!_active) { stopWatchdog(); return; }
        /* 最后一道闸：keyup 可能被系统整批吞掉（弹右键菜单、切输入法），
           没有它一旦漏掉就是「歌永远停在 2×」——这个 bug 用户根本找不到原因 */
        if (_startedAt && now() - _startedAt > num(tempoBoostPrefs().maxHoldMs, MAX_HOLD_MS)) {
            forceReleaseTempoBoost('max-hold');
            return;
        }
        const doc = _env && _env.document;
        if (!doc) return;
        if (doc.hidden === true) { forceReleaseTempoBoost('watchdog-hidden'); return; }
        if (typeof doc.hasFocus === 'function' && doc.hasFocus() === false) {
            forceReleaseTempoBoost('watchdog-unfocused');
        }
    } catch (e) {
        /* 看门狗不得因探测异常而停跑：下一次 tick 继续兜底 */
        logCatch('tempoBoost', e);
    }
}

/**
 * 进入加速。
 * @param {string} source 按压来源（'key' / 'press' …）；多来源叠加时最后一路松开才恢复
 * @returns {boolean} 是否真的改变了倍速
 */
export function engageTempoBoost(source) {
    const src = source || 'key';
    if (_sources.has(src) && _active) return true;
    const p = tempoBoostPrefs();
    if (!p.enabled) return false;
    const base = readRate();
    const boosted = boostedRateFor(base, p);
    if (!(boosted > 0) || Math.abs(boosted - base) < RATE_EPS) return false;
    if (_sources.size === 0) _baseRate = base;
    _sources.add(src);
    if (_active) return true;
    if (!writeRate(boosted)) {
        _sources.delete(src);
        return false;
    }
    _active = true;
    _appliedRate = boosted;
    _startedAt = now();
    startWatchdog();
    emit('engage', src);
    return true;
}

/** 退出加速并写回基准倍速（内部使用；对外走 release/forceRelease） */
function stopBoost(reason) {
    _sources.clear();
    stopWatchdog();
    if (!_active) return false;
    _active = false;
    const applied = _appliedRate;
    const current = readRate();
    /* 加速期间被第三方改过倍速：以用户的最新值为基准，绝不覆盖 */
    if (Math.abs(current - applied) > RATE_EPS) _baseRate = current;
    else writeRate(_baseRate);
    _appliedRate = 0;
    emit('release', reason);
    return true;
}

/**
 * 单路松开：还有别的按压源在按着就维持加速。
 * @param {string} source
 * @returns {boolean} 本次是否真的恢复了原速
 */
export function releaseTempoBoost(source) {
    const src = source || 'key';
    _sources.delete(src);
    if (!_active) return false;
    if (_sources.size > 0) return false;
    return stopBoost(src);
}

/**
 * 强制结束：失焦/隐藏/切歌/暂停等「用户已经不在这段加速上」的场景，
 * 不管还有几路按着都立即恢复（松手后不会自动续上，需重新按）。
 * @param {string} reason
 * @returns {boolean} 本次是否真的改变了倍速
 */
export function forceReleaseTempoBoost(reason) {
    if (!_active) { _sources.clear(); return false; }
    return stopBoost(reason || 'force');
}

/* ---------------- 事件适配（env 可注入，方便 Node 侧做失焦路径回归） ---------------- */

function isTypingTarget(target) {
    const tag = target && target.tagName ? String(target.tagName).toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return !!(target && target.isContentEditable);
}

/** 键名比对忽略大小写：CapsLock / 按住 Shift 时 e.key 会变成大写，别因此失灵
   （与 285-bilingual-cycle 的 HOTKEY 比对同一口径） */
function sameKey(a, b) {
    return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function isShortcutRecording() {
    try {
        return !!(typeof globalThis !== 'undefined' && globalThis.recordingShortcut);
    } catch (e) {
        logCatch('tempoBoost', e);
        return false;
    }
}

/** 接管只读显示模式（NPS）下本地播放链路是虚的，不动倍速 */
function isNowPlayingTakeover() {
    try {
        const A = (typeof globalThis !== 'undefined' && globalThis.Aria) || null;
        return !!(A && typeof A.__npActive === 'function' && A.__npActive());
    } catch (e) {
        logCatch('tempoBoost', e);
        return false;
    }
}

function onKeyDown(e) {
    const key = e && e.key;
    /* repeat：一直按着不叠加，倍速稳定在 boost 值（放这儿只挡连发） */
    if (!key || (e.repeat !== undefined && e.repeat)) return;
    const p = tempoBoostPrefs();
    if (!p.enabled || !sameKey(key, p.key)) return;
    if (isTypingTarget(e.target)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.isComposing) return;
    if (isShortcutRecording() || isNowPlayingTakeover()) return;
    engageTempoBoost('key');
}

function onKeyUp(e) {
    if (!_active || !_sources.has('key')) return;
    const key = e && e.key;
    /* 只认加速键自己的抬起：手在键盘上乱按别的键不该打断加速 */
    if (sameKey(key, tempoBoostPrefs().key)) releaseTempoBoost('key');
}

/** Windows 下「按住加速键 + 点右键」只会送来 keydown 与 contextmenu，keyup 整个丢掉。
    菜单弹出来那一刻用户的注意力已经不在「这段加速」上了，直接收手；
    漏掉这条就是「歌永远停在 2×」，而且用户根本说不清是怎么进去的。 */
function onContextMenu() {
    if (_active && _sources.has('key')) releaseTempoBoost('key');
}

function onBlur() {
    forceReleaseTempoBoost('blur');
}

function onVisibility() {
    const doc = _env && _env.document;
    if (doc && doc.hidden === true) forceReleaseTempoBoost('visibilitychange');
}

function onPageHide() {
    forceReleaseTempoBoost('pagehide');
}

function onAudioPause() {
    forceReleaseTempoBoost('pause');
}

/** 切歌：换源会走 load()/loadedmetadata，而 95/175 在切歌同步路径里按 currentPlaybackRate
    重写 playbackRate，事件顺序上这几发都落在后面，所以逐个都挂一次（幂等） */
function onTrackChanged() {
    forceReleaseTempoBoost('trackchange');
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
        audio: null,
    };
}

/**
 * 装配一次（重复调用只更新注入依赖，不会挂两份监听）。
 * @param {{setRate:(r:number)=>void, readRate:()=>number, audio?:any, env?:{window:any,document:any,audio:any}}} deps
 * @returns {() => void} 卸载
 */
export function installTempoBoost(deps = {}) {
    if (typeof deps.setRate === 'function') _setRate = deps.setRate;
    if (typeof deps.readRate === 'function') _readRate = deps.readRate;
    _env = deps.env || _env || defaultEnv();
    if (!_env.audio && deps.audio) _env.audio = deps.audio;
    if (_installed) return () => {};

    const win = _env.window;
    const doc = _env.document;
    const unbinds = [
        bind(win, 'keydown', onKeyDown),
        bind(win, 'keyup', onKeyUp),
        bind(win, 'contextmenu', onContextMenu),
        bind(win, 'blur', onBlur),
        bind(win, 'pagehide', onPageHide),
        bind(doc, 'visibilitychange', onVisibility),
        bind(_env.audio, 'pause', onAudioPause),
        bind(_env.audio, 'emptied', onTrackChanged),
        bind(_env.audio, 'loadstart', onTrackChanged),
        bind(_env.audio, 'loadedmetadata', onTrackChanged),
    ];
    _installed = true;
    return () => {
        _installed = false;
        forceReleaseTempoBoost('uninstall');
        unbinds.forEach(fn => { try { fn(); } catch (e) { logCatch('tempoBoost', e); } });
        stopWatchdog();
        _sources.clear();
    };
}
