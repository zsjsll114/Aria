#!/usr/bin/env node
/*
 * 测试登记门禁：仓库里每一个测试文件都必须真的在 CI 里跑到。
 *
 * 为什么需要：本仓库的 CI 是「一行行手抄测试文件」的形态，于是出现过 15 个
 * 写完就再没跑过的测试（含 49 条断言的工具栏 E2E、33 条的手机遥控 E2E、
 * 后端缓存锁/登录判据单测）。它们全绿过一次，然后长期沉默——绿色 CI 给人
 * 「都覆盖了」的错觉，比没有测试更糟。JS 侧已改成跑整个 glob，Python 侧文件名
 * 必须逐条列出（unittest 模块名/playwright 脚本各有前置差异），所以用手抄名单
 * + 本门禁：漏登记当场变红，而不是等下次人肉发现。
 *
 * 用法：node scripts/audits/test-registry.mjs [--check]
 *   不带 --check 只报告；带 --check 时任何未登记文件都 exit 1。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CI_FILE = '.github/workflows/ci.yml';
const JS_DIR = 'tests/js';
const PY_DIR = 'tests/python';
const E2E_DIR = 'tests';

/* 明确不进 CI 的文件：必须写理由，理由过期就删掉这条（不是长期豁免通道）。 */
export const EXEMPT = {
    // 素材在 .gitignore 的 local_music/ 里（真逐字 .elrc + flac），CI 上永远 SKIP
    'tests/test_word_align_accuracy.py': '需要 gitignore 的本地音频素材，CI 永远 SKIP',
    /* 2026-09-27：另一位会话正在改这份（本机实测 19/20，gutter-is-what-holds-alignment 还红着）。
       登记进 CI 会立刻把主干弄红，所以先豁免；它转绿之后必须补进 ci.yml 并删掉这条。
       这条豁免就是门禁的意义所在——它不会自己消失，下次跑门禁就会一直提醒。 */
    'tests/test_oobe_settings_polish.py': '会话在改，当前 19/20 有 1 条红；转绿后必须登记进 ci.yml',
};

function listFiles(dir, filter) {
    return readdirSync(path.join(ROOT, dir))
        .filter((n) => filter.test(n))
        .sort()
        .map((n) => `${dir}/${n}`);
}

/** 读真 ci.yml 并统一换行（自测注入「抽掉某一行」时要用同一份归一化，别抄第二遍） */
export function readCi() {
    return readFileSync(path.join(ROOT, CI_FILE), 'utf8').replace(/\r\n/g, '\n');
}

/** @param {string} [ciTextOverride] 喂一份假 ci.yml 文本（门禁自测用，见 tests/js/test_test_registry.js） */
export function scan(ciTextOverride) {
    /* 统一换行：仓库里的 ci.yml 是 CRLF，不归一化就没法用带 \n 的正则做「抽掉某一行」
       这类注入测试（实测会静默匹配不上，让自测变成假绿）。 */
    const ci = (ciTextOverride ?? readCi()).replace(/\r\n/g, '\n');
    const files = [
        ...listFiles(JS_DIR, /^test_.*\.js$/),
        ...listFiles(PY_DIR, /^test_.*\.py$/),
        ...listFiles(E2E_DIR, /^test_.*\.py$/),
    ];

    /* JS 侧允许「跑整个 glob」这一种覆盖方式：一行顶所有文件，新增自动进门禁。 */
    const jsGlob = /node --test tests\/js\/test_\*\.js/.test(ci);

    const missing = [];
    for (const file of files) {
        if (EXEMPT[file]) continue;
        if (file.startsWith(JS_DIR) && jsGlob) continue;
        const needle = file.startsWith(PY_DIR)
            ? `tests.python.${path.basename(file, '.py')}`
            : file.replace(/\\/g, '/');
        if (!ci.includes(needle)) missing.push(file);
    }

    /* 反向也查：名单里点了却不存在的文件（改名/删除后留下的空转行会让 CI 红在
       一个和改动无关的地方，排查成本比这条断言高得多）。 */
    const stale = [];
    for (const m of ci.matchAll(/(?:node --test |python )(tests\/[A-Za-z0-9_./-]*\.(?:js|py))/g)) {
        if (m[1].includes('*')) continue;
        if (!existsSync(path.join(ROOT, m[1]))) stale.push(m[1]);
    }
    for (const m of ci.matchAll(/python -m unittest (tests\.python\.[a-zA-Z0-9_]+)/g)) {
        const p = path.join(ROOT, ...m[1].split('.')) + '.py';
        if (!existsSync(p)) stale.push(m[1]);
    }
    /* 豁免表也可能过期：文件被删了还留着条目，等于凭空少查一个「未来的同名新测试」。 */
    for (const file of Object.keys(EXEMPT)) {
        if (!existsSync(path.join(ROOT, file))) stale.push(`${file}（豁免表条目）`);
    }

    return { total: files.length, missing, stale, exempt: Object.keys(EXEMPT) };
}

export function report(ciTextOverride) {
    const r = scan(ciTextOverride);
    const lines = [];
    lines.push(`测试文件 ${r.total} 个 / 未登记 ${r.missing.length} 个 / 空转 ${r.stale.length} 个 / 豁免 ${r.exempt.length} 个`);
    for (const f of r.missing) lines.push(`  ✗ 未登记: ${f}`);
    for (const f of r.stale) lines.push(`  ✗ ci.yml 里点了但不存在: ${f}`);
    for (const f of r.exempt) lines.push(`  · 豁免: ${f} —— ${EXEMPT[f]}`);
    return { ...r, text: lines.join('\n'), ok: r.missing.length === 0 && r.stale.length === 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
    const r = report();
    console.log(r.text);
    if (!r.ok && process.argv.includes('--check')) {
        console.error('存在未登记/空转的测试文件（见上）');
        process.exit(1);
    }
}
