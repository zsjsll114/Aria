/* selfhost-runtime.js —— 网易云自建取链的音质阶梯与**试听链拒绝**（2026-10-07）

用户报障：「都登录了、都是 VIP，网易云却只有 30 秒试听」。
根因：旧实现只看"有没有 http url"，而 /song/url/v1 对无该音质权益的曲目会回
`{url: 30秒试听链, freeTrialInfo:{...}}` —— 试听链被当成正常直链一路用到播放器。
这组用例把三条不变量钉死：
  1. 试听链（freeTrialInfo 非空）**绝不返回**，必须继续降级；
  2. 降到能拿到整曲的那一档就用它（并保留"降级"这一事实可观测）；
  3. 全档都是试听 / 副进程离线 → 返回 null（交棒公网阶梯，那条有自己的时长探测）。
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { selfhostNeteasePlayUrl, fetchStatus } from '../../web/src/app/selfhost-runtime.js';

const realFetch = globalThis.fetch;

function installStub(routes, { alive = true } = {}) {
    const calls = [];
    globalThis.fetch = async (url) => {
        const u = String(url);
        calls.push(u);
        if (u.includes('/api/selfhost/status')) {
            return { ok: true, status: 200, json: async () => ({ netease: { alive } }) };
        }
        const dec = decodeURIComponent(u);   /* proxy 的 path 参数是编码过的 */
        for (const [key, body] of Object.entries(routes)) {
            if (dec.includes(key)) return { ok: true, status: 200, json: async () => body };
        }
        return { ok: false, status: 404, json: async () => ({ error: 'no-route' }) };
    };
    return calls;
}

test('TC1 ★ 试听链绝不当直链用：hires 给试听 → 降到 exhigh 拿整曲', async () => {
    const calls = installStub({
        'level=hires': { data: [{ url: 'http://trial.example/30s.mp3', freeTrialInfo: { start: 0, end: 30 } }] },
        'level=lossless': { data: [{ url: null }] },
        'level=exhigh': { data: [{ url: 'http://full.example/full.mp3', level: 'exhigh' }] },
    });
    await fetchStatus(true);
    const url = await selfhostNeteasePlayUrl(123, 'hires');
    assert.equal(url, 'http://full.example/full.mp3', '必须拿到整曲，不能是试听链');
    assert.ok(!String(url).includes('trial'), '绝不能返回试听链');
    const dec = calls.map(decodeURIComponent).join(' | ');
    assert.ok(dec.includes('level=hires') && dec.includes('level=lossless') && dec.includes('level=exhigh'),
        '应当按阶梯依次下探：' + dec);
});

test('TC2 全档都是试听 → 返回 null（交棒公网阶梯，而不是拿试听充数）', async () => {
    installStub({
        'level=hires': { data: [{ url: 'http://t.example/a.mp3', freeTrialInfo: { end: 30 } }] },
        'level=lossless': { data: [{ url: 'http://t.example/b.mp3', freeTrialInfo: { end: 30 } }] },
        'level=exhigh': { data: [{ url: 'http://t.example/c.mp3', freeTrialInfo: { end: 30 } }] },
        'level=higher': { data: [{ url: 'http://t.example/d.mp3', freeTrialInfo: { end: 30 } }] },
        'level=standard': { data: [{ url: 'http://t.example/e.mp3', freeTrialInfo: { end: 30 } }] },
    });
    await fetchStatus(true);
    assert.equal(await selfhostNeteasePlayUrl(456, 'hires'), null);
});

test('TC3 副进程离线 → 不发起任何取链请求', async () => {
    const calls = installStub({}, { alive: false });
    await fetchStatus(true);
    assert.equal(await selfhostNeteasePlayUrl(789, 'exhigh'), null);
    assert.ok(!calls.some((u) => decodeURIComponent(u).includes('level=')), '离线时不该去取链');
});

test('TC4 目标是标准音质且直接可用 → 一次命中，不做多余降级', async () => {
    const calls = installStub({ 'level=standard': { data: [{ url: 'http://full.example/std.mp3' }] } });
    await fetchStatus(true);
    assert.equal(await selfhostNeteasePlayUrl(1, 'standard'), 'http://full.example/std.mp3');
    const dec = calls.map(decodeURIComponent).filter((u) => u.includes('level='));
    assert.equal(dec.length, 1, '不该多试别的档：' + dec.join(' | '));
});

test.after(() => { globalThis.fetch = realFetch; });
