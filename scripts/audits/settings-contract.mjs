#!/usr/bin/env node
/* ============================================================
 * scripts/audits/settings-contract.mjs — 配置键契约门禁
 *
 * 动机（AGENTS.md 约束 11）：
 *   loadSettings()（web/src/app/180-boot-config.js）是**按固定键白名单整体重建**
 *   appSettings，而不是 { ...DEFAULT_SETTINGS, ...saved } 的通用合并 —— 因为它带着
 *   音量取整、ai providerConfigs 合并、modeSettings fontSize 迁移等特殊逻辑，不能简单替换。
 *   代价是：「往 DEFAULT_SETTINGS 加顶层新键、却忘了在重建块补一行」时，只要有存档，
 *   该键就被整体丢弃 → 持久化功能**不报错但永远失效**。仓库已踩过（backup 键即活标本），
 *   历史上全靠人肉发现。本门禁把它变成「跑 CI 就红」。
 *
 * 判定：DEFAULT_SETTINGS 的每个顶层键，必须在 180 的重建块里以属性定义形式出现。
 *   用「锚点行缩进 + 4」定位顶层键缩进，故嵌套里的同名属性不会被误当顶层键。
 *
 * 已知局限：若某顶层键只在重建块的**嵌套**里出现同名属性，会假通过。DEFAULT_SETTINGS
 *   的顶层键名（playback/lyrics/background/...）极少作为嵌套属性名出现，风险可接受。
 *
 * 用法：node scripts/audits/settings-contract.mjs [--check]
 *   不带 --check 只报告；带 --check 时缺键 exit 1。
 * ============================================================ */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const REBUILD_FILE = 'web/src/app/180-boot-config.js';
const DEFAULTS_FILE = 'web/src/config/defaults.js';

/* 从 src[openIdx] 的 '{' 起做括号配对，跳过字符串/模板/注释，返回含首尾花括号的完整文本。
 * 不跳过字符串的话，重建块里的 'openai' 之类字面量不会出问题，但注释/模板里若含花括号
 * 就会把配对带偏 —— 宁可多写十行也不赌。 */
function sliceBalanced(src, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < src.length; i++) {
        const c = src[i];
        if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
        if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
        if (c === "'" || c === '"' || c === '`') {
            const q = c;
            i++;
            while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
            continue;
        }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return src.slice(openIdx, i + 1); }
    }
    return null;
}

/** 抽取 loadSettings 里 `appSettings = { ... }` 重建块的顶层键集合；找不到重建块返回 null。 */
export function extractRebuildKeys(src) {
    const anchor = src.search(/appSettings\s*=\s*\{/);
    if (anchor < 0) return null;
    const lineStart = src.lastIndexOf('\n', anchor) + 1;
    const baseIndent = anchor - lineStart;
    const braceIdx = src.indexOf('{', anchor);
    const body = sliceBalanced(src, braceIdx);
    if (!body) return null;
    const keyIndent = baseIndent + 4;
    /* 顶层键 = 恰好 keyIndent 个空格缩进 + 键名 + 冒号。缩进锚定其所在行，
       故 `saved.sleepTimer`（前面是点/空白但不是行首缩进定义）不会被误算。 */
    const re = new RegExp(`^ {${keyIndent}}(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\\w$]*))\\s*:`, 'gm');
    const keys = new Set();
    for (const m of body.matchAll(re)) keys.add(m[1] || m[2] || m[3]);
    return keys;
}

/**
 * @param {{ defaultsKeys?: string[], rebuildText?: string }} [override]
 *   defaultsKeys 为 DEFAULT_SETTINGS 顶层键列表；rebuildText 为 180 的源码文本。
 *   两者缺省时读真实文件（CLI 路径）；自测注入假数据走这里。
 */
export function scan(override = {}) {
    const text = override.rebuildText ?? readFileSync(path.join(ROOT, REBUILD_FILE), 'utf8');
    const rebuildKeys = extractRebuildKeys(text);
    if (!rebuildKeys) {
        return { ok: false, missing: [], error: `未在 ${REBUILD_FILE} 找到 appSettings = { ... } 重建块（结构变了？）` };
    }
    if (!override.defaultsKeys) {
        return { ok: false, missing: [], error: '未提供 defaultsKeys（CLI 会动态 import defaults.js；自测请注入）' };
    }
    const missing = override.defaultsKeys.filter((k) => !rebuildKeys.has(k));
    return { ok: missing.length === 0, missing, total: override.defaultsKeys.length, found: rebuildKeys.size };
}

export function report(override) {
    const r = scan(override);
    const lines = [];
    if (r.error) {
        lines.push(`✗ ${r.error}`);
    } else {
        lines.push(`DEFAULT_SETTINGS 顶层键 ${r.total} 个 / 重建块补齐 ${r.found} 个 / 缺 ${r.missing.length} 个`);
        for (const k of r.missing) {
            lines.push(`  ✗ 缺键: ${k} —— 重启后会被静默丢弃（不报错、持久化失效）`);
        }
    }
    return { ...r, text: lines.join('\n') };
}

/* 仅在被直接执行时跑 CLI（被 import 时沉默，供自测使用）。 */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
    const { DEFAULT_SETTINGS } = await import(pathToFileURL(path.join(ROOT, DEFAULTS_FILE)).href);
    const r = report({ defaultsKeys: Object.keys(DEFAULT_SETTINGS) });
    console.log(r.text);
    if (!r.ok && process.argv.includes('--check')) {
        console.error('DEFAULT_SETTINGS 有顶层键未在 loadSettings 重建块中补齐（见上）');
        process.exit(1);
    }
}
