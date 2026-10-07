/* ============================================================
 * tests/js/test_scatter_pick.js — 随机散列选曲（core/scatterPick.js）
 *
 * 盯住三件事：① 歌名归一化真的能削掉 Live/Remix/伴奏；② 三级降级**不会选不出歌**；
 * ③ 约束无法满足时允许相邻（宁可相邻也不能返回 -1 / undefined）。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    pickScatteredIndex, coreTitle, artistKey, albumKey, editDistance, similarTitle,
} from '../../web/src/core/scatterPick.js';

/* ---------------- 歌名归一化 ---------------- */

test('coreTitle 削掉尾部修饰（Live / Remix / 伴奏 / 括号版本）', () => {
    assert.equal(coreTitle('告白气球 (Live)'), coreTitle('告白气球'));
    assert.equal(coreTitle('告白气球 - Remix'), coreTitle('告白气球'));
    assert.equal(coreTitle('晴天（伴奏）'), coreTitle('晴天'));
    assert.equal(coreTitle('晴天 (Live) (Remix)'), coreTitle('晴天'), '连续修饰要削干净');
    assert.equal(coreTitle('Faded (Acoustic)'), coreTitle('Faded'));
});

test('coreTitle 不误伤标题中部的词', () => {
    /* 「Live」出现在中间时不该被削 */
    assert.notEqual(coreTitle('Live 演唱会'), coreTitle('演唱会'));
    assert.equal(coreTitle('Live 演唱会'), 'live演唱会');
});

test('coreTitle 去标点与空白并小写', () => {
    assert.equal(coreTitle('Hello, World!'), 'helloworld');
    assert.equal(coreTitle('  A-B_C  '), 'abc');
});

test('artistKey / albumKey 兼容各音源的不同字段名', () => {
    assert.equal(artistKey({ artist: '周杰伦' }), '周杰伦');
    assert.equal(artistKey({ singer: '周杰伦' }), '周杰伦');
    assert.equal(artistKey({ artists: ['周杰伦', '方文山'] }), '周杰伦/方文山');
    assert.equal(artistKey(null), '');
    assert.equal(albumKey({ album: '叶惠美' }), '叶惠美');
    assert.equal(albumKey({ albumName: '叶惠美' }), '叶惠美');
});

/* ---------------- 编辑距离 / 相似 ---------------- */

test('editDistance 基本正确', () => {
    assert.equal(editDistance('abc', 'abc'), 0);
    assert.equal(editDistance('abc', 'abd'), 1);
    assert.equal(editDistance('', 'abc'), 3);
    assert.equal(editDistance('kitten', 'sitting'), 3);
});

test('similarTitle 只对长度接近的短串判定相似', () => {
    assert.equal(similarTitle('告白气球', '告白汽球'), true, '一字之差算相似');
    assert.equal(similarTitle('告白气球', '晴天'), false);
    assert.equal(similarTitle('ab', 'ac'), false, '太短不判（噪声太大）');
    assert.equal(similarTitle('告白气球', '告白气球一个很长的副标题版本'), false, '长度差太多不判');
});

/* ---------------- 选曲 ---------------- */

const T = (title, artist, album) => ({ title, artist, album, id: title });

test('队列长度 ≤1：原样返回当前索引', () => {
    assert.equal(pickScatteredIndex([], 0), 0);
    assert.equal(pickScatteredIndex([T('a', 'x')], 0), 0);
});

test('① 优先不同歌手：同歌手全部被排除', () => {
    const list = [T('a', '周杰伦'), T('b', '周杰伦'), T('c', '蔡依林')];
    for (let i = 0; i < 50; i++) {
        assert.equal(pickScatteredIndex(list, 0, () => i / 50), 2, '只有一个不同歌手可选，必须选它');
    }
});

test('② 全是同一歌手：按核心歌名隔开（Live/Remix 视为同一首）', () => {
    const list = [
        T('晴天', '周杰伦'),
        T('晴天 (Live)', '周杰伦'),   /* 与当前曲同核心名 → 应被排除 */
        T('七里香', '周杰伦'),        /* 可选项 */
    ];
    const picked = pickScatteredIndex(list, 0, () => 0);
    assert.equal(picked, 2, 'Live 版是同核心名必须避开，只能选另一首');
});

test('②b 全是同一歌手：同专辑也被隔开', () => {
    const list = [
        T('A', '周杰伦', '叶惠美'),
        T('B', '周杰伦', '叶惠美'),   /* 同专辑 + 不同歌名 → 仍被排除 */
        T('C', '周杰伦', '七里香'),
    ];
    assert.equal(pickScatteredIndex(list, 0, () => 0), 2);
});

test('③ 约束无法满足：允许相邻但仍返回合法索引', () => {
    /* 同一首歌的三个版本：核心名相同、同歌手、同专辑 —— 无解 */
    const list = [
        T('Faded', 'Alan', 'X'),
        T('Faded (Live)', 'Alan', 'X'),
        T('Faded (Remix)', 'Alan', 'X'),
    ];
    const idx = pickScatteredIndex(list, 0, () => 0);
    assert.ok(idx >= 0 && idx < list.length && idx !== 0, `应返回合法且非当前的索引，实=${idx}`);
});

test('返回值永远落在合法范围（随机源边界）', () => {
    const list = [T('a', 'x'), T('b', 'y'), T('c', 'z')];
    for (const r of [0, 0.999999, 1, -1, NaN]) {
        const idx = pickScatteredIndex(list, 0, () => r);
        assert.ok(Number.isInteger(idx) && idx >= 0 && idx < list.length, `r=${r} 得 ${idx}`);
        assert.notEqual(idx, 0, '永远不能选回当前曲');
    }
});

test('同歌手相邻率显著下降（统计意义上的散列）', () => {
    const list = [];
    for (let i = 0; i < 10; i++) list.push(T('s' + i, 'A'));
    for (let i = 0; i < 10; i++) list.push(T('t' + i, 'B'));
    let same = 0;
    let cur = 0;
    const seq = [0.1, 0.35, 0.62, 0.88, 0.27, 0.51, 0.73, 0.94, 0.44, 0.16];
    let si = 0;
    for (let step = 0; step < 60; step++) {
        const nxt = pickScatteredIndex(list, cur, () => seq[si++ % seq.length]);
        if (artistKey(list[nxt]) === artistKey(list[cur])) same++;
        cur = nxt;
    }
    /* 两个歌手各半的队列：理想同歌手相邻率 ≈ 0（③ 兜底只在无解时触发，这里永远有解） */
    assert.equal(same, 0, `两个歌手各 10 首时不该出现同歌手相邻，实=${same}`);
});
