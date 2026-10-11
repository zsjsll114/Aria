/* ============================================================
 * types/dom-extensions.d.ts — 项目在 DOM 元素上挂的私有标记（仅供 tsc，不进运行时）
 *
 * 项目惯例：把「按元素复用一次的标记 / 幂等守卫 / 进行中的任务句柄」直接挂在元素上
 * （而不是另建 WeakMap）—— 例如设置页导航锚点的滚动锁、退场动画的 job 句柄。
 * 这些不是浏览器 API，lib.dom 自然不认识，统一在这里声明出来。
 *
 * 纯 .d.ts：不被任何页面加载、无 import 引用，对运行时零影响。
 * 本文件是【手写】的，不属于 globals-dts.mjs 的生成范围。
 * ============================================================ */

interface Element {
    /** 设置页导航锚点：该 chip 对应的目标分组 */
    __anchorTarget?: Element;
}

interface HTMLElement {
    /** 锚点点击后的滚动跟随锁（时间戳 ms） */
    __anchorClickLock?: number;
    /** 滚动跟随监听是否已绑过（幂等守卫） */
    __anchorSpyBound?: boolean;
    /** 正在进行的退场动画 job（`utils/motion.js`） */
    __ariaConceal?: { superseded: boolean, cls: boolean } | null;
}
