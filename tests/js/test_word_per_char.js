/* ============================================================
 * tests/js/test_word_per_char.js — 逐字展示开关 + 跨音源真逐字替换（todos #12）
 *
 * 覆盖两层纯函数（浏览器那一层在 tests/test_word_per_char_ui.py）：
 *   parsers/lyricMatch.js  —— 两份歌词是不是同一首歌
 *   config/wordPerChar.js  —— 现在到底该不该摊平
 *
 * 重点钉的是**替换的安全边界**：自动换歌词这件事，换错比不换糟糕得多
 * （把另一首歌的节拍贴过来 = 每个字都错位）。所以"不替换"的分支
 * 比"替换"的分支更需要测试。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hasRealWordTiming, lineSimilarity, lyricMatchRate, normalizeLyricLine } from '../../web/src/parsers/lyricMatch.js';
import { PER_CHAR_MODES, WORD_UPGRADE_MIN_COVERAGE, WORD_UPGRADE_MIN_MATCH_RATE, orderWordCandidateSources, perCharSynthesisWanted, wordUpgradeWanted } from '../../web/src/config/wordPerChar.js';
import { candidateWordLevel, currentLineLevel } from '../fixtures/lyric_pair_qingtian.mjs';

/* ---------- 归一化 ---------- */

test('normalizeLyricLine：KRC 装饰符、全角、大小写、标点空白都不算字', () => {
    assert.equal(normalizeLyricLine('^刮风$这天\\我试着留你'), '刮风这天我试着留你');
    assert.equal(normalizeLyricLine('ＲＥ ＳＯ'), 'reso');
    assert.equal(normalizeLyricLine('Re So So Si'), 'resososi');
    assert.equal(normalizeLyricLine('你好，世界！'), '你好世界');
    assert.equal(normalizeLyricLine(null), '');
    assert.equal(normalizeLyricLine(undefined), '');
});

test('lineSimilarity：同句不同写法=1，无关句=0，长度悬殊直接 0 不做无谓 DP', () => {
    assert.equal(lineSimilarity('^故事的小黄花$', '故事的小黄花'), 1);
    assert.equal(lineSimilarity('告白气球', '塞纳河畔左岸的咖啡'), 0);
    assert.equal(lineSimilarity('短', '这是一句长得完全不匹配的歌词内容'), 0);
    assert.equal(lineSimilarity('', ''), 1, '两边都空视为相同');
    assert.equal(lineSimilarity('有字', ''), 0);
});

/* ---------- hasRealWordTiming：合成行绝不算真逐字（约束 17 的同一判据） ---------- */

test('hasRealWordTiming：带 synthesized 标记的行不算真逐字', () => {
    assert.equal(hasRealWordTiming([{ words: [{ start: 0, end: 500 }], wordTiming: 'synthesized' }]), false);
    assert.equal(hasRealWordTiming([{ words: [{ start: 0, end: 500 }] }]), true);
    assert.equal(hasRealWordTiming([{ text: '一行', start: 0 }]), false, '没有 words 就是行级');
    assert.equal(hasRealWordTiming([{ words: [{ start: 5, end: 5 }] }]), false, '零时长节拍不算');
    assert.equal(hasRealWordTiming(null), false);
    assert.equal(hasRealWordTiming([]), false);
});

/* ---------- 替换的安全边界 ---------- */

const CUR = [
    { text: '晴天' }, { text: '刮风这天我试着留你' }, { text: '但偏偏雨渐渐大到我看不见' },
    { text: '故事的小黄花' }, { text: '从出生那年就飘着' }, { text: '童年的荡秋千' },
];
const SAME = [
    { text: '晴天' }, { text: '刮风这天 我试着留你' }, { text: '但偏偏 雨渐渐 大到我看你不见' },
    { text: '故事的小黄花' }, { text: '从出生那年就飘着' }, { text: '童年的荡秋千' },
];
const OTHER = [
    { text: '告白气球' }, { text: '塞纳河畔左岸的咖啡' }, { text: '我手一杯品尝你的美' },
    { text: '留下唇印的嘴' }, { text: '花店玫瑰' }, { text: '名字改对都太绝对' },
];

test('同一首歌（装饰/空格/个别字有差异）→ 匹配率过门槛', () => {
    const r = lyricMatchRate(CUR, SAME);
    assert.ok(r.coverage >= WORD_UPGRADE_MIN_COVERAGE, `coverage=${r.coverage} 应 ≥ ${WORD_UPGRADE_MIN_COVERAGE}`);
});

test('不同歌 → 匹配率 0，绝不能替换', () => {
    assert.equal(lyricMatchRate(CUR, OTHER).rate, 0);
});

/* ---------- 真实取样回归（2026-09-27 用户实测「自动替换不会替换」的根因） ---------- */

test('★ 同一首歌但开头制作信息条数不同 → 必须过门槛（旧算法在这里是 0.048）', () => {
    /* 线上失效的真实案例：《晴天》网易云行级版 55 行 vs 酷狗 KRC 逐字版 63 行，
       两份开头的制作信息条数与顺序都不一样（网易 8 条、酷狗 10 条），
       正文因此整体错行。按位置逐行比只有 0.048 分 → 自动替换永远不触发。
       换成「滤掉制作信息 + 顺序保持的 LCS」后同一对是 0.962。 */
    const r = lyricMatchRate(currentLineLevel, candidateWordLevel);
    assert.ok(r.coverage >= WORD_UPGRADE_MIN_COVERAGE,
        `同一首歌的真实两份歌词 coverage=${r.coverage} 必须 ≥ ${WORD_UPGRADE_MIN_COVERAGE}`);
    assert.ok(r.matched > 40, `达标行数少得离谱：${r.matched}`);
});

test('★ 滤掉制作信息不得把别的歌抬进门槛（分母仍是正文较大行数）', () => {
    /* 制作信息行是两份歌词里**最容易相同**的部分（同一首歌常同一套班底），
       所以「先滤掉再比」有个真实风险：别的歌只剩制作信息相似也能得高分。
       这条钉住它没有：拿《晴天》的候选去比另一首歌的正文，分数必须趴在门槛下。 */
    const r = lyricMatchRate(OTHER, candidateWordLevel);
    assert.ok(r.coverage < WORD_UPGRADE_MIN_COVERAGE, `别的歌 coverage=${r.coverage} 必须低于门槛`);
    const half = lyricMatchRate(currentLineLevel, candidateWordLevel.slice(0, 12));
    assert.ok(half.coverage < WORD_UPGRADE_MIN_COVERAGE, `只覆盖一小段 coverage=${half.coverage} 必须低于门槛`);
});

test('乱序的同一首歌不会被当成同一首（LCS 是顺序保持的）', () => {
    const shuffled = [...candidateWordLevel].reverse();
    const r = lyricMatchRate(currentLineLevel, shuffled);
    assert.ok(r.coverage < WORD_UPGRADE_MIN_COVERAGE, `倒序歌词 coverage=${r.coverage} 不该过门槛`);
});

test('★ 候选只覆盖一半行数 → 分数必须掉下来（分母取较大行数）', () => {
    /* 这是最危险的误判场景：候选是同一首歌但只有一半的行，
       若按"匹配上的都挺像"算就会得满分，然后把半份歌词贴上去。 */
    const half = lyricMatchRate(CUR, SAME.slice(0, 3));
    assert.ok(half.coverage < WORD_UPGRADE_MIN_COVERAGE, `半份歌词 coverage=${half.coverage} 必须低于门槛`);
    assert.equal(half.total, CUR.length, '分母该是较大行数');
});

test('★ 一半相同一半不同 → 落在门槛下（换歌不能替换）', () => {
    const mixed = [...SAME.slice(0, 3), ...OTHER.slice(3, 6)];
    const r = lyricMatchRate(CUR, mixed);
    assert.ok(r.coverage < WORD_UPGRADE_MIN_COVERAGE, `混合歌词 coverage=${r.coverage} 必须低于门槛`);
});

test('★ 判定用字流覆盖率，不用「按行均值」也不用「行数比」', () => {
    /* 钉住两次改错的方向：
       ① 按行均值（perLine）会被"像但不达线"的行蒙混——6 行错 1 行时均值仍有 0.93；
       ② 按行数比（rate = matched / 较大行数）会被**分行习惯**惩罚：
          酷狗 KRC 把一句拆两行、网易一行，同一首歌实测只有 67% → 功能永远不触发。
       现在判据是字流顺序覆盖率：无视换行，只看当前这份词的字数有多少按顺序出现在候选里。 */
    /* 个别行不同（和谐版/现场版差一句）不该挡：那是歌词常态。
       真正要挡的是「一半不同」——见上面 混合歌词 / 别的歌 两条。 */
    const oneBad = SAME.map((l, i) => (i === 4 ? { text: '从出生那年就忘了' } : l));
    const r = lyricMatchRate(CUR, oneBad);
    assert.ok(r.coverage >= WORD_UPGRADE_MIN_COVERAGE,
        `只差一行时覆盖率 ${r.coverage} 应放行（各平台歌词常有个别差异）`);
    assert.ok(r.rate < r.perLine,
        `行数比 ${r.rate} 比均值 ${r.perLine} 更保守——旧口径按它判会误拒`);

    /* 分行不同不该扣分：把同一份词按字数重新切成两倍的行数 */
    const resplit = [];
    for (const l of SAME) {
        const chars = [...l.text];
        const half = Math.ceil(chars.length / 2);
        resplit.push({ start: l.start, text: chars.slice(0, half).join('') });
        resplit.push({ start: l.start + 500, text: chars.slice(half).join('') });
    }
    const r2 = lyricMatchRate(CUR, resplit);
    assert.ok(r2.coverage >= WORD_UPGRADE_MIN_COVERAGE,
        `同一份词、换了切法，覆盖率 ${r2.coverage} 不该掉下门槛`);
});

test('空/脏输入不抛，一律 0 分（宁可不替换）', () => {
    assert.equal(lyricMatchRate(null, SAME).rate, 0);
    assert.equal(lyricMatchRate(CUR, []).rate, 0);
    assert.equal(lyricMatchRate([], []).rate, 0);
    assert.equal(lyricMatchRate(CUR, [null, undefined]).rate, 0);
});

test('逐字行的文本从 words 里拼出来（没有 text 字段也要能比）', () => {
    const wordLines = SAME.map(l => ({ words: l.text.split('').map(c => ({ word: c, start: 0, end: 1 })) }));
    assert.ok(lyricMatchRate(CUR, wordLines).coverage >= WORD_UPGRADE_MIN_COVERAGE);
});

/* ---------- 开关判定 ---------- */

test('开关1 默认开，且只对点名的三个模式生效', () => {
    const on = { lyrics: { perCharFromLineLyrics: true } };
    for (const m of ['lyrics', 'cover', 'wordcloud']) {
        assert.equal(perCharSynthesisWanted(on, m), true, `${m} 应该摊平`);
    }
    for (const m of ['pv', 'tunnel', 'neon', 'letterpress', 'dimension', 'flyin', 'bogus', '']) {
        assert.equal(perCharSynthesisWanted(on, m), false, `${m} 不该被这个开关管`);
    }
    assert.equal(PER_CHAR_MODES.size, 3);
});

test('开关1 关掉 → 任何模式都不摊平', () => {
    const off = { lyrics: { perCharFromLineLyrics: false } };
    for (const m of PER_CHAR_MODES) assert.equal(perCharSynthesisWanted(off, m), false, m);
});

test('★ 开关2 一开就压过开关1（用户定的互锁，判定层也要成立）', () => {
    const both = { lyrics: { perCharFromLineLyrics: true, autoUpgradeWordLyrics: true } };
    for (const m of PER_CHAR_MODES) {
        assert.equal(perCharSynthesisWanted(both, m), false, `${m}：要真逐字就不该同时贴假逐字`);
    }
    assert.equal(wordUpgradeWanted(both), true);
});

test('开关2 生效判定与 vendor 优先序（自建在线的源先试，公网源靠后）', () => {
    /* 用户实测指出：不该写死「酷狗第一」，优先的是**本机登录了的自建 vendor**——
       QQ 的逐字歌词同样优质，而公网上游会整体失联。 */
    const SRC = ['kugou', 'tencent', 'netease', 'kuwo', 'amll', 'lrclib'];
    assert.deepEqual(
        orderWordCandidateSources(SRC, () => false), SRC,
        '一个 vendor 都没有时保持基线顺序');
    assert.deepEqual(
        orderWordCandidateSources(SRC, p => p === 'qq'),
        ['tencent', 'kugou', 'netease', 'kuwo', 'amll', 'lrclib'],
        '只登录了 QQ：tencent 提到第一位，其余相对顺序不变');
    assert.deepEqual(
        orderWordCandidateSources(SRC, p => p === 'kugou' || p === 'netease'),
        ['kugou', 'netease', 'tencent', 'kuwo', 'amll', 'lrclib']);
    /* 酷我/amll/lrclib 没有自建服务，永远不可能因为 isEnabled 而提前 */
    assert.deepEqual(
        orderWordCandidateSources(SRC, () => true), SRC,
        '全部 vendor 可用时 = 基线顺序（没有 vendor 的源不许插队）');
    assert.deepEqual(orderWordCandidateSources([], () => true), []);
});

test('老配置没有这两个键 → 行为与约束 17 落地后一致（默认摊平、不自动替换）', () => {
    assert.equal(perCharSynthesisWanted({}, 'cover'), true);
    assert.equal(perCharSynthesisWanted({ lyrics: {} }, 'lyrics'), true);
    assert.equal(wordUpgradeWanted({ lyrics: {} }), false);
    assert.equal(perCharSynthesisWanted(undefined, 'cover'), true, 'settings 整个缺失也不能抛');
    assert.equal(wordUpgradeWanted(null), false);
});
