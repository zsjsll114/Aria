/* ============================================================
 * config/themePalette.js — 预设色板的唯一登记处
 *
 * 为什么要有这个文件：同一串 6 个色值原先在 index.html 里手抄了 17 份
 * （themeColor / highlightColor / graphicColor / bgColor / 两组灰阶），
 * 每份还各自内联同一个 12 路径彩虹 SVG 当「自定义颜色」按钮——
 * 改一个颜色要动 17 行，漏一行就是「设置页两处色板不一样」。
 * 202-settings-appearance.js 里还有第 18 份（判断"是不是预设色"的数组），
 * 000-tooltip.js 的首跑向导里又有第 19 份**且色值完全不同**（向导里选的色
 * 到设置页里根本不存在，active 直接落空）。
 *
 * ★ 色板本身的设计约束（有测试钉住，见 tests/js/test_theme_palette.js）：
 *   - 饱和度 ≤ 0.75：原先 6 个预设全是 S=1.00 的纯色，那就是"廉价感"的来源；
 *   - 对面板底 #20222e 的对比度 ≥ 5.4:1：强调色要当文字用，暗了就读不出；
 *   - 相邻色相间隔 ≥ 28°：原先金色 45° 和橙色 27° 只差 18°，六个里有两个几乎同色。
 * ============================================================ */

/** 面板玻璃底色，对比度按它算（modals.css 的 .ctx-menu / 设置面板都是这个深底） */
export const PANEL_BG = [32, 34, 46];

/** 强调色预设：key 用于持久化与 i18n，zh/en 是显示名 */
export const ACCENT_PRESETS = [
    { key: 'gold',   zh: '曜金', en: 'Obsidian Gold', hex: '#E8BE6A' },
    { key: 'coral',  zh: '丹霞', en: 'Terracotta',    hex: '#E08576' },
    { key: 'sage',   zh: '松雨', en: 'Sage Green',    hex: '#6FC2A0' },
    { key: 'teal',   zh: '石青', en: 'Stone Teal',    hex: '#5FB8C9' },
    { key: 'indigo', zh: '远黛', en: 'Dusty Indigo',  hex: '#7D9BD8' },
    { key: 'violet', zh: '暮紫', en: 'Muted Violet',  hex: '#AE90C8' },
];

/** 默认强调色：defaults.js / base.css 的 --theme-color 都指向这里，别再写第二份字面量 */
export const DEFAULT_ACCENT = ACCENT_PRESETS[0].hex;

/** 灰阶：非高亮歌词行 */
export const TEXT_PRESETS = ['#ffffff', 'rgba(255,255,255,0.6)', 'rgba(255,255,255,0.4)', '#cccccc', '#888888'];

/** 灰阶：高亮行的未高亮部分 */
export const DIM_PRESETS = ['rgba(255,255,255,0.6)', 'rgba(255,255,255,0.4)', 'rgba(255,255,255,0.3)', 'rgba(255,255,255,0.2)', '#888888'];

/** 「自定义颜色」那颗彩虹轮 SVG——原先在 index.html 里内联了 15 遍 */
export const CUSTOM_SWATCH_SVG = '<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M511.97 0.07c96.04 0 185.89 26.45 262.72 72.44l-6.74-3.84-127.95 221.64A254.79 254.79 0 0 0 511.97 256.05V0.07z" fill="#E70212"/>'
    + '<path d="M767.95 68.67a509.58 509.58 0 0 1 191.3 194.12l-3.92-3.74-221.64 127.99a257.26 257.26 0 0 0-93.69-93.69L767.95 68.67z" fill="#EA6101"/>'
    + '<path d="M955.33 256.05a509.58 509.58 0 0 1 68.6 263.75v-7.77h-255.98a254.79 254.79 0 0 0-34.26-127.99l221.64-127.99z" fill="#F39801"/>'
    + '<path d="M1023.93 512.03c0 90.02-23.25 174.67-64.04 248.18l-4.57 7.8-221.64-127.95c21.76-37.67 34.26-81.4 34.26-128.03v-0.04l255.98-0.04z" fill="#FCC902"/>'
    + '<path d="M733.69 640.03l221.64 127.99a509.66 509.66 0 0 1-179.53 182.9l-7.85 4.48-127.99-221.64a257.26 257.26 0 0 0 93.69-93.69z" fill="#FEF200"/>'
    + '<path d="M640 733.76l127.95 221.64A509.66 509.66 0 0 1 521.01 1024h-9.04v-255.98a254.79 254.79 0 0 0 128.03-34.26z" fill="#90C320"/>'
    + '<path d="M511.97 768.02v255.98c-90.02 0-174.67-23.25-248.18-64.04l-7.8-4.57 127.99-221.64c37.67 21.76 81.4 34.26 128.03 34.26z" fill="#019A44"/>'
    + '<path d="M383.97 733.76l-127.99 221.64a509.66 509.66 0 0 1-182.9-179.53l-4.48-7.85 221.64-127.99a257.26 257.26 0 0 0 93.69-93.69z" fill="#019E97"/>'
    + '<path d="M255.98 512.03c0 46.63 12.46 90.36 34.26 128.03L68.6 768.02A509.66 509.66 0 0 1 0 521.08v-9.05h255.98z" fill="#0169B8"/>'
    + '<path d="M68.6 256.05l221.64 127.99A254.79 254.79 0 0 0 255.98 512.03H0c0-90.02 23.25-174.67 64.04-248.18l4.57-7.8z" fill="#1C2089"/>'
    + '<path d="M262.68 64.75l-6.7 3.92 127.99 221.64A257.26 257.26 0 0 0 290.24 384.04L68.6 256.05A509.58 509.58 0 0 1 262.68 64.75z" fill="#621988"/>'
    + '<path d="M519.73 0.07h-7.77v255.98a254.79 254.79 0 0 0-128.03 34.26L255.98 68.67A509.58 509.58 0 0 1 519.73 0.07z" fill="#910783"/></svg>';

/** data-palette 的四种取值 → 色值序列。index.html 里只写名字，色值一律不出现在 HTML。 */
export const PALETTES = {
    accent: ACCENT_PRESETS.map(p => p.hex),
    'accent+white': ['#ffffff', ...ACCENT_PRESETS.map(p => p.hex)],
    text: TEXT_PRESETS,
    dim: DIM_PRESETS,
};

const ACCENT_SET = new Set(ACCENT_PRESETS.map(p => p.hex.toLowerCase()));

/** 是不是预设强调色（202 的下载歌词/主题面板用它决定"要不要显示成预设名"） */
export function isPresetAccent(hex) {
    return typeof hex === 'string' && ACCENT_SET.has(hex.trim().toLowerCase());
}

/** 按色值取预设名（找不到返回 null，说明是自定义色） */
export function accentPresetOf(hex) {
    const k = typeof hex === 'string' ? hex.trim().toLowerCase() : '';
    return ACCENT_PRESETS.find(p => p.hex.toLowerCase() === k) || null;
}
