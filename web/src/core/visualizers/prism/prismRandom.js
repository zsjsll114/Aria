/* ============================================================
 * prismRandom.js — 「棱镜 · Prism」确定性伪随机数生成器与哈希工具
 *
 * 保证同一首歌、同一段歌词生成的分镜构图、切面角度与排版位置 100% 确定且 seek-safe。
 * ============================================================ */

/**
 * 32-bit FNV-1a 字符串哈希
 * @param {string} str
 * @returns {number} 32位正整数种子
 */
export function hashPrismSeed(str) {
    let hash = 2166136261 >>> 0;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
        hash ^= s.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash;
}

/**
 * 组合多个种子
 * @param {number} seed
 * @param {number|string} salt
 * @returns {number}
 */
export function mixPrismSeed(seed, salt) {
    const s = typeof salt === 'number' ? salt : hashPrismSeed(String(salt));
    let h = (seed ^ s) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
}

/**
 * 确定性 [0, 1) 浮点随机数生成器
 * @param {number} seed
 * @param {number} index
 * @param {number} [salt=101]
 * @returns {number} 0 <= x < 1
 */
export function prismHash01(seed, index, salt = 101) {
    let h = (seed + Math.imul(index + 1, salt)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 1812433253) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 2246822507) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * 确定性区间随机数 [min, max]
 * @param {number} seed
 * @param {number} index
 * @param {number} min
 * @param {number} max
 * @param {number} [salt=101]
 * @returns {number}
 */
export function prismRange(seed, index, min, max, salt = 101) {
    return min + (max - min) * prismHash01(seed, index, salt);
}

/**
 * 从数组中无连续重复抽取元素
 * @template T
 * @param {T[]} pool
 * @param {number} seed
 * @param {number} index
 * @param {T|null} [lastItem=null]
 * @returns {T}
 */
export function pickPrismCandidate(pool, seed, index, lastItem = null) {
    if (!pool || pool.length === 0) return null;
    if (pool.length === 1) return pool[0];
    const available = lastItem != null ? pool.filter(item => item !== lastItem) : pool;
    const candidates = available.length > 0 ? available : pool;
    const idx = Math.floor(prismHash01(seed, index, 79) * candidates.length) % candidates.length;
    return candidates[idx];
}
