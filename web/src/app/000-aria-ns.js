/* ============================================================
 * 000-aria-ns.js — Aria 全局命名空间（P1 全局状态收敛·命名空间化）
 *
 * 目标：把散落在 window 上的内部工具（window.__foo 共享函数/缓存，
 * 31 键中除 Tauri 注入的 __TAURI__/__TAURI_API_ORIGIN 外的 29 键）
 * 收敛到单一命名空间 window.Aria，消除 window 污染与歧义。
 *
 * 约定：
 *   - 本分片必须是 index.js 第一个 import（先于所有消费方）。
 *   - 写入统一用 Aria.set(key, val)，读取可用 Aria.get(key)；
 *     直接属性读写 Aria.xxx 亦合法（保持 __ 迁移期兼容）。
 *   - 注意：Tauri 注入的 window.__TAURI__ / window.__TAURI_API_ORIGIN
 *     不属于本项目，禁止迁移，勿改名。
 * ============================================================ */

const NS = (typeof window !== 'undefined' && window.Aria) || {};

/* 命名空间语义：set 写入 Aria + 不做 globalThis 镜像（区别于 10-config-state
   的状态键；__ 工具本就走显式 window.__foo 读写，不依赖裸标识符协议） */
NS.set = function ariaSet(key, value) {
    NS[key] = value;
    return value;
};
NS.get = function ariaGet(key) {
    return NS[key];
};

if (typeof window !== 'undefined') {
    // 幂等：保证 Aria 已在全局（多个入口/热更场景不重复初始化）
    window.Aria = NS;
    if (!globalThis.Aria) globalThis.Aria = NS;
}

export default NS;