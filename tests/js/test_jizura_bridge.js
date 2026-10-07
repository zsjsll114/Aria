/* ============================================================
 * tests/js/test_jizura_bridge.js — 「字面 · Jizura」适配层单测
 *
 * 这一层唯一的职责是"翻译"，但有一处**错了就全篇错**的地方：
 * 上游 `timing.lineTimes[i]` 是**按行索引**取值的，而我们的歌词里可能有空行。
 * 空行会被上游解析器丢掉、我们的时间数组若没丢 → 从那一行起整首歌的卡点全部错位。
 * 所以 cleanJizuraLines / lyricsTextFromLines / lineTimesFromLines 三者
 * 必须走**同一个过滤后的数组**（下面 TC1/TC2 钉的就是这条）。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	JIZURA_FX_DEFAULTS, applyJizuraFontOverride, buildJizuraPlan, cleanJizuraLines,
	clearJizuraFontCaches, collectJizuraFx, computeWordSyncOverrides, currentTrackEntry,
	hasRealWords, jizuraFamilyNames, jizuraPlanKey, lineTimesFromLines, lyricsTextFromLines,
	normalizeBpm, perfOptionsFor, pickJizuraFamily, realWordLineCount, seededRandom, textSeed,
	trackFingerprint,
} from '../../web/src/core/visualizers/jizura/jizuraBridge.js';

/** 造一个最小可用的假 J：只含字体覆写要用到的那几样 */
function mockJ() {
	return {
		FONTS: {
			gothic_bold: { label: 'G', family: '"Noto Sans JP"', weight: 700, kind: 'gothic', fb: 'x', gf: 'spec' },
		},
		faceOf: (key) => ({ delegated: true, key, family: '"Noto Sans JP"', weight: 700, gf: 'spec' }),
		glyphs: { cleared: 0, clear() { this.cleared++; } },
		metrics: { cleared: 0, clear() { this.cleared++; } },
	};
}

const LINES = [
	{ start: 1000, end: 3000, original: '第一行' },
	{ start: 3000, end: 5000, original: '   ' },     /* 空行：必须被丢掉 */
	{ start: 5000, end: 8000, original: '第三行' },
	{ start: 8000, end: 9000, text: '译文兜底' },      /* 只有 text 的行 */
];

test('TC1 空行被过滤，且过滤后行数一致', () => {
	assert.equal(cleanJizuraLines(LINES).length, 3);
	assert.equal(cleanJizuraLines([]).length, 0);
	assert.equal(cleanJizuraLines(null).length, 0);
	assert.equal(cleanJizuraLines([null, undefined, { original: '' }]).length, 0);
});

test('TC2 ★ 时间索引与文本同源（空行不得挤掉后面的时间）', () => {
	assert.equal(lyricsTextFromLines(LINES), '第一行\n第三行\n译文兜底');
	assert.deepEqual(lineTimesFromLines(LINES), [1, 5, 8]);
	/* 反例守卫：若时间数组没过滤，会得到 [1,3,5,8] —— 第二行时间 3 秒会被错当成
	   "第三行"，整首歌词的卡点从第 3 行起全部提前。这条断言就是防止有人"顺手"改成两者不同源。 */
	assert.equal(lineTimesFromLines(LINES).length, cleanJizuraLines(LINES).length);
});

test('TC3 没有 original 时回落 text；时间取 start，其次 time；异常值归 0', () => {
	assert.equal(lyricsTextFromLines([{ text: '只有译文' }]), '只有译文');
	assert.deepEqual(
		lineTimesFromLines([{ time: 2500, text: 'a' }, { text: 'b' }, { start: -5, text: 'c' }, { start: NaN, text: 'd' }]),
		[2.5, 0, 0, 0],
	);
});

test('TC4 plan 指纹：同内容同键，行数/风格/画幅变化则换键，空歌词单独一档', () => {
	const a = jizuraPlanKey(LINES, { style: 'noir', res: 1080, fps: 24 });
	assert.equal(a, jizuraPlanKey(LINES, { style: 'noir', res: 1080, fps: 24 }), '同输入必须同键（否则每帧重建 plan）');
	assert.notEqual(a, jizuraPlanKey(LINES, { style: 'mint', res: 1080, fps: 24 }), '换风格必须重建');
	assert.notEqual(a, jizuraPlanKey(LINES, { style: 'noir', res: 720, fps: 24 }), '换画幅必须重建');
	assert.equal(jizuraPlanKey([], {}), 'empty');
});

test('TC6 ★ おまかせ 抽签必须"同歌同风格"（否则改任何设置都会把整首观感重抽）', () => {
	/* 种子只由「歌名|歌手|歌词」决定 */
	const a = textSeed('歌名|歌手|第一行\n第二行');
	assert.equal(a, textSeed('歌名|歌手|第一行\n第二行'), '同文本必须同种子');
	assert.notEqual(a, textSeed('歌名|歌手|第一行\n第三行'), '改了歌词就该换种子');
	assert.ok(Number.isInteger(a) && a >= 0 && a <= 0xFFFFFFFF, '必须是 32 位无符号整数');

	/* 同一个种子喂两次 → 完全相同的抽签序列；换种子 → 序列不同 */
	const s1 = seededRandom(a); const s2 = seededRandom(a); const s3 = seededRandom(a + 1);
	const r1 = [s1(), s1(), s1()]; const r2 = [s2(), s2(), s2()]; const r3 = [s3(), s3(), s3()];
	assert.deepEqual(r1, r2, '同种子必须给出同一序列');
	assert.notDeepEqual(r1, r3, '不同种子应给出不同序列');
	assert.ok(r1.every((v) => v >= 0 && v < 1), '输出必须落在 [0,1)');
	assert.equal(seededRandom(0)(), seededRandom(0)(), '种子 0 也要稳定（不能被当成 falsy 后换成 1）');
});

test('TC7 ★ 真实 BPM 只在不离谱时进 project.timing（引擎靠它建匀速卡点网格）', () => {
	/* 用**假 J** 截住 project：这层是纯粹的"翻译"，不需要（也不该）拉真引擎进来。
	   假 J 还顺带钉住一条：不许覆盖上游 timing 的其它字段。 */
	const seen = [];
	const J = {
		defaultProject: () => ({
			style: 'noir', aspect: '16:9', res: 1080, fps: 24,
			timing: { bpm: 0, snap: true, tail: 0.9 }, fx: {},
		}),
		plan: (p) => { seen.push(p); return { cuts: [], lines: [] }; },
	};
	const lines = [{ start: 1000, end: 2000, original: 'a' }];
	buildJizuraPlan(J, lines, { bpm: 128 });
	assert.equal(seen[0].timing.bpm, 128, '合法 BPM 必须写进 timing');
	assert.equal(seen[0].timing.snap, true, '不得覆盖上游其它 timing 字段');
	buildJizuraPlan(J, lines, {});
	assert.equal(seen[1].timing.bpm, 0, '没给 BPM 就不能编一个出来');
	buildJizuraPlan(J, lines, { bpm: 9999 });
	assert.equal(seen[2].timing.bpm, 0, '离谱值回 0 = 交给引擎自估');
	assert.equal(seen[0].lyrics, 'a', '歌词文本仍按同一份过滤后的行生成');
});

test('TC8 normalizeBpm：30~300 之外与异常输入一律归 0', () => {
	assert.equal(normalizeBpm(128), 128);
	assert.equal(normalizeBpm('128.4'), 128.4, '面板/配方里的字符串数值要能收');
	assert.equal(normalizeBpm(30), 30);
	assert.equal(normalizeBpm(300), 300);
	assert.equal(normalizeBpm(29.9), 0);
	assert.equal(normalizeBpm(300.1), 0);
	assert.equal(normalizeBpm(0), 0);
	assert.equal(normalizeBpm(-1), 0);
	assert.equal(normalizeBpm(NaN), 0);
	assert.equal(normalizeBpm(Infinity), 0);
	assert.equal(normalizeBpm(null), 0);
	assert.equal(normalizeBpm(undefined), 0);
});

test('TC10 当前曲目读取：越界/非数组一律 null 且不抛（读的是 app 注册的全局）', () => {
	const prevPl = globalThis.playlist;
	const prevIdx = globalThis.currentTrackIndex;
	try {
		globalThis.playlist = [{ title: 'A', artist: 'B', url: '/x.mp3' }];
		globalThis.currentTrackIndex = 0;
		assert.equal(currentTrackEntry().title, 'A');
		globalThis.currentTrackIndex = 5;
		assert.equal(currentTrackEntry(), null, '索引越界必须 null');
		globalThis.playlist = [];
		assert.equal(currentTrackEntry(), null);
		globalThis.playlist = 'not-an-array';
		assert.equal(currentTrackEntry(), null, '非数组不能抛');
		delete globalThis.playlist;
		assert.equal(currentTrackEntry(), null);
	} finally {
		if (prevPl === undefined) delete globalThis.playlist; else globalThis.playlist = prevPl;
		globalThis.currentTrackIndex = prevIdx;
	}
	assert.equal(trackFingerprint({ title: 'A', artist: 'B' }), '|A|B||');
	assert.equal(trackFingerprint(null), '');
	assert.equal(trackFingerprint({ id: 'x', title: 'A' }), 'x|A|||');
});

test('TC11 字体覆写：委托原 faceOf、只换 family 并丢掉 gf、且必须清字形缓存', () => {
	const J = mockJ();
	assert.equal(applyJizuraFontOverride(J, "'Noto Serif SC', serif"), true);
	const f = J.faceOf('gothic_bold');
	assert.equal(f.family, "'Noto Serif SC', serif");
	assert.equal(f.weight, 700, '必须保留引擎的粗细层级（否则换字体会把风格的粗细对比抹平）');
	assert.equal(f.delegated, true, '必须委托原 faceOf —— 按语言选面（简/繁/韩）的逻辑要留着');
	assert.equal(f.gf, null, '不再需要去拉 Google 字面');
	assert.ok(J.glyphs.cleared >= 1, '字形缓存必须清（否则继续用旧字体的字形）');
	assert.ok(J.metrics.cleared >= 1, '度量缓存必须清（否则字距/折行还是按旧字体算）');
});

test('TC12 字体覆写：幂等、可还原、异常输入不抛', () => {
	const J = mockJ();
	const orig = J.faceOf;
	applyJizuraFontOverride(J, 'A');
	const wrapped = J.faceOf;
	applyJizuraFontOverride(J, 'A');
	assert.equal(J.faceOf, wrapped, '同一字体重复下发不得再套一层包装器');
	applyJizuraFontOverride(J, 'B');
	assert.equal(J.faceOf('gothic_bold').family, 'B');
	/* 还原：'inherit' / 空 / null 都是"跟随上游" */
	assert.equal(applyJizuraFontOverride(J, 'inherit'), false);
	assert.equal(J.faceOf, orig, 'inherit 必须还原成上游原函数本身（不是再包一层）');
	assert.equal(J.faceOf('gothic_bold').family, '"Noto Sans JP"');
	assert.equal(applyJizuraFontOverride(J, ''), false);
	assert.equal(applyJizuraFontOverride(J, '   '), false);
	assert.equal(applyJizuraFontOverride(J, null), false);
	assert.equal(applyJizuraFontOverride(undefined, 'A'), false, '没有引擎时不能抛');
	assert.equal(applyJizuraFontOverride({}, 'A'), false, '没有 FONTS 的假对象也不能抛');
});

test('TC13 引擎没有 faceOf（裁剪版）时也能覆写，还原时把键删掉而不是留 undefined', () => {
	const J = {
		FONTS: { mono: { family: '"IBM Plex Mono"', weight: 500, gf: 's' } },
		glyphs: { clear() {} },
		metrics: { clear() {} },
	};
	assert.equal(applyJizuraFontOverride(J, 'X'), true);
	assert.equal(J.faceOf('mono').family, 'X');
	assert.equal(J.faceOf('mono').weight, 500, '没有原 faceOf 时要回落到 FONTS 表');
	assert.equal(applyJizuraFontOverride(J, ''), false);
	assert.equal(Object.prototype.hasOwnProperty.call(J, 'faceOf'), false,
		'还原后该键应不存在（留个 undefined 会让 J.faceOf ? ... : ... 的判断变味）');
});

test('TC14 ★ 逐字跟唱：真实字时间 → 每行的 cuts 块数与 cutTime 切点', () => {
	const lines = [
		{
			start: 1000, end: 4000, original: '一二三四五', wordTiming: 'real',
			words: [1000, 1500, 2000, 2600, 3200].map((ms, i) => ({ text: 'x' + i, start: ms })),
		},
		{
			start: 4000, end: 8000, original: '六七八', wordTiming: 'synthesized',
			words: [4000, 5000, 6000].map((ms, i) => ({ text: 'y' + i, start: ms })),
		},
	];
	const ov = computeWordSyncOverrides(lines);
	assert.deepEqual(Object.keys(ov), ['0'], '合成逐字不得产生覆盖项（引擎本来就在做同类均分）');
	assert.equal(ov[0].cuts, 5, '五个字 → 五块');
	assert.equal(ov[0].cutTime[0], undefined, '索引 0 不用：引擎的 bounds[0] 恒为行首');
	/* 相对行首（1.0s）的秒数：0.5 / 1.0 / 1.6 / 2.2 */
	assert.deepEqual(ov[0].cutTime.slice(1), [0.5, 1, 1.6, 2.2]);
});

test('TC15 ★ 字比引擎的 0.22s 网格还密时：减块，而不是把切点推到假位置', () => {
	/* 六个字挤在 0.5s 内（说唱）：真实间隔 0.1s < 引擎最小 0.22s，精确同步不可能。
	   旧做法是"把切点抬到 0.22 网格上"—— 那不是同步，是把字时间挪到了假位置；
	   现在做法是**减块**：只保住能精确落位的那几块。 */
	const dense = [{
		start: 0, end: 2000, original: '一二三四五六', wordTiming: 'real',
		words: [0, 100, 200, 300, 400, 500].map((ms, i) => ({ text: 'x' + i, start: ms })),
	}];
	const ovDense = computeWordSyncOverrides(dense);
	assert.equal(ovDense[0].cuts, 2, '只剩能落位的 2 块');
	assert.deepEqual(ovDense[0].cutTime.slice(1), [0.3], '切点仍是真实字时间（第 4 个字）');

	/* 间隔够宽（0.4s）时六块全保，且切点就是真实字时间 */
	const wide = [{
		start: 0, end: 4000, original: '一二三四五六', wordTiming: 'real',
		words: [0, 400, 800, 1200, 1600, 2000].map((ms, i) => ({ text: 'x' + i, start: ms })),
	}];
	const ovWide = computeWordSyncOverrides(wide);
	assert.equal(ovWide[0].cuts, 6);
	assert.deepEqual(ovWide[0].cutTime.slice(1), [0.4, 0.8, 1.2, 1.6, 2]);
});

test('TC20 真实行尾进 timing.lineEnds；窗口预算优先用 plan 的 visEnd', () => {
	const seen = [];
	const J = {
		defaultProject: () => ({ style: 'noir', aspect: '16:9', res: 1080, fps: 24, timing: { bpm: 0, snap: true }, fx: {} }),
		plan: (p) => { seen.push(p); return { cuts: [], lines: [] }; },
	};
	const w = (ms) => [{ text: 'x', start: ms }, { text: 'y', start: ms + 1000 }];
	const ON = { wordSync: 'cuts' };
	buildJizuraPlan(J, [
		{ start: 1000, end: 5000, original: 'ab', wordTiming: 'real', words: w(1000) },
		{ start: 5000, end: 9000, original: 'cd', wordTiming: 'real', words: w(5000) },
	], ON);
	assert.deepEqual(seen[0].timing.lineEnds, [5, 9], '行尾按秒随行给（上游补丁开的通道）');
	/* 行尾越过下一行起点 → 夹到下一行起点（元数据写错时别把切点摊到下一行） */
	buildJizuraPlan(J, [
		{ start: 1000, end: 9999, original: 'ab', wordTiming: 'real', words: w(1000) },
		{ start: 3000, end: 4000, original: 'cd' },
	], ON);
	assert.deepEqual(seen[1].timing.lineEnds, [3, 4]);
	/* 缺 end → null，引擎照旧自己推 */
	buildJizuraPlan(J, [{ start: 1000, original: 'ab', wordTiming: 'real', words: w(1000) }], ON);
	assert.deepEqual(seen[2].timing.lineEnds, [null]);
	/* ★ 默认（wordSync 关）**不给行尾**：行为与打补丁之前完全一致（用户要的"改回去"） */
	buildJizuraPlan(J, [{ start: 1000, end: 5000, original: 'ab', wordTiming: 'real', words: w(1000) }], {});
	assert.equal(seen[3].timing.lineEnds, undefined, '关掉时不碰行尾通道');

	/* 窗口预算：plan 的 visEnd 比行自身 end 小（末行按字数估）→ 能保住的块数更少 */
	const ln = [{
		start: 1000, end: 5000, original: 'x'.repeat(10), wordTiming: 'real',
		words: Array.from({ length: 10 }, (_, i) => ({ text: 'x', start: 1000 + i * 400 })),
	}];
	const withPlan = computeWordSyncOverrides(ln, { mode: 'chars', plan: { lines: [{ start: 1, end: 5, visEnd: 3.5 }] } });
	const noPlan = computeWordSyncOverrides(ln, { mode: 'chars' });
	assert.ok(withPlan[0].cuts < noPlan[0].cuts,
		`窗口更小 → 块数更少（${withPlan[0].cuts} < ${noPlan[0].cuts}）`);
	assert.ok(withPlan[0].cutTime[1] <= 2.5 - 0.22 + 1e-9, '切点必须落在引擎允许的窗口内');
});

test('TC16 逐字跟唱：长行切到上游上限 12 块（不是每字一块）', () => {
	const words = Array.from({ length: 30 }, (_, i) => ({ text: 'x', start: i * 200 }));
	const lines = [{ start: 0, end: 6500, original: 'x'.repeat(30), wordTiming: 'real', words }];
	const ov = computeWordSyncOverrides(lines);
	assert.equal(ov[0].cuts, 12, '上游 Math.min(12, …) 是硬上限');
	assert.equal(ov[0].cutTime.length, 12);
	/* 第 1 块的切点 = **第一个不早于 0.22s** 的真实字时间（0.4s，第 2 个字）。
	   不是按比例 round(1*30/12)=3（0.6s）—— 贪心是为了不被引擎的 0.22s 网格夹走。 */
	assert.equal(ov[0].cutTime[1], 0.4);
	/* 自定义上限也要生效（面板/配方若给更小的值） */
	const ov4 = computeWordSyncOverrides(lines, { maxCuts: 4 });
	assert.equal(ov4[0].cuts, 4);
});

test('TC18 ★ 逐字模式：每字一块（上限 64），且切点必须落在真实字时间上', () => {
	/** 核心不变量：每一个切点都必须是某个字的真实时间（不是被引擎网格挪出来的假位置） */
	const assertRealCuts = (ov, lines, li) => {
		const clean = cleanJizuraLines(lines);
		const base = lineTimesFromLines(lines)[li];
		const rel = clean[li].words.map((w) => Number(w.start) / 1000 - base);
		for (const d of ov[li].cutTime.slice(1)) {
			assert.ok(rel.some((t) => Math.abs(t - d) < 1e-6), `切点 ${d} 不是任何真实字时间（假同步）`);
		}
	};

	const w10 = Array.from({ length: 10 }, (_, i) => ({ text: 'x', start: i * 400 }));
	const l10 = [{ start: 0, end: 4000, original: 'x'.repeat(10), wordTiming: 'real', words: w10 }];
	const ov10c = computeWordSyncOverrides(l10, { mode: 'chars' });
	assert.equal(ov10c[0].cuts, 10, '10 字 → 10 块（每字一块）');
	assert.equal(computeWordSyncOverrides(l10, { mode: 'cuts' })[0].cuts, 10, '10 字也在块级上限 12 内');
	assertRealCuts(ov10c, l10, 0);

	/* 长行：块级夹到 12，逐字能全切开（这正是上游 cap 补丁的用处） */
	const w20 = Array.from({ length: 20 }, (_, i) => ({ text: 'x', start: i * 500 }));
	const l20 = [{ start: 0, end: 10000, original: 'x'.repeat(20), wordTiming: 'real', words: w20 }];
	assert.equal(computeWordSyncOverrides(l20, { mode: 'cuts' })[0].cuts, 12, '块级夹到 12');
	const ov20 = computeWordSyncOverrides(l20, { mode: 'chars' });
	assert.equal(ov20[0].cuts, 20, '逐字模式：20 字 → 20 块');
	assertRealCuts(ov20, l20, 0);
});

test('TC19 放不下 2 块的行不接同步（宁均分，也不接一个假的同步）', () => {
	const lines = [{
		start: 0, end: 300, original: '一二', wordTiming: 'real',
		words: [{ text: '一', start: 0 }, { text: '二', start: 150 }],
	}];
	assert.deepEqual(computeWordSyncOverrides(lines, { mode: 'chars' }), {});
	assert.deepEqual(computeWordSyncOverrides(lines), {});
	/* 缺 end（且没有 plan 给 visEnd）：拿不到可见窗口 → 整行不接。
	   保守是故意的：窗口估错会把切点全部挤到一起，那比"不接"更糟。 */
	const noEnd = [{
		start: 0, original: 'x'.repeat(20), wordTiming: 'real',
		words: Array.from({ length: 20 }, (_, i) => ({ text: 'x', start: i * 200 })),
	}];
	assert.deepEqual(computeWordSyncOverrides(noEnd, { mode: 'chars' }), {});
});

test('TC21 画面细节收敛：六根滑杆 + 开关/枚举，越界夹回 0~1、脏标记只在真变时置位', () => {
	const d = collectJizuraFx(null, {});
	assert.deepEqual(d.fx, JIZURA_FX_DEFAULTS, '不传字段时保留上游默认');
	assert.equal(d.dirty, false);

	const a = collectJizuraFx(null, { motion: 0.1, flash: false, hud: 'on' });
	assert.equal(a.fx.motion, 0.1);
	assert.equal(a.fx.flash, false);
	assert.equal(a.fx.hud, 'on');
	assert.equal(a.dirty, true);
	assert.equal(a.fx.glitch, JIZURA_FX_DEFAULTS.glitch, '没动的键必须保持默认');

	/* 越界夹回而不是丢弃（滑杆值不可信，夹一下比"静默不生效"好排查） */
	assert.equal(collectJizuraFx(null, { density: 9 }).fx.density, 1);
	assert.equal(collectJizuraFx(null, { density: -3 }).fx.density, 0);
	/* 面板来的字符串数值要能收 */
	assert.equal(collectJizuraFx(null, { chroma: '0.35' }).fx.chroma, 0.35);
	/* 非法值不改变现状、也不算脏 */
	const keep = collectJizuraFx({ motion: 0.25 }, { motion: 'abc' });
	assert.equal(keep.fx.motion, 0.25);
	assert.equal(keep.dirty, false);
	/* hud 只认三档；其它字符串忽略 */
	const hud = collectJizuraFx(null, { hud: '乱写的' });
	assert.equal(hud.fx.hud, JIZURA_FX_DEFAULTS.hud);
	assert.equal(hud.dirty, false);
});

test('TC22 引擎字体家族名取自引擎自己（字体包靠它匹配，别硬编）', () => {
	const J = {
		FONTS: {
			gothic_bold: { family: '"Noto Sans JP"' },
			mincho: { family: '"Noto Serif JP"' },
			mono: { family: '"IBM Plex Mono","IBM Plex Sans JP", monospace' },
			broken: {},
		},
	};
	const names = jizuraFamilyNames(J).sort();
	assert.deepEqual(names, ['IBM Plex Mono', 'IBM Plex Sans JP', 'Noto Sans JP', 'Noto Serif JP'].sort());
	assert.deepEqual(jizuraFamilyNames(null), [], '没有引擎时返回空表（不能抛）');
	assert.equal(clearJizuraFontCaches(null), false, '没有引擎时清缓存返回 false 而不是抛');
	let cleared = 0;
	clearJizuraFontCaches({ glyphs: { clear: () => cleared++ }, metrics: { clear: () => cleared++ } });
	assert.equal(cleared, 2, '字形与度量两个缓存都要清');
});

test('TC23 字体包的家族名匹配：完全一致 > 前缀（吃到字重后缀）> 回落文件名', () => {
	const canon = ['Noto Sans JP', 'Noto Serif JP', 'IBM Plex Sans JP'];
	assert.equal(pickJizuraFamily(canon, 'Noto Sans JP'), 'Noto Sans JP', '完全一致');
	assert.equal(pickJizuraFamily(canon, 'NotoSansJP-Black'), 'Noto Sans JP', '字重后缀不该让它匹配失败');
	assert.equal(pickJizuraFamily(canon, 'NotoSerifJP-VF'), 'Noto Serif JP');
	assert.equal(pickJizuraFamily(canon, 'noto-sans-jp'), 'Noto Sans JP', '大小写与分隔符不敏感');
	assert.equal(pickJizuraFamily(canon, 'IBM Plex Sans JP Medium'), 'IBM Plex Sans JP');
	/* 多个候选都能前缀命中时取最长的那个（否则会误配到更短的家族上） */
	assert.equal(pickJizuraFamily(['IBM Plex Mono', 'IBM Plex Sans JP'], 'IBMPlexSansJP Regular'), 'IBM Plex Sans JP');
	/* 都不命中：用文件名本身（仍是个可用家族名，只是本模式用不上） */
	assert.equal(pickJizuraFamily(canon, 'MyFancy Font'), 'MyFancy Font');
	assert.equal(pickJizuraFamily(canon, ''), null);
	assert.equal(pickJizuraFamily(null, 'Whatever'), 'Whatever');
});

test('TC17 hasRealWords / realWordLineCount 的边界（别把合成值当真实）', () => {
	assert.equal(hasRealWords(null), false);
	assert.equal(hasRealWords({}), false);
	assert.equal(hasRealWords({ original: 'x', words: [] }), false);
	assert.equal(hasRealWords({ original: 'x', words: [{ start: 0 }] }), false, '不到 2 个字不成分块');
	assert.equal(hasRealWords({ original: 'x', words: [{ start: 0 }, { start: 1 }], wordTiming: 'synthesized' }), false);
	assert.equal(hasRealWords({ original: 'x', words: [{ start: 0 }, { start: 'abc' }], wordTiming: 'real' }), false, '时间非法不算真实');
	assert.equal(hasRealWords({ original: 'x', words: [{ start: 0 }, { start: 1000 }] }), true, '未打标记但有合法时间：可用（最差也是均分）');
	assert.equal(realWordLineCount([
		{ original: 'a', words: [{ start: 0 }, { start: 1 }] },
		{ original: 'b', words: [{ start: 0 }, { start: 1 }], wordTiming: 'synthesized' },
		{ original: 'c' },
	]), 1);
	/* 空行不参与（与歌词文本、lineTimes 同一套过滤，索引才对得上） */
	assert.equal(realWordLineCount([{ original: '   ', words: [{ start: 0 }, { start: 1 }] }]), 0);
});

test('TC5 性能档映射：软件渲染/低配 → fast；MV 开着 → 透明通道', () => {
	assert.deepEqual(perfOptionsFor({}), { fast: false, transparent: false });
	assert.equal(perfOptionsFor({ low: true }).fast, true);
	assert.equal(perfOptionsFor({ minimal: true }).fast, true);
	/* 软件渲染（SwiftShader/无 GPU）即使没被标成 perf-minimal 也必须走 fast */
	assert.equal(perfOptionsFor({ softwareRenderer: true }).fast, true);
	assert.deepEqual(perfOptionsFor({ mvOn: true }), { fast: false, transparent: true });
	assert.equal(perfOptionsFor({ mvOn: true, minimal: true }).transparent, true);
});
