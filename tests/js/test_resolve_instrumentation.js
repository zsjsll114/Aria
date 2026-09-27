/* ============================================================
 * tests/js/test_resolve_instrumentation.js — 门禁本身必须会响
 *
 * 一条从不失败的检查，和一句「以后注意」没有区别。
 * 所以这里测的不是真源码 OK（那由 CI 跑），而是**故意喂它坏源码时必须报错**：
 *   ① 漏埋点 → 必须红；② 给预加载链埋点 → 必须红（那是另一种错法）；
 *   ③ 函数被改名 → 必须红（否则门禁会「永远通过」，最危险的失效模式）；
 *   ④ 字符串/注释里的花括号不得把函数体切短（否则 ① 会漏报）。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeResolveInstrumentation } from '../../scripts/audits/resolve-instrumentation.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ---------- ③ 函数改名 ---------- */
test('函数被改名时必须报错，而不是静默通过', () => {
  const r = analyzeResolveInstrumentation('export async function somethingElse() { playUrl = a; }');
  assert.ok(r.problems.some(p => /找不到 loadOnlineSong/.test(p)));
});

/* ---------- ① 漏埋点 ---------- */
test('少一个 recordResolveHit 就报，且报出缺口数', () => {
  const src = `
    async function loadOnlineSong(info) {
      let playUrl;
      if (a) { playUrl = urlA; recordResolveHit('selfhostQQ', playUrl, '320'); }
      if (b) { playUrl = urlB; }
      if (c) { playUrl = urlC; recordResolveHit('vkeys', playUrl); }
    }`;
  const r = analyzeResolveInstrumentation(src);
  assert.equal(r.assigns, 3);
  assert.equal(r.records, 2);
  assert.ok(r.problems.some(p => /1 个 playUrl 赋值点没有配对/.test(p)));
});

test('全埋齐时不报', () => {
  const src = `
    async function loadOnlineSong(info) {
      let playUrl;
      playUrl = urlA; recordResolveHit('x', playUrl);
      playUrl = urlB; recordResolveHit('y', playUrl);
    }`;
  assert.deepEqual(analyzeResolveInstrumentation(src).problems, []);
});

/* ---------- 比较运算符不得被当成赋值 ---------- */
test('playUrl == / === / >= 不算赋值点', () => {
  const src = `
    async function loadOnlineSong(info) {
      let playUrl = null;
      recordResolveHit('x', playUrl);
      if (playUrl === null) { return; }
      if (playUrl == other) { return; }
      if (n >= playUrl) { return; }
    }`;
  const r = analyzeResolveInstrumentation(src);
  assert.equal(r.assigns, 1, `把比较当成了赋值：${r.assigns}`);
  assert.deepEqual(r.problems, []);
});

/* ---------- ② 预加载链哨兵 ---------- */
test('给预加载链埋点也要报（角标会跳到下一首歌）', () => {
  const src = `
    async function loadOnlineSong(info) {
      let playUrl; playUrl = a; recordResolveHit('x', playUrl);
    }
    async function fetchPlayUrlForPreload(id) {
      let playUrl; playUrl = b; recordResolveHit('y', playUrl);
    }`;
  const r = analyzeResolveInstrumentation(src);
  assert.equal(r.preloadRecords, 1);
  assert.ok(r.problems.some(p => /预加载链不该埋点/.test(p)));
});

/* ---------- ④ 切体不得被字符串/注释里的花括号带偏 ---------- */
test('字符串与注释里的花括号不会把函数体切短', () => {
  const src = `
    async function loadOnlineSong(info) {
      let playUrl;
      const tpl = "a } b { c }";
      /* 注释里有 } 和 { 也不许影响配对 */
      const s2 = '}{';
      playUrl = a; recordResolveHit('x', playUrl);
      playUrl = b; recordResolveHit('y', playUrl);
      if (q) { return; }
    }
    function afterThisMustNotBeCounted() { playUrl = z; }`;
  const r = analyzeResolveInstrumentation(src);
  assert.equal(r.assigns, 2, `函数体切错了：assigns=${r.assigns}（3 说明越界读到了后面的函数）`);
  assert.equal(r.records, 2);
  assert.deepEqual(r.problems, []);
});

/* ---------- 真源码 ---------- */
test('真源码当前是合规的，且赋值点数量级符合预期', () => {
  const src = readFileSync(resolve(ROOT, 'web/src/app/175-track-index-online.js'), 'utf8');
  const r = analyzeResolveInstrumentation(src);
  assert.deepEqual(r.problems, [], `真源码不合规：${r.problems.join('; ')}`);
  assert.ok(r.assigns >= 19, `赋值点只有 ${r.assigns}，门禁可能切短了函数体`);
  assert.equal(r.preloadRecords, 0);
});
