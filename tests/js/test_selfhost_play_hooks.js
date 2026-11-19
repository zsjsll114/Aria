/* ============================================================
 * tests/js/test_selfhost_play_hooks.js — 自建取链优先级与来源归因单测
 *
 * 验证：
 * 1) fetchSameSongUrlFrom('netease', ...) 优先走 selfhostPlayHooks.netease 并标 provider='selfhostNetease'；
 *    仅自建失败时才落到 byfuns -> neteaseOuter；
 * 2) getKugouPlayInfo 在酷狗直链失败时依次尝试 QQ/网易自建，标 'selfhostQQ' / 'selfhostNetease'；
 * 3) getKuwoPlayInfo 在直链失败时优先走 selfhostPlayHooks.qq，先于 qqResolveUrl / vkeys，标 'selfhostQQ'；
 * 4) kuwo 直链路径显式携带 provider='kuwo'。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getKuwoPlayInfo, getKugouPlayInfo, fetchSameSongUrlFrom } from '../../web/src/services/musicApi.js';
import { registerSelfhostPlayHooks, resetSelfhostPlayHooks } from '../../web/src/services/selfhostPlayHooks.js';

function jsonResp(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function textResp(txt, status = 200) {
    return new Response(String(txt), {
        status,
        headers: { 'Content-Type': 'text/plain' },
    });
}

test('fetchSameSongUrlFrom(netease) 优先调用 selfhostNetease 并标记真实来源，失败后再走 byfuns/外链', async (t) => {
    const prevFetch = globalThis.fetch;
    t.after(() => {
        globalThis.fetch = prevFetch;
        resetSelfhostPlayHooks();
    });

    const called = [];
    globalThis.fetch = async (url) => {
        const u = String(url);
        called.push(u);
        if (u.includes('vkeys.cn/v2/music/netease')) {
            return jsonResp({
                code: 200,
                data: [{ id: 199999, song: '晴天', singer: '周杰伦', cover: 'https://img/ncm.jpg' }],
            });
        }
        if (u.includes('api.byfuns.top')) {
            return textResp('https://byfuns.example.com/199999.mp3');
        }
        return jsonResp({ code: 404 }, 404);
    };

    registerSelfhostPlayHooks({
        netease: async (id) => `https://selfhost.ncm.local/stream/${id}.flac`,
    });

    const hitSelfhost = await fetchSameSongUrlFrom('netease', '晴天', '周杰伦');
    assert.deepEqual(hitSelfhost, {
        url: 'https://selfhost.ncm.local/stream/199999.flac',
        cover: 'https://img/ncm.jpg',
        id: '199999',
        provider: 'selfhostNetease',
    });
    assert.ok(!called.some((u) => u.includes('byfuns')), '自建命中时不得继续请求 byfuns');

    called.length = 0;
    registerSelfhostPlayHooks({ netease: async () => null });
    const fallbackByfuns = await fetchSameSongUrlFrom('netease', '晴天', '周杰伦');
    assert.equal(fallbackByfuns.provider, 'byfuns');
    assert.equal(fallbackByfuns.url, 'https://byfuns.example.com/199999.mp3');
});

test('getKugouPlayInfo 酷狗官方失败后优先尝试 QQ / 网易自建并标注真实 provider', async (t) => {
    const prevFetch = globalThis.fetch;
    t.after(() => {
        globalThis.fetch = prevFetch;
        resetSelfhostPlayHooks();
    });

    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes('m.kugou.com/app/i/getSongInfo.php')) {
            return jsonResp({ errcode: 1, url: '' });
        }
        if (u.includes('vkeys.cn/v2/music/tencent?word=')) {
            return jsonResp({
                code: 200,
                data: [{ mid: '00QQMID1', song: '晴天', singer: '周杰伦', interval: '04:29', cover: 'https://img/qq.jpg' }],
            });
        }
        if (u.includes('vkeys.cn/v2/music/netease')) {
            return jsonResp({
                code: 200,
                data: [{ id: 288888, song: '晴天', singer: '周杰伦', cover: 'https://img/ncm2.jpg' }],
            });
        }
        return jsonResp({ code: 404 }, 404);
    };

    registerSelfhostPlayHooks({
        qq: async (mid) => `https://selfhost.qq.local/${mid}.m4a`,
        netease: async () => null,
    });
    const resQQ = await getKugouPlayInfo('HASH1', '晴天', '周杰伦');
    assert.equal(resQQ.provider, 'selfhostQQ');
    assert.equal(resQQ.url, 'https://selfhost.qq.local/00QQMID1.m4a');

    registerSelfhostPlayHooks({
        qq: async () => null,
        netease: async (id) => `https://selfhost.ncm.local/${id}.mp3`,
    });
    const resNcm = await getKugouPlayInfo('HASH2', '晴天', '周杰伦');
    assert.equal(resNcm.provider, 'selfhostNetease');
    assert.equal(resNcm.url, 'https://selfhost.ncm.local/288888.mp3');
});

test('getKuwoPlayInfo 直链失败后优先走 QQ 自建先于 qqResolve/vkeys，直链成功则标 kuwo', async (t) => {
    const prevFetch = globalThis.fetch;
    t.after(() => {
        globalThis.fetch = prevFetch;
        resetSelfhostPlayHooks();
    });

    const called = [];
    globalThis.fetch = async (url) => {
        const u = String(url);
        called.push(u);
        if (u.includes('/api/kuwo/detail')) {
            return jsonResp({ ok: false, data: null });
        }
        if (u.includes('api.bugpk.com/api/kuwo')) {
            return jsonResp({ code: 404 });
        }
        if (u.includes('vkeys.cn/v2/music/tencent?word=')) {
            return jsonResp({
                code: 200,
                data: [{ mid: '00KWMID', song: '七里香', singer: '周杰伦', cover: 'https://img/kwqq.jpg' }],
            });
        }
        return jsonResp({ code: 404 }, 404);
    };

    registerSelfhostPlayHooks({
        qq: async (mid) => `https://selfhost.qq.local/kw/${mid}.flac`,
    });
    const shHit = await getKuwoPlayInfo('998877', '七里香', '周杰伦');
    assert.equal(shHit.provider, 'selfhostQQ');
    assert.equal(shHit.url, 'https://selfhost.qq.local/kw/00KWMID.flac');
    assert.ok(!called.some((u) => u.includes('/api/qq/resolve')), 'QQ 自建命中时不得再走公网 qqResolve');

    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes('/api/kuwo/detail')) {
            return jsonResp({ ok: true, url: 'https://kuwo.cdn/998877.mp3', cover: 'https://kuwo.cdn/998877.jpg' });
        }
        return jsonResp({ code: 404 }, 404);
    };
    const kwHit = await getKuwoPlayInfo('998877', '七里香', '周杰伦');
    assert.equal(kwHit.provider, 'kuwo');
    assert.equal(kwHit.url, 'https://kuwo.cdn/998877.mp3');
});
