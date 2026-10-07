/**
 * sonnetTransitions.js — folia sonnetTransitions.ts 的 1:1 移植
 *
 * 快速、seek 稳定、单色（无色散）的场景转场。三类：
 *   fast-blur   — blur 0→14px + alpha 淡出
 *   mono-glitch — 14 级阶梯 glitch（逐字 x 抖动），尾部 14% 才淡出
 *   camera-pull — 纯 alpha 拉出
 * 所有帧是 time 的纯函数；IDLE 帧零开销。
 */

import { clamp01, easeSonnetInOut } from './sonnetMotion.js';

/* ★ 2026-09-30：mono-glitch 权重加倍（用户实测「没有错误特效来切镜」——上游三选一
   均分，glitch 命中率仅 1/3，观感上几乎见不到撕裂）。上游 kind 池 1:1 保留，此处只调分布。 */
export const SONNET_TRANSITION_KINDS = ['fast-blur', 'mono-glitch', 'camera-pull'];
const SONNET_BOUNDARY_KIND_POOL = ['mono-glitch', 'fast-blur', 'mono-glitch', 'camera-pull'];

export const IDLE_SONNET_TRANSITION_FRAME = Object.freeze({
    x: 0, y: 0, scale: 1, rotation: 0, alpha: 1, blur: 0, glitch: 0, glitchSeed: 0,
});

const resolveBoundaryKind = (seed, boundaryIndex) => {
    const mixed = (seed ^ Math.imul(boundaryIndex + 1, 0x9e3779b1)) >>> 0;
    return SONNET_BOUNDARY_KIND_POOL[mixed % SONNET_BOUNDARY_KIND_POOL.length];
};

export const resolveSonnetTransitionEffectFrame = (kind, phase, progress, seed) => {
    const linear = clamp01(progress);
    const eased = easeSonnetInOut(linear);
    const amount = phase === 'exit' ? eased : 1 - eased;

    if (kind === 'fast-blur') {
        return {
            x: 0, y: 0, scale: 1, rotation: 0,
            alpha: phase === 'exit' ? 1 - amount : 1 - amount * 0.82,
            blur: amount * 20,
            glitch: 0, glitchSeed: 0,
        };
    }

    if (kind === 'mono-glitch') {
        const step = Math.floor(linear * 14);
        return {
            x: 0, y: 0, scale: 1, rotation: 0,
            alpha: phase === 'exit' && linear > 0.86 ? 1 - (linear - 0.86) / 0.14 : 1,
            blur: 0,
            glitch: amount,
            glitchSeed: seed * 0.0001 + step * 0.173,
        };
    }

    /* camera-pull */
    return {
        x: 0, y: 0, scale: 1, rotation: 0,
        alpha: phase === 'exit' ? 1 - amount : 1 - amount * 0.72,
        blur: 0, glitch: 0, glitchSeed: 0,
    };
};

export const resolveSonnetEnterTransitionFrame = (kind, timeSinceStart, duration, enabled, seed) => {
    if (!enabled || !kind || timeSinceStart < 0 || timeSinceStart > duration) {
        return IDLE_SONNET_TRANSITION_FRAME;
    }
    return resolveSonnetTransitionEffectFrame(kind, 'enter', timeSinceStart / Math.max(duration, 0.001), seed);
};

/* ★ 2026-10-02 移植（上游 sonnetTransitions.ts:90）：段尾退场转场——按段落自身
   transitionOut 的时间窗出 exit 效果帧（blur/glitch/alpha）。这是上游「旧段退场」
   的唯一机制：无 fadeScene、无文本压暗，段尾只有这一段转场软化硬切。 */
export const resolveSonnetExitTransitionFrame = (paragraph, time, enabled, seed) => {
    const transition = paragraph && paragraph.transitionOut;
    if (!enabled || !transition || time < transition.startTime) return IDLE_SONNET_TRANSITION_FRAME;
    const progress = (time - transition.startTime) / Math.max(transition.endTime - transition.startTime, 0.001);
    return resolveSonnetTransitionEffectFrame(transition.kind, 'exit', progress, seed);
};

/** 给每个 shot 边界一段短转场（上游 resolveSonnetShotTransitionFrame 等价） */
export const resolveSonnetShotTransitionFrame = (shots, activeShotIndex, time, enabled, seed) => {
    if (!enabled || shots.length < 2) return IDLE_SONNET_TRANSITION_FRAME;
    const current = shots[activeShotIndex];
    if (!current) return IDLE_SONNET_TRANSITION_FRAME;

    if (activeShotIndex > 0) {
        const previous = shots[activeShotIndex - 1];
        /* ★ 2026-09-30 窗口加长（用户实测切镜无动画感）：0.14-0.24s 人眼难感知 → 0.3-0.5s */
        const duration = Math.min(0.5, Math.max(0.3, (current.startTime - previous.startTime) * 0.18));
        if (time <= current.startTime + duration) {
            return resolveSonnetEnterTransitionFrame(
                resolveBoundaryKind(seed, activeShotIndex - 1),
                time - current.startTime,
                duration,
                true,
                seed + activeShotIndex * 97,
            );
        }
    }

    const next = shots[activeShotIndex + 1];
    if (!next) return IDLE_SONNET_TRANSITION_FRAME;
    const duration = Math.min(0.5, Math.max(0.3, (next.startTime - current.startTime) * 0.18));
    const transitionStart = next.startTime - duration;
    if (time < transitionStart) return IDLE_SONNET_TRANSITION_FRAME;
    return resolveSonnetTransitionEffectFrame(
        resolveBoundaryKind(seed, activeShotIndex),
        'exit',
        (time - transitionStart) / duration,
        seed + (activeShotIndex + 1) * 97,
    );
};
