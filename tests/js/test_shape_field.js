/* ============================================================
 * tests/js/test_shape_field.js — 图形场「描边生长」（todos #24）回归
 *
 * 盯住两件事：
 *   ① pathLength="1" 必须注入到**每一条**子路径——漏一条，那条就不参与 dash 生长，
 *      会在画到一半时突然整条出现，比不做还难看；
 *   ② 同一 seed 输出必须逐字节一致（确定性选版是这套装饰的前提，
 *      folia 自己在 sonnetGuides.ts 里漏了 Math.random 破坏了可复现性，我们别再犯）。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildShapeFieldHTML } from '../../web/src/core/shapeField.js';

const DRAWABLE_TAGS = ['path', 'circle', 'rect', 'polyline', 'line', 'polygon'];

test('同一 seed 两次生成逐字节一致（确定性）', () => {
    assert.equal(buildShapeFieldHTML('song-abc'), buildShapeFieldHTML('song-abc'));
    assert.equal(buildShapeFieldHTML(12345), buildShapeFieldHTML(12345));
});

test('不同 seed 布局不同（seed 真的在起作用）', () => {
    assert.notEqual(buildShapeFieldHTML('a'), buildShapeFieldHTML('b'));
});

test('每条子路径都带 pathLength="1"，且数量与标签数一致', () => {
    const html = buildShapeFieldHTML('ink-check');
    const icons = html.split('pv-shape--icon').slice(1);
    assert.ok(icons.length > 0, '本 seed 应至少画出一个 icon，否则这条测试是空跑');
    for (const block of icons) {
        const svg = block.slice(block.indexOf('<svg'), block.indexOf('</svg>'));
        for (const tag of DRAWABLE_TAGS) {
            const total = (svg.match(new RegExp(`<${tag}\\b`, 'g')) || []).length;
            const inked = (svg.match(new RegExp(`<${tag} pathLength="1"`, 'g')) || []).length;
            assert.equal(inked, total, `<${tag}> 有 ${total - inked} 条没被注入 pathLength`);
        }
    }
});

test('15 个图形全部带生长时长与错峰延迟', () => {
    const html = buildShapeFieldHTML('timing');
    const shapes = html.split('class="pv-shape ').slice(1);
    assert.equal(shapes.length, 15);
    for (const s of shapes) {
        assert.match(s, /--grow:\d+(\.\d+)?s;/, '缺 --grow');
        assert.match(s, /--grow-delay:\d+(\.\d+)?s;/, '缺 --grow-delay');
    }
});

test('生长延迟按序号递增（铺陈感来自错峰，不是随机）', () => {
    const html = buildShapeFieldHTML('order');
    const delays = [...html.matchAll(/--grow-delay:([\d.]+)s/g)].map(m => Number(m[1]));
    assert.equal(delays.length, 15);
    assert.ok(delays[14] > delays[0], '最后一个应当比第一个晚起笔');
});

test('粒子数量不变（本测试只改描边，不该动粒子）', () => {
    const html = buildShapeFieldHTML('particles');
    assert.equal((html.match(/class="pv-shape-particle"/g) || []).length, 20);
});
