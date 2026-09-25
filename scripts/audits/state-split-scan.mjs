/* scratch/state_split_scan.mjs — 量化 state 单例 与 globalThis 裸协议 的分叉面 */
import fs from 'node:fs';
import path from 'node:path';

function walk(d, out = []) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'vendor') walk(p, out); }
        else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}
const files = walk('web/src');
const rel = (f) => f.replace(/^web[\\/]src[\\/]/, '');

const stateSrc = fs.readFileSync('web/src/infrastructure/state.js', 'utf8');
const stateKeys = (stateSrc.match(/^\s{4}([A-Za-z_]\w*)\s*:/gm) || []).map((s) => s.trim().split(':')[0]);

const gKeys = new Set();
for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    for (const m of t.matchAll(/registerGlobal\(\s*'([^']+)'/g)) gKeys.add(m[1]);
    for (const m of t.matchAll(/globalThis\.([A-Za-z_]\w*)\s*=/g)) gKeys.add(m[1]);
}

const overlap = stateKeys.filter((k) => gKeys.has(k));
console.log(`state.js 键 ${stateKeys.length} | globalThis 键 ${gKeys.size} | 重叠 ${overlap.length}`);

const rows = [];
for (const k of overlap) {
    const wState = [], wGlobal = [], rState = [], rBare = [];
    for (const f of files) {
        const t = fs.readFileSync(f, 'utf8');
        const n = (re) => (t.match(re) || []).length;
        const sW = n(new RegExp('state\\.' + k + '\\s*=[^=]', 'g'));
        const gW = n(new RegExp('globalThis\\.' + k + '\\s*=[^=]', 'g')) + n(new RegExp("assignGlobal\\(\\s*'" + k + "'", 'g'));
        const sR = n(new RegExp('state\\.' + k + '(?!\\w)', 'g'));
        const bR = n(new RegExp('(?<![\\w$.])' + k + '(?![\\w$])', 'g'));
        if (sW) wState.push(rel(f) + ':' + sW);
        if (gW) wGlobal.push(rel(f) + ':' + gW);
        if (sR) rState.push(rel(f));
        if (bR) rBare.push(rel(f));
    }
    rows.push({ k, wState, wGlobal, rState, rBare });
}

console.log('\n=== 两边都有写入（真分叉：同一状态两个写者，值会不一致）===');
rows.filter((r) => r.wState.length && r.wGlobal.length).forEach((r) =>
    console.log(`  ${r.k}\n     state: ${r.wState.join(' ')}\n     globalThis: ${r.wGlobal.join(' ')}`));

console.log('\n=== 只写 state、但存在裸读（写进去 UI 读不到 = 静默失效）===');
rows.filter((r) => r.wState.length && !r.wGlobal.length && r.rBare.length).forEach((r) =>
    console.log(`  ${r.k}  写:${r.wState.join(' ')}  裸读出现在 ${r.rBare.length} 处`));

console.log('\n=== 只写 globalThis、但存在 state 读（读到的永远是初始值）===');
rows.filter((r) => !r.wState.length && r.wGlobal.length && r.rState.length).forEach((r) =>
    console.log(`  ${r.k}  写:${r.wGlobal.join(' ')}  state 读:${r.rState.join(' ')}`));
