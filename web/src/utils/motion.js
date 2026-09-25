/* ============================================================
 * utils/motion.js — 退场运行时（补 CSS 做不到的那一件事）
 *
 * CSS 那半边在 styles/motion.css：静态浮层的进/退用 opacity + 
 * `visibility 0s linear <退场时长>` 就够了，而且 transition 天然从当前值
 * 插值，中途打断不需要额外处理。进场也交给 CSS（.visible / .active 上的
 * @keyframes），所以这里刻意**不**提供 reveal()——两边都驱动同一组属性会打架。
 *
 * 只剩 CSS 办不到的：display 是离散属性，一写 none 元素就没了，所以
 * 「先演完退场、再真正卸载/隐藏」必须由 JS 等动画结束。
 *
 * 时长/幅度从 CSS 自定义属性读，不抄第二份数字，避免 CSS 和 JS 各调一半。
 * 退场动画本身也交给 CSS（.is-concealing + @keyframes ariaConcealOut），JS 只等
 * animationend。不用 element.animate()：窗口切后台时 WAAPI 时间轴会被冻住
 * （playState 仍报 running、currentTime 恒为 0），退场永不结束。
 * 兜底计时器仍然必需——动画被节流或元素从没被渲染过时 animationend 不会来，
 * 回调不落地就会把界面卡在可见态（.chorus-marker 会留在歌词条上）。
 * ============================================================ */

import { logCatch } from '../services/log.js';

/** 退场兜底上限：动画本身最长也就 --d-layer，再等就是出问题了 */
export const FINISH_FALLBACK_MS = 1000;

/** 兜底宽限：动画时长之外再给这么多时间，专治「时间轴被冻住 → 动画永不结束」 */
const FALLBACK_GRACE_MS = 250;

/** conceal 用的 class 与 @keyframes 名，须与 styles/motion.css 保持一致 */
export const CONCEAL_CLASS = 'is-concealing';
export const CONCEAL_ANIM = 'ariaConcealOut';

/** CSS 令牌缓存，只在第一次读时付 getComputedStyle 的代价 */
let tokenCache = null;

/** 解析 CSS 时间值（'160ms' / '0.16s' / ''）；解析不出就用 fallback */
export function parseTimeMs(raw, fallback = 0) {
    if (typeof raw !== 'string') return fallback;
    const t = raw.trim();
    if (!t) return fallback;
    const n = parseFloat(t);
    if (!Number.isFinite(n)) return fallback;
    return t.endsWith('ms') ? n : n * 1000;
}

/** 解析 CSS 长度值；非 px 一律按 0，不值得为动效幅度做单位换算 */
export function parseLen(raw, fallback = 0) {
    if (typeof raw !== 'string') return fallback;
    const t = raw.trim();
    if (!t) return fallback;
    const n = parseFloat(t);
    if (!Number.isFinite(n)) return fallback;
    return t.endsWith('px') ? n : 0;
}

/** 读一组动效令牌；CSS 没加载时退回内置值 */
export function motionTokens(refresh = false) {
    if (tokenCache && !refresh) return tokenCache;
    const s = typeof document !== 'undefined' && document.documentElement
        ? getComputedStyle(document.documentElement)
        : null;
    const get = (n) => (s ? s.getPropertyValue(n) : '');
    tokenCache = {
        dFast: parseTimeMs(get('--d-fast'), 160),
        dLayer: parseTimeMs(get('--d-layer'), 340),
        dyOut: parseLen(get('--dy-out'), 8),
        sOut: parseFloat(get('--s-out')) || 0.992,
    };
    return tokenCache;
}

/** 用户要求减少动效：只保留 0 时长的状态切换，位移归零 */
export function prefersReducedMotion() {
    try {
        return typeof window !== 'undefined'
            && typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {
        logCatch('motion', e);
        return false;
    }
}

/**
 * 演完退场再执行 onHidden（通常是 display:none / remove()）。
 *
 * 同一个元素上连开两次时，前一次的 onHidden 不会执行——否则「快速切走又切回」
 * 会让陈旧回调把刚显示的界面藏掉。
 *
 * @param {Element} el
 * @param {Object}   [opts]
 * @param {number}   [opts.durationMs] 缺省 --d-fast
 * @param {number}   [opts.y]          缺省 --dy-out（退场位移，比进场小）
 * @param {number}   [opts.scale]      缺省 --s-out；纯淡出的元素传 1，别跟着缩
 * @param {Function} [opts.onHidden]   动画结束（或超时兜底）后调用
 * @returns {Promise<boolean>} true = 本次请求未被取代且回调已执行
 */
export function conceal(el, opts = {}) {
    const tk = motionTokens();
    const onHidden = typeof opts.onHidden === 'function' ? opts.onHidden : () => {};

    const prevJob = el ? el.__ariaConceal : null;
    if (prevJob) prevJob.superseded = true;
    const job = { superseded: false, cls: false };
    if (el) el.__ariaConceal = job;

    const reduced = prefersReducedMotion();
    const dur = reduced ? 0 : (opts.durationMs ?? tk.dFast);
    const y = reduced ? 0 : (opts.y ?? tk.dyOut);
    const scale = reduced ? 1 : (opts.scale ?? tk.sOut);

    function onAnimEnd(ev) {
        /* 只认本元素、本条动画：子元素的 animationend 会冒泡上来 */
        if (!ev || ev.target !== el || ev.animationName !== CONCEAL_ANIM) return;
        finish();
    }

    const settle = () => {
        if (job.superseded || (el && el.__ariaConceal !== job)) return false;
        /* 必须先摘 class 释放 fill:forwards，再落 onHidden：顺序反了的话这条动画会
           一直钉着 opacity:0，下次显示该元素就是透明的。两步同帧完成，中间不会闪。 */
        if (job.cls) {
            job.cls = false;
            try {
                el.classList.remove(CONCEAL_CLASS);
                el.removeEventListener('animationend', onAnimEnd);
                el.removeEventListener('animationcancel', onAnimEnd);
                /* 顺手擦掉三个入参，否则 DevTools 里每个退过场的元素都挂着一串
                   看起来还在生效的 --conceal-* */
                el.style.removeProperty('--conceal-dur');
                el.style.removeProperty('--conceal-y');
                el.style.removeProperty('--conceal-scale');
            } catch (e) { logCatch('motion', e); }
        }
        try { onHidden(); } catch (e) { logCatch('motion', e); }
        return true;
    };

    let done = false;
    /* 兜底 id 必须先声明再被 finish 引用：finish 可能在 setTimeout 返回前就被同步调用 */
    let fallbackId = null;
    /* 返回的 promise 以「本次落地」为准，不是以动画结束为准：时间轴被冻住时
       若跟着它 await，调用方会永久挂住。 */
    let resolveSettled;
    const settled = new Promise((r) => { resolveSettled = r; });
    const finish = () => {
        if (done) return false;
        done = true;
        if (fallbackId !== null) clearTimeout(fallbackId);
        const ok = settle();
        resolveSettled(ok);
        return ok;
    };

    if (!el || dur <= 0 || typeof el.classList?.add !== 'function') return Promise.resolve(settle());

    try {
        el.style.setProperty('--conceal-dur', dur + 'ms');
        el.style.setProperty('--conceal-y', y + 'px');
        el.style.setProperty('--conceal-scale', String(scale));
        el.addEventListener('animationend', onAnimEnd);
        el.addEventListener('animationcancel', onAnimEnd);
        el.classList.add(CONCEAL_CLASS);
        job.cls = true;
    } catch (e) {
        /* 挂不上就退化成「立刻隐藏」：功能不能让动画卡住 */
        logCatch('motion', e);
        return Promise.resolve(settle());
    }

    /* 兜底按动画时长收紧，而不是一律 1000ms：退场中的分区是绝对定位盖在新分区上的，
       兜底多久就遮挡多久。 */
    fallbackId = setTimeout(finish, Math.min(FINISH_FALLBACK_MS, dur + FALLBACK_GRACE_MS));
    return settled;
}

/** 仅供测试：清掉令牌缓存，下一次重新读 CSS */
export function _resetMotionTokensForTest() {
    tokenCache = null;
}
