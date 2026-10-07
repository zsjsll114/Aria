/* ============================================================
 * test_spatial_tuning.js — 空间音频 / 虚拟声场 档位与 IR 钉死
 *
 * 这份测试存在的理由（docs/空间音频与虚拟声场-技术方案.md §5）：
 * 档位 → 参数是**跨路径共享的同一张表**。biquad.rs 的教训是「两边系数不一致
 * 时用户切后端会听出不同音色，而两边各自看都『对』，极难归因」。
 * 现在两侧（Web `core/spatialTuning.js` / Rust `dsp/spatial_tuning.rs`）都是
 * `scripts/build_spatial_tuning.mjs` 的产物，但**产物本身仍可能被人手改**
 * （或生成器被改坏）。所以这里把三件事钉死：
 *   ① 档位枚举与字段取值域（虚拟声场恰好 light/medium，**不含 strong**，
 *      见方案 §8.2；空间音频 light/medium/strong）；
 *   ② IR 集合完整、长度一致、已按能量归一化、全为有限数；
 *   ③ ★ **两侧数值逐项相等** —— 直接读 Rust 源文件正则提取后比对。
 *      这是唯一能挡住「只改了一边」的手段（生成器存在 ≠ 两边一致）。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
    STAGE_TUNING, STAGE_LEVELS, STAGE_DEFAULT, stageTuningFor,
    SPATIAL_TUNING, SPATIAL_LEVELS, SPATIAL_DEFAULT, spatialTuningFor,
    SPATIAL_IRS, IR_ORDER, IR_DEFAULT, IR_TAPS, IR_SAMPLE_RATE, irFor, resampleLinear,
} from '../../web/src/core/spatialTuning.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUST_SRC = readFileSync(
    resolve(HERE, '../../src-tauri/audio/src/dsp/spatial_tuning.rs'),
    'utf8',
);

/* ---------------- Rust 源提取 ---------------- */

/** 取 `pub const NAME: [T; N] = [ ... ];` 的方括号内容（数组内无嵌套 `]`，非贪婪够用）。 */
function rustArrayBody(name) {
    const re = new RegExp(`pub const ${name}: \\[[^\\]]*\\] = \\[([\\s\\S]*?)\\];`);
    const m = RUST_SRC.match(re);
    assert.ok(m, `Rust 源里找不到 pub const ${name}`);
    return m[1];
}

/** 取 `pub const NAME: 类型 = 值;` 的标量值。 */
function rustScalar(name) {
    const re = new RegExp(`pub const ${name}: [^=]+= (-?[0-9.eE-]+);`);
    const m = RUST_SRC.match(re);
    assert.ok(m, `Rust 源里找不到 pub const ${name}`);
    return Number(m[1]);
}

function numbersIn(body) {
    return (body.match(/-?[0-9]+(?:\.[0-9]+)?(?:e-?[0-9]+)?/g) || []).map(Number);
}

/* ---------------- 虚拟声场（P1） ---------------- */

test('虚拟声场档位枚举恰好是 light/medium，不含 strong/high', () => {
    assert.deepEqual([...STAGE_LEVELS].sort(), ['light', 'medium']);
    assert.equal(Object.prototype.hasOwnProperty.call(STAGE_TUNING, 'strong'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(STAGE_TUNING, 'high'), false);
    assert.equal(Object.keys(STAGE_TUNING).length, 2);
});

test('虚拟声场缺省档是 light', () => {
    assert.equal(STAGE_DEFAULT, 'light');
});

test('虚拟声场每档字段齐全且为有限数，stageS >= 1', () => {
    for (const lv of STAGE_LEVELS) {
        const t = STAGE_TUNING[lv];
        for (const k of ['stageS', 'haasMs', 'haasMix']) {
            assert.ok(Number.isFinite(t[k]), `${lv}.${k} 必须是有限数，实为 ${t[k]}`);
        }
        assert.ok(t.stageS >= 1, `${lv}.stageS 必须 >= 1（<1 是收窄而非展宽），实为 ${t.stageS}`);
        assert.ok(t.haasMs >= 0 && t.haasMs <= 50, `${lv}.haasMs 应落在 [0, 50]ms`);
        assert.ok(t.haasMix >= 0 && t.haasMix <= 1, `${lv}.haasMix 应落在 [0, 1]`);
    }
});

test('虚拟声场 haasMs 与 haasMix 必须同时为 0 或同时为正（不可半开）', () => {
    for (const lv of STAGE_LEVELS) {
        const t = STAGE_TUNING[lv];
        const halfOpen = (t.haasMs > 0) !== (t.haasMix > 0);
        assert.equal(halfOpen, false,
            `${lv}: haasMs=${t.haasMs} haasMix=${t.haasMix} —— 有延时无混入是死代码，有混入无延时是相位打架`);
    }
});

test('虚拟声场 medium 比 light 更宽（档位单调）', () => {
    assert.ok(STAGE_TUNING.medium.stageS > STAGE_TUNING.light.stageS,
        'medium 的展宽量应大于 light');
});

test('stageTuningFor：非法档位回落到缺省档而不抛', () => {
    assert.deepEqual(stageTuningFor('light'), STAGE_TUNING.light);
    assert.deepEqual(stageTuningFor('medium'), STAGE_TUNING.medium);
    for (const bad of ['strong', 'high', 'off', '', null, undefined, 0, 42, {}]) {
        assert.deepEqual(stageTuningFor(bad), STAGE_TUNING[STAGE_DEFAULT],
            `stageTuningFor(${JSON.stringify(bad)}) 应回落到 ${STAGE_DEFAULT}`);
    }
});

/* ---------------- 空间音频（P2） ---------------- */

test('空间音频档位枚举恰好是 light/medium/strong', () => {
    assert.deepEqual([...SPATIAL_LEVELS].sort(), ['light', 'medium', 'strong']);
    assert.equal(Object.keys(SPATIAL_TUNING).length, 3);
    assert.equal(Object.prototype.hasOwnProperty.call(SPATIAL_TUNING, 'high'), false);
});

test('空间音频缺省档是 light（方案 §8.1：打开后默认落轻档）', () => {
    assert.equal(SPATIAL_DEFAULT, 'light');
});

test('空间音频 wet 落在 (0,1] 且随档位单调递增', () => {
    const w = SPATIAL_LEVELS.map((lv) => SPATIAL_TUNING[lv].wet);
    w.forEach((v, i) => {
        assert.ok(Number.isFinite(v), `${SPATIAL_LEVELS[i]} wet 必须是有限数`);
        assert.ok(v > 0 && v <= 1, `${SPATIAL_LEVELS[i]} wet 应落在 (0,1]，实为 ${v}`);
    });
    assert.ok(w[1] > w[0] && w[2] > w[1], `wet 应随档位递增，实为 ${w.join(' < ')}`);
    /* 方案 §1.1：强档也不能全湿——纯 wet 一定糊 */
    assert.ok(w[2] < 1, '强档 wet 不应取 1（纯湿必糊，方案 §1.1）');
});

test('spatialTuningFor：非法档位回落到缺省档而不抛', () => {
    assert.deepEqual(spatialTuningFor('strong'), SPATIAL_TUNING.strong);
    for (const bad of ['off', 'ultra', '', null, undefined, 7, {}]) {
        assert.deepEqual(spatialTuningFor(bad), SPATIAL_TUNING[SPATIAL_DEFAULT]);
    }
});

/* ---------------- IR ---------------- */

test('IR 预设枚举恰好是 near/hall/wide，缺省 near', () => {
    assert.deepEqual([...IR_ORDER].sort(), ['hall', 'near', 'wide']);
    assert.equal(IR_DEFAULT, 'near');
});

test('每个 IR 预设都有左右的 Float32Array，长度 == IR_TAPS 且全为有限数', () => {
    assert.ok(IR_TAPS >= 64, 'IR 太短就退化成一个梳状滤波器，失去意义');
    for (const name of IR_ORDER) {
        const ir = SPATIAL_IRS[name];
        assert.ok(ir, `缺少 IR 预设 ${name}`);
        for (const ear of ['left', 'right']) {
            assert.ok(ir[ear] instanceof Float32Array, `${name}.${ear} 必须是 Float32Array`);
            assert.equal(ir[ear].length, IR_TAPS, `${name}.${ear} 长度应为 IR_TAPS`);
            assert.ok([...ir[ear]].every(Number.isFinite), `${name}.${ear} 含 NaN/Inf`);
        }
    }
});

test('每个 IR 左右能量各自归一到 ~1（干湿比才可比）', () => {
    for (const name of IR_ORDER) {
        const { left, right } = SPATIAL_IRS[name];
        const e = (a) => a.reduce((s, v) => s + v * v, 0);
        /* 两耳用**同一个**归一因子（生成器保证），所以各自能量≈1 */
        assert.ok(Math.abs(e(left) - 1) < 0.05, `${name} 左耳能量应≈1，实为 ${e(left)}`);
        assert.ok(Math.abs(e(right) - 1) < 0.05, `${name} 右耳能量应≈1，实为 ${e(right)}`);
        /* 直达为主：峰值不该被扩散尾淹没（否则听感是"糊"不是"空间感"） */
        const peak = Math.max(...left, ...right, 0);
        assert.ok(peak > 0.5, `${name} 峰值过低（${peak}）—— 直达被扩散尾淹没`);
    }
});

test('irFor：非法预设回落到缺省而不抛', () => {
    assert.equal(irFor('hall'), SPATIAL_IRS.hall);
    for (const bad of ['none', 'cinema', '', null, undefined, 3]) {
        assert.equal(irFor(bad), SPATIAL_IRS[IR_DEFAULT]);
    }
});

/* ---------------- 重采样（两侧同算法） ---------------- */

test('resampleLinear：采样率相同则原样返回（长度与内容）', () => {
    const src = new Float32Array([0, 1, 0.5, -1, 0.25]);
    const out = resampleLinear(src, 48000, 48000);
    assert.equal(out.length, src.length);
    for (let i = 0; i < src.length; i++) assert.equal(out[i], src[i]);
});

test('resampleLinear：升/降采样长度按比例，且端点不越界', () => {
    const src = new Float32Array(480).fill(0.5);
    assert.equal(resampleLinear(src, 48000, 96000).length, 960);
    assert.equal(resampleLinear(src, 48000, 44100).length, 441);
    assert.ok(resampleLinear(src, 48000, 96000).every(Number.isFinite));
    assert.ok(resampleLinear(src, 48000, 44100).every(Number.isFinite));
    /* 空数组不该抛 */
    assert.equal(resampleLinear(new Float32Array(0), 48000, 96000).length, 0);
});

/* ---------------- ★ 两侧一致性（方案 §5 的核心守门） ---------------- */

test('★ 采样率与 taps：Web 与 Rust 两侧一致', () => {
    assert.equal(IR_SAMPLE_RATE, rustScalar('IR_SAMPLE_RATE'),
        'IR 参考采样率两侧不一致');
    assert.equal(IR_TAPS, rustScalar('IR_TAPS'), 'IR 长度两侧不一致');
});

test('★ 虚拟声场表：Web 与 Rust 逐项一致', () => {
    const rows = rustArrayBody('STAGE_TUNING');
    const got = numbersIn(rows);
    /* 每档 3 个数，按 decl 顺序：stage_s / haas_ms / haas_mix */
    assert.equal(got.length, STAGE_LEVELS.length * 3,
        `Rust STAGE_TUNING 应有 ${STAGE_LEVELS.length * 3} 个数，实为 ${got.length}`);
    STAGE_LEVELS.forEach((lv, i) => {
        const t = STAGE_TUNING[lv];
        const base = i * 3;
        assert.equal(got[base], t.stageS, `${lv}.stageS 两侧不一致`);
        assert.equal(got[base + 1], t.haasMs, `${lv}.haasMs 两侧不一致`);
        assert.equal(got[base + 2], t.haasMix, `${lv}.haasMix 两侧不一致`);
    });
});

test('★ 空间音频表：Web 与 Rust 逐项一致', () => {
    const got = numbersIn(rustArrayBody('SPATIAL_TUNING'));
    assert.equal(got.length, SPATIAL_LEVELS.length,
        `Rust SPATIAL_TUNING 应有 ${SPATIAL_LEVELS.length} 个数，实为 ${got.length}`);
    SPATIAL_LEVELS.forEach((lv, i) => {
        assert.equal(got[i], SPATIAL_TUNING[lv].wet, `${lv}.wet 两侧不一致`);
    });
});

test('★ IR 样本：Web 与 Rust 逐样本一致', () => {
    for (const name of IR_ORDER) {
        for (const ear of ['left', 'right']) {
            const constName = `IR_${name.toUpperCase()}_${ear === 'left' ? 'L' : 'R'}`;
            const got = numbersIn(rustArrayBody(constName));
            const want = SPATIAL_IRS[name][ear];
            assert.equal(got.length, want.length,
                `${constName} 长度与 Web 侧不一致（${got.length} vs ${want.length}）`);
            for (let i = 0; i < want.length; i++) {
                /* ★ 归到 f32 域再比：Rust 侧读的是十进制字面量、Web 侧 Float32Array
                   读到的是 f32 展开成 f64 的表示，两者字面不同但应是同一个 f32。
                   生成器用 9 位有效数字（binary32 十进制往返安全位数）写样本，
                   因此 Math.fround(十进制) 必然等于 Web 侧存的那个 f32。 */
                assert.equal(Math.fround(got[i]), want[i],
                    `${constName}[${i}] 两侧不一致：Rust=${got[i]} Web=${want[i]}`);
            }
        }
    }
});

test('★ IR 档位名与缺省项：Web 与 Rust 一致', () => {
    const rustOrder = (RUST_SRC.match(/pub const IR_ORDER: \[[^\]]*\] = \[([^\]]*)\]/) || [])[1];
    assert.ok(rustOrder, 'Rust 源里找不到 IR_ORDER');
    const names = (rustOrder.match(/"([^"]+)"/g) || []).map((s) => s.replace(/"/g, ''));
    assert.deepEqual(names, [...IR_ORDER], 'IR_ORDER 两侧不一致');
    const rustDefault = (RUST_SRC.match(/pub const IR_DEFAULT: &str = "([^"]+)"/) || [])[1];
    assert.equal(rustDefault, IR_DEFAULT, 'IR_DEFAULT 两侧不一致');
});
