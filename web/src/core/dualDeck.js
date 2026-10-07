/* ============================================================
 * core/dualDeck.js — 双 deck 音频元素管理（Automix Phase 1 骨架）
 *
 * 背景（Automix-技术方案.md §2 方案 Z）：全库 30 个分片 import
 * 20-lyrics-render 的 `audio` 绑定（原 const，现 export let）。
 * 真重叠交叉需要第二个音频元素，交叉结束后做「角色顶替」——
 * 本模块持有两个 deck 并负责：常驻监听器的成对搬运、角色互换时
 * 的回调通知（由 20-lyrics-render 重指 audio 绑定 / globalThis.audio /
 * dom.audio）。
 *
 * Phase 1 行为零变化承诺：deckB（影子）永不播放、swapRoles 无调用者，
 * 全库仍然只有 deckA 出声。Phase 2（crossfader）才开始调 swapRoles。
 *
 * ★ 原生输出线（Phase 2b）追加的 replaceActiveDeck：把活跃 deck 整个换成
 *   外部对象（nativeDeck 的鸭子类型替身），或换回 HTML 元素。与 swapRoles
 *   共用同一条监听搬运路径，理由见该函数注释。
 *
 * 层级纪律：本模块在 core 层，**不 import 任何 app/ 分片**（与
 * fadeController 同规矩）；对 app 层的反向通知走 onRoleSwap 回调。
 *
 * 监听器语义（重要）：registerAudioListener 只收**常驻**监听
 * （play/pause/ended/timeupdate 等一辈子挂在活跃元素上的）。
 * 一次性探针（canplay/loadeddata 挂上即拆的）必须继续用
 * audio.addEventListener 原样——live binding 保证 swap 后新探针
 * 挂到新 deck，在途旧探针随旧 deck 死亡，语义天然正确。
 * ============================================================ */
import { logInfo, logCatch } from '../services/log.js';

let deckA = null;   /* 活跃 deck = 全库语义上的「当前播放元素」 */
let deckB = null;   /* 影子 deck：Phase 2 预载/交叉用 */

const swapCallbacks = [];
const listenerTable = [];   /* { type, fn, options }——swap 时成对搬运 */

/**
 * 初始化双 deck。影子元素由本模块创建（type=audio 的空元素，
 * preload=none 不产生任何网络/解码活动），不挂到 DOM 也可正常工作，
 * 但为了与 #audioPlayer 同等待遇（如聚焦/媒体键探测）挂到 body 末尾。
 * @param {HTMLAudioElement} primary 现役 #audioPlayer
 */
export function initDualDeck(primary) {
    if (!primary) return;
    if (deckA) return;  /* 幂等：重复 init 不重置 */
    deckA = primary;
    if (typeof document !== 'undefined') {
        deckB = document.createElement('audio');
        deckB.id = 'audioShadow';
        deckB.preload = 'none';
        deckB.setAttribute('aria-hidden', 'true');
        /* ★ 影子元素不 display:none——部分内核会据此跳过加载；移出视口外即可 */
        deckB.style.position = 'fixed';
        deckB.style.left = '-9999px';
        deckB.style.width = '0';
        deckB.style.height = '0';
        document.body.appendChild(deckB);
    }
    /* 补挂 init 之前已登记的监听（防御：若调用顺序变化也不丢） */
    _attachListeners(deckA);
    logInfo('dualDeck', '双 deck 已初始化（影子 deck 待命，Phase 2 起参与交叉）');
}

/** 当前活跃元素。所有 core 注入点应改经此取，而不是缓存元素引用。 */
export function getActiveAudio() {
    return deckA;
}

/** 影子元素（Phase 2 crossfader 预载/起播用；Phase 1 无调用者）。 */
export function getShadowAudio() {
    return deckB;
}

/**
 * 注册**常驻**监听：登记进搬运表并挂到当前活跃元素。
 * swap 后自动迁移到新活跃元素，调用方无感知。
 * 一次性探针勿用此 API（见文件头）。
 */
export function registerAudioListener(type, fn, options) {
    listenerTable.push({ type, fn, options });
    if (deckA) deckA.addEventListener(type, fn, options);
}

/**
 * 卸载常驻监听：搬运表同步移除并从当前活跃元素摘除。
 * 供 installTempoBoost 等带卸载语义的模块使用；找不到时静默（幂等）。
 */
export function unregisterAudioListener(type, fn) {
    const i = listenerTable.findIndex(l => l.type === type && l.fn === fn);
    if (i >= 0) listenerTable.splice(i, 1);
    if (deckA) deckA.removeEventListener(type, fn);
}

/**
 * 角色互换回调：swapRoles 时逐个通知（20-lyrics-render 在此重指
 * `audio` live binding / globalThis.audio / dom.audio）。
 * @param {(newActive: HTMLAudioElement) => void} fn
 */
export function onRoleSwap(fn) {
    swapCallbacks.push(fn);
}

/**
 * 角色互换（Phase 2 由 crossfader 在 SWAPPED 阶段调用）：
 * ① A/B 互换身份；② 常驻监听成对搬运（从换出方摘除、挂到新活跃方）；
 * ③ 通知所有 onRoleSwap 回调。回调异常 logCatch 吞掉——单个回调失败
 * 不允许拖垮顶替流程。
 */
export function swapRoles() {
    if (!deckA || !deckB) return;
    const prev = deckA;
    deckA = deckB;
    deckB = prev;
    _moveListeners(prev, deckA);
    _notifyRoleSwap();
    logInfo('dualDeck', '角色已互换，常驻监听已搬运');
}

/**
 * 用外部元素**顶替**活跃 deck（不涉及影子 deck 身份）。
 *
 * 用途：原生输出线把活跃 deck 换成 nativeDeck（core/nativeDeck.js 的鸭子类型替身），
 * 或从原生切回 HTML 元素。走的是与 swapRoles 完全同一条搬运路径——常驻监听
 * 从旧元素摘除、挂到新元素，然后通知 onRoleSwap（20-lyrics-render 在那重指
 * `audio` live binding / globalThis.audio / dom.audio）。
 *
 * ★ 为什么不能只在 20-lyrics-render 里改 `audio` 绑定：绑定一动，30 个分片的
 *   运行时读法就都指向新 deck 了，但**常驻监听仍挂在旧元素上**——播放按钮、
 *   进度、切歌全部失效，且是「看起来没坏、只是没反应」这种最难查的形态。
 *
 * 幂等：next 与当前活跃同引用时直接返回（重复调用不产生额外搬运）。
 * @param {object} next 实现 addEventListener/removeEventListener 的「播放元素」
 */
export function replaceActiveDeck(next) {
    if (!next || next === deckA) return;
    const prev = deckA;
    deckA = next;
    if (prev) {
        _moveListeners(prev, deckA);
    } else {
        /* 未 init 就被顶替（装配序变化/测试）：搬运表本来就一条都没挂出去，
           这里补挂，否则「监听全丢」会表现成整条播放链路静默失效。 */
        _attachListeners(deckA);
    }
    _notifyRoleSwap();
    logInfo('dualDeck', '活跃 deck 已被顶替，常驻监听已搬运');
}

/** 把搬运表里的常驻监听全挂到某个 deck 上 */
function _attachListeners(to) {
    if (!to) return;
    for (const { type, fn, options } of listenerTable) {
        to.addEventListener(type, fn, options);
    }
}

/** 常驻监听成对搬运（swapRoles / replaceActiveDeck 的唯一实现，别抄第二份） */
function _moveListeners(from, to) {
    if (!from || !to) return;
    for (const { type, fn, options } of listenerTable) {
        try { from.removeEventListener(type, fn, options); } catch (e) { logCatch('dualDeck', e); }
        to.addEventListener(type, fn, options);
    }
}

function _notifyRoleSwap() {
    for (const cb of swapCallbacks) {
        try { cb(deckA); } catch (e) { logCatch('dualDeck', e); }
    }
}

/** 测试钩子：清空全部状态（生产代码勿调） */
export function _resetDualDeckForTest() {
    if (deckB && typeof deckB.remove === 'function') deckB.remove();
    deckA = null;
    deckB = null;
    swapCallbacks.length = 0;
    listenerTable.length = 0;
}
