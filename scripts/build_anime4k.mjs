/* ============================================================
 * scripts/build_anime4k.mjs — 把 Anime4K 的 mpv GLSL 转成 WebGL2
 *
 * 为什么要有这一步：Anime4K 的 shader 是给 mpv 用的，带一套 `//!HOOK / //!BIND /
 * //!SAVE / //!WIDTH` 钩子指令，而且一两百行里塞了几十个 mat4 权重——**手抄必错**。
 * 这里把指令解析成「多 pass 渲染图」，再把 mpv 的三个隐式变量翻译成 WebGL 的
 * uniform，产出一个自包含的 JS 模块（web/src/services/mvUpscaleShaders.js）。
 *
 * mpv → WebGL 的对应关系：
 *   NAME_texOff(vec2(a, b))  →  texture(u_texG, v_uv + vec2(a, b) * u_ptG)
 *   NAME_tex(P)              →  texture(u_texG, <P 翻译后>)   （参数保留，Depth-to-Space 靠它取子像素）
 *   NAME_pos                 →  v_uv                       （见 translateVars 的说明）
 *   NAME_size / NAME_pt      →  u_sizeG / u_ptG
 *   vec4 hook() { return X; } → void main() { o = X; }
 * 其中 G 是「该名字在**这一 pass 时刻**指向的纹理」的全局编号——mpv 的 `//!SAVE MAIN`
 * 会覆盖 MAIN，必须按 pass 顺序逐条解析注册表，不能全局静态映射。
 *
 * ★ `_pos` 是**归一化**坐标（不是像素），而且它相对的是**本 pass 的 target** ——
 *   target 归一化后仍是 [0,1]，所以**直接就是 v_uv，不能乘任何比例**。
 *   （踩过的坑：见 translateVars 的注释。）
 *
 * 用法：node scripts/build_anime4k.mjs
 * 源：bloc97/Anime4K v4.0（MIT）——见 scripts/anime4k/ 下的原文件（含许可头）。
 * 选型：Restore_CNN（去压缩伪影/去噪）+ Upscale_CNN_x2（2x 超分），**S / M / L 三档**。
 *   ★ 2026-10-04 用户需求：「让用户可以自行选择开关着色器 / 调整锐化 S、M、L 强度」。
 *   三档是**同一套架构、不同的卷积核尺寸**（S 最轻最快、去伪影最弱；L 最重，
 *   细节最强也最容易把噪点当细节锐出来），所以各出一条渲染图，运行时按设置选一条实例化。
 *   **不取 Clamp_Highlights** —— 它用了 HOOKED/PREKERNEL 与 STATSMAX 中间资产，
 *   属于 mpv 特有的两趟统计，移植成本远高于收益。
 * ============================================================ */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(ROOT, 'scripts', 'anime4k');
const OUT = join(ROOT, 'web', 'src', 'services', 'mvUpscaleShaders.js');

/* 档位 → 源文件（顺序即 pass 链顺序：先 Restore 后 Upscale）。 */
const TIERS = {
    S: ['Anime4K_Restore_CNN_S.glsl', 'Anime4K_Upscale_CNN_x2_S.glsl'],
    M: ['Anime4K_Restore_CNN_M.glsl', 'Anime4K_Upscale_CNN_x2_M.glsl'],
    L: ['Anime4K_Restore_CNN_L.glsl', 'Anime4K_Upscale_CNN_x2_L.glsl'],
};

/* ---------------- 解析 mpv 指令块 ---------------- */
function parseMpv(src) {
    const passes = [];
    let cur = null;
    for (const line of src.split('\n')) {
        const m = /^\/\/!([A-Z]+)\s*(.*)$/.exec(line);
        if (m) {
            const key = m[1];
            const val = m[2].trim();
            if (key === 'DESC') { cur = { desc: val, bind: [], body: [] }; passes.push(cur); }
            else if (cur) {
                if (key === 'BIND') cur.bind.push(val);
                else if (key === 'SAVE') cur.save = val;
                else if (key === 'WIDTH') cur.width = val;
                else if (key === 'HEIGHT') cur.height = val;
                else if (key === 'COMPONENTS') cur.components = parseInt(val, 10);
                /* HOOK / WHEN 忽略：本移植只走 MAIN 链，不做尺寸条件分支 */
            }
            continue;
        }
        if (cur) cur.body.push(line);
    }
    return passes;
}

/* WIDTH 表达式只有两种形态：`X.w` 与 `X.w 2 *`（实测源文件如此）。
   解析成 { base, axis, mul }，避免在运行时 eval 字符串。 */
function parseDim(expr) {
    if (!expr) return { base: 'MAIN', axis: 'w', mul: 1 };
    const m = /^(\w+)\.([wh])(?:\s+([\d.]+)\s*\*)?$/.exec(expr.trim());
    if (!m) throw new Error('无法解析尺寸表达式: ' + expr);
    return { base: m[1], axis: m[2], mul: m[3] ? parseFloat(m[3]) : 1 };
}

const SHADER_HEAD = [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    'in vec2 v_uv;',
    'out vec4 o;',
].join('\n');

/* 配平括号地整段替换 `fnName(...)`。
   ★ 不能用 /fnName\([^)]*\)/ —— 参数里常带嵌套括号（`conv2d_last_tf_tex((vec2(0.5) - f0)
   * conv2d_last_tf_pt + conv2d_last_tf_pos)`），`[^)]*` 会在 `vec2(0.5)` 的右括号处截断，
   于是把 `texture()` 的返回值留在外面跟 vec2 相减 —— 表现为「vec4 - vec2 类型不匹配」。
   第一版就是这么炸的。 */
function replaceCall(code, fnName, build) {
    let out = '';
    let i = 0;
    for (; ;) {
        const idx = code.indexOf(fnName + '(', i);
        if (idx < 0) { out += code.slice(i); break; }
        const prev = idx > 0 ? code[idx - 1] : '';
        if (/[\w$]/.test(prev)) {                 /* 是更长标识符的一部分，跳过 */
            out += code.slice(i, idx + fnName.length);
            i = idx + fnName.length;
            continue;
        }
        let j = idx + fnName.length;              /* j 指向 '(' */
        let depth = 0, args = '';
        for (; j < code.length; j++) {
            const ch = code[j];
            if (ch === '(') { depth++; if (depth === 1) continue; }
            else if (ch === ')') { depth--; if (depth === 0) break; }
            args += ch;
        }
        out += code.slice(i, idx) + build(args);
        i = j + 1;
    }
    return out;
}

/** 按顶层逗号切分（忽略括号内的逗号） */
function splitTopLevel(s) {
    const parts = [];
    let depth = 0, cur = '';
    for (const ch of s) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
        cur += ch;
    }
    parts.push(cur);
    return parts;
}

/** 把 `NAME_pos / _size / _pt` 换成 WebGL 的 uniform。
 *  ★ `_pos` 就是归一化的当前片元坐标，**直接映射到 v_uv**：
 *    `NAME_texOff(off)` 的定义是 `texture(raw, pos + off * pt)`，off 是像素单位、
 *    pt = 1/size，所以 pos 必须已经是归一化坐标（否则量纲对不上）。而它相对的是
 *    「本 pass 的 target」，target 归一化后仍落在 [0,1] —— **不能乘任何比例**。
 *    第一版乘了 `out/tex` 想"修正尺寸差"，结果 Depth-to-Space 的基座变成
 *    `texture(tex4, uv * 2)`，一半画面被 CLAMP 到边缘，整帧与源不相关（corr≈0）。
 *    Restore/Upscale 的卷积层尺寸不变，ratio 恰为 1，所以那里看不出问题。 */
function translateVars(text, n, g) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text
        .replace(new RegExp(esc + '_pos\\b', 'g'), 'v_uv')
        .replace(new RegExp(esc + '_size\\b', 'g'), `u_size${g}`)
        .replace(new RegExp(esc + '_pt\\b', 'g'), `u_pt${g}`);
}

/* 把 mpv 正文翻译成 WebGL：所有 NAME_xxx 引用都指向该名字「此刻」的纹理编号 */
function translate(body, reg) {
    let code = body.join('\n');
    /* 名字按长度降序替换，避免 conv2d_tf 抢先吃掉 conv2d_last_tf 这类前缀包含 */
    const names = Object.keys(reg).sort((a, b) => b.length - a.length);
    for (const n of names) {
        const g = reg[n];
        code = replaceCall(code, n + '_texOff', (args) => {
            const m = /^vec2\s*\(([\s\S]*)\)$/.exec(args.trim());
            if (!m) return `texture(u_tex${g}, v_uv)`;
            const xy = splitTopLevel(m[1]).map(p => translateVars(p.trim(), n, g)).join(', ');
            return `texture(u_tex${g}, v_uv + vec2(${xy}) * u_pt${g})`;
        });
        /* ★ 参数必须保留并翻译，不能丢掉：X_tex(X_pos + 偏移) 在 Depth-to-Space 里
           正是靠偏移取到 2x2 子像素，丢掉偏移等于把超分变成简单放大。 */
        code = replaceCall(code, n + '_tex', (args) =>
            `texture(u_tex${g}, ${translateVars(args.trim(), n, g)})`);
    }
    for (const n of names) {
        code = translateVars(code, n, reg[n]);
    }
    code = code.replace(/\bvec4\s+hook\s*\(\s*\)/, 'void main()');
    code = code.replace(/\breturn\s+([^;]+);/g, 'o = $1;');
    return code.trim();
}

/* ---------------- 链接成渲染图（一档一条） ---------------- */
function link(files) {
    const reg = { MAIN: 0 };          /* 名字 → 纹理全局编号；tex0 恒为源视频帧 */
    const passes = [];
    let next = 1;
    for (const f of files) {
        const src = readFileSync(join(SRC_DIR, f), 'utf8');
        for (const p of parseMpv(src)) {
            if (!p.bind.length || !p.save) continue;
            const inputs = p.bind.map(n => {
                if (!(n in reg)) throw new Error(`${f} 引用了未注册的 ${n}`);
                return reg[n];
            });
            const out = next++;
            const w = parseDim(p.width);
            const h = parseDim(p.height);
            passes.push({
                desc: p.desc,
                file: f,
                inputs,
                out,
                w: { base: reg[w.base], mul: w.mul },
                h: { base: reg[h.base], mul: h.mul },
                frag: SHADER_HEAD + '\n'
                    + inputs.map(g => `uniform sampler2D u_tex${g};\nuniform vec2 u_size${g};\nuniform vec2 u_pt${g};`).join('\n')
                    + '\n' + translate(p.body, { ...reg }),
            });
            reg[p.save] = out;
        }
    }
    /* 最后一个 pass 的 save 即最终输出（Upscale 的 Depth-to-Space 覆盖 MAIN） */
    return { passes, final: reg.MAIN };
}

const built = {};
for (const [tier, files] of Object.entries(TIERS)) built[tier] = link(files);

/* ---------------- 产出 ---------------- */
const out = [
    '/* 自动生成，请勿手改 —— 改 scripts/build_anime4k.mjs 后重跑 `node scripts/build_anime4k.mjs`。',
    ' *',
    ' * 源：bloc97/Anime4K v4.0（MIT License, Copyright (c) 2019-2021 bloc97）',
    ' *     glsl/Restore/Anime4K_Restore_CNN_{S,M,L}.glsl',
    ' *     glsl/Upscale/Anime4K_Upscale_CNN_x2_{S,M,L}.glsl',
    ' * 原文件保留在 scripts/anime4k/（含完整许可头）。',
    ' *',
    ' * 三档 = 同一套架构 + 不同的卷积核尺寸：S 最轻最快、L 最重（细节最强，也更容易',
    ' * 把噪点当细节锐出来）。每档各自是一条完整的渲染图（pass 数与纹理编号都独立）。',
    ' * 每个 pass：读 inputs[]（纹理编号），写 out（纹理编号）；w/h 是输出尺寸',
    ' * 的表达式 { base: 纹理编号, mul: 倍数 }。',
    ' */',
    '',
    'export const A4K_SOURCE = {',
    `  name: 'Anime4K v4.0',`,
    `  license: 'MIT',`,
    `  url: 'https://github.com/bloc97/Anime4K',`,
    '};',
    '',
    '/** 源视频帧固定占用的纹理编号 */',
    'export const A4K_SOURCE_TEX = 0;',
    '',
    '/** 档位顺序（由轻到重）。UI 的选项顺序与默认值都以它为准。 */',
    `export const A4K_TIER_ORDER = [${Object.keys(built).map(t => `'${t}'`).join(', ')}];`,
    '',
    '/** 档位 → { final, passes }。final 是该档最终输出所在的纹理编号。 */',
    'export const A4K_TIERS = {',
];
for (const [tier, r] of Object.entries(built)) {
    out.push(`    ${tier}: {`);
    out.push(`        final: ${r.final},`);
    out.push('        passes: [');
    for (const p of r.passes) {
        out.push('            {');
        out.push(`                desc: ${JSON.stringify(p.desc)},`);
        out.push(`                from: ${JSON.stringify(p.file)},`);
        out.push(`                inputs: [${p.inputs.join(', ')}],`);
        out.push(`                out: ${p.out},`);
        out.push(`                w: { base: ${p.w.base}, mul: ${p.w.mul} },`);
        out.push(`                h: { base: ${p.h.base}, mul: ${p.h.mul} },`);
        out.push('                frag: ' + JSON.stringify(p.frag) + ',');
        out.push('            },');
    }
    out.push('        ],');
    out.push('    },');
}
out.push('};');
out.push('');

const text = out.join('\n');
writeFileSync(OUT, text, 'utf8');
console.log(`写出 ${OUT}  （${Math.round(text.length / 1024)} KB）`);
for (const [tier, r] of Object.entries(built)) {
    console.log(`\n== ${tier} 档：${r.passes.length} pass，final = tex${r.final}`);
    for (const p of r.passes) {
        console.log(`   tex${p.out} <- [${p.inputs.join(',')}]  ${p.w.base}*${p.w.mul} x ${p.h.base}*${p.h.mul}  ${p.desc}`);
    }
}
