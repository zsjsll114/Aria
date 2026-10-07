/* ============================================================
 * tests/js/test_theme_palette.js — 预设色板的唯一登记处 + 设计契约
 *
 * 两件事分开钉：
 *  A. 结构：色板只有一份、index.html 里不许再出现色值、默认色与色板首项一致。
 *     （原先 6 个色值在 index.html 手抄 17 份、202 里又抄 1 份判断数组、
 *      首跑向导另写一份**完全不同**的 6 个色——改一处漏十四处。）
 *  B. 设计：这套色板为什么"不廉价"是可以量出来的，不靠人眼投票——
 *     饱和度上限、对面板底的对比度下限、色相间隔下限。
 *     旧色板 6 个全是 S=1.00 的纯色，且金色 45° 与橙色 27° 只差 18°
 *     （六个里有两个几乎同色），这正是"丑"的可测部分。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
    ACCENT_PRESETS, DEFAULT_ACCENT, DIM_PRESETS, PALETTES, PANEL_BG,
    TEXT_PRESETS, accentPresetOf, isPresetAccent,
} from '../../web/src/config/themePalette.js';
import { hexToRgb, relativeLuminance, rgbToHsl } from '../../web/src/utils/colorUtils.js';

const REPO = path.resolve(import.meta.dirname, '../..');
const SATURATION_CAP = 0.75;   /* 与 core/colorUtils.js 的 refineColor 同一档：超过就"荧光笔" */
const CONTRAST_FLOOR = 5.4;    /* 强调色要当文字用，面板底 #20222e 上低于这个就读不出 */
const HUE_GAP_FLOOR = 28;      /* 相邻色相至少隔这么多度，否则两颗看起来同色 */

const panelL = relativeLuminance(...PANEL_BG);

test('A1 每个预设都有 key / zh / en / hex 四个字段，hex 是合法 6 位', () => {
    assert.ok(ACCENT_PRESETS.length >= 6, '预设至少 6 个');
    for (const p of ACCENT_PRESETS) {
        assert.ok(p.key && /^[a-z]+$/.test(p.key), `key 非法: ${p.key}`);
        assert.ok(p.zh && p.en, `${p.key} 缺中英文名`);
        assert.match(p.hex, /^#[0-9A-F]{6}$/, `${p.key} hex 必须是大写 6 位: ${p.hex}`);
        assert.ok(hexToRgb(p.hex), `${p.key} hex 解析失败`);
    }
    const keys = ACCENT_PRESETS.map(p => p.key);
    assert.equal(new Set(keys).size, keys.length, 'key 不得重复');
});

test('A2 色板是唯一来源：index.html 里不许再出现任何十六进制色值', () => {
    const html = fs.readFileSync(path.join(REPO, 'web/index.html'), 'utf8');
    /* 水合后 HTML 只该有 data-palette / data-active；data-active 允许（它是"默认亮哪颗"的指针） */
    const rows = html.match(/class="setting-color-row"[^>]*/g) || [];
    assert.ok(rows.length >= 15, `色板行应全部保留，实际 ${rows.length}`);
    for (const r of rows) {
        assert.match(r, /data-palette="(accent|accent\+white|text|dim)"/, `行缺 data-palette: ${r.slice(0, 90)}`);
        assert.ok(!/style="background:/.test(r), `行里不该再有内联色: ${r.slice(0, 90)}`);
    }
    assert.ok(!/data-color="#/.test(html), 'index.html 不该再有手抄的 data-color 色值');
    assert.ok(!/color-swatch/.test(html), 'index.html 不该再有手抄的 .color-swatch 节点');
    /* ★ 把 17 行手抄色块换成一行 data-palette 时，最容易漏的就是闭合标签：
       第一版就是 18 行全部少了 `</div>`，症状却完全不在色板上——后面每个元素
       嵌套深一层，#sleepTimerOverlay 掉进 .settings-group 里变成 0×0，
       而"水合后有没有色块"这类断言照样全绿。所以这里直接钉结构不变量。
       （<div> 计数对得上不代表嵌套一定对，但对不上就一定坏。） */
    const open = (html.match(/<div\b/g) || []).length;
    const close = (html.match(/<\/div>/g) || []).length;
    assert.equal(open, close, `index.html 的 div 开合不配对：${open} 开 / ${close} 闭`);
});

test('A3 默认强调色 = 色板首项，且 defaults.js 不再写字面量', () => {
    assert.equal(DEFAULT_ACCENT, ACCENT_PRESETS[0].hex);
    const defaults = fs.readFileSync(path.join(REPO, 'web/src/config/defaults.js'), 'utf8');
    assert.match(defaults, /import \{ DEFAULT_ACCENT \} from '\.\/themePalette\.js'/);
    assert.ok(!/#ffcc33/i.test(defaults), 'defaults.js 里不该再有旧金色字面量');
});

test('A4 全仓只剩装饰色里的旧金色，主题色的两种写法都已跟上', () => {
    const hits = [];
    const rgbHits = [];
    /* _eval/ 在 .gitignore 里（scripts/setup-vendors.bat 重建），不是本仓源码，扫它只会误报 */
    const SKIP = new Set(['node_modules', 'vendor', '_eval', '.workbuddy', '.git', 'dist', 'dist-stub', 'scratch']);
    (function walk(abs) {
        for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
            if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(path.join(abs, e.name)); continue; }
            if (!/\.(js|css|html)$/.test(e.name)) continue;
            const full = path.join(abs, e.name);
            const rel = path.relative(REPO, full).replace(/\\/g, '/');
            const s = fs.readFileSync(full, 'utf8');
            s.split('\n').forEach((line, i) => {
                const at = `${rel}:${i + 1}`;
                if (/ffcc33/i.test(line)) hits.push(at);
                if (/255, ?204, ?51/.test(line)) rgbHits.push(at);
            });
        }
    })(path.join(REPO, 'web'));
    assert.deepEqual(hits, ['web/src/core/pvEngine/PVEngine.js:138'],
        `旧金色十六进制残留: ${hits.join(', ')}`);
    /* 主题色除了十六进制还有 rgba(255,204,51,…) 这种写法：只换十六进制会在同一条规则里
       留下两个金色（pv-tunnel.css:545 实测就是 color:#E8BE6A 配 text-shadow:rgba(255,204,51,.85)）。
       允许残留的只有两处真装饰色：AI 面板的高亮笔 marker（=renderChorusMarkers 的副歌标记条，
       ★ 行号漂移史：2026-09-26 从 1636/1637 → 1658/1659（f4f6973 团队提交）；
       2026-09-29 → 1654/1655（getLowQualityAudioUrl 删 ygking 死链块，行数 -9）；
       2026-10-05 → 1663/1664（applyEmotionWordColors 补 ensureEmotionWordStyle 兜底，+8 行）。
       行号硬编码本就脆弱，这里先跟上）、回响视觉器自己的能量光。 */
    const DECORATIVE_RGB = new Set([
        'web/src/app/201-settings-ai.js:1663',
        'web/src/app/201-settings-ai.js:1664',
        'web/src/core/visualizers/dimension/DimensionBackground.js:22',
    ]);
    const unexpected = rgbHits.filter(h => !DECORATIVE_RGB.has(h));
    assert.deepEqual(unexpected, [], `主题色 rgb 形态没跟上: ${unexpected.join(', ')}`);
});

test('A4b tokens.css 的 --aria-accent 与 --aria-accent-rgb 必须表示同一个颜色', () => {
    /* P1（2026-10-05）：主题色的 CSS 单一来源从 base.css 的 :root 迁到
       styles/tokens.css。base.css 那份已删——它 <link> 在 tokens.css 之后，
       :root 同特异度后来者胜，留着会把 --theme-color 别名覆盖回字面量，
       整个令牌层静默失效。这里同步改指 tokens.css 并加回归断言。 */
    const css = fs.readFileSync(path.join(REPO, 'web/src/styles/tokens.css'), 'utf8');
    const hex = /--aria-accent:\s*(#[0-9a-fA-F]{6})/.exec(css);
    const rgb = /--aria-accent-rgb:\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(css);
    assert.ok(hex && rgb, 'tokens.css 里两个变量都得有');
    assert.deepEqual([Number(rgb[1]), Number(rgb[2]), Number(rgb[3])], hexToRgb(hex[1]),
        `--aria-accent ${hex[1]} 与 --aria-accent-rgb ${rgb[1]},${rgb[2]},${rgb[3]} 不是同一个颜色`);
    assert.equal(hex[1].toUpperCase(), DEFAULT_ACCENT.toUpperCase());
    /* 兼容别名必须指向令牌本体 */
    assert.match(css, /--theme-color:\s*var\(--aria-accent\)/, '--theme-color 必须退化为 var(--aria-accent) 别名');
    /* base.css 不得再定义 --theme-color */
    const base = fs.readFileSync(path.join(REPO, 'web/src/styles/base.css'), 'utf8');
    assert.ok(!/--theme-color\s*:/.test(base),
        'base.css 不得再定义 --theme-color（它会覆盖 tokens.css 的别名）');
});

test('A5 isPresetAccent 大小写与空白都不敏感', () => {
    for (const p of ACCENT_PRESETS) {
        assert.ok(isPresetAccent(p.hex), p.hex);
        assert.ok(isPresetAccent(p.hex.toLowerCase()), p.hex.toLowerCase());
        assert.ok(isPresetAccent('  ' + p.hex + ' '), 'should trim');
        assert.equal(accentPresetOf(p.hex).key, p.key);
    }
    assert.equal(isPresetAccent('#123456'), false);
    assert.equal(isPresetAccent(''), false);
    assert.equal(isPresetAccent(null), false);
    assert.equal(accentPresetOf('#123456'), null);
});

test('A6 四种 data-palette 都在 PALETTES 里，且灰阶不含强调色', () => {
    for (const k of ['accent', 'accent+white', 'text', 'dim']) {
        assert.ok(Array.isArray(PALETTES[k]) && PALETTES[k].length >= 5, `PALETTES.${k} 缺失`);
    }
    assert.deepEqual(PALETTES.accent, ACCENT_PRESETS.map(p => p.hex));
    assert.equal(PALETTES['accent+white'][0], '#ffffff');
    assert.equal(PALETTES['accent+white'].length, ACCENT_PRESETS.length + 1);
    const accents = new Set(ACCENT_PRESETS.map(p => p.hex.toLowerCase()));
    for (const h of [...TEXT_PRESETS, ...DIM_PRESETS]) {
        assert.ok(!accents.has(String(h).toLowerCase()), `灰阶里混进了强调色: ${h}`);
    }
});

test('B1 设计契约：饱和度 ≤ 0.75（旧色板 6 颗全是 1.00，那就是廉价感的来源）', () => {
    for (const p of ACCENT_PRESETS) {
        const [r, g, b] = hexToRgb(p.hex);
        const [, s] = rgbToHsl(r, g, b);
        assert.ok(s <= SATURATION_CAP + 1e-6,
            `${p.key} ${p.hex} 饱和度 ${s.toFixed(2)} 超上限 ${SATURATION_CAP}`);
    }
});

test('B2 设计契约：对面板底对比度 ≥ 5.4:1（强调色要当文字用）', () => {
    for (const p of ACCENT_PRESETS) {
        const [r, g, b] = hexToRgb(p.hex);
        const L = relativeLuminance(r, g, b);
        const ratio = (L + 0.05) / (panelL + 0.05);
        assert.ok(ratio >= CONTRAST_FLOOR,
            `${p.key} ${p.hex} 对比度 ${ratio.toFixed(2)}:1 低于 ${CONTRAST_FLOOR}:1`);
    }
});

test('B3 设计契约：色相两两间隔 ≥ 28°（旧色板金色与橙色只差 18°）', () => {
    const hues = ACCENT_PRESETS.map(p => {
        const [r, g, b] = hexToRgb(p.hex);
        return rgbToHsl(r, g, b)[0] * 360;
    });
    for (let i = 0; i < hues.length; i++) {
        for (let j = i + 1; j < hues.length; j++) {
            const d = Math.abs(hues[i] - hues[j]);
            const gap = Math.min(d, 360 - d);
            assert.ok(gap >= HUE_GAP_FLOOR,
                `${ACCENT_PRESETS[i].key}(${hues[i].toFixed(0)}°) 与 ${ACCENT_PRESETS[j].key}(${hues[j].toFixed(0)}°) 只差 ${gap.toFixed(0)}°`);
        }
    }
});

test('B4 设计契约：亮度落在可读区间，既不发灰也不刺眼', () => {
    for (const p of ACCENT_PRESETS) {
        const [r, g, b] = hexToRgb(p.hex);
        const L = relativeLuminance(r, g, b);
        assert.ok(L >= 0.28 && L <= 0.62, `${p.key} ${p.hex} 相对亮度 ${L.toFixed(3)} 越界`);
    }
});

test('B5 反向验证：旧色板确实过不了上面这几条', () => {
    const OLD = ['#ffcc33', '#ff6b6b', '#51d0ff', '#a8ff51', '#ff8aff', '#ff9540'];
    const sat = OLD.map(h => rgbToHsl(...hexToRgb(h))[1]);
    assert.ok(sat.every(s => s > SATURATION_CAP), '旧色板应全部超饱和上限');
    const hues = OLD.map(h => rgbToHsl(...hexToRgb(h))[0] * 360).sort((a, b) => a - b);
    let minGap = 360;
    for (let i = 0; i < hues.length; i++) {
        const d = i ? hues[i] - hues[i - 1] : 360 - hues[hues.length - 1] + hues[0];
        minGap = Math.min(minGap, d);
    }
    assert.ok(minGap < HUE_GAP_FLOOR, `旧色板最小色相间隔 ${minGap.toFixed(0)}° 应小于 ${HUE_GAP_FLOOR}°`);
});
