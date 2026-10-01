/**
 * sonnetRandom.js — folia sonnet 确定性随机（sonnetRandom.ts 的 JS 移植）
 *
 * 上游：chthollyphile/folia-major src/components/visualizer/sonnet/sonnetRandom.ts
 * FNV-1a 32 位 hash + 乘法混合，全程禁用 Math.random()——同一首歌每次渲染
 * 逐帧一致（AGENTS「确定性」约定的 folia 对应实现）。
 */

/** FNV-1a 32 位字符串哈希 */
export function hashSonnetSeed(input) {
    let hash = 2166136261;
    const text = String(input);
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

/** 乘法混合（MurmurHash3 finalizer 常数 2654435761） */
export const mixSonnetSeed = (seed, salt) => (
    Math.imul((seed ^ salt) >>> 0, 2654435761) >>> 0
);

/** 确定性 [0,1) 随机：seed+salt 派生，i 为第 i 个采样 */
export const hash01 = (seed, salt, i) => (
    mixSonnetSeed((seed + Math.imul(i + 1, 97)) >>> 0, salt) / 4294967296
);
