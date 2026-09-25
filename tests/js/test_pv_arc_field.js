/* ============================================================
 * tests/js/test_pv_arc_field.js — 演唱进度驱动的长弧笔触（todos #24 重做）
 *
 * 上一版四层场被退回的三条理由，逐条钉成断言，防止重犯：
 *   ① 「线条不连续、很杂」→ 每条 path 必须是**一次挥笔**（1 个 M + 1 个 A），
 *      且张角 ≥130°；绝不能再出现一次生成 12 根短射线。
 *   ② 「不跟演唱进度走」→ sungProgress 必须是 f(播放头)：单调、可回跳、
 *      暂停时（时间不变）值不变。
 *   ③ 「出画」→ 弧的端点与圆心半径都要夹在画面内。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildArcFieldHTML, ARC_COUNT, MIN_SPAN_DEG } from '../../web/src/core/pvEngine/PVArcField.js';
import { PVRendering } from '../../web/src/core/pvEngine/PVRendering.js';

const VB_W = 160;
const VB_H = 90;

/* ---------- ① 长而连续 ---------- */

test('只有 3 条弧，不多不少', () => {
    const { arcs } = buildArcFieldHTML('mid-001');
    assert.equal(arcs.length, ARC_COUNT);
    assert.equal(ARC_COUNT, 3);
});

test('每条弧都是一次挥笔：1 个 M + 1 个 A，没有碎段', () => {
    for (let seed = 0; seed < 40; seed++) {
        const { arcs } = buildArcFieldHTML(`s${seed}`);
        for (const a of arcs) {
            const moves = (a.d.match(/M/g) || []).length;
            const arcsN = (a.d.match(/A/g) || []).length;
            assert.equal(moves, 1, `出现 ${moves} 个 M（碎段）: ${a.d}`);
            assert.equal(arcsN, 1, `出现 ${arcsN} 个 A: ${a.d}`);
            assert.ok(!/L|Z|C|Q/i.test(a.d), `掺了其它命令: ${a.d}`);
        }
    }
});

test('每条弧张角 ≥130°，短弧没有「挥」的感觉', () => {
    for (let seed = 0; seed < 60; seed++) {
        const { arcs } = buildArcFieldHTML(`t${seed}`);
        for (const a of arcs) {
            assert.ok(a.span >= MIN_SPAN_DEG && a.span <= 260,
                `seed${seed} 张角 ${a.span}`);
        }
    }
});

test('三条弧同心（共用圆心）——各给一个圆心时揭示成碎线，同心才像一笔挥过去', () => {
    for (let seed = 0; seed < 60; seed++) {
        const { arcs } = buildArcFieldHTML(`c${seed}`);
        assert.equal(new Set(arcs.map(a => `${a.cx},${a.cy}`)).size, 1, `seed${seed} 圆心不唯一`);
        assert.ok(arcs[0].R > arcs[1].R && arcs[1].R > arcs[2].R, '半径应递缩，否则三条弧重合叠成一条');
    }
});

test('起笔点落在各自弧的起点上，不叠在圆心', () => {
    const { arcs } = buildArcFieldHTML('d0');
    for (const a of arcs) {
        const dist = Math.hypot(a.sx - a.cx, a.sy - a.cy);
        assert.ok(Math.abs(dist - a.R) < 0.01, `起笔点距圆心 ${dist.toFixed(2)}，应为半径 ${a.R.toFixed(2)}`);
    }
});

/* ---------- ③ 不出画 ---------- */

test('圆心与端点都在画面内（含半径余量）', () => {
    for (let seed = 0; seed < 80; seed++) {
        const { arcs, html } = buildArcFieldHTML(`u${seed}`);
        for (const a of arcs) {
            assert.ok(a.cx - a.R >= -1 && a.cx + a.R <= VB_W + 1, `seed${seed} x 越界 ${a.cx}±${a.R}`);
            assert.ok(a.cy - a.R >= -1 && a.cy + a.R <= VB_H + 1, `seed${seed} y 越界 ${a.cy}±${a.R}`);
        }
        for (const c of html.matchAll(/<circle class="pv-arc-dot" cx="([\d.-]+)" cy="([\d.-]+)"/g)) {
            const x = Number(c[1]), y = Number(c[2]);
            assert.ok(x >= 0 && x <= VB_W && y >= 0 && y <= VB_H, `圆点越界 ${x},${y}`);
        }
    }
});

test('弧不挤在画面正中（中间是歌词）', () => {
    let inCenter = 0, total = 0;
    for (let seed = 0; seed < 80; seed++) {
        for (const a of buildArcFieldHTML(`v${seed}`).arcs) {
            total++;
            if (a.cx > VB_W * 0.32 && a.cx < VB_W * 0.68 && a.cy > VB_H * 0.34 && a.cy < VB_H * 0.66) inCenter++;
        }
    }
    assert.equal(inCenter, 0, `${inCenter}/${total} 条弧的圆心落在歌词安全区里`);
});

/* ---------- 确定性 + 时间窗 ---------- */

test('同 seed 逐字节一致', () => {
    assert.equal(buildArcFieldHTML('w').html, buildArcFieldHTML('w').html);
});

test('每条弧都带 pathLength 与自己的时间窗', () => {
    const { html } = buildArcFieldHTML('x');
    const paths = html.match(/<path [^>]+>/g) || [];
    assert.equal(paths.length, ARC_COUNT);
    for (const p of paths) {
        assert.match(p, /pathLength="1"/);
        assert.match(p, /--a0:[\d.]+/);
        assert.match(p, /--a1:[\d.]+/);
    }
});

test('三条弧的时间窗覆盖整段、依次错开且有重叠', () => {
    const { arcs } = buildArcFieldHTML('y');
    assert.equal(arcs[0].a0, 0, '第一条应从演唱开始就动笔');
    assert.ok(arcs[arcs.length - 1].a1 >= 0.95, '最后一条应在段尾前画完');
    for (let i = 0; i < arcs.length; i++) {
        assert.ok(arcs[i].a1 > arcs[i].a0, `第 ${i} 条窗口是空的`);
        if (i > 0) {
            assert.ok(arcs[i].a0 >= arcs[i - 1].a0, '窗口起点必须单调，否则三条弧会同时开画');
            assert.ok(arcs[i].a0 < arcs[i - 1].a1, '完全不重叠会画出一段一段的感觉');
        }
    }
});

/* ---------- ② 驱动量本身 ---------- */

const sung = (chars, t) => PVRendering.prototype.sungProgress.call({ chars }, t);

test('sungProgress 单调不回退，且始终在 0..1', () => {
    const chars = [
        { start: 0, end: 100 }, { start: 100, end: 250 },
        { start: 250, end: 300 }, { start: 300, end: 900 },
    ];
    let prev = -1;
    for (let t = -50; t <= 1200; t += 7) {
        const v = sung(chars, t);
        assert.ok(v >= 0 && v <= 1, `t=${t} 越界 ${v}`);
        assert.ok(v >= prev, `t=${t} 出现回退 ${prev} → ${v}`);
        prev = v;
    }
    assert.equal(sung(chars, -50), 0);
    assert.equal(sung(chars, 1200), 1);
});

test('sungProgress 只认播放头：可 seek 回跳、逐字推进', () => {
    const chars = [{ start: 0, end: 200 }, { start: 200, end: 400 }];
    /* 上一版是挂载时跑一条墙钟 CSS 动画：暂停会继续画完、seek 回去它不回头。
       这里盯的就是「值只由 t 决定」——所以 seek 回去必须退，唱过一个字必须进。 */
    const at300 = sung(chars, 300);
    assert.ok(at300 > 0.5 && at300 < 1);
    assert.ok(sung(chars, 100) < at300, 'seek 回去后进度没有回退');
    assert.ok(sung(chars, 201) > sung(chars, 199), '唱完一个字进度没有前进');
});

test('空字符表不炸（纯音乐/无逐字轨的段）', () => {
    assert.equal(sung([], 500), 0);
    assert.equal(sung(undefined, 500), 0);
});
