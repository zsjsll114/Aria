/* ============================================================
 * tests/js/test_overlay_contract.js — P3 浮层契约静态棘轮
 *
 * 钉住「浮层只有一份实现」这件事。这些断言全部来自真实事故：
 *
 * C1 showGlass* 四个入口只允许 021 定义。
 *    258 曾把 showGlassPrompt 同名覆盖成"返回 DOM 元素"的版本，
 *    于是 200-settings-panel.js 的 `await window.showGlassPrompt(...)` 拿到
 *    HTMLDivElement，applyAutoEqText 收到 "[object HTMLDivElement]" ——
 *    AutoEQ 导入静默失效（不报错，只提示"未识别到任何滤波器"）。
 * C4 对话框不得写死 z-index。旧实现 2400 被 .settings-overlay(10000) 盖住，
 *    从设置面板里弹的提示用户看不见；层级必须来自 --aria-z-modal。
 * C5 第三套确认框（静态 #ctxConfirm）已退役，不许复活。
 * C6 258 的 .gp-* 载荷已随实现收敛删除。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(REPO, 'web/src');
const DIALOG_OWNER = 'web/src/app/021-aria-dialog.js';
const OVERLAY_CORE = 'web/src/ui/overlay.js';

/** 遍历 web/src 下所有 .js，返回 [{rel, text}] */
function sourceFiles(dir = SRC, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
            /* vendor/ 是第三方（kuromoji 等），不是本仓源码 */
            if (e.name === 'vendor') continue;
            sourceFiles(path.join(dir, e.name), out);
            continue;
        }
        if (!e.name.endsWith('.js')) continue;
        const full = path.join(dir, e.name);
        out.push({ rel: path.relative(REPO, full).replace(/\\/g, '/'), text: fs.readFileSync(full, 'utf8') });
    }
    return out;
}

const FILES = sourceFiles();

test('C1 showGlass* 四个入口只允许 021-aria-dialog.js 定义（禁止同名覆盖）', () => {
    const entries = ['showGlassAlert', 'showGlassConfirm', 'showGlassPrompt', 'showGlassPick'];
    for (const name of entries) {
        /* (?!\s*=) 排除比较运算：`window.showGlassAlert === 'function'` 里的
           `===` 会被贪婪的 `\s*=` 当成赋值（第一版就是这么误报的）。 */
        const defRe = new RegExp('(?:window|globalThis)\\.' + name + '\\s*=(?!\\s*=)');
        const owners = FILES
            .filter((f) => defRe.test(f.text))
            .map((f) => f.rel);
        assert.deepEqual(owners, [DIALOG_OWNER],
            `${name} 的定义处应只有 ${DIALOG_OWNER}，实际: ${owners.join(', ') || '(无)'}`);
    }
});

test('C2 浮层行为只有一份实现：ui/overlay.js 必须导出契约 API', () => {
    const core = FILES.find((f) => f.rel === OVERLAY_CORE);
    assert.ok(core, `${OVERLAY_CORE} 必须存在（浮层契约内核）`);
    for (const fn of ['openOverlay', 'closeOverlay', 'topOverlay', 'overlayDepth', 'isOverlayOpen']) {
        assert.ok(new RegExp('export function ' + fn + '\\b').test(core.text),
            `overlay.js 必须导出 ${fn}`);
    }
});

test('C3 契约必须提供 dialog 语义与焦点陷阱（此前 role="dialog" 覆盖 4/36、焦点陷阱 0）', () => {
    const core = FILES.find((f) => f.rel === OVERLAY_CORE).text;
    assert.match(core, /setAttribute\('role',\s*'dialog'\)/, '必须自动挂 role="dialog"');
    assert.match(core, /setAttribute\('aria-modal',\s*'true'\)/, '必须自动挂 aria-modal');
    assert.match(core, /aria-labelledby/, '有标题时必须挂 aria-labelledby');
    assert.match(core, /trapTab/, '必须有 Tab 焦点陷阱');
    assert.match(core, /prevFocus/, '必须记录并在关闭时归还焦点');
    assert.match(core, /'Escape'/, '必须统一处理 ESC');
    assert.match(core, /topOverlay\(\)\s*!==\s*entry/, 'ESC 只允许关最顶层（嵌套浮层）');
});

test('C4 对话框不得写死 z-index：层级只能来自 --aria-z-modal', () => {
    const dialog = FILES.find((f) => f.rel === DIALOG_OWNER).text;
    assert.ok(!/z-index\s*:/.test(dialog),
        '021 不应出现 z-index 字面量（旧实现写死 2400 被 .settings-overlay(10000) 盖住）');
    const core = FILES.find((f) => f.rel === OVERLAY_CORE).text;
    assert.match(core, /--aria-z-modal/, 'overlay.js 必须从 --aria-z-modal 取层级');
});

test('C5 第三套确认框已退役：静态 #ctxConfirm 不许复活', () => {
    const html = fs.readFileSync(path.join(REPO, 'web/index.html'), 'utf8');
    assert.ok(!/id="ctxConfirm"/.test(html), 'index.html 不应再有 #ctxConfirm 节点');
    const menus = fs.readFileSync(path.join(REPO, 'web/src/styles/menus.css'), 'utf8');
    assert.ok(!/\.ctx-confirm[A-Za-z-]*\s*[,{]/.test(menus.replace(/\/\*[\s\S]*?\*\//g, '')),
        'menus.css 不应再有 .ctx-confirm 规则（注释里提及历史可以）');
    /* 源码里也一样：先剥注释再查（历史说明允许提及） */
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    const alive = FILES.filter((f) => /ctxConfirm/.test(strip(f.text))).map((f) => f.rel);
    assert.deepEqual(alive, [], `仍有源码引用已退役的 ctxConfirm: ${alive.join(', ')}`);
});

test('C6 258 的 .gp-* 浮层载荷已随实现收敛删除', () => {
    const styles = path.join(REPO, 'web/src/styles');
    const bad = [];
    for (const f of fs.readdirSync(styles)) {
        if (!f.endsWith('.css')) continue;
        const css = fs.readFileSync(path.join(styles, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        if (/\.gp-(modal|title|sub|input|actions|cancel|ok|pick)/.test(css)) bad.push(f);
    }
    assert.deepEqual(bad, [], `仍有 .gp-* 样式残留: ${bad.join(', ')}`);
    const js = FILES.filter((f) => /gp-overlay|gp-modal/.test(f.text.replace(/\/\*[\s\S]*?\*\//g, ''))).map((f) => f.rel);
    assert.deepEqual(js, [], `仍有源码使用 .gp-* 载荷: ${js.join(', ')}`);
});

test('C7 --aria-z-modal 必须高于面板档（10001），否则对话框被设置面板/取色器盖住', () => {
    const tokens = fs.readFileSync(path.join(REPO, 'web/src/styles/tokens.css'), 'utf8');
    const m = /--aria-z-modal:\s*(\d+)/.exec(tokens.replace(/\/\*[\s\S]*?\*\//g, ''));
    assert.ok(m, 'tokens.css 必须声明 --aria-z-modal');
    const z = Number(m[1]);
    assert.ok(z > 10001, `--aria-z-modal=${z} 必须高于 .color-picker-overlay/.ctx-confirm 的 10001`);
});

test('C8 光标陷阱与键盘导航共用同一个锚点类 .aria-modal-shell', () => {
    const core = FILES.find((f) => f.rel === OVERLAY_CORE).text;
    assert.match(core, /classList\.add\('aria-modal-shell'\)/, 'overlay.js 必须给面板加 .aria-modal-shell');
    const kb = FILES.find((f) => f.rel === 'web/src/app/110-keyboard-nav.js');
    assert.ok(kb, '110-keyboard-nav.js 必须存在');
    assert.match(kb.text, /\.aria-modal-shell/, '键盘导航必须锚在通用模态类上（而非某个具体弹窗 id）');
});
