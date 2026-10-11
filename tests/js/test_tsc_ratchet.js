/* ============================================================
 * tests/js/test_tsc_ratchet.js — 类型检查棘轮门禁本身必须会响
 *
 * 治的是「JSDoc 写了但没工具消费」：本门禁让 tsc 跑起来并钉住错误数只降不升。
 * 重点不是「现在几条」（那由 CI 跑），而是判定逻辑正确：
 *   ① 错误计数只认 `error TSxxxx`，不把普通输出/警告算进去；
 *   ② 当前 ≤ 基线 → OK；
 *   ③ 当前 > 基线 → 必须不等于 OK（棘轮会响）；
 *   ④ 基线文件存在且 errors 是数字（结构没被改坏）。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseErrorCount, evaluate, readBaseline } from '../../scripts/audits/tsc-ratchet.mjs';

test('① 只数 `error TSxxxx`，警告与普通输出不算', () => {
    const out = [
        'web/src/a.js(1,2): error TS2339: Property x does not exist.',
        'web/src/b.js(3,4): error TS2304: Cannot find name y.',
        'web/src/c.js(5,6): warning TS9999: something',
        'Found 2 errors in 2 files.',
    ].join('\n');
    assert.equal(parseErrorCount(out), 2);
    assert.equal(parseErrorCount(''), 0);
    assert.equal(parseErrorCount('no errors here'), 0);
});

test('② 当前 ≤ 基线 → OK', () => {
    assert.equal(evaluate({ count: 0, limit: 0 }).ok, true);
    assert.equal(evaluate({ count: 3, limit: 5 }).ok, true);
    assert.equal(evaluate({ count: 5, limit: 5 }).ok, true);
});

test('③ 当前 > 基线 → 棘轮必须响', () => {
    assert.equal(evaluate({ count: 1, limit: 0 }).ok, false);
    assert.equal(evaluate({ count: 6, limit: 5 }).ok, false);
});

test('④ 基线文件结构完好（errors 是数字、scope 非空）', () => {
    const b = readBaseline();
    assert.equal(typeof b.errors, 'number');
    assert.ok(Array.isArray(b.scope) && b.scope.length > 0, 'scope 不能为空');
});
