/* ============================================================
 * tests/js/test_globals_dts.js — globals.d.ts 同步门禁本身必须会响
 *
 * globals.d.ts 是从 eslint.config.mjs 的 PROJECT_GLOBAL_KEYS 生成的（清单唯一事实源），
 * 治的是「core 层一纳入 tsc 就一片 TS2339 属性不存在」。重点：
 *   ① 能从源码里提取键、去重、保持顺序；
 *   ② 源码里没有该数组 → 返回 null（结构被改要能发现，而不是当成 0 键悄悄过）；
 *   ③ 生成物同时含 var 形态与 Window 接口形态；
 *   ④ 真实文件与清单同步（这条就是 CI 里那条断言的本地版）；
 *   ⑤ 「清单加了键但没重新生成」必须被判为不同步。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractProjectGlobalKeys, render, scan } from '../../scripts/audits/globals-dts.mjs';

test('① 提取键：去重、保持顺序', () => {
    const src = "const PROJECT_GLOBAL_KEYS = [\n    'b', 'a',\n    'b',\n];\n";
    assert.deepEqual(extractProjectGlobalKeys(src), ['b', 'a']);
});

test('② 没有该数组 → null（结构被改不得静默当 0 键）', () => {
    assert.equal(extractProjectGlobalKeys('const x = 1;'), null);
});

test('③ 生成物同时含 var 与 Window 接口两种形态', () => {
    const t = render(['foo', 'bar']);
    assert.ok(t.includes('declare var foo: any;'), '缺 declare var 形态');
    assert.ok(t.includes('    bar: any;'), '缺 Window 接口形态');
    assert.ok(t.includes('interface Window'), '缺 Window 接口');
});

test('④ 真实文件必须与 eslint 清单同步（CI 里那条断言的本地版）', () => {
    const r = scan();
    assert.equal(r.error, undefined, r.error);
    assert.ok(r.ok, 'globals.d.ts 与 eslint.config.mjs 不同步 —— 跑 node scripts/audits/globals-dts.mjs --write');
});

test('⑤ 清单加了键但没重新生成 → 判为不同步', () => {
    const realSrc = "const PROJECT_GLOBAL_KEYS = [\n    'foo',\n];\n";
    const stale = render(['foo']); /* 只含 foo 的旧生成物 */
    const bumped = "const PROJECT_GLOBAL_KEYS = [\n    'foo',\n    'bar',\n];\n"; /* 清单已加 bar */
    const r = scan({ eslintSrc: bumped, dtsText: stale });
    assert.equal(r.ok, false);
    assert.ok(r.expected.includes('bar'), '生成期望里应含新键');
    /* 反证：与当前清单一致的生成物应判为同步 */
    assert.equal(scan({ eslintSrc: realSrc, dtsText: render(['foo']) }).ok, true);
});
