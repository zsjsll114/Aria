/* ============================================================
 * 308-jizura-preload.js — 空闲预热「字面 · Jizura」引擎
 *
 * 为什么需要：引擎是 39 个 ES module（源码 ≈2MB），首次切过去要一个个请求+解析。
 * 实测（本地 server / headless）第一次 plan 要等 1~2 秒，这期间画布是空的 ——
 * 用户看到的是"切过去黑一下"。这里在**应用启动后的空闲时段**先把它 import 掉，
 * 真去切模式时已经就绪。
 *
 * 三条自我约束：
 *   ① 只在 requestIdleCallback（不支持则 6 秒兜底）时做，绝不与应用启动抢带宽/主线程；
 *   ② 低配 / 软件渲染设备直接跳过 —— 它们的帧预算本来就紧，不该为"可能用不到的模式"预热；
 *   ③ 失败静默：vendor 文件缺失不该在控制台留噪音（getJizuraEngine 自己会记日志）。
 * ============================================================ */
import { getJizuraEngine } from '../core/visualizers/jizura/jizuraBridge.js';
import { logCatch } from '../services/log.js';

const TAG = 'jizuraPreload';

/** 低配/无 GPU 不预热（读的是启动期就写好的档位类名，不是每帧都判） */
function shouldSkip() {
    try {
        const body = document.body.classList;
        const html = document.documentElement.classList;
        return body.contains('perf-minimal') || html.contains('is-software-renderer');
    } catch {
        return false;
    }
}

function warm() {
    if (shouldSkip()) return;
    getJizuraEngine().catch((e) => logCatch(TAG, e));
}

if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(warm, { timeout: 8000 });
} else {
    setTimeout(warm, 6000);
}
