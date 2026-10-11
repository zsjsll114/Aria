#!/usr/bin/env node
/* ============================================================
 * scripts/audits/localhost-origin.mjs — 页面 URL 必须 localhost 门禁
 *
 * 动机（AGENTS.md「关键约定」）：
 *   AI 走 Gemini 反代 Worker（docs/cf-gemini-auth-worker.js），它按 ALLOWED_ORIGINS
 *   校验浏览器 Origin，线上只放行 http://localhost:8001。窗口/页面 URL 一旦被「优化」成
 *   http://127.0.0.1:8001，Origin 随之改变 → 403 Forbidden: origin not allowed，
 *   **AI 功能整体失效**。这类「优化」正是 AI 最容易做出来的改动，所以必须门禁化。
 *
 * 只查「加载页面的 URL」这两处落点（native_audio.rs 里的 127.0.0.1 是后端 API 地址的
 * 单元测试，不走浏览器 Origin 校验，合法，不在此列）：
 *   ① src-tauri/tauri.conf.json 的 app.windows[].url
 *   ② src-tauri/src/lib.rs 里 tauri::Url::parse("...") 的字面量
 *   注：tauri.conf.json 的 security.capabilities[].remote.urls 白名单同时放行两者，合法。
 *
 * 用法：node scripts/audits/localhost-origin.mjs [--check]
 *   不带 --check 只报告；带 --check 时有违规 exit 1。
 * ============================================================ */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TAURI_CONF = 'src-tauri/tauri.conf.json';
const LIB_RS = 'src-tauri/src/lib.rs';

/* 只认「主机真的是 127.0.0.1」的形态：//127.0.0.1 后紧跟 :端口 或 / 或结尾。 */
const LOOPBACK_RE = /\/\/127\.0\.0\.1(?=[:/]|$)/;

/**
 * @param {{ tauriConf?: string|object, libRs?: string }} [override]
 *   tauriConf 为 JSON 文本或已解析对象；libRs 为 Rust 源码文本。
 *   两者缺省时读真实文件（CLI 路径）；自测注入假数据走这里。
 */
export function scan(override = {}) {
    const violations = [];

    let conf = override.tauriConf;
    if (conf == null) conf = readFileSync(path.join(ROOT, TAURI_CONF), 'utf8');
    if (typeof conf === 'string') {
        try {
            conf = JSON.parse(conf);
        } catch (e) {
            return { ok: false, violations: [], error: `${TAURI_CONF} 不是合法 JSON: ${e.message}` };
        }
    }
    const windows = (conf && conf.app && conf.app.windows) || [];
    for (const w of windows) {
        const url = w && w.url;
        if (typeof url === 'string' && LOOPBACK_RE.test(url)) {
            violations.push(`${TAURI_CONF} windows[${w.label || w.title || '?'}].url = "${url}" 用了 127.0.0.1`);
        }
    }

    const rs = override.libRs ?? readFileSync(path.join(ROOT, LIB_RS), 'utf8');
    for (const m of rs.matchAll(/(?:tauri::)?Url::parse\(\s*"([^"]+)"\s*\)/g)) {
        if (LOOPBACK_RE.test(m[1])) {
            violations.push(`${LIB_RS} Url::parse("${m[1]}") 用了 127.0.0.1`);
        }
    }

    return { ok: violations.length === 0, violations };
}

export function report(override) {
    const r = scan(override);
    const lines = [];
    if (r.error) {
        lines.push(`✗ ${r.error}`);
    } else {
        lines.push(`页面 URL 落点检查：违规 ${r.violations.length} 处`);
        for (const v of r.violations) {
            lines.push(`  ✗ ${v} —— 必须改回 http://localhost:8001（否则 AI 反代 403，AI 全废）`);
        }
    }
    return { ...r, text: lines.join('\n') };
}

/* 仅在被直接执行时跑 CLI（被 import 时沉默，供自测使用）。 */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
    const r = report();
    console.log(r.text);
    if (!r.ok && process.argv.includes('--check')) {
        console.error('存在把页面 URL 写成 127.0.0.1 的位置（见上）');
        process.exit(1);
    }
}
