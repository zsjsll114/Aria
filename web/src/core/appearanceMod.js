/**
 * appearanceMod.js — 外观令牌的**落地层**（2026-10-06 重写）
 *
 * ★ 为什么重写：上一版这里自造了一套「外观 mod」格式
 *   （`_format` / `tokens` / `style` / `permissions`），而仓库里**早就有** mod 体系：
 *   `vfxRecipe.THEME_MOD_KIND = 'ariaTheme'` + `.aria-theme.json` + 290 的导入面板。
 *   两套格式撞了同一个扩展名 —— 用户把文件粘进既有导入框，被判
 *   「含本程序不认识的参数（应为 sv / mode / lyrics / background / interface / modeSettings）」。
 *   **结论：不再有第二套格式。** mod 走既有 `ariaTheme`，令牌是配方的 `tokens` 段
 *   （白名单与值校验在 `vfxRecipe.js` 的 `TOKEN_FIELDS`，那是单一事实源）。
 *
 * 职责边界（刻意收窄，避免又长出并行体系）：
 *   · 校验（白名单 / 值安全）→ vfxRecipe.js
 *   · 存储（跟着配方一起落盘）→ appSettings.interface.appearanceTokens
 *   · 落地（写成 documentElement 的行内自定义属性）→ 本模块
 * 本模块**不**读 appSettings、**不**写 appSettings、**不**占 globalThis 键。
 */

const TOKEN_RE = /^--aria-[a-z0-9-]+$/;

/** 已由本模块写下的令牌（清场只回滚自己写过的，不碰别人的行内值）。 */
let _applied = [];

/**
 * 把令牌表落到 documentElement 的行内自定义属性。
 * ★ 每次都先清掉自己上一轮写的、再写新的：换一份 mod 不会残留上一份的值；
 *   而且只动**行内层**，tokens.css 里的默认值始终在下面兜着（清掉即还原）。
 * @param {Record<string,string>|null} tokens
 * @param {{doc?:Document}} [opts]
 * @returns {{applied:number, cleared:number}}
 */
export function applyAppearanceTokens(tokens, opts) {
	const doc = (opts && opts.doc) || (typeof document !== 'undefined' ? document : null);
	if (!doc) return { applied: 0, cleared: 0 };
	const cleared = clearAppearanceTokens({ doc });
	const root = doc.documentElement;
	let applied = 0;
	if (tokens && typeof tokens === 'object') {
		for (const key of Object.keys(tokens)) {
			if (!TOKEN_RE.test(key)) continue;
			const v = tokens[key];
			if (typeof v !== 'string' || !v) continue;
			try { root.style.setProperty(key, v); _applied.push(key); applied++; } catch { /* 单个失败不阻断整表 */ }
		}
	}
	return { applied, cleared };
}

/** 回滚本模块写过的令牌（行内层清掉即回到 tokens.css 的默认值）。 */
export function clearAppearanceTokens(opts) {
	const doc = (opts && opts.doc) || (typeof document !== 'undefined' ? document : null);
	if (!doc) return 0;
	let n = 0;
	for (const key of _applied) {
		try { doc.documentElement.style.removeProperty(key); n++; } catch { /* 忽略 */ }
	}
	_applied = [];
	return n;
}

/** 当前生效的令牌快照（行内层），诊断与测试用。 */
export function appliedAppearanceTokens(opts) {
	const doc = (opts && opts.doc) || (typeof document !== 'undefined' ? document : null);
	if (!doc) return {};
	const out = {};
	for (const key of _applied) out[key] = doc.documentElement.style.getPropertyValue(key);
	return out;
}
