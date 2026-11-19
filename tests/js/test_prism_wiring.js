/* ============================================================
 * tests/js/test_prism_wiring.js — 「棱镜 · Prism」全链路接线完整性单测
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
const CSS = fs.readFileSync(path.join(REPO, 'web/src/styles/prism.css'), 'utf8');
const JS = fs.readFileSync(path.join(REPO, 'web/src/core/visualizers/PrismVisualizer.js'), 'utf8');

test('W1 卡片/分段按钮/设置段/样式表四件套齐全', () => {
    assert.ok(HTML.includes('class="view-mode-card" data-mode="prism"'), '缺样式卡片');
    assert.ok(APPEARANCE_MODE_MAP.prism, '缺 APPEARANCE_MODE_MAP.prism');
    assert.ok(RENDERER.includes('appearance-mode-btn'), '渲染器缺分段按钮类名');
    assert.ok(RENDERER.includes('data-mode-section'), '渲染器缺设置段属性');
    assert.ok(HTML.includes('src/styles/prism.css'), '缺样式表链接');
});

test('W2 设置段每个 data-var 都进 MODE_FIELDS_BY_MODE.prism', () => {
    const vars = collectSchemaModeVars('prism');
    assert.ok(vars.length >= 10, '控件过少: ' + vars.join(', '));
    const missing = vars.filter(v => !MODE_FIELDS_BY_MODE.prism.includes(v));
    assert.deepEqual(missing, [], '没进配方字段表: ' + missing.join(', '));
});

test('W3 默认键与字段表一一对应，模式进 VIEW_MODES', () => {
    const keys = Object.keys(DEFAULT_SETTINGS.modeSettings.prism);
    const missing = keys.filter(k => !MODE_FIELDS_BY_MODE.prism.includes(k));
    assert.deepEqual(missing, [], '默认键没进字段表: ' + missing.join(', '));
    assert.ok(VIEW_MODES.includes('prism'));
});

test('W4 舞台不变量与核心光学管线（切面折射/光谱色散/焦散光束/情感词着色）存在', () => {
    assert.match(CSS, /\.view-prism[\s\S]{0,120}\.player-controls-wrapper[\s\S]{0,80}display:\s*none/);
    assert.match(CSS, /\.view-prism[\s\S]{0,120}\.lyrics-area-wrapper[\s\S]{0,80}display:\s*none/);
    assert.ok(JS.includes('buildPrismFacetGeometry'), '引擎未接入 36 种参数化切面几何');
    assert.ok(JS.includes('compilePrismProgram'), '引擎未接入多镜头编译器');
    assert.ok(JS.includes('emotionColorsForGraphemes'), '引擎未接入 AI 情感词着色');
    assert.ok(JS.includes('_drawCaustics'), '引擎未接入逐字焦散光束');
});

test('W5 切镜性能决策接进引擎（预热降阈 + 旧镜底板冻结复用）', () => {
    assert.ok(JS.includes('shouldPrewarmNextShot'), '预热没走降阈后的纯函数决策');
    assert.ok(JS.includes('_plateFrozenLight'), '缺旧镜冻结底板画布');
    assert.ok(JS.includes('shouldFreezeOutgoingPlate'), '转场没接首帧冻结决策');
    assert.ok(JS.includes('canReuseFrozenPlate'), '转场没接冻结复用决策');
    assert.ok(JS.includes('frozen-reuse'), '旧镜后续帧仍在重栅格化（卡顿未修）');
});
