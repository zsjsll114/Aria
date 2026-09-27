/* ============================================================
 * tests/js/test_word_align_service.js — services/wordAlign.js 纯逻辑回归
 *
 * 只测不碰浏览器的部分：缓存键、歌词签名、是否需要对齐、把对齐结果贴回歌词。
 * decode/align 的编排要 WebAudio，交给 playwright（tests/test_word_align.py）。
 *
 * 盯的是几个会静默出错的点：
 *   · 缓存键必须含歌词签名——同一首歌换歌词源时行级时间戳会变，
 *     只按歌曲键会把上一份歌词的对齐结果贴到这一份上；
 *   · 对齐结果必须清掉 wordTiming 合成标记，否则 realWordsOf 仍当它是假的、
 *     下载和 AI 两条路都拿不到（AGENTS 约束 17）；
 *   · 反过来：音频没给出信息时（退化成均分）不能冒充真实逐字。
 * 运行：node --test tests/js/test_word_align_service.js
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    wordAlignKey, lyricSignature, needsAlign, applyAlignment, decimateBox,
} from '../../web/src/services/wordAlign.js';
import { ensureWordTiming, isSyntheticWordLine, realWordsOf, SYNTHESIZED } from '../../web/src/parsers/wordTiming.js';
import { maxDeviationFromEvenSplit } from '../../web/src/core/wordAligner.js';

const L = (start, text) => ({ start, end: start + 3000, text, original: text });

test('lyricSignature：文本相同则相同，行起点或行数变了则不同', () => {
    const a = [L(0, '甲乙'), L(3000, '丙丁')];
    assert.equal(lyricSignature(a), lyricSignature([L(0, '甲乙'), L(3000, '丙丁')]));
    assert.notEqual(lyricSignature(a), lyricSignature([L(500, '甲乙'), L(3000, '丙丁')]),
        '同一份文本但行级时间戳变了（换源常见），签名必须变');
    assert.notEqual(lyricSignature(a), lyricSignature([L(0, '甲乙')]));
    assert.notEqual(lyricSignature(a), lyricSignature([L(0, '甲戊'), L(3000, '丙丁')]));
});

test('wordAlignKey：带歌曲身份 + 歌词签名；缺歌曲信息也不抛', () => {
    const lines = [L(0, '甲乙'), L(3000, '丙丁')];
    const k1 = wordAlignKey({ source: 'tencent', mid: 'ABC' }, lines);
    assert.ok(k1.includes('tencent') && k1.includes('ABC'));
    assert.equal(k1, wordAlignKey({ source: 'tencent', mid: 'ABC' }, lines));
    assert.notEqual(k1, wordAlignKey({ source: 'tencent', mid: 'ABC' }, [L(0, '甲乙'), L(4000, '丙丁')]));
    assert.ok(wordAlignKey(null, lines).length > 0);
    assert.ok(wordAlignKey({}, []).length > 0);
});

test('needsAlign：只有行级（被摊平过）才要跑；已有真实逐字不跑', () => {
    const flat = ensureWordTiming([L(0, '甲乙'), L(3000, '丙丁')]);
    assert.equal(needsAlign(flat), true);
    const real = [
        { start: 0, end: 3000, text: '甲乙', words: [{ text: '甲', start: 0, end: 900 }, { text: '乙', start: 900, end: 1800 }] },
        { start: 3000, end: 6000, text: '丙丁', words: [{ text: '丙', start: 3000, end: 3900 }] },
    ];
    assert.equal(needsAlign(real), false);
    assert.equal(needsAlign([]), false);
    assert.equal(needsAlign(null), false);
});

test('applyAlignment：结果仍是 synthesized——更聪明的猜测也不许冒充真实逐字', () => {
    /* 实测依据：拿有真逐字的歌对拍，频谱对齐平均误差 547ms、±100ms 命中 36%，
       只比均分基线好 11%。清掉标记会让 realWordsOf 认它成真货，
       于是 547ms 级误差被写进用户下载的 .lrc、并被当节奏喂给 AI 打 ★/◆ 权重。 */
    const flat = ensureWordTiming([L(0, '甲乙'), L(3000, '丙丁')]);
    assert.equal(isSyntheticWordLine(flat[0]), true, '前提：摊平结果带合成标记');
    const out = applyAlignment(flat, [
        [{ text: '甲', start: 100, end: 1400 }, { text: '乙', start: 1400, end: 3000 }],
        [{ text: '丙', start: 3100, end: 4500 }, { text: '丁', start: 4500, end: 6000 }],
    ]);
    assert.equal(out[0].words[1].start, 1400, '渲染侧要拿到对齐后的 words');
    assert.equal(out[0].wordTiming, SYNTHESIZED, '必须仍是合成标记');
    assert.equal(isSyntheticWordLine(out[0]), true);
    assert.equal(realWordsOf(out[0]), null, '下载/AI 两条路不得认它为真实逐字');
    assert.equal(out[0].translation, flat[0].translation);
    assert.equal(flat[0].wordTiming, SYNTHESIZED, '不得原地改入参数组');
    assert.equal(typeof out[0].wordAlignDeviationMs, 'number', '诊断量应随行带出');
});

test('applyAlignment：某行没对齐结果时保留原样（不硬塞空数组把逐字抹掉）', () => {
    const flat = ensureWordTiming([L(0, '甲乙'), L(3000, '丙丁')]);
    const out = applyAlignment(flat, [
        [{ text: '甲', start: 100, end: 3000 }, { text: '乙', start: 3000, end: 3001 }],
        null,
    ]);
    assert.equal(out[1], flat[1], '缺失行应原引用保留');
    assert.equal(isSyntheticWordLine(out[1]), true);
});

test('maxDeviationFromEvenSplit：均分结果偏差为 0，真对齐结果偏差明显', () => {
    const tokens = [{ text: '甲', weight: 1 }, { text: '乙', weight: 1 }, { text: '丙', weight: 1 }, { text: '丁', weight: 1 }];
    const even = [0, 1000, 2000, 3000].map((s, i) => ({ text: tokens[i].text, start: s, end: s + 1000 }));
    assert.ok(maxDeviationFromEvenSplit(even, tokens, 0, 4000) < 5);
    const aligned = [200, 900, 2600, 3300].map((s, i) => ({ text: tokens[i].text, start: s, end: s + 700 }));
    assert.ok(maxDeviationFromEvenSplit(aligned, tokens, 0, 4000) > 300);
});

/* ---------- 降采样 ---------- */
test('decimateBox 比点采样更多地压住高于新奈奎斯特的分量', () => {
    const sr = 44100, ratio = sr / 16000, n = sr;
    /* 7 kHz：高于 16k 的奈奎斯特(8k)不多，但点采样会把它连同等高频一起折进语音带 */
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * 7000 * i / sr);
    const y = decimateBox(x, ratio);
    const naive = new Float32Array(y.length);
    for (let i = 0; i < y.length; i++) naive[i] = x[Math.floor(i * ratio)];
    const peak = a => { let m = 0; for (const v of a) m = Math.max(m, Math.abs(v)); return m; };
    /* 箱式平均 = 长度为 ratio 的 FIR；ratio≈2.76 时 |sinc| 约 0.7，衰减有限但确实有，
       而点采样完全无衰减（且把能量折回语音带）。断言相对关系，不断言绝对值。 */
    assert.ok(peak(y) < peak(naive) - 0.05,
        `box peak=${peak(y).toFixed(3)} 应明显低于点采样 peak=${peak(naive).toFixed(3)}`);
});

test('decimateBox 保留语音频段幅度，且长度正确', () => {
    const sr = 44100, ratio = sr / 16000, n = sr;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * 1000 * i / sr);
    const y = decimateBox(x, ratio);
    assert.equal(y.length, Math.floor(n / ratio));
    let peak = 0;
    for (let i = 0; i < y.length; i++) peak = Math.max(peak, Math.abs(y[i]));
    assert.ok(peak > 0.9, `1kHz 应基本保留，实得 peak=${peak.toFixed(3)}`);
    /* 点采样对照：长度一致但高频会漏下来 */
    const naive = new Float32Array(y.length);
    for (let i = 0; i < y.length; i++) naive[i] = x[Math.floor(i * ratio)];
    let npeak = 0;
    for (let i = 0; i < naive.length; i++) npeak = Math.max(npeak, Math.abs(naive[i]));
    assert.ok(peak < npeak + 1e-9 || npeak > 0, '对照应存在');
});

test('decimateBox 对非法输入不抛', () => {
    assert.equal(decimateBox(null, 2).length, 0);
    assert.equal(decimateBox(new Float32Array(4), 0).length, 0);
});
