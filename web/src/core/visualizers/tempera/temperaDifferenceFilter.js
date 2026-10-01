/**
 * 机械移植自 chthollyphile/folia-major src/components/visualizer/tempera/temperaDifferenceFilter.ts
 * 逐行保真移植：仅删除类型标注，不改任何逻辑/数值/分支。
 * （type PixiModule / type Filter 类型导入与 TemperaDifferenceOptions 接口已随 TypeScript
 *  类型一并移除；shader/glsl 字符串一字未改。）
 */
// 副作用 import 说明：上游无 'pixi.js/advanced-blend-modes' 等副作用导入。
// pixi.js 改为注入/全量 bundle 引用：本文件仅以首参 pixi（pixi.js 模块对象）使用
// UniformGroup / Filter / GlProgram / Texture.EMPTY，不直接 import vendor 路径。

import { parseColorChannels } from '../../../utils/colorMix.js';

// src/components/visualizer/tempera/temperaDifferenceFilter.ts
// Single-pass threshold inversion for the lyric layer: it samples the already-rendered
// artwork underneath and paints each text pixel in whichever of ink/paper contrasts more,
// giving the print-registration look without hand-picking a fill color per shot kind.
//
// It is also the only thing that colors the lyric in gradient mode - the ramp rides along as a
// tint. So the filter has a second, tint-only form for when the user switches the inversion
// off: same ramp, no backdrop read. Dropping the filter entirely there would silently take
// gradient mode's colour with it and leave flat ink text.

const vertex = `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

void main(void) {
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    gl_Position = vec4(position, 0.0, 1.0);
    vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
}
`;

// Shared by both forms: everything except the backdrop read and the colour decision.
const fragmentHead = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform highp vec4 uInputSize;
uniform highp vec4 uOutputFrame;
uniform vec3 uInkColor;
uniform vec3 uPaperColor;
uniform float uInkLuminance;
uniform float uPaperLuminance;
uniform float uBias;
uniform vec3 uTintA;
uniform vec3 uTintB;
uniform vec3 uTintC;
uniform vec3 uTintD;
uniform float uTintAmount;
uniform float uMinContrast;

// Four-stop ramp sampled across the filter's own bounds, so the colour sweeps the whole line
// rather than repeating inside every glyph.
vec3 sampleTint(float position) {
    float scaled = clamp(position, 0.0, 1.0) * 3.0;
    if (scaled < 1.0) return mix(uTintA, uTintB, scaled);
    if (scaled < 2.0) return mix(uTintB, uTintC, scaled - 1.0);
    return mix(uTintC, uTintD, scaled - 2.0);
}

float tintPosition(vec2 uv) {
    return clamp(uv.x * uInputSize.x / max(uOutputFrame.z, 1.0), 0.0, 1.0);
}
`;

const inversionFragment = `${fragmentHead}
uniform sampler2D uBackTexture;

float backLuminance(vec2 uv) {
    vec4 back = texture(uBackTexture, uv);
    // Pixi render targets are premultiplied; undo it before reading brightness.
    vec3 straight = back.rgb / max(back.a, 1e-4);
    float lum = dot(straight, vec3(0.2126, 0.7152, 0.0722));
    // Where nothing has been drawn, the shell background shows through, which is paper.
    return mix(uPaperLuminance, lum, clamp(back.a * 3.0, 0.0, 1.0));
}

void main(void) {
    vec4 front = texture(uTexture, vTextureCoord);
    // A 5-tap average keeps fine hatch from flickering the inversion decision per pixel.
    vec2 texel = uInputSize.zw * 1.5;
    float lum = backLuminance(vTextureCoord) * 0.4
        + (backLuminance(vTextureCoord + texel)
            + backLuminance(vTextureCoord - texel)
            + backLuminance(vTextureCoord + vec2(texel.x, -texel.y))
            + backLuminance(vTextureCoord + vec2(-texel.x, texel.y))) * 0.15;

    float distanceToPaper = abs(lum - uPaperLuminance);
    float distanceToInk = abs(lum - uInkLuminance);
    // Pick the color that sits further from the backdrop so contrast never collapses,
    // whether the theme puts light ink on dark paper or the reverse.
    vec3 tone = mix(uInkColor, uPaperColor, step(distanceToInk + uBias, distanceToPaper));

    /* ★ 2026-10-02 对比度地板（用户实测「圈起来的字与背景区分不开」）：ink/paper
       二选一只保证「较远」，但背景明度落在两者中点附近时，胜出者的距离也只有
       |ink-paper|/2 的一半量级；再叠加 giant watermark/淡色块等中间调背景，
       个别字形会掉进不可读区。此处强制 tone 与背景的明度差 ≥ uMinContrast：
       沿原色相缩放明度推不达标即翻转到黑白端点。 */
    {
        float toneLum = dot(tone, vec3(0.2126, 0.7152, 0.0722));
        float d = abs(toneLum - lum);
        if (d < uMinContrast) {
            float target = toneLum >= lum ? lum + uMinContrast : lum - uMinContrast;
            float gain = clamp(target / max(toneLum, 1e-3), 0.0, 6.0);
            vec3 scaled = clamp(tone * gain, 0.0, 1.0);
            float newLum = dot(scaled, vec3(0.2126, 0.7152, 0.0722));
            tone = abs(newLum - lum) < uMinContrast * 0.75
                ? (toneLum >= lum ? vec3(1.0) : vec3(0.02))
                : scaled;
        }
        /* ★ 二重地板（抗背景误读）：uBackTexture 采样若错位（把块外的亮页面读成
           背景），上面的地板会把字推暗——正落在深块上又不可读。再保证 tone 与
           paper 明度也差 ≥ 地板（paper 是块色阶的暗端），两条同时满足时 tone
           必然落在中间亮区，误读最多损失对比度、不会反向灭掉。 */
        float paperLum = uPaperLuminance;
        float toneLum2 = dot(tone, vec3(0.2126, 0.7152, 0.0722));
        if (abs(toneLum2 - paperLum) < uMinContrast) {
            float target = paperLum < 0.5 ? paperLum + uMinContrast : paperLum - uMinContrast;
            float gain = clamp(target / max(toneLum2, 1e-3), 0.0, 6.0);
            vec3 scaled = clamp(tone * gain, 0.0, 1.0);
            float newLum = dot(scaled, vec3(0.2126, 0.7152, 0.0722));
            tone = abs(newLum - paperLum) < uMinContrast * 0.75
                ? (paperLum < 0.5 ? vec3(1.0) : vec3(0.02))
                : scaled;
        }
    }

    // Colour modes tint that choice instead of replacing it: the hue comes from the ramp, the
    // luminance stays the one the inversion just picked. Colouring the text any other way
    // throws away the only thing guaranteeing it reads against the artwork.
    if (uTintAmount > 0.0) {
        vec3 tint = sampleTint(tintPosition(vTextureCoord));
        float tintLuminance = max(dot(tint, vec3(0.2126, 0.7152, 0.0722)), 1e-3);
        float toneLuminance = dot(tone, vec3(0.2126, 0.7152, 0.0722));
        vec3 matched = clamp(tint * (toneLuminance / tintLuminance), 0.0, 1.0);
        tone = mix(tone, matched, uTintAmount);
    }
    finalColor = vec4(tone * front.a, front.a);
}
`;

// The inversion switched off. No backdrop is copied, so the ramp *is* the colour: the stops
// are already built to clear the paper's luminance by ~88, which is what kept them readable
// when the inversion was only lending them its luminance.
const tintOnlyFragment = `${fragmentHead}
void main(void) {
    vec4 front = texture(uTexture, vTextureCoord);
    vec3 tone = uTintAmount > 0.0 ? sampleTint(tintPosition(vTextureCoord)) : uInkColor;
    /* ★ 2026-10-02 对比度地板（tint-only 路径，用户实测「还是看不清」）：渐变 ramp
       的前段停靠点贴着 paper（暗端），字落在深色块上直接灭掉。这里保证 tone 与
       paper 明度差 ≥ uMinContrast（Aria paper 恒深色 → 实际效果是整体抬亮），
       色相按通道缩放保留。 */
    {
        float paperLum = uPaperLuminance;
        float toneLum = dot(tone, vec3(0.2126, 0.7152, 0.0722));
        if (abs(toneLum - paperLum) < uMinContrast) {
            float target = paperLum < 0.5 ? paperLum + uMinContrast : paperLum - uMinContrast;
            float gain = clamp(target / max(toneLum, 1e-3), 0.0, 6.0);
            vec3 scaled = clamp(tone * gain, 0.0, 1.0);
            float newLum = dot(scaled, vec3(0.2126, 0.7152, 0.0722));
            tone = abs(newLum - paperLum) < uMinContrast * 0.75
                ? (paperLum < 0.5 ? vec3(1.0) : vec3(0.02))
                : scaled;
        }
    }
    finalColor = vec4(tone * front.a, front.a);
}
`;

const REC709 = { r: 0.2126, g: 0.7152, b: 0.0722 };

const toNormalizedRgb = (color, fallback) => {
    const channels = parseColorChannels(color);
    if (!channels) return fallback;
    return [channels.r / 255, channels.g / 255, channels.b / 255];
};

const luminanceOf = (rgb) => (
    rgb[0] * REC709.r + rgb[1] * REC709.g + rgb[2] * REC709.b
);

export const createTemperaDifferenceFilter = (
    pixi,
    options,
) => {
    const ink = toNormalizedRgb(options.ink, [1, 1, 1]);
    const paper = toNormalizedRgb(options.paper, [0, 0, 0]);
    const tint = options.tint && options.tint.length >= 2 ? options.tint : null;
    const stops = Array.from({ length: 4 }, (_, index) => (
        tint ? toNormalizedRgb(tint[Math.min(index, tint.length - 1)], ink) : ink
    ));
    const uniforms = new pixi.UniformGroup({
        uInkColor: { value: new Float32Array(ink), type: 'vec3<f32>' },
        uTintA: { value: new Float32Array(stops[0]), type: 'vec3<f32>' },
        uTintB: { value: new Float32Array(stops[1]), type: 'vec3<f32>' },
        uTintC: { value: new Float32Array(stops[2]), type: 'vec3<f32>' },
        uTintD: { value: new Float32Array(stops[3]), type: 'vec3<f32>' },
        uTintAmount: { value: tint ? 1 : 0, type: 'f32' },
        uMinContrast: { value: 0.28, type: 'f32' },
        uPaperColor: { value: new Float32Array(paper), type: 'vec3<f32>' },
        uInkLuminance: { value: luminanceOf(ink), type: 'f32' },
        uPaperLuminance: { value: luminanceOf(paper), type: 'f32' },
        uBias: { value: (options.threshold ?? 0.5) - 0.5, type: 'f32' },
    });
    const inversion = options.inversion ?? true;
    return new pixi.Filter({
        glProgram: pixi.GlProgram.from({
            vertex,
            fragment: inversion ? inversionFragment : tintOnlyFragment,
            name: inversion ? 'tempera-difference-inversion' : 'tempera-text-tint',
        }),
        // blendRequired makes Pixi snapshot the pixels already drawn beneath this filter's
        // bounds into uBackTexture; the empty texture below is the required placeholder. The
        // tint-only form reads no backdrop, so it declares neither.
        blendRequired: inversion,
        resources: inversion
            ? { differenceUniforms: uniforms, uBackTexture: pixi.Texture.EMPTY }
            : { differenceUniforms: uniforms },
        padding: 0,
        // MUST be 'inherit'. Pixi's Filter default is a hard 1, which allocates the input
        // texture at a different pixel size than the back texture (that one always follows the
        // render target's resolution). vTextureCoord then indexes the two textures
        // differently and the backdrop is read from the wrong place - the inversion picks the
        // wrong colour in patches, worst over fine hatch. The tint-only form has no back
        // texture to disagree with, but a hard 1 would still rasterize the type below the
        // canvas resolution and upscale it.
        resolution: 'inherit',
    });
};
