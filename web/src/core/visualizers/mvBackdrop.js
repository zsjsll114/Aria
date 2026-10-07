/**
 * mvBackdrop.js — MV 动态背景 × 全景视觉模式的「舞台压薄」契约（2026-10-04）
 *
 * 问题：tempera / tunnel 两个模式各自在自己的舞台上刷一层**不透明底**——
 *   版画的构图色块（addCutField alpha .92~.95）、蒙德里安的满屏色板
 *   （`.t-m-bg` 实心渐变 + `.t-m-block` alpha 烘焙成 0.92）。
 *   它们都在 `.player-container` 内、z-index ≥ 2，而 MV 是 body 级 z-index -2，
 *   于是 MV 被整块盖死（用户报：「蒙德里安无法显示 MV；
 *   版画部分分镜背景不透明，看不见 MV」）。
 *
 * 为什么不能只靠 CSS：mv.css 只改得动 DOM 元素的 background/opacity；
 *   Pixi 的 `renderer.background.alpha`、Graphics 的 fill alpha、
 *   以及被 `_hexWithAlpha()` 烘焙进 `backgroundColor` 的块透明度，
 *   CSS 一律够不着 —— 必须由引擎自己乘这个因子。
 *
 * 契约：`body.mv-bg-on` 为真 ⇔ **MV 开关开着 且 当前确实铺上了 MV**
 *   （101-mv-background 的 applyMvBgSettings 写、failMv/clearMvBackground 摘）。
 *   三个引擎的「底」一律乘 mvBackdropAlpha()：
 *     因子 = MV_BACKDROP_ALPHA（MV 在播） / 1（其余一切情况）
 *   ⇒ 不开 MV、没匹配到 MV、MV 取址失败时，各模式的原始观感**一个像素都不变**。
 */

/**
 * 「舞台底」在 MV 之上的透明度乘数。
 *
 * 0.26 是**量出来的**，不是拍的：蒙德里安一支 MV 上有三层会叠（暗幕 × 满屏底 × 色块
 * 及其 `::after` 影晕），单层 0.32 时合成覆盖已到 0.74 —— MV 只剩 26% 可见，看着
 * 还是"被盖死"。压到 0.26 并把隧道那两层另行处理（见 mv.css），合成覆盖 ≈0.36，
 * MV 约六成可见，同时色块/卷面/构图的骨架仍然读得出来。
 */
export const MV_BACKDROP_ALPHA = 0.26;

/** MV 背景开/关的广播事件名（唯一广播点：101-mv-background 的 setMvBgOn） */
export const MV_BACKDROP_EVENT = 'aria:mv-bg-change';

/**
 * 预览宿主：**设置面板里那几块实时预览不是"MV 的舞台"**。
 * 它们下面根本没有 MV，压薄只会让画布变透明、露出设置面板本身（预览变成一块空框）。
 * 主播放器与预览用的是同一批引擎，所以唯一的区分办法是问宿主元素自己。
 */
const PREVIEW_HOST_SELECTOR = '.preview-player, #lyricPreviewContainer, .preview-view-container';

/** 现在底下是否真有 MV 在播。 */
export function mvBgActive() {
    if (typeof document === 'undefined' || !document.body) return false;
    return document.body.classList.contains('mv-bg-on');
}

/**
 * 舞台底的透明度乘数（1 = 原样不动）。
 * @param {Element} [host] 引擎的宿主元素。传了它才能识别出"这是预览窗"并返回 1；
 *   不传 = 按主播放器处理（老调用点行为不变）。
 */
export function mvBackdropAlpha(host) {
    if (!mvBgActive()) return 1;
    if (host && typeof host.closest === 'function' && host.closest(PREVIEW_HOST_SELECTOR)) return 1;
    return MV_BACKDROP_ALPHA;
}

/**
 * 订阅 MV 背景开/关。返回退订函数（引擎 destroy 时必须调，否则监听器泄漏）。
 * ★ 回调里**不要用入参**，请自己重算 `mvBackdropAlpha(自己的宿主)` ——
 *   入参是全应用一个数，而预览窗要按宿主返回 1。
 * @param {() => void} cb
 */
export function onMvBackdropChange(cb) {
    if (typeof window === 'undefined' || typeof cb !== 'function') return () => {};
    const handler = () => {
        try { cb(); } catch { /* 订阅方自己的异常不外溢 */ }
    };
    window.addEventListener(MV_BACKDROP_EVENT, handler);
    return () => window.removeEventListener(MV_BACKDROP_EVENT, handler);
}

/**
 * 广播 MV 背景状态变化。**只由 101-mv-background 在切换 body.mv-bg-on 之后调用**——
 * 多一个广播点就会出现"class 与各引擎认知不一致"的窗口。
 */
export function broadcastMvBackdrop() {
    if (typeof window === 'undefined') return;
    try {
        window.dispatchEvent(new CustomEvent(MV_BACKDROP_EVENT, { detail: { on: mvBgActive() } }));
    } catch { /* CustomEvent 不可用（极老内核）时静默：引擎下次重建会读到新因子 */ }
}
