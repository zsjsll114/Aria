/* ============================================================
 * tests/js/test_automix_envelope.js — Automix 分析管线行为测试（Phase 0）
 *
 * 盯两层：
 *   · core/automix/envelope.js 纯信号函数：合成音频夹具构造**已知边界**，
 *     验证 intro/outro/outroSparse/bpm+confidence 的数学正确性；
 *   · core/automix/analyzer.js 的失败语义：fetch/decode 全程注入，
 *     任何一步失败必须返回 null 且不抛出（方案 §3.1「永不阻塞播放主链」）。
 * 手法：22050Hz 单声道正弦 + 静音段 + 线性淡出 + 2Hz 幅度调制（120BPM 拍点）。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const env = await import('../../web/src/core/automix/envelope.js');
const analyzer = await import('../../web/src/core/automix/analyzer.js');

const RATE = 22050;

/** 生成一段合成音频：前置静音 + 正弦主体 + 可选线性淡出尾 */
function makeTone({ totalSec = 5, silenceSec = 0, freq = 440, amp = 0.5, fadeOutSec = 0 } = {}) {
    const n = Math.round(totalSec * RATE);
    const out = new Float32Array(n);
    const silenceN = Math.round(silenceSec * RATE);
    const bodyEnd = n - Math.round(fadeOutSec * RATE); /* 淡出起点 */
    for (let i = 0; i < n; i++) {
        if (i < silenceN || i >= bodyEnd) continue;
        let a = amp;
        if (fadeOutSec > 0) a = amp * (1 - (i - bodyEnd) / (n - bodyEnd));
        out[i] = a * Math.sin(2 * Math.PI * freq * i / RATE);
    }
    return out;
}

/** 2Hz 幅度调制的 220Hz 载波（拍点周期 0.5s = 120 BPM） */
function makeBeatTone({ totalSec = 12, beatsPerSec = 2 } = {}) {
    const n = Math.round(totalSec * RATE);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const t = i / RATE;
        const am = 0.5 * (0.5 + 0.5 * Math.sin(2 * Math.PI * beatsPerSec * t)); /* 0~0.5 */
        out[i] = am * Math.sin(2 * Math.PI * 220 * t);
    }
    return out;
}

test('intro: 0.5s 前置静音被裁掉，误差 ±100ms', () => {
    const samples = makeTone({ silenceSec: 0.5 });
    const r = env.analyzeEnvelope(samples, RATE);
    assert.ok(Math.abs(r.introPointMs - 500) <= 100, `introPointMs=${r.introPointMs}`);
});

test('intro: 开场即有声不裁（返回 0）', () => {
    const samples = makeTone({ silenceSec: 0 });
    const r = env.analyzeEnvelope(samples, RATE);
    assert.equal(r.introPointMs, 0);
});

test('outro: 1s 线性淡出，衰减起点落在淡出区间内，稀疏点更靠后', () => {
    /* 3.5~4.5s 为淡出段（主体 3.5s） */
    const samples = makeTone({ totalSec: 5, fadeOutSec: 1 });
    const r = env.analyzeEnvelope(samples, RATE);
    assert.ok(r.outroPointMs > 3300 && r.outroPointMs < 4400,
        `outroPointMs=${r.outroPointMs} 应落在淡出起点附近`);
    assert.ok(r.outroSparsePointMs > r.outroPointMs,
        `稀疏点(${r.outroSparsePointMs})应比衰减起点更靠后`);
    assert.ok(r.outroSparsePointMs <= r.durationMs);
});

test('outro: 突然截断（无淡出）→ 两点都等于全曲时长（调度层降级 segue 的信号）', () => {
    const samples = makeTone({ totalSec: 5, fadeOutSec: 0 });
    const r = env.analyzeEnvelope(samples, RATE);
    assert.equal(r.outroPointMs, r.durationMs);
    assert.equal(r.outroSparsePointMs, r.durationMs);
});

test('bpm: 2Hz 拍点调制 → 120 ± 8，置信度显著', () => {
    const samples = makeBeatTone({});
    const r = env.analyzeEnvelope(samples, RATE);
    assert.ok(r.bpm !== null, '有拍点内容必须收敛出 bpm');
    assert.ok(Math.abs(r.bpm - 120) <= 8, `bpm=${r.bpm}`);
    assert.ok(r.bpmConfidence > 1.5, `confidence=${r.bpmConfidence}（Phase 2 调度层合格线 1.2）`);
});

test('bpm: 恒定无拍点内容 → bpm null + confidence 0（调度层按置信度低降级）', () => {
    /* 恒定正弦：包络常数，onset 全 0 */
    const samples = makeTone({ totalSec: 5, freq: 220 });
    const r = env.analyzeEnvelope(samples, RATE);
    assert.equal(r.bpm, null);
    assert.equal(r.bpmConfidence, 0);
});

test('meanEnergy 在合理量级（有声包络均值 0.01~0.5）', () => {
    const samples = makeTone({});
    const r = env.analyzeEnvelope(samples, RATE);
    assert.ok(r.meanEnergy > 0.01 && r.meanEnergy < 0.5, `meanEnergy=${r.meanEnergy}`);
});

/* ========== analyzer.js：失败语义（node 下用注入绕开浏览器 API） ========== */

function fakeDecoder(durationMs = 30000) {
    return async () => ({
        samples: new Float32Array(100),
        sampleRate: RATE,
        durationMs,
    });
}

test('analyzer: 正常路径返回完整结果且带缓存键；过短音频返回 null', async () => {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(url); return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }; };
    const r = await analyzer.analyzeTrack({ id: 'song-1', url: 'http://x/a.mp3', title: '测试曲' }, { fetchImpl, decodeImpl: fakeDecoder(30000) });
    assert.ok(r, '30s 音频应分析成功');
    assert.equal(r.durationMs, 30000);
    assert.ok('introPointMs' in r && 'outroPointMs' in r && 'bpm' in r && 'bpmConfidence' in r);
    assert.equal(calls.length, 1);
    assert.equal(analyzer.automixCacheKey({ id: 'song-1' }), 'automix:v1:song-1');

    const short = await analyzer.analyzeTrack({ id: 'song-2', url: 'http://x/b.mp3' }, { fetchImpl, decodeImpl: fakeDecoder(5000) });
    assert.equal(short, null, '15s 以下不分析');
});

test('analyzer: fetch 失败 / 解码抛错 / 缺参数 → 全部返回 null 且不抛出', async () => {
    const failFetch = async () => ({ ok: false, status: 403 });
    const boomDecode = async () => { throw new Error('decode error'); };
    assert.equal(await analyzer.analyzeTrack({ id: 'a', url: 'http://x/1' }, { fetchImpl: failFetch, decodeImpl: fakeDecoder() }), null);
    assert.equal(await analyzer.analyzeTrack({ id: 'b', url: 'http://x/2' }, { fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }), decodeImpl: boomDecode }), null);
    assert.equal(await analyzer.analyzeTrack(null, {}), null);
    assert.equal(await analyzer.analyzeTrack({}, {}), null);
});

test('analyzer: 缺 id 时用 url hash 生成稳定缓存键', () => {
    const k1 = analyzer.automixCacheKey({ url: 'http://x/same.mp3' });
    const k2 = analyzer.automixCacheKey({ url: 'http://x/same.mp3' });
    const k3 = analyzer.automixCacheKey({ url: 'http://x/other.mp3' });
    assert.equal(k1, k2);
    assert.notEqual(k1, k3);
    assert.ok(k1.startsWith('automix:v1:url:'));
});
