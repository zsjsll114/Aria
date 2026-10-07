import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../../web/src/core/energyMotion.js');
const {
	LOW_BIN_COUNT, ENERGY_MAX_SCALE_CAP, ENERGY_DEFAULTS,
	lowEnergyFromFreqData, scaleFromLevel, createEnergyMotion,
} = mod;

/* ---------------- 低频能量取法 ---------------- */

test('低频能量：取前 N 个 bin 的平均（不是峰值，免得被单个尖峰带飞）', () => {
	const freq = new Uint8Array([255, 255, 0, 0, 0, 0, 255, 255]);
	assert.equal(lowEnergyFromFreqData(freq), 0.5);
	assert.equal(lowEnergyFromFreqData(freq, 2), 1);
	assert.equal(lowEnergyFromFreqData(freq, 8), 0.5);
});

test('低频能量：空/非法/超界输入都不抛', () => {
	assert.equal(lowEnergyFromFreqData(null), 0);
	assert.equal(lowEnergyFromFreqData([]), 0);
	assert.equal(lowEnergyFromFreqData({ length: 0 }), 0);
	assert.equal(lowEnergyFromFreqData([NaN, NaN]), 0);
	/* bins 超过数组长度时按长度夹取，不许读越界 */
	assert.equal(lowEnergyFromFreqData(new Uint8Array([255, 0]), 99), 0.5);
	assert.equal(lowEnergyFromFreqData(new Uint8Array([255, 0]), 0), 0.5, 'bins<=0 回落默认值（再按数组长度夹取）');
	assert.equal(LOW_BIN_COUNT, 4);
});

/* ---------------- 缩放映射 ---------------- */

test('缩放映射：0 → 1.00，1 → 1.02，且 2% 是硬上限（传参也放大不了）', () => {
	assert.equal(scaleFromLevel(0), 1);
	assert.equal(scaleFromLevel(1), ENERGY_MAX_SCALE_CAP);
	assert.equal(scaleFromLevel(0.5), 1.01);
	assert.equal(scaleFromLevel(999), ENERGY_MAX_SCALE_CAP);
	assert.equal(scaleFromLevel(-5), 1);
	assert.equal(scaleFromLevel(NaN), 1);
	assert.equal(scaleFromLevel(1, { maxScale: 1.5 }), ENERGY_MAX_SCALE_CAP, '调用方不能突破上限');
});

/* ---------------- 包络 ---------------- */

test('包络：首帧直接到位（否则每次开始播放都要等几百毫秒才见第一次呼吸）', () => {
	const m = createEnergyMotion();
	const st = m.update(1, 0);
	assert.equal(st.level, 1);
	assert.equal(st.scale, ENERGY_MAX_SCALE_CAP);
});

test('包络：阈值以下视为安静，直接回落（挡掉底噪导致的持续微颤）', () => {
	const m = createEnergyMotion({ threshold: 0.2 });
	assert.equal(m.update(0.1, 0).level, 0);
	assert.equal(m.update(0, 1000).level, 0);
	/* 刚过阈值只是"刚开始动"，不是一步跳满 */
	const just = createEnergyMotion({ threshold: 0.2 }).update(0.21, 0);
	assert.ok(just.level > 0 && just.level < 0.05, `刚过阈值不应跳满，实得 ${just.level}`);
});

test('包络：起得快、落得慢（这是手感核心，反过来会像抽搐）', () => {
	const up = createEnergyMotion({ attackMs: 60, releaseMs: 420 });
	up.update(0, 0);
	const rising = up.update(1, 100);       /* 100ms 内向 1 逼近 */

	const down = createEnergyMotion({ attackMs: 60, releaseMs: 420 });
	down.update(1, 0);                      /* 首帧到 1 */
	const falling = down.update(0, 100);    /* 100ms 内从 1 回落 */

	assert.ok(rising.level > 0.5, `100ms 内应基本涨起来，实得 ${rising.level}`);
	/* ★ 关键不是"谁的绝对值大"——上升从 0 出发、回落从 1 出发，绝对值不可比。
	   要比的是**走完了多少路**：上升 100ms 走完 >50%，回落 100ms 只走完 <50%。 */
	const riseProgress = rising.level;
	const fallProgress = 1 - falling.level;
	assert.ok(riseProgress > 0.5, `上升 100ms 应走完过半，实得 ${riseProgress}`);
	assert.ok(fallProgress < 0.5, `回落 100ms 应明显落后于上升，实得 ${fallProgress}`);
	assert.ok(riseProgress > fallProgress, '同样的 100ms，回落进度必须小于上升进度');
});

test('包络：单调逼近目标，不越界不回弹过头', () => {
	const m = createEnergyMotion({ attackMs: 50, releaseMs: 400 });
	m.update(0, 0);
	let prev = 0;
	for (let t = 20; t <= 400; t += 20) {
		const st = m.update(1, t);
		assert.ok(st.level >= prev - 1e-9, '上升段必须单调不减');
		assert.ok(st.level <= 1.0000001, '不许越过 1');
		assert.ok(st.scale <= ENERGY_MAX_SCALE_CAP + 1e-9, '缩放不许越过硬上限');
		prev = st.level;
	}
	assert.ok(prev > 0.9);
});

test('包络：NaN / 负值 / 缺时间都不抛，且不产生非法缩放', () => {
	const m = createEnergyMotion();
	for (const bad of [NaN, undefined, null, -3, Infinity]) {
		const st = m.update(bad, 100);
		assert.ok(Number.isFinite(st.level) && st.level >= 0 && st.level <= 1);
		assert.ok(st.scale >= 1 && st.scale <= ENERGY_MAX_SCALE_CAP);
	}
	assert.ok(Number.isFinite(m.update(0.5, undefined).level));
});

test('包络：reset 清零，之后按首帧规则重新到位', () => {
	const m = createEnergyMotion();
	m.update(1, 0);
	assert.equal(m.level, 1);
	m.reset();
	assert.equal(m.level, 0);
	assert.equal(m.update(1, 5000).level, 1, 'reset 后重新首帧到位');
});

test('包络：同样输入同样输出（时间由外部注入，可用于确定性回归）', () => {
	const run = () => {
		const m = createEnergyMotion();
		const seen = [];
		for (let t = 0; t <= 600; t += 50) seen.push(m.update(t % 100 === 0 ? 0.9 : 0.2, t).level);
		return seen;
	};
	assert.deepEqual(run(), run());
	assert.equal(ENERGY_DEFAULTS.maxScale, ENERGY_MAX_SCALE_CAP);
});
