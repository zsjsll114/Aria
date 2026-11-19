/* ============================================================
 * tests/js/test_vitrail_wiring.js — 「琉璃龛 · Vitrail」（mode: vitrail）全链路接线完整性单测
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APPEARANCE_MODE_MAP, collectSchemaModeVars } from '../../web/src/config/appearanceSchema.js';
import { DEFAULT_SETTINGS } from '../../web/src/config/defaults.js';
import { MODE_FIELDS_BY_MODE, VIEW_MODES } from '../../web/src/core/vfxRecipe.js';

const REPO = path.resolve(import.meta.dirname, '../..');
const HTML = fs.readFileSync(path.join(REPO, 'web/index.html'), 'utf8');
const RENDERER = fs.readFileSync(path.join(REPO, 'web/src/ui/settingsRenderer.js'), 'utf8');
const CSS = fs.readFileSync(path.join(REPO, 'web/src/styles/vitrail.css'), 'utf8');
const JS = fs.readFileSync(path.join(REPO, 'web/src/core/visualizers/VitrailVisualizer.js'), 'utf8');
const MGR = fs.readFileSync(path.join(REPO, 'web/src/core/visualizers/VisualizerManager.js'), 'utf8');
const PREVIEW = fs.readFileSync(path.join(REPO, 'web/src/core/previewEngine.js'), 'utf8');
const READABILITY = fs.readFileSync(path.join(REPO, 'web/src/app/283-readability.js'), 'utf8');

test('VW1 卡片 / 分段按钮 / 设置段 / 样式表四件套齐全', () => {
    assert.ok(HTML.includes('class="view-mode-card" data-mode="vitrail"'), '缺样式卡片');
    assert.ok(APPEARANCE_MODE_MAP.vitrail, '缺 APPEARANCE_MODE_MAP.vitrail');
    assert.ok(APPEARANCE_MODE_MAP.vitrail.label.includes('琉璃龛 · Vitrail'), '缺「琉璃龛 · Vitrail」显示名称');
    assert.ok(RENDERER.includes('appearance-mode-btn'), '渲染器缺分段按钮类名');
    assert.ok(RENDERER.includes('data-mode-section'), '渲染器缺设置段属性');
    assert.ok(HTML.includes('src/styles/vitrail.css'), '缺样式表链接');
});

test('VW2 设置段每个 data-var 都进 MODE_FIELDS_BY_MODE.vitrail', () => {
    const vars = collectSchemaModeVars('vitrail');
    assert.ok(vars.length >= 12, '控件过少: ' + vars.join(', '));
    const missing = vars.filter((v) => !MODE_FIELDS_BY_MODE.vitrail.includes(v));
    assert.deepEqual(missing, [], '没进配方字段表: ' + missing.join(', '));
});

test('VW3 默认键与字段表一一对应，模式进 VIEW_MODES / VisualizerManager / previewEngine', () => {
    const keys = Object.keys(DEFAULT_SETTINGS.modeSettings.vitrail);
    const missing = keys.filter((k) => !MODE_FIELDS_BY_MODE.vitrail.includes(k));
    assert.deepEqual(missing, [], '默认键没进字段表: ' + missing.join(', '));
    assert.ok(VIEW_MODES.includes('vitrail'));
    assert.ok(MGR.includes("from './VitrailVisualizer.js'") && MGR.includes("this.register('vitrail', VitrailVisualizer)"), 'VisualizerManager 未注册 vitrail');
    assert.ok(PREVIEW.includes('vitrail:') && PREVIEW.includes("'view-vitrail'"), 'previewEngine 未接线 vitrail');
    assert.ok(READABILITY.includes("'view-vitrail'"), '283-readability 未收录 view-vitrail');
});

test('VW4 舞台不变量、#ariaRoot 性能降级与 WebGL2 核心渲染管线就绪', () => {
    assert.match(CSS, /\.view-vitrail[\s\S]{0,120}\.player-controls-wrapper[\s\S]{0,80}display:\s*none/);
    assert.match(CSS, /\.view-vitrail[\s\S]{0,120}\.lyrics-area-wrapper[\s\S]{0,80}display:\s*none/);
    assert.match(CSS, /\.view-vitrail\s+\.bottom-control-bar[\s\S]{0,120}display:\s*flex/);
    assert.match(CSS, /\.view-vitrail\s+\.top-action-buttons[\s\S]{0,120}display:\s*flex/);
    assert.match(CSS, /html#ariaRoot\.is-software-renderer[\s\S]{0,280}backdrop-filter:\s*none/);
    assert.ok(JS.includes('VitrailWebGLRenderer'), '未接入 WebGL2 渲染器');
    assert.ok(JS.includes('VitrailSdfAtlas'), '未接入线性时间 SDF 图集');
    assert.ok(JS.includes('composeVitrailArchitecture'), '未接入建筑参数化生成器');
    assert.ok(JS.includes('_renderFallback2d'), '未提供 WebGL2 不可用 2D 兜底渲染');
});
