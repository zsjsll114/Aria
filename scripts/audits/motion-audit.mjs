/* scripts/audits/motion-audit.mjs — 动效纪律复扫（缓动收敛 / 壳层禁回弹 / transition:all / will-change）
 *
 * 用法：node scripts/audits/motion-audit.mjs          只看报告，恒退出 0
 *       node scripts/audits/motion-audit.mjs --check  任一类目超过基线则退出 1（CI 用）
 *
 * 基线是「只减不增」的棘轮：改好后把新数字写回 BASELINE，别调回去。
 * 表现层（PV / 视觉器 / 歌词视图）允许回弹与自定义曲线，所以单列在 EXPRESSIVE 里，
 * 只有壳层（弹窗、底栏、列表、菜单）受限。
 */
import fs from 'node:fs';
import path from 'node:path';

const CHECK = process.argv.includes('--check');
const STYLES = 'web/src/styles';

/* 表现层：动效本身就是内容，不受壳层纪律约束 */
const EXPRESSIVE = new Set([
    'pv.css', 'pv-tunnel.css', 'visualizers.css', 'letterpress.css', 'neon.css',
    'appearance.css', 'motion.css',
]);

/* motion.css 里定义的三条曲线，去掉空格后比对 */
const norm = (s) => s.replace(/\s+/g, '');
const ALLOWED = new Set([
    'cubic-bezier(0.16,1,0.3,1)',      // --e-enter
    'cubic-bezier(0.22,1,0.36,1)',     // --e-enter-soft
    'cubic-bezier(0.4,0,1,1)',         // --e-exit
    'cubic-bezier(0.4,0,0.2,1)',       // 材料标准退场，存量已收敛到此
]);

/* 基线（2026-09-25 L2 收口后实测）
 * offCurve / bounce / transitionAll 已归零，只许更少。
 * willChangeShell 只统计壳层，且刻意留 4 处不删：
 *   base.css .line（逐帧 filter/transform 提升）、playlist-manager.css .plm-item（FLIP）、
 *   viewmode.css ×2 —— 删掉是否掉帧只能在低配机实测，开发机上量不出来，所以先不动，只挡住新增。 */
const BASELINE = {
    offCurve: 0,
    bounce: 0,
    transitionAll: 0,
    willChangeShell: 4,
};

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) continue;
        if (e.name.endsWith('.css')) out.push(path.join(dir, e.name));
    }
    return out;
}

const rows = { offCurve: [], bounce: [], transitionAll: [], willChange: [] };

for (const file of walk(STYLES)) {
    const name = path.basename(file);
    const expressive = EXPRESSIVE.has(name);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
        const ln = i + 1;
        const where = `${name}:${ln}`;
        /* 跳过令牌定义本身与 CSS 自定义属性赋值（--e-enter: cubic-bezier(...)） */
        const isTokenDef = /--[\w-]+\s*:/.test(line);

        for (const m of line.matchAll(/cubic-bezier\([^)]*\)/g)) {
            if (isTokenDef) continue;
            const curve = norm(m[0]);
            const y1 = +(curve.match(/cubic-bezier\(([^,]+),([^,]+),([^,]+),([^)]+)\)/) || [])[2];
            const y2 = +(curve.match(/cubic-bezier\(([^,]+),([^,]+),([^,]+),([^)]+)\)/) || [])[4];
            const overshoot = y1 > 1.01 || y2 > 1.01;
            if (overshoot && !expressive) rows.bounce.push({ where, curve: m[0], text: line.trim() });
            else if (!ALLOWED.has(curve) && !expressive) rows.offCurve.push({ where, curve: m[0], text: line.trim() });
        }
        if (!expressive && /transition\s*:\s*all\b/.test(line)) {
            rows.transitionAll.push({ where, text: line.trim() });
        }
        if (/will-change\s*:/.test(line)) {
            /* will-change: auto 是「取消提升」，属降级手段，不算违例 */
            if (/will-change\s*:\s*auto/.test(line)) return;
            rows.willChange.push({ where, text: line.trim(), expressive: expressive });
        }
    });
}

const cats = [
    ['offCurve', '壳层非白名单缓动曲线（应改用 var(--e-enter/--e-enter-soft/--e-exit)）'],
    ['bounce', '壳层回弹曲线 back-out（回弹只留给表现层）'],
    ['transitionAll', 'transition: all（会连带过渡 width/color 等意外属性）'],
    ['willChangeShell', '壳层 will-change（每处都是一层合成层，需逐个确认真的有收益）'],
];

/* 表现层文件里的 will-change 不计入棘轮，只单独提示 */
rows.willChangeShell = rows.willChange.filter((r) => !r.expressive);
const expressiveWc = rows.willChange.filter((r) => r.expressive);

let failed = false;
for (const [key, label] of cats) {
    const n = rows[key].length;
    const base = BASELINE[key];
    const flag = n > base ? '✗ 超出基线' : (n < base ? '✓ 低于基线' : '= 持平');
    console.log(`\n${label}\n  ${n} 处 / 基线 ${base}  ${flag}`);
    if (n > base) failed = true;
    for (const r of rows[key].slice(0, 12)) console.log(`    ${r.where}  ${r.text.slice(0, 96)}`);
    if (n > 12) console.log(`    … 另 ${n - 12} 处`);
}
console.log(`\n（表现层 will-change ${expressiveWc.length} 处不计入棘轮：PV/视觉器的合成层是内容本身）`);

console.log(`\n合计 ${cats.reduce((a, [k]) => a + rows[k].length, 0)} 处壳层待观察。`);
if (CHECK && failed) {
    console.log('\n动效纪律棘轮被突破：任一类目数量不得高于 BASELINE。');
    process.exit(1);
}
