/* ============================================================
 * tests/js/test_word_aligner.js — core/wordAligner.js 纯函数回归
 *
 * 目标：把只有行级时间戳的歌词，按音频频谱对齐成真实逐字时间，
 * 替掉 parsers/wordTiming.js 里「按行时长均分」的近似摊平。
 *
 * 这里只测纯算法（不碰 WebAudio / DOM）：
 *   · buildOnsetEnvelope：已知时刻注入能量突跳 → 峰位误差在 1 帧内；
 *     静音不出 NaN、长度与 hopMs 自洽；
 *   · alignLine：DP 边界必须贴到 onset；无信息时**退化成均分**（证明不会比现状差）；
 *     不变量——单调不重叠、每字 ≥1ms、首字贴行首、不越行尾；
 *   · 确定性（禁 Math.random）：同输入两次结果逐字节相同。
 * 手法：合成 PCM 用 LCG（可复现），不引第三方。
 * 运行：node --test tests/js/test_word_aligner.js
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildOnsetEnvelope, alignLine, HOP_MS_DEFAULT } from '../../web/src/core/wordAligner.js';
import { tokenizeForKaraoke } from '../../web/src/parsers/wordTiming.js';

const SR = 16000;

/** 可复现噪声：LCG，不依赖 Math.random */
function lcg(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}

/** 造一段「在 onsets 处有短促高频爆音、其余是平稳低能量元音」的 PCM */
function pcmWithOnsets(durationSec, onsets, { amp = 0.8, burstSec = 0.05 } = {}) {
    const n = Math.round(durationSec * SR);
    const x = new Float32Array(n);
    const rnd = lcg(1234);
    /* 底噪式元音：低频正弦，能量平稳 */
    for (let i = 0; i < n; i++) x[i] = 0.05 * Math.sin(2 * Math.PI * 180 * i / SR);
    for (const t of onsets) {
        const a = Math.round(t * SR);
        const b = Math.min(n, a + Math.round(burstSec * SR));
        for (let i = a; i < b; i++) x[i] += amp * rnd();   /* 高频噪声爆发 */
    }
    return x;
}

/* ==================== buildOnsetEnvelope ==================== */

test('buildOnsetEnvelope：注入的 onset 时刻能在包络上找到对应峰（误差 ≤1 帧）', () => {
    const onsets = [0.5, 1.2, 1.9, 2.6];
    const env = buildOnsetEnvelope(pcmWithOnsets(3.2, onsets), SR);
    assert.ok(env.values.length > 0 && Number.isFinite(env.hopMs) && env.hopMs > 0);
    for (const t of onsets) {
        const fi = Math.round(t * 1000 / env.hopMs);
        /* 该帧应是局部极大，且与真值不超过一帧 */
        const win = env.values.slice(Math.max(0, fi - 6), fi + 7);
        const peakRel = win.indexOf(Math.max(...win));
        const peakFi = Math.max(0, fi - 6) + peakRel;
        assert.ok(Math.abs(peakFi - fi) <= 1,
            `onset ${t}s 期望帧 ${fi} 实得 ${peakFi}（hopMs=${env.hopMs}）`);
    }
});

test('buildOnsetEnvelope：全静音不产生 NaN/Inf，且包络几乎为 0', () => {
    const env = buildOnsetEnvelope(new Float32Array(SR * 2), SR);
    assert.ok(Array.from(env.values).every(v => Number.isFinite(v)), '包络必须全有限');
    assert.ok(Math.max(...env.values) < 1e-3, `静音包络应接近 0，实得 ${Math.max(...env.values)}`);
});

test('buildOnsetEnvelope：帧数与时长/hopMs 自洽，非法输入不抛', () => {
    const dur = 3.2;
    const env = buildOnsetEnvelope(pcmWithOnsets(dur, [1]), SR);
    assert.ok(Math.abs(env.values.length * env.hopMs - dur * 1000) <= env.hopMs * 2,
        `帧覆盖 ${env.values.length * env.hopMs}ms 应接近 ${dur * 1000}ms`);
    assert.deepEqual(buildOnsetEnvelope(null, SR).values.length, 0);
    assert.deepEqual(buildOnsetEnvelope(new Float32Array(0), SR).values.length, 0);
    assert.deepEqual(buildOnsetEnvelope(new Float32Array(10), 0).values.length, 0, 'sampleRate 非法要空返回');
});

test('buildOnsetEnvelope：默认 hopMs 足够细（≤30ms）才分辨得开音节', () => {
    assert.ok(HOP_MS_DEFAULT <= 30, `hopMs=${HOP_MS_DEFAULT} 太粗，逐字对齐分辨不出来`);
});

/* ==================== alignLine ==================== */

const TOK = (text) => tokenizeForKaraoke(text);

test('alignLine：四个强 onset 时，字起点贴到 onset 而不是均分', () => {
    /* 行窗口 0~4s，onset 在 0.2/1.0/2.6/3.4 —— 与均分点(0/1/2/3)明显不同 */
    const onsets = [0.2, 1.0, 2.6, 3.4];
    const env = buildOnsetEnvelope(pcmWithOnsets(4.0, onsets), SR);
    const words = alignLine({
        tokens: TOK('一二三四'), envelope: env, lineStartMs: 0, lineEndMs: 4000,
    });
    assert.equal(words.length, 4);
    for (let i = 0; i < 4; i++) {
        const err = Math.abs(words[i].start - onsets[i] * 1000);
        assert.ok(err <= 220, `第 ${i} 字 start=${words[i].start} 期望贴 ${onsets[i] * 1000}（误差 ${err}ms）`);
    }
});

test('alignLine：onset 无信息（全静音）时退化成均分，不比现状差', () => {
    const env = buildOnsetEnvelope(new Float32Array(SR * 4), SR);
    const words = alignLine({ tokens: TOK('一二三四'), envelope: env, lineStartMs: 0, lineEndMs: 4000 });
    const even = [0, 1000, 2000, 3000];
    for (let i = 0; i < 4; i++) {
        assert.ok(Math.abs(words[i].start - even[i]) <= 120,
            `无信号时应接近均分，第 ${i} 字得 ${words[i].start}`);
    }
});

test('alignLine：不变量——单调不重叠、每字 ≥1ms、首字贴行首、不越行尾', () => {
    const env = buildOnsetEnvelope(pcmWithOnsets(3.0, [0.3, 0.9, 1.5, 2.1, 2.5]), SR);
    const words = alignLine({ tokens: TOK('这一句话很长'), envelope: env, lineStartMs: 500, lineEndMs: 3500 });
    assert.equal(words[0].start, 500, '首字必须从行首开始');
    assert.equal(words[words.length - 1].end, 3500, '末字必须收到行尾');
    for (let i = 0; i < words.length; i++) {
        assert.ok(words[i].end - words[i].start >= 1, `第 ${i} 字区间不得为零长（渲染层会除出 NaN）`);
        assert.ok(Number.isFinite(words[i].start) && Number.isFinite(words[i].end));
        if (i > 0) assert.ok(words[i].start >= words[i - 1].end, `第 ${i} 字与前一字重叠`);
    }
});

test('alignLine：拖腔（只有行首一个 onset，后面长平稳）不越界不 NaN', () => {
    const env = buildOnsetEnvelope(pcmWithOnsets(6.0, [0.05]), SR);
    const words = alignLine({ tokens: TOK('啊'), envelope: env, lineStartMs: 0, lineEndMs: 6000 });
    assert.equal(words.length, 1);
    assert.equal(words[0].start, 0);
    assert.equal(words[0].end, 6000);
});

test('alignLine：拉丁长词按权重分到更长时长', () => {
    const env = buildOnsetEnvelope(new Float32Array(SR * 4), SR);
    const words = alignLine({ tokens: TOK('a abcdef'), envelope: env, lineStartMs: 0, lineEndMs: 4000 });
    const [a, long] = words;
    assert.ok((long.end - long.start) > (a.end - a.start) * 2,
        `长词应显著更长：a=${a.end - a.start} long=${long.end - long.start}`);
});

test('alignLine：窗口为零 / tokens 为空 / 非法输入 → 返回空数组不抛', () => {
    const env = buildOnsetEnvelope(pcmWithOnsets(1, [0.5]), SR);
    assert.deepEqual(alignLine({ tokens: [], envelope: env, lineStartMs: 0, lineEndMs: 1000 }), []);
    assert.deepEqual(alignLine({ tokens: TOK('甲'), envelope: env, lineStartMs: 500, lineEndMs: 500 }), []);
    assert.deepEqual(alignLine({ tokens: TOK('甲'), envelope: null, lineStartMs: 0, lineEndMs: 1000 }), []);
});

test('alignLine：确定性——同输入两次结果逐字节相同（禁 Math.random）', () => {
    const args = () => ({
        tokens: TOK('我 爱你 baby'),
        envelope: buildOnsetEnvelope(pcmWithOnsets(3.0, [0.2, 0.8, 1.4, 2.2]), SR),
        lineStartMs: 1000, lineEndMs: 4000,
    });
    assert.deepEqual(JSON.stringify(alignLine(args())), JSON.stringify(alignLine(args())));
});

test('alignLine：真实逐字不该被后续兜底覆盖——产出的行不带合成标记的契约由调用方保证', () => {
    /* 这里只锁住输出形状：{text,start,end} 三件套齐备，
       这样 ensureWordTiming / realWordsOf 会把它当真实逐字（AGENTS 约束 17） */
    const env = buildOnsetEnvelope(pcmWithOnsets(2.0, [0.2, 1.0]), SR);
    const words = alignLine({ tokens: TOK('甲乙'), envelope: env, lineStartMs: 0, lineEndMs: 2000 });
    for (const w of words) {
        assert.equal(typeof w.text, 'string');
        assert.equal(typeof w.start, 'number');
        assert.equal(typeof w.end, 'number');
    }
});
