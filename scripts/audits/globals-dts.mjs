#!/usr/bin/env node
/* ============================================================
 * scripts/audits/globals-dts.mjs — 全局键类型声明（globals.d.ts）的生成与同步门禁
 *
 * 背景：项目沿用「globalThis.x 建立状态、裸标识符跨分片读写」的浏览器全局协议，
 *   TypeScript 不认识这些自定义键 —— core 层一纳入 tsc 就一片 TS2339「属性不存在」。
 *   解法是把这份清单声明给 tsc，让它只看真问题。
 *
 * ★ 清单唯一事实源 = eslint.config.mjs 的 PROJECT_GLOBAL_KEYS（no-undef 用的同一份）。
 *   本脚本从它生成 web/src/types/globals.d.ts，**不手抄第二份清单**；
 *   --check 断言生成物与源同步（CI 里跑）——改了 eslint 清单却没重新生成就红。
 *
 * 生成物是【纯类型声明 .d.ts】：不被任何页面加载、无 import 引用，对运行时零影响。
 *
 * 用法：node scripts/audits/globals-dts.mjs [--write|--check]
 *   默认只报告；--write 生成/覆盖 globals.d.ts；--check 不同步则 exit 1。
 * ============================================================ */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ESLINT_CONF = 'eslint.config.mjs';
const OUT_FILE = 'web/src/types/globals.d.ts';

/** 从 eslint.config.mjs 源码里提取 PROJECT_GLOBAL_KEYS（去重、保持顺序）。找不到返回 null。 */
export function extractProjectGlobalKeys(src) {
    const text = src ?? readFileSync(path.join(ROOT, ESLINT_CONF), 'utf8');
    const m = text.match(/const PROJECT_GLOBAL_KEYS = \[([\s\S]*?)\n\];/);
    if (!m) return null;
    return [...new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]))];
}

const HEADER = `/* ============================================================
 * types/globals.d.ts — 项目自有全局键的类型声明（仅供 tsc，不进运行时）
 *
 * ★ 本文件是【生成物】，请勿手改。
 *   清单唯一事实源 = eslint.config.mjs 的 PROJECT_GLOBAL_KEYS。
 *   改完清单后跑：node scripts/audits/globals-dts.mjs --write
 *   同步门禁（CI 里跑）：node scripts/audits/globals-dts.mjs --check
 *
 * 为什么需要它：项目沿用「globalThis.x 建立状态、裸标识符跨分片读写」的浏览器全局
 * 协议，TypeScript 不认识这些自定义键 → core 层一纳入 tsc 就一片 TS2339
 * 「属性不存在」。本文件把清单声明出来，让 tsc 只看真正的类型问题。
 *
 * 它不被任何页面加载（web/index.html 无引用、无 import），对运行时零影响。
 * ============================================================ */

/* ---- 裸标识符 / globalThis.xxx 形态（declare var 一次覆盖） ---- */
`;

/** 生成 globals.d.ts 全文。 */
export function render(keys) {
    const varLines = keys.map((k) => `declare var ${k}: any;`).join('\n');
    const winLines = keys.map((k) => `    ${k}: any;`).join('\n');
    return `${HEADER}${varLines}

/* ---- window.* 挂载形态（并入 Window 接口，覆盖 \`window.x\`） ---- */
interface Window {
${winLines}
}
`;
}

/**
 * @param {{ eslintSrc?: string, dtsText?: string }} [override]
 *   eslintSrc 注入假 eslint 源码；dtsText 注入假生成物文本（自测用）。
 *   缺省时读真实文件。
 */
export function scan(override = {}) {
    const keys = extractProjectGlobalKeys(override.eslintSrc);
    if (!keys) return { ok: false, error: `未在 ${ESLINT_CONF} 找到 PROJECT_GLOBAL_KEYS 数组` };
    const expected = render(keys);
    let actual = override.dtsText;
    if (actual === undefined) {
        try {
            actual = readFileSync(path.join(ROOT, OUT_FILE), 'utf8');
        } catch { actual = null; /* 尚未生成 */ }
    }
    return { ok: actual === expected, count: keys.length, expected, actual };
}

export function report(override) {
    const r = scan(override);
    const lines = [];
    if (r.error) lines.push(`✗ ${r.error}`);
    else if (r.ok) lines.push(`globals.d.ts 与 PROJECT_GLOBAL_KEYS 同步（${r.count} 键）`);
    else lines.push(`✗ ${OUT_FILE} 与 eslint.config.mjs 的 PROJECT_GLOBAL_KEYS 不同步（源 ${r.count} 键）—— 跑 --write 重新生成`);
    return { ...r, text: lines.join('\n') };
}

/** 依据当前清单重写 globals.d.ts（父目录不存在时自动创建）。 */
export function write() {
    const keys = extractProjectGlobalKeys();
    if (!keys) throw new Error(`未在 ${ESLINT_CONF} 找到 PROJECT_GLOBAL_KEYS 数组`);
    const outPath = path.join(ROOT, OUT_FILE);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, render(keys), 'utf8');
    return keys.length;
}

/* 仅在被直接执行时跑 CLI（被 import 时沉默，供自测使用）。 */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
    if (process.argv.includes('--write')) {
        console.log(`已生成 ${OUT_FILE}（${write()} 键）`);
    } else {
        const r = report();
        console.log(r.text);
        if (!r.ok && process.argv.includes('--check')) process.exit(1);
    }
}
