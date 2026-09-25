/* ============================================================
 * tests/js/test_word_fx.js — 词级特效参数（PV 从字级改词级）回归
 *
 * 用户反馈「每个字的粒子又杂又不如 folia」。根因是发射挂在 glyph 上：
 * 一行十个字 × 每字 3~5 颗 = 30~50 颗。这里盯住改完之后的三件事：
 *   ① 颗粒数按**词**给，且封顶 6 —— 总量必须显著低于字级；
 *   ② 有提前量（唱到之前就起势），且落在上游 guide 的 0.2~0.38s 区间；
 *   ③ 星轨是一条连续的三次贝塞尔、终点落在词位上（不是一堆碎线）。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    wordBurstCount,
    wordLeadMs,
    wordBurstEnvelope,
    buildStarTrail,
    WORD_TAIL_MS,
    mulberry32,
} from '../../web/src/core/pvEngine/wordFxSpec.js';

/* ---------- ① 颗粒量级 ---------- */

test('颗粒按词分级给量，且封顶 6', () => {
    assert.equal(wordBurstCount('hero', false), 6);
    assert.equal(wordBurstCount('support', true), 5);
    assert.equal(wordBurstCount('support', false), 3);
    for (const s of ['hero', 'semi-hero', 'support', 'decoration', '']) {
        assert.ok(wordBurstCount(s, true) <= 6 && wordBurstCount(s, true) >= 3);
    }
});

test('一行十字的总颗粒远少于字级实现', () => {
    /* 字级：10 字 × 平均 4 颗 ≈ 40；词级：按 5 词 × 3 颗 = 15 */
    const perChar = 10 * 4;
    const perWord = 5 * wordBurstCount('support', false);
    assert.ok(perWord < perChar / 2, `词级 ${perWord} 没比字级 ${perChar} 少一半`);
});

/* ---------- ② 提前量与拖尾 ---------- */

test('提前量落在上游 guide 的 200~380ms 区间', () => {
    const rnd = mulberry32(20260925);
    for (let i = 0; i < 500; i++) {
        const lead = wordLeadMs(rnd);
        assert.ok(lead >= 200 && lead <= 380, `提前量越界 ${lead}`);
    }
});

test('拖尾窗口是固定 650ms', () => {
    assert.equal(WORD_TAIL_MS, 650);
});

test('hero 的包络在三个维度上都比 support 更外放', () => {
    const hero = wordBurstEnvelope('hero');
    const sup = wordBurstEnvelope('support');
    assert.ok(hero.distMul > sup.distMul);
    assert.ok(hero.durMul > sup.durMul);
    assert.ok(hero.sizeMul > sup.sizeMul);
    assert.ok(sup.distMul > 1, '词级必须比字级甩得更远，否则改了等于没改');
});

/* ---------- ③ 星轨几何 ---------- */

test('星轨是一条连续的三次贝塞尔，终点落在词中心', () => {
    const rnd = mulberry32(7);
    for (let i = 0; i < 200; i++) {
        const box = { w: 40 + i, h: 24 + (i % 9) };
        const { d } = buildStarTrail(rnd, box);
        const moves = (d.match(/M/g) || []).length;
        const curves = (d.match(/C/g) || []).length;
        assert.equal(moves, 1, `不是一笔: ${d}`);
        assert.equal(curves, 1, `不是单条三次曲线: ${d}`);
        assert.ok(!/L|A|Q|Z/.test(d), `掺了其它命令: ${d}`);
        const tail = d.trim().split(/\s+/).pop();
        const [x, y] = tail.split(',').map(Number);
        assert.ok(Math.abs(x - box.w / 2) < 0.02 && Math.abs(y - box.h / 2) < 0.02,
            `终点没落在词位上: ${tail} vs ${box.w / 2},${box.h / 2}`);
    }
});

test('星轨时长在 420~680ms，且数值全部有限', () => {
    const rnd = mulberry32(11);
    for (let i = 0; i < 200; i++) {
        const t = buildStarTrail(rnd, { w: 80, h: 40 });
        assert.ok(t.durMs >= 420 && t.durMs <= 680, `时长越界 ${t.durMs}`);
        assert.ok(!/NaN|undefined|Infinity/.test(t.d), `几何里有坏数: ${t.d}`);
    }
});

test('同种子可复现（装饰也必须能重放）', () => {
    const a = buildStarTrail(mulberry32(99), { w: 70, h: 34 });
    const b = buildStarTrail(mulberry32(99), { w: 70, h: 34 });
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, buildStarTrail(mulberry32(100), { w: 70, h: 34 }));
});
