/* ============================================================
 * tests/js/test_sonnet_audio_levels.js — verse（sonnet）音频驱动的折算契约
 *
 * 为什么值得单测：这条链断过一次，而且是**静默**断的 ——
 * SonnetEngine 读的 `globalThis.__sonnetAudioLevels` 全仓没有任何地方写，
 * 于是恒 null → 三个参数恒 0 → `sonnetShotMgFull` 里
 * `audioEnergy = bass*0.34 + vocal*0.52 + power*0.14` 恒 0（还要过一道 0.08 门限），
 * 背景几何生长/图标脉动整块死掉，画面上只表现为"不跟音乐走"，没有任何报错。
 *
 * 本文件钉住三件事：
 *   ① 频段切分与 bin 映射（共享 analyser 是 fftSize=128 的粗分辨率，低频会落进 bin 0）；
 *   ② 上游 `process()` 的指数提升口径；
 *   ③ **刻度是 0~255 而不是 0~1** —— 移植过来的 MG 用
 *      `normalizeAudioLevel(v) = v > 1 ? v / 255 : v`，两种刻度虽然都能算，
 *      但只有 0~255 与上游的响应**幅度**一致。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	SONNET_BANDS_HZ, SONNET_BAND_BOOST, bandAverage, bandBinRange, boostBand, resolveSonnetAudioLevels,
} from '../../web/src/core/visualizers/sonnet/sonnetAudioLevels.js';

/* 共享 analyser 的实际参数：equalizer.js:849 建的 fftSize=128 → 64 个 bin
   （44.1kHz 下每 bin ≈ 344.5Hz） */
const SR = 44100;
const FFT = 128;
const BINS = FFT / 2;

const spectrumOf = (fill) => Uint8Array.from({ length: BINS }, (_, i) => (typeof fill === 'function' ? fill(i) : fill));

test('SA1 频段 → bin 映射：粗分辨率下低频必然落进前几格', () => {
	assert.deepEqual(bandBinRange(20, 150, SR, FFT, BINS), { from: 0, to: 0 }, '20~150Hz 只落在 bin 0');
	assert.deepEqual(bandBinRange(150, 400, SR, FFT, BINS), { from: 0, to: 1 });
	const vocal = bandBinRange(1000, 3500, SR, FFT, BINS);
	assert.equal(vocal.from, 2, '1000Hz ≈ bin 2.9');
	assert.equal(vocal.to, 10, '3500Hz ≈ bin 10.2');
	/* 越界/垃圾输入不得算出负下标或 NaN */
	for (const bad of [[0, 0], [-5, 10], [1e9, 2e9], [20, 150]]) {
		const r = bandBinRange(bad[0], bad[1], SR, FFT, BINS);
		assert.ok(r.from >= 0 && r.to >= 0 && r.to <= BINS - 1 && r.from <= r.to, `${bad} → ${JSON.stringify(r)}`);
	}
	assert.deepEqual(bandBinRange(20, 150, 0, 0, 0), { from: 0, to: 0 }, '拿不到采样率时退化成 bin 0，不抛');
	assert.deepEqual(bandBinRange(NaN, NaN, SR, FFT, BINS), { from: 0, to: 0 });
});

test('SA2 boostBand 与上游 process() 同口径：pow(v/255, boost) * 255', () => {
	assert.equal(boostBand(255, 1.8), 255, '满值提升后仍是满值');
	assert.equal(boostBand(0, 3), 0, '静音恒为 0');
	assert.ok(Math.abs(boostBand(128, 1) - 128) < 1e-9, 'boost=1 时是恒等映射');
	const boosted = boostBand(128, 3);
	assert.ok(Math.abs(boosted - Math.pow(128 / 255, 3) * 255) < 1e-9, `与公式一致，实得 ${boosted}`);
	assert.ok(boosted < 40, `三次方提升会明显压低中等电平，实得 ${boosted}`);
	/* 单调 + 值域 */
	let prev = -1;
	for (let v = 0; v <= 255; v += 5) {
		const out = boostBand(v, 1.8);
		assert.ok(out >= prev, '必须单调不减');
		assert.ok(out >= 0 && out <= 255, '必须落在 0~255');
		prev = out;
	}
	assert.equal(boostBand(NaN, 1.8), 0, 'NaN 不得扩散');
	assert.equal(boostBand(-10, 1.8), 0);
	assert.equal(boostBand(999, 1.8), 255, '超界夹回 255');
});

test('SA3 静音与异常输入：一律给确定的 0，不抛', () => {
	const silent = resolveSonnetAudioLevels(spectrumOf(0), SR, FFT);
	assert.deepEqual(silent, { bass: 0, power: 0, vocal: 0 });
	for (const bad of [null, undefined, [], new Uint8Array(0), 'nope', 123]) {
		assert.deepEqual(resolveSonnetAudioLevels(bad, SR, FFT), { bass: 0, power: 0, vocal: 0 }, `${bad} 应给全 0`);
	}
	/* NaN 项不得污染整条曲线 */
	const dirty = Uint8Array.from({ length: BINS }, (_, i) => (i % 3 === 0 ? NaN : 200));
	const out = resolveSonnetAudioLevels(dirty, SR, FFT);
	assert.ok(Object.values(out).every((v) => Number.isFinite(v)), 'NaN 不得扩散');
});

test('SA4 ★ 刻度契约：0~255（不是 0~1），且只吐引擎消费的三个键', () => {
	const keys = Object.keys(resolveSonnetAudioLevels(spectrumOf(128), SR, FFT)).sort();
	assert.deepEqual(keys, ['bass', 'power', 'vocal'],
		'引擎只消费这三个（sonnetShotMgFull 的 updateTime 签名），多吐键没有意义、少吐会变 undefined');

	/* 中等电平必须 > 1：这正是 0~255 与 0~1 的分界（MG 的 normalizeAudioLevel 按 v > 1 判刻度） */
	const mid = resolveSonnetAudioLevels(spectrumOf(128), SR, FFT);
	assert.ok(mid.bass > 1 && mid.vocal > 1, `中等电平应远大于 1（实得 bass=${mid.bass}），说明是 0~255 刻度`);
	assert.ok(mid.bass <= 255 && mid.vocal <= 255 && mid.power <= 255, '不得超过 255');

	const full = resolveSonnetAudioLevels(spectrumOf(255), SR, FFT);
	assert.deepEqual(full, { bass: 255, power: 255, vocal: 255 }, '满谱应给满值');
});

test('SA5 频段互不串：只有 bin 0 有能量时，低频有值、人声段为 0', () => {
	const onlyBass = spectrumOf((i) => (i === 0 ? 255 : 0));
	const out = resolveSonnetAudioLevels(onlyBass, SR, FFT);
	assert.equal(out.bass, 255, 'bin 0 属于 bass');
	assert.equal(out.vocal, 0, 'vocal 取 bin 2~10，不该被 bin 0 带起来');
	/* power 用的是 (bass + lowMid) / 2：lowMid 取 bin 0~1 的**均值**（这里 = 127.5），
	   所以峰值的那一格被摊掉了一半 —— 这就是"取平均不取峰值"的直接体现。 */
	const expectedPower = Math.pow(((255 + 127.5) / 2) / 255, 3) * 255;
	assert.ok(Math.abs(out.power - expectedPower) < 1e-6,
		`power = process((bass+lowMid)/2)，实得 ${out.power} / 期望 ${expectedPower}`);

	const onlyVocal = spectrumOf((i) => (i >= 2 && i <= 10 ? 255 : 0));
	const v = resolveSonnetAudioLevels(onlyVocal, SR, FFT);
	assert.equal(v.vocal, 255);
	assert.equal(v.bass, 0, 'bass 只看 bin 0');
});

test('SA6 bandAverage：取平均而不是峰值（单个尖峰 bin 不该带飞整段）', () => {
	const flat = Uint8Array.from([100, 100, 100, 100]);
	assert.equal(bandAverage(flat, 0, 3), 100);
	const spiky = Uint8Array.from([255, 0, 0, 0]);
	assert.equal(bandAverage(spiky, 0, 3), 255 / 4, '平均值就被 1/4 摊平了');
	/* 区间夹回合法范围 */
	assert.equal(bandAverage(flat, -5, 99), 100);
	assert.equal(bandAverage(null, 0, 3), 0);
	assert.equal(bandAverage(new Uint8Array(0), 0, 3), 0);
});

test('SA7 常量表与上游 getEnergy 的频段/指数一致（改动必须是有意的）', () => {
	assert.deepEqual(SONNET_BANDS_HZ, { bass: [20, 150], lowMid: [150, 400], vocal: [1000, 3500] });
	assert.deepEqual(SONNET_BAND_BOOST, { bass: 1.8, lowMid: 2, vocal: 1.5, power: 3 });
});
