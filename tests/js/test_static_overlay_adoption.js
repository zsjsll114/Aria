/* ============================================================
 * tests/js/test_static_overlay_adoption.js — 静态浮层收编的棘轮（P3-b）
 *
 * 钉住三件事：
 *  E1/E2 登记表与 web/index.html 里的静态浮层**一一对应** —— 新增一个浮层却不
 *         登记（或随手指个理由排除）会直接红。没有这条，`ui/static-overlays.js`
 *         的清单会在几次迭代后悄悄过期，而"浮层没有可访问性语义"这件事
 *         只会在真机上被屏幕阅读器用户发现。
 *  E3    登记表里的选择器必须真的存在于 index.html —— 选择器写错的表现是
 *         **静默无 labelledby**（不报错），必须静态挡。
 *  E4/E5 首跑层层级与桌面端隐藏：欢迎层必须排在 panel 与 modal 之间
 *         （原写死 99999 会盖住任何对话框），且桌面壳不再显示它。
 *  E6    ESC 不再重复绑定：120/125 各自绑过一份，与 150 的逐层链叠加后
 *        一次 ESC 会连关两层（document 先于 window 触发）。删掉后只能由
 *         150 的逐层链负责。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { OVERLAY_EXCLUSIONS, STATIC_OVERLAYS } from '../../web/src/ui/static-overlays.js';

const REPO = path.resolve(import.meta.dirname, '../..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const INDEX_HTML = read('web/index.html');
const TOKENS_CSS = read('web/src/styles/tokens.css');

/** 与 ui/static-overlays.js 的收编范围一致：这些类名标记"这是一个静态浮层根" */
const OVERLAY_ROOT_CLASSES = [
    'search-overlay', 'lyric-source-overlay', 'ai-models-overlay', 'settings-overlay',
    'view-mode-overlay', 'color-picker-overlay', 'welcome-overlay',
    'eq-panel', 'ai-status-panel', 'plm-panel', 'ctx-menu',
];

/** 从 index.html 里扫出所有静态浮层根的 id（class 与 id 两种书写顺序都认） */
function overlayRootIds(html) {
    const ids = [];
    const push = (cls, id) => {
        const classes = cls.split(/\s+/);
        if (classes.some((c) => OVERLAY_ROOT_CLASSES.includes(c))) ids.push('#' + id);
    };
    for (const m of html.matchAll(/class="([^"]*)"\s+id="([A-Za-z0-9_-]+)"/g)) push(m[1], m[2]);
    for (const m of html.matchAll(/id="([A-Za-z0-9_-]+)"\s+class="([^"]*)"/g)) push(m[2], m[1]);
    return ids;
}

test('E1 index.html 的每个静态浮层根都被登记或显式排除（一一对应）', () => {
    const found = overlayRootIds(INDEX_HTML);
    assert.ok(found.length >= 25, `扫到的浮层根太少（${found.length}），正则可能失效`);
    const known = new Set([
        ...STATIC_OVERLAYS.map((s) => s.root),
        ...OVERLAY_EXCLUSIONS.map((e) => e.root),
    ]);
    const unhandled = found.filter((id) => !known.has(id));
    assert.deepEqual(unhandled, [],
        `这些浮层既没登记也没排除（新增浮层请去 ui/static-overlays.js 补一行）: ${unhandled.join(', ')}`);

    const stale = [...known].filter((id) => !found.includes(id));
    assert.deepEqual(stale, [],
        `登记表里这些浮层在 index.html 里已不存在（清单过期了）: ${stale.join(', ')}`);
});

test('E2 排除项必须写明理由，且理由只能是"菜单/状态"这类非模态语义', () => {
    const allowed = new Set(['menu', 'status']);
    for (const e of OVERLAY_EXCLUSIONS) {
        assert.ok(e.reason && e.note, `${e.root} 的排除必须同时给 reason 与 note`);
        assert.ok(allowed.has(e.reason),
            `${e.root} 的排除理由 "${e.reason}" 不在允许集合内 —— 模态浮层不许被随手排除`);
    }
    assert.ok(OVERLAY_EXCLUSIONS.length <= 4,
        '排除项过多：请确认每个都不是模态（本棘轮就是防"批量排除"这种偷懒）');
});

test('E3 登记表里的面板/标题选择器必须真的存在于 index.html', () => {
    const hasId = (id) => new RegExp('id="' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"').test(INDEX_HTML);
    const hasClass = (cls) => new RegExp('class="[^"]*\\b' + cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(INDEX_HTML);

    for (const spec of STATIC_OVERLAYS) {
        for (const sel of [spec.panel, spec.title]) {
            if (!sel) continue;
            const name = sel.slice(1);
            const ok = sel.startsWith('#') ? hasId(name) : hasClass(name);
            assert.ok(ok, `${spec.root} 的选择器 ${sel} 在 index.html 里找不到（写错的表现是静默无 labelledby）`);
        }
    }
});

test('E4 欢迎层必须排在 panel 与 modal 之间，且 z-index 不得写死', () => {
    const num = (name) => {
        const m = new RegExp(name + ':\\s*(\\d+)').exec(TOKENS_CSS.replace(/\/\*[\s\S]*?\*\//g, ''));
        assert.ok(m, `tokens.css 必须声明 ${name}`);
        return Number(m[1]);
    };
    const welcome = num('--aria-z-welcome');
    const modal = num('--aria-z-modal');
    assert.ok(welcome > 10001, `--aria-z-welcome=${welcome} 必须高于面板档 10001`);
    assert.ok(welcome < modal, `--aria-z-welcome=${welcome} 必须低于 --aria-z-modal=${modal}`);

    const base = read('web/src/styles/base.css');
    assert.match(base, /\.welcome-overlay\s*\{[\s\S]*?z-index:\s*var\(--aria-z-welcome/,
        '.welcome-overlay 的 z-index 必须引用 --aria-z-welcome（不得再写死 99999）');
    const block = /\.welcome-overlay\s*\{[\s\S]*?\n\s*\}/.exec(base);
    assert.ok(block && !/z-index:\s*\d/.test(block[0]),
        '.welcome-overlay 里不该再有 z-index 字面量');
});

test('E5 桌面壳不再显示欢迎页（只是隐藏，节点仍由 180 自调 handleWelcomeEnter 处理）', () => {
    const base = read('web/src/styles/base.css');
    assert.match(base, /html\.aria-desktop\s+#welcomeOverlay/, '缺少桌面端隐藏欢迎页的规则');
    assert.ok(!/html\.aria-desktop\s+\.welcome-overlay/.test(base),
        '必须用 id 选择器：#performanceDialog 复用 .welcome-overlay 类，桌面端仍需要它');

    const boot = read('web/src/app/180-boot-config.js');
    assert.match(boot, /isDesktopShell/, '180 必须区分桌面壳与浏览器');
    assert.match(boot, /if \(isDesktopShell\) \{\s*handleWelcomeEnter\(\);/,
        '桌面端必须自调 handleWelcomeEnter —— 首曲初始化与播放挂在它里面，漏了启动后不加载歌曲');

    const conf = read('src-tauri/tauri.conf.json');
    assert.match(conf, /autoplay-policy=no-user-gesture-required/,
        'tauri.conf.json 必须放开自动播放策略（否则桌面端去掉手势闸门后播不出声）');
    assert.match(conf, /--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection/,
        'additionalBrowserArgs 会**覆盖** wry 默认参数，必须自己带上这段（否则丢掉默认行为）');
});

test('E6 ESC 不再重复绑定：搜索页/收藏页只由 150 的逐层链负责', () => {
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    for (const f of ['web/src/app/120-search-results.js', 'web/src/app/125-favorites.js']) {
        assert.ok(!/e\.key === 'Escape'/.test(strip(read(f))),
            `${f} 不该再有独立 ESC handler —— 与 150 的逐层链叠加会一次 ESC 连关两层`);
    }
    const chain = strip(read('web/src/app/150-search-engine.js'));
    assert.match(chain, /e\.key === 'Escape'/, '150 必须保留逐层 ESC 链');
    assert.match(chain, /searchOverlay[\s\S]{0,80}classList\.contains\('visible'\)/,
        '150 的逐层链必须仍覆盖搜索页');
    assert.match(chain, /closeFavorites\(\)/, '150 必须调用 125 导出的 closeFavorites（而非手写类名）');
});

test('E7 收编是纯增量：只加属性，不动显隐与开闭', () => {
    const mod = read('web/src/ui/static-overlays.js');
    const body = mod.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/classList\.(remove|toggle)\(/.test(body), '收编只允许 classList.add，不许改显隐');
    assert.ok(!/addEventListener/.test(body), '收编不许绑事件（ESC/焦点是 step 2 的事）');
    assert.match(body, /classList\.add\(STATIC_MODAL_CLASS\)/, '必须打上公开标记类');
});
