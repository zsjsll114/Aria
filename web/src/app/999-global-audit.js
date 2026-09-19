/* ============================================================
 * 999-global-audit.js — P1 全局状态收敛：启动末尾审计（最后加载）
 *
 * 在全部 46 分片 import 完成后运行：
 *   - 校验 10-config-state.js 登记的 76 个全局键是否已定义
 *   - 报告类型漂移与「跨分片多处写入」键（仅日志，不改运行行为）
 * 延迟到 window load 后执行，避免启动流程早期（engine 等惰性初始化）
 * 尚未赋值的键被误报「未定义」。auditGlobals 里 strict=false 不抛错。
 * ============================================================ */
import { auditGlobals, listGlobals } from '../core/globalRegistry.js';
import { logWarn } from '../services/log.js'; // ★ 全库唯一 console.* 使用点是 services/log.js；审计异常也走 logWarn

/* DevTools 调试入口：Aria 里 console 执行 __listGlobals() 查看注册表快照 */
if (typeof window !== 'undefined') {
    globalThis.__listGlobals = () => listGlobals();
}

function runAudit() {
    try {
        auditGlobals({ strict: false });
    } catch (e) {
        logWarn('globalRegistry', '审计异常(不影响运行):', e);
    }
}

if (typeof window !== 'undefined') {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(runAudit, 800);
    } else {
        window.addEventListener('load', () => setTimeout(runAudit, 800), { once: true });
    }
}