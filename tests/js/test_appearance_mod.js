import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

const vfx = await import('../../web/src/core/vfxRecipe.js');
const { TOKEN_FIELDS, tokenValueSafe, parseThemeMod, validateRecipe, applyRecipeToSettings, summarizeRecipe } = vfx;
const mod = await import('../../web/src/core/appearanceMod.js');

/* ============================================================================
 * ★ 本文件的由来（2026-10-06）：
 *   我此前**自造**了一套「外观 mod」格式（_format/tokens/style/permissions），
 *   用了和仓库既有体系相同的扩展名 .aria-theme.json —— 用户把它粘进既有导入面板，
 *   被逐条判「含本程序不认识的参数（应为 sv / mode / lyrics / background /
 *   interface / modeSettings）」。
 *   下面第一条用例就是钉死这件事：**随包的 mod 必须能过仓库真正的解析器**。
 * ========================================================================= */

test('随包谷歌风 mod：必须能过真正的 parseThemeMod（不能再自造格式）', () => {
	const p = path.join(REPO, 'web/mods/google-material.aria-theme.json');
	assert.ok(fs.existsSync(p), 'mod 文件必须存在（它同时是格式文档）');
	const raw = fs.readFileSync(p, 'utf8');
	const res = parseThemeMod(raw);
	assert.deepEqual(res.errors || [], [], '随包 mod 有校验错误等于给用户发了个坏样例');
	assert.equal(res.ok, true);
	assert.equal(res.meta.name.includes('Google'), true);
	assert.equal(res.recipe.interface.themeColor, '#8AB4F8');
	/* 用户点名的三项能力都必须在配方里：圆角（窗口直角）、模糊、排版 */
	for (const k of ['--aria-radius-lg', '--aria-glass-blur', '--aria-text-2']) {
		assert.ok(Object.prototype.hasOwnProperty.call(res.recipe.tokens, k), `mod 应带 ${k}`);
	}
});

test('tokens 段：白名单外的令牌被明确拒绝，并指向正确入口', () => {
	const r = validateRecipe({ sv: 1, tokens: { '--aria-accent': '#ff0000' } });
	assert.equal(r.ok, false);
	const err = r.errors.find(e => e.path === 'tokens.--aria-accent');
	assert.ok(err, '应报 tokens.--aria-accent');
	assert.equal(err.code, 'token-not-allowed');
	/* ★ 有受管写入口的令牌一律不在白名单：主题色走 interface.themeColor */
	for (const banned of ['--aria-accent', '--aria-accent-rgb', '--theme-color', '--theme-color-rgb',
		'--aria-z-modal', '--aria-z-welcome', '--dtk-hl', '--dtk-hl-glow', '--aria-lyric-origin']) {
		assert.equal(Object.prototype.hasOwnProperty.call(TOKEN_FIELDS, banned), false, banned + ' 不该进白名单');
	}
});

test('tokens 段：值按类型校验（长度/百分比/颜色/rgb/焦点环/阴影）', () => {
	const ok = validateRecipe({
		sv: 1,
		tokens: {
			'--aria-radius-lg': '0px',            /* 窗口改成直角 */
			'--aria-glass-blur': '14px',
			'--aria-glass-saturate': '100%',
			'--aria-glass-bg': 'rgba(32, 33, 36, 0.98)',
			'--aria-text-1': '#E8EAED',
			'--aria-danger-rgb': '242, 139, 130',
			'--aria-focus-ring': '2px solid var(--aria-accent)',
			'--aria-glass-shadow': 'none',
		},
	});
	assert.equal(ok.ok, true, JSON.stringify(ok.errors));
	assert.equal(ok.recipe.tokens['--aria-radius-lg'], '0px');
	assert.equal(ok.recipe.tokens['--aria-glass-shadow'], 'none');

	const bad = (k, v) => validateRecipe({ sv: 1, tokens: { [k]: v } });
	assert.equal(bad('--aria-radius-lg', '28').ok, false, '长度必须带单位或为 0');
	assert.equal(bad('--aria-glass-blur', '28px;color:red').ok, false, '分号＝能跑出声明');
	assert.equal(bad('--aria-glass-bg', 'url(http://a/b)').ok, false, '外链一律禁');
	assert.equal(bad('--aria-text-1', 'red').ok, false, '只收色值，不收关键字');
	assert.equal(bad('--aria-focus-ring', '2px dashed red').ok, false, '焦点环只收 solid');
	assert.equal(bad('--aria-danger-rgb', '242 139 130').ok, false, '通道值用逗号分隔');
	assert.equal(tokenValueSafe('x'.repeat(200)), false, '超长拒绝');
});

test('tokens 段：落地到 interface.appearanceTokens（不新开顶层键）', () => {
	const s = { interface: { themeColor: '#E8BE6A' }, lyrics: {}, background: {}, modeSettings: {} };
	const r = applyRecipeToSettings(s, { sv: 1, tokens: { '--aria-radius-lg': '28px' } });
	assert.equal(r.ok, true);
	assert.equal(r.counts.tokens, 1);
	assert.equal(s.interface.appearanceTokens['--aria-radius-lg'], '28px');
	/* ★ 顶层新键会被 loadSettings 静默丢掉（AGENTS 记过这个坑），所以必须在 interface 下 */
	assert.equal(Object.prototype.hasOwnProperty.call(s, 'tokens'), false);
	/* 再应用一份：是合并，不是替换（避免换 mod 时把没写的令牌清掉） */
	applyRecipeToSettings(s, { sv: 1, tokens: { '--aria-glass-blur': '0px' } });
	assert.equal(s.interface.appearanceTokens['--aria-radius-lg'], '28px');
	assert.equal(s.interface.appearanceTokens['--aria-glass-blur'], '0px');
});

test('tokens 计数进摘要（UI 要说得出「这份配方会改什么」）', () => {
	const sum = summarizeRecipe({ sv: 1, tokens: { '--aria-radius-lg': '28px', '--aria-text-2': '#9AA0A6' } });
	assert.equal(sum.groups.tokens, 2);
	assert.ok(sum.total >= 2);
});

test('令牌落地层：只碰行内层、只回滚自己写过的（不碰 appSettings）', () => {
	/* 假 document：够用的最小实现，验证 setProperty/removeProperty 的调用与清场语义 */
	const set = new Map();
	const fake = {
		documentElement: {
			style: {
				setProperty: (k, v) => set.set(k, v),
				removeProperty: (k) => set.delete(k),
				getPropertyValue: (k) => set.get(k) || '',
			},
		},
	};
	const r = mod.applyAppearanceTokens({ '--aria-radius-lg': '28px', '--bad-key': 'x' }, { doc: fake });
	assert.equal(r.applied, 1, '非 --aria-* 的键不下发');
	assert.equal(set.get('--aria-radius-lg'), '28px');
	assert.deepEqual(mod.appliedAppearanceTokens({ doc: fake }), { '--aria-radius-lg': '28px' });
	assert.equal(mod.clearAppearanceTokens({ doc: fake }), 1);
	assert.equal(set.has('--aria-radius-lg'), false, '清掉行内值即回到 tokens.css 默认值');
});
