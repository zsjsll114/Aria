/**
 * @fileoverview 回归测试：取链 LRU+TTL 缓存、上游熔断冷却、/api/qq/mid 补全、
 * selfhost 启动期短轮询等待与 QQ_QUALITY_LADDER 高阶音质映射。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    RESOLVE_CACHE_MAX_ENTRIES,
    RESOLVE_CACHE_TTL_MS,
    PROVIDER_COOLDOWN_MS,
    makeResolveCacheKey,
    getCachedResolvedPlay,
    setCachedResolvedPlay,
    invalidateCachedResolvedPlay,
    invalidateResolvedPlayByTrack,
    clearResolvedPlayCache,
    isProviderInCooldown,
    recordProviderFailure,
    recordProviderSuccess,
    resetAllProviderCooldowns,
} from '../../web/src/core/resolveCache.js';

import { fetchQQSongMid, fetchSameSongUrlFrom } from '../../web/src/services/musicApi.js';
import { selfhostNeteasePlayUrl, selfhostQQPlayUrl } from '../../web/src/app/selfhost-runtime.js';

test('resolveCache: 键规范化、TTL 过期与 LRU 淘汰保护最近命中项', () => {
    clearResolvedPlayCache();
    assert.equal(makeResolveCacheKey('QQ', 123, 'FLAC'), 'qq:123:flac');
    assert.equal(makeResolveCacheKey('netease', '456'), 'netease:456:default');
    assert.equal(makeResolveCacheKey('', '456'), '');

    const t0 = 1_000_000;
    const k1 = makeResolveCacheKey('tencent', 'mid1', '320');
    setCachedResolvedPlay(k1, { url: 'https://cdn.example/1.mp3', channel: 'selfhostQQ', songMid: 'mid1', quality: '320' }, RESOLVE_CACHE_TTL_MS, t0);
    assert.equal(getCachedResolvedPlay(k1, t0 + 5000)?.url, 'https://cdn.example/1.mp3');
    assert.equal(getCachedResolvedPlay(k1, t0 + RESOLVE_CACHE_TTL_MS), null);

    /* LRU 淘汰：第 0 项被读取续命，再灌满超过上限，应先淘汰第 1 项 */
    clearResolvedPlayCache();
    const keys = [];
    for (let i = 0; i < RESOLVE_CACHE_MAX_ENTRIES; i++) {
        const k = makeResolveCacheKey('netease', `id_${i}`, 'exhigh');
        keys.push(k);
        setCachedResolvedPlay(k, { url: `https://cdn.example/${i}.mp3`, channel: 'selfhostNetease' }, 60_000, t0);
    }
    assert.ok(getCachedResolvedPlay(keys[0], t0 + 10));
    setCachedResolvedPlay(makeResolveCacheKey('netease', 'overflow', 'exhigh'), 'https://cdn.example/over.mp3', 60_000, t0 + 20);
    assert.ok(getCachedResolvedPlay(keys[0], t0 + 30), '被访问过的最老条目不应先淘汰');
    assert.equal(getCachedResolvedPlay(keys[1], t0 + 30), null, '未访问的最久条目应被淘汰');

    assert.equal(invalidateCachedResolvedPlay(keys[0]), true);
    assert.equal(invalidateResolvedPlayByTrack('netease', 'overflow'), 1);
    clearResolvedPlayCache();
});

test('providerCooldown: 两次连续传输失败熔断，HTTP 200 文本错误不触发熔断', async () => {
    resetAllProviderCooldowns();
    const t0 = 5_000_000;
    assert.equal(recordProviderFailure('byfuns', 'timeout', { now: t0 }), false);
    assert.equal(isProviderInCooldown('byfuns', t0 + 100), false);
    assert.equal(recordProviderFailure('byfuns', 'timeout', { now: t0 + 200 }), true);
    assert.equal(isProviderInCooldown('byfuns', t0 + 1000), true);
    assert.equal(isProviderInCooldown('byfuns', t0 + 200 + PROVIDER_COOLDOWN_MS), false);

    recordProviderFailure('byfuns', 'timeout', { now: t0 });
    recordProviderSuccess('byfuns');
    assert.equal(recordProviderFailure('byfuns', 'timeout', { now: t0 + 10 }), false);

    const origFetch = globalThis.fetch;
    try {
        resetAllProviderCooldowns();
        const byfunsHits = [];
        globalThis.fetch = async (url) => {
            const s = String(url);
            if (s.includes('/netease?word=')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ code: 200, data: [{ id: 888, song: '晴天', singer: '周杰伦' }] }),
                };
            }
            if (s.includes('api.byfuns.top')) {
                byfunsHits.push(s);
                /* 模拟网络异常（前两次失败即熔断，不再打第 3/4 档） */
                throw new Error('ECONNRESET');
            }
            throw new Error(`Unexpected fetch: ${s}`);
        };
        const hit1 = await fetchSameSongUrlFrom('netease', '晴天', '周杰伦');
        assert.equal(hit1?.provider, 'neteaseOuter');
        assert.equal(byfunsHits.length, 2, '连续 2 次网络失败应熔断并跳过剩余音质档');

        /* 冷却期间再次调用应完全跳过 byfuns */
        const hit2 = await fetchSameSongUrlFrom('netease', '晴天', '周杰伦');
        assert.equal(hit2?.provider, 'neteaseOuter');
        assert.equal(byfunsHits.length, 2, '冷却期内不得再打 byfuns');

        /* HTTP 200 业务错误（如 sign_error / error）不得触发熔断 */
        resetAllProviderCooldowns();
        const textErrHits = [];
        globalThis.fetch = async (url) => {
            const s = String(url);
            if (s.includes('/netease?word=')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ code: 200, data: [{ id: 889, song: '七里香', singer: '周杰伦' }] }),
                };
            }
            if (s.includes('api.byfuns.top')) {
                textErrHits.push(s);
                return { ok: true, status: 200, text: async () => 'sign_error' };
            }
            throw new Error(`Unexpected fetch: ${s}`);
        };
        const hit3 = await fetchSameSongUrlFrom('netease', '七里香', '周杰伦');
        assert.equal(hit3?.provider, 'neteaseOuter');
        assert.equal(textErrHits.length, 4, 'HTTP 200 文本错误必须完整跑完 4 档');
        assert.equal(isProviderInCooldown('byfuns'), false);
    } finally {
        globalThis.fetch = origFetch;
        resetAllProviderCooldowns();
    }
});

test('selfhost startup wait + QQ quality ladder + /api/qq/mid + NetEase time 检查', async () => {
    const origFetch = globalThis.fetch;
    try {
        /* Case 1: starting=true 短轮询后变为 alive=true -> 不再被 5s 缓存锁死 */
        let statusPolls = 0;
        const ncmCalls = [];
        globalThis.fetch = async (url) => {
            const s = String(url);
            if (s === '/api/selfhost/status') {
                statusPolls += 1;
                if (statusPolls === 1) {
                    return { ok: true, json: async () => ({ qq: { alive: true, loggedIn: true }, netease: { alive: false, starting: true } }) };
                }
                return { ok: true, json: async () => ({ qq: { alive: true, loggedIn: true }, netease: { alive: true, starting: false } }) };
            }
            if (s.includes('/api/selfhost/netease/proxy')) {
                ncmCalls.push(decodeURIComponent(s));
                if (decodeURIComponent(s).includes('level=exhigh')) {
                    /* time=30000ms 明显短于期望 200s (< 200*450)，应视为试听链继续下探 */
                    return { ok: true, status: 200, json: async () => ({ data: [{ url: 'https://ncm.example/preview.mp3', time: 30000 }] }) };
                }
                return { ok: true, status: 200, json: async () => ({ data: [{ url: 'https://ncm.example/full.mp3', time: 200000 }] }) };
            }
            throw new Error(`Unexpected fetch: ${s}`);
        };
        const ncmUrl = await selfhostNeteasePlayUrl('1001', 'exhigh', null, { expSec: 200 });
        assert.equal(ncmUrl, 'https://ncm.example/full.mp3');
        assert.equal(statusPolls, 2);
        assert.equal(ncmCalls.length, 2);

        /* Case 2: QQ master/atmos/hires 映射为 ['flac','320','128'] 且从 flac 降到 320 */
        const qqQualities = [];
        globalThis.fetch = async (url) => {
            const s = String(url);
            if (s === '/api/selfhost/status') {
                return { ok: true, json: async () => ({ qq: { alive: true, loggedIn: true } }) };
            }
            if (s.includes('/api/selfhost/qq/proxy')) {
                const decoded = decodeURIComponent(s);
                const m = decoded.match(/quality=([^&]+)/);
                if (m) qqQualities.push(m[1]);
                if (decoded.includes('quality=320')) {
                    return { ok: true, json: async () => ({ playUrl: { '001mid': { url: 'https://qq.example/320.mp3' } } }) };
                }
                return { ok: true, json: async () => ({ playUrl: {} }) };
            }
            throw new Error(`Unexpected fetch: ${s}`);
        };
        const qqUrl = await selfhostQQPlayUrl('001mid', 'master');
        assert.equal(qqUrl, 'https://qq.example/320.mp3');
        assert.deepEqual(qqQualities, ['flac', '320']);

        /* Case 3: fetchQQSongMid 轻接口与非数字入参保护 */
        let midFetches = 0;
        globalThis.fetch = async (url) => {
            midFetches += 1;
            assert.equal(url, '/api/qq/mid?id=97773');
            return { ok: true, json: async () => ({ ok: true, mid: '0039MnYb0qxYhV' }) };
        };
        assert.equal(await fetchQQSongMid(''), '');
        assert.equal(await fetchQQSongMid('abc'), '');
        assert.equal(midFetches, 0);
        assert.equal(await fetchQQSongMid('97773'), '0039MnYb0qxYhV');
        assert.equal(midFetches, 1);
    } finally {
        globalThis.fetch = origFetch;
    }
});
