/* ============================================================
 * 007-static-overlays.js — 静态骨架浮层的契约收编入口（P3-b）
 *
 * 实现在 ui/static-overlays.js，这里只负责"什么时候跑"与失败留痕。
 *
 * ★ 为什么排在 021 之前：属性收编必须在任何分片开始操作这些浮层之前完成
 *   （模块是 defer 语义，执行时 DOM 已解析完，静态骨架都在）。
 * ★ 为什么不放在 ui/ 里自挂：ui/ 只放实现，挂载点集中在 app/ 分片里，
 *   与 005-skeleton / 021-aria-dialog 的既有分工一致。
 * ============================================================ */
import Aria from './000-aria-ns.js';
import { adoptStaticOverlays } from '../ui/static-overlays.js';
import { logWarn } from '../services/log.js';

if (typeof document !== 'undefined') {
    const report = adoptStaticOverlays();
    /* 留痕而不是静默：missing 说明 index.html 的结构变了而 ui/static-overlays.js
       的登记表没跟上 —— 那正是"新加了浮层却没人管可访问性"的信号。
       （tests/js/test_static_overlay_adoption.js 会在 CI 上直接挡住这种漂移。） */
    if (report.missing.length) {
        logWarn('staticOverlays', '登记表里的浮层没找到（index.html 结构变了？）:', report.missing);
    }
    /* 收编结果挂到 Aria 命名空间供诊断页/测试读取。
       ★ 不用 globalThis.__xxx：门禁 B（no-restricted-syntax）禁止新文件写裸全局键，
       Aria.set 是本仓收敛后的唯一合法路径（见 000-aria-ns.js）。 */
    Aria.set('staticOverlays', report);
}
