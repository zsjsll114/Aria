/* ============================================================
 * tests/js/test_lyric_index.js — services/lyricIndex.js 行为回归（歌词内搜索 todos #2）
 *
 * 覆盖：中文子串匹配（含标点/空格/大小写无关 + 高亮位置换算回原文）、
 * 排序（命中次数优先、来源权重次之）、增量计划（put/fetch/prune/冷却）、
 * 去重（同一首歌跨收藏/歌单/最近只一篇文档、只出一行一次）、无命中，
 * 以及 IDB 存储管线（用内存 store 驱动同一套异步代码）。
 *
 * 手法：不碰 DOM、不碰真 IndexedDB。lyricIndex 的存储层是一个 7 方法的窄接口
 * （ping/all/putMany/delMany/clear/getMeta/setMeta），测试用 Map 实现同一个接口
 * 注进去，于是 loadIndex/putDocs/removeDocs 走的异步分支与浏览器一致；
 * 真正的 IDB 事务语义（req.onsuccess 那一层）不在本文件覆盖范围内。
 * ============================================================ */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    matchLine,
    normParts,
    normText,
    normalizeTerms,
    buildDoc,
    buildEmptyDoc,
    mergeDesired,
    planSync,
    searchLyric,
    sigOf,
    songKeyOf,
    toIndexLines,
    weightOf,
    useStore,
    loadIndex,
    putDocs,
    removeDocs,
    clearIndex,
    getCachedDocs,
    getDoc,
    search,
    indexStats,
    loadError,
    probeStore,
} from '../../web/src/services/lyricIndex.js';

/* ---------- 内存 store ---------- */
function memoryStore(seed = []) {
    const rows = new Map();
    const meta = new Map();
    for (const r of seed) rows.set(r.key, JSON.parse(JSON.stringify(r)));
    return {
        rows, meta,
        async ping() { return true; },
        async all() { return [...rows.values()].map(r => JSON.parse(JSON.stringify(r))); },
        async putMany(docs) { for (const d of docs) rows.set(d.key, JSON.parse(JSON.stringify(d))); },
        async delMany(keys) { for (const k of keys) rows.delete(k); },
        async clear() { rows.clear(); },
        async getMeta(k) { return meta.has(k) ? meta.get(k) : null; },
        async setMeta(k, v) { meta.set(k, v); return true; },
    };
}

/* ---------- 假歌词 ---------- */
/* renderLyrics 吃的就是这个形状（mergeLyrics 产物）：start 毫秒 + original 整行 + 可选 translation */
function L(start, original, translation) {
    return { start, end: start + 4000, original, translation: translation || '', words: [] };
}

const QINGHUA = [
    L(0, '素胚勾勒出青花笔锋浓转淡'),
    L(5000, '天青色等烟雨，而我在等你'),
    L(10000, '色白花青的锦鲤跃然于碗底'),
    L(15000, '天青色等烟雨 而我在等你'),
];

const ZHOUZAI = [
    L(0, '裁出一片天 留给我的思念'),
    L(4000, '快使用双截棍 哼哼哈兮'),
    L(8000, '我年轻时候的歌 现在还在听'),
];

function docFor(song, lines, scopes, at) {
    return buildDoc(song, lines, scopes, { at: at || Date.now() });
}

const FAV_QINGHUA = { source: 'tencent', id: '101', mid: 'M101', title: '青花瓷', artist: '周杰伦', cover: 'c1.jpg' };
const FAV_ZHOUZAI = { source: 'tencent', id: '102', mid: 'M102', title: '双截棍', artist: '周杰伦' };
const RECENT_QINGHUA = { source: 'tencent', id: '101', mid: 'M101', song: '青花瓷', singer: '周杰伦' };

beforeEach(async () => {
    useStore(memoryStore());
});

/* ==================== 规范化与子串匹配 ==================== */

test('normText 丢空白与标点，并做 NFKC + 小写', () => {
    assert.equal(normText('天青色等烟雨，而我在等你'), '天青色等烟雨而我在等你');
    assert.equal(normText('  Hello,   World! '), 'helloworld');
    assert.equal(normText('ＡＢＣ（１２３）'), 'abc123');
    assert.equal(normText(''), '');
    assert.equal(normText(null), '');
});

test('normParts 的映射能把归一坐标换算回原文下标', () => {
    const text = '天青色等烟雨，而我在等你';
    const p = normParts(text);
    assert.equal(p.n, '天青色等烟雨而我在等你');
    assert.equal(text.slice(p.at[0], p.at[2] + p.wid[2]), '天青色');
    assert.equal(text.slice(p.at[3], p.at[5] + p.wid[5]), '等烟雨');
});

test('中文子串匹配：标点/空格/大小写差异都能命中', () => {
    const terms = normalizeTerms('天青色 烟雨');
    assert.deepEqual(terms, ['天青色', '烟雨']);
    const text = '天青色等烟雨，而我在等你';
    const m = matchLine(text, normText(text), terms);
    assert.ok(m, '应命中');
    assert.equal(m.track, 'x');
    assert.deepEqual(m.ranges, [[0, 3], [4, 6]]);
    assert.deepEqual(m.ranges.map(([s, e]) => text.slice(s, e)), ['天青色', '烟雨']);

    /* 相邻的命中片段并成一个 <mark>，中间只剩被丢掉的标点时不算「断开」 */
    const merged = matchLine(text, normText(text), normalizeTerms('天青色 等烟雨'));
    assert.deepEqual(merged.ranges, [[0, 6]]);
    assert.equal(text.slice(0, 6), '天青色等烟雨');

    const en = matchLine('Hello World', 'helloworld', normalizeTerms('hello world'));
    assert.deepEqual(en.ranges, [[0, 5], [6, 11]]);
});

test('多词是 AND：任一词不在同一行就不命中', () => {
    const text = '天青色等烟雨，而我在等你';
    assert.equal(matchLine(text, normText(text), normalizeTerms('天青色 双截棍')), null);
    assert.ok(matchLine(text, normText(text), normalizeTerms('天青色等烟雨而我在等你')));
});

test('整句里多次出现同一词时全部高亮', () => {
    const text = '我要你 也想你';
    const m = matchLine(text, normText(text), normalizeTerms('你'));
    assert.deepEqual(m.ranges, [[2, 3], [6, 7]]);
    assert.deepEqual(m.ranges.map(([s, e]) => text.slice(s, e)), ['你', '你']);
});

test('译文轨也能命中，并标出命中的是哪一轨', () => {
    const line = { start: 1000, original: 'Hello goodbye here', translation: '你好再见', words: [] };
    const idx = toIndexLines([line])[0];
    assert.equal(idx.y, '你好再见');
    assert.equal(idx.yq, '你好再见');
    const m = matchLine(idx.x, idx.q, normalizeTerms('你好再见'), { text: idx.y, n: idx.yq });
    assert.equal(m.track, 'y');
    assert.equal(idx.y.slice(m.ranges[0][0], m.ranges[0][1]), '你好再见');
});

test('空查询/纯标点查询不命中任何内容', () => {
    assert.deepEqual(normalizeTerms('   '), []);
    assert.deepEqual(normalizeTerms('，。、'), []);
    assert.equal(matchLine('随便一句', '随便一句', []), null);
});

/* ==================== 文档构建 ==================== */

test('songKeyOf 跨来源同歌同键（id 优先，兼容 mid/hash/本地）', () => {
    assert.equal(songKeyOf(FAV_QINGHUA), 'tencent:101');
    assert.equal(songKeyOf(RECENT_QINGHUA), 'tencent:101');
    assert.equal(songKeyOf({ source: 'tencent', mid: 'M9' }), 'tencent:M9');
    assert.equal(songKeyOf({ source: 'kugou', hash: 'H1' }), 'kugou:H1');
    assert.equal(songKeyOf({ url: 'blob:x', title: '无名' }), 'local:blob:x');
    assert.equal(songKeyOf(null), '');
});

test('toIndexLines 逐字行退化为词元拼接，空行/占位译文被丢掉', () => {
    const lines = toIndexLines([
        { start: 100, words: [{ text: '晴 ' }, { text: '空' }], original: '' },
        { start: 200, original: '   ' },
        { start: 300, original: '第二句', translation: '//' },
    ]);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].x, '晴 空');
    assert.equal(lines[0].q, '晴空');
    assert.equal(lines[1].y, '');
    assert.equal(lines[0].t, 100);
});

test('buildDoc 产出可搜索文档；无有效行返回 null；sig 随行文本变化', () => {
    const doc = docFor(FAV_QINGHUA, QINGHUA, ['favorite', 'recent'], 1700000000000);
    assert.equal(doc.key, 'tencent:101');
    assert.equal(doc.title, '青花瓷');
    assert.equal(doc.n, 4);
    assert.deepEqual(doc.scopes, ['favorite', 'recent']);
    assert.equal(doc.empty, false);
    assert.equal(doc.lines[1].x, '天青色等烟雨，而我在等你');
    assert.equal(sigOf(doc.lines), doc.sig);
    assert.notEqual(doc.sig, sigOf(toIndexLines(QINGHUA.slice(0, 3))));
    assert.equal(buildDoc(FAV_QINGHUA, [], ['favorite']), null);
    assert.equal(buildDoc(null, QINGHUA, ['favorite']), null);
});

test('权重与来源排序：current > favorite > playlist > recent', () => {
    assert.equal(weightOf(['recent']), 0.5);
    assert.equal(weightOf(['recent', 'favorite']), 0.86);
    assert.equal(weightOf(['recent', 'current']), 1);
    assert.equal(weightOf([]), 0);
    assert.deepEqual(buildDoc(FAV_QINGHUA, QINGHUA, ['recent', 'favorite', 'current']).scopes,
        ['current', 'favorite', 'recent']);
});

/* ==================== 查询：排序 / 去重 / 无命中 ==================== */

/** 直接手搓一篇文档（跳过 buildDoc 的归一化，用来精确控制命中次数） */
function mkDoc(key, title, scopes, texts, at) {
    const lines = texts.map((x, i) => ({ t: i * 4000, x, q: normText(x), y: '', yq: '' }));
    return {
        key, title, artist: '周杰伦', source: key.split(':')[0], id: '1', mid: '', hash: '',
        url: '', cover: '', scopes, n: lines.length, sig: sigOf(lines), empty: false,
        at: at || 1700000000000, lines,
    };
}

test('搜索：命中次数优先，其次来源权重', () => {
    const docs = [
        mkDoc('tencent:101', '一行命中·收藏', ['favorite'], ['别的词', '我要你在我身旁']),
        mkDoc('netease:201', '两次命中·最近', ['recent'], ['我要你在我身旁', '我要你为我梳妆', '别的词']),
        mkDoc('tencent:102', '一行命中·当前', ['current'], ['别的词', '我要你在我身旁']),
    ];
    const r = searchLyric('我要你', docs);
    assert.equal(r.rows.length, 4);
    assert.equal(r.rows[0].key, 'netease:201', '2 次命中排最前，哪怕来源权重最低');
    assert.equal(r.rows[0].songHits, 2);
    assert.equal(r.rows[1].key, 'netease:201', '同一首的多行连着排');
    assert.equal(r.rows[1].lineIndex > r.rows[0].lineIndex, true);
    assert.equal(r.rows[2].key, 'tencent:102', '同为 1 次命中时 current 压过 favorite');
    assert.equal(r.rows[3].key, 'tencent:101');
    assert.equal(r.songs, 3);
    assert.equal(r.total, 4);
});

test('搜索结果带回歌手/时间戳/上下文一句，且每首歌最多 perSong 行', () => {
    const song = { source: 'tencent', id: '101', title: '青花瓷', artist: '周杰伦' };
    const lines = [L(0, '第一句'), L(5000, '天青色等烟雨'), L(10000, '第三句'),
        L(15000, '天青色等烟雨二'), L(20000, '天青色等烟雨三'), L(25000, '天青色等烟雨四')];
    const doc = docFor(song, lines, ['favorite']);
    const r = searchLyric('天青色', [doc]);
    assert.equal(r.total, 4, '全曲命中 4 行');
    assert.equal(r.rows.length, 3, '默认每首最多 3 行进列表');
    assert.equal(r.rows[0].songHits, 4);
    assert.equal(r.rows[0].artist, '周杰伦');
    assert.equal(r.rows[0].time, 5000);
    assert.equal(r.rows[0].prev, '第一句');
    assert.equal(r.rows[0].next, '第三句');
    assert.deepEqual(r.rows.map(x => x.lineIndex), [1, 3, 4]);
});

test('同一首歌同时来自收藏+歌单+最近时只索引一篇、只出一次', () => {
    const desired = mergeDesired([
        { scope: 'favorite', items: [FAV_QINGHUA] },
        { scope: 'playlist', items: [{ source: 'tencent', id: '101', title: '青花瓷', artist: '周杰伦' }] },
        { scope: 'recent', items: [RECENT_QINGHUA] },
    ]);
    assert.equal(desired.length, 1, '三路合并去重成一条');
    assert.deepEqual(desired[0].scopes, ['favorite', 'playlist', 'recent']);
    const doc = docFor(FAV_QINGHUA, QINGHUA, desired[0].scopes);
    const r = searchLyric('天青色', [doc]);
    assert.equal(r.songs, 1);
    assert.equal(r.rows.length, 2, '同一首里两行各出一条，不按来源翻倍');
    assert.equal(r.rows[0].scopes.length, 3);
    assert.equal(r.rows[0].scope, 'favorite');
});

test('无命中：空 rows 但 scanned 是索引里的歌数', () => {
    const docs = [docFor(FAV_QINGHUA, QINGHUA, ['favorite']), docFor(FAV_ZHOUZAI, ZHOUZAI, ['recent'])];
    const r = searchLyric('这句话哪首歌都没有', docs);
    assert.deepEqual(r.rows, []);
    assert.equal(r.total, 0);
    assert.equal(r.songs, 0);
    assert.equal(r.scanned, 2);
    assert.equal(searchLyric('', docs).rows.length, 0);
    assert.equal(searchLyric('青花', []).rows.length, 0);
});

test('empty 文档（取词失败的歌）不参与搜索也不报错', () => {
    const empty = buildEmptyDoc({ source: 'tencent', id: '999', title: '没词的歌' }, ['favorite'], 'no lyric');
    assert.equal(empty.empty, true);
    assert.equal(empty.n, 0);
    const r = searchLyric('随便', [empty, docFor(FAV_QINGHUA, QINGHUA, ['favorite'])]);
    assert.equal(r.scanned, 1);
});

/* ==================== 增量更新 ==================== */

test('planSync：首次铺开 = 当前歌直接落库 + 其余排队取词', () => {
    const desired = mergeDesired([
        { scope: 'current', items: [FAV_QINGHUA], lines: QINGHUA },
        { scope: 'favorite', items: [FAV_ZHOUZAI] },
    ]);
    const plan = planSync(desired, []);
    assert.equal(plan.put.length, 1);
    assert.equal(plan.put[0].key, 'tencent:101');
    assert.deepEqual(plan.put[0].scopes, ['current']);
    assert.equal(plan.fetch.length, 1);
    assert.equal(plan.fetch[0].key, 'tencent:102');
    assert.deepEqual(plan.prune, []);
});

test('planSync：歌词变了才重写，来源变了只改标签，都不重新取词', () => {
    const have = [docFor(FAV_QINGHUA, QINGHUA, ['current'], 1)];
    const same = planSync(mergeDesired([{ scope: 'current', items: [FAV_QINGHUA], lines: QINGHUA }]), have, { now: 2 });
    assert.equal(same.put.length, 0);
    assert.equal(same.fetch.length, 0);
    assert.equal(same.skipped, 1);

    const changed = planSync(mergeDesired([{ scope: 'current', items: [FAV_QINGHUA], lines: QINGHUA.slice(0, 2) }]), have, { now: 2 });
    assert.equal(changed.put.length, 1);
    assert.equal(changed.put[0].n, 2);

    const retagged = planSync(mergeDesired([{ scope: 'favorite', items: [FAV_QINGHUA] }]), have, { now: 2 });
    assert.equal(retagged.put.length, 1);
    assert.deepEqual(retagged.put[0].scopes, ['favorite']);
    assert.equal(retagged.put[0].n, 4, '沿用旧歌词，不重新取词');
    assert.equal(retagged.fetch.length, 0);
});

test('planSync：从所有来源消失的歌被 prune；取词失败的在冷却期内不重试', () => {
    const kept = docFor(FAV_QINGHUA, QINGHUA, ['favorite']);
    const gone = docFor(FAV_ZHOUZAI, ZHOUZAI, ['favorite']);
    const plan = planSync([{ key: kept.key, song: FAV_QINGHUA, scopes: ['favorite'], weight: 0.86, lines: null }],
        [kept, gone], { now: 10 });
    assert.deepEqual(plan.prune, [gone.key]);

    const failed = buildEmptyDoc(FAV_ZHOUZAI, ['favorite'], 'timeout');
    failed.at = 1000;
    const cool = planSync(mergeDesired([{ scope: 'favorite', items: [FAV_ZHOUZAI] }]), [failed], { now: 2000, emptyRetryMs: 60000 });
    assert.equal(cool.fetch.length, 0);
    assert.deepEqual(cool.cooling, [failed.key]);
    const retry = planSync(mergeDesired([{ scope: 'favorite', items: [FAV_ZHOUZAI] }]), [failed], { now: 99000, emptyRetryMs: 60000 });
    assert.equal(retry.fetch.length, 1);
});

test('planSync：容量上限之后不再排新取词', () => {
    const desired = mergeDesired([{ scope: 'recent', items: [FAV_QINGHUA, FAV_ZHOUZAI] }]);
    const plan = planSync(desired, [], { maxDocs: 1 });
    assert.equal(plan.fetch.length, 1);
    assert.equal(plan.skipped, 1);
});

/* ==================== 存储管线（内存 store 驱动同一套异步代码） ==================== */

test('loadIndex/putDocs/removeDocs/clearIndex 与缓存一致', async () => {
    const store = memoryStore();
    useStore(store);
    assert.equal(await loadIndex(), 0);
    assert.equal(await putDocs([docFor(FAV_QINGHUA, QINGHUA, ['favorite'])]), 1);
    assert.equal(store.rows.size, 1, '落库');
    assert.equal(getCachedDocs().length, 1, '进缓存');

    useStore(store);
    assert.equal(await loadIndex(), 1, '重新打开时从库里读回');
    assert.equal(getDoc('tencent:101').title, '青花瓷');
    assert.equal(await removeDocs(['tencent:101']), 1);
    assert.equal(getCachedDocs().length, 0);
    assert.equal(store.rows.size, 0);

    await putDocs([docFor(FAV_QINGHUA, QINGHUA, ['favorite']), docFor(FAV_ZHOUZAI, ZHOUZAI, ['recent'])]);
    const stats = indexStats();
    assert.equal(stats.docs, 2);
    assert.equal(stats.lines, 7);
    assert.equal(stats.byScope.recent, 1);
    assert.equal(await clearIndex(), true);
    assert.equal(indexStats().docs, 0);
});

test('search() 走缓存：写完立刻查得到，删完立刻查不到', async () => {
    await putDocs([docFor(FAV_QINGHUA, QINGHUA, ['favorite']), docFor(FAV_ZHOUZAI, ZHOUZAI, ['playlist'])]);
    assert.equal(search('天青色').rows.length, 2);
    assert.equal(search('天青色', { keys: ['tencent:102'] }).rows.length, 0);
    await removeDocs(['tencent:101']);
    assert.equal(search('天青色').rows.length, 0);
});

test('增量闭环：计划→落库→再计划就没有活要干了', async () => {
    await putDocs([docFor(FAV_QINGHUA, QINGHUA, ['current'])]);
    const desired = mergeDesired([
        { scope: 'current', items: [FAV_QINGHUA], lines: QINGHUA },
        { scope: 'favorite', items: [FAV_ZHOUZAI] },
    ]);
    const first = planSync(desired, getCachedDocs());
    assert.equal(first.fetch.length, 1);
    await putDocs(first.put.concat([docFor(FAV_ZHOUZAI, ZHOUZAI, first.fetch[0].scopes)]));
    const second = planSync(desired, getCachedDocs());
    assert.equal(second.fetch.length, 0);
    assert.equal(second.put.length, 0);
    assert.equal(second.prune.length, 0);
    assert.equal(search('双截棍').rows.length, 1);
});

test('存储不可用时不假装空库：loadIndex 归零并留下原因', async () => {
    useStore(memoryStore());
    await putDocs([docFor(FAV_QINGHUA, QINGHUA, ['favorite'])]);
    useStore({
        async ping() { throw new Error('IndexedDB 不可用'); },
        async all() { throw new Error('IndexedDB 不可用'); },
        async putMany() { throw new Error('IndexedDB 不可用'); },
        async delMany() { throw new Error('IndexedDB 不可用'); },
        async clear() { throw new Error('IndexedDB 不可用'); },
    });
    assert.equal(await probeStore(), false);
    assert.equal(await loadIndex(), 0);
    assert.match(loadError(), /IndexedDB/);
    assert.equal(getCachedDocs().length, 0);
    await assert.rejects(() => putDocs([docFor(FAV_QINGHUA, QINGHUA, ['favorite'])]));
});
