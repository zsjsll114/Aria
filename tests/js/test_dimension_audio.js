/* ============================================================
 * tests/js/test_dimension_audio.js — 穿行模式的真实频谱分支
 *
 * 关键回归（用户实测「粒子不跟真实频谱」）：
 *   有 AnalyserNode 时必须一直用真实数据拼接，不能因为"能量低"
 *   偷偷切回合成节拍；只有完全拿不到采集通道时才允许合成兜底。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DimensionAudio } from '../../web/src/core/visualizers/dimension/DimensionAudio.js';

/**
 * @param {number[]} values 64 个频段值
 */
function makeAnalyser(values) {
    return {
        frequencyBinCount: 64,
        getByteFrequencyData(out) {
            for (let i = 0; i < out.length; i++) out[i] = values[i] || 0;
        },
    };
}

/** @param {any} win @param {() => void} fn */
function withWindow(win, fn) {
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
    const prev = /** @type {any} */ (globalThis).window;
    /** @type {any} */ (globalThis).window = win;
    try {
        fn();
    } finally {
        if (had) /** @type {any} */ (globalThis).window = prev;
        else delete /** @type {any} */ (globalThis).window;
    }
}

test('D1 低/中/高频分别进入 bass / mid / treble', () => {
    withWindow({ audio: {}, playerAudioAnalyser: makeAnalyser(Array.from({ length: 64 }, (_, i) => (i < 4 ? 255 : 0))) }, () => {
        const audio = new DimensionAudio();
        audio.update(1, true);
        assert.ok(audio.bass > 0.15, `bass 应被真实低频推高，实际 ${audio.bass}`);
        assert.ok(audio.mid < 0.02);
    });

    withWindow({ audio: {}, playerAudioAnalyser: makeAnalyser(Array.from({ length: 64 }, (_, i) => (i >= 24 ? 255 : 0))) }, () => {
        const audio = new DimensionAudio();
        audio.update(1, true);
        assert.ok(audio.treble > 0.15, `treble 应被真实高频推高，实际 ${audio.treble}`);
    });
});

test('D2 真实数据全 0 时不得切回合成节拍', () => {
    withWindow({ audio: {}, playerAudioAnalyser: makeAnalyser([]) }, () => {
        const audio = new DimensionAudio();
        for (let i = 0; i < 8; i++) audio.update(i * 0.1, true);
        assert.ok(audio.freqData.every(v => v === 0), '安静段落必须保持真实 0，而不是编造假频谱');
        assert.ok(audio.bass < 0.01);
        assert.ok(audio.overall < 0.01);
    });
});

test('D3 完全拿不到采集通道时才允许合成兜底（画面不会死）', () => {
    withWindow({ audio: {}, playerAudioAnalyser: null }, () => {
        const audio = new DimensionAudio();
        audio.update(1, true);
        assert.ok(audio.freqData.some(v => v > 0), '无频谱来源时应有合成节拍');
        assert.ok(audio.bass > 0.1);
    });
});

test('D4 暂停时频谱与能量一起衰减，避免粒子挂在最后一帧', () => {
    withWindow({ audio: {}, playerAudioAnalyser: makeAnalyser([]) }, () => {
        const audio = new DimensionAudio();
        audio.freqData[0] = 200;
        audio.freqData[1] = 100;
        audio.bass = 1;
        audio.overall = 1;
        audio.update(1, false);
        assert.ok(audio.freqData[0] < 200);
        assert.ok(audio.freqData[1] < 100);
        assert.ok(audio.bass < 1);
        assert.ok(audio.overall < 1);
    });
});
