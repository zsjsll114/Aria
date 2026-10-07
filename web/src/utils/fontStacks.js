/* Portions ported from chthollyphile/folia-major (AGPL-3.0) — Copyright (c) chthollyphile and contributors. See THIRD_PARTY_NOTICES.md */
/**
 * 机械移植自 chthollyphile/folia-major src/utils/fontStacks.ts @ 119 行
 * Theme 类型引用已删除（调用方传 plain object {fontStyle, fontFamily, fontFamilyStack}）。
 */
export const MIN_FONT_WEIGHT = 100;
export const MAX_FONT_WEIGHT = 900;
export const FONT_WEIGHT_STEP = 10;

export const normalizeFontWeight = (fontWeight) => {
    if (typeof fontWeight !== 'number' || !Number.isFinite(fontWeight)) return null;

    const clamped = Math.min(MAX_FONT_WEIGHT, Math.max(MIN_FONT_WEIGHT, fontWeight));
    return Math.round(clamped / FONT_WEIGHT_STEP) * FONT_WEIGHT_STEP;
};

export const resolveThemeFontWeight = (theme, fallback) => normalizeFontWeight(theme?.fontWeight) ?? fallback;

const SUGAR_SERIF_FAMILY = '"獅尾四季春加糖SC"';

export const BUILTIN_FONT_STACKS = {
    sans: '"Inter", "Noto Sans CJK SC", "Noto Sans JP", "Source Han Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif',
    serif: `${SUGAR_SERIF_FAMILY}, "Iowan Old Style", "Noto Serif CJK SC", "Noto Serif JP", "Source Han Serif SC", "Songti SC", "STSong", "Georgia", serif`,
    mono: '"IBM Plex Mono", "Sarasa Mono SC", "Noto Sans Mono CJK SC", "Noto Sans Mono", "SFMono-Regular", Consolas, monospace',
};

const TRANSLATION_FONT_STACKS = {
    sans: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", "Helvetica Neue", Arial, "Noto Sans CJK SC", "Source Han Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans JP", "Source Han Sans JP", "Hiragino Sans", "Yu Gothic", Meiryo, sans-serif',
    serif: `${SUGAR_SERIF_FAMILY}, "Folia Noto Serif SC", "Iowan Old Style", Georgia, "Times New Roman", "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", "STSong", "SimSun", "Noto Serif JP", "Source Han Serif JP", "Yu Mincho", "MS PMincho", serif`,
    mono: 'Consolas, "IBM Plex Mono", "SFMono-Regular", Menlo, Monaco, "Sarasa Mono SC", "Noto Sans Mono CJK SC", "SimHei", "DengXian", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans Mono CJK JP", "MS Gothic", monospace',
};

const CSS_GENERIC_FONT_FAMILIES = new Set([
    'serif',
    'sans-serif',
    'monospace',
    'cursive',
    'fantasy',
    'system-ui',
    'ui-serif',
    'ui-sans-serif',
    'ui-monospace',
    'ui-rounded',
    'emoji',
    'math',
    'fangsong',
]);

const quoteFontFamily = (fontFamily) => `"${fontFamily.replace(/["\\]/g, '\\$&')}"`;

const normalizeFontFamilyName = (fontFamily) => fontFamily.trim().replace(/^['"]|['"]$/g, '').trim();

/**
 * ★ Aria 适配（2026-10-01）：把「单族名或整段字体栈字符串」拆成族名数组。
 * Aria 的 resolveFontFamily 返回的是完整 CSS 栈（'Segoe UI', 'Microsoft YaHei', sans-serif），
 * 而 folia 上游 theme.fontFamily 语义是单个族名。整串流进 normalizeFontFamilyStack 会被
 * 当成一个族名剥引号→再被 quoteFontFamily 整体包双引号，产出
 * `"Segoe UI', 'Microsoft YaHei', sans-serif"` 这种引号不配对的嵌套污染段——
 * Pixi toFontString 按逗号 split 后出现孤引号族名，特定路径下 canvas 字体度量/绘制
 * 回退 10px 默认字体（字号 249px 渲染成 7×12，用户实测「tempera 字怎么都调不大」）。
 * 按逗号拆开逐段归一化即根治；对上游的单族名输入是恒等变换。
 */
const splitFontFamilyStack = (input) => {
    if (typeof input !== 'string') return [];
    return input.split(',').map(segment => segment.trim()).filter(Boolean);
};

const formatFontFamily = (fontFamily) => {
    const normalized = normalizeFontFamilyName(fontFamily);
    if (!normalized) return null;

    return CSS_GENERIC_FONT_FAMILIES.has(normalized.toLowerCase())
        ? normalized
        : quoteFontFamily(normalized);
};

export const normalizeFontFamilyStack = (fontFamilies) => {
    const seen = new Set();
    const stack = [];

    fontFamilies?.forEach(fontFamily => {
        /* ★ Aria 适配：先按逗号拆（见 splitFontFamilyStack 注释），再逐段去引号去重 */
        splitFontFamilyStack(fontFamily ?? '').forEach(familyName => {
            const normalized = normalizeFontFamilyName(familyName);
            if (!normalized) return;

            const key = normalized.toLocaleLowerCase();
            if (seen.has(key)) return;

            seen.add(key);
            stack.push(normalized);
        });
    });

    return stack;
};

/**
 * ★ Aria 适配（2026-10-01）：把任意「族名/字体栈」输入清洗成合法 CSS font-family 栈。
 * 供不走 resolveThemeFontStack 的直接消费者使用（sonnet/scroll 的 engine.fontFamily
 * 会直接进 Pixi TextStyle——嵌套污染段会让渲染回退 10px 字体）。
 */
export const sanitizeCssFontFamily = (input, fallback = 'sans-serif') => {
    const stack = normalizeFontFamilyStack(input ? [input] : [])
        .map(formatFontFamily)
        .filter(Boolean);
    if (stack.length === 0) return fallback;
    if (!stack.some(name => CSS_GENERIC_FONT_FAMILIES.has(name.toLowerCase()))) {
        stack.push(fallback);
    }
    return stack.join(', ');
};

const buildCustomFontFamilyStack = (theme) => {
    const familiesToNormalize = [
        ...(theme.fontFamily ? [theme.fontFamily] : []),
        ...(theme.fontFamilyStack ?? []),
    ];

    if (familiesToNormalize.length === 0) {
        return [];
    }

    return normalizeFontFamilyStack(familiesToNormalize)
        .map(formatFontFamily)
        .filter((fontFamily) => Boolean(fontFamily));
};

export const getBuiltinThemeFontStack = (fontStyle) => {
    return BUILTIN_FONT_STACKS[fontStyle] ?? BUILTIN_FONT_STACKS.sans;
};

export const resolveThemeFontStack = (theme) => {
    const fallbackStack = getBuiltinThemeFontStack(theme.fontStyle);
    const customFontStack = buildCustomFontFamilyStack(theme);

    if (customFontStack.length === 0) {
        return fallbackStack;
    }

    return `${customFontStack.join(', ')}, ${fallbackStack}`;
};

export const resolveThemeTranslationFontStack = (theme) => {
    const fallbackStack = TRANSLATION_FONT_STACKS[theme.fontStyle] ?? TRANSLATION_FONT_STACKS.sans;
    const customFontStack = buildCustomFontFamilyStack(theme);

    if (customFontStack.length === 0) {
        return fallbackStack;
    }

    return `${customFontStack.join(', ')}, ${fallbackStack}`;
};
