/* ============================================================
 * tests/js/test_emotion_color_normalize.js — AI 情感词颜色归一化单测
 *
 * 用户投诉「AI 生成的情感词颜色全都很丑、不高级、太同质化」。
 * 根因之一：refineColor（S≤0.75）是死代码，AI 颜色从未被归一化，
 * 高饱和荧光色（示例 #FF6B6B）直接上屏。这里钉住归一化机制：
 *   ① 饱和度压到 ≤0.75（去荧光感）
 *   ② 亮度收进可读带 [0.52, 0.80]（深色不再隐身、过曝不再刺眼）
 *   ③ 色相保留（情感色彩倾向不变）
 *   ④ 幂等：归一化两次 == 一次
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeEmotionColor,
    hexToRgb,
    rgbToHsl,
} from '../../web/src/utils/colorUtils.js';

/** @param {string} hex @returns {[number,number,number]} */
function hsl(hex) {
    const rgb = hexToRgb(hex);
    assert.ok(rgb, '不是合法 #rrggbb: ' + hex);
    return rgbToHsl(rgb[0], rgb[1], rgb[2]);
}

test('N1 荧光色饱和度压到 ≤0.75（#FF6B6B S≈1.0）', () => {
    const out = normalizeEmotionColor('#FF6B6B');
    assert.match(out, /^#[0-9a-f]{6}$/i);
    const [, s] = hsl(out);
    assert.ok(s <= 0.75 + 0.01, '饱和度仍超标: ' + s);
    assert.ok(s < 0.99, '必须比原荧光色低饱和');
});

test('N2 深色提亮进可读带（#1a1a2e L≈0.14 → ≥0.52）', () => {
    const out = normalizeEmotionColor('#1a1a2e');
    const [, , l] = hsl(out);
    assert.ok(l >= 0.52 - 0.01, '深色没被提亮，暗底会隐身: ' + l);
});

test('N3 过曝色压回可读带（#ffffff L=1 → ≤0.80）', () => {
    const out = normalizeEmotionColor('#ffffff');
    const [, , l] = hsl(out);
    assert.ok(l <= 0.80 + 0.01, '过曝色没被压回: ' + l);
});

test('N4 色相保留（红色情感词归一化后仍是红系）', () => {
    const [h0] = hsl('#FF6B6B');
    const [h1] = hsl(normalizeEmotionColor('#FF6B6B'));
    const dh = Math.abs(h1 - h0);
    assert.ok(Math.min(dh, 1 - dh) <= 6 / 360, '色相漂移过大: ' + h0 + ' → ' + h1);
});

test('N5 已高级的颜色基本不动（#8FA8B8 低饱和中亮度）', () => {
    const out = normalizeEmotionColor('#8FA8B8');
    const [h0, , l0] = hsl('#8FA8B8');
    const [h1, s1, l1] = hsl(out);
    assert.ok(s1 <= 0.75 + 1e-6);
    assert.ok(Math.abs(l1 - l0) <= 0.02, '中亮度不该被大幅改动');
    assert.ok(Math.min(Math.abs(h1 - h0), 1 - Math.abs(h1 - h0)) <= 2 / 360);
});

test('N6 幂等：归一化两次 == 一次', () => {
    for (const c of ['#FF6B6B', '#1a1a2e', '#00ffcc', '#ff2a6d', '#8FA8B8']) {
        const once = normalizeEmotionColor(c);
        assert.equal(normalizeEmotionColor(once), once, '不幂等: ' + c);
    }
});

test('N7 非 #rrggbb 原样返回（不抛错）', () => {
    assert.equal(normalizeEmotionColor('rgb(255,0,0)'), 'rgb(255,0,0)');
    assert.equal(normalizeEmotionColor(''), '');
    assert.equal(normalizeEmotionColor(null), null);
});