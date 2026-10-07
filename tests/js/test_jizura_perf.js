/* ============================================================
 * tests/js/test_jizura_perf.js — 自适应画质调速器单测
 *
 * 这个模块的失效方式是"静默抖动"：降级太灵敏 → 每次分镜转场都掉清晰度；
 * 回升太灵敏 → 清晰度在阈值附近来回闪。两条都由"迟滞"钉住，下面逐条断言。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	PERF_LEVELS, createPerfGovernor, qualityStartLevel, qualityToDprCap,
} from '../../web/src/core/visualizers/jizura/jizuraPerf.js';

/** 喂 n 帧同样的耗时 */
function feed(gov, ms, n) {
	let last = null;
	for (let i = 0; i < n; i++) last = gov.sample(ms);
	return last;
}

test('P0 档位表：越靠后越省，且三根杠杆的顺序是 fast → 倍率 → 帧节流', () => {
	assert.ok(PERF_LEVELS.length >= 3);
	assert.equal(PERF_LEVELS[0].fast, false, '第 0 档必须保留全效果');
	assert.equal(PERF_LEVELS[0].resScale, 1);
	assert.equal(PERF_LEVELS[0].fpsDiv, 1);
	/* 单调性：不允许出现"后一档反而更清晰/更费"的排列（写错表会让调速器白忙） */
	for (let i = 1; i < PERF_LEVELS.length; i++) {
		const p = PERF_LEVELS[i - 1], c = PERF_LEVELS[i];
		assert.ok(c.resScale <= p.resScale, `第 ${i} 档 resScale 不应大于前一档`);
		assert.ok(c.fpsDiv >= p.fpsDiv, `第 ${i} 档 fpsDiv 不应小于前一档`);
		assert.ok(!(p.fast === false && c.fast === false && c.resScale === p.resScale && c.fpsDiv === p.fpsDiv),
			'不允许存在两档完全等价');
	}
});

test('P1 DPR 上限：默认必须压到 1（实测 dpr2 是 43.5ms vs dpr1 11.0ms）', () => {
	assert.equal(qualityToDprCap('auto'), 1);
	assert.equal(qualityToDprCap('eco'), 1);
	assert.equal(qualityToDprCap('hd'), 2);
	assert.equal(qualityToDprCap(undefined), 1, '未配置时也必须保守');
	assert.equal(qualityToDprCap('乱写的值'), 1);
});

test('P2 起始档：eco 直接钉在最低档，auto/hd 从全效果起', () => {
	assert.equal(qualityStartLevel('eco'), PERF_LEVELS.length - 1);
	assert.equal(qualityStartLevel('auto'), 0);
	assert.equal(qualityStartLevel('hd'), 0);
});

test('P3 持续超预算 → 逐级降到最低档并停住（不会越界）', () => {
	const g = createPerfGovernor({ startLevel: 0 });
	const lv = feed(g, 30, 400);      /* 30ms/帧，重度超支 */
	assert.equal(g.index(), PERF_LEVELS.length - 1, '应降到最后一档');
	assert.equal(lv.key, PERF_LEVELS[PERF_LEVELS.length - 1].key);
	assert.equal(lv.fast, true, '最低档必须打开 fast');
	assert.ok(lv.resScale < 1 && lv.fpsDiv >= 2);
});

test('P4 迟滞：单帧尖峰不得触发降级（分镜转场天然会尖）', () => {
	const g = createPerfGovernor({ startLevel: 0, downAfter: 5 });
	feed(g, 2, 30);                  /* 先稳定在轻松档 */
	g.sample(80);                    /* 一帧转场尖峰 */
	assert.equal(g.index(), 0, '单帧尖峰后仍应在第 0 档');
	feed(g, 2, 5);
	assert.equal(g.index(), 0);
});

test('P5 持续吃力但没有失控：只降一级就够用时不再继续降', () => {
	const g = createPerfGovernor({ startLevel: 0, downAfter: 3 });
	/* 先重载把它推到第 1 档 */
	feed(g, 20, 20);
	const after = g.index();
	assert.ok(after >= 1, `应至少降一级，实得 ${after}`);
	/* 之后稳定在"刚好达标"（低于 target 但高于 upSlack 线）→ 既不降也不升 */
	feed(g, 11, 400);
	assert.equal(g.index(), after, '刚好达标时应停住不动（否则会抖动）');
});

test('P6 负载回落后能爬回清晰档（且需要足够长的轻松期）', () => {
	const g = createPerfGovernor({ startLevel: 0, downAfter: 3, upAfter: 50 });
	feed(g, 25, 60);
	const low = g.index();
	assert.ok(low > 0);
	/* 回升前不该动 */
	feed(g, 1, 20);
	assert.equal(g.index(), low, '20 帧的短暂轻松不足以回升');
	feed(g, 1, 200);
	assert.equal(g.index(), 0, '长时间轻松后应回到全效果档');
});

test('P7 上下界被尊重：eco 档（maxLevel 设死）不会被任何负载推到更省', () => {
	const last = PERF_LEVELS.length - 1;
	const g = createPerfGovernor({ startLevel: last, minLevel: last, maxLevel: last });
	const lv = feed(g, 60, 200);
	assert.equal(g.index(), last);
	assert.equal(lv.key, PERF_LEVELS[last].key);
	/* 反向也一样：不许越过 minLevel 往更清晰的方向爬 */
	const g2 = createPerfGovernor({ startLevel: 1, minLevel: 1 });
	feed(g2, 0.2, 500);
	assert.equal(g2.index(), 1);
});

test('P8 异常输入不污染统计', () => {
	const g = createPerfGovernor({ startLevel: 0 });
	g.sample(NaN);
	g.sample(-5);
	g.sample(undefined);
	assert.equal(g.samples(), 0, '非法样本不该计入');
	assert.equal(g.index(), 0);
	/* reset 后 EMA 重新起步（切歌/改窗口尺寸后不该拿旧负载误判） */
	feed(g, 30, 30);
	g.reset();
	assert.equal(g.samples(), 0);
	assert.equal(g.ema(), 0);
});
