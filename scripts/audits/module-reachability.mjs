/* scratch/reachability.mjs — 从真实入口做静态 import 可达性分析
 * 目的：量化「影子层」——存在但从没被接线的模块。
 * 入口：web/src/app/index.js（分片唯一入口）+ web/lyrics.html + web/index.html 的 <script type=module>
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'web/src';
function walk(d, out = []) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'vendor') walk(p, out); }
        else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) out.push(p);
    }
    return out;
}
const all = walk(ROOT).map((f) => path.normalize(f).replace(/\\/g, '/'));

/* 收集入口：分片入口 + 两个 html 里直接 import 的模块 */
const entries = new Set();
const idx = 'web/src/app/index.js';
if (all.includes(idx)) entries.add(idx);
for (const html of ['web/index.html', 'web/lyrics.html']) {
    if (!fs.existsSync(html)) continue;
    const t = fs.readFileSync(html, 'utf8');
    for (const m of t.matchAll(/(?:src|href)=["']([^"']*\.m?js)["']/g)) {
        const p = path.normalize('web/' + m[1].replace(/^\.\//, '').replace(/^src\//, 'src/')).replace(/\\/g, '/');
        if (all.includes(p)) entries.add(p);
    }
    for (const m of t.matchAll(/import\s+(?:\([^)]*\)|[\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
        /* html 内联 module script 的 import 以 html 所在目录为基准 */
        const p = path.normalize(path.join(path.dirname(html), m[2])).replace(/\\/g, '/');
        if (all.includes(p)) entries.add(p);
    }
}

const specToPath = (spec, from) => {
    if (!spec.startsWith('.')) return null;              /* 裸模块名（CDN/Node）不参与 */
    const p = path.normalize(path.join(path.dirname(from), spec)).replace(/\\/g, '/');
    return all.includes(p) ? p : null;
};

const reachable = new Set();
const importers = new Map();
const stack = [...entries];
while (stack.length) {
    const f = stack.pop();
    if (reachable.has(f)) continue;
    reachable.add(f);
    const t = fs.readFileSync(f, 'utf8');
    for (const m of t.matchAll(/(?:^|[\s(;{}=])import\s+(?:[\s\S]*?\sfrom\s*)?["']([^"']+)["']/g)) {
        const p = specToPath(m[1], f);
        if (p) {
            if (!importers.has(p)) importers.set(p, new Set());
            importers.get(p).add(f);
            stack.push(p);
        }
    }
    for (const m of t.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) {
        const p = specToPath(m[1], f);
        if (p) {
            if (!importers.has(p)) importers.set(p, new Set());
            importers.get(p).add(f + ' (动态)');
            stack.push(p);
        }
    }
}

const dead = all.filter((f) => !reachable.has(f));
const loc = (f) => fs.readFileSync(f, 'utf8').split('\n').length;

console.log(`模块总数 ${all.length} | 入口 ${entries.size} | 可达 ${reachable.size} | 不可达 ${dead.length}`);
const byDir = new Map();
for (const d of dead) {
    const dir = path.dirname(d);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(d);
}
let totLoc = 0;
for (const [dir, list] of [...byDir.entries()].sort()) {
    const l = list.reduce((a, f) => a + loc(f), 0);
    totLoc += l;
    console.log(`\n[${dir}] ${list.length} 个 / ${l} 行`);
    list.sort().forEach((f) => console.log(`   ${f.replace('web/src/', '')}  (${loc(f)} 行)`));
}
console.log(`\n不可达合计行数 ${totLoc}`);

/* 影子层引用到的下游：删影子后会跟着变孤儿的模块 */
console.log('\n=== 影子层引用到的下游（删影子后会跟着变孤儿）===');
const orphanCandidates = new Set();
for (const d of dead) {
    const t = fs.readFileSync(d, 'utf8');
    for (const m of t.matchAll(/from\s+["']([^"']+)["']/g)) {
        const p = specToPath(m[1], d);
        if (p && reachable.has(p)) orphanCandidates.add(p);
    }
}
for (const p of [...orphanCandidates].sort()) {
    const users = all.filter((f) => !dead.includes(f) && fs.readFileSync(f, 'utf8').includes(path.basename(p)));
    console.log(`   ${p.replace('web/src/', '')}  仍被存活模块引用: ${users.length}`);
}
