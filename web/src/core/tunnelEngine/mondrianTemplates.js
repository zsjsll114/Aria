/**
 * mondrianTemplates.js — 蒙德里安模式手工预设布局表 v2（参考实现 tempera 构图移植）
 *
 * v2 关键转变（用户反馈「不如 上游参考项目」后的对照重做）：
 * - **满屏色板拼画**：tempera 的画面是 2~5 块大面积 tone 平板铺满整屏（无深底露出），
 *   而非「深色底上飘半透明块」。底（bgGradient）即 tone 底档，块 alpha 近实心；
 * - **4 档明度阶梯**：tone1(最亮)→tone4(最暗) 由莫兰迪色板派生（shade 压暗系数
 *   0.86/0.72/0.55/0.38），明度有序不乱；接缝线 = ink 深色；
 * - **构图几何逐个移植自 参考实现 temperaSplitCompositions.ts**：
 *   duoSplit(52/48 对分+缝)、quadSplit(四象限+双缝，对角同色)、pillarGap(双柱夹亮槽，
 *   歌词立于槽中)、stairBlocks(底板+对角阶梯)、checkerQuad(棋盘对角同色)、
 *   diagonalHalves(斜切)、cornerWedge(角部体量)、bandTriple(三带)；
 * - 歌词可读性：中央排版区只放 tone2/tone3 中暗档（白字+发光可读），tone1 亮档
 *   只出现在边缘/角部；上游参考项目的「反色滤镜」我们暂无，靠明度约束替代。
 *
 * 模板块格式：[x, y, w, h, toneIdx(1~4), rotation?]
 * 模板级 opts：seam(接缝块索引数组——ink 色细块)、invert 不再使用（满屏色板无深底反差）。
 */

export const MOSAIC_COLOR_SETS = [
  ['#8A9BAF', '#A8B5C4', '#C9B08C', '#E2C8A8'], // 雾霾蓝灰
  ['#9A8E84', '#B8AA9E', '#D2C2AE', '#E8D8C8'], // 奶油米灰
  ['#829590', '#9CB0A8', '#B8C5B0', '#D2DCD0'], // 薄荷灰绿
  ['#897D8E', '#A293A8', '#BFB0C7', '#D4C5D6'], // 紫灰
  ['#8190A0', '#9AA8B8', '#B8C5D0', '#D0DAE4'], // 雾蓝
  ['#8C7C74', '#A5928A', '#C4B2A8', '#DDD0C8'], // 烟灰粉
  ['#809491', '#96AAA0', '#B4C2B6', '#CCD5CD'], // 青绿灰
  ['#868696', '#9E9EAE', '#BDB5C2', '#D6D0DA'], // 薰衣草灰
  ['#7E8A82', '#98A496', '#B4BFA6', '#CCCDBC'], // 橄榄灰
  ['#8E808E', '#A696A4', '#C4B3C2', '#DCC8DA'], // 玫瑰灰
];

/* hex 变暗系数 f（1=原色）——tone 阶梯派生 */
export function shadeHex(hex, f) {
  const m = String(hex).replace('#', '');
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  const t = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return '#' + [t(r), t(g), t(b)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/* 色板 → 4 档明度阶梯（压暗适配白色歌词）：tone1 亮档只在边缘出现 */
export function tonesOf(colors) {
  return [
    shadeHex(colors[3], 0.86), // tone1 最亮（强调色亮档，边缘/角部）
    shadeHex(colors[2], 0.72), // tone2 主
    shadeHex(colors[1], 0.55), // tone3 次（中央排版区友）
    shadeHex(colors[0], 0.38), // tone4 最暗
  ];
}

/* 模板：family / mood / blocks（[x,y,w,h,toneIdx,rotation?]）/ seam（接缝块索引） */
export const MOSAIC_LAYOUTS = [
  /* ── duo 对分族（tempera duoSplit）：52/48 对分 + ink 接缝 ── */
  { family: 'duo', mood: 'neutral', seam: [2], blocks: [
    [0, 0, 100, 52, 3],          // 上 tone4 暗档
    [0, 52, 100, 48, 2],         // 下 tone3
    [0, 51.7, 100, 0.6, 0],      // 接缝（ink 由渲染层着色）
  ] },
  { family: 'duo', mood: 'neutral', seam: [2], blocks: [
    [0, 0, 52, 100, 2],
    [52, 0, 48, 100, 3],
    [51.7, 0, 0.6, 100, 0],
  ] },

  /* ── quad 四象限族（tempera quadSplit）：分割点 46~54 抖动区取中 + 双缝 + 对角同色 ── */
  { family: 'quad', mood: 'loud', seam: [4, 5], blocks: [
    [0, 0, 46, 44, 2],           // 左上 tone3
    [46, 0, 54, 44, 1],          // 右上 tone2
    [0, 44, 46, 56, 1],          // 左下 tone2（对角同色）
    [46, 44, 54, 56, 3],         // 右下 tone4
    [45.7, 0, 0.6, 100, 0],      // 竖缝
    [0, 43.7, 100, 0.6, 0],      // 横缝
  ] },
  { family: 'quad', mood: 'loud', seam: [4, 5], blocks: [
    [0, 0, 54, 48, 1],
    [54, 0, 46, 48, 3],
    [0, 48, 54, 52, 3],
    [54, 48, 46, 52, 2],
    [53.7, 0, 0.6, 100, 0],
    [0, 47.7, 100, 0.6, 0],
  ] },

  /* ── pillarGap 双柱夹槽族：歌词立于两柱之间的亮槽（tempera pillarGap） ── */
  { family: 'pillarGap', mood: 'neutral', blocks: [
    [0, 0, 30, 100, 3],          // 左暗柱
    [70, 0, 30, 100, 3],         // 右暗柱
    [29.7, 0, 0.6, 100, 0],      // 缝
    [69.7, 0, 0.6, 100, 0],      // 缝
  ] },  // 中央 40% 露底（bgGradient=中亮档）——歌词的亮槽
  { family: 'pillarGap', mood: 'neutral', blocks: [
    [0, 0, 100, 30, 3],          // 上暗柱
    [0, 70, 100, 30, 3],         // 下暗柱
    [0, 29.7, 100, 0.6, 0],
    [0, 69.7, 100, 0.6, 0],
  ] },

  /* ── stair 阶梯族（tempera stairBlocks）：底板 + 4 块沿对角线阶梯渐深 ── */
  { family: 'stair', mood: 'neutral', blocks: [
    [-2, -2, 104, 104, 2, 0],    // 全屏底板
    [6, 10, 30, 34, 1],          // 阶梯 1（右移 20%/下移 16% 步进）
    [26, 26, 30, 34, 3],
    [46, 42, 30, 34, 1],
    [66, 58, 30, 34, 4],
  ] },

  /* ── checker 棋盘族（tempera checkerQuad）：四象限对角同色 + 双缝 ── */
  { family: 'checker', mood: 'loud', seam: [4, 5], blocks: [
    [0, 0, 50, 50, 2],
    [50, 0, 50, 50, 3],
    [0, 50, 50, 50, 3],
    [50, 50, 50, 50, 2],
    [49.7, 0, 0.6, 100, 0],
    [0, 49.7, 100, 0.6, 0],
  ] },

  /* ── cornerWedge 角部体量族（tempera cornerWedge）：全屏中档 + 角部大暗块 + 角部小亮块 ── */
  { family: 'corner', mood: 'neutral', blocks: [
    [-2, -2, 104, 104, 2, 0],    // 全屏底
    [-2, -2, 58, 52, 4],         // 左上大暗块
    [74, 74, 28, 28, 1],         // 右下小亮块
  ] },
  { family: 'corner', mood: 'neutral', blocks: [
    [-2, -2, 104, 104, 3, 0],
    [44, 50, 58, 52, 4],         // 右下大暗块
    [4, 8, 22, 16, 1],           // 左上小亮块
  ] },

  /* ── band 三带族：横/竖三带，中央带放歌词 ── */
  { family: 'band', mood: 'quiet', blocks: [
    [0, 0, 100, 28, 3],
    [0, 28, 100, 44, 2],
    [0, 72, 100, 28, 4],
  ] },
  { family: 'band', mood: 'quiet', blocks: [
    [0, 0, 24, 100, 3],
    [24, 0, 46, 100, 2],
    [70, 0, 30, 100, 4],
  ] },
];

/**
 * 渲染布局表为 patterns（TunnelEngine 块池字段兼容）。
 * tone 阶梯 + ink 接缝由色板派生；块 alpha 近实心（0.92）。
 * @param {Function} normBlock TunnelEngine 的块规范化
 */
export function buildMosaicPatterns(normBlock) {
  const patterns = [];
  MOSAIC_LAYOUTS.forEach((tpl, i) => {
    const colors = MOSAIC_COLOR_SETS[(i * 3) % MOSAIC_COLOR_SETS.length];
    const tones = tonesOf(colors);
    const ink = shadeHex(colors[0], 0.22);   // 接缝深色
    const blocks = tpl.blocks.map((b, bi) => {
      const [x, y, w, h, ti, rot] = b;
      const isSeam = Array.isArray(tpl.seam) && tpl.seam.indexOf(bi) >= 0;
      return normBlock({
        x, y, w, h,
        color: isSeam ? ink : (tones[ti - 1] || tones[1]),
        opacity: isSeam ? 0.9 : 0.92,           // 近实心（tempera 0.94~0.96 的深底等效）
        rotation: rot || 0,
        isGrid: false,
        isBar: false,
        invertText: false,
        gap: 0,
        gridAngle: 10, gridSpacing: 24, gridLineWidth: 1.5, gridColor: '',
        barAngle: -20, barSpacing: 20, barColor: '',
      });
    });
    /* 底 = 中央档渐变（pillarGap 的亮槽露的就是它） */
    /* ★ 栅格保底（历史教训：用户要求每屏必见方格——v2 模板化后只有 classic
       带 grid 索引，quiet 段的 band 族等永远没有方格）：未显式指定 grid 的
       幅面，选面积居中的块强制带栅格（不用最大块——「栅格过多」旧教训） */
    if (tpl.grid == null && blocks.length > 0) {
      const sorted = blocks.slice().sort((a, b) => (a.w * a.h) - (b.w * b.h));
      const mid = sorted[Math.floor(sorted.length / 2)];
      mid.isGrid = true;
      mid.isBar = false;
      mid.gridColor = colors[0] + 'B8';
      if (!mid.gridSpacing || mid.gridSpacing <= 0) mid.gridSpacing = 24;
      if (!mid.gridAngle || mid.gridAngle === 10) mid.gridAngle = 10;
    }
    patterns.push({
      blocks,
      family: tpl.family,
      mood: tpl.mood,
      gridColor: colors[0],
      accentColor: colors[3],
      background: tones[2],
      backgroundSolid: false,
      bgGradient: `linear-gradient(150deg, ${tones[1]} 0%, ${tones[2]} 55%, ${tones[3]} 100%)`,
      texture: 0,
      isMondrian: true,
    });
  });
  return patterns;
}
