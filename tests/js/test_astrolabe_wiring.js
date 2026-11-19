/* ============================================================
 * tests/js/test_astrolabe_wiring.js — 「画册 · Folio」（mode: astrolabe）全链路接线完整性单测
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
const CSS = fs.readFileSync(path.join(REPO, 'web/src/styles/astrolabe.css'), 'utf8');
const JS = fs.readFileSync(path.join(REPO, 'web/src/core/visualizers/AstrolabeVisualizer.js'), 'utf8');

test('AW1 卡片/分段按钮/设置段/样式表四件套齐全', () => {
    assert.ok(HTML.includes('class="view-mode-card" data-mode="astrolabe"'), '缺样式卡片');
    assert.ok(APPEARANCE_MODE_MAP.astrolabe, '缺 APPEARANCE_MODE_MAP.astrolabe');
    assert.ok(APPEARANCE_MODE_MAP.astrolabe.label.includes('画册 · Folio'), '缺「画册 · Folio」显示名称');
    assert.ok(RENDERER.includes('appearance-mode-btn'), '渲染器缺分段按钮类名');
    assert.ok(RENDERER.includes('data-mode-section'), '渲染器缺设置段属性');
    assert.ok(HTML.includes('src/styles/astrolabe.css'), '缺样式表链接');
});

test('AW2 设置段每个 data-var 都进 MODE_FIELDS_BY_MODE.astrolabe', () => {
    const vars = collectSchemaModeVars('astrolabe');
    assert.ok(vars.length >= 10, '控件过少: ' + vars.join(', '));
    const missing = vars.filter(v => !MODE_FIELDS_BY_MODE.astrolabe.includes(v));
    assert.deepEqual(missing, [], '没进配方字段表: ' + missing.join(', '));
});

test('AW3 默认键与字段表一一对应，模式进 VIEW_MODES', () => {
    const keys = Object.keys(DEFAULT_SETTINGS.modeSettings.astrolabe);
    const missing = keys.filter(k => !MODE_FIELDS_BY_MODE.astrolabe.includes(k));
    assert.deepEqual(missing, [], '默认键没进字段表: ' + missing.join(', '));
    assert.ok(VIEW_MODES.includes('astrolabe'));
});

test('AW4 舞台不变量与核心版画正负形反色管线存在', () => {
    assert.match(CSS, /\.view-astrolabe[\s\S]{0,120}\.player-controls-wrapper[\s\S]{0,80}display:\s*none/);
    assert.match(CSS, /\.view-astrolabe[\s\S]{0,120}\.lyrics-area-wrapper[\s\S]{0,80}display:\s*none/);
    assert.match(CSS, /\.view-astrolabe\s+\.bottom-control-bar[\s\S]{0,120}display:\s*flex/);
    assert.match(CSS, /\.view-astrolabe\s+\.top-action-buttons[\s\S]{0,120}display:\s*flex/);
    assert.ok(JS.includes('buildAstrolabeShotGeometry'), '引擎未接入 54 种破框几何生成');
    assert.ok(JS.includes('compileAstrolabeProgram'), '引擎未接入多拓扑时间轴编译器');
    assert.ok(JS.includes('_drawInvertedMassWithText'), '引擎未接入正负形双底板反色管线');
});
