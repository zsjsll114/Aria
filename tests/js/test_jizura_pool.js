/* ============================================================
 * tests/js/test_jizura_pool.js — 「抽签池」回归防线
 *
 * 背景（2026-10-11 用户报障"jizura 的分镜比原版少了很多、太容易重复"）：
 * 根因不是引擎被裁剪（40 个文件是逐字节搬运 + 机器校验差异行数），而是
 * **适配层没转发 `extra`** —— 引擎的 `J.randomOk`（11q_sets.js:51-57）用严格的
 * `project.extra === true` 决定"首版之后新增的部件与风格能不能被抽中"，
 * 而上游 `defaultProject()` 里它是 **false**。
 * 实测：不转发时抽签池只有 486/910，**转场只剩 5/27**、风格只剩 12/27。
 *
 * 为什么必须单独立一个测试文件：**plan 的 cuts/lines 数量完全不受影响**
 * （实测两种 extra 下都是 73 cut / 20 行），所以任何只断言 plan 结构的测试
 * 都抓不住"抽签池被静默砍半"——而这正是用户唯一能看见的症状。
 *
 * ⚠ 本文件会把**真引擎**载进 Node：加载期要建离屏 canvas 量字宽
 *   （vendor/jizura/engine/02_fonts.js:137），所以先装最小 DOM 桩、再动态 import
 *   （静态 import 会被提升到桩之前执行）。引擎实例必须每进程一个（加载期
 *   06/07/11q/08b 会给 def 追加 tags/extra/wa/set 标记，建两次会重复追加）。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildJizuraPlan } from '../../web/src/core/visualizers/jizura/jizuraBridge.js';

/* ---- 最小 DOM 桩（够引擎加载期跑通：量字宽 + 字体就绪判断）---- */
const stubCtx = { font: '', measureText: (t) => ({ width: String(t).length * 10 }) };
globalThis.document = {
	createElement: () => ({ width: 0, height: 0, getContext: () => stubCtx }),
	fonts: {
		load: async () => [], ready: Promise.resolve(),
		addEventListener() {}, removeEventListener() {},
	},
	addEventListener() {}, removeEventListener() {},
};
globalThis.window = globalThis;

const { createJizuraEngine } = await import('../../web/src/vendor/jizura/engine/bootstrap.js');
const J = createJizuraEngine();

/* ---- 部件池的度量 ---- */
const GROUPS = ['layout', 'enter', 'exit', 'hold', 'decor', 'treat', 'bg', 'cam', 'fx', 'trans'];

/** 这个 project 允许抽签选中的部件总数（= J.randomOk 通过的条目数，含风格与字体） */
function poolOf(proj) {
	let n = 0;
	for (const g of GROUPS) for (const k of J.order(g)) if (J.randomOk(proj, g, k)) n++;
	for (const k of J.STYLE_ORDER) if (J.randomOk(proj, 'style', k)) n++;
	for (const k of Object.keys(J.FONTS)) if (J.randomOk(proj, 'font', k)) n++;
	return n;
}
const poolOfGroup = (proj, g) => J.order(g).filter((k) => J.randomOk(proj, g, k)).length;
/** 风格不在分组注册表里（J.order('style') 会抛），单独走 STYLE_ORDER */
const poolOfStyles = (proj) => J.STYLE_ORDER.filter((k) => J.randomOk(proj, 'style', k)).length;

/** 上游默认（extra:false = 只有首版部件集） */
const upstreamDefault = () => Object.assign({}, J.defaultProject(), { extra: false });
/** 开着追加分 */
const withExtra = () => Object.assign({}, J.defaultProject(), { extra: true });

const LYRICS = [
	'夜明けの色を/覚えてる',
	'ほどけた声が遠くで鳴った',
	'ねえ、まだ間に合うかな',
	'*透明*なままじゃ終われない!',
	'街の灯がゆっくり流れて',
	'君の名前を呼んでみた',
	'遠くの空に手を伸ばして',
	'ここから先へ歩き出す!',
	'忘れないよ この季節を',
	'風が運んだ約束',
	'また会えると信じてる',
	'今度こそは笑えるように!',
	'静かな朝が窓を叩く',
	'夢の続きを探してた',
	'小さな声で歌うよ',
	'まだ終わらない物語!',
	'光の中へ駆け出した',
	'振り返らずに進むよ',
	'君と見た景色を抱いて',
	'いつか同じ空の下で!',
].join('\n');

const LINES = LYRICS.split('\n').map((t, i) => ({ start: i * 3200, end: (i + 1) * 3200, original: t }));

/** 造一份和适配层同形的 project（不走 bridge，用来对拍） */
function mkProject(extra) {
	const base = J.defaultProject();
	return Object.assign({}, base, {
		title: 'pool-probe', artist: 'pool-probe', lyrics: LYRICS, style: 'noir', extra,
		timing: Object.assign({}, base.timing, {
			lineTimes: Object.fromEntries(LYRICS.split('\n').map((_, i) => [i, i * 3.2])),
		}),
	});
}

/** 临时截住 J.plan，拿到 bridge 真正递给引擎的 (project, audio) */
function capturePlan(fn) {
	const orig = J.plan;
	const seen = [];
	J.plan = (p, audio) => { seen.push({ p, audio }); return orig(p, audio); };
	try { fn(); } finally { J.plan = orig; }
	return seen;
}

/* ============================================================ */

test('JP0 上游默认（extra:false）的抽签池量级：锁定"首版部件集"有多大', () => {
	const n = poolOf(upstreamDefault());
	assert.ok(n >= 450, `上游默认池应 ≥450（实测 486），实得 ${n} —— 引擎或加载顺序变了？`);
	assert.ok(n <= 520, `上游默认池应 ≤520（实测 486），实得 ${n} —— 首版部件集被谁扩大了？`);
	assert.ok(poolOfGroup(upstreamDefault(), 'trans') <= 8,
		'上游默认下转场只有个位数（实测 5）—— 这是"转场最容易被看出重复"的原因');
});

test('JP1 ★ 追加分把抽签池扩到约 1.8 倍，转场从个位数涨到 20+', () => {
	const off = poolOf(upstreamDefault());
	const on = poolOf(withExtra());
	assert.ok(on >= Math.round(off * 1.6), `开追加分后池子应 ≥1.6 倍（实测 855/486=1.76），实得 ${on}/${off}`);
	assert.equal(poolOfStyles(upstreamDefault()), J.BASE_STYLES.length,
		'关掉追加分时风格恰好是首版那 12 套');
	assert.ok(poolOfStyles(withExtra()) >= J.BASE_STYLES.length * 2 - 1,
		`开追加分后风格应翻倍（实测 12→24），实得 ${poolOfStyles(withExtra())}`);
	assert.ok(poolOfGroup(withExtra(), 'trans') >= 20,
		`开追加分后转场应 ≥20（实测 25），实得 ${poolOfGroup(withExtra(), 'trans')}`);
});

test('JP2 ★★ 端到端：bridge 造出的 project 必须开着追加分（忘了转发 extra 就红）', () => {
	/* 这是本文件存在的理由：只断言 plan 结构抓不住这条（cuts 数量两种 extra 下相同）。 */
	const byDefault = capturePlan(() => buildJizuraPlan(J, LINES, { style: 'noir' }));
	assert.equal(byDefault.length, 1);
	assert.equal(byDefault[0].p.extra, true, '不传 extra 时的默认值必须是 true（面板开关默认开）');
	assert.equal(poolOf(byDefault[0].p), poolOf(withExtra()),
		'★ 抽签池必须等于"开着追加分"那一档——不等就说明 extra 没被转发');

	const explicitOff = capturePlan(() => buildJizuraPlan(J, LINES, { style: 'noir', extra: false }));
	assert.equal(poolOf(explicitOff[0].p), poolOf(upstreamDefault()),
		'显式关掉时必须退回首版部件集');
});

test('JP3 ★ 端到端：有真实 BPM 时，引擎第二参必须带拍点栅格', () => {
	/* plan.beats 驱动 snap()（切点对齐拍点）与渲染层的拍点脉冲，空数组 = 两者全哑。 */
	const seen = capturePlan(() => buildJizuraPlan(J, LINES, { style: 'noir', bpm: 120 }));
	assert.ok(seen[0].audio && Array.isArray(seen[0].audio.beats), '必须给引擎一个带 beats 的第二参');
	assert.ok(seen[0].audio.beats.length > 0, 'plan.beats 不能是空的');
	assert.ok(seen[0].audio.beats[seen[0].audio.beats.length - 1] >= 54,
		'网格要盖住整首歌（末行 64s）');

	const noBpm = capturePlan(() => buildJizuraPlan(J, LINES, { style: 'noir' }));
	assert.equal(noBpm[0].audio, null, '没有 BPM 就不给栅格（交给引擎自估，不编数据）');
});

test('JP5 ★ 端到端：能量包络落到 plan.energy / plan.energyRate（引擎 6 处消费者据此缩放）', () => {
	/* 引擎侧读法固定：09_render.js:113 `plan.energy[floor(t * plan.energyRate)]`，
	   6 处消费者都是 `env.energy != null ? 按能量缩放 : 假噪声摆动`。所以「有没有把
	   包络交到 plan 上」就是这条链唯一的成败判据。 */
	const energy = Float32Array.from({ length: 200 }, (_, i) => i / 200);
	const plan = J.plan(mkProject(true), { beats: J.beatGrid(120, 0, 600), energy, energyRate: 20 });
	assert.equal(plan.energy, energy, 'energy 必须原样进 plan（引擎按索引直取，不做拷贝/转换）');
	assert.equal(plan.energyRate, 20);

	/* 反例守卫：没给 analyses 时必须是 null / 0 —— 引擎据此走噪声兜底，不是 NaN 或空数组 */
	const bare = J.plan(mkProject(true), null);
	assert.equal(bare.energy, null);
	assert.equal(bare.energyRate, 0);
});

test('JP4 追加分只扩大部件池，不改分镜数量（别指望它改 cuts）', () => {
	const a = J.plan(mkProject(false), null);
	const b = J.plan(mkProject(true), null);
	assert.equal(a.cuts.length, b.cuts.length,
		'cut 数由 density / 可见时长 / chunks 决定，与抽签池无关（实测两种都是 73）');
	assert.equal(a.lines.length, b.lines.length);
	const distinct = (plan, f) => new Set(plan.cuts.map((c) => c[f]).filter(Boolean)).size;
	assert.ok(distinct(b, 'trans') > distinct(a, 'trans'),
		`开追加分后实际用到的转场种类必须变多（实测 ${distinct(a, 'trans')} → ${distinct(b, 'trans')}）`);
});
