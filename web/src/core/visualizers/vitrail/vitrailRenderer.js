/**
 * web/src/core/visualizers/vitrail/vitrailRenderer.js
 * 「琉璃龛 · Vitrail」（mode: vitrail）—— WebGL2 多通道光学渲染管线
 *
 * 管线组成：
 *   Pass 1 (0.5x FBO):   平面水镜倒影（镜像 Y 变换 + gl.frontFace(gl.CW) + 倒影歌词与圣殿拱肋）
 *   Pass 2 (Full FBO):   主建筑场景（三平面石材/金属/彩绘琉璃 + 动态点光源 + 水面波纹反射 + 圣光束 + 3D SDF 雕刻歌词 + 浮尘）
 *   Pass 3 (0.25x FBO):  半分辨率阈值泛光提取 + 两道双向 Kawase 模糊
 *   Pass 4 (Backbuffer): HDR 泛光合成 + ACES 电影色调映射 + 柔和暗角与微颗粒
 */

import {
    SCENE_VS, SCENE_FS,
    WATER_VS, WATER_FS,
    SHAFT_VS, SHAFT_FS,
    SCRIM_VS, SCRIM_FS,
    GLYPH_VS, GLYPH_FS,
    MOTE_VS, MOTE_FS,
    QUAD_VS, SKY_FS, SCENE_BLEND_FS, BLOOM_EXTRACT_FS, BLOOM_BLUR_FS, COMPOSITE_FS,
} from './vitrailShaders.js';
import {
    mat4Perspective,
    mat4LookAt,
    mat4Multiply,
    mat4Identity,
    mat4ModelTransform,
} from './vitrailGeometry.js';
import { VITRAIL_ARCHETYPES, clamp, hexToVec3 } from './vitrailProfiles.js';
import { logCatch, logWarn } from '../../../services/log.js';

const MAX_GLYPH_QUADS = 256;
// 每个顶点：aPos(3) + aUv(2) + aColorBase(4) + aColorSung(4) + aProg(1) + aEnter(1) = 15 floats
const GLYPH_FLOATS_PER_VERT = 15;

function toLinear(c) {
    return Math.pow(Math.max(0, Math.min(1, c)), 2.2);
}

function hexToLinearVec3(hex) {
    const [r, g, b] = hexToVec3(hex);
    return [toLinear(r), toLinear(g), toLinear(b)];
}

function compileShader(gl, type, src, label) {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh) || 'unknown';
        logWarn('vitrailRenderer', `[Shader Compile Error:${label}] ${log}`);
        gl.deleteShader(sh);
        return null;
    }
    return sh;
}

function createProgram(gl, vsSrc, fsSrc, label) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc, `${label}.vs`);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc, `${label}.fs`);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    if (!prog) return null;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(prog) || 'unknown';
        logWarn('vitrailRenderer', `[Program Link Error:${label}] ${log}`);
        gl.deleteProgram(prog);
        return null;
    }
    const uniforms = {};
    const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
        const info = gl.getActiveUniform(prog, i);
        if (info && info.name) {
            uniforms[info.name] = gl.getUniformLocation(prog, info.name);
        }
    }
    return { program: prog, u: uniforms };
}

function mat3NormalFromMat4(m) {
    return new Float32Array([
        m[0], m[1], m[2],
        m[4], m[5], m[6],
        m[8], m[9], m[10],
    ]);
}

export class VitrailWebGLRenderer {
    /**
     * @param {HTMLCanvasElement} canvas
     */
    constructor(canvas) {
        this.canvas = canvas;
        /** @type {WebGL2RenderingContext|null} */
        this.gl = null;
        this.ready = false;
        this.contextLost = false;
        this.hasFloatFbo = false;

        this.programs = {};
        this.vaos = {};
        this.fbos = {};
        this.textures = {};
        this.dynamicMeshes = [];
        this.sceneCache = new Map();
        this._activeSceneArch = null;

        this.glyphFloats = new Float32Array(MAX_GLYPH_QUADS * 4 * GLYPH_FLOATS_PER_VERT);
        this.glyphIndices = new Uint16Array(MAX_GLYPH_QUADS * 6);
        for (let i = 0; i < MAX_GLYPH_QUADS; i++) {
            const vb = i * 4;
            const ib = i * 6;
            this.glyphIndices[ib + 0] = vb + 0;
            this.glyphIndices[ib + 1] = vb + 1;
            this.glyphIndices[ib + 2] = vb + 2;
            this.glyphIndices[ib + 3] = vb + 0;
            this.glyphIndices[ib + 4] = vb + 2;
            this.glyphIndices[ib + 5] = vb + 3;
        }
        this.activeGlyphCount = 0;
        this.scrimFloats = new Float32Array(4 * 5);

        this.width = 0;
        this.height = 0;
        this._fboWidth = 0;
        this._fboHeight = 0;
        this._moteCount = 220;
        this._staticIdxCount = 0;
        this._shaftIdxCount = 0;
        this._waterIdxCount = 6;
        this._onLost = null;
        this._onRestored = null;
    }

    init(sceneBundle) {
        if (!this.canvas) return false;
        const attrs = {
            alpha: false,
            antialias: false,
            depth: true,
            stencil: false,
            powerPreference: 'high-performance',
            preserveDrawingBuffer: false,
        };
        /** @type {WebGL2RenderingContext|null} */
        let gl;
        try {
            gl = /** @type {WebGL2RenderingContext|null} */ (this.canvas.getContext('webgl2', attrs));
        } catch (e) {
            logCatch('vitrailRenderer.getContext', e);
            gl = null;
        }
        if (!gl) {
            this.ready = false;
            return false;
        }
        this.gl = gl;

        this._onLost = (ev) => {
            ev.preventDefault();
            this.contextLost = true;
        };
        this._onRestored = () => {
            this.contextLost = false;
            this._rebuildResources(this._lastSceneBundle);
        };
        this.canvas.addEventListener('webglcontextlost', this._onLost, false);
        this.canvas.addEventListener('webglcontextrestored', this._onRestored, false);

        return this._rebuildResources(sceneBundle);
    }

    _rebuildResources(sceneBundle) {
        const gl = this.gl;
        if (!gl || !sceneBundle) return false;
        this._lastSceneBundle = sceneBundle;
        this._disposeGpuObjects(false);

        const floatExt = gl.getExtension('EXT_color_buffer_float');
        gl.getExtension('OES_texture_float_linear');
        this.hasFloatFbo = Boolean(floatExt);

        const pScene = createProgram(gl, SCENE_VS, SCENE_FS, 'scene');
        const pWater = createProgram(gl, WATER_VS, WATER_FS, 'water');
        const pShaft = createProgram(gl, SHAFT_VS, SHAFT_FS, 'shaft');
        const pScrim = createProgram(gl, SCRIM_VS, SCRIM_FS, 'scrim');
        const pGlyph = createProgram(gl, GLYPH_VS, GLYPH_FS, 'glyph');
        const pMote = createProgram(gl, MOTE_VS, MOTE_FS, 'mote');
        const pSky = createProgram(gl, QUAD_VS, SKY_FS, 'sky');
        const pBlend = createProgram(gl, QUAD_VS, SCENE_BLEND_FS, 'sceneBlend');
        const pExtract = createProgram(gl, QUAD_VS, BLOOM_EXTRACT_FS, 'bloomExtract');
        const pBlur = createProgram(gl, QUAD_VS, BLOOM_BLUR_FS, 'bloomBlur');
        const pComp = createProgram(gl, QUAD_VS, COMPOSITE_FS, 'composite');

        if (!pScene || !pWater || !pShaft || !pScrim || !pGlyph || !pMote || !pSky || !pBlend || !pExtract || !pBlur || !pComp) {
            this.ready = false;
            return false;
        }
        this.programs = { pScene, pWater, pShaft, pScrim, pGlyph, pMote, pSky, pBlend, pExtract, pBlur, pComp };

        this.uploadSceneGeometry(sceneBundle);
        this._buildDynamicGlyphVao();
        this._buildScrimAndQuadVaos();
        this._buildMoteVao();
        this._fboWidth = 0; // 强制在首次 renderFrame 时重建尺寸匹配 FBO

        this.ready = true;
        return true;
    }

    _createSceneMeshVao(mesh) {
        const gl = this.gl;
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);

        const vboPos = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vboPos);
        gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

        const vboNorm = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vboNorm);
        gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

        const vboUv = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vboUv);
        gl.bufferData(gl.ARRAY_BUFFER, mesh.uvs, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);

        const vboMat = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vboMat);
        gl.bufferData(gl.ARRAY_BUFFER, mesh.matIds, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(3);
        gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 0, 0);

        const ibo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

        gl.bindVertexArray(null);
        return { vao, buffers: [vboPos, vboNorm, vboUv, vboMat, ibo], indexCount: mesh.indices.length };
    }

    hasCachedScene(arch) {
        return Boolean(arch && this.sceneCache.has(arch));
    }

    ensureSceneCached(sceneBundle) {
        const gl = this.gl;
        if (!gl || !sceneBundle) return null;
        const arch = sceneBundle.archetype || 'default';
        if (this.sceneCache.has(arch)) {
            return this.sceneCache.get(arch);
        }

        const st = this._createSceneMeshVao(sceneBundle.staticMesh);
        const sh = this._createSceneMeshVao(sceneBundle.shaftMesh);

        const wVao = gl.createVertexArray();
        gl.bindVertexArray(wVao);
        const wVbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, wVbo);
        gl.bufferData(gl.ARRAY_BUFFER, sceneBundle.waterMesh.positions, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        const wIbo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wIbo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, sceneBundle.waterMesh.indices, gl.STATIC_DRAW);
        gl.bindVertexArray(null);
        const water = { vao: wVao, buffers: [wVbo, wIbo], indexCount: sceneBundle.waterMesh.indices.length };

        const dynamicMeshes = (sceneBundle.dynamicParts || []).map((part) => ({
            ...part,
            gpu: this._createSceneMeshVao(part.mesh),
        }));

        const entry = { archetype: arch, static: st, shaft: sh, water, dynamicMeshes, bundle: sceneBundle };
        this.sceneCache.set(arch, entry);
        return entry;
    }

    _bindSceneEntry(entry) {
        if (!entry) return;
        this.vaos.static = entry.static;
        this._staticIdxCount = entry.static.indexCount;
        this.vaos.shaft = entry.shaft;
        this._shaftIdxCount = entry.shaft.indexCount;
        this.vaos.water = entry.water;
        this._waterIdxCount = entry.water.indexCount;
        this.dynamicMeshes = entry.dynamicMeshes;
        this._activeSceneArch = entry.archetype;
    }

    uploadSceneGeometry(sceneBundle) {
        const gl = this.gl;
        if (!gl || !sceneBundle) return;
        this._lastSceneBundle = sceneBundle;
        const entry = this.ensureSceneCached(sceneBundle);
        this._bindSceneEntry(entry);
    }

    _buildDynamicGlyphVao() {
        const gl = this.gl;
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        const vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, this.glyphFloats.byteLength, gl.DYNAMIC_DRAW);

        const stride = GLYPH_FLOATS_PER_VERT * 4;
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 12);
        gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 20);
        gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 36);
        gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 52);
        gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 1, gl.FLOAT, false, stride, 56);

        const ibo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.glyphIndices, gl.STATIC_DRAW);

        gl.bindVertexArray(null);
        this.vaos.glyph = { vao, vbo, ibo };
    }

    _buildScrimAndQuadVaos() {
        const gl = this.gl;

        // Scrim quad
        const sVao = gl.createVertexArray();
        gl.bindVertexArray(sVao);
        const sVbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, sVbo);
        gl.bufferData(gl.ARRAY_BUFFER, this.scrimFloats.byteLength, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
        const sIbo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sIbo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
        gl.bindVertexArray(null);
        this.vaos.scrim = { vao: sVao, vbo: sVbo, ibo: sIbo };

        // Fullscreen Quad
        const qVao = gl.createVertexArray();
        gl.bindVertexArray(qVao);
        const qVbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, qVbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        this.vaos.quad = { vao: qVao, vbo: qVbo };
    }

    _buildMoteVao() {
        const gl = this.gl;
        const count = this._moteCount;
        const instData = new Float32Array(count * 5);
        for (let i = 0; i < count; i++) {
            const s1 = Math.sin(i * 12.9898) * 43758.5453;
            const s2 = Math.sin(i * 78.233 + 1.7) * 29431.1273;
            const s3 = Math.sin(i * 39.425 + 4.2) * 19283.7192;
            const r1 = s1 - Math.floor(s1);
            const r2 = s2 - Math.floor(s2);
            const r3 = s3 - Math.floor(s3);
            // 把浮尘沿中央和侧廊分布
            instData[i * 5 + 0] = (r1 - 0.5) * 11.5;
            instData[i * 5 + 1] = 0.6 + r2 * 6.8;
            instData[i * 5 + 2] = -12.8 + r3 * 16.5;
            instData[i * 5 + 3] = 0.022 + ((i * 7) % 13) * 0.004;
            instData[i * 5 + 4] = r1 * 1.3 + r2 * 0.7;
        }

        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        const cornerVbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, cornerVbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

        const instVbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, instVbo);
        gl.bufferData(gl.ARRAY_BUFFER, instData, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 20, 0); gl.vertexAttribDivisor(1, 1);
        gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 20, 12); gl.vertexAttribDivisor(2, 1);
        gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 20, 16); gl.vertexAttribDivisor(3, 1);

        gl.bindVertexArray(null);
        this.vaos.mote = { vao, buffers: [cornerVbo, instVbo], count };
    }

    _makeColorFbo(w, h, useFloat, withDepth) {
        const gl = this.gl;
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);

        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        const intFmt = useFloat ? gl.RGBA16F : gl.RGBA8;
        const type = useFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
        gl.texImage2D(gl.TEXTURE_2D, 0, intFmt, w, h, 0, gl.RGBA, type, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

        let depthRb = null;
        if (withDepth) {
            depthRb = gl.createRenderbuffer();
            gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
            gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb);
        }

        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            gl.deleteFramebuffer(fbo);
            gl.deleteTexture(tex);
            if (depthRb) gl.deleteRenderbuffer(depthRb);
            return null;
        }
        return { fbo, tex, depthRb, w, h };
    }

    _ensureFbos(w, h, enableReflect, enableBloom) {
        if (this._fboWidth === w && this._fboHeight === h
            && Boolean(this.fbos.reflect) === enableReflect
            && Boolean(this.fbos.bloomA) === enableBloom) {
            return;
        }
        this._disposeFbos();
        this._fboWidth = w;
        this._fboHeight = h;

        // 优先尝试 RGBA16F HDR FBO，不兼容时无缝回退 RGBA8
        let scene = this.hasFloatFbo ? this._makeColorFbo(w, h, true, true) : null;
        if (!scene) scene = this._makeColorFbo(w, h, false, true);
        this.fbos.scene = scene;

        if (enableReflect) {
            const rw = Math.max(64, Math.floor(w * 0.5));
            const rh = Math.max(64, Math.floor(h * 0.5));
            this.fbos.reflect = this._makeColorFbo(rw, rh, false, true);
        }
        if (enableBloom) {
            const bw = Math.max(32, Math.floor(w * 0.25));
            const bh = Math.max(32, Math.floor(h * 0.25));
            let bA = this.hasFloatFbo ? this._makeColorFbo(bw, bh, true, false) : null;
            if (!bA) bA = this._makeColorFbo(bw, bh, false, false);
            let bB = this.hasFloatFbo ? this._makeColorFbo(bw, bh, true, false) : null;
            if (!bB) bB = this._makeColorFbo(bw, bh, false, false);
            this.fbos.bloomA = bA;
            this.fbos.bloomB = bB;
        }
    }

    prewarmTransitionFbos() {
        if (!this.gl || !this.ready || this.contextLost) return false;
        if (this._fboWidth <= 0 || this._fboHeight <= 0) return false;
        return this._ensureTransitionFbos(this._fboWidth, this._fboHeight);
    }

    _ensureTransitionFbos(w, h) {
        if (this.fbos.sceneFrom && this.fbos.sceneTo
            && this.fbos.sceneFrom.w === w && this.fbos.sceneFrom.h === h) {
            return true;
        }
        for (const key of ['sceneFrom', 'sceneTo']) {
            const old = this.fbos[key];
            if (old) {
                if (old.fbo) this.gl.deleteFramebuffer(old.fbo);
                if (old.tex) this.gl.deleteTexture(old.tex);
                if (old.depthRb) this.gl.deleteRenderbuffer(old.depthRb);
                this.fbos[key] = null;
            }
        }
        let fA = this.hasFloatFbo ? this._makeColorFbo(w, h, true, true) : null;
        if (!fA) fA = this._makeColorFbo(w, h, false, true);
        let fB = this.hasFloatFbo ? this._makeColorFbo(w, h, true, true) : null;
        if (!fB) fB = this._makeColorFbo(w, h, false, true);
        this.fbos.sceneFrom = fA;
        this.fbos.sceneTo = fB;
        return Boolean(fA && fB);
    }

    /**
     * 更新 3D 雕刻文字四边体流与保护衬底坐标
     */
    uploadGlyphQuads(glyphQuads = [], scrimQuad = null) {
        const gl = this.gl;
        if (!gl || !this.vaos.glyph) return;
        const count = Math.min(MAX_GLYPH_QUADS, glyphQuads.length);
        this.activeGlyphCount = count;
        const dst = this.glyphFloats;

        for (let i = 0; i < count; i++) {
            const q = glyphQuads[i];
            const baseRgb = q.baseRgb || [0.92, 0.89, 0.84];
            const sungRgb = q.sungRgb || [1.0, 0.88, 0.58];
            const br = toLinear(baseRgb[0]), bg = toLinear(baseRgb[1]), bb = toLinear(baseRgb[2]);
            const sr = toLinear(sungRgb[0]), sg = toLinear(sungRgb[1]), sb = toLinear(sungRgb[2]);
            const ba = q.baseAlpha ?? 0.96;
            const sa = q.sungAlpha ?? 1.0;
            const prog = clamp(q.prog ?? 0, 0, 1);
            const enter = clamp(q.enter ?? 1, 0, 1);
            const [u0, v0, u1, v1] = q.uvRect;

            const corners = [
                { p: q.bl, u: u0, v: v1 },
                { p: q.br, u: u1, v: v1 },
                { p: q.tr, u: u1, v: v0 },
                { p: q.tl, u: u0, v: v0 },
            ];
            for (let k = 0; k < 4; k++) {
                const o = (i * 4 + k) * GLYPH_FLOATS_PER_VERT;
                const c = corners[k];
                dst[o + 0] = c.p[0]; dst[o + 1] = c.p[1]; dst[o + 2] = c.p[2];
                dst[o + 3] = c.u;    dst[o + 4] = c.v;
                dst[o + 5] = br;     dst[o + 6] = bg;     dst[o + 7] = bb; dst[o + 8] = ba;
                dst[o + 9] = sr;     dst[o + 10] = sg;    dst[o + 11] = sb; dst[o + 12] = sa;
                dst[o + 13] = prog;
                dst[o + 14] = enter;
            }
        }
        if (count > 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this.vaos.glyph.vbo);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, dst.subarray(0, count * 4 * GLYPH_FLOATS_PER_VERT));
        }

        if (scrimQuad && this.vaos.scrim) {
            const s = this.scrimFloats;
            const pts = [
                { p: scrimQuad.bl, u: 0, v: 0 },
                { p: scrimQuad.br, u: 1, v: 0 },
                { p: scrimQuad.tr, u: 1, v: 1 },
                { p: scrimQuad.tl, u: 0, v: 1 },
            ];
            for (let k = 0; k < 4; k++) {
                const o = k * 5;
                s[o + 0] = pts[k].p[0]; s[o + 1] = pts[k].p[1]; s[o + 2] = pts[k].p[2];
                s[o + 3] = pts[k].u;    s[o + 4] = pts[k].v;
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, this.vaos.scrim.vbo);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, s);
            this._hasScrim = true;
        } else {
            this._hasScrim = false;
        }
    }

    renderFrame(params) {
        const gl = this.gl;
        if (!gl || !this.ready || this.contextLost) return false;

        const w = Math.max(64, Math.floor(params.renderWidth || this.canvas.width));
        const h = Math.max(64, Math.floor(params.renderHeight || this.canvas.height));
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
        }

        const enableReflect = Boolean(params.enableReflection && params.qualityTier !== 'lite');
        const enableBloom = Boolean(params.qualityTier !== 'lite' && params.lighting > 0.08);
        this._ensureFbos(w, h, enableReflect, enableBloom);
        if (!this.fbos.scene) return false;

        const pal = params.palette;
        const cam = params.camera;
        const proj = mat4Perspective((cam.fovDeg * Math.PI) / 180, w / Math.max(1, h), 0.15, 70.0);
        const view = mat4LookAt(cam.eye, cam.target, cam.up);
        const viewProj = mat4Multiply(proj, view);
        const identModel = mat4Identity();
        const identNorm = mat3NormalFromMat4(identModel);

        const buildPassTheme = (p) => {
            const lightFactor = Number.isFinite(p.lightMix) ? clamp(p.lightMix, 0, 1) : (p.isLight ? 1.0 : 0.0);
            return {
                pal: p,
                cStoneBase: hexToLinearVec3(p.stoneBase),
                cStoneTrim: hexToLinearVec3(p.stoneTrim),
                cMetal: hexToLinearVec3(p.metal),
                cGlassA: hexToLinearVec3(p.glassA),
                cGlassB: hexToLinearVec3(p.glassB),
                cGlassC: hexToLinearVec3(p.glassC),
                cKey: hexToLinearVec3(p.lightColor),
                cFill: hexToLinearVec3(p.fillColor),
                cFogHorizon: hexToLinearVec3(p.bgHorizon),
                cFogZenith: hexToLinearVec3(p.bgTop),
                cWater: hexToLinearVec3(p.waterTint),
                isLight: lightFactor,
                cShadow: [
                    0.008 + (0.85 - 0.008) * lightFactor,
                    0.010 + (0.80 - 0.010) * lightFactor,
                    0.015 + (0.71 - 0.015) * lightFactor,
                ],
            };
        };

        const mainTheme = buildPassTheme(pal);
        const isLight = mainTheme.isLight;

        const time = params.timeSec || 0;
        const bass = params.audio?.bass || 0;
        const mid = params.audio?.mid || 0;
        const treble = params.audio?.treble || 0;
        const pt0Pos = params.pointLights?.[0]?.pos || [0, 2.5, -3.0];
        const pt0Rgb = params.pointLights?.[0]?.rgb || mainTheme.cKey;
        const pt1Pos = params.pointLights?.[1]?.pos || [0, 4.2, -9.5];
        const pt1Rgb = params.pointLights?.[1]?.rgb || mainTheme.cGlassA;

        const drawGlyphs = (mirrorSign, theme) => {
            if (this.activeGlyphCount <= 0 || !params.atlasTexture) return;
            const pG = this.programs.pGlyph;
            gl.useProgram(pG.program);
            gl.uniformMatrix4fv(pG.u.uViewProj, false, viewProj);
            gl.uniform1f(pG.u.uMirrorSign, mirrorSign);
            gl.uniform3fv(pG.u.uCamPos, cam.eye);
            gl.uniform3fv(pG.u.uKeyColor, theme.cKey);
            gl.uniform3fv(pG.u.uBackdropShadow, theme.cShadow);
            gl.uniform1f(pG.u.uIsLightMode, theme.isLight);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, params.atlasTexture);
            gl.uniform1i(pG.u.uSdfAtlas, 0);

            gl.bindVertexArray(this.vaos.glyph.vao);
            gl.drawElements(gl.TRIANGLES, this.activeGlyphCount * 6, gl.UNSIGNED_SHORT, 0);
        };

        const drawArchitectureAndGlyphs = (mirrorSign, theme, drawReflectedGlyphs) => {
            const pScene = this.programs.pScene;
            gl.useProgram(pScene.program);
            gl.uniformMatrix4fv(pScene.u.uViewProj, false, viewProj);
            gl.uniform3fv(pScene.u.uCamPos, cam.eye);
            gl.uniform1f(pScene.u.uTime, time);
            gl.uniform1f(pScene.u.uMirrorSign, mirrorSign);
            gl.uniform1f(pScene.u.uAudioBass, bass);
            gl.uniform1f(pScene.u.uAudioMid, mid);
            gl.uniform1f(pScene.u.uAudioTreble, treble);
            gl.uniform1f(pScene.u.uLighting, params.lighting);

            gl.uniform3fv(pScene.u.uStoneBase, theme.cStoneBase);
            gl.uniform3fv(pScene.u.uStoneTrim, theme.cStoneTrim);
            gl.uniform3fv(pScene.u.uMetalColor, theme.cMetal);
            gl.uniform3fv(pScene.u.uGlassA, theme.cGlassA);
            gl.uniform3fv(pScene.u.uGlassB, theme.cGlassB);
            gl.uniform3fv(pScene.u.uGlassC, theme.cGlassC);
            gl.uniform3fv(pScene.u.uKeyColor, theme.cKey);
            gl.uniform3fv(pScene.u.uFillColor, theme.cFill);
            gl.uniform3fv(pScene.u.uFogHorizon, theme.cFogHorizon);
            gl.uniform3fv(pScene.u.uFogZenith, theme.cFogZenith);
            gl.uniform1f(pScene.u.uFogDensity, theme.pal.fogDensity);
            gl.uniform1f(pScene.u.uIsLightMode, theme.isLight);
            if (pScene.u.uArchStyle) {
                const archIdx = Math.max(0, VITRAIL_ARCHETYPES.indexOf(this._activeSceneArch));
                gl.uniform1f(pScene.u.uArchStyle, archIdx);
            }
            gl.uniform3fv(pScene.u.uPoint0Pos, pt0Pos);
            gl.uniform3fv(pScene.u.uPoint0Color, pt0Rgb);
            gl.uniform3fv(pScene.u.uPoint1Pos, pt1Pos);
            gl.uniform3fv(pScene.u.uPoint1Color, pt1Rgb);

            // 静态主架构
            gl.uniformMatrix4fv(pScene.u.uModel, false, identModel);
            gl.uniformMatrix3fv(pScene.u.uNormalMat, false, identNorm);
            gl.bindVertexArray(this.vaos.static.vao);
            gl.drawElements(gl.TRIANGLES, this._staticIdxCount, gl.UNSIGNED_INT, 0);

            // 动态构件（浑天铜环 / 漂浮棱晶）
            for (const dp of this.dynamicMeshes) {
                const pos = [
                    dp.pivot[0],
                    dp.pivot[1] + (dp.bobAmp ? Math.sin(time * 0.9 + dp.pivot[0]) * dp.bobAmp * (1 + bass * 0.4) : 0),
                    dp.pivot[2],
                ];
                const rot = [
                    dp.baseRot[0] + time * dp.spinRate[0],
                    dp.baseRot[1] + time * dp.spinRate[1] + mid * 0.25,
                    dp.baseRot[2] + time * dp.spinRate[2],
                ];
                const mMat = mat4ModelTransform(pos, rot);
                gl.uniformMatrix4fv(pScene.u.uModel, false, mMat);
                gl.uniformMatrix3fv(pScene.u.uNormalMat, false, mat3NormalFromMat4(mMat));
                gl.bindVertexArray(dp.gpu.vao);
                gl.drawElements(gl.TRIANGLES, dp.gpu.indexCount, gl.UNSIGNED_INT, 0);
            }

            // 倒影中也绘制立体 SDF 歌词（主场景则在透明混合段单独画并配保护衬底）
            if (drawReflectedGlyphs && mirrorSign < 0 && this.activeGlyphCount > 0 && params.atlasTexture) {
                gl.enable(gl.BLEND);
                gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
                gl.depthMask(false);
                drawGlyphs(mirrorSign, theme);
                gl.depthMask(true);
                gl.disable(gl.BLEND);
            }
        };

        const drawSkyBackdrop = (mirrorSign, theme) => {
            const pSky = this.programs.pSky;
            if (!pSky || !this.vaos.quad) return;
            gl.disable(gl.DEPTH_TEST);
            gl.depthMask(false);
            gl.disable(gl.CULL_FACE);
            gl.useProgram(pSky.program);
            gl.uniform3fv(pSky.u.uFogHorizon, theme.cFogHorizon);
            gl.uniform3fv(pSky.u.uFogZenith, theme.cFogZenith);
            gl.uniform3fv(pSky.u.uGlassA, theme.cGlassA);
            gl.uniform3fv(pSky.u.uGlassB, theme.cGlassB);
            gl.uniform1f(pSky.u.uMirrorSign, mirrorSign);
            gl.uniform1f(pSky.u.uIsLightMode, theme.isLight);
            if (pSky.u.uArchStyle) {
                const archIdx = Math.max(0, VITRAIL_ARCHETYPES.indexOf(this._activeSceneArch));
                gl.uniform1f(pSky.u.uArchStyle, archIdx);
            }
            if (pSky.u.uTime) gl.uniform1f(pSky.u.uTime, time);
            gl.bindVertexArray(this.vaos.quad.vao);
            gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
            gl.enable(gl.CULL_FACE);
            gl.depthMask(true);
            gl.enable(gl.DEPTH_TEST);
        };

        const drawWorldIntoFbo = (targetFbo, entry, theme, drawReflectedGlyphs) => {
            this._bindSceneEntry(entry);
            gl.enable(gl.DEPTH_TEST);
            gl.depthFunc(gl.LEQUAL);
            gl.enable(gl.CULL_FACE);
            gl.depthMask(true);
            gl.disable(gl.BLEND);

            // ===== Pass 1: 水面镜面反射渲染到 Reflect FBO =====
            if (enableReflect && this.fbos.reflect) {
                const rf = this.fbos.reflect;
                gl.bindFramebuffer(gl.FRAMEBUFFER, rf.fbo);
                gl.viewport(0, 0, rf.w, rf.h);
                gl.clearColor(theme.cFogHorizon[0], theme.cFogHorizon[1], theme.cFogHorizon[2], 1.0);
                gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
                drawSkyBackdrop(-1.0, theme);
                // Y 翻转镜像会逆转缠绕，临时设 frontFace(CW) 保证正面不被背面剔除误杀！
                gl.frontFace(gl.CW);
                drawArchitectureAndGlyphs(-1.0, theme, drawReflectedGlyphs);
                gl.frontFace(gl.CCW);
            }

            // ===== Pass 2: 主 3D 圣殿渲染到目标 Scene FBO =====
            gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo.fbo);
            gl.viewport(0, 0, targetFbo.w, targetFbo.h);
            gl.clearColor(theme.cFogZenith[0], theme.cFogZenith[1], theme.cFogZenith[2], 1.0);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            gl.frontFace(gl.CCW);
            drawSkyBackdrop(1.0, theme);

            drawArchitectureAndGlyphs(1.0, theme, false);

            // 2B: 中央水镜着色（采样反射 FBO + 实时波纹 + 动态点光源倒影）
            if (this.vaos.water) {
                const pW = this.programs.pWater;
                gl.useProgram(pW.program);
                gl.uniformMatrix4fv(pW.u.uViewProj, false, viewProj);
                gl.uniform3fv(pW.u.uCamPos, cam.eye);
                gl.uniform1f(pW.u.uTime, time);
                gl.uniform1f(pW.u.uAudioBass, bass);
                gl.uniform1f(pW.u.uAudioMid, mid);
                gl.uniform1f(pW.u.uLighting, params.lighting);
                if (pW.u.uArchStyle) {
                    const archIdx = Math.max(0, VITRAIL_ARCHETYPES.indexOf(this._activeSceneArch));
                    gl.uniform1f(pW.u.uArchStyle, archIdx);
                }
                gl.uniform3fv(pW.u.uWaterTint, theme.cWater);
                gl.uniform3fv(pW.u.uFogHorizon, theme.cFogHorizon);
                gl.uniform3fv(pW.u.uFogZenith, theme.cFogZenith);
                gl.uniform3fv(pW.u.uGlassA, theme.cGlassA);
                gl.uniform3fv(pW.u.uGlassB, theme.cGlassB);
                gl.uniform3fv(pW.u.uKeyColor, theme.cKey);
                gl.uniform3fv(pW.u.uPoint0Pos, pt0Pos);
                gl.uniform3fv(pW.u.uPoint0Color, pt0Rgb);
                gl.uniform3fv(pW.u.uPoint1Pos, pt1Pos);
                gl.uniform3fv(pW.u.uPoint1Color, pt1Rgb);
                gl.uniform1f(pW.u.uHasReflect, (enableReflect && this.fbos.reflect) ? 1.0 : 0.0);
                if (enableReflect && this.fbos.reflect) {
                    gl.activeTexture(gl.TEXTURE0);
                    gl.bindTexture(gl.TEXTURE_2D, this.fbos.reflect.tex);
                    gl.uniform1i(pW.u.uReflectTex, 0);
                }
                gl.bindVertexArray(this.vaos.water.vao);
                gl.drawElements(gl.TRIANGLES, this._waterIdxCount, gl.UNSIGNED_INT, 0);
            }

            // 2C: 圣光光束属于建筑光场，随各自场景一同溶解过渡
            if (params.lighting > 0.05 && this.vaos.shaft && this._shaftIdxCount > 0) {
                gl.enable(gl.BLEND);
                gl.depthMask(false);
                gl.disable(gl.CULL_FACE);
                gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
                const pSh = this.programs.pShaft;
                gl.useProgram(pSh.program);
                gl.uniformMatrix4fv(pSh.u.uViewProj, false, viewProj);
                gl.uniform1f(pSh.u.uTime, time);
                gl.uniform1f(pSh.u.uLighting, params.lighting * (1.0 - 0.48 * theme.isLight));
                gl.uniform1f(pSh.u.uAudioMid, mid);
                gl.uniform1f(pSh.u.uAudioBass, bass);
                gl.uniform3fv(pSh.u.uKeyColor, theme.cKey);
                gl.uniform3fv(pSh.u.uGlassA, theme.cGlassA);
                gl.uniform3fv(pSh.u.uGlassB, theme.cGlassB);
                gl.bindVertexArray(this.vaos.shaft.vao);
                gl.drawElements(gl.TRIANGLES, this._shaftIdxCount, gl.UNSIGNED_INT, 0);
                gl.depthMask(true);
                gl.enable(gl.CULL_FACE);
                gl.disable(gl.BLEND);
            }
        };

        const targetArch = params.toArch || this._activeSceneArch || this._lastSceneBundle?.archetype;
        const sourceArch = params.fromArch || targetArch;
        const sceneMix = params.sceneMix === undefined ? 1.0 : clamp(Number(params.sceneMix), 0, 1);
        const canQueryBundle = typeof params.getSceneBundle === 'function';
        let toEntry = (targetArch && this.sceneCache.get(targetArch))
            || (targetArch && canQueryBundle ? this.ensureSceneCached(params.getSceneBundle(targetArch)) : null);
        if (!toEntry && this._lastSceneBundle) {
            toEntry = this.ensureSceneCached(this._lastSceneBundle);
        }
        if (!toEntry) return false;

        let fromEntry = null;
        if (sourceArch && sourceArch !== toEntry.archetype && sceneMix < 0.998) {
            fromEntry = this.sceneCache.get(sourceArch)
                || (canQueryBundle ? this.ensureSceneCached(params.getSceneBundle(sourceArch)) : null);
        }

        const sf = this.fbos.scene;
        const hasDiffSource = Boolean(fromEntry && fromEntry !== toEntry);
        const useDualFbo = Boolean(
            hasDiffSource
            && sceneMix > 0.002
            && sceneMix < 0.998
            && this._ensureTransitionFbos(w, h),
        );

        if (useDualFbo) {
            const themeA = params.palA ? buildPassTheme(params.palA) : mainTheme;
            const themeB = params.palB ? buildPassTheme(params.palB) : mainTheme;
            drawWorldIntoFbo(this.fbos.sceneFrom, fromEntry, themeA, true);
            drawWorldIntoFbo(this.fbos.sceneTo, toEntry, themeB, true);
            this._bindSceneEntry(toEntry);

            gl.bindFramebuffer(gl.FRAMEBUFFER, sf.fbo);
            gl.viewport(0, 0, sf.w, sf.h);
            gl.disable(gl.DEPTH_TEST);
            gl.depthMask(false);
            gl.disable(gl.CULL_FACE);
            gl.disable(gl.BLEND);

            const pBl = this.programs.pBlend;
            gl.useProgram(pBl.program);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.fbos.sceneFrom.tex);
            gl.uniform1i(pBl.u.uTexA, 0);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, this.fbos.sceneTo.tex);
            gl.uniform1i(pBl.u.uTexB, 1);
            gl.uniform1f(pBl.u.uMix, sceneMix);
            gl.uniform3fv(pBl.u.uMistColor, mainTheme.cFogHorizon);
            gl.uniform3fv(pBl.u.uAccentColor, mainTheme.cGlassA);
            gl.uniform1f(pBl.u.uTime, time);

            gl.bindVertexArray(this.vaos.quad.vao);
            gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);

            // 仅清空深度，保持混合后的背景色完整，使 3D 歌词与浮尘单层锐利叠加零重影
            gl.depthMask(true);
            gl.clear(gl.DEPTH_BUFFER_BIT);
            gl.enable(gl.DEPTH_TEST);
        } else if (hasDiffSource && sceneMix <= 0.002) {
            // 修复溶解起点前 ~140ms 因 smootherstep < 0.002 误切到目标场景的闪屏跳变
            const themeA = params.palA ? buildPassTheme(params.palA) : mainTheme;
            drawWorldIntoFbo(sf, fromEntry, themeA, true);
        } else {
            drawWorldIntoFbo(sf, toEntry, mainTheme, true);
        }

        // 2D: 空中悬浮浮尘 + 歌词背后柔光可读性保护衬底 + 3D SDF 雕刻歌词主体（全屏单一通道）
        gl.enable(gl.BLEND);
        gl.depthMask(false);
        gl.disable(gl.CULL_FACE);

        if (params.enableParticles && this.vaos.mote) {
            gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
            const pM = this.programs.pMote;
            gl.useProgram(pM.program);
            gl.uniformMatrix4fv(pM.u.uView, false, view);
            gl.uniformMatrix4fv(pM.u.uProj, false, proj);
            gl.uniform1f(pM.u.uTime, time);
            gl.uniform1f(pM.u.uAudioTreble, treble);
            gl.uniform3fv(pM.u.uKeyColor, mainTheme.cKey);
            gl.uniform3fv(pM.u.uGlassA, mainTheme.cGlassA);
            const drawMotes = params.qualityTier === 'high' ? this.vaos.mote.count : Math.floor(this.vaos.mote.count * 0.55);
            gl.bindVertexArray(this.vaos.mote.vao);
            gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, drawMotes);
        }

        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
        if (this._hasScrim && this.vaos.scrim && this.activeGlyphCount > 0) {
            const pSc = this.programs.pScrim;
            gl.useProgram(pSc.program);
            gl.uniformMatrix4fv(pSc.u.uViewProj, false, viewProj);
            gl.uniform3fv(pSc.u.uScrimColor, [
                0.008 + (0.76 - 0.008) * isLight,
                0.011 + (0.70 - 0.011) * isLight,
                0.018 + (0.59 - 0.018) * isLight,
            ]);
            gl.uniform1f(pSc.u.uAlpha, 0.44 - 0.08 * isLight);
            gl.bindVertexArray(this.vaos.scrim.vao);
            gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
        }

        if (this.activeGlyphCount > 0 && params.atlasTexture) {
            drawGlyphs(1.0, mainTheme);
        }

        gl.depthMask(true);
        gl.enable(gl.CULL_FACE);
        gl.disable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);

        // ===== Pass 3: 1/4 分辨率阈值泛光提取与两轮模糊 =====
        let bloomTex = sf.tex;
        let bloomStrength = 0.0;
        if (enableBloom && this.fbos.bloomA && this.fbos.bloomB) {
            const bA = this.fbos.bloomA;
            const bB = this.fbos.bloomB;
            gl.bindVertexArray(this.vaos.quad.vao);

            // Extract bright highlights
            gl.bindFramebuffer(gl.FRAMEBUFFER, bA.fbo);
            gl.viewport(0, 0, bA.w, bA.h);
            const pEx = this.programs.pExtract;
            gl.useProgram(pEx.program);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, sf.tex);
            gl.uniform1i(pEx.u.uSceneTex, 0);
            const baseThresh = (this.hasFloatFbo ? 0.78 : 0.64) + ((this.hasFloatFbo ? 0.98 : 0.90) - (this.hasFloatFbo ? 0.78 : 0.64)) * isLight;
            gl.uniform1f(pEx.u.uThreshold, baseThresh);
            gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);

            // Horizontal + Vertical Kawase blur passes
            const pBl = this.programs.pBlur;
            gl.useProgram(pBl.program);
            const passes = [
                { src: bA, dst: bB, step: [1.0 / bA.w, 0] },
                { src: bB, dst: bA, step: [0, 1.0 / bB.h] },
                { src: bA, dst: bB, step: [2.0 / bA.w, 0] },
                { src: bB, dst: bA, step: [0, 2.0 / bB.h] },
            ];
            for (const ps of passes) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, ps.dst.fbo);
                gl.viewport(0, 0, ps.dst.w, ps.dst.h);
                gl.bindTexture(gl.TEXTURE_2D, ps.src.tex);
                gl.uniform1i(pBl.u.uTex, 0);
                gl.uniform2f(pBl.u.uTexelStep, ps.step[0], ps.step[1]);
                gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
            }
            bloomTex = bA.tex;
            bloomStrength = clamp(params.lighting * 0.34 * (pal.bloomBoost ?? 1.0), 0.0, 0.72);
        }

        // ===== Pass 4: 最终 ACES Filmic 色调映射输出至主屏幕 =====
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, w, h);
        const pC = this.programs.pComp;
        gl.useProgram(pC.program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, sf.tex);
        gl.uniform1i(pC.u.uSceneTex, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, bloomTex);
        gl.uniform1i(pC.u.uBloomTex, 1);
        gl.uniform1f(pC.u.uBloomStrength, bloomStrength);
        gl.uniform1f(pC.u.uTime, time);
        gl.uniform1f(pC.u.uGrain, params.qualityTier === 'lite' ? 0.0 : 0.012);
        gl.uniform1f(pC.u.uIsLightMode, isLight);

        gl.bindVertexArray(this.vaos.quad.vao);
        gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
        gl.bindVertexArray(null);
        return true;
    }

    _clearSceneMeshes() {
        const gl = this.gl;
        if (!gl) return;
        const del = (m) => {
            if (!m) return;
            if (m.vao) gl.deleteVertexArray(m.vao);
            for (const b of (m.buffers || [])) gl.deleteBuffer(b);
        };
        for (const entry of this.sceneCache.values()) {
            del(entry.static);
            del(entry.water);
            del(entry.shaft);
            for (const dp of (entry.dynamicMeshes || [])) del(dp.gpu);
        }
        this.sceneCache.clear();
        this.vaos.static = null;
        this.vaos.water = null;
        this.vaos.shaft = null;
        this.dynamicMeshes = [];
        this._activeSceneArch = null;
    }

    _disposeFbos() {
        const gl = this.gl;
        if (!gl) return;
        for (const k of Object.keys(this.fbos)) {
            const f = this.fbos[k];
            if (!f) continue;
            if (f.fbo) gl.deleteFramebuffer(f.fbo);
            if (f.tex) gl.deleteTexture(f.tex);
            if (f.depthRb) gl.deleteRenderbuffer(f.depthRb);
        }
        this.fbos = {};
    }

    _disposeGpuObjects(removeListeners = true) {
        const gl = this.gl;
        if (removeListeners && this.canvas) {
            if (this._onLost) this.canvas.removeEventListener('webglcontextlost', this._onLost);
            if (this._onRestored) this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
        }
        if (!gl) return;
        this._clearSceneMeshes();
        this._disposeFbos();
        if (this.vaos.glyph) {
            gl.deleteVertexArray(this.vaos.glyph.vao);
            gl.deleteBuffer(this.vaos.glyph.vbo);
            gl.deleteBuffer(this.vaos.glyph.ibo);
        }
        if (this.vaos.scrim) {
            gl.deleteVertexArray(this.vaos.scrim.vao);
            gl.deleteBuffer(this.vaos.scrim.vbo);
            gl.deleteBuffer(this.vaos.scrim.ibo);
        }
        if (this.vaos.quad) {
            gl.deleteVertexArray(this.vaos.quad.vao);
            gl.deleteBuffer(this.vaos.quad.vbo);
        }
        if (this.vaos.mote) {
            gl.deleteVertexArray(this.vaos.mote.vao);
            for (const b of (this.vaos.mote.buffers || [])) gl.deleteBuffer(b);
        }
        this.vaos = {};
        for (const k of Object.keys(this.programs)) {
            if (this.programs[k]?.program) gl.deleteProgram(this.programs[k].program);
        }
        this.programs = {};
    }

    destroy() {
        this._disposeGpuObjects(true);
        this.ready = false;
        this.gl = null;
        this.canvas = null;
    }
}
