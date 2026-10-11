/* ============================================================
 * types/legacy-prefixed.d.ts — 非标准 / 已弃用 API 的类型声明（仅供 tsc，不进运行时）
 *
 * TS 自带的 lib.dom 不含 WebKit 前缀 API，也不含 Node 的 `module` 引用。
 * 项目在少数处做能力探测（如 `window.AudioContext || window.webkitAudioContext`）
 * 或环境探测（`typeof module !== 'undefined'`），这里把它们声明出来，
 * 免得这些探测点被 TS 报成一片 TS2339 / TS2551 / TS2591。
 *
 * 同为纯 .d.ts：不被任何页面加载、无 import 引用，对运行时零影响。
 * 本文件是【手写】的，不属于 globals-dts.mjs 的生成范围（那份对应 PROJECT_GLOBAL_KEYS）。
 * ============================================================ */

/* WebKit 前缀音频：旧 Safari 与部分内嵌 webview 只有带前缀的构造器。 */
interface Window {
    webkitAudioContext?: typeof AudioContext;
    webkitOfflineAudioContext?: typeof OfflineAudioContext;
}

/* Node CJS 环境探测：浏览器里不存在，故标 optional（`typeof module !== 'undefined'` 会缩窄）。 */
declare var module: { exports?: unknown } | undefined;
