/* ============================================================
 * tests/js/test_vfx_intensity.js — 动效强度滑杆的映射契约（todos #6）
 *
 * 滑杆替用户做了一个「看不见」的决定：把 0~100 摊成 10 个 vfx 键。
 * 所以钉死四件事：
 *   ① 四个端点必须**还原档位原值**——否则「拉到 100」不等于高性能，用户按数字找档会落空；
 *   ② 单调不回退、且任何中间点都不越出端点范围——滑杆不该发明档位里没有的怪值；
 *   ③ 「未设定」必须是 null 语义（跟随档位），不能和 0 混同——混同等于每次启动都把人
 *      拖到极简；
 *   ④ 特效开关按权重过半才点亮（pvBloom 只有满档为真，所以要 ≥83 而不是 ≥34）。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PERFORMANCE_PROFILES } from '../../web/src/config/performance.js';
import {
    VFX_INTENSITY_ANCHORS,
    clampIntensity,
    intensityBand,
    intensityForProfile,
    intensitySegment,
    nearestAnchor,
    vfxFromIntensity,
} from '../../web/src/core/vfxIntensity.js';

const ALL_KEYS = [...PERFORMANCE_PROFILES.high.vfx ? Object.keys(PERFORMANCE_PROFILES.high.vfx) : []];

test('四个端点还原档位原值（滑杆的两端就是用户认识的档位）', () => {
    for (const anchor of VFX_INTENSITY_ANCHORS) {
        const n = intensityForProfile(anchor);
        const got = vfxFromIntensity(n);
        const want = PERFORMANCE_PROFILES[anchor].vfx;
        for (const key of ALL_KEYS) {
            assert.equal(got[key], want[key], `${anchor}(${n}) 的 ${key} 应为 ${want[key]}，实得 ${got[key]}`);
        }
    }
});

test('0 / 100 与 minimal / high 完全一致（含全部 10 个键）', () => {
    assert.deepEqual(vfxFromIntensity(0), PERFORMANCE_PROFILES.minimal.vfx);
    assert.deepEqual(vfxFromIntensity(100), PERFORMANCE_PROFILES.high.vfx);
});

test('数值键单调不回退，且始终落在两端之间', () => {
    let prev = vfxFromIntensity(0);
    for (let n = 1; n <= 100; n++) {
        const cur = vfxFromIntensity(n);
        for (const key of ['renderScale', 'coverBlur', 'glassBlur', 'lyricBlur', 'textBlur']) {
            assert.ok(cur[key] >= prev[key], `${key} 在 ${n} 处回退了：${prev[key]} → ${cur[key]}`);
            assert.ok(cur[key] >= PERFORMANCE_PROFILES.minimal.vfx[key] - 1e-9
                && cur[key] <= PERFORMANCE_PROFILES.high.vfx[key] + 1e-9,
            `${key} 在 ${n} 处越界：${cur[key]}`);
        }
        prev = cur;
    }
});

test('★ 未设定 = null 语义（跟随档位），不得和 0 混同', () => {
    /* 混同的话每次启动都被拖到极简——那是「功能没生效」级别的事故。 */
    assert.equal(clampIntensity(null), null);
    assert.equal(clampIntensity(undefined), null);
    assert.equal(clampIntensity(''), null);
    assert.equal(clampIntensity('abc'), null);
    assert.deepEqual(vfxFromIntensity(null), {}, '未设定时不能覆盖任何键');
    assert.notDeepEqual(vfxFromIntensity(0), {}, '但 0 是真实档位，必须覆盖');
});

test('越界夹到 0~100，负数不会当成未设定', () => {
    assert.equal(clampIntensity(-20), 0);
    assert.equal(clampIntensity(260), 100);
    assert.deepEqual(vfxFromIntensity(-20), vfxFromIntensity(0));
});

test('特效开关要权重过半才点亮（pvBloom 只有满档为真）', () => {
    assert.equal(vfxFromIntensity(34).pvBloom, false, '34 处 medium 都还没开 bloom，不该点亮');
    assert.equal(vfxFromIntensity(83).pvBloom, false);
    assert.equal(vfxFromIntensity(84).pvBloom, true, '过半点是 83.3，84 起必须为真');
    /* wcParticles 在 medium 就为真，所以 40 出头就该点亮 */
    assert.equal(vfxFromIntensity(50).wcParticles, true);
    assert.equal(vfxFromIntensity(20).wcParticles, false);
});

test('渲染缩放对齐到 0.05 网格（与手动微调滑条同网格，否则显示会跳）', () => {
    for (let n = 0; n <= 100; n += 3) {
        const v = vfxFromIntensity(n).renderScale;
        assert.ok(Math.abs(v * 20 - Math.round(v * 20)) < 1e-9, `${n} 处 renderScale=${v} 不在 0.05 网格上`);
    }
});

test('分段函数在 100 处不越界（hi 索引必须夹住）', () => {
    const seg = intensitySegment(100);
    assert.equal(seg.hi, VFX_INTENSITY_ANCHORS.length - 1);
    assert.equal(VFX_INTENSITY_ANCHORS[seg.lo], 'medium');
    assert.ok(seg.t <= 1);
});

test('最近端点名与滑杆位置自洽（说明行用它报「约等于哪一档」）', () => {
    assert.equal(nearestAnchor(0), 'minimal');
    assert.equal(nearestAnchor(100), 'high');
    /* 分界在两点之间（0.5 个档位段 = 16.7），不是「档位编号除以 4」那种直觉值 */
    assert.equal(nearestAnchor(16), 'minimal');
    assert.equal(nearestAnchor(17), 'low');
    assert.equal(nearestAnchor(25), 'low', '25 已过 minimal/low 的中点');
});

test('说明分档键覆盖全部情形，且边界与档位对齐', () => {
    assert.equal(intensityBand(null), 'follow');
    assert.equal(intensityBand(0), 'bare');
    assert.equal(intensityBand(100), 'full');
    assert.equal(intensityBand(33), 'light');
    assert.equal(intensityBand(40), 'balanced');
    assert.equal(intensityBand(67), 'balanced');
    assert.equal(intensityBand(80), 'rich');
    assert.equal(intensityBand(99), 'rich');
});

test('档位→滑杆→档位可往返（intensityForProfile 与 nearestAnchor 互逆）', () => {
    for (const anchor of VFX_INTENSITY_ANCHORS) {
        assert.equal(nearestAnchor(intensityForProfile(anchor)), anchor);
    }
    assert.equal(intensityForProfile('nope'), null, '未知档位返回 null，不猜位置');
});
