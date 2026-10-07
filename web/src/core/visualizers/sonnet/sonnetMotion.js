/* Portions ported from chthollyphile/folia-major (AGPL-3.0) — Copyright (c) chthollyphile and contributors. See THIRD_PARTY_NOTICES.md */
/**
 * sonnetMotion.js — folia sonnet 运动系统（sonnetMotion.ts 的 JS 移植）
 *
 * 纯绝对时间函数：所有运动都是 (shot, time) 的确定值，无积分器。
 * seek/暂停天然连续——同一时刻永远同一画面。
 */

export const clamp01 = (value) => Math.min(1, Math.max(0, value));

const cubicCoordinate = (point1, point2, time) => {
    const inverse = 1 - time;
    return 3 * inverse * inverse * time * point1
        + 3 * inverse * time * time * point2
        + time * time * time;
};

/** CSS cubic-bezier 求解（二分 x 曲线后采样 y） */
export const resolveCubicBezier = (x1, y1, x2, y2, value) => {
    const target = clamp01(value);
    if (target === 0 || target === 1) return target;
    let low = 0;
    let high = 1;
    let parameter = target;
    for (let iteration = 0; iteration < 12; iteration += 1) {
        const x = cubicCoordinate(x1, x2, parameter);
        if (x < target) low = parameter;
        else high = parameter;
        parameter = (low + high) / 2;
    }
    return cubicCoordinate(y1, y2, parameter);
};

export const easeSonnetInOut = (value) => resolveCubicBezier(0.65, 0, 0.35, 1, value);
export const easeSonnetEnter = (value) => resolveCubicBezier(0.22, 1, 0.36, 1, value);

export const easeSonnetExpoOut = (value) => (
    value === 1 ? 1 : 1 - Math.pow(2, -10 * value)
);

/* 机械移植自上游 sonnetMotion.ts:53（frameDecor 消费） */
export const easeSonnetElasticOut = (value) => {
    const p = 0.3;
    return Math.pow(2, -10 * value) * Math.sin((value - p / 4) * (2 * Math.PI) / p) + 1;
};

export const resolveShotProgress = (shot, time) => (
    clamp01((time - shot.startTime) / Math.max(shot.endTime - shot.startTime, 0.001))
);

/** 逐字入场：ExpoOut 打击感 */
export const resolveSegmentProgress = (startTime, endTime, time) => (
    easeSonnetExpoOut(clamp01((time - startTime) / Math.max(endTime - startTime, 0.08)))
);

export const resolveSonnetSegmentDepth = (role, random = Math.random) => {
    if (role !== 'decoration') return 0;
    return random() > 0.5 ? 0.5 + random() * 0.8 : -0.5 - random() * 0.8;
};

export const resolveSonnetSegmentNormalOffset = (role, layoutDirection, rotation, fontSize, randomValue) => {
    if (role !== 'support') return { x: 0, y: 0 };
    const distance = (Math.min(1, Math.max(0, randomValue)) * 2 - 1) * fontSize * 0.3;
    const normalAngle = rotation + (layoutDirection === 'vertical' ? 0 : Math.PI / 2);
    return {
        x: Math.cos(normalAngle) * distance,
        y: Math.sin(normalAngle) * distance,
    };
};

/** PV 镜头路径：ExpoOut 快入 → 近匀速漂移 → 柔和收尾 */
export const resolveShotPathProgress = (kind, progress) => {
    const linear = clamp01(progress);
    if (kind === 'tracking-ribbon' || kind === 'fragment-collage'
        || kind === 'quiet-tableau' || kind === 'poster-blocks') {
        return linear * 0.55 + easeSonnetInOut(linear) * 0.45;
    }
    if (linear < 0.18) return easeSonnetExpoOut(linear / 0.18) * 0.22;
    if (linear < 0.78) return 0.22 + ((linear - 0.18) / 0.6) * 0.56;
    const settle = (linear - 0.78) / 0.22;
    return 0.78 + (1 - (1 - settle) * (1 - settle)) * 0.22;
};

/** 7 种镜头的运动帧（x/y 归一化、scale、rotation rad） */
export const resolveShotMotionFrame = (kind, progress) => {
    const linear = clamp01(progress);
    const eased = resolveShotPathProgress(kind, linear);
    const frames = {
        'editorial-column': {
            x: -0.055 + eased * 0.095,
            y: 0.025 - eased * 0.04,
            scale: 0.98 + eased * 0.07,
            rotation: -0.006 + eased * 0.01,
        },
        'type-impact': {
            x: -0.035 + eased * 0.07,
            y: 0.018 - eased * 0.028,
            scale: 1 + (1 - easeSonnetExpoOut(Math.min(linear / 0.18, 1))) * 0.22 + eased * 0.08,
            rotation: -0.01 + eased * 0.016,
        },
        'fragment-collage': {
            x: -0.045 + eased * 0.085,
            y: 0.028 - Math.sin(eased * Math.PI) * 0.055,
            scale: 0.97 + eased * 0.09,
            rotation: -0.014 + eased * 0.028,
        },
        'tracking-ribbon': {
            x: -0.16 + eased * 0.28,
            y: 0.05 - eased * 0.085,
            scale: 0.98 + eased * 0.07,
            rotation: 0.008 - eased * 0.014,
        },
        'mask-reveal': {
            x: 0.035 - eased * 0.065,
            y: 0.1 - eased * 0.135,
            scale: 0.96 + eased * 0.12,
            rotation: -0.006 + eased * 0.009,
        },
        'poster-blocks': {
            x: -0.012 + eased * 0.024,
            y: 0.008 - eased * 0.016,
            scale: 0.99 + eased * 0.025,
            rotation: -0.0015 + eased * 0.003,
        },
        'quiet-tableau': {
            x: -0.022 + eased * 0.04,
            y: 0.014 - eased * 0.025,
            scale: 1 + eased * 0.028,
            rotation: -0.002 + eased * 0.003,
        },
    };
    return frames[kind];
};

export const SONNET_CAMERA_BREATH_MAX_OFFSET = 0.006;
export const SONNET_CAMERA_BREATH_MAX_SCALE = 0.002;
export const SONNET_CAMERA_BREATH_MAX_ROTATION = 0.0015;

/** 手持呼吸漂移：非公度正弦叠加，绝对时间求值 */
export const resolveSonnetCameraBreath = (time, phase = 0) => {
    const tau = time * Math.PI * 2;
    return {
        x: (Math.sin(tau * 0.13 + phase) * 0.65 + Math.sin(tau * 0.31 + phase * 1.7) * 0.35)
            * SONNET_CAMERA_BREATH_MAX_OFFSET,
        y: (Math.cos(tau * 0.11 + phase * 2.3) * 0.65 + Math.sin(tau * 0.29 + phase * 0.9) * 0.35)
            * SONNET_CAMERA_BREATH_MAX_OFFSET,
        scale: Math.sin(tau * 0.09 + phase * 1.3) * SONNET_CAMERA_BREATH_MAX_SCALE,
        rotation: Math.sin(tau * 0.07 + phase * 2.9) * SONNET_CAMERA_BREATH_MAX_ROTATION,
    };
};

/** 歌词点亮完成后呼吸权重渐入（1.2s ramp），避免中途突然出现 */
export const resolveSonnetBreathWeight = (time, revealDoneTime, rampDuration = 1.2) => {
    if (rampDuration <= 0) return time >= revealDoneTime ? 1 : 0;
    return easeSonnetInOut(clamp01((time - revealDoneTime) / rampDuration));
};

/** 纯时间轴伪随机震颤（chorus/lift 用） */
export const resolveTimelineShake = (time, intensity) => {
    if (intensity <= 0) return { x: 0, y: 0, rotation: 0 };
    const shakeX = Math.sin(time * 123.456) * Math.cos(time * 789.123);
    const shakeY = Math.cos(time * 345.678) * Math.sin(time * 901.234);
    const shakeRot = Math.sin(time * 567.89);
    return {
        x: shakeX * 0.02 * intensity,
        y: shakeY * 0.02 * intensity,
        rotation: shakeRot * 0.005 * intensity,
    };
};

/** 逐字运动的运动窗（上游 resolveSonnetGlyphMotionDuration） */
export const resolveSonnetGlyphMotionDuration = (motionWindow) => {
    const shotDuration = Math.max(0.001, motionWindow.endTime - motionWindow.startTime);
    const preferred = Math.min(1.8, Math.max(0.65, shotDuration * 0.42));
    return Math.min(preferred, shotDuration * 0.72);
};

/** 段落间相机焦点的高斯权重（σ=0.35s，含静默间隙与尾段） */
/* 机械移植自上游 sonnetMotion.ts:108-153（相机焦点时域平滑；此前批次遗漏） */
const SONNET_CAMERA_SMOOTHING_SAMPLES = [
    { offset: -1, weight: 1 },
    { offset: -0.5, weight: 4 },
    { offset: 0, weight: 6 },
    { offset: 0.5, weight: 4 },
    { offset: 1, weight: 1 },
];

// Applies deterministic edge-preserving temporal smoothing without tying camera motion to frame rate.
export const resolveSonnetSmoothedCameraFocus = (
    time,
    startTime,
    endTime,
    sampleFocus,
    smoothingWindow = 0.12,
    maxBlendDistance = 96,
) => {
    const safeStart = Math.min(startTime, endTime);
    const safeEnd = Math.max(startTime, endTime);
    const radius = Math.max(0, smoothingWindow);
    if (radius === 0 || safeStart === safeEnd) {
        return sampleFocus(Math.min(safeEnd, Math.max(safeStart, time)));
    }

    const samples = SONNET_CAMERA_SMOOTHING_SAMPLES.map(({ offset, weight }) => {
        const sampleTime = Math.min(safeEnd, Math.max(safeStart, time + offset * radius));
        return { point: sampleFocus(sampleTime), weight };
    });
    const center = samples[2].point;
    const maxDistanceSquared = Math.max(0, maxBlendDistance) ** 2;
    let x = 0;
    let y = 0;
    let totalWeight = 0;
    samples.forEach(({ point, weight }) => {
        const distanceSquared = (point.x - center.x) ** 2 + (point.y - center.y) ** 2;
        // Preserve intentional composition jumps instead of averaging two distant focal points.
        if (distanceSquared > maxDistanceSquared) return;
        x += point.x * weight;
        y += point.y * weight;
        totalWeight += weight;
    });
    return { x: x / totalWeight, y: y / totalWeight };
};

export const resolveSonnetFocusWeights = (ranges, time, sigma = 0.35) => {    if (ranges.length === 0) return [];
    const safeSigma = Math.max(0.001, sigma);
    const logWeights = ranges.map(range => {
        const startTime = Math.min(range.startTime, range.endTime);
        const endTime = Math.max(range.startTime, range.endTime);
        const distance = time < startTime
            ? startTime - time
            : time > endTime ? time - endTime : 0;
        return -(distance * distance) / (2 * safeSigma * safeSigma);
    });
    const maxLogWeight = Math.max(...logWeights);
    const weights = logWeights.map(weight => Math.exp(weight - maxLogWeight));
    const totalWeight = weights.reduce((total, weight) => total + weight, 0);
    return weights.map(weight => weight / totalWeight);
};
