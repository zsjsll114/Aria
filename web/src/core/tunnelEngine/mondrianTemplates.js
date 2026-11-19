/* Portions ported from chthollyphile/folia-major (AGPL-3.0) — Copyright (c) chthollyphile and contributors. See THIRD_PARTY_NOTICES.md */
/**
 * mondrianTemplates.js — 蒙德里安模式构图表 v4「夜间风格派」（2026-11-18 重构）
 *
 * v4 重构动机（用户反馈「蒙德里安模式有点丑」）：v2/v3 的莫兰迪粉彩满屏平铺 + 方格纸叠层
 * 既不像蒙德里安、也显脏。回到风格派（De Stijl）本源的三要素：
 *   ① **粗黑分隔线**：每个格子 border = 半线宽（CSS 变量 --m-line），相邻两格拼出整线；
 *      线色 ink 由色板给出，经 `_paintMosaicBlocks` 写入 borderColor（随 MV 因子压薄）；
 *   ② **三原色点睛**：红/蓝/黄 + 米白画纸，只放在画面**边缘/角部的小格**；
 *   ③ **大面积深色画布**（deep/mid 两档）：歌词安全区（约 x 12~88%、y 20~62%，
 *      见 TunnelEngine._computeSectionStableCell）只允许 deep/mid，保白字可读。
 *      亮格（纸/黄）上偶有词块时，引擎 `_isLightColor` 会自动反色为深墨字。
 *
 * 模板块格式：[x, y, w, h, toneIdx]，格子**严格平铺不重叠**（反色判定取第一个命中格）。
 * toneIdx：1=红 2=蓝 3=黄 4=深画布 5=次画布 6=米白纸。
 * 模板级 opts：grid（可选，带细方格的格索引；缺省时自动选最小的次画布格）。
 * 对外接口不变：MOSAIC_COLOR_SETS / buildMosaicPatterns / applyPalette。
 */

/* 色板：三原色 + 纸 + 两档画布 + 墨线。保持低一点的饱和度，避免广告牌式刺眼 */
export const MOSAIC_COLOR_SETS = [
  { name: 'classic', red: '#C8372D', blue: '#1F4A92', yellow: '#EDB92E', paper: '#ECE5D3', deep: '#15161A', mid: '#23252B', ink: '#060607' },
  { name: 'night',   red: '#D0503C', blue: '#2C6BC4', yellow: '#F0C75A', paper: '#E3E0D6', deep: '#0F1626', mid: '#1A2338', ink: '#04060B' },
  { name: 'ochre',   red: '#B8432F', blue: '#2E5A7A', yellow: '#E3A93A', paper: '#EADFC8', deep: '#1D1712', mid: '#2B231C', ink: '#090604' },
  { name: 'forest',  red: '#C2463A', blue: '#24577A', yellow: '#E8BE47', paper: '#E6E2D2', deep: '#101915', mid: '#1B2720', ink: '#040705' },
  { name: 'plum',    red: '#C93C5A', blue: '#3A4FA8', yellow: '#F2C14E', paper: '#EEE6E1', deep: '#18131D', mid: '#251E2C', ink: '#07050A' },
  { name: 'bauhaus', red: '#D9573A', blue: '#3B7EA1', yellow: '#F2D06B', paper: '#F0EBDD', deep: '#1A1C1E', mid: '#2A2D30', ink: '#09090A' },
  { name: 'neon',    red: '#F24B5B', blue: '#3D7BFF', yellow: '#FFD23F', paper: '#E8ECF2', deep: '#0D0E14', mid: '#191B25', ink: '#000000' },
  { name: 'slate',   red: '#B54A3C', blue: '#48627E', yellow: '#D9B25C', paper: '#DCD6CA', deep: '#1B1B1D', mid: '#2A2A2D', ink: '#0A0A0B' },
];

/* hex 变暗系数 f（1=原色）——保留导出，外部/旧代码可能引用 */
export function shadeHex(hex, f) {
  const m = String(hex).replace('#', '');
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  const t = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return '#' + [t(r), t(g), t(b)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/* 色板 → toneIdx(1~6) 颜色表（下标 0 留空） */
export function tonesOf(set) {
  return [null, set.red, set.blue, set.yellow, set.deep, set.mid, set.paper];
}

/* 构图表：quiet（前奏/尾奏，少点睛）/ neutral（主歌）/ loud（副歌，多格多色） */
export const MOSAIC_LAYOUTS = [
  /* ── quiet ── */
  { family: 'band', mood: 'quiet', blocks: [
    [0, 0, 100, 20, 5],
    [0, 20, 100, 52, 4],
    [0, 72, 70, 28, 5],
    [70, 72, 30, 28, 2],
  ] },
  { family: 'corner', mood: 'quiet', blocks: [
    [0, 0, 88, 78, 4],
    [88, 0, 12, 12, 3],
    [88, 12, 12, 66, 5],
    [0, 78, 20, 22, 6],
    [20, 78, 80, 22, 5],
  ] },
  { family: 'tric', mood: 'quiet', blocks: [
    [0, 0, 10, 100, 5],
    [10, 0, 78, 100, 4],
    [88, 0, 12, 74, 5],
    [88, 74, 12, 26, 1],
  ] },
  { family: 'duo', mood: 'quiet', blocks: [
    [0, 0, 100, 66, 4],
    [0, 66, 10, 34, 2],
    [10, 66, 90, 34, 5],
  ] },

  /* ── neutral ── */
  { family: 'classic', mood: 'neutral', blocks: [
    [0, 0, 9, 26, 1],
    [9, 0, 91, 16, 5],
    [0, 26, 9, 74, 4],
    [9, 16, 82, 56, 4],
    [91, 16, 9, 40, 6],
    [91, 56, 9, 44, 2],
    [9, 72, 56, 28, 5],
    [65, 72, 26, 28, 3],
  ] },
  { family: 'pillar', mood: 'neutral', blocks: [
    [0, 0, 8, 36, 6],
    [0, 36, 8, 64, 2],
    [8, 0, 84, 100, 4],
    [92, 0, 8, 62, 5],
    [92, 62, 8, 38, 1],
  ] },
  { family: 'golden', mood: 'neutral', blocks: [
    [0, 0, 62, 84, 4],
    [62, 0, 38, 62, 5],
    [62, 62, 38, 38, 6],
    [0, 84, 18, 16, 1],
    [18, 84, 44, 16, 5],
  ] },
  { family: 'stair', mood: 'neutral', blocks: [
    [0, 0, 14, 14, 3],
    [14, 0, 86, 14, 5],
    [0, 14, 100, 58, 4],
    [0, 72, 28, 28, 5],
    [28, 72, 14, 14, 2],
    [28, 86, 14, 14, 6],
    [42, 72, 58, 28, 5],
  ] },
  { family: 'frame', mood: 'neutral', blocks: [
    [0, 0, 100, 10, 6],
    [0, 10, 100, 64, 4],
    [0, 74, 8, 26, 3],
    [8, 74, 84, 26, 5],
    [92, 74, 8, 26, 1],
  ] },

  /* ── loud ── */
  { family: 'compo', mood: 'loud', blocks: [
    [0, 0, 30, 18, 6],
    [30, 0, 70, 18, 1],
    [0, 18, 100, 50, 4],
    [0, 68, 14, 32, 2],
    [14, 68, 60, 32, 5],
    [74, 68, 26, 16, 6],
    [74, 84, 26, 16, 3],
  ] },
  { family: 'boogie', mood: 'loud', blocks: [
    [0, 0, 18, 12, 3],
    [18, 0, 12, 12, 6],
    [30, 0, 44, 12, 5],
    [74, 0, 26, 12, 1],
    [0, 12, 100, 60, 4],
    [0, 72, 40, 28, 5],
    [40, 72, 10, 28, 2],
    [50, 72, 30, 28, 6],
    [80, 72, 20, 28, 3],
  ] },
  { family: 'lattice', mood: 'loud', blocks: [
    [0, 0, 24, 20, 1],
    [24, 0, 52, 20, 5],
    [76, 0, 24, 20, 6],
    [0, 20, 10, 50, 5],
    [10, 20, 80, 50, 4],
    [90, 20, 10, 50, 2],
    [0, 70, 24, 30, 6],
    [24, 70, 52, 30, 5],
    [76, 70, 24, 30, 3],
  ] },
  { family: 'asym', mood: 'loud', blocks: [
    [0, 0, 70, 16, 5],
    [70, 0, 30, 16, 2],
    [0, 16, 100, 54, 4],
    [0, 70, 12, 30, 1],
    [12, 70, 40, 30, 6],
    [52, 70, 48, 30, 5],
  ] },
  { family: 'cross', mood: 'loud', blocks: [
    [0, 0, 46, 14, 3],
    [46, 0, 8, 14, 6],
    [54, 0, 46, 14, 5],
    [0, 14, 100, 56, 4],
    [0, 70, 46, 30, 5],
    [46, 70, 8, 30, 1],
    [54, 70, 46, 30, 2],
  ] },
];

/* 单块着色（buildMosaicPatterns / applyPalette 共用） */
function paintBlock(b, set, tones) {
  const ti = b.toneIdx;
  return {
    ...b,
    color: tones[ti] || set.deep,
    ink: set.ink,
    gridColor: b.isGrid ? (set.paper + '1F') : b.gridColor,
  };
}

function patternMeta(set, idx) {
  return {
    paletteIdx: idx,
    paletteColors: { ...set },
    gridColor: set.paper,
    accentColor: set.yellow,
    inkColor: set.ink,
    background: set.ink,
    bgGradient: `linear-gradient(0deg, ${set.ink}, ${set.ink})`,
  };
}

/**
 * 渲染构图表为 patterns（TunnelEngine 块池字段兼容）。
 * @param {Function} normBlock TunnelEngine 的块规范化
 */
export function buildMosaicPatterns(normBlock) {
  const patterns = [];
  MOSAIC_LAYOUTS.forEach((tpl, i) => {
    const pIdx = i % MOSAIC_COLOR_SETS.length;
    const set = MOSAIC_COLOR_SETS[pIdx];
    const tones = tonesOf(set);
    /* 细方格只上一个「次画布」小格（历史要求每屏见方格；放边缘小格不抢歌词） */
    let gridIdx = (typeof tpl.grid === 'number') ? tpl.grid : -1;
    if (gridIdx < 0) {
      let best = Infinity;
      tpl.blocks.forEach((b, bi) => {
        const area = b[2] * b[3];
        if (b[4] === 5 && area < best) { best = area; gridIdx = bi; }
      });
    }
    const blocks = tpl.blocks.map((b, bi) => {
      const [x, y, w, h, ti] = b;
      return normBlock(paintBlock({
        x, y, w, h,
        toneIdx: ti,
        opacity: 0.96,
        rotation: 0,
        isGrid: bi === gridIdx,
        isBar: false,
        invertText: false,
        gap: 0,
        gridAngle: 0, gridSpacing: 16, gridLineWidth: 1, gridColor: '',
        barAngle: -20, barSpacing: 20, barColor: '',
      }, set, tones));
    });
    patterns.push({
      blocks,
      family: tpl.family,
      mood: tpl.mood,
      backgroundSolid: true,
      texture: 0,
      isMondrian: true,
      ...patternMeta(set, pIdx),
    });
  });
  return patterns;
}

/**
 * 运行时色板轮换：几何/家族/mood 不变，只换颜色。
 * @param {Object} pattern buildMosaicPatterns 产物（blocks 带 toneIdx）
 * @param {number} colorSetIdx 色板索引
 * @param {Function} normBlock TunnelEngine._normMosaicBlock
 */
export function applyPalette(pattern, colorSetIdx, normBlock) {
  const n = MOSAIC_COLOR_SETS.length;
  const idx = ((colorSetIdx % n) + n) % n;
  const set = MOSAIC_COLOR_SETS[idx];
  const tones = tonesOf(set);
  const blocks = pattern.blocks.map((b) => normBlock(paintBlock(b, set, tones)));
  return { ...pattern, blocks, ...patternMeta(set, idx) };
}
