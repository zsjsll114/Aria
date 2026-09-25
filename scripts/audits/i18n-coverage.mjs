/* ============================================================
 * scripts/audits/i18n-coverage.mjs — 中文 UI 文本登记覆盖复扫（AGENTS 约束 7 的门禁）
 *
 * 为什么需要它：约束 7 要求「新增任何中文 UI 文本必须同时登记进
 * web/src/core/i18n.js 的 STATIC_PHRASE_MAP」。这条约定此前只靠人肉记得，
 * 结果 284-diagnostics 自建了一张私有 PHRASE_EN 表绕开全库词表，
 * 一次性漏登记 189 条（2026-09-25 实测）。没有复扫手段的约定等于没有。
 *
 * 用法：
 *   node scripts/audits/i18n-coverage.mjs            只出报告，恒退出 0
 *   node scripts/audits/i18n-coverage.mjs --check    棘轮门禁：出现基线外的新未登记项则退出 1
 *   node scripts/audits/i18n-coverage.mjs --all      打印全部明细（默认每类截断 40 行）
 *   node scripts/audits/i18n-coverage.mjs --json     机器可读输出（测试用）
 *
 * ── 怎么取「中文串」─────────────────────────────────────────────
 * 手写一遍小型词法器：先剥注释（行/块），再取**单行**字符串字面量；模板字符串
 * 把 `${expr}` 折成 `{}` 占位（整条落进「动态句」桶，不算失败），同时递归吃进
 * `${expr}` 里的普通字面量。跨行未闭合的字面量在 JS 里本就是语法错误，直接丢掉
 * —— scratch/i18n_gap.mjs 的 bug 正是只用 `'([^'\\]*[一-鿿][^'\\]*)'` 全文匹配，
 * 把 `);\n }, delay);` 这种代码片段当成了中文串。
 * 含标签的字面量按标签切成文本段：innerHTML 模板里 `<div class="k">状态</div>`
 * 真正会作为 DOM 文本节点被 STATIC_PHRASE_MAP 命中的是「状态」，不是整坨 HTML。
 *
 * ── 怎么判「UI 可见」───────────────────────────────────────────
 * 按所在行 + 邻接结构归类，三类：
 *   log  整行是 logInfo/logWarn/logError/logCatch/console.*：约束 9 允许中文正文 → 不算漏
 *   ui   ① 行里有 UI 出口（textContent/innerHTML/title/data-tooltip/aria-label/
 *           placeholder/setHint/showToast/to(/tx(/translatePhrase( 等），
 *        ② 或它是「中文 : 英文」词表项 / ['中文','英文'] 双语对的第一项 —— 这两条
 *           是结构判定，284 的 PHRASE_EN 与 280/282 的 STR 就是这么写的，光看行文本抓不到
 *   rest 都不满足 → 单独列出给人复核，不进棘轮（避免把比较用的常量、正则素材算成 UI）
 *
 * ── 棘轮，不是「只卡新分片」────────────────────────────────────
 * 只卡新分片挡不住「在旧分片里加中文 UI」这种最常见的改法，而且新分片名单本身要人
 * 维护、迟早过期。所以按 **文件 × 串** 冻结存量：新增一条立刻红；修掉一条就把它从
 * BASELINE 删掉（脚本会打印「可从基线删除」清单）。比只比总数严——纯计数会允许
 * 「修一条 + 加一条」蒙混过关。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHECK = process.argv.includes('--check');
const JSON_OUT = process.argv.includes('--json');
const SHOW_ALL = process.argv.includes('--all');
const LIMIT = SHOW_ALL ? Infinity : 40;

/** 扫描范围：前端源码全库。词表本体除外——它自己就是登记处；
 *  vendor/ 是第三方打包产物（segmentit 2.8MB 单行压缩），既不是本项目文案，
 *  拿逐行正则去磨它还会把复扫拖成分钟级（实测卡在这里）。 */
const SCAN_ROOT = 'web/src';
const SELF = 'web/src/core/i18n.js';
const SKIP_DIRS = new Set(['vendor', 'node_modules', 'font', 'img']);
/** 超过这个长度的行按压缩产物处理：不做行级归类（一条 500KB 的行 × 几千个字面量
 *  会让正则退化成 O(n²)），直接落进 rest 桶给人复核。 */
const MAX_LINE_LEN = 600;

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
/** 带 {占位符} 的动态句：STATIC_PHRASE_MAP 是整句精确匹配，命中不了，另列不算失败 */
const PLACEHOLDER = /\{[^{}]*\}/;
const MIN_LEN = 2;
const MAX_LEN = 140;

const LOG_LINE = /(^|[^\w$.])(logInfo|logWarn|logError|logCatch|logDebug|console\s*\.\s*(log|info|warn|error|debug|trace))\s*\(/;
const UI_LINE = new RegExp([
    '\\.\\s*(textContent|innerHTML|outerHTML|innerText|title)\\s*=',
    'insertAdjacentHTML\\s*\\(',
    /* 局部 HTML 累加器：`let html = ''` + 一堆 `html += '<div>中文</div>'`，
       最后才 `body.innerHTML = html`。只看 innerHTML 那一行的话这类分片（275 就是）
       会整片漏判成「非 UI」。 */
    '\\bhtml\\s*\\+=\\s*[\'"`]', '\\bhtml\\s*=\\s*[\'"`]',
    '\\b(textContent|innerHTML|innerText|title|label|labelEn|labelZh|group|groupEn|text|textEn|desc|description|hint|hintEn|message|tooltip|placeholder|alt|tip|subtitle|summary|name|titleZh|labelOn|labelOff)\\s*:',
    'setAttribute\\s*\\(\\s*[\'"](?:title|data-tooltip|aria-label|placeholder|alt)[\'"]',
    '\\bdata-tooltip\\b', '\\baria-label\\b', '\\bplaceholder\\s*=',
    '\\b(setHint|showHint|showToast|toast|notify|alert|confirm|showOsd)\\s*\\(',
    '\\b(tx|translatePhrase)\\s*\\(',
    '\\bPHRASE_EN\\b', '\\bSTR\\.[A-Za-z_$]',
].join('|'));
/* 明显是代码而不是文案的东西。
   ⚠ 不要往这里加 `[{}]` —— 带花括号的是「{占位符}动态句」，必须先于本判定分流到
   dynamic 桶（第一版把顺序写反了，结果 280/282 的动态句整批消失、被算成零缺口）。 */
const CODEISH = [/=>/, /\bfunction\b/, /\bdocument\./, /\bquerySelector\b/, /^\s*[\w$.[\]-]+\s*=\s*$/, /['"]/, /<\/?[a-zA-Z]/];

/* ================= 词法扫描 ================= */

function isRegexAllowed(prev) {
    if (prev === '') return true;
    return '(,=:[!&|?{};+-*%~^<>'.indexOf(prev) >= 0;
}

/** 从 i 处的 `/` 试着吃掉一个正则字面量；不像正则就返回 -1 */
function eatRegex(src, i) {
    let j = i + 1, inClass = false;
    for (; j < src.length; j++) {
        const c = src[j];
        if (c === '\n') return -1;
        if (c === '\\') { j++; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
    }
    if (j >= src.length) return -1;
    while (j + 1 < src.length && /[a-z]/.test(src[j + 1])) j++;
    return j;
}

function unescapeLit(v) {
    return v
        .replace(/\\u\{?([0-9a-fA-F]{2,6})\}?/g, (all, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/\\([nrtvf])/g, (all, k) => (k === 'n' || k === 'r' ? ' ' : k === 't' ? ' ' : k))
        .replace(/\\(['"`\\])/g, '$1');
}

/**
 * 扫出所有字面量：[{ text, start, end, line, tpl }]
 *  - 普通引号串：text = 内容，tpl = false
 *  - 模板串：整条静态文本（`${}` 折成 `{}`）算一个条目，tpl = 是否含插值；
 *            插值表达式里的普通字面量另外递归收进来
 */
function scanLiterals(src) {
    const out = [];
    const n = src.length;
    /** 行首偏移表，用来把绝对 offset 换成行号 */
    const lineStarts = [0];
    for (let k = 0; k < n; k++) if (src[k] === '\n') lineStarts.push(k + 1);
    const lineOf = (pos) => {
        let lo = 0, hi = lineStarts.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; }
        return lo + 1;
    };

    /** 引号串：返回 [内容, 闭合引号下标]；本行内没闭合返回 null */
    function readQuoted(start, q) {
        let j = start + 1, v = '';
        for (; j < n; j++) {
            const c = src[j];
            if (c === '\\') { v += src.slice(j, j + 2); j += 2; continue; }
            if (c === '\n') return null;
            if (c === q) return [v, j];
            v += c;
        }
        return null;
    }

    /** 模板串：返回 { items, end } ；不闭合返回 null */
    function readTemplate(start) {
        let j = start + 1, chunk = '', full = '', hadExpr = false;
        for (;;) {
            if (j >= n) return null;
            const c = src[j];
            if (c === '\\') { chunk += src.slice(j, j + 2); j += 2; continue; }
            if (c === '`') {
                /* 无插值的模板串就是普通字面量；有插值的整条算动态句 */
                const text = hadExpr ? full + chunk : chunk;
                if (text.trim()) out.push({ text: unescapeLit(text), start, end: j, tpl: hadExpr });
                return { end: j };
            }
            if (c === '$' && src[j + 1] === '{') {
                hadExpr = true;
                full += chunk + '{}';
                chunk = '';
                const close = matchBrace(j + 1);
                if (close < 0) return null;
                /* 递归吃插值表达式里的普通字面量（`…${tx('中文')}…` 也得进扫描面），
                   offset 折回全文件坐标，行号在最后统一按 lineOf 换算 */
                const exprStart = j + 2;
                for (const s of scanLiterals(src.slice(exprStart, close))) {
                    out.push({ text: s.text, start: exprStart + s.start, end: exprStart + s.end, tpl: s.tpl });
                }
                j = close + 1;
                continue;
            }
            chunk += c; j++;
        }
    }

    /** 从 i 处的 `{` 找到配对的 `}`（跳过字符串/模板/注释/嵌套块），返回 `}` 下标或 -1 */
    function matchBrace(i) {
        let depth = 0, k = i;
        for (; k < n; k++) {
            const c = src[k];
            if (c === '{') depth++;
            else if (c === '}') { depth--; if (depth === 0) return k; }
            else if (c === '/' && (src[k + 1] === '/' || src[k + 1] === '*')) {
                if (src[k + 1] === '/') { const e = src.indexOf('\n', k); k = e < 0 ? n : e - 1; }
                else { const e = src.indexOf('*/', k + 2); k = e < 0 ? n : e + 1; }
            }
            else if (c === '"' || c === "'") { const q = readQuoted(k, c); if (q) k = q[1]; }
            else if (c === '`') { let m = k + 1; for (; m < n; m++) { if (src[m] === '\\') { m++; continue; } if (src[m] === '`') break; } k = m; }
        }
        return -1;
    }

    let i = 0, prev = '';
    while (i < n) {
        const c = src[i];
        if (c === '\n') { i++; continue; }
        if (c === '/') {
            const d = src[i + 1];
            if (d === '/') { const e = src.indexOf('\n', i); i = e < 0 ? n : e; continue; }
            if (d === '*') {
                let j = i + 2;
                while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
                i = Math.min(j + 2, n); prev = ' '; continue;
            }
            if (isRegexAllowed(prev)) {
                const end = eatRegex(src, i);
                if (end >= 0) { i = end + 1; prev = '/'; continue; }
            }
            prev = c; i++; continue;
        }
        if (c === '"' || c === "'") {
            const r = readQuoted(i, c);
            if (r) { out.push({ text: unescapeLit(r[0]), start: i, end: r[1], tpl: false }); prev = c; i = r[1] + 1; continue; }
            prev = c; i++; continue;         /* 撇号 / 跨行：跳过这个字符 */
        }
        if (c === '`') {
            const r = readTemplate(i);
            if (r) { prev = '`'; i = r.end + 1; continue; }
            prev = c; i++; continue;
        }
        if (!/\s/.test(c)) prev = c;
        i++;
    }
    for (const o of out) o.line = lineOf(o.start);
    return out;
}

/** 字面量 → 候选文案：含标签的按标签切成文本段 */
function candidatesOf(text) {
    if (text.indexOf('<') >= 0 && /<\/|[a-zA-Z][^>]*>/.test(text)) {
        return text.split(/<[^>]*>/).map(s => s.trim()).filter(Boolean);
    }
    return [text.trim()];
}

/** 结构判定：这条字面量是不是「中文 → 英文」词表项 / 双语对的第一项 */
function isPhrasePair(src, lit) {
    const after = src.slice(lit.end + 1, lit.end + 1 + 200);
    const before = src.slice(Math.max(0, lit.start - 4), lit.start);
    /* '中文': 'English'  /  '中文': "English" */
    if (/^\s*:/.test(after)) return isDisplayCopy(after.replace(/^\s*:\s*/, ''));
    /* ['中文', 'English'] */
    if (/[[,]\s*$/.test(before) && /^\s*,\s*(['"])/.test(after)) return isDisplayCopy(after.replace(/^\s*,\s*/, ''));
    return false;
}

/**
 * 值那侧「像不像给人看的文案」。
 * ★ 必须有这一道：TunnelDirector 里有 67 条 `'悲しみ': 'sorrow'` 形态的**情感词→分类**
 *   查表（决定隧道视觉选哪种构图），形状和「中文: 英文」词表项一模一样。只按形状判
 *   会把它们全算成未登记 UI 文本，门禁当场变成噪音机。
 *   判据取「像文案而不像标识符」：带空格/标点、或首字母大写。
 */
function isDisplayCopy(rest) {
    const m = /^(['"`])([\s\S]*?)\1/.exec(rest);
    if (!m) return false;                 /* 值是变量/函数调用：交给按行判定 */
    const val = m[2];
    if (!val || HAN.test(val)) return false;
    return /[\s,.:;!?—–·、（）()]/.test(val) || /^[A-Z]/.test(val);
}

/* ================= 基线（只减不增） ================= */
/* 存量记在 i18n-coverage.baseline.json 里，key = 相对路径 + '\u0000' + 中文串。
   为什么不「只卡新分片」：新分片名单要人维护、迟早过期，而且在旧分片里加中文 UI
   是最常见的改法，根本挡不住。修掉一条就重跑 `--write-baseline` 收缩基线。 */
const BASELINE_FILE = 'scripts/audits/i18n-coverage.baseline.json';
const WRITE_BASELINE = process.argv.includes('--write-baseline');

/* ================= 收集 ================= */
function walk(dir, out = []) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = dir + '/' + e.name;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(rel, out); }
        else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) out.push(rel);
    }
    return out;
}

/* 词表查询走 i18n.js 真身（避免自己再解析一遍词表，顺带验证导出函数没坏） */
const i18n = await import(pathToFileURL(path.join(ROOT, SELF)).href);
i18n.setLanguage('en-US');
const registered = (zh) => i18n.translatePhrase(zh) !== zh;
export { registered as isPhraseRegistered, scanLiterals, candidatesOf, isPhrasePair };

/**
 * 扫一批「相对路径 → 源码」。抽成函数是为了让 tests/js/test_i18n_coverage.js
 * 能喂合成片段（真库里既没有「已知未登记」也没有「已知该放过」的受控样本）。
 * @param {Iterable<[string, string]>} entries
 */
export function scanSources(entries) {
    /* ★ 词表查询只在英文模式下有意义（translatePhrase 非英文模式一律原样返回）。
       这里显式钉住，不靠 import 时那次 setLanguage —— 同进程里任何别处（比如单测）
       切回中文，就会让 registered() 对所有串返回 false，整份基线瞬间「全灭」。 */
    i18n.setLanguage('en-US');
    const unregistered = new Map();     /* phrase -> { files:Set, keys:Set } */
    const dynamicSentences = new Map();
    const restBucket = new Map();
    let registeredHits = 0;

    for (const [rel, src] of entries) {
        const lines = src.split(/\r?\n/);
        /* ★ 整页自译的面板（诊断页那类）：文件里出现 tx()/translatePhrase() 就说明它的
           中文串**全部**是准备过词表的（row('外壳') 这种标签在行文本上看不出一个 UI 出口，
           但渲染前都会过一遍查表）。这类文件里的中文串一律按 UI 算，否则「在自译面板里
           新加一条不登记的标签」正好是门禁最该拦的那件事，却会漏进 rest 桶。 */
        const selfTranslating = /\b(?:tx|translatePhrase)\s*\(/.test(src);
        /* 行级归类缓存：压缩产物一行能挂几千个字面量，同一行重复跑那条大交替正则
           会让复扫退化成 O(n²)（首轮实测直接卡在这里）。 */
        const rowClass = new Map();
        const classify = (ln) => {
            let hit = rowClass.get(ln);
            if (hit) return hit;
            const row = lines[ln - 1];
            if (!row || row.length > MAX_LINE_LEN) hit = { isLog: false, isUi: false };
            else {
                const isLog = LOG_LINE.test(row);
                hit = { isLog, isUi: !isLog && (selfTranslating || UI_LINE.test(row)) };
            }
            rowClass.set(ln, hit);
            return hit;
        };
        for (const lit of scanLiterals(src)) {
            const { isLog, isUi: uiByLine } = classify(lit.line);
            const isUi = uiByLine || (isLog ? false : isPhrasePair(src, lit));
            for (const cand of candidatesOf(lit.text)) {
                if (!cand || cand.length < MIN_LEN || cand.length > MAX_LEN) continue;
                if (!HAN.test(cand)) continue;
                /* 顺序：长度 → 中文 → 动态句 → 代码噪声 → 日志 → UI/存疑 */
                if (PLACEHOLDER.test(cand)) {
                    if (!isLog) {
                        if (!dynamicSentences.has(cand)) dynamicSentences.set(cand, new Set());
                        dynamicSentences.get(cand).add(rel);
                    }
                    continue;
                }
                if (CODEISH.some(re => re.test(cand))) continue;
                if (isLog) continue;                    /* 约束 9：日志正文允许中文 */
                if (!isUi) {
                    if (!restBucket.has(cand)) restBucket.set(cand, new Set());
                    restBucket.get(cand).add(rel);
                    continue;
                }
                if (registered(cand)) { registeredHits++; continue; }
                if (!unregistered.has(cand)) unregistered.set(cand, { files: new Set(), keys: new Set() });
                unregistered.get(cand).files.add(rel);
                unregistered.get(cand).keys.add(rel + '\u0000' + cand);
            }
        }
    }

    const allKeys = new Set();
    for (const v of unregistered.values()) for (const k of v.keys) allKeys.add(k);
    const asList = (map) => [...map].map(([p, v]) => ({
        phrase: p,
        files: v instanceof Set ? [...v] : [...v.files],
    })).sort((a, b) => a.files[0].localeCompare(b.files[0]) || a.phrase.localeCompare(b.phrase));
    return {
        unregistered, dynamicSentences, restBucket, registeredHits, allKeys,
        unregisteredList: asList(unregistered),
        dynamicList: asList(dynamicSentences),
        restList: asList(restBucket),
    };
}

/* ================= 命令行 ================= */
/* 被 tests/js/test_i18n_coverage.js import 时只暴露 scanSources/scanLiterals，
   不读盘、不打印、更不能 process.exit()。 */
const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
const files = walk(SCAN_ROOT).filter(f => f !== SELF);
const result = scanSources(files.map(f => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]));
const { unregistered, dynamicSentences, restBucket, registeredHits, allKeys,
    unregisteredList, dynamicList, restList } = result;

/* ================= 棘轮 ================= */
if (WRITE_BASELINE) {
    const body = {
        _note: 'i18n-coverage.mjs 的存量基线：' + allKeys.size + ' 处「文件 × 中文 UI 串」尚未登记进 '
            + 'web/src/core/i18n.js 的 STATIC_PHRASE_MAP。只减不增——登记掉一批之后重跑 '
            + '`node scripts/audits/i18n-coverage.mjs --write-baseline` 收缩。key = 相对路径 + U+0000 + 中文串。',
        _generated: new Date().toISOString().slice(0, 10),
        keys: [...allKeys].sort(),
    };
    fs.writeFileSync(path.join(ROOT, BASELINE_FILE), JSON.stringify(body, null, 1) + '\n', 'utf8');
    console.log(`基线已写入 ${BASELINE_FILE}：${allKeys.size} 处`);
    process.exit(0);
}

let BASELINE_KEYS = new Set();
try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, BASELINE_FILE), 'utf8'));
    BASELINE_KEYS = new Set(raw.keys || []);
} catch (_) {
    /* 走 stderr：--json 模式下 stdout 必须只有 JSON */
    console.error(`读不到基线 ${BASELINE_FILE}（${_.message}）；先跑 --write-baseline 生成，本轮按空基线处理。`);
}
const newKeys = [...allKeys].filter(k => !BASELINE_KEYS.has(k)).sort();
const stale = [...BASELINE_KEYS].filter(k => !allKeys.has(k)).sort();

const report = {
    files: files.length,
    registeredHits,
    unregisteredCount: unregistered.size,
    occurrenceCount: allKeys.size,
    baselineSize: BASELINE_KEYS.size,
    newCount: newKeys.length,
    staleCount: stale.length,
    unregistered: unregisteredList,
    dynamic: dynamicList,
    rest: restList,
    newKeys,
    stale,
};

if (JSON_OUT) {
    console.log(JSON.stringify(report));
} else {
    const byFile = new Map();
    for (const u of report.unregistered) for (const f of u.files) byFile.set(f, (byFile.get(f) || 0) + 1);
    const show = (arr, fmt) => {
        arr.slice(0, LIMIT).forEach((x, i) => console.log(`  ${i + 1}. ${fmt(x)}`));
        if (arr.length > LIMIT) console.log(`  … 另 ${arr.length - LIMIT} 条（--all 看全部）`);
    };
    console.log(`扫描 ${report.files} 个文件（${SCAN_ROOT}，词表本体除外）`);
    console.log(`UI 出口上已登记的中文串：${report.registeredHits} 处（命中即合格）`);
    console.log(`\n【未登记的中文 UI 文本】${report.unregisteredCount} 条 / ${report.occurrenceCount} 处  （基线 ${report.baselineSize} 处）`);
    show([...byFile].sort((a, b) => b[1] - a[1]), x => `${x[0]}: ${x[1]}`);
    show(report.unregistered, x => `${x.phrase}  ← ${x.files.join(', ')}`);
    console.log(`\n【带占位符的动态句】${report.dynamic.length} 条 —— 整句精确匹配命中不了，不算失败，但要人工过一遍`);
    show(report.dynamic, x => `${x.phrase}  ← ${x.files.join(', ')}`);
    console.log(`\n【判不出归类的中文串】${report.rest.length} 条 —— 既不像日志也不像 UI 出口，不进棘轮，靠 --all 复核`);
    show(report.rest, x => `${x.phrase}  ← ${x.files.join(', ')}`);
    if (newKeys.length) {
        console.log(`\n✗ 基线之外的新未登记项 ${newKeys.length} 处：`);
        for (const k of newKeys.slice(0, LIMIT)) console.log('  ' + k.replace('\u0000', '  '));
        if (newKeys.length > LIMIT) console.log(`  … 另 ${newKeys.length - LIMIT} 处`);
    }
    if (stale.length) {
        console.log(`\n✓ 已修好、应从 BASELINE 删除的 ${stale.length} 处：`);
        for (const k of stale.slice(0, LIMIT)) console.log('  ' + k.replace('\u0000', '  '));
        if (stale.length > LIMIT) console.log(`  … 另 ${stale.length - LIMIT} 处`);
    }
    console.log(`\n合计：未登记 ${report.occurrenceCount} 处 / 基线 ${report.baselineSize} 处，基线外新增 ${newKeys.length} 处。`);
}

if (CHECK && newKeys.length) {
    console.log('\ni18n 棘轮被突破：新增的中文 UI 文本必须登记进 ' + SELF + ' 的 STATIC_PHRASE_MAP（AGENTS 约束 7）。');
    process.exit(1);
}
}
