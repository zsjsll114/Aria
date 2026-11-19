/**
 * web/src/core/visualizers/vitrail/vitrailShaders.js
 * 「琉璃龛 · Vitrail」（mode: vitrail）—— WebGL2 多通道光学建筑渲染着色器集合
 */

export const SCENE_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
layout(location = 3) in float aMatId;

uniform mat4 uViewProj;
uniform mat4 uModel;
uniform mat3 uNormalMat;
uniform float uMirrorSign; // 1.0 = 正常, -1.0 = 镜面水倒影 Pass

out vec3 vWorldPos;
out vec3 vWorldNormal;
out vec2 vUv;
out float vMatId;
out float vRawY;

void main() {
    vec4 wp = uModel * vec4(aPos, 1.0);
    vRawY = wp.y;
    wp.y *= uMirrorSign;

    vec3 rawN = uNormalMat * aNormal;
    float nLen2 = dot(rawN, rawN);
    vec3 wn = nLen2 > 1e-8 ? rawN * inversesqrt(nLen2) : vec3(0.0, 1.0, 0.0);
    wn.y *= uMirrorSign;

    vWorldPos = wp.xyz;
    vWorldNormal = wn;
    vUv = aUv;
    vMatId = aMatId;
    gl_Position = uViewProj * wp;
}
`;

export const SCENE_FS = `#version 300 es
precision highp float;

in vec3 vWorldPos;
in vec3 vWorldNormal;
in vec2 vUv;
in float vMatId;
in float vRawY;

uniform vec3 uCamPos;
uniform float uTime;
uniform float uMirrorSign;
uniform float uAudioBass;
uniform float uAudioMid;
uniform float uAudioTreble;
uniform float uLighting;

uniform vec3 uStoneBase;
uniform vec3 uStoneTrim;
uniform vec3 uMetalColor;
uniform vec3 uGlassA;
uniform vec3 uGlassB;
uniform vec3 uGlassC;
uniform vec3 uKeyColor;
uniform vec3 uFillColor;
uniform vec3 uFogHorizon;
uniform vec3 uFogZenith;
uniform float uFogDensity;
uniform float uIsLightMode;
uniform float uArchStyle;

uniform vec3 uPoint0Pos;
uniform vec3 uPoint0Color;
uniform vec3 uPoint1Pos;
uniform vec3 uPoint1Color;

out vec4 fragColor;

float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

vec3 safeNorm(vec3 v, vec3 fb) {
    float l2 = dot(v, v);
    return l2 > 1e-8 ? v * inversesqrt(l2) : fb;
}

float safePow(float x, float e) {
    return pow(max(x, 1e-4), e);
}

vec3 sanitizeHdr(vec3 c, float hi) {
    return vec3(
        c.x >= 0.0 ? min(c.x, hi) : 0.0,
        c.y >= 0.0 ? min(c.y, hi) : 0.0,
        c.z >= 0.0 ? min(c.z, hi) : 0.0
    );
}

float triplanarNoise(vec3 p, vec3 n) {
    vec3 a = abs(n);
    vec3 w = a * a * a;
    w /= max(0.001, w.x + w.y + w.z);
    float nx = valueNoise(p.zy * 2.2) * 0.65 + valueNoise(p.zy * 6.5) * 0.35;
    float ny = valueNoise(p.xz * 2.2) * 0.65 + valueNoise(p.xz * 6.5) * 0.35;
    float nz = valueNoise(p.xy * 2.2) * 0.65 + valueNoise(p.xy * 6.5) * 0.35;
    return nx * w.x + ny * w.y + nz * w.z;
}

vec3 calcPointLight(vec3 pPos, vec3 pCol, vec3 wPos, vec3 N, vec3 V, vec3 albedo, float specPow, float specAmp) {
    vec3 d = pPos - wPos;
    float dist2 = dot(d, d);
    float att = 1.0 / (1.0 + 0.08 * dist2 + 0.012 * dist2 * dist2);
    vec3 L = safeNorm(d, N);
    float ndl = clamp(dot(N, L), 0.0, 1.0);
    vec3 H = safeNorm(L + V, N);
    float spec = safePow(clamp(dot(N, H), 0.0, 1.0), specPow) * specAmp;
    return pCol * att * (albedo * ndl * 1.15 + spec);
}

void main() {
    if (uMirrorSign < 0.0 && vRawY < -0.02) {
        discard;
    }

    vec3 N = safeNorm(vWorldNormal, vec3(0.0, 1.0, 0.0));
    vec3 unmirroredPos = vec3(vWorldPos.x, vRawY, vWorldPos.z);
    vec3 V = safeNorm(uCamPos - vWorldPos, vec3(0.0, 0.0, 1.0));
    int mat = int(vMatId + 0.5);

    // 1. 按建筑原型定制化材质肌理（哥特条石 / 万神纹大理石 / 安藤清水混凝土 / 折光黑板岩 / 威尼斯石灰岩 / 温室砂岩）
    float tex = triplanarNoise(unmirroredPos * 0.65, abs(N));
    float softVeining = triplanarNoise(unmirroredPos * 1.45, abs(N));
    float isMarbleArch = (abs(uArchStyle - 1.0) < 0.5 || abs(uArchStyle - 4.0) < 0.5) ? 1.0 : 0.0;
    float isConcreteArch = abs(uArchStyle - 2.0) < 0.5 ? 1.0 : 0.0;
    float isSlateArch = abs(uArchStyle - 3.0) < 0.5 ? 1.0 : 0.0;
    float isVenetianArch = abs(uArchStyle - 5.0) < 0.5 ? 1.0 : 0.0;

    float cScale = mix(1.05, 0.45, isMarbleArch);
    cScale = mix(cScale, 0.85, isConcreteArch);
    cScale = mix(cScale, 0.72, isVenetianArch);
    float courseY = unmirroredPos.y * cScale;
    float rowId = floor(courseY);
    float horizCoord = (unmirroredPos.x + unmirroredPos.z * 0.85) * mix(0.48, 0.34, isMarbleArch + isConcreteArch * 0.6)
        + mod(rowId, 2.0) * 0.5 * (1.0 - isConcreteArch);
    float colId = floor(horizCoord);
    float mortarH = smoothstep(0.0, mix(0.055, 0.022, isConcreteArch), abs(fract(courseY) - 0.5));
    float mortarV = smoothstep(0.0, mix(0.036, 0.020, isConcreteArch), abs(fract(horizCoord) - 0.5));
    float mortar = min(mortarH, mix(0.70, 1.0, mortarV));
    mortar = mix(mortar, 1.0, isMarbleArch * 0.75 + isSlateArch * 0.85);
    float blockVar = mix(mix(0.95, 1.06, hash21(vec2(rowId, colId))), 1.0, isConcreteArch * 0.7 + isMarbleArch * 0.5);

    // 大理石天然纹理 & 清水混凝土模板孔洞细节
    float marbleVein = 0.5 + 0.5 * sin((unmirroredPos.x * 1.6 + unmirroredPos.z * 1.1 + unmirroredPos.y * 0.7) + tex * 5.0);
    vec2 tieCell = abs(fract(vec2((unmirroredPos.x + unmirroredPos.z) * 0.52, unmirroredPos.y * 0.85)) - 0.5);
    float tieDot = isConcreteArch * (1.0 - smoothstep(0.025, 0.055, length(tieCell)));

    vec3 albedo = uStoneBase * blockVar * mix(0.88, 1.12, tex * 0.72 + softVeining * 0.28) * mix(0.84, 1.0, mortar);
    albedo = mix(albedo, uStoneBase * mix(0.90, 1.14, marbleVein), isMarbleArch * 0.65);
    albedo *= (1.0 - tieDot * 0.22);
    float roughness = mix(0.82, 0.68, softVeining);
    roughness = mix(roughness, 0.42, isMarbleArch * 0.65 + isSlateArch * 0.75);
    roughness = mix(0.96, roughness, mortar);
    float metallic = mix(0.03, 0.14, isSlateArch);
    vec3 emissive = vec3(0.0);

    if (mat == 1) {
        // 精雕建筑线脚、柱头、花窗石棂与花瓶栏杆
        albedo = uStoneTrim * mix(0.91, 1.09, tex * 0.75 + softVeining * 0.25) * mix(0.92, 1.0, mortarH);
        albedo = mix(albedo, uStoneTrim * mix(0.93, 1.12, marbleVein), isMarbleArch * 0.55);
        roughness = mix(0.58, 0.38, isMarbleArch + isSlateArch * 0.5);
        metallic = mix(0.05, 0.16, isSlateArch);
    } else if (mat == 2) {
        // 拉丝古铜/浑天黄铜与细铜嵌丝（真实金属 Schlick 菲涅尔高光）
        float brush = valueNoise(vec2(unmirroredPos.x * 10.0 + unmirroredPos.z * 7.0, unmirroredPos.y * 2.5));
        albedo = uMetalColor * mix(0.86, 1.10, brush);
        roughness = mix(0.24, 0.34, brush);
        metallic = 0.90;
    } else if (mat == 3) {
        // 按 8 种建筑原型分化彩窗玻璃 / 障子纸 / 星图 / 棱镜 / 威尼斯扇贝窗 / 植物玻璃穹
        vec2 gUv = vUv * vec2(4.6, 5.4) + vec2(floor(unmirroredPos.z * 0.25) * 0.37, 0.0);
        float c0 = valueNoise(gUv);
        float c1 = valueNoise(gUv * 2.4 + 3.7);
        vec3 shard = mix(uGlassA, uGlassB, smoothstep(0.24, 0.76, c0));
        shard = mix(shard, uGlassC, smoothstep(0.50, 0.88, c1));
        float fresnel = safePow(clamp(1.0 - clamp(dot(N, V), 0.0, 1.0), 0.0, 1.0), 2.4);
        float pulse = 1.0 + uAudioMid * 0.40 + uAudioTreble * 0.28;
        float d1 = abs(fract((vUv.x + vUv.y) * 5.6) - 0.5);
        float d2 = abs(fract((vUv.x - vUv.y) * 5.6) - 0.5);
        float diamondLead = smoothstep(0.032, 0.095, min(d1, d2));
        float cellLead = smoothstep(0.035, 0.115, min(fract(gUv.x), fract(gUv.y)));
        float seam = mix(cellLead, diamondLead * cellLead, 0.60);
        float glowBoost = 0.68;

        if (abs(uArchStyle - 1.0) < 0.5) {
            // 观象台：深蓝星空图与黄铜经纬刻度弧 + 闪烁星点
            vec2 centered = vUv - 0.5 + vec2(1e-4);
            float radArc = abs(fract(length(centered) * 7.5) - 0.5);
            float angLine = abs(fract(atan(centered.y, centered.x) * 1.90986) - 0.5);
            seam = smoothstep(0.03, 0.08, min(radArc, angLine));
            vec2 starCell = floor(vUv * 42.0);
            float starRand = hash21(starCell + vec2(floor(unmirroredPos.z), floor(unmirroredPos.x)));
            float star = step(0.945, starRand) * (0.65 + 0.35 * sin(uTime * 2.2 + starRand * 19.0));
            shard = mix(uGlassB * 0.52, uGlassA, star) + uGlassC * (1.0 - seam) * 0.35;
            glowBoost = 0.62 + star * 0.55;
        } else if (abs(uArchStyle - 2.0) < 0.5) {
            // 禅意水院：正交日式组子障子木格 + 柔和透亮和纸光晕
            float sx = abs(fract(vUv.x * 5.0) - 0.5);
            float sy = abs(fract(vUv.y * 8.0) - 0.5);
            seam = smoothstep(0.038, 0.09, min(sx, sy));
            shard = mix(uKeyColor, mix(uGlassA, uGlassB, 0.35), 0.34) * (0.90 + 0.10 * c0);
            glowBoost = 0.78;
        } else if (abs(uArchStyle - 3.0) < 0.5) {
            // 晶体棱阁：锐利折纸V字人字棱晶拼块 + 强烈宝石折光闪耀
            float cv1 = abs(fract(vUv.x * 3.4 + abs(vUv.y - 0.5) * 6.2) - 0.5);
            float cv2 = abs(fract(vUv.x * 3.4 - abs(vUv.y - 0.5) * 6.2) - 0.5);
            seam = smoothstep(0.024, 0.075, min(cv1, cv2));
            float facetId = hash21(floor(vec2(vUv.x * 3.4 + abs(vUv.y - 0.5) * 6.2, vUv.y * 5.0)));
            shard = mix(uGlassA, mix(uGlassB, uGlassC, facetId), smoothstep(0.18, 0.85, facetId));
            glowBoost = 0.80 + fresnel * 0.45;
        } else if (abs(uArchStyle - 4.0) < 0.5) {
            // 万神圆厅：黄金放射环纹神龛玻璃
            float ringG = abs(fract(vUv.y * 6.5 + 0.14 * sin(vUv.x * 12.566)) - 0.5);
            float rayG = abs(fract(vUv.x * 6.0) - 0.5);
            seam = smoothstep(0.035, 0.095, min(ringG, rayG));
            shard = mix(uGlassA, uGlassC, smoothstep(0.25, 0.80, vUv.y));
            glowBoost = 0.72;
        } else if (abs(uArchStyle - 5.0) < 0.5) {
            // 威尼斯水上拱廊：扇贝鳞片 Murano 水纹拼花
            vec2 scUv = vUv * vec2(4.8, 6.2);
            float rowStag = mod(floor(scUv.y), 2.0) * 0.5;
            vec2 tilePos = vec2(fract(scUv.x + rowStag) - 0.5, fract(scUv.y));
            float scallop = abs(length(tilePos) - 0.56);
            seam = smoothstep(0.03, 0.085, scallop);
            float aquaTint = hash21(floor(vec2(scUv.x + rowStag, scUv.y)));
            shard = mix(uGlassA, mix(uGlassB, uGlassC, aquaTint), 0.55);
            glowBoost = 0.72;
        } else if (abs(uArchStyle - 6.0) < 0.5) {
            // 秘阁穹廊：古羊皮纸纹与细密菱形纹章格
            float q1 = abs(fract((vUv.x + vUv.y) * 7.8) - 0.5);
            float q2 = abs(fract((vUv.x - vUv.y) * 7.8) - 0.5);
            seam = smoothstep(0.03, 0.08, min(q1, q2));
            shard = mix(uGlassA, uGlassC, smoothstep(0.2, 0.8, c1));
            glowBoost = 0.68;
        } else if (abs(uArchStyle - 7.0) < 0.5) {
            // 植物晶庭：纤细铸铁花房长窗框 + 晨光叶影斑驳透射
            float gx = abs(fract(vUv.x * 4.0) - 0.5);
            float gy = abs(fract(vUv.y * 7.0) - 0.5);
            seam = smoothstep(0.022, 0.068, min(gx, gy));
            float canopyDapple = 0.82 + 0.18 * valueNoise(vUv * 4.2 + vec2(uTime * 0.08, 0.0));
            shard = mix(uKeyColor * 1.05, mix(uGlassA, uGlassB, c0), 0.42) * canopyDapple;
            glowBoost = 0.82;
        }

        float lightMod = mix(1.0, 0.68, clamp(uIsLightMode, 0.0, 1.0));
        albedo = shard * 0.38;
        emissive = shard * (glowBoost + 0.14 * sin(uTime * 0.7 + c0 * 6.2831) + fresnel * 0.34) * seam * pulse * (0.72 + uLighting * 0.52) * lightMod;
        roughness = 0.18;
    } else if (mat == 6) {
        // 十二面切割圣灯晶核（铜笼内部璀璨折光宝石面）
        float fresnel = safePow(clamp(1.0 - clamp(dot(N, V), 0.0, 1.0), 0.0, 1.0), 2.1);
        float grad = clamp(vUv.y, 0.0, 1.0);
        vec3 crystalCol = mix(uGlassC, mix(uGlassA, uGlassB, fract(vUv.x * 3.0 + 0.15)), grad * 0.76 + 0.16);
        albedo = crystalCol * 0.45;
        emissive = crystalCol * (0.62 + fresnel * 0.98) * (0.85 + uLighting * 0.55 + uAudioMid * 0.35);
        roughness = 0.08;
        metallic = 0.24;
    }

    // 2. 光照方程：主方向圣光 + 琉璃色温回弹微光 + 建筑边缘柔润菲涅尔高光
    vec3 keyDir = normalize(vec3(0.32, 0.74, 0.58));
    vec3 rimDir = normalize(vec3(-0.35, 0.42, -0.84));
    vec3 effKey = keyDir;
    vec3 effRim = rimDir;
    if (uMirrorSign < 0.0) {
        effKey.y *= -1.0;
        effRim.y *= -1.0;
    }

    float ndl = clamp(dot(N, effKey), 0.0, 1.0);
    float ndr = clamp(dot(N, effRim), 0.0, 1.0);
    float ndv = clamp(dot(N, V), 0.0, 1.0);
    float hemi = 0.5 + 0.5 * (uMirrorSign < 0.0 ? -N.y : N.y);

    float groundAo = smoothstep(0.0, 1.48, max(0.0, vRawY));
    float corridorBounce = mix(0.34, 0.16, uIsLightMode);

    vec3 F0 = mix(vec3(0.045), albedo, metallic);
    float oneMinusNdv = clamp(1.0 - ndv, 0.0, 1.0);
    vec3 fresnelTerm = F0 + (vec3(1.0) - F0) * safePow(oneMinusNdv, 4.5);

    vec3 diffColor = albedo * (1.0 - metallic * 0.86);
    vec3 specColor = mix(vec3(0.055), fresnelTerm * (1.18 - roughness * 0.45), max(metallic, 0.22));
    float specPow = mix(20.0, 118.0, 1.0 - roughness);

    vec3 Hk = safeNorm(effKey + V, N);
    vec3 Hr = safeNorm(effRim + V, N);
    float specK = safePow(clamp(dot(N, Hk), 0.0, 1.0), specPow) * (1.18 - roughness * 0.75);
    float specR = safePow(clamp(dot(N, Hr), 0.0, 1.0), specPow * 0.7) * 0.58;

    float aoShade = mix(mix(0.66, 0.48, uIsLightMode), 1.0, groundAo);
    vec3 glassBounce = mix(uGlassA, uGlassB, 0.45) * mix(0.15, 0.04, uIsLightMode);
    float stoneGraze = safePow(oneMinusNdv, 3.1) * (1.0 - metallic) * mix(0.10, 0.03, uIsLightMode);

    vec3 skyAmb = mix(uFillColor * mix(0.54, 0.60, uIsLightMode), uKeyColor * mix(0.33, 0.36, uIsLightMode), hemi);
    vec3 amb = (diffColor * (skyAmb + glassBounce * (0.45 + 0.55 * (1.0 - ndl))) + uStoneTrim * stoneGraze) * aoShade * (1.0 + corridorBounce);
    vec3 direct = (diffColor * ndl * mix(1.0, 1.25, uIsLightMode) + specColor * specK) * uKeyColor * (0.90 + uAudioBass * 0.28);
    vec3 rimLight = (diffColor * ndr * 0.26 + specColor * specR) * mix(uGlassA, uGlassB, 0.4) * (0.55 + uLighting * 0.35);

    vec3 pt0 = calcPointLight(uPoint0Pos, uPoint0Color, vWorldPos, N, V, diffColor, specPow, 0.9 - roughness * 0.5);
    vec3 pt1 = calcPointLight(uPoint1Pos, uPoint1Color, vWorldPos, N, V, diffColor, specPow, 0.9 - roughness * 0.5);

    vec3 col = amb + direct + rimLight + pt0 + pt1 + emissive;

    // 3. 大气纵深与高度雾
    float dist = length(uCamPos - vWorldPos);
    float heightFactor = exp(-max(0.0, vRawY) * 0.14);
    float fogAmt = 1.0 - exp(-dist * uFogDensity * (0.65 + 0.55 * heightFactor));
    fogAmt = clamp(fogAmt, 0.0, 0.94);
    vec3 fogCol = mix(uFogZenith, uFogHorizon, heightFactor);
    col = mix(col, fogCol, fogAmt);

    fragColor = vec4(sanitizeHdr(col, 24.0), 1.0);
}
`;

export const WATER_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;

uniform mat4 uViewProj;

out vec3 vWorldPos;
out vec4 vClipPos;

void main() {
    vWorldPos = aPos;
    vClipPos = uViewProj * vec4(aPos, 1.0);
    gl_Position = vClipPos;
}
`;

export const WATER_FS = `#version 300 es
precision highp float;

in vec3 vWorldPos;
in vec4 vClipPos;

uniform sampler2D uReflectTex;
uniform float uHasReflect;
uniform vec3 uCamPos;
uniform float uTime;
uniform float uAudioBass;
uniform float uAudioMid;
uniform float uLighting;
uniform float uArchStyle;

uniform vec3 uWaterTint;
uniform vec3 uFogHorizon;
uniform vec3 uFogZenith;
uniform vec3 uGlassA;
uniform vec3 uGlassB;
uniform vec3 uKeyColor;
uniform vec3 uPoint0Pos;
uniform vec3 uPoint0Color;
uniform vec3 uPoint1Pos;
uniform vec3 uPoint1Color;

out vec4 fragColor;

vec3 safeNormW(vec3 v, vec3 fb) {
    float l2 = dot(v, v);
    return l2 > 1e-8 ? v * inversesqrt(l2) : fb;
}

float safePowW(float x, float e) {
    return pow(max(x, 1e-4), e);
}

vec3 sanitizeWater(vec3 c, float hi) {
    return vec3(
        c.x >= 0.0 ? min(c.x, hi) : 0.0,
        c.y >= 0.0 ? min(c.y, hi) : 0.0,
        c.z >= 0.0 ? min(c.z, hi) : 0.0
    );
}

void main() {
    vec2 p = vWorldPos.xz;
    float t = uTime;

    // 多尺度水波纹微法线（中心慢涌 + 声波同心涟漪 + 高频风痕）
    float rDist = length(p - vec2(0.0, -3.5));
    float ripple1 = sin(p.x * 2.1 + t * 0.85) * cos(p.y * 1.7 - t * 0.65);
    float ripple2 = sin(rDist * (3.2 + uAudioBass * 1.6) - t * 2.2) * exp(-rDist * 0.085);
    float ripple3 = cos(p.x * 5.7 - p.y * 4.3 + t * 1.35) * 0.35;

    float waveScale = 1.0;
    if (abs(uArchStyle - 2.0) < 0.5) waveScale = 0.42;
    else if (abs(uArchStyle - 5.0) < 0.5) waveScale = 1.38;
    else if (abs(uArchStyle - 3.0) < 0.5) waveScale = 0.68;

    float waveAmp = (0.012 + uAudioBass * 0.022) * waveScale;
    float dx = (cos(p.x * 2.1 + t * 0.85) * 2.1 * cos(p.y * 1.7 - t * 0.65)
             + cos(rDist * (3.2 + uAudioBass * 1.6) - t * 2.2) * (p.x / max(0.2, rDist)) * exp(-rDist * 0.085) * 1.8) * waveAmp;
    float dz = (-sin(p.x * 2.1 + t * 0.85) * sin(p.y * 1.7 - t * 0.65) * 1.7
             + cos(rDist * (3.2 + uAudioBass * 1.6) - t * 2.2) * ((p.y + 3.5) / max(0.2, rDist)) * exp(-rDist * 0.085) * 1.8) * waveAmp;

    vec3 N = safeNormW(vec3(-dx, 1.0, -dz), vec3(0.0, 1.0, 0.0));
    vec3 V = safeNormW(uCamPos - vWorldPos, vec3(0.0, 0.35, 0.94));
    float fresnel = 0.045 + 0.955 * safePowW(clamp(1.0 - clamp(dot(N, V), 0.0, 1.0), 0.0, 1.0), 4.0);

    vec3 reflCol = mix(uWaterTint * 1.4, uFogHorizon * 0.9, fresnel);
    if (uHasReflect > 0.5) {
        vec2 ndc = vClipPos.xy / max(0.001, vClipPos.w);
        vec2 reflUv = ndc * 0.5 + 0.5;
        // 随水波梯度自然偏移采样坐标，严密钳制在安全区内防边缘采黑
        reflUv += vec2(N.x * 0.16, N.z * 0.12);
        reflUv = clamp(reflUv, vec2(0.004), vec2(0.996));
        reflCol = sanitizeWater(texture(uReflectTex, reflUv).rgb, 24.0);
    } else {
        // 低配无反射 FBO 兜底：优雅深水池渐层 + 倒映后窗余晖
        float bx = vWorldPos.x * 0.42;
        float beamRefl = exp(-(bx * bx)) * smoothstep(-15.0, -1.0, vWorldPos.z);
        reflCol = mix(uWaterTint, mix(uGlassA, uGlassB, 0.5) * 0.45 + uKeyColor * 0.25, beamRefl * 0.65);
    }

    // 实时动态点光源在水波上的碎金倒影
    vec3 d0 = uPoint0Pos - vWorldPos;
    vec3 L0 = safeNormW(d0, N);
    float att0 = 1.0 / (1.0 + 0.14 * dot(d0, d0));
    float spec0 = safePowW(clamp(dot(N, safeNormW(L0 + V, N)), 0.0, 1.0), 96.0);

    vec3 d1 = uPoint1Pos - vWorldPos;
    vec3 L1 = safeNormW(d1, N);
    float att1 = 1.0 / (1.0 + 0.14 * dot(d1, d1));
    float spec1 = safePowW(clamp(dot(N, safeNormW(L1 + V, N)), 0.0, 1.0), 96.0);

    // 主玫瑰窗高光走廊拉丝反射
    vec3 sunDir = normalize(vec3(0.0, 0.36, -0.92));
    float sunSpec = safePowW(clamp(dot(N, safeNormW(sunDir + V, N)), 0.0, 1.0), 140.0) * (0.45 + uLighting * 0.45);

    vec3 deepWater = uWaterTint * (0.75 + 0.25 * ripple3);
    vec3 surface = mix(deepWater, reflCol, clamp(fresnel * 1.15 + 0.28, 0.0, 0.92));
    surface += uPoint0Color * spec0 * att0 * 2.2;
    surface += uPoint1Color * spec1 * att1 * 2.0;
    surface += mix(uGlassA, uKeyColor, 0.5) * sunSpec * (0.8 + uAudioMid * 0.4);

    float dist = length(uCamPos - vWorldPos);
    float fog = clamp(1.0 - exp(-dist * 0.024), 0.0, 0.9);
    surface = mix(surface, mix(uFogZenith, uFogHorizon, 0.65), fog);

    fragColor = vec4(sanitizeWater(surface, 24.0), 1.0);
}
`;

export const SHAFT_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;

uniform mat4 uViewProj;

out vec2 vUv;
out vec3 vWorldPos;

void main() {
    vUv = aUv;
    vWorldPos = aPos;
    gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

export const SHAFT_FS = `#version 300 es
precision highp float;

in vec2 vUv;
in vec3 vWorldPos;

uniform float uTime;
uniform float uLighting;
uniform float uAudioMid;
uniform float uAudioBass;
uniform vec3 uKeyColor;
uniform vec3 uGlassA;
uniform vec3 uGlassB;

out vec4 fragColor;

void main() {
    // 四周柔顺羽化，绝不出现硬切直边矩形！
    float edgeX = max(0.0, sin(clamp(vUv.x, 0.0, 1.0) * 3.14159265));
    edgeX = edgeX > 1e-4 ? pow(edgeX, 1.85) : 0.0;
    float vertical = smoothstep(0.02, 0.52, vUv.y) * smoothstep(1.0, 0.78, vUv.y);
    float streak = 0.72 + 0.28 * sin(vUv.x * 16.0 + uTime * 0.45 + vWorldPos.z * 0.25);

    vec3 tint = mix(uKeyColor, mix(uGlassA, uGlassB, vUv.x), 0.36);
    float alpha = clamp(edgeX * vertical * streak * (0.042 + uAudioMid * 0.032 + uAudioBass * 0.018) * clamp(uLighting, 0.0, 1.5), 0.0, 1.0);
    vec3 safeTint = vec3(tint.x >= 0.0 ? tint.x : 0.0, tint.y >= 0.0 ? tint.y : 0.0, tint.z >= 0.0 ? tint.z : 0.0);
    fragColor = vec4(min(safeTint * alpha * 1.45, vec3(8.0)), alpha);
}
`;

export const SCRIM_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUv;

uniform mat4 uViewProj;

out vec2 vUv;

void main() {
    vUv = aUv;
    gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

export const SCRIM_FS = `#version 300 es
precision highp float;

in vec2 vUv;

uniform vec3 uScrimColor;
uniform float uAlpha;

out vec4 fragColor;

void main() {
    // 椭圆柔光暗幕保护层（防止玫瑰窗高光直冲歌词导致可读性降低，边缘柔和溶入背景）
    vec2 d = (vUv - 0.5) * 2.0;
    float r2 = dot(d, d);
    float mask = exp(-r2 * 1.85) * smoothstep(1.0, 0.15, length(d));
    fragColor = vec4(uScrimColor, mask * uAlpha);
}
`;

export const GLYPH_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUv;
layout(location = 2) in vec4 aColorBase;     // 未唱颜色 RGBA
layout(location = 3) in vec4 aColorSung;     // 唱过/高亮颜色 RGBA
layout(location = 4) in float aProg;         // 单字卡拉OK进度 [0..1]
layout(location = 5) in float aEnter;        // 入场过渡 [0..1]

uniform mat4 uViewProj;
uniform float uMirrorSign;

out vec2 vUv;
out vec3 vWorldPos;
out vec4 vColorBase;
out vec4 vColorSung;
out float vProg;
out float vEnter;

void main() {
    vec3 wp = aPos;
    wp.y *= uMirrorSign;
    vUv = aUv;
    vWorldPos = wp;
    vColorBase = aColorBase;
    vColorSung = aColorSung;
    vProg = aProg;
    vEnter = aEnter;
    gl_Position = uViewProj * vec4(wp, 1.0);
}
`;

export const GLYPH_FS = `#version 300 es
precision highp float;

in vec2 vUv;
in vec3 vWorldPos;
in vec4 vColorBase;
in vec4 vColorSung;
in float vProg;
in float vEnter;

uniform sampler2D uSdfAtlas;
uniform vec3 uCamPos;
uniform vec3 uKeyColor;
uniform vec3 uBackdropShadow;
uniform float uMirrorSign;
uniform float uIsLightMode;

out vec4 fragColor;

void main() {
    if (uMirrorSign < 0.0 && vWorldPos.y > 0.0) {
        discard;
    }

    vec4 s = texture(uSdfAtlas, vUv);
    float sdf = s.r;
    float fw = fwidth(sdf);
    // fwidth 在字号较大 / 高 DPR 下可能很小，此前 >=0.014 下限把清晰字形强行拉回 0.035 宽模糊；
    // 改用紧凑夹紧（0.003..0.065），同时把衬影羽化收敛在字缘外侧，避免糊住笔画主轮廓
    float aa = fw > 0.0001 ? clamp(fw * 0.72, 0.003, 0.065) : 0.010;

    // 外围清晰雕琢衬影边界（无论背景石柱/天光如何变化，字边缘始终如凿刻般清晰可读）
    float lightT = clamp(uIsLightMode, 0.0, 1.0);
    float shadowAlpha = smoothstep(0.36 - aa * 1.2, 0.495, sdf) * mix(0.62, 0.46, lightT);
    float fillAlpha = smoothstep(0.50 - aa, 0.50 + aa, sdf);
    if (max(fillAlpha, shadowAlpha) < 0.015) discard;

    // 从 RGBA 图集恢复 3D 笔画斜面倒角法线
    vec2 bevelXY = s.gb * 2.0 - 1.0;
    float bevelEdge = smoothstep(0.49, 0.72, sdf) * (1.0 - smoothstep(0.70, 0.92, sdf));
    vec3 rawBn = vec3(bevelXY * bevelEdge * 0.85, 1.0);
    vec3 bevelN = rawBn * inversesqrt(max(1e-6, dot(rawBn, rawBn)));
    vec3 L = normalize(vec3(0.32, 0.82, 0.68));
    vec3 vDiff = uCamPos - vWorldPos;
    float vLen2 = dot(vDiff, vDiff);
    vec3 V = vLen2 > 1e-8 ? vDiff * inversesqrt(vLen2) : vec3(0.0, 0.0, 1.0);
    vec3 hSum = L + V;
    float hLen2 = dot(hSum, hSum);
    vec3 H = hLen2 > 1e-8 ? hSum * inversesqrt(hLen2) : vec3(0.0, 0.0, 1.0);

    float bevelDiff = clamp(0.78 + 0.34 * dot(bevelN, L), 0.55, 1.18);
    float bevelSpec = pow(max(dot(bevelN, H), 1e-4), 28.0) * bevelEdge;

    // 逐字高亮推进 + 扫光金边
    float p = clamp(vProg, 0.0, 1.0);
    float isSwept = smoothstep(0.0, 0.25, p);
    float isSweepingRidge = sin(p * 3.14159265) * 0.75;

    vec3 baseCol = vColorBase.rgb;
    vec3 sungCol = vColorSung.rgb;
    vec3 inkCol = mix(baseCol, sungCol, p);
    vec3 darkInk = (inkCol * bevelDiff + uKeyColor * bevelSpec * mix(0.28, 0.78, p) + uKeyColor * isSweepingRidge * 0.32) * mix(1.0, 1.24, isSwept);
    // 白石亮调模式：禁止对深色墨字叠加亮白 keyColor（防止扫光中段泛白隐形），改为宝石墨彩加深鎏金边缘
    vec3 ridgeInk = mix(inkCol * 0.85, sungCol * 0.76, 0.58);
    vec3 lightInk = mix(inkCol * (0.86 + 0.18 * dot(bevelN, L)), ridgeInk, isSweepingRidge * 0.68) + sungCol * bevelSpec * 0.15;
    inkCol = mix(darkInk, lightInk, clamp(uIsLightMode, 0.0, 1.0));
    inkCol *= (uMirrorSign < 0.0 ? 0.82 : 1.0);

    vec3 finalRgb = mix(uBackdropShadow, inkCol, clamp(fillAlpha / max(0.01, max(fillAlpha, shadowAlpha)), 0.0, 1.0));
    float finalAlpha = max(fillAlpha * mix(vColorBase.a, vColorSung.a, p), shadowAlpha) * clamp(vEnter, 0.0, 1.0);

    fragColor = vec4(finalRgb, finalAlpha);
}
`;

export const MOTE_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec3 aCenter;
layout(location = 2) in float aSize;
layout(location = 3) in float aPhase;

uniform mat4 uView;
uniform mat4 uProj;
uniform float uTime;
uniform float uAudioTreble;

out vec2 vLocal;
out float vAlpha;
out float vPhase;

void main() {
    vec3 p = aCenter;
    p.y += mod(uTime * (0.14 + 0.08 * fract(aPhase * 3.7)) + aPhase * 8.0, 7.6) - 0.8;
    p.x += sin(uTime * 0.38 + aPhase * 6.2831) * 0.42;
    p.z += cos(uTime * 0.31 + aPhase * 5.13) * 0.42;

    vec4 viewCenter = uView * vec4(p, 1.0);
    float sz = aSize * (1.0 + uAudioTreble * 0.45);
    viewCenter.xy += aCorner * sz;
    gl_Position = uProj * viewCenter;

    vLocal = aCorner;
    vPhase = aPhase;
    float fadeY = smoothstep(0.1, 1.4, p.y) * smoothstep(7.2, 4.8, p.y);
    vAlpha = fadeY * (0.45 + 0.45 * sin(uTime * 1.1 + aPhase * 9.42));
}
`;

export const MOTE_FS = `#version 300 es
precision highp float;

in vec2 vLocal;
in float vAlpha;
in float vPhase;

uniform vec3 uKeyColor;
uniform vec3 uGlassA;

out vec4 fragColor;

void main() {
    float r = length(vLocal);
    if (r > 1.0) discard;
    float glow = exp(-r * r * 4.5) * smoothstep(1.0, 0.15, r);
    vec3 col = mix(uKeyColor, uGlassA, fract(vPhase * 5.3) * 0.45);
    float a = glow * vAlpha * 0.65;
    fragColor = vec4(col * a * 1.4, a);
}
`;

export const QUAD_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aPos;
out vec2 vUv;

void main() {
    vUv = aPos * 0.5 + 0.5;
    gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

export const SKY_FS = `#version 300 es
precision highp float;

in vec2 vUv;
uniform vec3 uFogHorizon;
uniform vec3 uFogZenith;
uniform vec3 uGlassA;
uniform vec3 uGlassB;
uniform float uMirrorSign;
uniform float uIsLightMode;
uniform float uArchStyle;
uniform float uTime;

out vec4 fragColor;

float hashSky(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 41.3);
    return fract(p.x * p.y);
}

vec3 sanitizePost(vec3 c, float hi) {
    return vec3(
        c.x >= 0.0 ? min(c.x, hi) : 0.0,
        c.y >= 0.0 ? min(c.y, hi) : 0.0,
        c.z >= 0.0 ? min(c.z, hi) : 0.0
    );
}

void main() {
    float y = uMirrorSign < 0.0 ? (1.0 - vUv.y) : vUv.y;
    float h = (y - 0.36) * 2.15;
    float horizonCurve = exp(-(h * h));
    vec3 col = mix(uFogZenith, uFogHorizon, smoothstep(0.95, 0.18, y));
    // 后殿中央琉璃穹窿透出的温柔漫射光晕，取代死黑背景
    vec2 glowUv = vec2(vUv.x - 0.5, y - 0.56);
    float apseGlow = exp(-dot(glowUv * vec2(1.4, 2.0), glowUv * vec2(1.4, 2.0)) * 3.8);
    vec3 aura = mix(uGlassA, uGlassB, 0.35) * mix(0.14, 0.06, clamp(uIsLightMode, 0.0, 1.0));
    col += aura * (apseGlow + horizonCurve * 0.35);

    if (abs(uArchStyle - 1.0) < 0.5) {
        // 观象台：繁星天穹与斜跨银河微光
        vec2 starGrid = vec2(vUv.x * 160.0, y * 105.0);
        vec2 sId = floor(starGrid);
        vec2 sLoc = fract(starGrid) - 0.5;
        float sVal = hashSky(sId);
        float sCore = step(0.972, sVal) * (1.0 - smoothstep(0.08, 0.36, length(sLoc)));
        float twinkle = 0.65 + 0.35 * sin(uTime * 1.9 + sVal * 31.4);
        float mw = exp(-((vUv.x * 0.7 + y * 0.7 - 0.85) * 4.2) * ((vUv.x * 0.7 + y * 0.7 - 0.85) * 4.2));
        col += mix(uGlassA, vec3(0.95, 0.97, 1.0), 0.7) * sCore * twinkle * smoothstep(0.22, 0.55, y) * 1.4;
        col += mix(uGlassB, uGlassA, 0.4) * mw * 0.065;
    } else if (abs(uArchStyle - 4.0) < 0.5) {
        // 万神圆厅：顶部开放穹眼倾泻日晕/月轮圣光柱
        vec2 oculusUv = vec2((vUv.x - 0.5) * 1.55, y - 0.88);
        float ocHalo = exp(-dot(oculusUv, oculusUv) * 10.5);
        col += mix(uGlassA, vec3(1.0, 0.96, 0.88), 0.55) * ocHalo * mix(0.42, 0.22, clamp(uIsLightMode, 0.0, 1.0));
    } else if (abs(uArchStyle - 5.0) < 0.5) {
        // 威尼斯水上拱廊：远处泻湖地平线月盘/暮光晕
        vec2 moonUv = vec2((vUv.x - 0.5) * 1.6, (y - 0.46) * 1.0);
        float dMoon = length(moonUv);
        float orb = (1.0 - smoothstep(0.045, 0.068, dMoon)) * 0.28 + exp(-dMoon * 4.5) * 0.16;
        col += mix(uGlassB, vec3(1.0, 0.95, 0.86), 0.6) * orb;
    } else if (abs(uArchStyle - 7.0) < 0.5) {
        // 植物晶庭：天顶通透晴空与柔润日光漫散
        float zenithSun = exp(-dot(vec2(vUv.x - 0.5, y - 0.92), vec2(vUv.x - 0.5, y - 0.92)) * 3.5);
        col += mix(uGlassA, vec3(1.0, 0.98, 0.92), 0.65) * zenithSun * 0.18;
    }

    fragColor = vec4(sanitizePost(col, 16.0), 1.0);
}
`;

export const SCENE_BLEND_FS = `#version 300 es
precision highp float;

in vec2 vUv;
uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform float uMix;
uniform vec3 uMistColor;
uniform vec3 uAccentColor;
uniform float uTime;

out vec4 fragColor;

vec3 sanitizeBlend(vec3 c, float hi) {
    return vec3(
        c.x >= 0.0 ? min(c.x, hi) : 0.0,
        c.y >= 0.0 ? min(c.y, hi) : 0.0,
        c.z >= 0.0 ? min(c.z, hi) : 0.0
    );
}

void main() {
    float mixT = clamp(uMix, 0.0, 1.0);
    float easeM = mixT * mixT * (3.0 - 2.0 * mixT);
    vec2 center = vec2(0.5, 0.48);
    vec2 dv = vUv - center;
    float r = length(dv);
    float bell = max(0.0, sin(mixT * 3.14159265));

    // 单向穿门推进：旧殿缓步向纵深淡出、新殿由远及近稳定落位（绝不在端点处回弹或停滞）
    float zoomA = 1.0 - easeM * 0.036;
    float zoomB = 1.0 + (1.0 - easeM) * 0.036;
    vec2 uvA = clamp(center + dv * zoomA, vec2(0.001), vec2(0.999));
    vec2 uvB = clamp(center + dv * zoomB, vec2(0.001), vec2(0.999));

    vec3 colA = sanitizeBlend(texture(uTexA, uvA).rgb, 24.0);
    vec3 colB = sanitizeBlend(texture(uTexB, uvB).rgb, 24.0);

    // 柔和中心光漫过渡：保持端点严格收敛到 0 与 1，避免硬切圆形划变
    float radialShift = (0.14 - r * 0.24 + sin(uTime * 0.9 + dv.x * 3.5) * 0.014) * bell;
    float blendT = smoothstep(0.0, 1.0, clamp(easeM + radialShift, 0.0, 1.0));
    vec3 blended = mix(colA, colB, blendT);

    // 过门光纱（Light Veil）：用柔和圣光弥散过渡不同建筑结构的体量切换
    float mistMask = (bell > 1e-4 ? pow(bell, 1.35) : 0.0) * (0.15 + 0.14 * exp(-r * r * 2.0));
    vec3 veilTint = mix(uMistColor, uAccentColor, 0.26 * exp(-r * r * 2.6));
    blended = mix(blended, veilTint + uAccentColor * 0.07 * bell, clamp(mistMask, 0.0, 0.32));
    fragColor = vec4(sanitizeBlend(blended, 24.0), 1.0);
}
`;

export const BLOOM_EXTRACT_FS = `#version 300 es
precision highp float;

in vec2 vUv;
uniform sampler2D uSceneTex;
uniform float uThreshold;

out vec4 fragColor;

vec3 sanitizeTap(vec3 c, float hi) {
    return vec3(
        c.x >= 0.0 ? min(c.x, hi) : 0.0,
        c.y >= 0.0 ? min(c.y, hi) : 0.0,
        c.z >= 0.0 ? min(c.z, hi) : 0.0
    );
}

void main() {
    vec3 c = sanitizeTap(texture(uSceneTex, vUv).rgb, 24.0);
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float knee = 0.25;
    float soft = clamp((lum - uThreshold + knee) / (2.0 * knee), 0.0, 1.0);
    soft = soft * soft;
    float contrib = max(soft * knee, lum - uThreshold) / max(0.0001, lum);
    fragColor = vec4(sanitizeTap(c * clamp(contrib, 0.0, 1.4), 16.0), 1.0);
}
`;

export const BLOOM_BLUR_FS = `#version 300 es
precision highp float;

in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexelStep;

out vec4 fragColor;

vec3 sanitizeTap(vec3 c, float hi) {
    return vec3(
        c.x >= 0.0 ? min(c.x, hi) : 0.0,
        c.y >= 0.0 ? min(c.y, hi) : 0.0,
        c.z >= 0.0 ? min(c.z, hi) : 0.0
    );
}

void main() {
    // 5-tap Kawase / Gauss 轻量核，逐点消毒防止任何 NaN 扩散成黑块
    vec3 sum = sanitizeTap(texture(uTex, vUv).rgb, 16.0) * 0.28;
    sum += sanitizeTap(texture(uTex, vUv + uTexelStep * 1.3846).rgb, 16.0) * 0.24;
    sum += sanitizeTap(texture(uTex, vUv - uTexelStep * 1.3846).rgb, 16.0) * 0.24;
    sum += sanitizeTap(texture(uTex, vUv + uTexelStep * 3.2307).rgb, 16.0) * 0.12;
    sum += sanitizeTap(texture(uTex, vUv - uTexelStep * 3.2307).rgb, 16.0) * 0.12;
    fragColor = vec4(sanitizeTap(sum, 16.0), 1.0);
}
`;

export const COMPOSITE_FS = `#version 300 es
precision highp float;

in vec2 vUv;
uniform sampler2D uSceneTex;
uniform sampler2D uBloomTex;
uniform float uBloomStrength;
uniform float uTime;
uniform float uGrain;
uniform float uIsLightMode;

out vec4 fragColor;

vec3 sanitizeTap(vec3 c, float hi) {
    return vec3(
        c.x >= 0.0 ? min(c.x, hi) : 0.0,
        c.y >= 0.0 ? min(c.y, hi) : 0.0,
        c.z >= 0.0 ? min(c.z, hi) : 0.0
    );
}

vec3 acesFilmic(vec3 x) {
    float a = 2.51;
    float b = 0.03;
    float c = 2.43;
    float d = 0.59;
    float e = 0.14;
    return clamp((x * (a * x + b)) / max(vec3(1e-4), x * (c * x + d) + e), 0.0, 1.0);
}

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

void main() {
    vec3 hdr = sanitizeTap(texture(uSceneTex, vUv).rgb, 24.0);
    vec3 bloom = sanitizeTap(texture(uBloomTex, vUv).rgb, 16.0);
    vec3 col = hdr + bloom * max(0.0, uBloomStrength);

    // ACES 电影感色调映射 + sRGB 伽马
    col = acesFilmic(col * 1.06);
    col = pow(max(col, vec3(1e-5)), vec3(1.0 / 2.08));

    // 温和胶片暗角（暗调模式压深四周突出圣殿主体，亮调石室轻微柔化）
    vec2 uvCentered = vUv - 0.5;
    float vigDist = dot(uvCentered, uvCentered);
    float vig = 1.0 - vigDist * mix(0.62, 0.28, clamp(uIsLightMode, 0.0, 1.0));
    col *= clamp(vig, 0.55, 1.0);

    if (uGrain > 0.001) {
        float g = (hash12(gl_FragCoord.xy + fract(uTime * 17.3) * 100.0) - 0.5) * uGrain;
        col += vec3(g);
    }

    fragColor = vec4(clamp(sanitizeTap(col, 1.0), 0.0, 1.0), 1.0);
}
`;
