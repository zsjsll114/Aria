/* ============================================================
 * tests/js/test_test_registry.js — 登记门禁本身必须会响
 *
 * 这条门禁是为了治「测试写完没进 CI」：本仓库真漏过 15 个（工具栏 E2E 49 条断言、
 * 手机遥控 33 条、后端缓存锁/登录判据单测……），全绿过一次就再没跑过。
 * 所以重点不是「现在名单齐」（那由 CI 跑），而是**故意把名单弄缺时必须报**：
 *   ① 抽掉一个 e2e 行 → 只报那一个（证明逐文件判定，不是「少了一行所以整体糊」）；
 *   ② 抽掉 unittest 模块名 → 同上；
 *   ③ 把 JS 那行 glob 改回手抄名单 → 全体 JS 立刻未登记（glob 是它们的唯一覆盖来源）；
 *   ④ 名单点了不存在的文件 → 报空转（改名/删文件留下的行会让 CI 红在无关处）；
 *   ⑤ 空 ci 文本 → 必须报一大堆，而不是「0 个文件」——防止扫描目录写错导致门禁永远通过。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scan, readCi, EXEMPT } from '../../scripts/audits/test-registry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL = readCi();

test('真名单必须齐全（这条就是 CI 里那条断言的本地版）', () => {
    const r = scan(REAL);
    assert.deepEqual(r.missing, [], `未登记: ${r.missing.join(', ')}`);
    assert.deepEqual(r.stale, [], `空转: ${r.stale.join(', ')}`);
});

test('① 抽掉一个 e2e 回归行 → 只报那一个文件', () => {
    const r = scan(REAL.replace(/ *python tests\/test_number_stepper\.py\n/, '\n'));
    assert.deepEqual(r.missing, ['tests/test_number_stepper.py'], r.missing);
});

test('② 抽掉一个后端单测模块名 → 报对应文件（不是整段吞掉）', () => {
    const r = scan(REAL.replace(/ *python -m unittest tests\.python\.test_cache_lock\n/, '\n'));
    assert.deepEqual(r.missing, ['tests/python/test_cache_lock.py'], r.missing);
});

test('③ JS 那行 glob 若被改回手抄名单，全体 JS 测试立刻未登记', () => {
    /* 钉住实现选择：JS 侧靠 glob 覆盖，所以「谁手抄回逐行、又漏了几行」这类退回
       必须当场可见——而不是悄悄少跑 12 个文件。 */
    const r = scan(REAL.replace('node --test tests/js/test_*.js', 'echo skipped'));
    const js = r.missing.filter((f) => f.startsWith('tests/js/'));
    assert.ok(js.length >= 20, `应报出全部 JS 测试，实际 ${js.length}`);
    assert.ok(js.includes('tests/js/test_ab_loop.js'), js.slice(0, 5));
});

test('④ 名单点了不存在的文件 → 报空转', () => {
    const r = scan(REAL.replace('tests/test_number_stepper.py', 'tests/test_ghost.py'));
    assert.ok(r.stale.includes('tests/test_ghost.py'), r.stale);
    assert.ok(r.missing.includes('tests/test_number_stepper.py'), r.missing);
});

test('④b unittest 点了不存在的模块 → 一样报空转', () => {
    const r = scan(REAL.replace('tests.python.test_cache_lock', 'tests.python.test_ghost'));
    assert.ok(r.stale.includes('tests.python.test_ghost'), r.stale);
});

test('⑤ 空名单不得「通过」：扫到的文件数就是真实文件数', () => {
    const r = scan('jobs:\n  x:\n    steps: []\n');
    assert.ok(r.total >= 40, `总文件数被扫成 ${r.total}，目录写法八成错了`);
    assert.equal(r.missing.length, r.total - Object.keys(EXEMPT).length);
});

test('豁免必须带理由，且理由非空（防止变成长期免死金牌）', () => {
    for (const [file, why] of Object.entries(EXEMPT)) {
        assert.ok(String(why).length > 8, `${file} 的豁免理由太短: ${why}`);
    }
    const r = scan(REAL);
    for (const file of Object.keys(EXEMPT)) {
        assert.ok(!r.missing.includes(file), `${file} 已在豁免表却仍被报未登记`);
    }
});

test('豁免表里的文件必须真的存在（删掉测试后别留着条目骗自己）', () => {
    for (const file of Object.keys(EXEMPT)) {
        assert.ok(existsSync(resolve(ROOT, file)), `豁免表点了不存在的文件: ${file}`);
    }
});
