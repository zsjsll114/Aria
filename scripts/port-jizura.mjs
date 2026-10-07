/* ============================================================
 * _port_jizura.mjs — 把 JIZURA 引擎按「包裹式搬运」写进 web/src/vendor/jizura/
 *
 * 工艺（见 docs/JIZURA-落地技术方案.md §4）：
 *   上游 = 40 个文件按文件名排序**拼接进同一作用域**，靠闭包共享 `const J`
 *   （src/01_util.js:5 是创建者；其余是 `(() => { const E = J.E; … })();`）。
 *   因此：01_util.js 包成 createJizuraRoot()，其余 39 个包成 install(J)——**原文一字不改**。
 *
 * ★ 为什么放 vendor/：上游 11p_*.js 里有 800 个中日文 `name:` 字段，
 *   放进 core/ 会让 i18n-coverage 棘轮当场爆（新增 800 条未登记）。而 vendor/ 被
 *   eslint（eslint.config.mjs:112）、module-reachability（:13）、i18n（SKIP_DIRS）三处
 *   天然跳过，且"第三方移植源码放 vendor"语义正确。
 *
 * 校验：逐文件比对「包裹体内部正文」与上游原文的差异行数，必须**恰好等于已声明的数量**
 *      （版本占位符 1 行 + PATCHES 里声明的补丁各 1 行）——这是"没有偷改逻辑"的机器证明。
 *      ★ 补丁只允许写在下面的 PATCHES 里：直接改 vendor 文件会在下次搬运时被覆盖；
 *        而"声明内允许、声明外必须 0 差异"这条守门逻辑因此原样有效。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'scratch/jizura/src';
const OUT = 'web/src/vendor/jizura/engine';
const ATTR = '/* Ported from 852wa/JIZURA (MIT, Copyright (c) 2026 hakoniwa) — https://github.com/852wa/JIZURA — See THIRD_PARTY_NOTICES.md */';
/* 12_ui.js 是编辑器外壳（时间轴/面板/导出对话框/新手导览），不搬（方案 §1） */
const SKIP = new Set(['12_ui.js']);
/* 上游 build.py 把 VERSION 写进这个占位符；我们不跑它的构建，直接落一个可读值 */
const SUB_VERSION = { from: "'@VERSION@'", to: "'0.10.1-port'" };

/* ---------------- 已声明的本地补丁（Aria 对上游的**唯一**改动通道） ----------------
 * 每条 = 精确的 from→to + 理由 + 短标签。规则：
 *   ① 补丁必须**行数不变**（1 行换 1 行）—— 差异计数是按行下标比的，插行会让后面全部报错；
 *   ② 必须**命中**：上游那段变了就 problems 报警（宁可红，也不要静默产出没打补丁的引擎）；
 *   ③ 理由写在这里，vendor 文件里只留一个 `[Aria patch]` 标记，便于日后升级上游时定位。
 */
const PATCHES = [
    {
        file: '08_planner.js',
        tag: '逐字跟唱（cut 上限 12→64）',
        why: '逐字跟唱需要"每字一块"：块内只有一个字时，引擎自己的均分 reveal 天然精确，'
            + '因此不必改任何 reveal 公式（05_anim/11p_enter* 一行不动）。默认 12 块的上限'
            + '是给它的编辑器滑块用的，对我们只是限制。',
        from: '    const fixedN = ov.cuts > 0 ? Math.min(12, ov.cuts | 0) : 0;',
        to: '    const fixedN = ov.cuts > 0 ? Math.min(64, ov.cuts | 0) : 0;   // [Aria patch] 12→64 逐字跟唱，见 port-jizura.mjs PATCHES',
    },
    {
        file: '08_planner.js',
        tag: '真实行尾（timing.lineEnds）',
        why: '上游只认行首（timing.lineTimes），行尾是推出来的：非末行取下一行起点，'
            + '**末行按字数估**（clamp(0.8 + n*0.17, 1.5, 5.2)，10 字 → 2.5s）。'
            + '实测后果：一行 1.0→5.0s 的歌，引擎认为它 3.5s 就结束了，逐字切点被它夹到 1 个 0.22s 网格上。'
            + 'Aria 侧本来就有真实行尾（line.end），给它一条通道即可。',
        from: '  const ends = starts.map((s, i) => {',
        to: '  const ends = starts.map((s, i) => { const manEnd = T.lineEnds && T.lineEnds[i] != null && isFinite(+T.lineEnds[i]) && +T.lineEnds[i] > s ? +T.lineEnds[i] : null; if (manEnd != null) return manEnd;   // [Aria patch] 真实行尾，见 port-jizura.mjs PATCHES',
    },
];

const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.js') && !SKIP.has(f)).sort();
fs.mkdirSync(OUT, { recursive: true });

const idOf = (f) => 'i' + f.replace(/\.js$/, '').replace(/[^A-Za-z0-9_]/g, '_');
const rows = [];
const problems = [];

for (const f of files) {
    const raw = fs.readFileSync(path.join(SRC, f), 'utf8').replace(/\r\n/g, '\n');
    let body = raw;
    const isRoot = f === '01_util.js';
    if (isRoot) {
        body = body.replace(/^const J = \(window\.J = window\.J \|\| \{\}\);$/m, 'const J = {};');
        if (/window\.J/.test(body)) problems.push(`${f}: 仍残留 window.J`);
    }
    if (body.includes(SUB_VERSION.from)) body = body.split(SUB_VERSION.from).join(SUB_VERSION.to);

    /* 已声明的本地补丁：逐条精确替换 + 命中断言（见 PATCHES 的规则） */
    const patches = PATCHES.filter((p) => p.file === f);
    for (const p of patches) {
        if (!body.includes(p.from)) {
            problems.push(`${f}: 补丁未命中（上游这段变了？）—— ${p.tag}`);
            continue;
        }
        body = body.split(p.from).join(p.to);
    }
    const reasons = [];
    if (isRoot) reasons.push('window.J → 模块作用域');   /* 01_util.js 的包裹必需改动 */
    if (raw.includes(SUB_VERSION.from)) reasons.push('版本占位符');
    for (const p of patches) reasons.push(p.tag);

    /* 差异行数 = "搬运是否改了逻辑"的机器证明 */
    const a = raw.split('\n'); const b = body.split('\n');
    let diff = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) diff++;
    const expect = reasons.length;
    if (diff !== expect) problems.push(`${f}: 差异 ${diff} 行，声明 ${expect} 行（${reasons.join(' + ') || '无'}）`);

    const wrapped = isRoot
        ? `${ATTR}\nexport function createJizuraRoot() {\n${body}\nreturn J;\n}\n`
        : `${ATTR}\nexport default function install(J) {\n${body}\n}\n`;
    fs.writeFileSync(path.join(OUT, f), wrapped, 'utf8');
    rows.push({ f, lines: a.length, diff, isRoot, expect, reasons });
}

/* ---------------- bootstrap：唯一按序 import 的地方 ---------------- */
const root = files.find((f) => f === '01_util.js');
const others = files.filter((f) => f !== '01_util.js');
const boot = [
    '/* ============================================================',
    ' * bootstrap.js — JIZURA 引擎装配（唯一决定加载顺序的地方）',
    ' *',
    ' * ★ 顺序 = 上游 build.py 的 sorted(glob(src/*.js))，不能改。三处加载期副作用',
    ' *   依赖它（方案 §5）：',
    ' *   ① 08_planner.js 的 J.CORE_ORDER 是**加载期快照**，必须在所有 pack 注册之前；',
    ' *   ② 11q_sets.js 遍历全部 group/order 打 extra/wa/set 标记，必须在所有 pack 之后；',
    ' *   ③ 08b_omakase.js 给核心 def 追加 mood tags，依赖 06/05/07 已注册。',
    ' * ★ 引擎实例必须**进程内单例**：② ③ 是"只跑一次"的副作用，重复实例化会让',
    ' *   部件集/随机候选漂移。',
    ' * ============================================================ */',
    `import { createJizuraRoot } from './${root}';`,
    ...others.map((f) => `import ${idOf(f)} from './${f}';`),
    '',
    "export const JIZURA_ENGINE_VERSION = '0.10.1-port';",
    '',
    '/** 建一个 JIZURA 引擎（拿到 J 即可 J.plan / new J.Renderer() / J.omakase …） */',
    'export function createJizuraEngine() {',
    '    const J = createJizuraRoot();',
    ...others.map((f) => `    ${idOf(f)}(J);`),
    '    return J;',
    '}',
    '',
].join('\n');
fs.writeFileSync(path.join(OUT, 'bootstrap.js'), boot, 'utf8');

/* ---------------- 报告 ---------------- */
console.log(`搬运 ${files.length} 个文件 → ${OUT}`);
const offenders = rows.filter((r) => r.diff !== r.expect);
const declared = rows.filter((r) => r.diff > 0);
console.log(`差异行数：${rows.length - declared.length} 个文件 0 差异；${declared.length} 个文件有**已声明**的差异`);
for (const r of declared) console.log(`  · ${r.f}  ${r.diff} 行（${r.reasons.join(' + ')}）`);
if (offenders.length) {
    console.log('⚠ 与声明不符：');
    for (const r of offenders) console.log(`  · ${r.f}  实测 ${r.diff} 行 / 声明 ${r.expect} 行`);
}
if (problems.length) { console.log('⚠ 问题：'); for (const p of problems) console.log('  · ' + p); }
console.log(`bootstrap.js：${1 + others.length} 个 import（1 个 root + ${others.length} 个 install）`);
console.log(`总行数：${rows.reduce((s, r) => s + r.lines, 0)}`);
