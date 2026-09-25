/* scripts/audits/accessor-safety-scan.mjs — globalThis→state accessor 化之前的安全扫描
 *
 * 三类会改变语义的用法：
 *   A. delete globalThis.K          —— 可配置 accessor 被 delete 后，裸标识符读会抛 ReferenceError
 *   B. typeof K === 'undefined'     —— 把「未定义」当「未初始化」探测；accessor 化后恒不为 undefined
 *   C. index.html 里 var/function K —— 全局 var 声明遇到同名 configurable accessor 不会重置值，
 *      但会让人误以为声明生效
 * 另外报告：state.js 与 globalThis 的重叠键清单（accessor 化的作用面）。
 */
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
const files = walk('web/src').map((f) => f.replace(/\\/g, '/'));

const stateKeys = (fs.readFileSync('web/src/infrastructure/state.js', 'utf8').match(/^\s{4}([A-Za-z_]\w*)\s*:/gm) || [])
    .map((s) => s.trim().split(':')[0]);
const gKeys = new Set();
for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    for (const m of t.matchAll(/registerGlobal\(\s*'([^']+)'/g)) gKeys.add(m[1]);
    for (const m of t.matchAll(/globalThis\.([A-Za-z_]\w*)\s*=[^=]/g)) gKeys.add(m[1]);
}
const overlap = stateKeys.filter((k) => gKeys.has(k));
console.log(`作用面：state 键 ${stateKeys.length} / globalThis 键 ${gKeys.size} / 重叠 ${overlap.length}`);

const hit = (label, re, where) => {
    const out = [];
    const list = where === 'html' ? ['web/index.html', 'web/lyrics.html'] : files;
    for (const f of list) {
        const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
        lines.forEach((l, i) => {
            const m = l.match(re);
            if (!m) return;
            if (!overlap.includes(m[1])) return;      /* 只关心 accessor 作用面上的键 */
            out.push(`${f}:${i + 1}  ${l.trim().slice(0, 110)}`);
        });
    }
    console.log(`\n[${label}] ${out.length} 处`);
    out.slice(0, 30).forEach((s) => console.log('   ' + s));
    return out;
};

hit('A: delete globalThis.K', /delete\s+(?:globalThis|window)\.([A-Za-z_]\w*)/);
hit('B: typeof K 未初始化探测', /typeof\s+([A-Za-z_]\w*)\s*(?:===|!==|==)\s*['"]undefined['"]/);
hit('C: html 里 var/function K 撞名', /^\s*(?:var|function)\s+([A-Za-z_]\w*)/, 'html');
hit('D: window.K 读写（同一属性，仅登记）', /window\.([A-Za-z_]\w*)\s*=[^=]/);

/* 额外：把 state 里有、但 globalThis 从未赋值的键列出来（这些键 accessor 化等于新增初值语义） */
console.log('\n[only-in-state] 只在 state 定义、globalThis 无赋值：');
stateKeys.filter((k) => !gKeys.has(k)).forEach((k) => console.log('   ' + k));

/* ---- E. typeof 探测是否会真的翻转 ----
 * 只有「boot 时从未赋过值」的键，`typeof K` 才可能从 'undefined' 变成有值；
 * 已在 10-config-state 等分片里赋过初值的键，探测本来就恒真，accessor 化不改变语义。 */
const probed = new Set();
const assigned = new Set();
for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    for (const m of t.matchAll(/typeof\s+([A-Za-z_]\w*)\s*(?:===|!==|==)\s*['"]undefined['"]/g)) probed.add(m[1]);
    for (const m of t.matchAll(/(?:globalThis|window)\.([A-Za-z_]\w*)\s*=[^=]/g)) assigned.add(m[1]);
}
const flipRisk = overlap.filter((k) => probed.has(k) && !assigned.has(k));
const safeProbes = overlap.filter((k) => probed.has(k) && assigned.has(k));
console.log(`\n[E] typeof 探测会翻转的键（accessor 化前必须逐个处理）: ${flipRisk.length}`);
flipRisk.forEach((k) => console.log('   ★ ' + k));
console.log(`[E] 探测恒真、语义不变的键: ${safeProbes.length} → ${safeProbes.join(', ')}`);
