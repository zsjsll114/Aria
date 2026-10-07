/* ============================================================
 * tests/js/test_design_tokens.js — P1 设计令牌层门禁
 *
 * 钉住四件事：
 *  T1 JS / CSS 两处强调色不得漂移（tokens.css 的 --aria-accent ↔
 *     themePalette.js 的 DEFAULT_ACCENT）。这是令牌层唯一的"两个事实源"，
 *     漂移后 mod 作者按 CSS 改、界面却不全变。
 *  T2 --theme-color 已退化为别名（只减不增），且指向令牌本体。
 *  T3 迁移完整：除 tokens.css 外没有任何 CSS 再引用/定义 --theme-color。
 *  T4 令牌登记表（scripts/audits/token-registry.json）与 tokens.css 双向一致，
 *     含 reserved 名字空间不重叠。
 *  T5 加载顺序不变量：tokens.css 必须排在 index.html 其它样式之前。
 *  T6 独立窗口（lyrics.html / remote.html）必须显式接入。
 *  T7 行内写入棘轮：活代码不得再写行内 --theme-color —— 行内值会盖掉别名，
 *     使社区 mod 覆盖 --aria-accent 时静默失效。
 *     （唯一豁免是冻结的影子模块 core/themeEngine.js，见 AGENTS 约束 10。）
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_ACCENT } from '../../web/src/config/themePalette.js';
import { hexToRgb } from '../../web/src/utils/colorUtils.js';

const REPO = path.resolve(import.meta.dirname, '../..');
const STYLES = path.join(REPO, 'web/src/styles');
const TOKENS_PATH = path.join(STYLES, 'tokens.css');
const REGISTRY_PATH = path.join(REPO, 'scripts/audits/token-registry.json');

const tokensCss = fs.readFileSync(TOKENS_PATH, 'utf8');
const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));

/** 去掉注释再解析令牌名：文档注释里大量出现 --aria-* / html#ariaRoot 示例，
 *  不剥离会把示例名当成真实声明，T4 的"死登记"判断会全部误报。 */
function stripComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** tokens.css 里顶层声明的自定义属性名（去重保序） */
function declaredTokenNames(css) {
    const out = [];
    for (const m of css.matchAll(/^[ \t]*(--[a-z0-9-]+)[ \t]*:/gim)) {
        if (!out.includes(m[1])) out.push(m[1]);
    }
    return out;
}

/** 冻结的影子模块：AGENTS 约束 10 —— 从入口不可达、门禁 A 禁止 import。
 *  它们的行内写入不参与棘轮（也不该去"修"，接管时以分片活实现为准重写）。 */
const FROZEN_SHADOW = new Set(['web/src/core/themeEngine.js']);

test('T1 JS/CSS 两处强调色不得漂移（唯一事实源的守卫）', () => {
    const hex = /--aria-accent:[ \t]*(#[0-9a-fA-F]{6})/.exec(tokensCss);
    const rgb = /--aria-accent-rgb:[ \t]*(\d+)[ \t]*,[ \t]*(\d+)[ \t]*,[ \t]*(\d+)/.exec(tokensCss);
    assert.ok(hex, 'tokens.css 必须声明 --aria-accent');
    assert.ok(rgb, 'tokens.css 必须声明 --aria-accent-rgb');
    assert.deepEqual([Number(rgb[1]), Number(rgb[2]), Number(rgb[3])], hexToRgb(hex[1]),
        `--aria-accent ${hex[1]} 与 --aria-accent-rgb 不是同一个颜色`);
    assert.equal(hex[1].toUpperCase(), DEFAULT_ACCENT.toUpperCase(),
        `tokens.css 的 ${hex[1]} 与 themePalette.DEFAULT_ACCENT ${DEFAULT_ACCENT} 漂移了`);
});

test('T2 --theme-color 退化为兼容别名且指向令牌本体', () => {
    assert.match(tokensCss, /--theme-color:[ \t]*var\(--aria-accent\)/,
        '--theme-color 必须是 var(--aria-accent) 别名（只减不增）');
    assert.match(tokensCss, /--theme-color-rgb:[ \t]*var\(--aria-accent-rgb\)/,
        '--theme-color-rgb 必须是 var(--aria-accent-rgb) 别名');
});

test('T3 迁移完整性：除 tokens.css 外没有 CSS 再引用/定义 --theme-color', () => {
    const bad = [];
    for (const f of fs.readdirSync(STYLES)) {
        if (!f.endsWith('.css') || f === 'tokens.css') continue;
        const css = stripComments(fs.readFileSync(path.join(STYLES, f), 'utf8'));
        if (/--theme-color/.test(css)) bad.push(f);
    }
    assert.deepEqual(bad, [], `仍残留旧令牌引用（应改走 var(--aria-accent)）: ${bad.join(', ')}`);
});

test('T4 令牌登记表与 tokens.css 双向一致（无未登记 / 无死登记）', () => {
    const declared = declaredTokenNames(stripComments(tokensCss));
    const active = registry.active;
    const missing = declared.filter((n) => !active.includes(n));
    const orphan = active.filter((n) => !declared.includes(n));
    assert.deepEqual(missing, [], `tokens.css 里未登记的令牌: ${missing.join(', ')}`);
    assert.deepEqual(orphan, [], `登记了但 tokens.css 未声明（死登记）: ${orphan.join(', ')}`);
});

test('T5 reserved 名字空间与 active 不重叠，且都带 -- 前缀', () => {
    const reserved = Object.entries(registry.reserved)
        .filter(([k]) => !k.startsWith('_'))
        .flatMap(([, v]) => v);
    assert.ok(reserved.length > 0, 'reserved 不应为空（它是后续阶段的命名空间预留）');
    const overlap = reserved.filter((n) => registry.active.includes(n));
    assert.deepEqual(overlap, [], `active 与 reserved 重叠: ${overlap.join(', ')}`);
    const badPrefix = reserved.filter((n) => !/^--/.test(n));
    assert.deepEqual(badPrefix, [], `reserved 名字必须带 -- 前缀: ${badPrefix.join(', ')}`);
});

test('T6 加载顺序不变量：index.html 里 tokens.css 必须排在其它样式之前', () => {
    const html = fs.readFileSync(path.join(REPO, 'web/index.html'), 'utf8');
    const iTokens = html.indexOf('src/styles/tokens.css');
    assert.ok(iTokens > 0, 'index.html 必须 link tokens.css');
    const later = [];
    for (const f of fs.readdirSync(STYLES)) {
        if (!f.endsWith('.css') || f === 'tokens.css') continue;
        const at = html.indexOf(`src/styles/${f}`);
        if (at >= 0 && at < iTokens) later.push(f);
    }
    assert.deepEqual(later, [], `这些样式排在 tokens.css 之前: ${later.join(', ')}`);
});

test('T7 独立窗口也接入令牌（lyrics.html / remote.html）', () => {
    for (const page of ['lyrics.html', 'remote.html']) {
        const html = fs.readFileSync(path.join(REPO, 'web', page), 'utf8');
        assert.ok(html.includes('src/styles/tokens.css'), `${page} 未 link tokens.css`);
    }
});

test('T8 行内写入棘轮：活代码不得写行内 --theme-color（会盖掉别名，mod 静默失效）', () => {
    const hits = [];
    (function walk(abs) {
        for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
            if (e.isDirectory()) { walk(path.join(abs, e.name)); continue; }
            if (!e.name.endsWith('.js')) continue;
            const full = path.join(abs, e.name);
            const rel = path.relative(REPO, full).replace(/\\/g, '/');
            if (FROZEN_SHADOW.has(rel)) continue;
            fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
                if (/setProperty\(\s*['"]--theme-color/.test(line)) hits.push(`${rel}:${i + 1}`);
            });
        }
    })(path.join(REPO, 'web/src'));
    assert.deepEqual(hits, [],
        `活代码仍在写行内 --theme-color（应写 --aria-accent）: ${hits.join(', ')}`);
});

test('T9 行内读取棘轮：读行内主题色必须用 --aria-accent 键名', () => {
    /* 与 T8 对称的另一半坑：.style.getPropertyValue() 只看行内样式、不解析 CSS 别名。
       190-settings-fontsize.js 改写成 --aria-accent 后，任何仍读行内 --theme-color
       的地方都会拿到空串——PVEngine 曾踩过（主题色静默丢失，不报错）。 */
    const hits = [];
    (function walk(abs) {
        for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
            if (e.isDirectory()) { walk(path.join(abs, e.name)); continue; }
            if (!e.name.endsWith('.js')) continue;
            const full = path.join(abs, e.name);
            const rel = path.relative(REPO, full).replace(/\\/g, '/');
            if (FROZEN_SHADOW.has(rel)) continue;
            fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
                /* 只认 .style.getPropertyValue（行内）；getComputedStyle(...) 走别名，合法 */
                if (/\.style\.getPropertyValue\(\s*['"]--theme-color/.test(line)) {
                    hits.push(`${rel}:${i + 1}`);
                }
            });
        }
    })(path.join(REPO, 'web/src'));
    assert.deepEqual(hits, [],
        `行内读取仍用旧键名（会读到空串）: ${hits.join(', ')}`);
});
