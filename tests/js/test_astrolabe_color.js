/* ============================================================
 * tests/js/test_astrolabe_color.js — 「画册 · Folio」（mode: astrolabe）配色修复单测
 *
 * 两个用户投诉：
 *   ① 「分镜颜色之间没有太大的联系」——根因是章节色板锚点带逐镜随机抖动
 *      floor(hash*2)，同章节内每镜乱跳。修复：锚点按 section 稳定。
 *   ② 「情感词颜色和背景撞色看不清」——根因是 plateEmotionColor 只对 invert
 *      档盲混 26%，其余原样上屏，无亮度/对比度计算。修复：按字素实际底色
 *      （invert?paper:bg）做对比度护栏，保色相调亮度到 ≥4.5:1。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    ensureEmotionContrast,
    hexToRgb,
    rgbToHsl,
    relativeLuminance,
    contrastRatio,
} from '../../web/src/utils/colorUtils.js';
import { astrolabeChapterIndex } from '../../web/src/core/visualizers/astrolabe/astrolabeProfiles.js';

const REPO = path.resolve(import.meta.dirname, '../..');

/** @param {string} a @param {string} b @returns {number} */
function contrast(a, b) {
    const ca = hexToRgb(a), cb = hexToRgb(b);
    assert.ok(ca && cb, '非法 hex: ' + a + ' / ' + b);
    return contrastRatio(relativeLuminance(ca[0], ca[1], ca[2]), relativeLuminance(cb[0], cb[1], cb[2]));
}

test('A1 亮纸底上的浅色情感词被压深到 ≥4.5:1（撞色修复）', () => {
    const paper = '#f3efe4'; /* 象牙宣纸，亮底 */
    const pale = '#B8C98A'; /* 浅黄绿，原本几乎看不见 */
    assert.ok(contrast(pale, paper) < 4.5, '前提：原色确实撞色');
    const fixed = ensureEmotionContrast(pale, paper);
    assert.ok(contrast(fixed, paper) >= 4.5, '修复后对比度不足: ' + contrast(fixed, paper));
});

test('A2 深底上的深色情感词被提亮到 ≥4.5:1', () => {
    const dark = '#0e1218';
    const deep = '#1a1a2e'; /* 深蓝，暗底隐身 */
    assert.ok(contrast(deep, dark) < 4.5, '前提：原色确实隐身');
    const fixed = ensureEmotionContrast(deep, dark);
    assert.ok(contrast(fixed, dark) >= 4.5, '修复后对比度不足: ' + contrast(fixed, dark));
});

test('A3 已可读的颜色基本不动', () => {
    const dark = '#0e1218';
    const good = '#8FA8B8';
    assert.ok(contrast(good, dark) >= 4.5, '前提：原色已可读');
    const fixed = ensureEmotionContrast(good, dark);
    assert.equal(fixed.toLowerCase(), good.toLowerCase(), '可读色不该被改动');
});

test('A4 护栏保留色相（情感色彩倾向不变）', () => {
    const paper = '#f3efe4';
    const warm = '#C98A7D';
    const fixed = ensureEmotionContrast(warm, paper);
    const [h0] = rgbToHsl(...hexToRgb(warm));
    const [h1] = rgbToHsl(...hexToRgb(fixed));
    const dh = Math.abs(h1 - h0);
    assert.ok(Math.min(dh, 1 - dh) <= 8 / 360, '色相漂移过大: ' + h0 + ' → ' + h1);
});

test('A5 非 #rrggbb 原样返回（不抛错）', () => {
    assert.equal(ensureEmotionContrast('rgb(255,0,0)', '#0e1218'), 'rgb(255,0,0)');
    assert.equal(ensureEmotionContrast(null, '#0e1218'), null);
    assert.equal(ensureEmotionContrast('#8FA8B8', 'not-a-color'), '#8FA8B8');
});

test('A6 章节锚点按 section 稳定（同章节不再逐镜乱跳）', () => {
    assert.equal(astrolabeChapterIndex(0), 0);
    assert.equal(astrolabeChapterIndex(1), 2);
    assert.equal(astrolabeChapterIndex(2), 4);
    assert.equal(astrolabeChapterIndex(3), 0); /* 6 套循环 */
    /* 同 section 无论 shotIndex/seed 如何，锚点恒定 */
    for (let s = 0; s < 8; s++) {
        assert.equal(astrolabeChapterIndex(s), astrolabeChapterIndex(s));
    }
});

test('A7 护栏与稳定锚点真的接进引擎（非死代码）', () => {
    const JS = fs.readFileSync(path.join(REPO, 'web/src/core/visualizers/AstrolabeVisualizer.js'), 'utf8');
    assert.ok(JS.includes('ensureEmotionContrast'), '情感词没接对比度护栏');
    assert.ok(JS.includes('astrolabeChapterIndex'), '章节锚点没接稳定函数');
    assert.ok(!/secIdx \* 2 \+ Math\.floor\(h2 \* 2\)/.test(JS), '逐镜随机抖动仍在');
});