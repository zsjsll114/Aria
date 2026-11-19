/* ============================================================
 * tests/js/test_vitrail_clarity.js — 「琉璃龛 · Vitrail」清晰度参数回归单测
 *
 * 锁定影响字体锐度与可读性的关键参数不被回退：
 * 1) GLYPH_FS：fwidth(sdf) 驱动紧凑 AA 夹紧与衬影边界；
 * 2) VitrailVisualizer：预览/舞台高分 SDF 图集 cellSize/cols/spread 与 DPR 上限；
 * 3) vitrailRenderer：收敛的 Bloom 提取阈值与 bloomStrength 上限。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { GLYPH_FS } from '../../web/src/core/visualizers/vitrail/vitrailShaders.js';

const REPO = path.resolve(import.meta.dirname, '../..');
const VISUALIZER_JS = fs.readFileSync(path.join(REPO, 'web/src/core/visualizers/VitrailVisualizer.js'), 'utf8');
const RENDERER_JS = fs.readFileSync(path.join(REPO, 'web/src/core/visualizers/vitrail/vitrailRenderer.js'), 'utf8');

test('GLYPH_FS 使用紧凑 fwidth SDF AA 夹紧并保留外围雕琢衬影', () => {
    assert.match(GLYPH_FS, /clamp\(fw \* 0\.72,\s*0\.003,\s*0\.065\)/);
    assert.match(GLYPH_FS, /smoothstep\(0\.36 - aa \* 1\.2,\s*0\.495,\s*sdf\)/);
    assert.match(GLYPH_FS, /smoothstep\(0\.50 - aa,\s*0\.50 \+ aa,\s*sdf\)/);
});

test('VitrailVisualizer 保持高清 SDF 图集与高分屏 DPR 预算', () => {
    assert.match(VISUALIZER_JS, /cellSize:\s*isPreview\s*\?\s*96\s*:\s*128/);
    assert.match(VISUALIZER_JS, /cols:\s*isPreview\s*\?\s*10\s*:\s*12/);
    assert.match(VISUALIZER_JS, /spread:\s*isPreview\s*\?\s*11\s*:\s*14/);
    assert.match(VISUALIZER_JS, /qualityTier === 'high'\s*\?\s*Math\.min\(rawDpr,\s*2\.0\)\s*:\s*\(qualityTier === 'balanced'\s*\?\s*Math\.min\(rawDpr,\s*1\.5\)\s*:\s*1\.0\)/);
});

test('vitrailRenderer 提高 Bloom 提取阈值并压低溢光强度以避免糊字', () => {
    assert.match(RENDERER_JS, /baseThresh\s*=\s*\(this\.hasFloatFbo \? 0\.78 : 0\.64\)/);
    assert.match(RENDERER_JS, /bloomStrength\s*=\s*clamp\(params\.lighting \* 0\.34 \* \(pal\.bloomBoost \?\? 1\.0\),\s*0\.0,\s*0\.72\)/);
});
