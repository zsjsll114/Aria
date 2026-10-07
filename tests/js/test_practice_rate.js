/* ============================================================
 * test_practice_rate.js — 练习模式变速的纯逻辑（需求 15）
 *
 * 测 `core/practiceRate.js`（不拉 DOM，所以能在 node 里直接跑）。
 * 覆盖三件事：
 *   ① 0.05 网格取整 + **无浮点尾巴**（有尾巴会让 nativeDeck 的快照键每轮询
 *      都判成"变了"，退化成 20Hz 的 IPC 风暴）；
 *   ② 量程夹取与非法输入回落；
 *   ③ 落点决策 `practicePlanFor` —— 练习模式给出"速度 = 练习速度"，
 *      且**保音高**（2026-10-06 改：原实现为迁就独占路径的线性重采样强制关掉，
 *      结果慢放变调，练习模式等于废掉一半）。独占路径的变调由 app/85 提示。
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
	PRACTICE_MAX, PRACTICE_MIN, PRACTICE_STEP,
	clampPracticeRate, formatPracticeRate, practicePlanFor,
} from '../../web/src/core/practiceRate.js';

test('量程常量：0.5~2.0，步进 0.05', () => {
	assert.equal(PRACTICE_MIN, 0.5);
	assert.equal(PRACTICE_MAX, 2.0);
	assert.equal(PRACTICE_STEP, 0.05);
	/* 40 档：跟练难点要够细，又不至于拖不动 */
	assert.equal((PRACTICE_MAX - PRACTICE_MIN) / PRACTICE_STEP, 30);
});

test('clampPracticeRate：非法输入回落 1', () => {
	for (const bad of [undefined, null, NaN, Infinity, -Infinity, 'abc', {}]) {
		assert.equal(clampPracticeRate(bad), 1, `输入 ${String(bad)}`);
	}
});

test('clampPracticeRate：越界夹到量程内', () => {
	assert.equal(clampPracticeRate(0.1), PRACTICE_MIN);
	assert.equal(clampPracticeRate(-3), PRACTICE_MIN);
	assert.equal(clampPracticeRate(9), PRACTICE_MAX);
});

test('clampPracticeRate：对齐到 0.05 网格且无浮点尾巴', () => {
	for (let i = 0; i <= 30; i++) {
		const raw = 0.5 + i * 0.05;
		const want = Number(raw.toFixed(2));
		const got = clampPracticeRate(raw);
		assert.equal(got, want, `第 ${i} 档`);
		/* 字符串长度即"有没有尾巴"：0.65 是 4 字符，0.6500000000000001 不是 */
		assert.ok(String(got).length <= 4, `${got} 带浮点尾巴`);
	}
});

test('clampPracticeRate：落在两档之间取最近档', () => {
	assert.equal(clampPracticeRate(1.03), 1.05);
	assert.equal(clampPracticeRate(1.02), 1);
	assert.equal(clampPracticeRate(1.024), 1);
	assert.equal(clampPracticeRate(1.026), 1.05);
	assert.equal(clampPracticeRate(0.97), 0.95);
});

test('clampPracticeRate：幂等', () => {
	for (const v of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
		assert.equal(clampPracticeRate(v), v);
		assert.equal(clampPracticeRate(clampPracticeRate(v)), v);
	}
});

test('practicePlanFor：开启 → 练习速度 + 保音高（2026-10-06 改口径）', () => {
	const a = practicePlanFor(true, 0.8, true);
	assert.equal(a.rate, 0.8);
	/* ★ 回归守卫：这里曾经是 `preservesPitch: false`（为了与独占路径的线性重采样
	   听感一致），代价是慢放会变调 —— 练习模式最不能忍的就是变调（跟弹/跟唱）。
	   现在以用户设置为准（默认保音高）。 */
	assert.equal(a.preservesPitch, true, '练习模式默认必须保音高');
	/* 用户显式关掉"保持音高"时，仍尊重他的选择 */
	assert.equal(practicePlanFor(true, 1.5, false).preservesPitch, false);
});

test('practicePlanFor：开启时速度也走网格取整', () => {
	assert.equal(practicePlanFor(true, 0.83, true).rate, 0.85);
	assert.equal(practicePlanFor(true, 99, true).rate, PRACTICE_MAX);
	assert.equal(practicePlanFor(true, undefined, true).rate, 1);
});

test('practicePlanFor：关闭 → 回 1×，并把保音高还给用户的设置', () => {
	assert.deepEqual(practicePlanFor(false, 0.8, true), { rate: 1, preservesPitch: true });
	assert.deepEqual(practicePlanFor(false, 0.8, false), { rate: 1, preservesPitch: false });
	/* 未传（老配置里没有这个键）按"保持音高"处理，与 10-config-state 的默认 true 一致 */
	assert.deepEqual(practicePlanFor(false, 0.8), { rate: 1, preservesPitch: true });
});

test('formatPracticeRate：固定两位小数 + ×', () => {
	assert.equal(formatPracticeRate(1), '1.00×');
	assert.equal(formatPracticeRate(0.8), '0.80×');
	assert.equal(formatPracticeRate(1.25), '1.25×');
	assert.equal(formatPracticeRate(9), '2.00×');
});
