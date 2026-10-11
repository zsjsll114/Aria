/* ============================================================
 * tests/js/test_chorus_detector.js — core/chorusDetector.js 纯算法回归
 *
 * 为什么单开一个文件（test_rhythm_tempo.js 已覆盖 _estimateTempo /
 * _computeBandEnergy）：`noUncheckedIndexedAccess` 在该文件会报 154 条（全仓最多），
 * 落点集中在 _fft 的位反转 + 蝶形、_hannWindow、_cosineSim，以及 _identifyChorus
 * 的 11 步流水线（2s 窗口聚合 → 三级阈值 → 短段吸收 → 频谱重复 → 边界细分 → 覆盖率封顶）。
 * 这些路径原先**没有行为测试**——动 154 处索引访问之前，先把它们钉住。
 *
 * 覆盖：
 *   · _fft        对拍朴素 DFT、Parseval 能量守恒、冲激/直流特例、线性、n≤1 空操作
 *   · _hannWindow 端点≈0、对称、峰值、值域 [0,1]
 *   · _cosineSim  同向=1、正交=0、零向量=0（不是 NaN）、尺度无关、对称
 *   · _identifyChorus
 *                 段不变量（≥6s、label∈{0,1,2}、signature 归一、升序不重叠）、
 *                 覆盖率 ≤50% 封顶、确定性、非法 duration 的兜底、
 *                 以及在「响段 + 同谱重复」合成轨上真的检出该响段
 * 手法：合成 frame 序列用 LCG，任何失败都能原样复现；不碰 Worker / DOM / WebAudio。
 * 运行：node --test tests/js/test_chorus_detector.js
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    fft,
    hannWindow,
    cosineSim,
    identifyChorus,
} from '../../web/src/core/chorusDetector.js';

const SR = 16000;
const HOP = 512;
const BANDS = 16;

/** 可复现伪随机：LCG（不用 Math.random，失败可复现） */
function lcg(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** 朴素 DFT（O(n²)）：只用来对拍小 n 的 _fft，不做性能用途 */
function naiveDft(reIn, imIn) {
    const n = reIn.length;
    const re = new Array(n).fill(0);
    const im = new Array(n).fill(0);
    for (let k = 0; k < n; k++) {
        for (let t = 0; t < n; t++) {
            const a = -2 * Math.PI * k * t / n;
            re[k] += reIn[t] * Math.cos(a) - imIn[t] * Math.sin(a);
            im[k] += reIn[t] * Math.sin(a) + imIn[t] * Math.cos(a);
        }
    }
    return { re, im };
}

/* ==================== _fft ==================== */

test('fft：对拍朴素 DFT（n=2/4/8/16/32，float32 容差内）', () => {
    for (const n of [2, 4, 8, 16, 32]) {
        const rnd = lcg(1000 + n);
        const re = new Float32Array(n);
        const im = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            re[i] = rnd() * 2 - 1;
            im[i] = rnd() * 2 - 1;
        }
        const ref = naiveDft(re, im);
        fft(re, im);
        for (let k = 0; k < n; k++) {
            assert.ok(Math.abs(re[k] - ref.re[k]) < 1e-2,
                `n=${n} k=${k} 实部 ${re[k]} vs 朴素 ${ref.re[k]}`);
            assert.ok(Math.abs(im[k] - ref.im[k]) < 1e-2,
                `n=${n} k=${k} 虚部 ${im[k]} vs 朴素 ${ref.im[k]}`);
        }
    }
});

test('fft：Parseval —— Σ|X[k]|² = n · Σ|x[t]|²', () => {
    const n = 64;
    const rnd = lcg(7);
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    let timePower = 0;
    for (let i = 0; i < n; i++) {
        re[i] = rnd() * 2 - 1;
        im[i] = rnd() * 2 - 1;
        timePower += re[i] * re[i] + im[i] * im[i];
    }
    fft(re, im);
    let freqPower = 0;
    for (let k = 0; k < n; k++) freqPower += re[k] * re[k] + im[k] * im[k];
    const relErr = Math.abs(freqPower - n * timePower) / (n * timePower);
    assert.ok(relErr < 1e-3, `能量不守恒：频域 ${freqPower} vs n×时域 ${n * timePower}（相对误差 ${relErr}）`);
});

test('fft：冲激 → 全 1 谱；直流 → 能量全在 0 号 bin', () => {
    const n = 16;
    const ri = new Float32Array(n);
    const ii = new Float32Array(n);
    ri[0] = 1;
    fft(ri, ii);
    for (let k = 0; k < n; k++) {
        assert.ok(Math.abs(ri[k] - 1) < 1e-6, `冲激谱 k=${k} 应为 1，实际 ${ri[k]}`);
        assert.ok(Math.abs(ii[k]) < 1e-6, `冲激谱 k=${k} 虚部应为 0，实际 ${ii[k]}`);
    }

    const rd = new Float32Array(n).fill(1);
    const idd = new Float32Array(n);
    fft(rd, idd);
    assert.ok(Math.abs(rd[0] - n) < 1e-4, `直流分量应为 ${n}，实际 ${rd[0]}`);
    for (let k = 1; k < n; k++) {
        assert.ok(Math.abs(rd[k]) < 1e-3 && Math.abs(idd[k]) < 1e-3,
            `直流信号的 k=${k} 应≈0，实际 ${rd[k]}+${idd[k]}i`);
    }
});

test('fft：线性 —— fft(a+b) = fft(a) + fft(b)', () => {
    const n = 32;
    const rnd = lcg(99);
    const aRe = new Float32Array(n), aIm = new Float32Array(n);
    const bRe = new Float32Array(n), bIm = new Float32Array(n);
    const sRe = new Float32Array(n), sIm = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        aRe[i] = rnd() * 2 - 1; aIm[i] = rnd() * 2 - 1;
        bRe[i] = rnd() * 2 - 1; bIm[i] = rnd() * 2 - 1;
        sRe[i] = aRe[i] + bRe[i];
        sIm[i] = aIm[i] + bIm[i];
    }
    fft(aRe, aIm); fft(bRe, bIm); fft(sRe, sIm);
    for (let k = 0; k < n; k++) {
        assert.ok(Math.abs(sRe[k] - (aRe[k] + bRe[k])) < 1e-3,
            `k=${k} 实部不满足叠加：${sRe[k]} vs ${aRe[k] + bRe[k]}`);
        assert.ok(Math.abs(sIm[k] - (aIm[k] + bIm[k])) < 1e-3,
            `k=${k} 虚部不满足叠加：${sIm[k]} vs ${aIm[k] + bIm[k]}`);
    }
});

test('fft：n≤1 是空操作（不抛、不改）', () => {
    const r0 = new Float32Array(0);
    const i0 = new Float32Array(0);
    fft(r0, i0);
    assert.equal(r0.length, 0);

    const r1 = new Float32Array([3.5]);
    const i1 = new Float32Array([-1.5]);
    fft(r1, i1);
    assert.equal(r1[0], 3.5);
    assert.equal(i1[0], -1.5);
});

/* ==================== _hannWindow ==================== */

test('hannWindow：端点≈0、对称、峰值、值域 [0,1]', () => {
    for (const n of [8, 64, 1024]) {
        const w = hannWindow(n);
        assert.equal(w.length, n, `长度应为 ${n}`);
        assert.ok(Math.abs(w[0]) < 1e-6, `w[0] 应为 0，实际 ${w[0]}`);
        assert.ok(Math.abs(w[n - 1]) < 1e-6, `w[${n - 1}] 应为 0，实际 ${w[n - 1]}`);

        let max = -Infinity;
        for (let i = 0; i < n; i++) {
            assert.ok(w[i] >= 0 && w[i] <= 1, `w[${i}]=${w[i]} 越界 [0,1]`);
            if (w[i] > max) max = w[i];
            /* 对称：n=1024 时 float32 累积误差可控，给 1e-5 容差 */
            assert.ok(Math.abs(w[i] - w[n - 1 - i]) < 1e-5,
                `n=${n} 不对称：w[${i}]=${w[i]} vs w[${n - 1 - i}]=${w[n - 1 - i]}`);
        }
        assert.ok(max > 0.9 && max <= 1, `n=${n} 峰值应接近 1，实际 ${max}`);
    }
});

/* ==================== _cosineSim ==================== */

test('cosineSim：同向=1、正交=0、零向量=0（不是 NaN）、尺度无关、对称', () => {
    assert.ok(Math.abs(cosineSim([1, 2, 3], [1, 2, 3]) - 1) < 1e-9, '自身相似度应为 1');
    assert.ok(Math.abs(cosineSim([1, 0], [0, 1])) < 1e-9, '正交应为 0');
    assert.ok(Math.abs(cosineSim([1, 1], [2, 2]) - 1) < 1e-9, '应尺度无关');

    /* 零向量：分母 sqrt(0)*sqrt(2)=0 → 代码用 `|| 1` 兜底，故结果为 0 而非 NaN */
    const z = cosineSim([0, 0], [1, 1]);
    assert.ok(Number.isFinite(z), `零向量不应产出 NaN/Infinity，实际 ${z}`);
    assert.equal(z, 0);

    /* 对称 */
    const a = [0.1, 0.9, 0.4, 0.2];
    const b = [0.7, 0.1, 0.3, 0.5];
    assert.ok(Math.abs(cosineSim(a, b) - cosineSim(b, a)) < 1e-9, '应对称');
});

/* ==================== _identifyChorus ==================== */

const SHAPE_BRIGHT = [3, 1, 1, 1, 3, 1, 1, 1, 3, 1, 1, 1, 3, 1, 1, 1];
const SHAPE_BASS = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0.5, 0.4, 0.3, 0.2, 0.1, 0.1, 0.1];

/**
 * 按「时间段 → (能量, 谱形)」配方铺 frame 序列。
 * 产物与 _computeBandEnergy 同构：{ bands: Float32Array(16), energy }，
 * 且 frames[].bands 的占比就是该段谱形——于是同谱形的两段会得到相同 signature，
 * 正好触发 _identifyChorus 第 7 步的「频谱重复检测」。
 * @param {number} durationSec
 * @param {Array<{from:number,to:number,energy:number,shape:number[]}>} blocks
 */
function synthFrames(durationSec, blocks) {
    const hopSec = HOP / SR;
    const n = Math.round(durationSec / hopSec);
    const frames = [];
    const lastBlock = blocks[blocks.length - 1];
    for (let i = 0; i < n; i++) {
        const t = i * hopSec;
        const blk = blocks.find((b) => t >= b.from && t < b.to) || lastBlock;
        const bands = new Float32Array(BANDS);
        let shapeSum = 0;
        for (let b = 0; b < BANDS; b++) shapeSum += blk.shape[b % blk.shape.length];
        for (let b = 0; b < BANDS; b++) {
            bands[b] = (blk.shape[b % blk.shape.length] / (shapeSum || 1)) * blk.energy;
        }
        frames.push({ bands: bands, energy: blk.energy });
    }
    return frames;
}

/** 结构合法，且这些不变量必须无条件成立 */
function assertSegmentInvariants(result, durationSec, numBands) {
    const { allSegments, chorusSegments } = result;
    for (const s of allSegments) {
        assert.ok(Number.isFinite(s.start) && Number.isFinite(s.end), `段时间必须有限：${s.start}~${s.end}`);
        assert.ok(s.end > s.start, `段 end(${s.end}) 必须大于 start(${s.start})`);
        assert.ok(s.end - s.start >= 6 - 1e-9, `第 6 步过滤：段长 ${s.end - s.start}s 应 ≥6s`);
        assert.ok([0, 1, 2].includes(s.label), `label 应 ∈{0,1,2}，实际 ${s.label}`);
        assert.ok(s.signature.length === numBands, `signature 维度应为 ${numBands}，实际 ${s.signature.length}`);
        const sigSum = s.signature.reduce((a, v) => a + v, 0);
        assert.ok(Math.abs(sigSum - 1) < 1e-4, `signature 应归一（和=1），实际 ${sigSum}`);
        assert.ok(s.energy >= 0 && s.energy <= 1 + 1e-9, `归一化能量应 ∈[0,1]，实际 ${s.energy}`);
    }
    /* 升序且不重叠（第 6 步合并同类 + 第 10 步按 start 排序保证） */
    for (let i = 1; i < allSegments.length; i++) {
        assert.ok(allSegments[i].start >= allSegments[i - 1].start, '段必须按 start 升序');
        assert.ok(allSegments[i].start >= allSegments[i - 1].end - 1e-9,
            `段 ${i - 1}(${allSegments[i - 1].start}~${allSegments[i - 1].end}) 与段 ${i}(${allSegments[i].start}~${allSegments[i].end}) 重叠`);
    }

    for (const c of chorusSegments) {
        assert.ok(c.end > c.start, `高潮段 end 必须大于 start：${c.start}~${c.end}`);
        assert.ok(c.start >= -1e-9 && c.end <= durationSec + 1e-9,
            `高潮段 ${c.start}~${c.end} 应落在 [0, ${durationSec}] 内`);
        assert.ok(typeof c.reason === 'string' && c.reason.length > 0, '高潮段必须带 reason');
    }
    for (let i = 1; i < chorusSegments.length; i++) {
        assert.ok(chorusSegments[i].start >= chorusSegments[i - 1].start, '高潮段必须按 start 升序');
    }
    const total = chorusSegments.reduce((a, c) => a + (c.end - c.start), 0);
    assert.ok(total <= durationSec * 0.5 + 1e-6,
        `第 11 步封顶：高潮总长 ${total}s 应 ≤ 时长的一半 ${durationSec * 0.5}s`);
}

/** 100s 合成轨：「响 + 同谱」两段（20-40s 与 60-80s），中间与头尾是安静的另一种谱形 */
const DUR_SYNTH = 100;
function synthTrack() {
    return synthFrames(DUR_SYNTH, [
        { from: 0, to: 20, energy: 0.05, shape: SHAPE_BASS },
        { from: 20, to: 40, energy: 1.0, shape: SHAPE_BRIGHT },
        { from: 40, to: 60, energy: 0.05, shape: SHAPE_BASS },
        { from: 60, to: 80, energy: 1.0, shape: SHAPE_BRIGHT },
        { from: 80, to: 100, energy: 0.05, shape: SHAPE_BASS },
    ]);
}

test('identifyChorus：段不变量 + 覆盖率封顶（响段/同谱合成轨）', () => {
    const result = identifyChorus(synthTrack(), HOP, SR, DUR_SYNTH);
    assert.ok(Array.isArray(result.allSegments), 'allSegments 必须是数组');
    assert.ok(Array.isArray(result.chorusSegments), 'chorusSegments 必须是数组');
    assert.ok(result.chorusSegments.length > 0, '合成轨有明显响段，不该一个高潮都没检出');
    assertSegmentInvariants(result, DUR_SYNTH, BANDS);
});

test('identifyChorus：检出的高潮段确实落在响段上（20-40s / 60-80s）', () => {
    const result = identifyChorus(synthTrack(), HOP, SR, DUR_SYNTH);
    const LOUD = [[20, 40], [60, 80]];
    const overlapsLoud = result.chorusSegments.some((c) =>
        LOUD.some(([a, b]) => c.start < b && c.end > a));
    assert.ok(overlapsLoud,
        `高潮段应覆盖响段之一，实际 ${JSON.stringify(result.chorusSegments.map((c) => [c.start, c.end]))}`);
    /* 反向：不该整段落在纯安静区（0-20 / 40-60 之间那些以安静为主的地带） */
    const entirelyQuiet = result.chorusSegments.some((c) => c.end <= 20 || (c.start >= 40 && c.end <= 60));
    assert.ok(!entirelyQuiet,
        `不该有高潮段整段落在安静区，实际 ${JSON.stringify(result.chorusSegments.map((c) => [c.start, c.end]))}`);
});

test('identifyChorus：确定性 —— 同输入两次结果完全一致', () => {
    const a = identifyChorus(synthTrack(), HOP, SR, DUR_SYNTH);
    const b = identifyChorus(synthTrack(), HOP, SR, DUR_SYNTH);
    assert.deepEqual(a, b, '纯算法必须确定性（禁 Math.random / 时间戳）');
});

test('identifyChorus：非法 duration → 用帧数×hop/采样率兜底', () => {
    const frames = synthTrack();
    const result = identifyChorus(frames, HOP, SR, 0);
    const expected = frames.length * HOP / SR;
    assertSegmentInvariants(result, expected, BANDS);
    /* 兜底时长必须真的被用上（而不是留下 0/NaN 污染段边界） */
    for (const s of result.allSegments) {
        assert.ok(s.end <= expected + 1e-9, `段 end ${s.end} 不应超过兜底时长 ${expected}`);
    }
});

test('identifyChorus：全静音输入不抛、不产出 NaN（记录退化行为，见下）', () => {
    /* ★ 已知退化行为（实测，本轮未改）：
       全 0 帧序列下 smoothed 全为 0，第 3 步走 `rawMax=0.001 / range=0.001` 的兜底，
       归一化后所有帧能量都是 0；而三级阈值此时 median=high=low=0，于是每帧都满足
       `energy >= highThresh` → 整段 label 2 → 第 8 步因 energy(0) 不 >0.85 判定失败 →
       第 9 步「回退 A」取能量最高的 2 段 → 得到 **1 个覆盖全曲的段**。
       又因第 11 步的覆盖率封顶带 `finalChorus.length > 1` 守卫，单段时不触发。
       对真实音频无影响（解码后的 PCM 总有底噪），故此处只钉「不抛/不 NaN/不越界」，
       不把该退化结果固化成期望；真要对齐「无信息 → 不报高潮」需改算法，另立项。 */
    const DUR = 60;
    const frames = synthFrames(DUR, [{ from: 0, to: DUR, energy: 0, shape: SHAPE_BASS }]);
    const result = identifyChorus(frames, HOP, SR, DUR);
    for (const s of result.allSegments) {
        assert.ok(Number.isFinite(s.energy) && Number.isFinite(s.start) && Number.isFinite(s.end),
            `静音输入不应产出 NaN：${JSON.stringify(s)}`);
        assert.ok(s.start >= -1e-9 && s.end <= DUR + 1e-9, `段越界：${s.start}~${s.end}`);
    }
    for (const c of result.chorusSegments) {
        assert.ok(Number.isFinite(c.start) && Number.isFinite(c.end),
            `静音输入的高潮段不应含 NaN：${JSON.stringify(c)}`);
        assert.ok(c.start >= -1e-9 && c.end <= DUR + 1e-9, `高潮段越界：${c.start}~${c.end}`);
    }
    /* 无条件成立的上界（比第 11 步的 50% 弱，任何输入都该满足） */
    const total = result.chorusSegments.reduce((a, c) => a + (c.end - c.start), 0);
    assert.ok(total <= DUR + 1e-6, `高潮总长 ${total}s 不应超过歌曲时长 ${DUR}s`);
});

test('identifyChorus：onProgress 收到过程日志（Worker 路径同款回调）', () => {
    const msgs = [];
    identifyChorus(synthTrack(), HOP, SR, DUR_SYNTH, (m) => msgs.push(m));
    assert.ok(msgs.length > 0, '应回传过程日志');
    assert.ok(msgs.some((m) => String(m).includes('帧数')), `应包含帧数日志，实际首条 ${msgs[0]}`);
});
