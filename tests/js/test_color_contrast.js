/* ============================================================
 * tests/js/test_color_contrast.js — 感知亮度与取墨判定的行为回归
 *
 * 起因：标题栏三大金刚键「不随背景变色」。旧实现是
 *   const L = (0.2126*r + 0.7152*g + 0.0722*b) / 255;  light = L < 0.48;
 * 两个错：① 把 sRGB 的**编码值**当光强加权（没有 gamma 解码），中灰算出来 0.504
 * 判成"亮背景→深色墨"，而它真实相对亮度只有 0.214，其实偏暗；
 *    ② 完全忽略 .blur-background 的 brightness(0.35)——按钮底下的实际颜色比封面主色暗得多。
 * 钉住这两条，别让人再抄回线性公式。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { contrastRatio, pickInk, relativeLuminance, srgbToLinear } from '../../web/src/utils/colorUtils.js';

test('srgbToLinear：编码值不当光强用（中灰 128 → 0.216，不是 0.502）', () => {
    assert.ok(Math.abs(srgbToLinear(128) - 0.2158) < 1e-3, String(srgbToLinear(128)));
    assert.equal(srgbToLinear(0), 0);
    assert.equal(srgbToLinear(255), 1);
    /* 低端线性段（≤ 0.04045*255 ≈ 10.3）不能走 pow，否则 0 附近斜率爆炸 */
    assert.ok(Math.abs(srgbToLinear(5) - 5 / 255 / 12.92) < 1e-6);
});

test('relativeLuminance：黑 0 / 白 1 / 中灰 ≈0.2126（WCAG 已知值）', () => {
    assert.equal(relativeLuminance(0, 0, 0), 0);
    assert.ok(Math.abs(relativeLuminance(255, 255, 255) - 1) < 1e-9);
    assert.ok(Math.abs(relativeLuminance(128, 128, 128) - 0.2159) < 1e-3);
});

test('relativeLuminance：绿色通道权重最高（纯绿比纯蓝亮得多）', () => {
    assert.ok(relativeLuminance(0, 255, 0) > relativeLuminance(0, 0, 255) * 3);
});

test('relativeLuminance：入参越界/脏值不抛，收进 0~255', () => {
    assert.equal(relativeLuminance(-40, 900, NaN), relativeLuminance(0, 255, 0));
    assert.equal(relativeLuminance(undefined, undefined, undefined), 0);
});

test('contrastRatio：同色 1，黑白 21', () => {
    assert.equal(contrastRatio(0.5, 0.5), 1);
    assert.ok(Math.abs(contrastRatio(1, 0) - 21) < 1e-9);
});

test('pickInk：暗背景取亮墨、亮背景取暗墨（旧线性阈值在这两处都判错）', () => {
    /* 默认 brightness(0.35) 下的白封面：实际背景是暗的，必须保持亮墨。
       旧公式对纯白给 L=1 → light=false → 深色墨，正是用户看到的「不变色/看不清」。 */
    assert.equal(pickInk(0.06).light, true, 'dark backdrop -> light ink');
    assert.equal(pickInk(0.06, false).light, true, '再暗也不能因为"当前是暗墨"就赖着不换');
    assert.equal(pickInk(0.75).light, false, 'light backdrop -> dark ink');
    assert.equal(pickInk(0.75, true).light, false, '迟滞不许把很亮的背景仍判成亮墨');
    /* 旧线性阈值 0.48 对应的感知值远低于 0.5：中灰背景（0.216）落在中性带，保持现状 */
    assert.equal(pickInk(relativeLuminance(128, 128, 128), true).light, true);
    assert.equal(pickInk(relativeLuminance(128, 128, 128), false).light, false);
});

test('pickInk：迟滞——中性带里保持现状，不来回翻', () => {
    /* 两墨对比度相等的交叉点在亮度 ≈0.2002（(L+0.05)^2 = 1.01×0.062） */
    const mid = 0.2;
    const a = pickInk(mid, true);
    const b = pickInk(mid, false);
    assert.ok(Math.abs(a.lead) < 1.6, `测试前提：${mid} 应落在迟滞带内, lead=${a.lead}`);
    assert.equal(a.light, true, '当前是亮墨就继续亮墨');
    assert.equal(b.light, false, '当前是暗墨就继续暗墨');
    /* 越过 margin 就必须换边。边界是解出来的不是猜的：
       lead(L)=1.01/(L+.05)-(L+.05)/0.062，lead=±1.6 的解是 L≈0.1555 / L≈0.2547，
       所以取 0.12 与 0.32 才真的在带外（第一版取 0.16/0.25 其实还在带内，测试自己先错了）。 */
    assert.equal(pickInk(0.12, false).light, true, '超过 margin 就换到亮墨');
    assert.equal(pickInk(0.32, true).light, false, '超过 margin 就换到暗墨');
    assert.equal(pickInk(0.16, false).light, false, '0.16 仍在迟滞带内（lead≈1.42 < 1.6）');
    assert.equal(pickInk(0.25, true).light, true, '0.25 仍在迟滞带内（lead≈-1.5 > -1.6）');
});
