/* ============================================================
 * core/osd.js — 音量/进度/倍速屏幕浮层的「事件 → 快照」层（纯逻辑，零 DOM）
 *
 * 分层与 sleepTimer 一致：这里只做合并与驻留计时，281-osd.js 订阅快照去写文字与动画。
 * core 不 import app/*、不读 document，因此在 node 测试里可以直接跑（快捷键回归已依赖这点）。
 * 快照是**数据**不是文案：倍速/时间/百分比的字符串由 UI 侧按当前语言拼，
 * 于是本模块不需要知道 i18n 的存在。
 *
 * 为什么要合并：音量连按 F3 十次，若每次一座浮层就会叠出十层各自淡出，
 * 反而读不出「现在到底多少」。规则——
 *   · 同类事件在驻留窗内再触发：覆盖内容 + revision++，不重播入场动画（entered=false）；
 *   · 换类别（音量 → 进度）：entered=true，UI 重放一次轻量转场；
 *   · 每次触发都重置驻留计时。
 * 进度再叠一层「同向累计」：连按 Ctrl+→ 三次应当显示 +0:15，
 * 用户关心的是「一共跳了多远」而不是最后一次按键；反向一按即重新起算。
 * ============================================================ */
import { logCatch } from '../services/log.js';

/** 浮层驻留时长（不含淡出动画） */
export const OSD_DWELL_MS = 1200;

export const OSD_KIND = { VOLUME: 'volume', SEEK: 'seek', RATE: 'rate' };

/** 倍速刻度条的满量程区间（与 RATE_OPTIONS 的最外档一致：0.5x ~ 2x） */
export const OSD_RATE_MIN = 0.5;
export const OSD_RATE_MAX = 2;

const _listeners = new Set();
let _state = { kind: null, visible: false, revision: 0, entered: false, merged: 0, data: null };
let _hideTimer = null;
let _seekRun = null;

function toNum(v) {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : NaN;
}

function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

/* 接管只读显示模式（232-nowplaying-follow）下 updateVolume 直接 return、audio 也没歌，
   这时候浮字会报出一个根本没生效的数字。与 sleepTimer 同样的探测式读全局，不 import 分片。 */
function takeoverActive() {
    try {
        const A = (typeof globalThis !== 'undefined' && globalThis.Aria) || null;
        return !!(A && typeof A.__npActive === 'function' && A.__npActive());
    } catch (e) { logCatch('osd', e); return false; }
}

function disarmHide() {
    if (_hideTimer !== null && typeof clearTimeout === 'function') clearTimeout(_hideTimer);
    _hideTimer = null;
}

function armHide() {
    disarmHide();
    if (typeof setTimeout !== 'function') return;
    _hideTimer = setTimeout(() => {
        _hideTimer = null;
        hideOsd();
    }, OSD_DWELL_MS);
}

function snapshot() {
    return {
        kind: _state.kind,
        visible: _state.visible,
        revision: _state.revision,
        entered: _state.entered,
        merged: _state.merged,
        data: _state.data,
    };
}

function emit() {
    const snap = snapshot();
    _listeners.forEach((fn) => {
        try { fn(snap); } catch (e) { logCatch('osd', e); }
    });
}

/**
 * 呈现一次内容。合并语义的唯一落点：
 * 新类别/从隐藏态起来 → entered=true（UI 播一次入场），同类刷新只 bump revision。
 */
function present(kind, data) {
    const isFresh = !_state.visible || _state.kind !== kind;
    _state = {
        kind,
        visible: true,
        revision: _state.revision + 1,
        entered: isFresh,
        merged: isFresh ? 1 : _state.merged + 1,
        data,
    };
    armHide();
    emit();
}

/**
 * 音量浮层。
 * @param {number} percent 0~100 手柄位（与全局 volume 同一单位，不是声压增益）
 * @returns {boolean} true = 已呈现；false = 参数不可用或处于接管只读模式（调用方无需分叉）
 */
export function showVolume(percent) {
    const p = toNum(percent);
    if (Number.isNaN(p) || takeoverActive()) return false;
    const clamped = clamp(p, 0, 100);
    present(OSD_KIND.VOLUME, { percent: Math.round(clamped), ratio: clamped / 100 });
    return true;
}

/**
 * 进度跳转浮层：同向连按会累计成一次「+0:15」。
 * @param {number} deltaMs 本次跳转量（正=前进，负=后退）
 * @param {number} currentTimeSec 跳转**之后**的播放位置（秒）
 * @param {number} [durationSec] 总时长（秒）；无效时副行只显位置、刻度条留空
 * @returns {boolean}
 */
export function showSeek(deltaMs, currentTimeSec, durationSec) {
    const d = toNum(deltaMs);
    if (Number.isNaN(d) || d === 0 || takeoverActive()) return false;
    const dir = d > 0 ? 1 : -1;
    const dur = toNum(durationSec === undefined ? NaN : durationSec);
    const hasDur = !Number.isNaN(dur) && dur > 0;
    const pos = toNum(currentTimeSec);
    const target = Number.isNaN(pos) ? 0 : (hasDur ? clamp(pos, 0, dur) : Math.max(0, pos));

    const sameRun = _seekRun && _seekRun.dir === dir
        && _state.visible && _state.kind === OSD_KIND.SEEK;
    if (sameRun) _seekRun.deltaSec += d / 1000;
    else _seekRun = { dir, deltaSec: d / 1000 };
    if (hasDur) _seekRun.deltaSec = clamp(_seekRun.deltaSec, -dur, dur);

    present(OSD_KIND.SEEK, {
        deltaSec: _seekRun.deltaSec,
        targetSec: target,
        durationSec: hasDur ? dur : 0,
        hasDuration: hasDur,
        ratio: hasDur ? clamp(target / dur, 0, 1) : 0,
    });
    return true;
}

/**
 * 倍速浮层（目前无键盘档位快捷键，接线见交付报告）。
 * @param {number} rate 播放倍速
 * @returns {boolean}
 */
export function showRate(rate) {
    const r = toNum(rate);
    if (Number.isNaN(r) || r <= 0 || takeoverActive()) return false;
    const span = OSD_RATE_MAX - OSD_RATE_MIN;
    present(OSD_KIND.RATE, { rate: r, ratio: clamp((r - OSD_RATE_MIN) / span, 0, 1) });
    return true;
}

/**
 * 立即收起（如切歌/接管态变化时不想等驻留计时）。
 * revision 不变：UI 只需淡出，不必重排文本。
 * @returns {boolean} 此前是否正在显示
 */
export function hideOsd() {
    disarmHide();
    _seekRun = null;
    if (!_state.visible) return false;
    _state = Object.assign({}, _state, { visible: false, entered: false });
    emit();
    return true;
}

/** 当前快照（浅拷贝，改不动内部状态） */
export function getOsdState() {
    return snapshot();
}

/**
 * 订阅快照变化。**不会**在订阅时回放当前值——UI 起来时自行 getOsdState()。
 * @param {(snap:{kind:string|null,visible:boolean,revision:number,entered:boolean,merged:number,data:Object|null})=>void} listener
 * @returns {() => void} 取消订阅
 */
export function onOsdChange(listener) {
    if (typeof listener !== 'function') return () => {};
    _listeners.add(listener);
    return () => { _listeners.delete(listener); };
}
