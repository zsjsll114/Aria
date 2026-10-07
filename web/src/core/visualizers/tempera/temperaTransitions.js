/* Portions ported from chthollyphile/folia-major (AGPL-3.0) — Copyright (c) chthollyphile and contributors. See THIRD_PARTY_NOTICES.md */
/**
 * temperaTransitions.js — 机械移植自 chthollyphile/folia-major src/components/visualizer/tempera/temperaTransitions.ts
 * 逐行保真移植：仅删除类型标注，不改任何逻辑/数值/分支。
 */

import { easeTemperaInOut, clamp01 } from './temperaMotion.js';

// src/components/visualizer/tempera/temperaTransitions.ts
// Seek-stable transition frames for *paragraph* boundaries. Shot boundaries need none: the
// compositions hand off to each other directly in the runtime. Every kind here is led by the
// large graphics or by the camera and runs along the shot's flow angle, so the outgoing and
// incoming paragraphs travel the same way and the boundary reads as one continuous move.
// (接口 TemperaTransitionFrame 已随 TypeScript 类型标注一并移除。)

export const IDLE_TEMPERA_TRANSITION_FRAME = {
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
    alpha: 1,
    blur: 0,
    wipe: 0,
    wipeAngle: 0,
};

/**
 * Resolves one side of a boundary. `exit` moves the outgoing composition further along the
 * flow; `enter` starts the incoming one upstream and lets it arrive on the same vector, so
 * across the swap the on-screen motion never changes direction.
 */
export const resolveTemperaTransitionEffectFrame = (
    kind,
    phase,
    progress,
    flowAngle,
) => {
    const linear = clamp01(progress);
    const eased = easeTemperaInOut(linear);
    const flowX = Math.cos(flowAngle);
    const flowY = Math.sin(flowAngle);

    if (kind === 'block-wipe') {
        // The scene stays fully opaque and in place; a screen-sized block slides across on the
        // flow vector and the swap happens under full coverage. The sweep is one continuous
        // 0..2 travel: 0..1 brings the block in, 1..2 carries it off the far side, so the
        // block never reverses direction halfway through the boundary.
        return {
            ...IDLE_TEMPERA_TRANSITION_FRAME,
            wipe: phase === 'exit' ? eased : 1 + eased,
            wipeAngle: flowAngle,
        };
    }

    if (kind === 'camera-pan') {
        const travel = 0.5;
        // Alpha is held until the composition is nearly off frame, so the swipe never dips
        // to an empty screen in the middle of the move.
        const offset = phase === 'exit' ? eased * travel : -(1 - eased) * travel;
        const alpha = phase === 'exit'
            ? 1 - clamp01((linear - 0.72) / 0.28)
            : clamp01(linear / 0.3);
        return {
            ...IDLE_TEMPERA_TRANSITION_FRAME,
            x: flowX * offset,
            y: flowY * offset,
            scale: 1 + (phase === 'exit' ? eased : 1 - eased) * 0.03,
            alpha,
            wipeAngle: flowAngle,
        };
    }

    // shape-carry: the composition keeps drifting on the flow vector while it dilates and
    // softens, as if the next graphic were pulling it out of focus. No hard cut, no glitch.
    const drift = (phase === 'exit' ? eased : eased - 1) * 0.09;
    const away = phase === 'exit' ? eased : 1 - eased;
    return {
        ...IDLE_TEMPERA_TRANSITION_FRAME,
        x: flowX * drift,
        y: flowY * drift,
        scale: 1 + away * 0.07,
        alpha: phase === 'exit' ? 1 - clamp01((linear - 0.55) / 0.45) : clamp01(linear / 0.45),
        blur: away * 6,
        wipeAngle: flowAngle,
    };
};

export const resolveTemperaExitTransitionFrame = (
    paragraph,
    time,
    enabled,
) => {
    const transition = paragraph.transitionOut;
    if (!enabled || !transition || time < transition.startTime) return IDLE_TEMPERA_TRANSITION_FRAME;
    const progress = (time - transition.startTime) / Math.max(transition.endTime - transition.startTime, 0.001);
    const flowAngle = paragraph.shots.at(-1)?.flowAngle ?? 0;
    return resolveTemperaTransitionEffectFrame(transition.kind, 'exit', progress, flowAngle);
};

export const resolveTemperaEnterTransitionFrame = (
    kind,
    timeSinceStart,
    duration,
    enabled,
    flowAngle,
) => {
    if (!enabled || !kind || timeSinceStart < 0 || timeSinceStart > duration) {
        return IDLE_TEMPERA_TRANSITION_FRAME;
    }
    return resolveTemperaTransitionEffectFrame(kind, 'enter', timeSinceStart / Math.max(duration, 0.001), flowAngle);
};
