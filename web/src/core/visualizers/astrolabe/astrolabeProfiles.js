/**
 * web/src/core/visualizers/astrolabe/astrolabeProfiles.js
 * 「画册 · Folio」（mode: astrolabe）—— 瑞士国际主义平面构成 · 巨型破框天体圆弧 · 版画级实色正负形反色配置表
 *
 * ============================================================================
 * ★ OPUS 5.5 单轮审美精调指南（Single-Round Aesthetic Tuning Guide）
 * ============================================================================
 * 本文件与同目录的 `astrolabeCompositions.js` 是专门为审美精调解耦出的纯前端声明式层：
 * 1. 【5 条去 AI 味铁律（严禁违背）】：
 *    - 严禁廉价发光球 / 霓虹 radialGradient / 半透明糊层：所有色块必须 100% 不透明实色（Opaque Flat Masses）；
 *    - 严禁屏幕正中小圆圈匀速转：所有圆弧/圆环必须巨型破框（圆心在画幅外或边缘，半径 0.65w~2.2w），采用非线性卡点入场 + 渐近阻尼微移 `astrolabeCreep`；
 *    - 严禁伪科幻英文乱码 HUD：只允许纯正印刷裁切标（Crop Marks）、对位十字（Registration Cross）、平行排线（Hatching）与点阵网屏（Halftone Dots）；
 *    - 严禁干瘪 1px 细线网：每个分镜必须由占屏 30%~70% 的大块实色几何面主导，跨越文字触发正负形一刀切反色（Ink <-> Paper）；
 *    - 严禁呆板单行居中：使用下方 8 种瑞士海报级排版拓扑（`ASTROLABE_TYPO_TOPOLOGIES`）与 12 宫非对称黄金锚区。
 * 2. 如需微调配色：直接调整 `ASTROLABE_PALETTES` 的 paper / ink / tones / accent；
 * 3. 如需微调字号与排版张力：直接调整 `ASTROLABE_TYPO_CONFIG` 与 `ASTROLABE_TYPO_TOPOLOGIES`；
 * 4. 如需微调镜头运动感：直接调整 `ASTROLABE_MOTION_TUNING`。
 * ============================================================================
 */

export const ASTROLABE_FAMILIES = Object.freeze([
    'eclipse',       // 01. 偏心巨盘与伴星正负形切分
    'armillary',     // 02. 破框浑天大圆环带交错
    'quadrant',      // 03. 黄金分割象限扇区与直角梁
    'orrery',        // 04. 行星偏心连杆与对位圆盘
    'meridian',      // 05. 跨屏大倾角子午线走廊与色带
    'transit',       // 06. 序列平行切片与快门叶片
    'constellation', // 07. 几何包豪斯构架与观测窗
    'solstice',      // 08. 昼夜平分大画幅阴阳对撞
    'zenith',        // 09. 副歌高能：破框放射构成与核心反色盘
]);

/** 9 大家族 × 6 镜 = 54 种独立主分镜（远超 Prism 36 镜与 Tempera 30 镜） */
export const ASTROLABE_SHOT_KINDS = Object.freeze([
    // 01. eclipse (6)
    'eclipse-corona', 'eclipse-crescent', 'eclipse-binary',
    'eclipse-annular', 'eclipse-penumbra', 'eclipse-totality',
    // 02. armillary (6)
    'armillary-equator', 'armillary-ecliptic', 'armillary-gyro',
    'armillary-solstice', 'armillary-tropics', 'armillary-celestial',
    // 03. quadrant (6)
    'quadrant-tycho', 'quadrant-fibonacci', 'quadrant-sextant',
    'quadrant-octant', 'quadrant-plumb', 'quadrant-vernier',
    // 04. orrery (6)
    'orrery-epicycle', 'orrery-conjunction', 'orrery-syzygy',
    'orrery-retrograde', 'orrery-aphelion', 'orrery-perihelion',
    // 05. meridian (6)
    'meridian-prime', 'meridian-zenith', 'meridian-nadir',
    'meridian-horizon', 'meridian-azimuth', 'meridian-declination',
    // 06. transit (6)
    'transit-venus', 'transit-mercury', 'transit-shutter',
    'transit-chronograph', 'transit-parallax', 'transit-occultation',
    // 07. constellation (6)
    'constellation-atlas', 'constellation-triad', 'constellation-astrolabe',
    'constellation-reticle', 'constellation-cartography', 'constellation-parsec',
    // 08. solstice (6)
    'solstice-summer', 'solstice-winter', 'solstice-equinox',
    'solstice-dawn', 'solstice-dusk', 'solstice-midnight',
    // 09. zenith (6)
    'zenith-nova', 'zenith-pulsar', 'zenith-quasar',
    'zenith-apogee', 'zenith-cosmos', 'zenith-singularity',
]);

/** 8 种瑞士海报级排版拓扑（正交作用于 54 种几何分镜） */
export const ASTROLABE_TYPO_TOPOLOGIES = Object.freeze([
    'swiss-editorial',     // 瑞士网格参差折行（黄金缩进 + 错位行距）
    'staircase-cascade',   // 阶梯瀑布式逐行对角下沉
    'celestial-chord',     // 弦切反向错位（上下行沿圆弧切线相向滑开）
    'fulcrum-pivot',       // 支点主词破版（核心词 1.42x 巨化，短词紧凑环绕）
    'antiphony-split',     // 双栏对位呼应（左高右低双锚点跨色块对话）
    'vertical-manuscript', // 手稿横竖混排（首词竖立铭文柱 + 主体横排破框）
    'orbital-stagger',     // 轨道扇形微偏（多行呈微倾角构成主义扇面展开）
    'monolith-banner',     // 巨石通栏宣言（大字号通栏横跨多重反色边界）
]);

/** 12 宫非对称黄金分割银幕锚区（彻底杜绝句句钉死屏幕正中） */
export const ASTROLABE_FOCAL_ZONES = Object.freeze([
    { id: 'golden-nw',   cx: 0.36, cy: 0.38, w: 0.66, h: 0.50, align: 'left',   tiltDeg: -1.8 },
    { id: 'golden-se',   cx: 0.64, cy: 0.54, w: 0.66, h: 0.50, align: 'right',  tiltDeg: 1.6 },
    { id: 'golden-ne',   cx: 0.63, cy: 0.38, w: 0.66, h: 0.50, align: 'right',  tiltDeg: -1.4 },
    { id: 'golden-sw',   cx: 0.37, cy: 0.54, w: 0.66, h: 0.50, align: 'left',   tiltDeg: 1.8 },
    { id: 'swiss-west',  cx: 0.39, cy: 0.46, w: 0.68, h: 0.54, align: 'left',   tiltDeg: 0 },
    { id: 'swiss-east',  cx: 0.61, cy: 0.46, w: 0.68, h: 0.54, align: 'right',  tiltDeg: 0 },
    { id: 'zenith-high', cx: 0.50, cy: 0.37, w: 0.74, h: 0.48, align: 'center', tiltDeg: -1.2 },
    { id: 'nadir-low',   cx: 0.50, cy: 0.55, w: 0.74, h: 0.48, align: 'center', tiltDeg: 1.2 },
    { id: 'chord-up-l',  cx: 0.42, cy: 0.41, w: 0.70, h: 0.52, align: 'left',   tiltDeg: -2.4 },
    { id: 'chord-dn-r',  cx: 0.58, cy: 0.52, w: 0.70, h: 0.52, align: 'right',  tiltDeg: 2.4 },
    { id: 'poster-axis', cx: 0.48, cy: 0.45, w: 0.76, h: 0.56, align: 'center', tiltDeg: 0 },
    { id: 'offset-wide', cx: 0.53, cy: 0.44, w: 0.74, h: 0.54, align: 'left',   tiltDeg: -0.9 },
]);

/** 10 种版画与构成主义装饰母题（零科幻乱码，纯印刷肌理与几何构成） */
export const ASTROLABE_DECOR_MOTIFS = Object.freeze([
    'crop-marks-swiss',     // 瑞士海报四角裁切标与十字准星
    'hatch-band-diagonal',  // 45° 版画平行排线色带
    'halftone-dot-matrix',  // 印刷网屏圆点矩阵
    'vernier-scale-arc',    // 破框大圆弧精密刻度线
    'bauhaus-cross-grid',   // 包豪斯十字对位标阵列
    'double-chord-secant',  // 贯通画幅的双平行割线与实心锚点
    'stepped-rule-bars',    // 粗细渐变构成主义阶梯横条
    'tangent-plumb-line',   // 垂直铅锤基准线与黄金分割节点
    'corner-block-frame',   // 印刷压边实心角块与内衬线
    'concentric-hairlines', // 极细印刷同心基准弧（圆心在画幅外）
]);

/** 5 种文字入场微动风格 */
export const ASTROLABE_ENTER_STYLES = Object.freeze([
    'editorial-snap', // 利落顺流滑入卡点
    'chord-shear',    // 奇偶行沿弦切方向反向咬合
    'step-drop',      // 阶梯错峰下沉落位
    'pivot-unfold',   // 围绕主词支点微旋展开
    'press-stamp',    // 活版印刷微缩压印定格
]);

/** 5 种分镜交棒转场风格 */
export const ASTROLABE_TRANSITIONS = Object.freeze([
    'flow-relay',     // Tempera 同款顺流惯性交棒（主推）
    'eclipse-wipe',   // 巨型实色圆弧横扫接棒
    'bauhaus-shear',  // 斜切构成色带错峰推拉
    'shutter-split',  // 双叶几何面反向开合
    'chorus-imprint', // 副歌高张力双倍行程冲刺交棒
]);

/**
 * 6 套博物馆级实色印刷色板（100% 不透明实色，零霓虹廉价感）
 * - bg: 主舞台背景纸/底墨色
 * - paper: 反色主块面（亮色羊皮纸/象牙纸/宣纸，内部文字反转为 darkInk）
 * - ink: 深底上的主文字色
 * - dimInk: 深底未唱到的文字色（清晰可读，不发灰）
 * - darkInk: 亮色反色块（paper）内部的深邃油墨字色
 * - dimDarkInk: 亮色反色块内部未唱到的字色
 * - accent: 逐字扫光与核心主词点睛强调色（朱砂/群青/琥珀金/赤陶）
 * - seam: 色块硬边油墨描线色
 * - tones: 3 档不反转文字的深色构成辅助面（用于叠出空间层次）
 */
export const ASTROLABE_PALETTES = Object.freeze({
    obsidian: {
        name: '曜石赤金 · Obsidian & Gold',
        bg: '#0e1017',
        paper: '#f4efe2',
        ink: '#f5efe4',
        dimInk: 'rgba(245, 239, 228, 0.44)',
        darkInk: '#10131c',
        dimDarkInk: 'rgba(16, 19, 28, 0.38)',
        accent: '#e6a832',
        seam: '#2c3345',
        tones: ['#171b26', '#23293a', '#31394f'],
    },
    prussian: {
        name: '普鲁士群青 · Prussian Ultramarine',
        bg: '#08182b',
        paper: '#e7f0f8',
        ink: '#ebf3fa',
        dimInk: 'rgba(235, 243, 250, 0.45)',
        darkInk: '#09192b',
        dimDarkInk: 'rgba(9, 25, 43, 0.38)',
        accent: '#2b7fff',
        seam: '#234268',
        tones: ['#0f2847', '#173c68', '#22548c'],
    },
    bauhaus: {
        name: '包豪斯三原 · Weimar Bauhaus',
        bg: '#1c1816',
        paper: '#f7f2e4',
        ink: '#f8f4ea',
        dimInk: 'rgba(248, 244, 234, 0.45)',
        darkInk: '#161312',
        dimDarkInk: 'rgba(22, 19, 18, 0.38)',
        accent: '#f2b705',
        seam: '#3d3632',
        tones: ['#1c365e', '#b52820', '#2d2825'],
    },
    vermilion: {
        name: '大漆朱砂 · Lacquer Vermilion',
        bg: '#210d0d',
        paper: '#f6ece0',
        ink: '#f7f1e6',
        dimInk: 'rgba(247, 241, 230, 0.45)',
        darkInk: '#1f0e0e',
        dimDarkInk: 'rgba(31, 14, 14, 0.38)',
        accent: '#e63928',
        seam: '#472422',
        tones: ['#361514', '#521f1d', '#2b1b18'],
    },
    celadon: {
        name: '天青石绿 · Celadon Malachite',
        bg: '#0a1f1d',
        paper: '#e4f2ec',
        ink: '#eaf5f0',
        dimInk: 'rgba(234, 245, 240, 0.45)',
        darkInk: '#0b211e',
        dimDarkInk: 'rgba(11, 33, 30, 0.38)',
        accent: '#18b888',
        seam: '#1f4742',
        tones: ['#12332f', '#1c4d46', '#28665e'],
    },
    ochre: {
        name: '赭石古铜 · Ochre & Copper',
        bg: '#1f140d',
        paper: '#f5ead6',
        ink: '#f6efe0',
        dimInk: 'rgba(246, 239, 224, 0.45)',
        darkInk: '#1c120b',
        dimDarkInk: 'rgba(28, 18, 11, 0.38)',
        accent: '#d4882a',
        seam: '#423020',
        tones: ['#332115', '#4a301e', '#263849'],
    },
});

/**
 * 章节色板锚点（按 section 稳定，去逐镜随机抖动）。
 * 旧实现是 (secIdx*2 + floor(hash*2))%6，hash 逐镜抖动让同章节内每镜乱跳两套色板，
 * 整首歌配色像随机抽签。改为只按 section 取锚：同章节共享同一色族（色彩叙事连贯），
 * 镜间差异交给翻页极性（dark/paper/poster，随音乐段落呼吸）而非随机色相。
 * 锚点顺序与 _resolveShotPalette 的 presetKeys 一致。
 * @param {number} sectionIndex
 * @returns {number} 0~5
 */
export function astrolabeChapterIndex(sectionIndex) {
    const sec = Math.max(0, Math.floor(Number(sectionIndex) || 0));
    return (sec * 2) % 6;
}

/** 排版与字号全局基准配置（Opus 5.5 可直接微调） */
export const ASTROLABE_TYPO_CONFIG = Object.freeze({
    lyricsFontScale: 2.15,     // 视口等比字号总乘数（对标 Tempera 2.1x 海报张力）
    viewportRatioCap: 0.132,   // 全屏视口字号上限比例 w * 0.132（1080p 可达 253px，2K 可达 338px）
    minFontPx: 42,             // 最小字号保底
    floorScaleRatio: 0.72,     // 多行自适应缩放时的字号底线比例
    heroWordScale: 1.38,       // 核心主词放大倍率（与 1.0x 构成严格两档字号，确保 Skia 缓存 100% 命中）
    lineHeightRatio: 1.16,     // 行高比例
    cjkTrackingRatio: 0.04,    // 中日韩字间距比例
    latinWordGapRatio: 0.26,   // 西文词间距比例
});

/** 运动与转场曲线全局配置（Opus 5.5 可直接微调） */
export const ASTROLABE_MOTION_TUNING = Object.freeze({
    enterPower: 3.6,           // 切面与分镜非线性卡点入场幂次（越大越干脆利落）
    creepTimeConstantSec: 6.5, // 渐近阻尼微移时间常数（1 - exp(-t / 6.5)，永不死板停滞也绝不乱飞）
    relayTravelRatio: 0.30,    // 切镜顺流交棒行程占屏幕对角线比例
    blockStaggerCarry: 0.11,   // 内部色块错峰追赶位移占屏幕长边比例
    cameraOvershootMul: 0.36,  // 旧镜退场时允许进度越过 1.0 的惯性滑行系数
});

/**
 * 非线性利落入场曲线（Power 3.6）
 * @param {number} t 0..1
 */
export function easeAstrolabeEnter(t) {
    const c = Math.max(0, Math.min(1, Number(t) || 0));
    return 1 - Math.pow(1 - c, ASTROLABE_MOTION_TUNING.enterPower);
}

/**
 * 丝滑对称退场曲线
 * @param {number} t 0..1
 */
export function easeAstrolabeInOut(t) {
    const c = Math.max(0, Math.min(1, Number(t) || 0));
    return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
}

/**
 * Tempera 同款渐近阻尼微移（Asymptotic Creep）：始终保持微妙生命力，但绝不匀速转圈
 * @param {number} elapsedMs
 */
export function astrolabeCreep(elapsedMs) {
    const sec = Math.max(0, (Number(elapsedMs) || 0) * 0.001);
    return 1 - Math.exp(-sec / ASTROLABE_MOTION_TUNING.creepTimeConstantSec);
}
