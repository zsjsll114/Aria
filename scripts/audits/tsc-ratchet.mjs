#!/usr/bin/env node
/* ============================================================
 * scripts/audits/tsc-ratchet.mjs — TypeScript 类型检查棘轮
 *
 * 动机：仓库写了 100+ 文件、129+ 处 JSDoc 类型注释（@param/@returns/@typedef），
 *   却没有任何工具消费它们（无 tsconfig/tsc/flow）——注释不产生约束，等于白写。
 *   本门禁让 tsc 真正跑起来（noEmit，不产出、不改「源码即运行时」的哲学），
 *   并用**棘轮**兜住：类型错误数只降不升。
 *
 * 为什么是棘轮而不是「必须 0 错误」：一次性把 tsc 铺到整个 web/src 会立刻产出
 *   1000+ 条噪音（实测 core 顶层就有 1090 条，其中 516 条是缺全局声明的配置级报错）。
 *   噪音规则等于没有规则，最后会被整体关掉。所以从最干净的一小块
 *   （web/src/infrastructure/，当前 0 错误）起步，新代码不许让错误数上升；
 *   扩大 include 范围时用 --update 抬高基线，之后只能往下走。
 *   扩大范围的路线见 docs/typescript-类型化路线.md。
 *
 * 用法：node scripts/audits/tsc-ratchet.mjs [--check|--update]
 *   默认只报告；--check 当前 > 基线则 exit 1；--update 用当前值重写基线（需人工确认）。
 * ============================================================ */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const BASELINE_FILE = 'scripts/audits/tsc-baseline.json';

/** 从 tsc 输出里数错误条数（`path(line,col): error TSxxxx: ...`）。 */
export function parseErrorCount(output) {
    return (String(output).match(/error TS\d+/g) || []).length;
}

/** 棘轮判定：当前错误数不得超过基线。 */
export function evaluate({ count, limit }) {
    return { count, limit, ok: count <= limit };
}

function runTsc() {
    /* 用 execSync（字符串命令）而不是 spawnSync+shell:true —— 后者在 Windows 上会触发
       DEP0190 弃用警告（args 不经转义直接拼接）。tsc 有错误时以非零码退出，输出在异常里。 */
    try {
        return execSync('npx tsc --noEmit --pretty false', {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            maxBuffer: 64 * 1024 * 1024,
        });
    } catch (e) {
        return `${e.stdout || ''}${e.stderr || ''}`;
    }
}

export function readBaseline() {
    return JSON.parse(readFileSync(path.join(ROOT, BASELINE_FILE), 'utf8'));
}

/**
 * @param {{ output?: string, baseline?: { errors: number } }} [override]
 *   output 为 tsc 的原始输出（自测注入假输出，避免真跑）；缺省时真跑 tsc。
 */
export function scan(override = {}) {
    const output = override.output ?? runTsc();
    const baseline = override.baseline ?? readBaseline();
    const count = parseErrorCount(output);
    return { ...evaluate({ count, limit: baseline.errors }), output };
}

export function report(override) {
    const r = scan(override);
    const lines = [`tsc 类型错误 ${r.count} 条 / 基线 ${r.limit} 条 —— ${r.ok ? 'OK' : '超出棘轮'}`];
    if (!r.ok) {
        const first = String(r.output).split('\n').filter((l) => l.includes('error TS')).slice(0, 10);
        for (const l of first) lines.push(`  ✗ ${l.trim()}`);
        lines.push('  （新增的类型错误必须修掉；确属无法修的老问题请收敛 include 范围或--update 抬高基线）');
    }
    return { ...r, text: lines.join('\n') };
}

/** 用当前 tsc 错误数重写基线（人工确认后使用）。 */
export function updateBaseline() {
    const count = parseErrorCount(runTsc());
    const next = { ...readBaseline(), errors: count, updatedAt: new Date().toISOString().slice(0, 10) };
    writeFileSync(path.join(ROOT, BASELINE_FILE), `${JSON.stringify(next, null, 4)}\n`, 'utf8');
    return next;
}

/* 仅在被直接执行时跑 CLI（被 import 时沉默，供自测使用）。 */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
    if (process.argv.includes('--update')) {
        const b = updateBaseline();
        console.log(`基线已更新：errors=${b.errors}（${b.updatedAt}）`);
    } else {
        const r = report();
        console.log(r.text);
        if (!r.ok && process.argv.includes('--check')) {
            console.error('类型错误数超过棘轮基线（见上）');
            process.exit(1);
        }
    }
}
