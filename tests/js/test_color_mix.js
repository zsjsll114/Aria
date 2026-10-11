/* ============================================================
 * tests/js/test_color_mix.js — utils/colorMix.js 行为回归
 *
 * 为什么补：该文件是 folia-major 的逐行保真移植（AGPL，见 THIRD_PARTY_NOTICES），
 * 且此前**没有任何测试**。`noUncheckedIndexedAccess` 在它上面报 14 条，全部落在
 * 十六进制逐位取字符（`hex[0]`/`hex[1]`/`hex[2]`）、`rgbMatch[1]` 与
 * `const [r, g, b] = ...` 解构上。动这些索引之前先把「解析/钳制/回退」三条路径钉住。
 *
 * 覆盖：3/6 位 hex、rgb()/rgba()、非法输入的各路回退、通道钳制、alpha 钳制、
 *       非颜色字符串直通、mix 的端点与中点、以及 0/1 量程外的 amount。
 * 运行：node --test tests/js/test_color_mix.js
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    colorWithAlpha,
    parseColorChannels,
    mixColors,
} from '../../web/src/utils/colorMix.js';

/* ==================== parseColorChannels ==================== */

test('parseColorChannels：3 位 hex 逐位双写展开', () => {
    assert.deepEqual(parseColorChannels('#fff'), { r: 255, g: 255, b: 255 });
    assert.deepEqual(parseColorChannels('#abc'), { r: 0xaa, g: 0xbb, b: 0xcc });
    assert.deepEqual(parseColorChannels('#000'), { r: 0, g: 0, b: 0 });
});

test('parseColorChannels：6 位 hex 按 2 位切分', () => {
    assert.deepEqual(parseColorChannels('#1a2b3c'), { r: 0x1a, g: 0x2b, b: 0x3c });
    assert.deepEqual(parseColorChannels('#ffffff'), { r: 255, g: 255, b: 255 });
    assert.deepEqual(parseColorChannels('#000000'), { r: 0, g: 0, b: 0 });
});

test('parseColorChannels：rgb() / rgba() 取前三通道，忽略 alpha', () => {
    assert.deepEqual(parseColorChannels('rgb(1, 2, 3)'), { r: 1, g: 2, b: 3 });
    assert.deepEqual(parseColorChannels('rgba(10, 20, 30, 0.5)'), { r: 10, g: 20, b: 30 });
    assert.deepEqual(parseColorChannels('rgb( 4 , 5 , 6 )'), { r: 4, g: 5, b: 6 });
});

test('parseColorChannels：非法输入一律 null（不产出 NaN 通道）', () => {
    assert.equal(parseColorChannels(''), null);
    assert.equal(parseColorChannels(null), null);
    assert.equal(parseColorChannels(undefined), null);
    assert.equal(parseColorChannels('#12'), null, '2 位 hex 非法');
    assert.equal(parseColorChannels('#12345'), null, '5 位 hex 非法');
    assert.equal(parseColorChannels('#zzzzzz'), null, '非十六进制');
    assert.equal(parseColorChannels('rgb(1, 2, nope)'), null, '通道非数字');
    assert.equal(parseColorChannels('rgb(1, 2)'), null, '通道不足 3 个');
    assert.equal(parseColorChannels('var(--theme-color)'), null);
});

/* ==================== colorWithAlpha ==================== */

test('colorWithAlpha：hex 转 rgba，通道四舍五入', () => {
    assert.equal(colorWithAlpha('#fff', 1), 'rgba(255, 255, 255, 1)');
    assert.equal(colorWithAlpha('#abc', 1), 'rgba(170, 187, 204, 1)');
    assert.equal(colorWithAlpha('#1a2b3c', 0.5), 'rgba(26, 43, 60, 0.5)');
});

test('colorWithAlpha：通道越界被钳到 [0,255]', () => {
    assert.equal(colorWithAlpha('rgb(300, -5, 10)', 1), 'rgba(255, 0, 10, 1)');
});

test('colorWithAlpha：alpha 钳到 [0,1]', () => {
    assert.equal(colorWithAlpha('#fff', 5), 'rgba(255, 255, 255, 1)');
    assert.equal(colorWithAlpha('#fff', -1), 'rgba(255, 255, 255, 0)');
});

test('colorWithAlpha：非法/空输入回退到白色（而不是抛出）', () => {
    assert.equal(colorWithAlpha('', 0.25), 'rgba(255, 255, 255, 0.25)');
    assert.equal(colorWithAlpha(null, 0.25), 'rgba(255, 255, 255, 0.25)');
    assert.equal(colorWithAlpha('#12345', 1), 'rgba(255, 255, 255, 1)', '非法 hex 回退白');
    assert.equal(colorWithAlpha('rgb(1, 2, nope)', 1), 'rgba(255, 255, 255, 1)', '坏通道回退白');
});

test('colorWithAlpha：既非 hex 也非 rgb() 的字符串原样直通（CSS 变量等）', () => {
    assert.equal(colorWithAlpha('var(--dtk-hl)', 1), 'var(--dtk-hl)');
    assert.equal(colorWithAlpha('currentColor', 0.4), 'currentColor');
    /* 首尾空白先 trim 再判定，故 "  #fff  " 走 hex 分支 */
    assert.equal(colorWithAlpha('  #fff  ', 1), 'rgba(255, 255, 255, 1)');
});

/* ==================== mixColors ==================== */

test('mixColors：两端点与中点', () => {
    assert.equal(mixColors('#000000', '#ffffff', 0), 'rgba(0, 0, 0, 1)');
    assert.equal(mixColors('#000000', '#ffffff', 1), 'rgba(255, 255, 255, 1)');
    assert.equal(mixColors('#000000', '#ffffff', 0.5), 'rgba(128, 128, 128, 1)',
        '127.5 四舍五入为 128');
});

test('mixColors：amount 越界被钳到 [0,1]', () => {
    assert.equal(mixColors('#000000', '#ffffff', -3), 'rgba(0, 0, 0, 1)');
    assert.equal(mixColors('#000000', '#ffffff', 9), 'rgba(255, 255, 255, 1)');
});

test('mixColors：alpha 透传且钳到 [0,1]', () => {
    assert.equal(mixColors('#000000', '#ffffff', 0, 0.5), 'rgba(0, 0, 0, 0.5)');
    assert.equal(mixColors('#000000', '#ffffff', 0, 7), 'rgba(0, 0, 0, 1)');
});

test('mixColors：任一端不可解析 → 退化为「按 amount 二选一」，不抛不产 NaN', () => {
    /* amount < 0.5 取 from；>= 0.5 取 to（再由 colorWithAlpha 归一化） */
    assert.equal(mixColors('var(--a)', '#ffffff', 0.2), 'var(--a)');
    assert.equal(mixColors('var(--a)', '#ffffff', 0.8), 'rgba(255, 255, 255, 1)');
    assert.equal(mixColors('#000000', 'nope', 0.8), 'nope');
    /* 两端都不可解析：仍不该出现 NaN 文本 */
    const both = mixColors('nope', 'alsonope', 0.5);
    assert.ok(!String(both).includes('NaN'), `不应出现 NaN：${both}`);
});
