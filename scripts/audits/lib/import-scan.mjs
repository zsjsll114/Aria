/* ============================================================
 * scripts/audits/lib/import-scan.mjs — import 抽取的公共正则
 *
 * 单独成文件的原因：`module-reachability.mjs` 在导入时就会全仓扫描并打印报告，
 * 自测没法直接 import 它。判定逻辑抽到这里，门禁与它的测试共用同一份（不抄第二遍）。
 * ============================================================ */

/**
 * 静态 import 的 specifier 列表。
 *
 * ★ 跨行部分必须是 `[^;]*?` 而不是 `[\s\S]*?`：
 *   副作用写法 `import '../utils/numberStepper.js';` 后面紧跟一条 `import { x } from '...'` 时，
 *   懒匹配从副作用那行的 `import` 起跳、越过换行撞到**后一条**的 `from '...'`，
 *   于是副作用 import 的 specifier 永远不进图。实测后果是把只被副作用引用的模块
 *   误报成「不可达影子模块」（AGENTS.md 约束 10 的那张名单本来就有 4 个，虚增到 5 过一次）。
 */
export const STATIC_IMPORT_RE = /(?:^|[\s(;{}=])import\s+(?:[^;]*?\sfrom\s*)?["']([^"']+)["']/g;

export function extractStaticImports(text) {
    return [...text.matchAll(STATIC_IMPORT_RE)].map((m) => m[1]);
}
