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
import { fetchQishuiLyric, qishuiLinesToKrc } from '../../web/src/services/musicApi.js';
import { isTrustworthyCrossMatch, normSongName } from '../../web/src/services/musicApi.js';
import { parseKrc } from '../../web/src/services/krcParser.js';

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

/* ==================== 汽水（QRC 逐字 → KRC 文本） ====================
 * 汽水只给每个字的**绝对起点**（timeMs），没有时长；转 KRC 时可以用相邻字/下一行
 * 推出来。这里钉的是三件容易写错的事：
 *   1) 相对偏移必须减去行起点（KRC 的 <a,b,0> 里 a 是行内相对值）；
 *   2) 任何字都不能是 0 时长——高亮进度会拿它当分母（除零 → NaN → 整行不亮）；
 *   3) 转出来的文本喂给真正的 parseKrc 必须能还原出绝对时间，否则渲染层会错位。
 */
test('qishuiLinesToKrc：相对偏移与逐字时长推算正确', () => {
    const krc = qishuiLinesToKrc([
        { timeMs: 1000, text: '甲乙', words: [{ timeMs: 1000, text: '甲' }, { timeMs: 1400, text: '乙' }] },
        { timeMs: 2000, text: '丙', words: [{ timeMs: 2000, text: '丙' }] },
    ]);
    assert.equal(krc, '[1000,1000]<0,400,0>甲<400,600,0>乙\n[2000,800]<0,800,0>丙');
    /* 行末字用下一行起点兜底（1400 → 2000）；末行没有下一行 → 固定 800ms */
});

test('qishuiLinesToKrc：缺 words 时退化为整行一个字，且时长永不为 0', () => {
    const krc = qishuiLinesToKrc([{ timeMs: 500, text: '整行' }]);
    assert.equal(krc, '[500,800]<0,800,0>整行');
    const parsed = parseKrc(krc);
    assert.equal(parsed.length, 1);
    assert.ok(parsed[0].words.every(w => w.duration > 0));
});

test('qishuiLinesToKrc：剥掉会破坏 KRC 标签语法的尖括号', () => {
    const krc = qishuiLinesToKrc([
        { timeMs: 0, text: '<a>', words: [{ timeMs: 0, text: '<a>' }] },
    ]);
    assert.ok(!krc.includes('<a>'), `不应残留裸标签: ${krc}`);
    assert.equal(parseKrc(krc)[0].original, 'a');
});

test('qishuiLinesToKrc → parseKrc：绝对时间与原文逐字还原', () => {
    const lines = [
        { timeMs: 1260, text: '灯火葳蕤', words: [
            { timeMs: 1260, text: '灯' }, { timeMs: 1500, text: '火' },
            { timeMs: 1740, text: '葳' }, { timeMs: 1980, text: '蕤' },
        ] },
        { timeMs: 2500, text: '揉皱你眼眉', words: [{ timeMs: 2500, text: '揉皱你眼眉' }] },
    ];
    const parsed = parseKrc(qishuiLinesToKrc(lines));
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].start, 1260);
    assert.equal(parsed[0].original, '灯火葳蕤');
    assert.deepEqual(parsed[0].words.map(w => w.start), [1260, 1500, 1740, 1980]);
    assert.equal(parsed[1].start, 2500);
    assert.equal(parsed[1].original, '揉皱你眼眉');
});

test('fetchQishuiLyric：解析 vendor 行式为逐字 parsedList', async () => {
    installMock([
        ['/api/selfhost/qishui/proxy', () => jsonRes({
            ok: true, type: 'word', lines: [
                { timeMs: 0, text: '作曲：银临', words: [{ timeMs: 0, text: '作曲：银临' }] },
                { timeMs: 1260, text: '灯火葳蕤', words: [{ timeMs: 1260, text: '灯火葳蕤' }] },
            ],
        })],
    ]);
    const r = await fetchQishuiLyric({ id: '7409943692154816531', source: 'qishui' });
    assert.ok(Array.isArray(r.parsedList) && r.parsedList.length === 2);
    assert.equal(r.source, 'qishui');
    assert.equal(r.parsedList[1].start, 1260);
    assert.ok(r.parsedList.every(l => l.words.every(w => w.duration > 0)));
});

test('fetchQishuiLyric：vendor 未就绪/无词时返回空对象（不抛）', async () => {
    installMock([['/api/selfhost/qishui/proxy', () => jsonRes({ ok: false, err: '副进程未运行' })]]);
    assert.deepEqual(await fetchQishuiLyric({ id: '1' }), {});
    installMock([['/api/selfhost/qishui/proxy', () => jsonRes({ ok: true, lines: [] })]]);
    assert.deepEqual(await fetchQishuiLyric({ id: '1' }), {});
    installMock([]);
    assert.deepEqual(await fetchQishuiLyric({ id: '' }), {});
});

/* ============================================================
 * 跨源候选可信度判据（2026-10-03 用户实测问题的回归钉）
 * 用户原话：「下一曲后竟然从网易云取链，并且显示是纯音乐（上一首刚刚还有歌词）」
 * 根因：跨源回退只查歌手名，网易/QQ 里「纯音乐 / 伴奏 / 钢琴版」这类**同歌手同歌名**
 *       的换皮版本会直接过关 → 拿一段没歌词的伴奏当原曲播。
 * 判据两段：① 归一化歌名对得上；② 原始标题不带换皮标记。
 * ============================================================ */

test('normSongName：去括号补充 / HTML 标记 / 空白，并小写', () => {
    assert.equal(normSongName('晴天'), '晴天');
    assert.equal(normSongName('晴天 (Live)'), '晴天');
    assert.equal(normSongName('《起风了》（伴奏）'), '《起风了》');
    assert.equal(normSongName('Hello [Remix]'), 'hello');
    assert.equal(normSongName('A<b>B</b> C'), 'abc');
    assert.equal(normSongName(null), '');
    assert.equal(normSongName(undefined), '');
});

test('isTrustworthyCrossMatch：同歌手同名的纯音乐/伴奏版必须被否掉', () => {
    const T = '晴天';
    // ① 换皮标记一律否决（歌名完全一致也不行）
    assert.equal(isTrustworthyCrossMatch({ song: '晴天', singer: '周杰伦' }, T), true);
    assert.equal(isTrustworthyCrossMatch({ song: '晴天（纯音乐）', singer: '周杰伦' }, T), false);
    assert.equal(isTrustworthyCrossMatch({ name: '晴天 官方伴奏', artist: '周杰伦' }, T), false);
    assert.equal(isTrustworthyCrossMatch({ name: '晴天', artist: '周杰伦 钢琴版' }, T), false);
    assert.equal(isTrustworthyCrossMatch({ song: '晴天 Instrumental', singer: 'Jay' }, T), false);
    assert.equal(isTrustworthyCrossMatch({ song: '晴天 Off Vocal', singer: 'Jay' }, T), false);
    assert.equal(isTrustworthyCrossMatch({ song: '晴天 试听', singer: 'Jay' }, T), false);
    assert.equal(isTrustworthyCrossMatch({ song: '晴天 无人声', singer: 'Jay' }, T), false);
    // 注：候选同时给 song 与 name 时按仓库既有优先级取 song（同 titleOf/artistOf 约定），
    //     故歌名/歌手都按「取到的那个字段」判；上面 name-only 的用例覆盖另一条通道。
    // ② 歌名对不上 → 否决
    assert.equal(isTrustworthyCrossMatch({ song: '七里香', singer: '周杰伦' }, T), false);
    // ③ 含/被含都算对得上（同一首的不同写法）
    assert.equal(isTrustworthyCrossMatch({ song: '晴天 (Live)', singer: '周杰伦' }, T), true);
    // ④ 候选歌名缺失时不额外否决（由调用方的歌手判定兜底）
    assert.equal(isTrustworthyCrossMatch({ singer: '周杰伦' }, T), true);
    // ⑤ 空候选
    assert.equal(isTrustworthyCrossMatch(null, T), false);
});
