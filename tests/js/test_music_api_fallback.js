/* ============================================================
 * tests/js/test_music_api_fallback.js — 跨源同名歌回退链单测
 * 运行方式：node --test tests/js/test_music_api_fallback.js
 *   （Node ≥ 22 内置 test runner；mock 全局 fetch，零真实网络）
 * 覆盖：fetchSameSongUrlFrom 酷狗/网易双分支——
 *   双匹配优先 / 歌手精确优先 / DJ版等垃圾候选过滤 / stripEm 清洗关键词 /
 *   byfuns 音质阶梯升级 / 全败回退网易外链 / 搜索失败与无直链返回 null
 * 说明：酷狗 JSONP 在 Node 下必然 reject，故自动走 mobilecdn 代理兜底通道；
 *       mock fetch 对代理候选端点(相对 /proxy、127.0.0.1:8xxx)返回不 OK，
 *       proxyFetch 遂落到目标直连端点，由下面按 URL 子串路由的 handler 接管。
 * ============================================================ */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { fetchSameSongUrlFrom } from '../../web/src/services/musicApi.js';

const realFetch = globalThis.fetch;

/* 编程式 mock fetch：按 URL 子串命中最先注册的 handler；未命中视为"连不上" */
function installMock(routes) {
    const calls = [];
    globalThis.fetch = async (input) => {
        const url = String(input);
        calls.push(url);
        for (const [needle, handler] of routes) {
            if (url.includes(needle)) return handler(url);
        }
        return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
    };
    return calls;
}

const jsonRes = (body, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => body, text: async () => JSON.stringify(body) });
const textRes = (text) => ({ ok: true, status: 200, json: async () => ({}), text: async () => text });

/* 酷狗 two-stage：先是 mobilecdn 搜索(代理兜底)，再是 getSongInfo 取直链 */
function kugouRoutes(info, playUrl) {
    return [
        ['mobilecdn.kugou.com/api/v3/search/song', () => jsonRes({ data: { info } })],
        ['m.kugou.com/app/i/getSongInfo.php', () => jsonRes(playUrl == null ? {} : { url: playUrl })]
    ];
}

beforeEach(() => { globalThis.fetch = realFetch; });
afterEach(() => { globalThis.fetch = realFetch; });

/* ==================== 酷狗分支 ==================== */

test('酷狗：双匹配(歌名+歌手)优先于仅歌名', async () => {
    const calls = installMock(kugouRoutes([
        { songname: '雾里看花', singername: '王二', hash: 'HASH1' },
        { songname: '雾里看花', singername: '张三', hash: 'HASH2' }
    ], 'http://music.example.com/kg.mp3'));
    const r = await fetchSameSongUrlFrom('kugou', '雾里看花', '张三');
    assert.equal(r.url, 'http://music.example.com/kg.mp3');
    const direct = calls.find(u => u.includes('getSongInfo.php'));
    assert.ok(direct.includes('HASH2'), `应取歌手精确匹配的 HASH2，实际 ${direct}`);
});

test('酷狗：无歌手匹配时回退到第一条', async () => {
    const calls = installMock(kugouRoutes([
        { songname: '雾里看花', singername: '王二', hash: 'HASH1' },
        { songname: '雾里看花', singername: '张三', hash: 'HASH2' }
    ], 'http://music.example.com/kg.mp3'));
    const r = await fetchSameSongUrlFrom('kugou', '雾里看花', '李四');
    assert.equal(r.url, 'http://music.example.com/kg.mp3');
    const direct = calls.find(u => u.includes('getSongInfo.php'));
    assert.ok(direct.includes('HASH1'), `应回退到 HASH1，实际 ${direct}`);
});

test('酷狗：原始歌名无垃圾标记时过滤 DJ版/Cover 候选', async () => {
    const calls = installMock(kugouRoutes([
        { songname: '雾里看花 (DJ版)', singername: '张三', hash: 'HASH_DJ' },
        { songname: '雾里看花', singername: '王二', hash: 'HASH_CLEAN' }
    ], 'http://music.example.com/kg.mp3'));
    const r = await fetchSameSongUrlFrom('kugou', '雾里看花', '王二');
    assert.equal(r.url, 'http://music.example.com/kg.mp3');
    const direct = calls.find(u => u.includes('getSongInfo.php'));
    assert.ok(direct.includes('HASH_CLEAN'), `应过滤垃圾候选取 HASH_CLEAN，实际 ${direct}`);
});

test('酷狗：getSongInfo 无直链(疑似VIP)时返回 null', async () => {
    installMock(kugouRoutes([{ songname: '雾里看花', singername: '张三', hash: 'HASH1' }], null));
    const r = await fetchSameSongUrlFrom('kugou', '雾里看花', '张三');
    assert.equal(r, null);
});

test('酷狗：搜索为空列表时返回 null 且不抛异常', async () => {
    installMock(kugouRoutes([], 'http://music.example.com/kg.mp3'));
    const r = await fetchSameSongUrlFrom('kugou', '雾里看花', '张三');
    assert.equal(r, null);
});

/* ==================== 网易云分支 ==================== */

test('网易：stripEm 清洗关键词（emoji/符号去除后再编码进 word 参数）', async () => {
    const calls = installMock([
        ['/netease?word=', () => jsonRes({ code: 200, data: [{ song: '雾里看花', singer: '张三', id: 1 }] })],
        ['api.byfuns.top/1/', () => textRes('http://music.example.com/ne.mp3')]
    ]);
    await fetchSameSongUrlFrom('netease', '雾🌫里看花♥', '张(三)');
    const search = calls.find(u => u.includes('/netease?word='));
    assert.ok(search.includes('word=%E9%9B%BE%E9%87%8C%E7%9C%8B%E8%8A%B1'), `word 应为"雾里看花"的编码: ${search}`);
    assert.ok(!search.includes('%F3'), 'word 不应含被清洗的 emoji 编码');
});

test('网易：歌手精确匹配优先于首位候选', async () => {
    const calls = installMock([
        ['/netease?word=', () => jsonRes({
            code: 200,
            data: [
                { song: '雾里看花', singer: '合唱团', id: 11 },
                { song: '雾里看花', singer: '张三', id: 22 }
            ]
        })],
        ['api.byfuns.top/1/', () => textRes('http://music.example.com/ne.mp3')]
    ]);
    const r = await fetchSameSongUrlFrom('netease', '雾里看花', '张三');
    assert.equal(r.url, 'http://music.example.com/ne.mp3');
    assert.equal(r.id, '22');
    const byfuns = calls.find(u => u.includes('byfuns'));
    assert.ok(byfuns.includes('id=22'), `应上报精确匹配 id=22，实际 ${byfuns}`);
});

test('网易：byfuns 音质阶梯 exhigh→lossless→higher 逐级升级', async () => {
    const calls = installMock([
        ['/netease?word=', () => jsonRes({ code: 200, data: [{ song: '雾里看花', singer: '张三', id: 7 }] })],
        ['api.byfuns.top/1/', (url) => textRes(url.includes('level=higher') ? 'http://music.example.com/ne.mp3' : 'sign_error')]
    ]);
    const r = await fetchSameSongUrlFrom('netease', '雾里看花', '张三');
    assert.equal(r.url, 'http://music.example.com/ne.mp3');
    const byfunsLevels = calls.filter(u => u.includes('byfuns')).map(u => /level=(\w+)/.exec(u)[1]);
    assert.deepEqual(byfunsLevels, ['exhigh', 'lossless', 'higher'], '应按 exhigh→lossless→higher 顺序请求');
});

test('网易：byfuns 全败时回退网易官方外链', async () => {
    installMock([
        ['/netease?word=', () => jsonRes({ code: 200, data: [{ song: '雾里看花', singer: '张三', id: 9 }] })],
        ['api.byfuns.top/1/', () => textRes('error')]
    ]);
    const r = await fetchSameSongUrlFrom('netease', '雾里看花', '张三');
    assert.equal(r.url, 'https://music.163.com/song/media/outer/url?id=9');
    assert.equal(r.id, '9');
});

test('网易：搜索接口返回非 200 时返回 null', async () => {
    installMock([
        ['/netease?word=', () => jsonRes({ code: 500 }, false)],
        ['api.byfuns.top/1/', () => textRes('http://music.example.com/ne.mp3')]
    ]);
    const r = await fetchSameSongUrlFrom('netease', '雾里看花', '张三');
    assert.equal(r, null);
});

test('未知音源与空标题直接返回 null', async () => {
    installMock([]);
    assert.equal(await fetchSameSongUrlFrom('migu', '雾里看花', '张三'), null);
    assert.equal(await fetchSameSongUrlFrom('netease', '', '张三'), null);
    assert.equal(await fetchSameSongUrlFrom('netease', '   ', '张三'), null);
});