/**
 * han-convert —— 第三方繁简转换 vendor 的**手写类型声明**（不是编译产物）。
 *
 * 来源：`chinese-simple2traditional` 的浏览器构建（压成单行的 rollup 产物，33KB，无源码）。
 * 本文件与 `index.mjs` 同目录同名（`.d.mts` 对应 `.mjs`），解析时**声明优先于 JS**，
 * 于是 tsc 只看这里、不再去 `checkJs` 那份 minified 代码——它自身的 24 条
 * TS7006/TS7031（隐式 any 参数）属上游噪音，不该记在本项目的棘轮账上。
 *
 * 为什么不用 tsconfig 的 `exclude`：TS 的 exclude 只作用于 include 的 glob 展开，
 * 对**被 import 的文件**无效（见 docs/typescript-类型化路线.md「为什么 app/ 暂缓」）。
 * 同目录同名声明是唯一能把第三方 JS 挡在检查之外的机制。
 *
 * 下面 6 个符号由运行时探针实测确认（typeof / arity / 繁简互转往返），不是照名字猜的：
 *   node -e "import('./index.mjs').then(m => Object.entries(m).forEach(...))"
 *
 * ⚠ 升级 vendor 时若导出面变化，**必须同步本文件**：同名的 .mjs 不会被检查，
 *   漏改不会在 vendor 处报错，只会在调用方报 TS2305。
 */

/** 繁 → 简（单字 + 词组表；本项目唯一在用，见 services/lyricMatcher.js） */
export function toSimplified(text: string): string;

/** 简 → 繁（`toSimplified` 的逆向） */
export function toTraditional(text: string): string;

/** 简 → 繁（与 `toTraditional` 同向，包内另一路实现） */
export function simpleToTradition(text: string): string;

/** 繁 → 简（与 `toSimplified` 同向，包内另一路实现） */
export function traditionToSimple(text: string): string;

/**
 * 追加自定义「简 → 繁」词组（setter，无返回值）。
 * 入参是 `[原词, 替换词]` 对的集合——数组与 Map 均实测可用。
 */
export function customS2TPhrases(phrases: Iterable<[string, string]>): void;

/**
 * 追加自定义「繁 → 简」词组（setter，无返回值）。
 * 入参是 `[原词, 替换词]` 对的集合——数组与 Map 均实测可用。
 */
export function customT2SPhrases(phrases: Iterable<[string, string]>): void;
