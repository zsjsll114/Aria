/* ============================================================
 * services/selfhostPlayHooks.js — 自建服务取链能力注册表
 *
 * 解耦 app/selfhost-runtime.js（高阶运行时）与 services/musicApi.js（取链基础层）：
 * 避免 services 反向 static import app 层导致架构成环，同时让跨源兜底
 * （如酷狗/酷我回退到 QQ / 网易时）同样优先走本机自建服务而非直奔外链。
 * ============================================================ */

/** @typedef {{ qq?: ((mid: string, quality?: string) => Promise<string | null>) | null | undefined, netease?: ((id: string | number, level?: string, signal?: AbortSignal | null) => Promise<string | null>) | null | undefined }} SelfhostPlayHooks */

/** @type {SelfhostPlayHooks} */
let _hooks = { qq: null, netease: null };

/** @param {SelfhostPlayHooks} hooks */
export function registerSelfhostPlayHooks(hooks) {
    if (!hooks || typeof hooks !== 'object') return;
    _hooks = {
        qq: typeof hooks.qq === 'function' ? hooks.qq : _hooks.qq,
        netease: typeof hooks.netease === 'function' ? hooks.netease : _hooks.netease,
    };
}

/** @returns {SelfhostPlayHooks} */
export function getSelfhostPlayHooks() {
    return _hooks;
}

/** 仅单测重置用 */
export function resetSelfhostPlayHooks() {
    _hooks = { qq: null, netease: null };
}
