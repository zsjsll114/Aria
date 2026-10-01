/**
 * temperaRandom.js — 机械移植自 chthollyphile/folia-major src/components/visualizer/tempera/temperaRandom.ts
 * 逐行保真移植：仅删除类型标注，不改任何逻辑/数值/分支。
 * 注：与 ../sonnet/sonnetRandom.js 的 API（hashSonnetSeed/mixSonnetSeed/hash01 参数序）不匹配，
 * 故按上游原样单独移植，未复用 sonnet 版。
 */

// src/components/visualizer/tempera/temperaRandom.ts
// Supplies deterministic selection without relying on process-global random state.
export const hashTemperaSeed = (value) => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
};

// Mixes a numeric seed with a salt so different sub-systems (blocks, decor,
// per-glyph jitter) stay decorrelated.
export const mixTemperaSeed = (seed, salt) => (
    Math.imul((Math.trunc(seed) ^ salt) >>> 0, 2654435761) >>> 0
);

// Deterministic 0..1 jitter per element index; seek-safe and rebuild-stable.
export const temperaHash01 = (seed, index, salt) => (
    mixTemperaSeed(seed + Math.imul(index + 1, 97), salt) / 4294967296
);

// Picks a deterministic choice that differs from the previous pick when possible.
export const chooseWithoutRepeat = (choices, seed, previous) => {
    const start = hashTemperaSeed(seed) % choices.length;
    for (let offset = 0; offset < choices.length; offset += 1) {
        const candidate = choices[(start + offset) % choices.length];
        if (candidate !== previous) return candidate;
    }
    return choices[start];
};
