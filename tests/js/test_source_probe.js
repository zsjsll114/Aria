/* ============================================================
 * tests/js/test_source_probe.js — 音源探测（core/sourceProbe.js）
 *
 * 真实网络不参与：stub globalThis.fetch，逐条钉住判定分支 ——
 *   成功 / 连接被拒 / 超时 / 同源 JSON 汇总 / no-cors opaque / probeAll 顺序。
 * ============================================================ */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { probeOne, probeAll, SOURCE_PROBES } from '../../web/src/core/sourceProbe.js';

const realFetch = globalThis.fetch;
beforeEach(() => { delete globalThis.fetch; });
afterEach(() => { globalThis.fetch = realFetch; });

test('成功：ok=true 且有毫秒延迟', async () => {
    globalThis.fetch = async () => ({ type: 'opaque', status: 0 });
    const r = await probeOne({ id: 'qq', label: 'QQ 音乐', url: 'http://127.0.0.1:3200/' }, 1000);
    assert.equal(r.ok, true);
    assert.equal(r.id, 'qq');
    assert.ok(Number.isFinite(r.ms) && r.ms >= 0, `ms 应为数字，实=${r.ms}`);
    assert.equal(r.status, null, 'opaque 响应没有可读 status');
});

test('连接被拒：ok=false 且标记 unreachable', async () => {
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    const r = await probeOne({ id: 'kugou', label: '酷狗音乐', url: 'http://127.0.0.1:3100/' }, 1000);
    assert.equal(r.ok, false);
    assert.equal(r.info, 'unreachable');
});

test('超时：中止后标记 timeout', async () => {
    globalThis.fetch = (url, opts) => new Promise((_res, rej) => {
        if (opts && opts.signal) {
            opts.signal.addEventListener('abort', () => {
                const e = new Error('aborted');
                e.name = 'AbortError';
                rej(e);
            });
        }
    });
    const r = await probeOne({ id: 'netease', label: '网易云音乐', url: 'http://127.0.0.1:3201/' }, 30);
    assert.equal(r.ok, false);
    assert.equal(r.info, 'timeout');
});

test('同源目标：成功时解析 JSON 汇总副进程状态', async () => {
    globalThis.fetch = async () => ({
        type: 'basic',
        status: 200,
        json: async () => ({
            qq: { alive: true, loggedIn: true },
            kugou: { alive: true, loggedIn: false },
            netease: { alive: false },
        }),
    });
    const r = await probeOne({ id: 'server', label: '本机主服务', url: '/api/selfhost/status', sameOrigin: true }, 1000);
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.match(r.info, /qq:login/);
    assert.match(r.info, /kugou:ok/);
    assert.match(r.info, /netease:off/);
});

test('同源目标 JSON 坏掉也不影响连通判定', async () => {
    globalThis.fetch = async () => ({
        type: 'basic',
        status: 200,
        json: async () => { throw new SyntaxError('bad json'); },
    });
    const r = await probeOne({ id: 'server', label: '本机主服务', url: '/api/selfhost/status', sameOrigin: true }, 1000);
    assert.equal(r.ok, true);
    assert.equal(r.info, '');
});

test('probeAll 保持顺序与数量，单项失败不影响其它项', async () => {
    let n = 0;
    globalThis.fetch = async (url) => {
        n++;
        if (String(url).includes('3100')) throw new TypeError('Failed to fetch');
        return { type: 'opaque', status: 0 };
    };
    const list = [
        { id: 'a', label: 'A', url: 'http://127.0.0.1:3200/' },
        { id: 'b', label: 'B', url: 'http://127.0.0.1:3100/' },
        { id: 'c', label: 'C', url: 'http://127.0.0.1:3201/' },
    ];
    const res = await probeAll(list, 1000);
    assert.equal(res.length, 3);
    assert.deepEqual(res.map((r) => r.id), ['a', 'b', 'c'], '顺序必须与传入一致');
    assert.equal(res[0].ok, true);
    assert.equal(res[1].ok, false);
    assert.equal(res[2].ok, true);
    assert.equal(n, 3);
});

test('默认目标表结构合法（id/label/url 齐全、id 不重复）', () => {
    assert.ok(SOURCE_PROBES.length >= 5);
    const ids = new Set();
    for (const p of SOURCE_PROBES) {
        assert.ok(p.id && p.label && p.url, `探测项缺字段：${JSON.stringify(p)}`);
        assert.equal(ids.has(p.id), false, `id 重复：${p.id}`);
        ids.add(p.id);
    }
    /* 本机主服务必须是同源项，否则读不到 status JSON */
    const server = SOURCE_PROBES.find((p) => p.id === 'server');
    assert.equal(server.sameOrigin, true);
});

test('没有 fetch 可用时安全返回失败（不抛）', async () => {
    const r = await probeOne({ id: 'x', label: 'X', url: 'http://x/' }, 100);
    assert.equal(r.ok, false);
});
