#!/usr/bin/env node
/**
 * scripts/audits/resolve-instrumentation.mjs — 取链埋点完备性门禁（AGENTS.md 约束 14）
 *
 * 为什么要有这个脚本：约束 14 要求「loadOnlineSong 里每个 `playUrl =` 赋值点后面
 * 跟一行 recordResolveHit」，此前它只是一句人话约定 + 一条按**行号区间** grep 的复扫命令。
 * 行号会随任何一次编辑漂移，漂移之后那条命令既不报错、也不报错，只是悄悄不再覆盖
 * 新增的分支 —— 于是角标开始漏报来源，而没人知道从哪一版开始漏。
 *
 * 所以这里改成：按大括号配对切出函数体，在体内比较「赋值点数」与「埋点数」，
 * 并额外要求每个埋点确实在该函数体内。不依赖行号，也不依赖人的记忆。
 *
 * 用法：node scripts/audits/resolve-instrumentation.mjs [--check]
 *   --check 时不合规以 exit(1) 结束（CI 用）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TARGET = 'web/src/app/175-track-index-online.js';

/**
 * 按大括号配对取出某个函数声明的函数体源码。
 * 不用正则匹配 `}` 是因为函数体里有字符串/注释/模板串里的花括号，
 * 这里用一个够用的近似：先跳过字符串再计数（本文件里没有跨行模板串嵌套）。
 */
function extractFunctionBody(src, fnName) {
  const decl = new RegExp(`(async\\s+)?function\\s+${fnName}\\s*\\(`);
  const m = decl.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', src.indexOf(')', m.index));
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '\'' || c === '"' || c === '`') {            // 跳过字符串字面量
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {                  // 跳过行注释
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {                  // 跳过块注释
      i = src.indexOf('*/', i + 2) + 1;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { body: src.slice(open + 1, i), start: open, end: i };
    }
  }
  return null;
}

/** 赋值点：`playUrl =` 但排除 `==`、`===`、`>=`、`<=`、`!` 这类比较 */
const ASSIGN_RE = /\bplayUrl\s*=(?!=)/g;
const RECORD_RE = /\brecordResolveHit\s*\(/g;

/**
 * 分析一份 175 源码，返回 { assigns, records, preloadRecords, problems }。
 * 导出是为了能被反向测试钉住（「漏埋点时必须报错」），而不只在真源码上显示 OK。
 */
export function analyzeResolveInstrumentation(src) {
  const problems = [];
  const fn = extractFunctionBody(src, 'loadOnlineSong');
  let assigns = 0;
  let records = 0;
  if (!fn) {
    problems.push('找不到 loadOnlineSong 函数体 —— 它被改名或挪走了，请同步更新本门禁');
  } else {
    assigns = (fn.body.match(ASSIGN_RE) || []).length;
    records = (fn.body.match(RECORD_RE) || []).length;
    if (records < assigns) {
      problems.push(`有 ${assigns - records} 个 playUrl 赋值点没有配对的 recordResolveHit`
        + `（角标会对这些分支永久沉默）`);
    }
    if (records > assigns) {
      problems.push(`recordResolveHit 比赋值点还多（${records} > ${assigns}）`
        + `—— 要么多埋了，要么赋值写法变了`);
    }
  }

  /* 预加载链是**故意**不埋点的：埋了角标会显示成还没播放的那一首。
     把它当哨兵量出来 —— 有人给预加载也埋点时，这里就该红。 */
  const preload = extractFunctionBody(src, 'fetchPlayUrlForPreload');
  const preloadRecords = preload ? (preload.body.match(RECORD_RE) || []).length : 0;
  if (preloadRecords > 0) {
    problems.push(`fetchPlayUrlForPreload 里出现了 ${preloadRecords} 个 recordResolveHit`
      + `：预加载链不该埋点（角标会跳到下一首歌）`);
  }
  return { assigns, records, preloadRecords, problems };
}

/* 只在作为脚本直接执行时跑 CLI；被测试 import 时不打印、不 exit。
   用 globalThis.process 而不是 import 'node:process'：真 Node 里它本就是全局，
   而某些沙箱（node-repl）禁 import 该模块，取全局可让本文件在两种环境下都被 import。
   Windows 下 argv[1] 的大小写/分隔符可能与 import.meta.url 不一致，故归一化比较。 */
const proc = globalThis.process;
function norm(p) {
  const q = resolve(p).replace(/\\/g, '/');
  return proc && proc.platform === 'win32' ? q.toLowerCase() : q;
}
const isMain = !!proc?.argv?.[1] && norm(proc.argv[1]) === norm(fileURLToPath(import.meta.url));

if (isMain) {
  const src = readFileSync(resolve(ROOT, TARGET), 'utf8');
  const { assigns, records, preloadRecords, problems } = analyzeResolveInstrumentation(src);

  const line = `${TARGET} · loadOnlineSong 赋值点 ${assigns} / 埋点 ${records}`
    + ` · 预加载链埋点 ${preloadRecords}（应为 0）`;

  if (problems.length === 0) {
    console.log(`OK   ${line}`);
    console.log('     取链埋点完备。新增取链分支时记得同时 recordResolveHit。');
  } else {
    console.log(`FAIL ${line}`);
    for (const p of problems) console.log('  ✗ ' + p);
    console.log('  参考：AGENTS.md 约束 14');
  }

  if (proc.argv.includes('--check') && problems.length) proc.exit(1);
}
