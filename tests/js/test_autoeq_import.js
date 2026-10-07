/* ============================================================
 * test_autoeq_import.js — AutoEQ PEQ 解析与频响映射（需求 3）
 *
 * 钉三件事：
 *   ① 解析器认 AutoEQ 标准行（含 OFF 跳过、LP/HP 记为 skipped、Preamp）；
 *   ② RBJ 双二阶响应数值正确（+6dB peaking 在中心频点应 ≈+6dB，
 *      lowshelf 在远低于 Fc 处应 ≈ 满增益）—— 这是"用标准公式而非
 *      自己发明算法"的可验证证据；
 *   ③ 输出的段增益长度/范围/整数性符合 10 段 EQ 的约束。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import(new URL('../../web/src/core/autoeqImport.js', import.meta.url));
const { parseAutoEqPeq, peqToBandGains, compileAutoEq, AUTO_EQ_GAIN_LIMIT } = mod;

const BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

const SAMPLE = `Preamp: -6.1 dB
Filter 1: ON PK Fc 105 Hz Gain 6.1 dB Q 0.70
Filter 2: ON LSC Fc 105 Hz Gain 5.0 dB Q 0.70
Filter 3: ON HSC Fc 10000 Hz Gain -3.0 dB Q 0.70
Filter 4: OFF PK Fc 500 Hz Gain 9.9 dB Q 1.00
Filter 5: ON LP Fc 20000 Hz
`;

test('解析：识别 PK/LSC/HSC，跳过 OFF，无增益类型计入 skipped', () => {
    const p = parseAutoEqPeq(SAMPLE);
    assert.equal(p.preampDb, -6.1, 'Preamp 应被解析');
    assert.equal(p.filters.length, 3, 'PK+LSC+HSC 三条（OFF 与 LP 不采）');
    assert.equal(p.filters[0].type, 'peaking');
    assert.equal(p.filters[0].fc, 105);
    assert.equal(p.filters[0].gainDb, 6.1);
    assert.equal(p.filters[0].q, 0.7);
    assert.equal(p.filters[1].type, 'lowshelf');
    assert.equal(p.filters[2].type, 'highshelf');
    assert.equal(p.skipped, 1, 'LP 无增益 → skipped');
});

test('解析：Q 缺省回落 0.707（不产生 NaN）', () => {
    const p = parseAutoEqPeq('Filter 1: ON LSC Fc 105 Hz Gain 4.0 dB');
    assert.equal(p.filters.length, 1);
    assert.ok(Math.abs(p.filters[0].q - 0.707) < 1e-9);
});

test('解析：Peace/旧括号格式也认', () => {
    const p = parseAutoEqPeq('Peaking: 1000 Hz, 3.5 dB, Q 1.40\nLow Shelf: 105 Hz, 5.0 dB, Q 0.70');
    assert.equal(p.filters.length, 2);
    assert.equal(p.filters[0].type, 'peaking');
    assert.equal(p.filters[0].gainDb, 3.5);
    assert.equal(p.filters[1].type, 'lowshelf');
});

test('解析：空文本 / 垃圾文本不抛，返回空 filters', () => {
    for (const t of ['', '   ', 'hello world', null, undefined]) {
        const p = parseAutoEqPeq(t);
        assert.equal(p.filters.length, 0);
    }
});

test('响应：+6dB peaking @1kHz 在 1kHz 处 ≈ +6dB（中心频点）', () => {
    const gains = peqToBandGains({ filters: [{ type: 'peaking', fc: 1000, gainDb: 6, q: 0.707 }] }, BANDS);
    const i = BANDS.indexOf(1000);
    assert.equal(gains[i], 6, `1kHz 段应约 +6dB，实得 ${gains[i]}`);
});

test('响应：-6dB peaking @1kHz 在 1kHz 处 ≈ -6dB', () => {
    const gains = peqToBandGains({ filters: [{ type: 'peaking', fc: 1000, gainDb: -6, q: 0.707 }] }, BANDS);
    assert.equal(gains[BANDS.indexOf(1000)], -6);
});

test('响应：高窄 Q 只在中心频点起作用（1kHz 不影响 8kHz 段）', () => {
    const gains = peqToBandGains({ filters: [{ type: 'peaking', fc: 1000, gainDb: 8, q: 4 }] }, BANDS);
    assert.equal(gains[BANDS.indexOf(1000)], 8);
    assert.equal(gains[BANDS.indexOf(8000)], 0, '8kHz 应不受 1kHz 窄峰影响');
});

test('响应：lowshelf +6dB @105Hz 在低频段 ≈ 满增益、高频段 ≈ 0', () => {
    const g = peqToBandGains({ filters: [{ type: 'lowshelf', fc: 105, gainDb: 6, q: 0.707 }] }, BANDS);
    assert.ok(g[BANDS.indexOf(32)] >= 5, `32Hz 应接近 +6dB，实得 ${g[BANDS.indexOf(32)]}`);
    assert.equal(g[BANDS.indexOf(8000)], 0, '8kHz 应基本不受低频搁架影响');
});

test('响应：highshelf +6dB @4kHz 在高频段 ≈ 满增益', () => {
    const g = peqToBandGains({ filters: [{ type: 'highshelf', fc: 4000, gainDb: 6, q: 0.707 }] }, BANDS);
    assert.ok(g[BANDS.indexOf(16000)] >= 5, `16kHz 应接近 +6dB，实得 ${g[BANDS.indexOf(16000)]}`);
    assert.equal(g[BANDS.indexOf(32)], 0);
});

test('响应：多个滤波器线性叠加（+4 与 -4 同频点相消）', () => {
    const g = peqToBandGains({
        filters: [
            { type: 'peaking', fc: 500, gainDb: 4, q: 0.707 },
            { type: 'peaking', fc: 500, gainDb: -4, q: 0.707 },
        ],
    }, BANDS);
    assert.equal(g[BANDS.indexOf(500)], 0, '同频点正负相消');
});

test('输出约束：长度=频点数、整数、落在 ±12 内', () => {
    const g = peqToBandGains({ filters: [{ type: 'peaking', fc: 1000, gainDb: 40, q: 0.5 }] }, BANDS);
    assert.equal(g.length, BANDS.length);
    for (const v of g) {
        assert.ok(Number.isInteger(v), '段增益必须是整数');
        assert.ok(Math.abs(v) <= AUTO_EQ_GAIN_LIMIT, `超出 ±${AUTO_EQ_GAIN_LIMIT}：${v}`);
    }
});

test('compileAutoEq：成功路径返回 gains 与 report', () => {
    const r = compileAutoEq(SAMPLE, BANDS);
    assert.equal(r.ok, true);
    assert.equal(r.gains.length, BANDS.length);
    assert.equal(r.report.count, 3);
    assert.equal(r.report.skipped, 1);
    assert.equal(r.report.preampDb, -6.1);
});

test('compileAutoEq：空文本 / 无有效滤波器 报错', () => {
    assert.equal(compileAutoEq('', BANDS).ok, false);
    assert.equal(compileAutoEq('whatever', BANDS).error, 'no-filter');
    assert.equal(compileAutoEq(SAMPLE, []).error, 'no-bands');
});

test('真实 AutoEQ 片段：解析条数与典型增益方向合理', () => {
    /* 典型 Sennheiser HD600 AutoEQ 前几行（截取） */
    const txt = `Preamp: -6.5 dB
Filter 1: ON LSC Fc 105 Hz Gain 5.5 dB Q 0.70
Filter 2: ON PK Fc 200 Hz Gain -1.4 dB Q 1.41
Filter 3: ON PK Fc 1500 Hz Gain -2.2 dB Q 1.41
Filter 4: ON PK Fc 3500 Hz Gain 2.8 dB Q 2.00
Filter 5: ON HSC Fc 10000 Hz Gain -4.0 dB Q 0.70`;
    const r = compileAutoEq(txt, BANDS);
    assert.equal(r.ok, true);
    assert.equal(r.report.count, 5);
    assert.ok(r.gains[BANDS.indexOf(32)] > 0, '低频搁架应抬升低频');
    assert.ok(r.gains[BANDS.indexOf(2000)] < 0, '1.5k 附近的凹陷');
    assert.ok(r.gains[BANDS.indexOf(16000)] < 0, '高频搁架应压高频');
});
