/**
 * web/src/core/visualizers/vitrail/vitrailProfiles.js
 * 「琉璃龛 · Vitrail」（mode: vitrail）—— 建筑美学色板、曲风智能匹配与运镜编排器
 *
 * 零 DOM 依赖，纯函数可由 Node 单元测试直跑。
 */

export const VITRAIL_ARCHETYPES = [
    'cathedral',
    'observatory',
    'cloister',
    'pavilion',
    'rotunda',
    'arcade',
    'scriptorium',
    'atrium',
];
export const VITRAIL_PRESET_KEYS = ['amber', 'sapphire', 'jade', 'crimson', 'moonlight', 'alabaster'];
export const VITRAIL_MOVEMENTS = ['sanctuary', 'gallery', 'horizon', 'altar'];

export const VITRAIL_SCENE_SUITES = {
    cathedral: ['cathedral', 'scriptorium', 'rotunda', 'cathedral'],
    observatory: ['observatory', 'rotunda', 'atrium', 'observatory'],
    cloister: ['cloister', 'arcade', 'scriptorium', 'cloister'],
    pavilion: ['pavilion', 'atrium', 'arcade', 'pavilion'],
    rotunda: ['rotunda', 'observatory', 'cathedral', 'rotunda'],
    arcade: ['arcade', 'cloister', 'atrium', 'arcade'],
    scriptorium: ['scriptorium', 'cathedral', 'arcade', 'scriptorium'],
    atrium: ['atrium', 'pavilion', 'rotunda', 'atrium'],
};

export const VITRAIL_PALETTE_PROGRESSION = {
    amber: ['amber', 'crimson', 'amber', 'amber'],
    sapphire: ['sapphire', 'moonlight', 'sapphire', 'sapphire'],
    jade: ['jade', 'moonlight', 'jade', 'jade'],
    crimson: ['crimson', 'amber', 'crimson', 'crimson'],
    moonlight: ['moonlight', 'sapphire', 'moonlight', 'moonlight'],
    alabaster: ['alabaster', 'alabaster', 'alabaster', 'alabaster'],
};

/** @typedef {{
 *   key: string, label: string, isLight: boolean,
 *   bgTop: string, bgHorizon: string, stoneBase: string, stoneTrim: string,
 *   metal: string, glassA: string, glassB: string, glassC: string,
 *   waterTint: string, lightColor: string, fillColor: string,
 *   ink: string, inkMuted: string, accent: string, scrimBg: string,
 *   fogDensity: number, bloomBoost: number
 * }} VitrailPalette */

/** @type {Record<string, VitrailPalette>} */
export const VITRAIL_PALETTES = {
    amber: {
        key: 'amber',
        label: '琥珀圣殿 · Sainte Amber',
        isLight: false,
        bgTop: '#08070b',
        bgHorizon: '#1c130e',
        stoneBase: '#201b17',
        stoneTrim: '#3a3028',
        metal: '#dfa952',
        glassA: '#ef9c38',
        glassB: '#c94c31',
        glassC: '#588aa8',
        waterTint: '#110d0a',
        lightColor: '#ffd48c',
        fillColor: '#48607d',
        ink: '#f8f1e4',
        inkMuted: 'rgba(248, 241, 228, 0.58)',
        accent: '#f2bf63',
        scrimBg: 'rgba(12, 10, 8, 0.42)',
        fogDensity: 0.022,
        bloomBoost: 1.0,
    },
    sapphire: {
        key: 'sapphire',
        label: '群青圣堂 · Chartres Blue',
        isLight: false,
        bgTop: '#050812',
        bgHorizon: '#10192d',
        stoneBase: '#161d2b',
        stoneTrim: '#2b374e',
        metal: '#c8d0de',
        glassA: '#3b82e0',
        glassB: '#7bc1f9',
        glassC: '#de9a4e',
        waterTint: '#08101e',
        lightColor: '#a6cfff',
        fillColor: '#3b4e73',
        ink: '#f0f5ff',
        inkMuted: 'rgba(240, 245, 255, 0.58)',
        accent: '#7fb9ff',
        scrimBg: 'rgba(8, 12, 22, 0.44)',
        fogDensity: 0.021,
        bloomBoost: 1.0,
    },
    jade: {
        key: 'jade',
        label: '青石水院 · Ando Celadon',
        isLight: false,
        bgTop: '#060c0b',
        bgHorizon: '#101f1b',
        stoneBase: '#18231f',
        stoneTrim: '#2d3f37',
        metal: '#c0a97c',
        glassA: '#49b595',
        glassB: '#85d8b4',
        glassC: '#dfb76c',
        waterTint: '#071411',
        lightColor: '#cbf2e3',
        fillColor: '#31524b',
        ink: '#eff8f3',
        inkMuted: 'rgba(239, 248, 243, 0.58)',
        accent: '#7fdab9',
        scrimBg: 'rgba(8, 16, 14, 0.42)',
        fogDensity: 0.021,
        bloomBoost: 0.96,
    },
    crimson: {
        key: 'crimson',
        label: '朱砂穹殿 · Vermilion Dome',
        isLight: false,
        bgTop: '#0c0709',
        bgHorizon: '#231015',
        stoneBase: '#24171b',
        stoneTrim: '#3f272d',
        metal: '#e3b56c',
        glassA: '#dd4a3c',
        glassB: '#ee9449',
        glassC: '#63789f',
        waterTint: '#14090c',
        lightColor: '#ffb98f',
        fillColor: '#5c3847',
        ink: '#fcf2ea',
        inkMuted: 'rgba(252, 242, 234, 0.58)',
        accent: '#f27858',
        scrimBg: 'rgba(18, 9, 12, 0.44)',
        fogDensity: 0.022,
        bloomBoost: 1.02,
    },
    moonlight: {
        key: 'moonlight',
        label: '银月浑仪 · Nocturne Silver',
        isLight: false,
        bgTop: '#07090f',
        bgHorizon: '#141924',
        stoneBase: '#1a1f28',
        stoneTrim: '#313847',
        metal: '#d3d9e5',
        glassA: '#aebfd9',
        glassB: '#6d88ba',
        glassC: '#ceb68b',
        waterTint: '#0b1019',
        lightColor: '#e0e9fa',
        fillColor: '#485775',
        ink: '#f5f7fc',
        inkMuted: 'rgba(245, 247, 252, 0.58)',
        accent: '#c7d8f7',
        scrimBg: 'rgba(10, 13, 20, 0.44)',
        fogDensity: 0.020,
        bloomBoost: 0.95,
    },
    alabaster: {
        key: 'alabaster',
        label: '白石日影 · Travertine Sun',
        isLight: true,
        bgTop: '#cfc6b5',
        bgHorizon: '#e9e1cf',
        stoneBase: '#c6bc9f',
        stoneTrim: '#8b7b61',
        metal: '#8c692e',
        glassA: '#d5993b',
        glassB: '#448292',
        glassC: '#b3533a',
        waterTint: '#6c7975',
        lightColor: '#fff5de',
        fillColor: '#9c9282',
        ink: '#171410',
        inkMuted: 'rgba(23, 20, 16, 0.60)',
        accent: '#9b6418',
        scrimBg: 'rgba(236, 229, 214, 0.44)',
        fogDensity: 0.015,
        bloomBoost: 0.58,
    },
};

export function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

export function lerp(a, b, t) {
    return a + (b - a) * t;
}

export function smoothstep01(t) {
    const x = clamp(t, 0, 1);
    return x * x * (3 - 2 * x);
}

export function smootherstep01(t) {
    const x = clamp(t, 0, 1);
    return x * x * x * (x * (x * 6 - 15) + 10);
}

/**
 * 在两套材质色板之间平滑插值，包含 lightMix 连续昼夜过渡权重。
 */
export function lerpVitrailPalette(palA, palB, t = 0) {
    const a = palA || VITRAIL_PALETTES.amber;
    const b = palB || a;
    const k = clamp(Number(t) || 0, 0, 1);
    if (k <= 0.0005 || a === b) {
        return { ...a, lightMix: a.isLight ? 1 : 0 };
    }
    if (k >= 0.9995) {
        return { ...b, lightMix: b.isLight ? 1 : 0 };
    }
    const lightMix = lerp(a.isLight ? 1 : 0, b.isLight ? 1 : 0, k);
    return {
        key: k < 0.5 ? a.key : b.key,
        label: k < 0.5 ? a.label : b.label,
        isLight: lightMix >= 0.5,
        lightMix,
        bgTop: mixHex(a.bgTop, b.bgTop, k),
        bgHorizon: mixHex(a.bgHorizon, b.bgHorizon, k),
        stoneBase: mixHex(a.stoneBase, b.stoneBase, k),
        stoneTrim: mixHex(a.stoneTrim, b.stoneTrim, k),
        metal: mixHex(a.metal, b.metal, k),
        glassA: mixHex(a.glassA, b.glassA, k),
        glassB: mixHex(a.glassB, b.glassB, k),
        glassC: mixHex(a.glassC, b.glassC, k),
        waterTint: mixHex(a.waterTint, b.waterTint, k),
        lightColor: mixHex(a.lightColor, b.lightColor, k),
        fillColor: mixHex(a.fillColor, b.fillColor, k),
        ink: k < 0.5 ? a.ink : b.ink,
        inkMuted: k < 0.5 ? a.inkMuted : b.inkMuted,
        accent: mixHex(a.accent, b.accent, k),
        scrimBg: k < 0.5 ? a.scrimBg : b.scrimBg,
        fogDensity: lerp(a.fogDensity ?? 0.02, b.fogDensity ?? 0.02, k),
        bloomBoost: lerp(a.bloomBoost ?? 1, b.bloomBoost ?? 1, k),
    };
}

/**
 * 为整首歌解析和谐的多幕场景巡礼序列（显式指定建筑则锁定单场景，否则按篇章舒缓递进）
 */
export function resolveVitrailSceneSuite({
    archetype = 'cathedral',
    paletteKey = 'amber',
    presetOverride = 'auto',
    archOverride = 'auto',
} = {}) {
    const validArch = VITRAIL_ARCHETYPES.includes(archetype) ? archetype : 'cathedral';
    const validPal = VITRAIL_PALETTES[paletteKey] ? paletteKey : 'amber';
    const archSuite = (archOverride && archOverride !== 'auto' && VITRAIL_ARCHETYPES.includes(archOverride))
        ? [archOverride]
        : (VITRAIL_SCENE_SUITES[validArch] || [validArch]);
    const palSuite = (presetOverride && presetOverride !== 'auto' && VITRAIL_PALETTES[presetOverride])
        ? archSuite.map(() => presetOverride)
        : (VITRAIL_PALETTE_PROGRESSION[validPal] || archSuite.map(() => validPal));
    return archSuite.map((arch, idx) => ({
        archetype: arch,
        paletteKey: palSuite[idx % palSuite.length] || validPal,
    }));
}

export function hashVitrailString(str = '') {
    const s = String(str || '');
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
}

export function parseHexRgb(hex = '#ffffff') {
    const clean = String(hex || '').trim().replace(/^#/, '');
    if (clean.length === 3) {
        return {
            r: parseInt(clean[0] + clean[0], 16) || 0,
            g: parseInt(clean[1] + clean[1], 16) || 0,
            b: parseInt(clean[2] + clean[2], 16) || 0,
        };
    }
    if (clean.length >= 6) {
        const n = parseInt(clean.slice(0, 6), 16);
        if (!Number.isNaN(n)) {
            return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
        }
    }
    return { r: 232, g: 190, b: 106 };
}

export function rgbToHex(r, g, b) {
    const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return `#${c(r)}${c(g)}${c(b)}`;
}

export function hexToVec3(hex) {
    const { r, g, b } = parseHexRgb(hex);
    return [r / 255, g / 255, b / 255];
}

export function mixHex(hexA, hexB, t = 0.5) {
    const a = parseHexRgb(hexA);
    const b = parseHexRgb(hexB);
    const k = clamp(Number(t) || 0, 0, 1);
    return rgbToHex(lerp(a.r, b.r, k), lerp(a.g, b.g, k), lerp(a.b, b.b, k));
}

export function rgbToHsl(r, g, b) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) * 0.5;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    return { h: (h / 6) * 360, s, l };
}

/**
 * 分析歌词时间与文字特征（曲速代理、语种倾向、情绪密度），供曲风匹配使用。
 */
export function extractSongTextMetrics(lyrics = [], aiData = {}, songData = {}) {
    const list = Array.isArray(lyrics) ? lyrics : [];
    const gaps = [];
    let fastCount = 0;
    let cjkChars = 0;
    let kanaChars = 0;
    let latinChars = 0;
    let chorusHintCount = 0;

    for (let i = 0; i < list.length; i++) {
        const line = list[i];
        const text = String(line?.original ?? line?.text ?? '').trim();
        if (!text) continue;
        for (const ch of text) {
            if (/[\u3040-\u30ff]/.test(ch)) kanaChars++;
            else if (/[\u4e00-\u9fff]/.test(ch)) cjkChars++;
            else if (/[a-zA-Z]/.test(ch)) latinChars++;
        }
        if (line?.isChorus || line?.chorus) chorusHintCount++;
        if (i + 1 < list.length) {
            const t0 = Number(line?.time ?? line?.start ?? 0) || 0;
            const t1 = Number(list[i + 1]?.time ?? list[i + 1]?.start ?? 0) || 0;
            const ms0 = t0 > 1000 ? t0 : t0 * 1000;
            const ms1 = t1 > 1000 ? t1 : t1 * 1000;
            const d = ms1 - ms0;
            if (d > 250 && d < 18000) {
                gaps.push(d);
                if (d < 2200) fastCount++;
            }
        }
    }

    const avgGapMs = gaps.length > 0
        ? gaps.reduce((a, b) => a + b, 0) / gaps.length
        : 3600;
    const fastRatio = gaps.length > 0 ? fastCount / gaps.length : 0.25;
    const totalChars = Math.max(1, cjkChars + kanaChars + latinChars);
    let scriptKind = 'mixed';
    if (kanaChars / totalChars > 0.14) scriptKind = 'ja';
    else if (cjkChars / totalChars > 0.55) scriptKind = 'zh';
    else if (latinChars / totalChars > 0.65) scriptKind = 'latin';

    const rawMood = [
        aiData?.mood,
        aiData?.theme,
        aiData?.emotion,
        aiData?.style,
        aiData?.description,
        songData?.title,
        songData?.album,
    ].filter(Boolean).join(' ').toLowerCase();

    return {
        lineCount: list.length,
        avgGapMs,
        fastRatio,
        chorusRatio: list.length > 0 ? chorusHintCount / list.length : 0,
        scriptKind,
        rawMood,
    };
}

function chooseAutoPaletteFromCoverAndMood(metrics, aiData = {}, coverPalette = null, seed = 0) {
    const mood = metrics.rawMood || '';
    const refColor = coverPalette?.primary || coverPalette?.accent || aiData?.accent_color || '';
    let bestKey;

    if (refColor && /^#?[0-9a-f]{3,8}$/i.test(String(refColor).trim())) {
        const { r, g, b } = parseHexRgb(refColor);
        const { h, s, l } = rgbToHsl(r, g, b);
        if (s < 0.14) {
            bestKey = l > 0.72 && !/night|dark|夜|暗|痛/.test(mood) ? 'alabaster' : 'moonlight';
        } else if (h >= 190 && h < 260) {
            bestKey = 'sapphire';
        } else if (h >= 110 && h < 190) {
            bestKey = 'jade';
        } else if (h < 22 || h >= 325) {
            bestKey = 'crimson';
        } else if (h >= 22 && h < 62) {
            bestKey = (l > 0.66 && metrics.fastRatio < 0.3) ? 'alabaster' : 'amber';
        } else {
            bestKey = 'sapphire';
        }
    } else if (/sun|day|morning|white|pure|light|晴|晨|白|光|风|夏/.test(mood)) {
        bestKey = 'alabaster';
    } else if (/rain|forest|sea|green|teal|竹|林|雨|青|山|水|静/.test(mood)) {
        bestKey = 'jade';
    } else if (/night|star|cosmos|moon|cyber|dream|夜|星|月|梦|蓝|海/.test(mood)) {
        bestKey = 'sapphire';
    } else if (/fire|blood|passion|rose|crimson|红|烈|焰|爱|伤/.test(mood)) {
        bestKey = 'crimson';
    } else {
        const idx = seed % VITRAIL_PRESET_KEYS.length;
        bestKey = VITRAIL_PRESET_KEYS[idx];
    }

    const base = { ...VITRAIL_PALETTES[bestKey] };
    // 微妙融入封面点缀色到彩窗与金属高光，同时钳制明度保护架构对比度
    const coverAccent = coverPalette?.accent || coverPalette?.primary || aiData?.accent_color;
    if (coverAccent && /^#[0-9a-f]{3,6}$/i.test(String(coverAccent).trim())) {
        base.glassA = mixHex(base.glassA, coverAccent, 0.34);
        if (!base.isLight) {
            base.bgHorizon = mixHex(base.bgHorizon, coverAccent, 0.12);
            base.accent = mixHex(base.accent, coverAccent, 0.25);
        } else {
            base.stoneTrim = mixHex(base.stoneTrim, coverAccent, 0.18);
        }
    }
    return base;
}

/**
 * 为当前歌曲解析最匹配的建筑形态（archetype）与材质光影方案（palette）。
 */
export function resolveVitrailSongProfile({
    lyrics = [],
    aiData = {},
    coverPalette = null,
    songData = {},
    presetOverride = 'auto',
    archOverride = 'auto',
} = {}) {
    const metrics = extractSongTextMetrics(lyrics, aiData, songData);
    const seed = hashVitrailString(`${songData?.title || ''}|${songData?.artist || ''}|${metrics.lineCount}`);

    // 1. 材质色板
    const palette = (presetOverride && presetOverride !== 'auto' && VITRAIL_PALETTES[presetOverride])
        ? { ...VITRAIL_PALETTES[presetOverride] }
        : chooseAutoPaletteFromCoverAndMood(metrics, aiData, coverPalette, seed);

    // 2. 建筑原型打分
    let archetype = VITRAIL_ARCHETYPES[seed % VITRAIL_ARCHETYPES.length];
    if (archOverride && archOverride !== 'auto' && VITRAIL_ARCHETYPES.includes(archOverride)) {
        archetype = archOverride;
    } else {
        const scores = { cathedral: 1, observatory: 1, cloister: 1, pavilion: 1 };
        const mood = metrics.rawMood;

        // 节奏与密度权重
        if (metrics.avgGapMs >= 3700) {
            scores.cathedral += 1.4;
            scores.cloister += 1.2;
        } else if (metrics.avgGapMs <= 2400 || metrics.fastRatio > 0.42) {
            scores.pavilion += 2.2;
            scores.observatory += 0.9;
        } else {
            scores.observatory += 1.0;
        }

        // 语种与文化意象微调
        if (metrics.scriptKind === 'zh' || metrics.scriptKind === 'ja') {
            scores.cloister += 0.8;
        }
        if (metrics.scriptKind === 'latin' && metrics.avgGapMs > 3000) {
            scores.cathedral += 0.7;
        }

        // 情绪关键词精准匹配
        if (/sacred|solemn|grand|epic|ballad|gothic|soul|悲|圣|诗|咏|哀|叹|教堂|钟/.test(mood)) {
            scores.cathedral += 2.4;
        }
        if (/night|star|space|electronic|ambient|synth|orbit|cosmic|梦|星|月|宇宙|幻|夜/.test(mood)) {
            scores.observatory += 2.4;
        }
        if (/calm|heal|acoustic|folk|rain|quiet|warm|nostalgia|雨|风|静|民谣|治愈|禅|院|夏|回忆/.test(mood)) {
            scores.cloister += 2.4;
        }
        if (/bright|dance|pop|upbeat|energetic|prism|party|hop|燃|欢|跃|光|舞|晴|快/.test(mood)) {
            scores.pavilion += 2.4;
        }

        // 使用 seed 做微小打破平局，确保无关键词曲库仍多姿多彩
        const baseCandidates = ['cathedral', 'observatory', 'cloister', 'pavilion'];
        baseCandidates.forEach((a, idx) => {
            scores[a] += (((seed >> (idx * 4)) & 15) / 100);
        });

        // 附加拓展原型在特定意象下的微加权（如水上威尼斯/古书阁/植物温室/万神殿）
        const extScores = { rotunda: 0, arcade: 0, scriptorium: 0, atrium: 0 };
        if (/venice|water|canal|river|harbor|水城|长廊|画舫|溪|波/.test(mood)) extScores.arcade += 3.2;
        if (/library|book|scroll|letter|letterpress|ink|书|墨|笺|信|章|古卷/.test(mood)) extScores.scriptorium += 3.2;
        if (/glasshouse|garden|flower|spring|botanical|花|叶|春|绿|晨露|光阴/.test(mood)) extScores.atrium += 3.2;
        if (/pantheon|dome|halo|oracle|orbit|万神|穹|轮回|圣坛/.test(mood)) extScores.rotunda += 3.2;

        let topScore = -Infinity;
        for (const key of VITRAIL_ARCHETYPES) {
            const total = (scores[key] || 0) + (extScores[key] || 0);
            if (total > topScore) {
                topScore = total;
                archetype = key;
            }
        }
    }

    const suite = resolveVitrailSceneSuite({
        archetype,
        paletteKey: palette.key,
        presetOverride,
        archOverride,
    });

    return {
        archetype,
        palette,
        suite,
        metrics,
        seed,
        tempoEnergyScale: clamp(3200 / Math.max(1200, metrics.avgGapMs), 0.65, 1.55),
    };
}

function applyArchetypeCameraOffset(pose, archetype) {
    if (archetype === 'cathedral') {
        pose.y -= 0.16;
        pose.z += 0.12;
        pose.ty += 0.34;
        pose.fov += 1.5;
    } else if (archetype === 'observatory') {
        pose.y += 0.38;
        pose.z += 0.36;
        pose.ty += 0.42;
        pose.fov += 3.5;
    } else if (archetype === 'cloister') {
        pose.y -= 0.34;
        pose.z += 0.48;
        pose.ty -= 0.16;
        pose.fov -= 2.5;
    } else if (archetype === 'pavilion') {
        pose.y -= 0.06;
        pose.z -= 0.24;
        pose.ty += 0.20;
        pose.fov += 5.0;
    } else if (archetype === 'rotunda') {
        pose.y -= 0.24;
        pose.z += 0.50;
        pose.ty += 0.56;
        pose.fov += 4.5;
    } else if (archetype === 'arcade') {
        pose.y += 0.08;
        pose.z += 0.56;
        pose.ty -= 0.06;
        pose.fov += 3.0;
    } else if (archetype === 'scriptorium') {
        pose.y += 0.18;
        pose.z += 0.16;
        pose.ty += 0.22;
        pose.fov += 1.5;
    } else if (archetype === 'atrium') {
        pose.y += 0.26;
        pose.z += 0.30;
        pose.ty += 0.28;
        pose.fov += 4.0;
    }
    return pose;
}

/**
 * 为单一分镜生成柔和连贯的构图参考基点（采用全局歌序连续谐波，彻底消除逐句哈希随机左右跳变）
 */
function computeShotCameraCue(shot, archetype, amp) {
    const lineIdx = shot?.lineIndex ?? shot?.index ?? 0;
    const totalChunks = Math.max(1, shot?.totalChunks || 1);
    const chunkIdx = clamp(shot?.chunkIndex || 0, 0, totalChunks - 1);
    const idx = lineIdx + (chunkIdx / totalChunks);
    const songPhase = ((shot?.songSeed ?? 0) & 255) * 0.0245;
    const isChorus = Boolean(shot?.isChorus);
    const isInterlude = shot?.kind === 'interlude' || shot?.kind === 'colophon';
    const m = shot?.movement || 'sanctuary';

    // 低频连续谐波构图：按句序沿着中轴柔和游弋，相邻分句与切块自然衔接
    let x = Math.sin(idx * 0.42 + songPhase) * 0.46 * amp;
    let y = 2.16 + Math.cos(idx * 0.31 + songPhase * 0.5) * 0.12 * amp;
    let z = 4.78 + Math.sin(idx * 0.24 + 0.6) * 0.24 * amp;
    let tx = -x * 0.16;
    let ty = 2.38;
    let fov = 46;

    if (m === 'altar' || isChorus) {
        y -= 0.16; // 高潮/圣坛微微低机位仰视，增强穹顶压迫感与神圣感
        z -= 0.30;
        ty += 0.09;
        fov = 44.6;
    } else if (m === 'gallery') {
        x *= 1.12;
        z += 0.12;
        fov = 45.6;
    } else if (isInterlude) {
        x *= 0.65;
        y += 0.15;
        z += 0.38;
        ty += 0.16;
        fov = 47.8;
    }

    const base = { x, y, z, tx, ty, fov };
    return archetype ? applyArchetypeCameraOffset(base, archetype) : base;
}

function resolveShotMotionSpan(shot, nextShot) {
    if (!shot || !Number.isFinite(shot.startSec)) {
        return { start: 0, end: 2.0, dur: 2.0 };
    }
    const start = shot.startSec;
    let end = Math.max(start + 0.35, Number(shot.endSec) || (start + 2.0));
    const nextStart = nextShot && Number.isFinite(nextShot.startSec) ? nextShot.startSec : null;
    if (nextStart !== null && nextStart > start + 0.05) {
        // 若两句间为普通喘息间隔 (<4.5s) 或时间戳轻微重叠，把运动跨度直接接到下句起点，机位不停顿直滑过界
        if (nextStart < end || (nextStart - end) < 4.5) {
            end = nextStart;
        }
    }
    return { start, end, dur: Math.max(0.25, end - start) };
}

function boundaryCueVelocity(cueA, spanA, cueB, spanB) {
    // 边界左右双方共用同一分母公式，确保跨句界时 m/s 世界速度矢量完全一致（C1 切线无折角）
    const dA = spanA.dur;
    const dB = spanB.dur;
    const effDur = Math.max(0.65, (dA + dB) * 0.5, 0.72 * Math.max(dA, dB));
    return {
        x: (cueB.x - cueA.x) / effDur,
        y: (cueB.y - cueA.y) / effDur,
        z: (cueB.z - cueA.z) / effDur,
        tx: (cueB.tx - cueA.tx) / effDur,
        ty: (cueB.ty - cueA.ty) / effDur,
        fov: (cueB.fov - cueA.fov) / effDur,
    };
}

function hermiteCue(p0, v0, p1, v1, dur, u) {
    const t = clamp(u, 0, 1);
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    const evalField = (k) => h00 * p0[k] + h10 * (v0[k] * dur) + h01 * p1[k] + h11 * (v1[k] * dur);
    return {
        x: evalField('x'),
        y: evalField('y'),
        z: evalField('z'),
        tx: evalField('tx'),
        ty: evalField('ty'),
        fov: evalField('fov'),
    };
}

function lerpCameraCue(a, b, t) {
    return {
        x: lerp(a.x, b.x, t),
        y: lerp(a.y, b.y, t),
        z: lerp(a.z, b.z, t),
        tx: lerp(a.tx, b.tx, t),
        ty: lerp(a.ty, b.ty, t),
        fov: lerp(a.fov, b.fov, t),
    };
}

/**
 * 为每个分镜计算全局 C1 连续、世界速度平滑衔接且 Seek 100% 幂等的 3D 机位轨迹。
 * 采用跨分句中点三次 Hermite 样条（兼容 B 样条凹凸包性质），句界零刹车、句中不停滞，并支持场景过渡插值。
 */
export function computeVitrailCameraPose({
    timeSec = 0,
    shot = null,
    prevShot = null,
    nextShot = null,
    nextNextShot = null,
    archetype = 'cathedral',
    fromArchetype = null,
    sceneMix = 1,
    cameraAmp = 0.85,
    pointerX = 0,
    pointerY = 0,
    audioEnergy = 0,
} = {}) {
    const amp = clamp(Number(cameraAmp ?? 0.85), 0, 1.5);
    const hasSceneEnvelope = Boolean(fromArchetype);
    const curSpan = resolveShotMotionSpan(shot, nextShot);
    const cueArch = (s) => (hasSceneEnvelope ? null : (s?.sceneArchetype || archetype));
    const curCue = computeShotCameraCue(shot, cueArch(shot), amp);
    let basePose;
    if (!shot || !Number.isFinite(shot.startSec) || !Number.isFinite(shot.endSec)) {
        basePose = curCue;
    } else {
        const prevSpan = resolveShotMotionSpan(prevShot, shot);
        const nextSpan = resolveShotMotionSpan(nextShot, nextNextShot);
        const prevCue = prevShot ? computeShotCameraCue(prevShot, cueArch(prevShot), amp) : curCue;
        const nextCue = nextShot ? computeShotCameraCue(nextShot, cueArch(nextShot), amp) : curCue;

        const p0 = lerpCameraCue(prevCue, curCue, 0.5);
        const p1 = lerpCameraCue(curCue, nextCue, 0.5);
        const v0 = prevShot
            ? boundaryCueVelocity(prevCue, prevSpan, curCue, curSpan)
            : { x: 0, y: 0, z: 0, tx: 0, ty: 0, fov: 0 };
        const v1 = nextShot
            ? boundaryCueVelocity(curCue, curSpan, nextCue, nextSpan)
            : { x: 0, y: 0, z: 0, tx: 0, ty: 0, fov: 0 };
        const u = clamp((timeSec - curSpan.start) / curSpan.dur, 0, 1);
        basePose = hermiteCue(p0, v0, p1, v1, curSpan.dur, u);
    }

    let pose;
    if (hasSceneEnvelope) {
        const toPose = applyArchetypeCameraOffset({ ...basePose }, archetype);
        pose = (fromArchetype !== archetype && sceneMix < 0.999)
            ? lerpCameraCue(applyArchetypeCameraOffset({ ...basePose }, fromArchetype), toPose, clamp(sceneMix, 0, 1))
            : toPose;
    } else {
        pose = basePose;
    }

    // 全局连续呼吸巡航（基于绝对时间而非分句本地进度，确保越过分句边界丝滑零断层）
    const swayX = Math.sin(timeSec * 0.21) * 0.32 * amp;
    const swayY = Math.cos(timeSec * 0.16) * 0.08 * amp;
    const swayZ = Math.sin(timeSec * 0.13 + 0.8) * 0.16 * amp;

    const px = clamp(Number(pointerX) || 0, -1, 1);
    const py = clamp(Number(pointerY) || 0, -1, 1);

    const camX = pose.x + swayX + px * 0.52 * Math.max(0.35, amp);
    const camY = pose.y + swayY + py * 0.28 * Math.max(0.35, amp);
    const camZ = pose.z + swayZ;
    const targetX = pose.tx + swayX * 0.22 + px * 0.12;
    const targetY = pose.ty + py * 0.06;
    const fovDeg = pose.fov - clamp(Number(audioEnergy) || 0, 0, 1) * 1.35;

    return {
        eye: [camX, camY, camZ],
        target: [targetX, targetY, -3.4],
        up: [px * 0.015, 1, 0],
        fovDeg,
    };
}
