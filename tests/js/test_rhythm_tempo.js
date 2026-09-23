/* ============================================================
 * tests/js/test_rhythm_tempo.js — BPM 节拍估计单测
 * 运行方式：node --test tests/js/test_rhythm_tempo.js
 *   （Node ≥ 22 内置 test runner；零第三方依赖）
 * 覆盖（core/chorusDetector.js v4.3 新增 _estimateTempo，folia 作者方案：
 *   「先测 BPM，FFT 拿节奏信息」）：
 *   合成节拍音轨 120/90 BPM 检出 / 静音低置信度 / 短输入 null /
 *   拍相位落在节拍栅格上 / STFT 帧生成器的基础行为
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    estimateTempo,
    computeBandEnergyFrames
} from '../../web/src/core/chorusDetector.js';

const SR = 16000;

/** 合成节拍音轨：按 BPM 周期插入指数衰减的宽带 click（确定性伪随机，可复现） */
function makeClickTrack(bpm, seconds, seed = 42) {
    const n = Math.floor(seconds * SR);
    const data = new Float32Array(n);
    const period = Math.round((60 / bpm) * SR);
    const clickLen = Math.floor(0.04 * SR);
    let s = seed;
    const rand = () => {
        /* LCG：测试输入也确定性，任何失败都能原样复现 */
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return (s / 0x7fffffff) * 2 - 1;
    };
    for (let t = 0; t + clickLen < n; t += period) {
        for (let i = 0; i < clickLen; i++) {
            const env = Math.exp(-i / (0.004 * SR));
            data[t + i] += rand() * env * 0.8;
        }
    }
    return data;
}

function framesOf(samples) {
    return computeBandEnergyFrames(samples, 1024, 512, 16);
}

/* ==================== 正常检出 ==================== */
test('estimateTempo：120 BPM click → bpm∈[112,128]，置信度 > 0.2', () => {
    const samples = makeClickTrack(120, 24);
    const tempo = estimateTempo(framesOf(samples), 512, SR);
    assert.ok(tempo, '应返回结果');
    assert.ok(Math.abs(tempo.bpm - 120) <= 8, `bpm=${tempo.bpm} 应接近 120`);
    assert.ok(tempo.confidence > 0.2, `置信度 ${tempo.confidence} 应 > 0.2`);
});

test('estimateTempo：90 BPM click → bpm∈[82,98]（不折叠错档）', () => {
    const samples = makeClickTrack(90, 24);
    const tempo = estimateTempo(framesOf(samples), 512, SR);
    assert.ok(tempo, '应返回结果');
    assert.ok(Math.abs(tempo.bpm - 90) <= 8, `bpm=${tempo.bpm} 应接近 90`);
});

test('estimateTempo：拍相位落在首个节拍栅格附近（≤ 半个周期）', () => {
    const bpm = 120;
    const samples = makeClickTrack(bpm, 24);
    const tempo = estimateTempo(framesOf(samples), 512, SR);
    assert.ok(tempo, '应返回结果');
    const periodSec = 60 / bpm;
    const offset = tempo.beatOffsetSec % periodSec;
    /* onset 包络的峰可能落在 click 后 1 帧内；半个周期容差足够 */
    assert.ok(offset < periodSec / 2, `拍相位 ${tempo.beatOffsetSec}s（mod ${periodSec}s = ${offset}s）应落在半周期内`);
});

/* ==================== 边界与脏数据 ==================== */
test('estimateTempo：静音输入置信度接近 0（不算出假节拍）', () => {
    const samples = new Float32Array(SR * 12);
    const tempo = estimateTempo(framesOf(samples), 512, SR);
    if (tempo) {
        assert.ok(tempo.confidence < 0.15, `静音置信度 ${tempo.confidence} 应 < 0.15`);
    }
});

test('estimateTempo：过短/空输入返回 null', () => {
    assert.equal(estimateTempo([], 512, SR), null);
    assert.equal(estimateTempo(new Array(10).fill({ bands: new Float32Array(16), energy: 0 }), 512, SR), null);
    assert.equal(estimateTempo(framesOf(new Float32Array(4096)), 512, SR), null);
    assert.equal(estimateTempo(framesOf(makeClickTrack(120, 24)), 0, SR), null, '非法采样率');
});

/* ==================== STFT 帧生成器基础行为 ==================== */
test('computeBandEnergyFrames：帧数/维度/能量非负', () => {
    const samples = makeClickTrack(100, 6);
    const frames = computeBandEnergyFrames(samples, 1024, 512, 16);
    const expected = Math.floor((samples.length - 1024) / 512) + 1;
    assert.equal(frames.length, expected);
    assert.equal(frames[0].bands.length, 16);
    for (const f of frames.slice(0, 50)) {
        assert.ok(f.energy >= 0);
        assert.ok(f.bands.every(b => b >= 0));
    }
    /* click 处的能量显著高于间隙 */
    const energies = frames.map(f => f.energy);
    const max = Math.max(...energies);
    const median = [...energies].sort((a, b) => a - b)[Math.floor(energies.length / 2)];
    assert.ok(max > median * 2, `click 帧能量 (${max}) 应远高于中位 (${median})`);
});
