/* ============================================================
 * tests/js/test_verse_settings_sync.js — 诗镜新增设置项的「六处同步」守卫
 *
 * 覆盖三组（2026-10-11 把上游 `DEFAULT_SONNET_TUNING` / `SonnetSettingsPanel` 里
 * 本该可调的键接出来）：
 *   ① 后期处理组：postProcessEnabled + 7 条强度。上游主开关**默认 false** = 干净画面；
 *      本仓曾硬编码 true + 非零 rgbShift/halftone，观感是"还没分镜就有雪花/故障"。
 *   ② 画面元素组：showOnlyText / showGuide / showGiantDecorativeText / showFixedGeo。
 *      上游同类键还有 showBackgroundMg / showBackgroundDecor，**本仓不收**——既有的
 *      「显示巨型背景字与几何构图」「显示星芒微粒」已管那两层，收进来是两套开关打架。
 *   ③ 动态与构图组（上游滑杆域 min 0 / max 2 / step 0.05）：cameraIntensity /
 *      typographyMotion / mgDensity，外加 `outerFrameMode` 三档（none/frame/full）
 *      与 Aria 扩展 `interludeStaff`（间奏标记也走谱面，默认 false = 上游行为）。
 *
 * 为什么要这条守卫：这些键要在**六处**同时存在，漏任何一处都是**静默**失效 ——
 *   ① vfxRecipe 的 MODE_FIELD_POOL（值类型与取值域 = schema）
 *   ② vfxRecipe 的 MODE_FIELDS_BY_MODE.pv（不进池 ⇒ 存不进分享码，导入别人的配方静默回默认）
 *   ③ defaults.js 的 modeSettings.pv（新装用户的开箱档）
 *   ④ 190-settings-fontsize.js 的 applyModeSettings 兜底字面量（缺了 fallback 到 cover 档）
 *   ⑤ previewEngine 的 modeVars.pv（缺了外观面板重开时控件回填不上）
 *   ⑥ index.html 的 pv 面板行（data-var，缺了用户碰不到）
 * 这类坑本仓踩过不止一次（jizura 的 extra、tempera 的 postProcess*），
 * 表现全是"调了没反应 / 导入后掉回默认"，没有报错。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MODE_FIELD_POOL, MODE_FIELDS_BY_MODE, validateValue } from '../../web/src/core/vfxRecipe.js';
import { DEFAULT_SETTINGS } from '../../web/src/config/defaults.js';

/** 布尔开关 → 上游默认值（folia types.ts:560-580 的 DEFAULT_SONNET_TUNING） */
const BOOL_KEYS = {
	postProcessEnabled: false,
	showOnlyText: false,
	showGuide: true,
	showGiantDecorativeText: true,
	showFixedGeo: true,
	interludeStaff: false,   // Aria 扩展：默认 false = 只认 ♪（上游行为）
};
/** 数值强度 → [上游默认值, 下界, 上界]（取值域见上游 types.ts:543-557 的注释与面板滑杆） */
const NUM_KEYS = {
	postProcessGrain: [0.2, 0, 1],
	postProcessContrast: [0, 0, 1],
	postProcessRgbShift: [0, 0, 1],
	postProcessHalftone: [0, 0, 1],
	postProcessVignette: [0.85, 0, 2],
	postProcessLensDistortion: [0.3, 0, 2],
	postProcessLensDispersion: [0.6, 0, 1],
	cameraIntensity: [1, 0, 2],
	typographyMotion: [1, 0, 2],
	mgDensity: [1, 0, 2],
};
/** 枚举键 → [上游默认值, 合法值]（上游 stores 里也是"只认这三个，其余回落默认"） */
const ENUM_KEYS = {
	outerFrameMode: ['full', ['none', 'frame', 'full']],
};

const ALL_KEYS = [
	...Object.keys(BOOL_KEYS), ...Object.keys(NUM_KEYS), ...Object.keys(ENUM_KEYS),
];

const readSrc = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('SS1 schema：类型与取值域都对（布尔只收布尔、数值越界拒、枚举只认合法值）', () => {
	for (const key of Object.keys(BOOL_KEYS)) {
		assert.equal(validateValue(MODE_FIELD_POOL[key], true).ok, true, `${key} 应接受布尔`);
		assert.equal(validateValue(MODE_FIELD_POOL[key], false).ok, true);
		assert.equal(validateValue(MODE_FIELD_POOL[key], 0.5).ok, false, `${key} 不该接受数字`);
	}
	for (const [key, [, min, max]] of Object.entries(NUM_KEYS)) {
		assert.equal(validateValue(MODE_FIELD_POOL[key], min).ok, true, `${key} 下界 ${min} 合法`);
		assert.equal(validateValue(MODE_FIELD_POOL[key], max).ok, true, `${key} 上界 ${max} 合法`);
		assert.equal(validateValue(MODE_FIELD_POOL[key], max + 0.5).ok, false, `${key} 越界必须拒`);
		assert.equal(validateValue(MODE_FIELD_POOL[key], min - 0.5).ok, false, `${key} 负向越界必须拒`);
	}
	for (const [key, [, legal]] of Object.entries(ENUM_KEYS)) {
		for (const value of legal) {
			assert.equal(validateValue(MODE_FIELD_POOL[key], value).ok, true, `${key} 应接受 ${value}`);
		}
		assert.equal(validateValue(MODE_FIELD_POOL[key], 'bogus').ok, false, `${key} 未知档必须拒`);
	}
});

test('SS2 pv 字段池收录全部键（否则存不进分享码）', () => {
	const pool = MODE_FIELDS_BY_MODE.pv;
	for (const key of ALL_KEYS) {
		assert.ok(pool.includes(key), `MODE_FIELDS_BY_MODE.pv 缺 ${key}：配方会静默丢掉它`);
	}
});

test('SS3 开箱默认档 = 上游值；语义键不得翻', () => {
	const pv = DEFAULT_SETTINGS.modeSettings.pv;
	for (const [key, value] of Object.entries(BOOL_KEYS)) {
		assert.equal(pv[key], value, `defaults.js 的 pv.${key} 必须是上游值 ${value}`);
	}
	for (const [key, [value]] of Object.entries(NUM_KEYS)) {
		assert.equal(pv[key], value, `defaults.js 的 pv.${key} 必须是上游值 ${value}`);
	}
	for (const [key, [value]] of Object.entries(ENUM_KEYS)) {
		assert.equal(pv[key], value, `defaults.js 的 pv.${key} 必须是上游值 ${value}`);
	}
	/* 语义断言（不只是数值对齐） */
	assert.equal(pv.postProcessEnabled, false, '主开关默认必须关：开着就是"还没分镜就有雪花"');
	assert.equal(pv.showOnlyText, false, '不得默认"仅文字"');
	assert.equal(pv.interludeStaff, false, '扩展必须默认关 —— 默认档要等于上游行为（只认 ♪）');
	assert.equal(pv.outerFrameMode, 'full', '上游默认是 full（画框 + 竖排主题名）');
});

test('SS4 另外四处必须同步（190 兜底 / previewEngine 回填 / 引擎映射 / 面板 data-var）', async () => {
	const { collectSchemaModeVars } = await import('../../web/src/config/appearanceSchema.js');
	const pvVars = new Set(collectSchemaModeVars('pv'));
	const rendererSrc = readSrc('../../web/src/ui/settingsRenderer.js');
	const files = {
		'190 兜底': readSrc('../../web/src/app/190-settings-fontsize.js'),
		'previewEngine 回填': readSrc('../../web/src/core/previewEngine.js'),
		'引擎 applySettings 映射': readSrc('../../web/src/core/visualizers/sonnet/SonnetEngine.js'),
		'面板 schema': readSrc('../../web/src/config/appearanceSchema.js'),
	};
	for (const [label, src] of Object.entries(files)) {
		for (const key of ALL_KEYS) {
			assert.ok(src.includes(key), `${label} 缺 ${key}`);
		}
	}
	assert.ok(rendererSrc.includes('dataset.var') || rendererSrc.includes('data-var'), 'settingsRenderer 必须写入 data-var');
	for (const key of ALL_KEYS) {
		assert.ok(pvVars.has(key), `appearanceSchema 的 pv 段缺 ${key}`);
	}
});
