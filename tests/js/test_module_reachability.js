/* ============================================================
 * tests/js/test_module_reachability.js — 可达性门禁的抽取层必须会响
 *
 * 治的是一个**假阳性**：`module-reachability` 用正则在源码里找 import，
 * 原来的写法 `import\s+([\s\S]*?\sfrom\s*)?['"]x['"]` 会把「副作用 import」整条吃掉——
 *   import '../utils/numberStepper.js';
 *   import { x } from './y.js';
 * 第二条的 `from` 被当成第一条的，于是 numberStepper 从图里消失，被误报成
 * 「影子模块 / 改了不生效」。约束 10 那张名单的 4 → 5 虚增就是这么来的。
 * 门禁报假阳性比漏报更糟：人会开始相信它的输出，然后照它删代码。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractStaticImports } from '../../scripts/audits/lib/import-scan.mjs';

test('★ 副作用 import 后面紧跟 from import：两条都要抽到', () => {
    const src = `import '../utils/numberStepper.js';\nimport { x } from './y.js';\n`;
    assert.deepEqual(extractStaticImports(src), ['../utils/numberStepper.js', './y.js']);
});

test('副作用 import 在文件末尾（后面没有 from）也不许漏', () => {
    assert.deepEqual(extractStaticImports(`import './side-effect.js';\n`), ['./side-effect.js']);
});

test('多行具名 import 照常抽取（换行不算越过 ; 所以不会被挡）', () => {
    const src = `import {\n    A,\n    B,\n} from '../core/x.js';\n`;
    assert.deepEqual(extractStaticImports(src), ['../core/x.js']);
});

test('一条语句里不许跨到下一条：分号是硬边界', () => {
    /* 若允许 [\s\S]*?，这条只返回 './b.js'（第一条被吞）——上面第一条用例就是这个反例 */
    const src = `import a from './a.js'; import b from './b.js';\n`;
    assert.deepEqual(extractStaticImports(src), ['./a.js', './b.js']);
});

test('动态 import 不归这条正则管（另有 matchAll），这里只保证不误报成静态', () => {
    const src = `const m = await import('./lazy.js');\n`;
    assert.deepEqual(extractStaticImports(src), []);
});

test('抽取层不剥注释：靠调用方用 specToPath 过滤不存在的路径兜住', () => {
    /* 真源码里 `import` 字样出现在注释的情况很多（本仓库文档尤甚）。
       抽取层本身不做注释剥离——那是调用方的事，这里钉住「谁负责」：
       spec 指向不存在的文件时 specToPath 返回 null，注释行因此不会进图。 */
    const hits = extractStaticImports(`// import './not-real.js'\nimport './real.js';\n`);
    assert.ok(hits.includes('./real.js'));
    assert.equal(hits.length, 2, '注释行也被抽到：说明过滤责任在调用方，别指望这层干净');
});
