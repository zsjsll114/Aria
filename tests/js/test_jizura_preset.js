/* ============================================================
 * tests/js/test_jizura_preset.js — 「AI 推荐」风格选择（jizuraPreset.js）
 *
 * 需求（2026-10-11 用户）：AI 分析完顺便挑一套模式预设 + 心情，别让用户每次手调。
 * 设计要点（这些断言就是钉它们）：
 *   · **确定性**：同输入同输出。推荐结果参与 plan 指纹，若带随机性，改个字号重建 plan
 *     就会整首换风格（那不是推荐，是抽风）。
 *   · **候选必须真实存在**：推荐出的 id 会拿去当引擎的 `project.style`，
 *     所以用调用方给的 `J.STYLE_ORDER` 过滤，引擎里没有的候选直接跳过。
 *   · **绝不返回 'ai'/'auto'**：这两个是我们自己的档位记号，不是引擎认得的风格 id。
 *   · 无分析结果 ⇒ 兜底为风格表第一套（mood 不限），调用方另有"回落 'auto' 抽签"的一层。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	JIZURA_MOOD_IDS, hexToHsl, jizuraPresetSignature, recommendJizuraPreset,
} from '../../web/src/core/visualizers/jizura/jizuraPreset.js';

/** 取面板里登记的那 27 套（与 index.html 的风格下拉一致；顺序也照它） */
const STYLES = [
	'noir', 'crimson', 'caution', 'magenta', 'paper', 'hud', 'mint', 'specimen', 'transit',
	'blueprint', 'rouge', 'mono', 'hrRuin', 'hrNightRec', 'hrCurse', 'sakura', 'ocean', 'sunset',
	'forest', 'vapor', 'newsprint', 'synth80', 'kraft', 'candy', 'acid', 'sumi', 'gold',
];

test('JP1 关键词路由：中/英情绪词都能落到候选风格，且结果在引擎风格表里', () => {
	const cases = [
		[{ mood: '诡异恐怖' }, ['hrRuin', 'hrNightRec', 'hrCurse', 'noir', 'mono']],
		[{ mood: '赛博朋克' }, ['synth80', 'acid', 'hud', 'blueprint', 'transit']],
		[{ mood: '和风禅意' }, ['sumi', 'paper', 'newsprint', 'sakura', 'mono']],
		[{ mood: '忧郁思念' }, ['rouge', 'sakura', 'ocean', 'sumi', 'gold']],
		[{ mood: 'sweet love song' }, ['candy', 'magenta', 'sunset', 'crimson', 'gold']],
		[{ description: '怀旧的老胶片质感' }, ['kraft', 'newsprint', 'specimen', 'transit', 'paper']],
		[{ mood: 'geometric minimal urban' }, ['blueprint', 'hud', 'mono', 'magenta']],
	];
	for (const [ai, expected] of cases) {
		const rec = recommendJizuraPreset(ai, STYLES);
		assert.equal(rec.reason, 'keyword', `${JSON.stringify(ai)} 应走关键词分支`);
		assert.ok(expected.includes(rec.style), `${JSON.stringify(ai)} → ${rec.style} 应在候选里`);
		assert.ok(STYLES.includes(rec.style), '推荐结果必须是引擎真实存在的风格 id');
		assert.ok(JIZURA_MOOD_IDS.includes(rec.mood), `心情 ${rec.mood} 必须是引擎的心情键`);
	}
});

test('JP2 候选被引擎风格表过滤：表里没有的候选自动跳过，绝不返回 ai/auto', () => {
	/* 只给 3 套风格的表：恐怖候选里 hrRuin/hrNightRec/hrCurse 都不在 ⇒ 应落到 noir */
	const tiny = ['noir', 'gold', 'paper'];
	const rec = recommendJizuraPreset({ mood: '恐怖' }, tiny);
	assert.equal(rec.style, 'noir', '候选逐个过滤，取第一个存在的');
	assert.ok(tiny.includes(rec.style));

	/* 表里一个候选都没有 ⇒ 兜底第一套（绝不给不存在的 id） */
	const onlyGold = ['gold'];
	assert.equal(recommendJizuraPreset({ mood: '恐怖' }, onlyGold).style, 'gold');

	for (const ai of [{ mood: '恐怖' }, { mood: '赛博' }, {}, { mood: 'sweet' }]) {
		const style = recommendJizuraPreset(ai, STYLES).style;
		assert.notEqual(style, 'ai', "推荐结果不能是 'ai' 本身（那是我们自己的档位记号）");
		assert.notEqual(style, 'auto');
	}
});

test('JP3 第二、三判据：animation_style 与配色；都没有就兜底', () => {
	/* 关键词不命中，但 animation_style 命中 */
	const byMotion = recommendJizuraPreset({ animation_style: 'glitch' }, STYLES);
	assert.equal(byMotion.reason, 'animationStyle');
	assert.equal(byMotion.mood, 'glitch');
	assert.ok(['synth80', 'acid', 'hud', 'transit'].includes(byMotion.style));

	/* animation_style 是引擎没见过的词（AI 自由发挥）⇒ 走配色 */
	const byPalette = recommendJizuraPreset({ animation_style: 'sparkle', primary_color: '#1b3fa0' }, STYLES);
	assert.equal(byPalette.reason, 'palette', '深蓝应命中色相分支');
	assert.equal(byPalette.mood, 'editorial');
	assert.ok(['blueprint', 'synth80', 'hud'].includes(byPalette.style));

	/* 关键色相覆盖：极暗 / 低饱和 / 红 / 绿 / 紫 */
	const picks = [
		['#0a0a0c', ['noir', 'mono', 'hrNightRec']],
		['#8d8d8d', ['mono', 'newsprint', 'kraft', 'sumi']],
		['#d51f3a', ['rouge', 'crimson', 'caution', 'hrRuin']],
		['#2f9e5a', ['forest', 'mint', 'paper']],
		['#8b3fd6', ['magenta', 'vapor', 'specimen']],
	];
	for (const [hex, expected] of picks) {
		const rec = recommendJizuraPreset({ primary_color: hex }, STYLES);
		assert.equal(rec.reason, 'palette', `${hex} 应走配色分支`);
		assert.ok(expected.includes(rec.style), `${hex} → ${rec.style} 应在候选里`);
	}

	/* 什么都没有 ⇒ 风格表第一套 + 不限定心情 */
	const empty = recommendJizuraPreset({}, STYLES);
	assert.equal(empty.reason, 'default');
	assert.equal(empty.style, 'noir');
	assert.equal(empty.mood, null);

	/* 非对象/空表也不抛（面板可能在引擎就绪前就下发设置） */
	assert.doesNotThrow(() => recommendJizuraPreset(null, STYLES));
	assert.doesNotThrow(() => recommendJizuraPreset({ mood: '恐怖' }, null));
	assert.equal(recommendJizuraPreset({ mood: '恐怖' }, []).style, null, '没有风格表就没有推荐');
});

test('JP4 确定性 + 指纹：同输入同结果；指纹只随参与推荐的字段变', () => {
	const ai = { mood: '赛博朋克', animation_style: 'glitch', primary_color: '#12d6f0' };
	const a = recommendJizuraPreset(ai, STYLES);
	const b = recommendJizuraPreset({ ...ai }, STYLES);
	assert.deepEqual(a, b, '同输入必须同输出（否则每次重建 plan 都换风格）');

	/* 无关字段变化不影响推荐，但签名要稳定 */
	assert.equal(jizuraPresetSignature(ai), jizuraPresetSignature({ ...ai, emotion_words: [{ word: 'x' }] }));
	/* 参与推荐的字段变化 ⇒ 指纹变（plan 才会重建） */
	assert.notEqual(jizuraPresetSignature(ai), jizuraPresetSignature({ ...ai, mood: '安静' }));
	assert.notEqual(jizuraPresetSignature(ai), jizuraPresetSignature({ ...ai, primary_color: '#ffffff' }));
	assert.equal(jizuraPresetSignature(null), '|||', '没有分析结果时是空签名（稳定值）');

	/* hexToHsl 的边界：3 位缩写可解析、非法返回 null */
	assert.ok(hexToHsl('#fff'));
	assert.equal(hexToHsl('#fff').s, 0);
	assert.equal(hexToHsl('not-a-color'), null);
	assert.equal(hexToHsl(''), null);
	assert.equal(hexToHsl(undefined), null);
});

test('JP5 设置链同步：风格默认 = ai、帧率四档都在（defaults / 190 兜底 / previewEngine / 面板）', async () => {
	const { readFileSync } = await import('node:fs');
	const { fileURLToPath } = await import('node:url');
	const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

	const { DEFAULT_SETTINGS } = await import('../../web/src/config/defaults.js');
	const { APPEARANCE_SECTIONS } = await import('../../web/src/config/appearanceSchema.js');
	const { MODE_FIELD_POOL, MODE_FIELDS_BY_MODE, validateValue } =
		await import('../../web/src/core/vfxRecipe.js');
	assert.equal(DEFAULT_SETTINGS.modeSettings.jizura.style, 'ai',
		"开箱档必须是「AI 推荐」——用户不该被迫手调风格");

	const sources = {
		'190 兜底': read('../../web/src/app/190-settings-fontsize.js'),
		'previewEngine 回填': read('../../web/src/core/previewEngine.js'),
		'面板': read('../../web/src/config/appearanceSchema.js'),
	};
	for (const [label, src] of Object.entries(sources)) {
		assert.ok(src.includes("'ai'") || src.includes('"ai"'), `${label} 里应有 'ai' 档`);
	}
	const jizCtrls = ['core', 'advanced', 'override'].flatMap(
		(t) => (APPEARANCE_SECTIONS.jizura[t] || []).flatMap((r) => r.controls || []),
	);
	const styleCtrl = jizCtrls.find((c) => c.var === 'style');
	assert.ok(styleCtrl?.options?.some((o) => o.value === 'ai'), '面板风格下拉必须有 AI 推荐项');

	/* 帧率四档：面板选项齐 + schema 值域容得下（tInt(6,60)） */
	const fpsCtrl = jizCtrls.find((c) => c.var === 'fps');
	for (const v of ['12', '24', '30', '60']) {
		assert.ok(fpsCtrl?.options?.some((o) => o.value === v && o.text === `${v} fps`), `面板缺 ${v} fps 档`);
	}
	for (const v of [6, 12, 24, 30, 60]) {
		assert.equal(validateValue(MODE_FIELD_POOL.fps, v).ok, true, `fps=${v} 应合法`);
	}
	assert.equal(validateValue(MODE_FIELD_POOL.fps, 61).ok, false, 'fps 越界应拒');
	/* 帧率必须在 jizura 的字段池里（否则存不进分享码） */
	assert.ok(MODE_FIELDS_BY_MODE.jizura.includes('fps'));
	assert.ok(MODE_FIELDS_BY_MODE.jizura.includes('style'));
});

test('JP6 面板结构：jizura 覆写控件收在 jizura 段内且 index.html div 平衡', async () => {
	/* 存在理由：该段曾被手写 HTML 塞进多余 `</div>`，把「背景与字体」组挤到段外。
	   结构化 schema + DOM 渲染器保证所有 Tier 控件都落在各自 [data-mode-section] 内。 */
	const { APPEARANCE_SECTIONS } = await import('../../web/src/config/appearanceSchema.js');
	const { readFileSync } = await import('node:fs');
	const { fileURLToPath } = await import('node:url');
	const jiz = APPEARANCE_SECTIONS.jizura;
	assert.ok(Array.isArray(jiz?.override) && jiz.override.length > 0, 'jizura 段应包含独立覆写组');
	const html = readFileSync(fileURLToPath(new URL('../../web/index.html', import.meta.url)), 'utf8');
	const opens = (html.match(/<div\b/g) || []).length;
	const closes = (html.match(/<\/div>/g) || []).length;
	assert.equal(opens, closes, `index.html div 不平衡：<div> ${opens} 个 / </div> ${closes} 个`);
});
