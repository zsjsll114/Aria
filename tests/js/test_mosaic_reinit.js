/* ============================================================
 * tests/js/test_mosaic_reinit.js — 蒙德里安重入无背景回归测试
 * 运行方式：node --test tests/js/test_mosaic_reinit.js
 *   （Node ≥ 22 内置 test runner；零第三方依赖）
 *
 * 背景（2026-09 bug 复盘）：
 *   220-shortcuts-viewmode.js 切回隧道模式时对**复用实例**再次 init()，
 *   init() 里 viewContainer.innerHTML='' 丢弃整个图层树，而
 *   _mosaicBlockPool/_mosaicBgEl 等仍指向旧图层孤儿节点 → 背景样式
 *   全刷在不可见 DOM 上 → 「蒙德里安模式没有背景」（首进正常、重进必现）。
 *
 * 为什么是源码级断言：TunnelEngine 依赖完整 DOM/canvas 环境，node 无头
 * 环境跑不动；这里锁定的是「不变量」——init() 在重建图层树时必须先重置
 * 全部绑定 DOM 的蒙德里安运行时状态，且重置必须发生在首个
 * _updateMosaicBackground 调用（首帧兜底）之前。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', '..', 'web', 'src', 'core', 'tunnelEngine', 'TunnelEngine.js');
const source = readFileSync(SRC, 'utf8');

/** 从源码中按方法名提取方法体（大括号配对，够用于本项目扁平类体） */
function extractMethod(name) {
  const sigRe = new RegExp(`\\n\\s{2}(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*\\{`);
  const m = source.match(sigRe);
  assert.ok(m, `源码中应存在方法 ${name}()`);
  const start = source.indexOf('{', m.index + m[0].length - 1);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  assert.fail(`方法 ${name}() 大括号不配对`);
}

/* 必须重置的孤儿引用清单：凡指向 mosaicLayer 内 DOM 或由其派生的运行时状态 */
const ORPHAN_PRONE_REFS = [
  '_mosaicBlockPool',
  '_mosaicBgEl',
  '_mosaicDecoEl',
  '_lastMosaicFamily',
  '_lastBgCacheKey',
  '_currentMosaicPattern',
  '_currentMosaicEdges',
  '_lastPatternBlocks',
];

test('init() 重建图层树后必须重置全部蒙德里安孤儿引用', () => {
  const body = extractMethod('init');
  const wipeAt = body.indexOf("this.viewContainer.innerHTML = ''");
  assert.ok(wipeAt >= 0, 'init() 应包含 viewContainer.innerHTML 清空');

  for (const ref of ORPHAN_PRONE_REFS) {
    const re = new RegExp(`this\\.${ref}\\s*=\\s*null`);
    const m = body.slice(wipeAt).match(re);
    assert.ok(m, `init() 在 innerHTML='' 之后必须重置 this.${ref} = null（重入孤儿节点防护）`);
  }
});

test('重置必须发生在 init() 首帧兜底 _updateMosaicBackground 调用之前', () => {
  const body = extractMethod('init');
  const wipeAt = body.indexOf("this.viewContainer.innerHTML = ''");
  const resetAt = body.indexOf('this._mosaicBlockPool = null', wipeAt);
  const fallbackAt = body.indexOf('_updateMosaicBackground(', wipeAt);
  assert.ok(fallbackAt >= 0, 'init() 应保留首帧兜底 _updateMosaicBackground 调用');
  assert.ok(resetAt >= 0 && resetAt < fallbackAt,
    '孤儿引用重置必须先于首帧兜底（否则兜底又把样式刷进新池前的旧状态）');
});

test('_updateMosaicBackground 块池必须惰性重建（重置后可自愈）', () => {
  const body = extractMethod('_updateMosaicBackground');
  assert.ok(/if\s*\(!this\._mosaicBlockPool\)\s*this\._mosaicBlockPool\s*=\s*\[\]/.test(body),
    '块池必须以 if (!this._mosaicBlockPool) 惰性创建，重置为 null 后下次调用可重建');
  assert.ok(/if\s*\(!this\._mosaicBgEl\)\s*\{/.test(body),
    '背景底层元素必须以 if (!this._mosaicBgEl) 惰性创建');
});

test('模式退出仅 stop() 不销毁实例 → 二次 init 重入路径真实存在', () => {
  /* 锁定触发条件本身：220-shortcuts-viewmode 的重入路径若日后改为每次新建实例，
     本测试允许删除；但只要"复用实例 + 再次 init()"还成立，重置就必须在。 */
  const vmPath = join(__dirname, '..', '..', 'web', 'src', 'app', '220-shortcuts-viewmode.js');
  const vm = readFileSync(vmPath, 'utf8');
  assert.ok(/if\s*\(!tunnelEngineInstance\)\s*\{[^}]*new TunnelEngine/.test(vm),
    '220-shortcuts-viewmode 存在实例复用分支');
  assert.ok(/tunnelEngineInstance\.init\(tunnelContainer\)/.test(vm),
    '220-shortcuts-viewmode 对（可能是复用的）实例直接调用 init()');
});
