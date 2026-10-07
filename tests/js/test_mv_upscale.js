/* ============================================================
 * test_mv_upscale.js — Anime4K 移植（mvUpscaleShaders.js / mvUpscale.js）的契约钉
 *
 * 这份测试存在的理由：mvUpscaleShaders.js 是**自动生成**的（scripts/build_anime4k.mjs
 * 把 mpv 的 GLSL 翻成 WebGL2）。翻译一旦漏掉某一处，产物里就会留下 mpv 专有的
 * 记号 —— 那时候 WebGL 侧只会报一句 "shader 编译失败"，看不出是谁漏了。
 * 这里把「翻译必须彻底」「链路必须连通」两件事钉住，重跑生成器后立刻能验。
 *
 * ★ 2026-10-04 扩成**三档**（用户需求：自行选择 S / M / L 强度）：产物从单一
 *   `A4K_PASSES` 变成 `A4K_TIERS = { S, M, L }`，每档各是一条独立渲染图。
 *   所有契约检查因此都改成"逐档跑一遍" —— 换档功能上线后，最容易坏的就是
 *   某一档的链断掉（用户切过去就是黑屏），而单档测试发现不了。
 *
 * 真实教训（都是这一轮踩的）：
 *   · `_pos` 语义翻错（当成像素坐标乘了尺寸比）→ Depth-to-Space 基座采样越界，
 *     整帧与源帧不相关（实测 corr 从 0.99 掉到 -0.07）。所以下面钉了
 *     「不许出现 * u_ratio」这种写法。
 *   · `NAME_tex(...)` 的参数用 `[^)]*` 正则匹配会在第一个右括号截断
 *     （`conv2d_last_tf_tex((vec2(0.5) - f0) * ...)`）→ 必须保留并翻译参数。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { A4K_TIERS, A4K_TIER_ORDER, A4K_SOURCE_TEX } from '../../web/src/services/mvUpscaleShaders.js';

const TIERS = A4K_TIER_ORDER;

test('三档都在，顺序由轻到重，pass 数递增（越重越吃 GPU）', () => {
    assert.deepEqual(A4K_TIER_ORDER, ['S', 'M', 'L']);
    const lens = TIERS.map(t => A4K_TIERS[t].passes.length);
    assert.equal(lens[0], 9, 'S = Restore_CNN_S(4) + Upscale_CNN_x2_S(5)');
    assert.ok(lens[1] > lens[0], `M 应比 S 重，实际 ${lens[1]} vs ${lens[0]}`);
    assert.ok(lens[2] > lens[1], `L 应比 M 重，实际 ${lens[2]} vs ${lens[1]}`);
    assert.equal(A4K_SOURCE_TEX, 0, '源视频帧恒占 tex0');
    for (const t of TIERS) assert.ok(A4K_TIERS[t].final > 0, `${t} 档 final 应为正数`);
});

test('每档：最终输出必须是链路最后一级产出（否则 blit 会读到中间结果）', () => {
    for (const t of TIERS) {
        const { passes, final } = A4K_TIERS[t];
        assert.equal(passes[passes.length - 1].out, final, `${t} 档`);
    }
});

test('每档链路连通：每个 pass 的输入都必须是"此前已产出"的纹理', () => {
    for (const t of TIERS) {
        const { passes, final } = A4K_TIERS[t];
        const produced = new Set([A4K_SOURCE_TEX]);
        for (const p of passes) {
            assert.ok(p.inputs.length >= 1 && p.inputs.length <= 8, `${t}/${p.desc}: 输入数异常`);
            for (const g of p.inputs) {
                assert.ok(produced.has(g), `${t} 档 pass「${p.desc}」引用了尚未产出的 tex${g}`);
            }
            assert.ok(!p.inputs.includes(p.out), `${t}/${p.desc}: 输出与输入同一纹理（反馈回路）`);
            produced.add(p.out);
        }
        assert.ok(produced.has(final), `${t} 档 final 未被产出`);
    }
});

test('每档尺寸链：卷积层尺寸不变，且末端有一次 2 倍放大（Depth-to-Space）', () => {
    for (const t of TIERS) {
        const { passes } = A4K_TIERS[t];
        for (const p of passes) {
            for (const axis of ['w', 'h']) {
                const d = p[axis];
                assert.equal(typeof d.base, 'number', `${t}/${p.desc}: ${axis}.base 应为纹理编号`);
                assert.ok(d.mul === 1 || d.mul === 2, `${t}/${p.desc}: 意外的缩放倍数 ${d.mul}`);
                assert.ok(d.base <= p.out, `${t}/${p.desc}: 只能引用已产出纹理的尺寸`);
            }
        }
        const last = passes[passes.length - 1];
        assert.match(last.desc, /Depth-to-Space/, `${t} 档末级应是 Depth-to-Space`);
        assert.equal(last.w.mul, 2, `${t} 档末级宽度应放大 2 倍`);
        assert.equal(last.h.mul, 2, `${t} 档末级高度应放大 2 倍`);
    }
});

test('每档翻译彻底：frag 里不许残留任何 mpv 专有记号', () => {
    for (const t of TIERS) {
        for (const p of A4K_TIERS[t].passes) {
            const f = p.frag;
            const where = `${t}/${p.desc}`;
            assert.doesNotMatch(f, /\/\/!/, `${where}: 残留 mpv 指令`);
            assert.doesNotMatch(f, /\b\w+_texOff\s*\(/, `${where}: 残留 _texOff 调用`);
            assert.doesNotMatch(f, /\b\w+_tex\s*\(/, `${where}: 残留 _tex 调用`);
            assert.doesNotMatch(f, /\b\w+_pos\b/, `${where}: 残留 _pos（未翻译的 mpv 变量）`);
            assert.doesNotMatch(f, /\b\w+_pt\b(?!\d)/, `${where}: 残留裸 _pt`);
            assert.doesNotMatch(f, /\bvec4\s+hook\s*\(/, `${where}: hook() 未换成 main()`);
            assert.doesNotMatch(f, /\breturn\s+[^;]+;/, `${where}: 残留返回值（main 不接受 return 值）`);
        }
    }
});

test('每档翻译正确性：_pos 直接映射 v_uv，不许再乘任何尺寸比', () => {
    /* ★ 这是本轮最贵的一个 bug：把 _pos 当成"像素坐标 × 尺寸比"，
       Depth-to-Space 的基座变成 texture(tex4, uv*2) → 一半画面被 CLAMP 到边缘。
       （注意 `fract(v_uv * u_size8)` 是**原 shader 自己**的写法
       —— `fract(pos * size)` 取亚像素相位，不在此列。） */
    for (const t of TIERS) {
        for (const p of A4K_TIERS[t].passes) {
            assert.doesNotMatch(p.frag, /u_ratio/, `${t}/${p.desc}: 不该再有 u_ratio`);
            assert.doesNotMatch(p.frag, /texture\(\s*u_tex\d+\s*,\s*v_uv\s*\*\s*[\d.]+/, `${t}/${p.desc}: _pos 被乘了比例`);
        }
    }
});

test('每档每个 frag 都是合法的 WebGL2 片段着色器骨架', () => {
    for (const t of TIERS) {
        for (const p of A4K_TIERS[t].passes) {
            assert.match(p.frag, /^#version 300 es\b/, `${t}/${p.desc}: 缺少 #version 300 es`);
            assert.match(p.frag, /\bprecision\s+highp\s+float;/, `${t}/${p.desc}: 缺少精度限定`);
            assert.match(p.frag, /\bin\s+vec2\s+v_uv;/, `${t}/${p.desc}: 缺少 v_uv 输入`);
            assert.match(p.frag, /\bout\s+vec4\s+o;/, `${t}/${p.desc}: 缺少输出变量`);
            assert.match(p.frag, /void\s+main\s*\(\s*\)/, `${t}/${p.desc}: 缺少 main()`);
            /* 每个输入都必须有配套的 sampler / size / pt 三个 uniform（缺一个就是运行期黑屏） */
            for (const g of p.inputs) {
                assert.match(p.frag, new RegExp(`uniform\\s+sampler2D\\s+u_tex${g};`), `${t}/${p.desc}: 缺 u_tex${g}`);
                assert.match(p.frag, new RegExp(`uniform\\s+vec2\\s+u_size${g};`), `${t}/${p.desc}: 缺 u_size${g}`);
                assert.match(p.frag, new RegExp(`uniform\\s+vec2\\s+u_pt${g};`), `${t}/${p.desc}: 缺 u_pt${g}`);
            }
        }
    }
});

test('isUpscaleSupported 在非浏览器环境安全返回 false（不抛）', async () => {
    const mod = await import('../../web/src/services/mvUpscale.js');
    assert.equal(typeof mod.isUpscaleSupported, 'function');
    /* node 里没有 document —— 必须安静地返回 false，而不是抛异常把整个 import 链带崩 */
    assert.equal(mod.isUpscaleSupported(), false);
    assert.equal(typeof mod.createUpscaler, 'function');
});
