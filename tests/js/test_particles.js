/* ============================================================
 * tests/js/test_particles.js — PV 逐字迸发粒子纯规格单测
 * 运行方式：node --test tests/js/test_particles.js
 * 覆盖：burstCount 3~5 颗 / 形状枚举 / 距离·寿命·大小·错峰区间 /
 *       cross 透明度 / 终态直线位移（tx=cos·dist, ty=sin·dist）/
 *       种子确定性（同一 seed 两次生成完全一致）/ 颜色只取主色或白尘
 * 说明：粒子改版（无限公转轨道 → folia sonnet 直线迸发）后为纯装饰，
 *       不影响布局与时序，故参数规格抽为纯函数直接断言。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PARTICLE_KINDS, WHITE_DUST, buildBurstParticle, burstCount, mulberry32 } from '../../web/src/core/pvEngine/particleSpec.js';

const HOST = '#ffcc33';

test('burstCount：恒在 3~5 区间，多轮覆盖 ≥2 种取值', () => {
    const rnd = mulberry32(42);
    const seen = new Set();
    for (let k = 0; k < 500; k++) {
        const c = burstCount(rnd);
        assert.ok(c >= 3 && c <= 5, `burstCount=${c} 越界`);
        seen.add(c);
    }
    assert.ok(seen.size >= 2, '应覆盖多个取值');
});

test('buildBurstParticle：形状只来自四种枚举', () => {
    const rnd = mulberry32(7);
    for (let i = 0; i < 40; i++) {
        assert.ok(PARTICLE_KINDS.includes(buildBurstParticle(rnd, i, HOST).kind));
    }
});

test('buildBurstParticle：数值区间（距离/寿命/大小/错峰/旋转）', () => {
    const rnd = mulberry32(99);
    for (let i = 0; i < 200; i++) {
        const s = buildBurstParticle(rnd, i, HOST);
        assert.ok(s.angle >= 0 && s.angle < Math.PI * 2, 'angle 越界');
        assert.ok(s.dist >= 0.55 && s.dist < 2.05, `dist=${s.dist}`);
        assert.ok(s.dur >= 0.9 && s.dur < 1.4, `dur=${s.dur}`);
        assert.ok(s.size >= 1.8 && s.size < 4.6, `size=${s.size}`);
        assert.ok(s.bl >= 0.02 && s.bl < 0.07, `bl=${s.bl}`);
        assert.ok(s.rotateDeg >= -30 && s.rotateDeg < 30, `rotateDeg=${s.rotateDeg}`);
    }
});

test('buildBurstParticle：cross 透明度 0.65，其余 0.85', () => {
    const rnd = mulberry32(3);
    for (let i = 0; i < 80; i++) {
        const s = buildBurstParticle(rnd, i, HOST);
        assert.equal(s.alpha, s.kind === 'cross' ? 0.65 : 0.85);
    }
});

test('buildBurstParticle：终态位移 = 方位角余弦/正弦 × 距离（直线迸发）', () => {
    const rnd = mulberry32(5);
    for (let i = 0; i < 80; i++) {
        const s = buildBurstParticle(rnd, i, HOST);
        assert.ok(Math.abs(s.tx - Math.cos(s.angle) * s.dist) < 1e-9, 'tx 不匹配');
        assert.ok(Math.abs(s.ty - Math.sin(s.angle) * s.dist) < 1e-9, 'ty 不匹配');
    }
});

test('buildBurstParticle：颜色只可能是主色或白尘', () => {
    const rnd = mulberry32(11);
    for (let i = 0; i < 80; i++) {
        const s = buildBurstParticle(rnd, i, HOST);
        assert.ok(s.color === HOST || s.color === WHITE_DUST, `color=${s.color}`);
    }
});

test('确定性：同一种子·同序号两次生成完全一致（可回归复现）', () => {
    const a = buildBurstParticle(mulberry32(2024), 3, HOST);
    const b = buildBurstParticle(mulberry32(2024), 3, HOST);
    assert.deepEqual(a, b);
});

test('确定性：不同种子生成结果不同（随机确实在起作用）', () => {
    const a = buildBurstParticle(mulberry32(1), 0, HOST);
    const b = buildBurstParticle(mulberry32(2), 0, HOST);
    assert.notDeepEqual(a, b);
});