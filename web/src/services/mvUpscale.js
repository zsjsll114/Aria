/* ============================================================
 * mvUpscale.js — MV 背景的 Anime4K 画质增强（WebGL2 多 pass 渲染器）
 *
 * 解决什么：MV 直链普遍是低分辨率低码率（实测酷狗「晴天」768x432 / 24MB mkv），
 * 而背景层要铺满整个窗口（1440x900 窗口下约 1613x1008）——4.9 倍放大 + 低码率
 * 压缩伪影，观感就是用户说的「模糊、噪点多、边缘不清晰」。
 *
 * 链路（全部来自 bloc97/Anime4K v4.0，MIT；由 scripts/build_anime4k.mjs 自动移植）：
 *   Restore_CNN_*    —— 去压缩伪影 / 去噪（针对低码率源，这是"噪点"的来源）
 *   Upscale_CNN_x2_* —— 2 倍超分（这是"模糊/边缘不清"的来源）
 *   + 1 个 blit pass 把结果缩放到 canvas
 * ★ 三档（2026-10-04 用户需求「让用户可以自行选择开关着色器 / 调整锐化 S、M、L 强度」）：
 *   S = 9 pass / M = 17 pass / L = 19 pass，同一套架构、不同卷积核尺寸。
 *   档位在 createUpscaler 时确定；换档 = dispose 旧的再建新的（调用方负责）。
 *
 * 为什么能直接在跨源 MV 上跑：实测酷狗 / 网易 / QQ 三家 CDN 的直链都带
 *   `Access-Control-Allow-Origin: *`，所以 `<video crossOrigin="anonymous">`
 *   之后 `texImage2D(video)` 不会抛 SecurityError。**不需要同源代理、不需要改
 *   server.py**（省掉一次 PyInstaller 重打包）。
 *
 * 中间纹理必须用浮点：Anime4K 的卷积输出含负数与 >1 的值，RGBA8 会被 clamp
 *   成过曝/花屏。用 RGBA16F（+ EXT_color_buffer_float）；该扩展缺失时退回
 *   RGBA8 并在 info 上打标 —— 画质打折但不崩。
 *
 * 实测开销（RTX 5070 Ti / ANGLE D3D11，768x432 源）：S 档整链 10 个 pass 在 1~3ms 内；
 *   M/L 的 pass 数与卷积通道数都更多，明显更吃 GPU（降级闸就是为它们准备的）。
 * ============================================================ */
import { A4K_TIERS, A4K_SOURCE_TEX } from './mvUpscaleShaders.js';
import { logInfo, logWarn, logCatch } from './log.js';

const VS = `#version 300 es
precision highp float;
out vec2 v_uv;
void main(){
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    v_uv = p;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/* 把最终纹理缩放到 canvas。缩放比通常只有 1.0~1.3（Anime4K 已做完主要放大），
   双线性足够，不值得再上一档 CNN。 */
const BLIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_tex;
void main(){ o = vec4(texture(u_tex, v_uv).rgb, 1.0); }`;

/** 缓存能力探测结果（探测本身要建一次 context，别每帧做） */
let _supportCache = null;

/** WebGL2 + 浮点渲染是否可用（决定画质档，不影响能不能跑） */
export function isUpscaleSupported() {
    if (_supportCache !== null) return _supportCache;
    try {
        if (typeof document === 'undefined') { _supportCache = false; return false; }
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl2');
        if (!gl) { _supportCache = false; return false; }
        _supportCache = !!gl.getExtension('EXT_color_buffer_float');
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
    } catch (e) {
        logCatch('mvUpscale', e);
        _supportCache = false;
    }
    return _supportCache;
}

function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const err = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error('shader 编译失败: ' + err);
    }
    return s;
}

function makeProgram(gl, fsSrc) {
    const p = gl.createProgram();
    const vs = compile(gl, gl.VERTEX_SHADER, VS);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        const err = gl.getProgramInfoLog(p);
        gl.deleteProgram(p);
        throw new Error('program 链接失败: ' + err);
    }
    return p;
}

/**
 * 建一个 Anime4K 上行渲染器。
 * @param {HTMLCanvasElement} canvas 输出画布（内部尺寸由调用方设成显示尺寸）
 * @param {'S'|'M'|'L'} [tier='S'] 强度档位。只在这里解析一次；
 *   换档由调用方 dispose 旧实例后重新创建（不同档的 pass 图与纹理编号都独立）。
 * @returns {null | {render:Function, dispose:Function, info:Object}}
 */
export function createUpscaler(canvas, tier = 'S') {
    const tierSpec = A4K_TIERS[tier] || A4K_TIERS[Object.keys(A4K_TIERS)[0]];
    const passes = tierSpec.passes;
    const finalTex = tierSpec.final;
    let gl = null;
    try {
        gl = canvas.getContext('webgl2', {
            alpha: false, antialias: false, depth: false, stencil: false,
            premultipliedAlpha: false, preserveDrawingBuffer: false,
            powerPreference: 'high-performance',
        });
    } catch (e) { logCatch('mvUpscale', e); }
    if (!gl) return null;

    const floatOk = !!gl.getExtension('EXT_color_buffer_float');
    const internalFormat = floatOk ? gl.RGBA16F : gl.RGBA8;
    const texType = floatOk ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

    const textures = new Map();     /* 纹理编号 → WebGLTexture */
    const fbos = new Map();         /* 纹理编号 → Framebuffer（源纹理不建 FBO） */
    const sizeOf = new Map();       /* 纹理编号 → { w, h } */
    let allocated = { w: 0, h: 0 };
    let disposed = false;
    let frames = 0;
    let avgMs = 0;
    let lastMs = 0;

    const info = { tier, float: floatOk, passes: passes.length + 1, texCount: 0, midSize: '', frames: 0, lastMs: 0, avgMs: 0 };

    let programs = null;
    let uniforms = null;
    let blitProg = null;
    let vao = null;
    try {
        programs = passes.map(p => ({ spec: p, prog: makeProgram(gl, p.frag) }));
        /* 每个 pass 的输入 sampler / size / pt 位置只查一次 */
        uniforms = programs.map(({ spec, prog }) => spec.inputs.map(g => ({
            tex: gl.getUniformLocation(prog, `u_tex${g}`),
            size: gl.getUniformLocation(prog, `u_size${g}`),
            pt: gl.getUniformLocation(prog, `u_pt${g}`),
            ratio: gl.getUniformLocation(prog, `u_ratio${g}`),
            g,
        })));
        blitProg = makeProgram(gl, BLIT_FS);
        vao = gl.createVertexArray();
    } catch (e) {
        logWarn('mvUpscale', '[MV] Anime4K shader 初始化失败: ' + e.message);
        return null;
    }

    function newTexture(w, h, isSource) {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        /* 源帧每一帧都会被 texImage2D 覆盖，先给个 1x1 占位即可 */
        const [iw, ih, ifmt, itype] = isSource ? [1, 1, gl.RGBA8, gl.UNSIGNED_BYTE] : [w, h, internalFormat, texType];
        gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, iw, ih, 0, gl.RGBA, itype, null);
        return t;
    }

    /** 按渲染图算出每个纹理的尺寸（源尺寸变了就整体重算） */
    function computeSizes(srcW, srcH) {
        sizeOf.clear();
        sizeOf.set(A4K_SOURCE_TEX, { w: srcW, h: srcH });
        for (const p of passes) {
            const bw = sizeOf.get(p.w.base).w, bh = sizeOf.get(p.h.base).h;
            sizeOf.set(p.out, {
                w: Math.max(1, Math.round(bw * p.w.mul)),
                h: Math.max(1, Math.round(bh * p.h.mul)),
            });
        }
    }

    function allocate(srcW, srcH) {
        for (const t of textures.values()) gl.deleteTexture(t);
        for (const f of fbos.values()) gl.deleteFramebuffer(f);
        textures.clear();
        fbos.clear();
        computeSizes(srcW, srcH);

        textures.set(A4K_SOURCE_TEX, newTexture(srcW, srcH, true));
        for (const p of passes) {
            const s = sizeOf.get(p.out);
            const t = newTexture(s.w, s.h, false);
            textures.set(p.out, t);
            const fb = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
            const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
            if (st !== gl.FRAMEBUFFER_COMPLETE) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                throw new Error('FBO 不完整: 0x' + st.toString(16) + ` (${s.w}x${s.h})`);
            }
            fbos.set(p.out, fb);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        allocated = { w: srcW, h: srcH };
        const fin = sizeOf.get(finalTex);
        info.texCount = sizeOf.size;
        info.midSize = `${fin.w}x${fin.h}`;
    }

    /**
     * 渲染一帧。
     * @param {HTMLVideoElement} video 已 readyState>=2 的源
     * @returns {boolean} false = 调用方应回退到普通 video 显示
     */
    function render(video, srcW, srcH) {
        if (disposed || gl.isContextLost()) return false;
        if (!srcW || !srcH || !video) return false;
        if (allocated.w !== srcW || allocated.h !== srcH) {
            try { allocate(srcW, srcH); }
            catch (e) { logWarn('mvUpscale', '[MV] 纹理分配失败: ' + e.message); return false; }
        }
        const t0 = performance.now();

        gl.bindTexture(gl.TEXTURE_2D, textures.get(A4K_SOURCE_TEX));
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, video);
        } catch (e) {
            /* 跨源且无 CORS 头会走到这里 —— 调用方应回退 */
            logCatch('mvUpscale', e);
            return false;
        } finally {
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        }

        gl.bindVertexArray(vao);
        gl.disable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);

        for (let i = 0; i < programs.length; i++) {
            const { spec, prog } = programs[i];
            const s = sizeOf.get(spec.out);
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbos.get(spec.out));
            gl.viewport(0, 0, s.w, s.h);
            gl.useProgram(prog);
            uniforms[i].forEach((u, k) => {
                const ts = sizeOf.get(u.g);
                gl.activeTexture(gl.TEXTURE0 + k);
                gl.bindTexture(gl.TEXTURE_2D, textures.get(u.g));
                gl.uniform1i(u.tex, k);
                gl.uniform2f(u.size, ts.w, ts.h);
                gl.uniform2f(u.pt, 1 / ts.w, 1 / ts.h);
                /* mpv 的 _pos 是「当前片元在该纹理坐标系下的**归一化**位置」——
                   输入/输出尺寸不等时它超出 0..1（Depth-to-Space 输出 2x ⇒ uv*2）。
                   传 0 会被 GL 当成 0（未使用该 uniform 的 pass 无所谓），
                   但**用到了就必须传对**，否则画面错位。 */
                if (u.ratio) gl.uniform2f(u.ratio, s.w / ts.w, s.h / ts.h);
            });
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        }

        /* 唯一一次不定比缩放：中间结果 → canvas */
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.useProgram(blitProg);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, textures.get(finalTex));
        gl.uniform1i(gl.getUniformLocation(blitProg, 'u_tex'), 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);

        lastMs = performance.now() - t0;
        frames++;
        avgMs = avgMs ? avgMs * 0.9 + lastMs * 0.1 : lastMs;
        info.frames = frames;
        info.lastMs = lastMs;
        info.avgMs = avgMs;
        return true;
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        try {
            for (const t of textures.values()) gl.deleteTexture(t);
            for (const f of fbos.values()) gl.deleteFramebuffer(f);
            textures.clear(); fbos.clear();
            if (programs) programs.forEach(p => gl.deleteProgram(p.prog));
            if (blitProg) gl.deleteProgram(blitProg);
            if (vao) gl.deleteVertexArray(vao);
            const lose = gl.getExtension('WEBGL_lose_context');
            if (lose) lose.loseContext();
        } catch (e) { logCatch('mvUpscale', e); }
        logInfo('mvUpscale', `[MV] 画质增强已释放（渲染 ${frames} 帧，均 ${avgMs.toFixed(2)}ms）`);
    }

    return { render, dispose, info };
}
