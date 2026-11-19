/**
 * @fileoverview 在线歌曲取链结果缓存（Bounded LRU + TTL）与公网上游熔断冷却表。
 * 作用：
 * 1. 同一首歌在 TTL 内二次点播 / 切回上一首 / 预热命中时直接复用已解析的直链，实现秒切；
 * 2. 上游接口连续出现网络超时、429 或 5xx 时进入短暂冷却期，避免每首歌都白等超时。
 * 注意：HTTP 200 返回的业务错误文本（如 sign_error / 无版权）不计入熔断。
 */

export const RESOLVE_CACHE_MAX_ENTRIES = 150;
export const RESOLVE_CACHE_TTL_MS = 12 * 60 * 1000;
export const PROVIDER_COOLDOWN_MS = 30 * 1000;
export const PROVIDER_FAIL_THRESHOLD = 2;

/**
 * @typedef {Object} CachedResolvedPlay
 * @property {string} url
 * @property {string} channel
 * @property {string} [songMid]
 * @property {string} [quality]
 * @property {number} cachedAt
 * @property {number} expiresAt
 */

/** @type {Map<string, CachedResolvedPlay>} */
const _playCache = new Map();

/** @type {Map<string, { failures: number, cooldownUntil: number, lastError: string }>} */
const _providerHealth = new Map();

/**
 * 构造统一的取链缓存键。
 * @param {string} source
 * @param {string|number} id
 * @param {string} [quality='']
 * @returns {string}
 */
export function makeResolveCacheKey(source, id, quality = '') {
    const src = String(source || '').trim().toLowerCase();
    const sid = String(id ?? '').trim();
    if (!src || !sid) return '';
    const q = String(quality || '').trim().toLowerCase() || 'default';
    return `${src}:${sid}:${q}`;
}

/**
 * 读取未过期的已解析直链，并刷新其 LRU 位置。
 * @param {string} key
 * @param {number} [now=Date.now()]
 * @returns {CachedResolvedPlay | null}
 */
export function getCachedResolvedPlay(key, now = Date.now()) {
    const k = String(key || '').trim();
    if (!k) return null;
    const entry = _playCache.get(k);
    if (!entry) return null;
    if (now >= entry.expiresAt) {
        _playCache.delete(k);
        return null;
    }
    _playCache.delete(k);
    _playCache.set(k, entry);
    return { ...entry };
}

/**
 * 写入已解析直链，超过容量上限时淘汰最久未使用条目。
 * @param {string} key
 * @param {string | { url: string, channel?: string, songMid?: string, quality?: string }} value
 * @param {number} [ttlMs=RESOLVE_CACHE_TTL_MS]
 * @param {number} [now=Date.now()]
 * @returns {CachedResolvedPlay | null}
 */
export function setCachedResolvedPlay(key, value, ttlMs = RESOLVE_CACHE_TTL_MS, now = Date.now()) {
    const k = String(key || '').trim();
    const url = typeof value === 'string'
        ? value.trim()
        : String((value && value.url) || '').trim();
    if (!k || !url) return null;
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : RESOLVE_CACHE_TTL_MS;
    /** @type {{ channel?: string, songMid?: string, quality?: string }} */
    const extra = typeof value === 'object' && value ? value : {};
    /** @type {CachedResolvedPlay} */
    const entry = {
        ...extra,
        url,
        channel: String(extra.channel || ''),
        cachedAt: now,
        expiresAt: now + ttl,
    };
    if (_playCache.has(k)) {
        _playCache.delete(k);
    }
    _playCache.set(k, entry);
    while (_playCache.size > RESOLVE_CACHE_MAX_ENTRIES) {
        const oldestKey = _playCache.keys().next().value;
        if (oldestKey === undefined) break;
        _playCache.delete(oldestKey);
    }
    return { ...entry };
}

/**
 * 按精确键失效缓存条目（播放失败或重解析时调用）。
 * @param {string} key
 * @returns {boolean}
 */
export function invalidateCachedResolvedPlay(key) {
    const k = String(key || '').trim();
    if (!k) return false;
    return _playCache.delete(k);
}

/**
 * 按平台+标识或直链 URL 批量失效关联缓存条目。
 * @param {string} source
 * @param {string|number} [id='']
 * @param {string} [url='']
 * @returns {number}
 */
export function invalidateResolvedPlayByTrack(source, id = '', url = '') {
    const src = String(source || '').trim().toLowerCase();
    const sid = String(id ?? '').trim();
    const targetUrl = String(url || '').trim();
    const prefix = src && sid ? `${src}:${sid}:` : '';
    let removed = 0;
    for (const [k, entry] of Array.from(_playCache.entries())) {
        if ((prefix && k.startsWith(prefix)) || (targetUrl && entry && entry.url === targetUrl)) {
            _playCache.delete(k);
            removed += 1;
        }
    }
    return removed;
}

/**
 * 清空全部取链缓存。
 */
export function clearResolvedPlayCache() {
    _playCache.clear();
}

/**
 * 查询某公网上游是否正处于熔断冷却期。
 * 冷却期到期会自动重置计数，允许下一次试探。
 * @param {string} provider
 * @param {number} [now=Date.now()]
 * @returns {boolean}
 */
export function isProviderInCooldown(provider, now = Date.now()) {
    const p = String(provider || '').trim().toLowerCase();
    if (!p) return false;
    const st = _providerHealth.get(p);
    if (!st) return false;
    if (st.cooldownUntil > now) return true;
    if (st.cooldownUntil > 0 && now >= st.cooldownUntil) {
        _providerHealth.delete(p);
    }
    return false;
}

/**
 * 记录一次网络/超时/429/5xx 失败，连续达到阈值时触发冷却。
 * @param {string} provider
 * @param {string} [reason='']
 * @param {{ now?: number, threshold?: number, cooldownMs?: number }} [opts={}]
 * @returns {boolean} 是否已进入冷却期
 */
export function recordProviderFailure(provider, reason = '', opts = {}) {
    const p = String(provider || '').trim().toLowerCase();
    if (!p) return false;
    const now = Number.isFinite(opts.now) ? /** @type {number} */ (opts.now) : Date.now();
    const threshold = Number.isFinite(opts.threshold) && /** @type {number} */ (opts.threshold) > 0
        ? /** @type {number} */ (opts.threshold)
        : PROVIDER_FAIL_THRESHOLD;
    const cooldownMs = Number.isFinite(opts.cooldownMs) && /** @type {number} */ (opts.cooldownMs) > 0
        ? /** @type {number} */ (opts.cooldownMs)
        : PROVIDER_COOLDOWN_MS;
    const prev = _providerHealth.get(p);
    const cur = prev && (prev.cooldownUntil === 0 || now < prev.cooldownUntil)
        ? prev
        : { failures: 0, cooldownUntil: 0, lastError: '' };
    cur.failures += 1;
    cur.lastError = String(reason || '');
    if (cur.failures >= threshold) {
        cur.cooldownUntil = now + cooldownMs;
    }
    _providerHealth.set(p, cur);
    return cur.cooldownUntil > now;
}

/**
 * 上游请求成功响应时清除其失败计数与冷却状态。
 * @param {string} provider
 */
export function recordProviderSuccess(provider) {
    const p = String(provider || '').trim().toLowerCase();
    if (!p) return;
    _providerHealth.delete(p);
}

/**
 * 重置所有上游冷却状态（供测试与手动重试使用）。
 */
export function resetAllProviderCooldowns() {
    _providerHealth.clear();
}
