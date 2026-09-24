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
  ['#8FB4D9', '#AAC9E6', '#C8DDF0', '#E2F0FA'], // 湖蓝
  ['#C9A3CE', '#DABADD', '#E9D1EB', '#F4E4F5'], // 莫奈粉紫
  ['#96C29A', '#B0D4B2', '#CBE3CB', '#E1F0E0'], // 嫩绿
  ['#DBB277', '#E6C795', '#F0DCB5', '#F8EBD4'], // 暖金
  ['#E39B90', '#ECB4AB', '#F4CDC6', '#F9E1DD'], // 珊瑚
  ['#89BCCB', '#A5CEDA', '#C2DFE7', '#DCEFF3'], // 天青
  ['#A99FD1', '#BFB7DF', '#D5CFEA', '#E9E5F4'], // 薰衣草
  ['#D49FB0', '#E0B7C4', '#EBCFD8', '#F4E4EA'], // 玫瑰
  ['#DDB88E', '#E8CBAC', '#F1DCC6', '#F8ECDA'], // 杏色
  ['#9FC7B4', '#B9D8CA', '#D0E6DB', '#E4F1E9'], // 薄荷
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

/* 色板 → 4 档明度阶梯（★ 莫奈化：压暗系数放宽——灰暗感来自低饱和+过暗，
   新色板饱和已提至 45~55%，阶梯只轻微压暗保白字可读；tone1 亮档只在边缘出现 */
export function tonesOf(colors) {
  return [
    shadeHex(colors[3], 0.90), // tone1 最亮（强调色亮档，边缘/角部）
    shadeHex(colors[2], 0.78), // tone2 主
    shadeHex(colors[1], 0.62), // tone3 次（中央排版区友）
    shadeHex(colors[0], 0.46), // tone4 最暗（白字可读底线）
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

  /* ══ v3 扩充（2026-09-24 用户反馈「就四五种样式、不如 folia」）：
     借鉴上游 blockTemplates 的 slot 比例美学——三分律 / 黄金分割 / 不对称四块 /
     L 形 / 中心岛 / 大侧板 + 副条列。版式池 14 → 36 幅，同 mood 池内相邻不重样。 ══ */

  /* ── golden 黄金分割族（61.8 / 38.2 竖横四向） ── */
  { family: 'golden', mood: 'neutral', blocks: [
    [0, 0, 61.8, 100, 2],
    [61.8, 0, 38.2, 100, 3],
  ] },
  { family: 'golden', mood: 'neutral', blocks: [
    [0, 0, 38.2, 100, 3],
    [38.2, 0, 61.8, 100, 2],
  ] },
  { family: 'golden', mood: 'quiet', blocks: [
    [0, 0, 100, 61.8, 2],
    [0, 61.8, 100, 38.2, 3],
  ] },
  { family: 'golden', mood: 'quiet', blocks: [
    [0, 0, 100, 38.2, 3],
    [0, 38.2, 100, 61.8, 2],
  ] },

  /* ── lshape L 形族：大 L 包小体量 ── */
  { family: 'lshape', mood: 'neutral', blocks: [
    [0, 0, 62, 100, 2],
    [62, 0, 38, 58, 3],
    [62, 58, 38, 42, 4],
  ] },
  { family: 'lshape', mood: 'neutral', blocks: [
    [0, 0, 100, 45, 3],
    [0, 45, 55, 55, 2],
    [55, 45, 45, 55, 4],
  ] },

  /* ── triCol 三栏不等宽族（25/45/30 与 30/42/28） ── */
  { family: 'tric', mood: 'quiet', blocks: [
    [0, 0, 25, 100, 3],
    [25, 0, 45, 100, 2],
    [70, 0, 30, 100, 4],
  ] },
  { family: 'tric', mood: 'quiet', blocks: [
    [0, 0, 30, 100, 4],
    [30, 0, 42, 100, 2],
    [72, 0, 28, 100, 3],
  ] },

  /* ── island 中心岛族：满屏衬底 + 中央/偏置亮岛 ── */
  { family: 'island', mood: 'loud', blocks: [
    [0, 0, 100, 100, 3],
    [26, 26, 48, 48, 1],
  ] },
  { family: 'island', mood: 'loud', blocks: [
    [0, 0, 100, 100, 2],
    [20, 22, 34, 56, 4],
    [62, 22, 18, 26, 1],
  ] },
  { family: 'island', mood: 'loud', blocks: [
    [0, 0, 100, 100, 4],
    [14, 14, 44, 44, 2],
    [62, 50, 26, 36, 1],
  ] },

  /* ── asymQuad 不对称四块族（三分律交叉切割） ── */
  { family: 'asym', mood: 'loud', blocks: [
    [0, 0, 30, 100, 3],
    [30, 0, 40, 52, 2],
    [70, 0, 30, 100, 4],
    [30, 52, 40, 48, 1],
  ] },
  { family: 'asym', mood: 'loud', blocks: [
    [0, 0, 70, 42, 2],
    [70, 0, 30, 58, 3],
    [0, 42, 44, 58, 4],
    [44, 42, 56, 58, 1],
  ] },
  { family: 'asym', mood: 'neutral', blocks: [
    [0, 0, 55, 100, 2],
    [55, 0, 45, 35, 3],
    [55, 35, 45, 30, 1],
    [55, 65, 45, 35, 4],
  ] },
  { family: 'asym', mood: 'neutral', blocks: [
    [0, 0, 100, 35, 3],
    [0, 35, 62, 65, 2],
    [62, 35, 38, 40, 1],
    [62, 75, 38, 25, 4],
  ] },

  /* ── panel 大侧板族：主版面 + 副条列（folia sidePanel 比例） ── */
  { family: 'panel', mood: 'neutral', blocks: [
    [0, 0, 72, 100, 2],
    [72, 0, 28, 33, 3],
    [72, 33, 28, 34, 4],
    [72, 67, 28, 33, 1],
  ] },
  { family: 'panel', mood: 'quiet', blocks: [
    [0, 0, 28, 100, 4],
    [28, 0, 44, 100, 2],
    [72, 0, 28, 50, 3],
    [72, 50, 28, 50, 1],
  ] },
  { family: 'panel', mood: 'quiet', blocks: [
    [0, 0, 100, 70, 2],
    [0, 70, 34, 30, 3],
    [34, 70, 30, 30, 1],
    [64, 70, 36, 30, 4],
  ] },

  /* ── cross 中心十字带族：横竖带交叉，中央亮块放歌词 ── */
  { family: 'cross', mood: 'loud', blocks: [
    [0, 0, 100, 30, 3],
    [0, 70, 100, 30, 4],
    [0, 30, 32, 40, 2],
    [68, 30, 32, 40, 2],
    [32, 30, 36, 40, 1],
  ] },
  { family: 'cross', mood: 'loud', blocks: [
    [0, 0, 30, 100, 4],
    [70, 0, 30, 100, 3],
    [30, 0, 20, 32, 2],
    [50, 0, 20, 32, 2],
    [30, 32, 40, 36, 1],
    [30, 68, 40, 32, 2],
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
        /* ★ toneIdx 随块存档（seam=-1）：运行时按句组轮换色板（applyPalette）需要
           知道每块在明度阶梯里的档位，否则色板绑死在启动期——同段落内色板永远不变 */
        toneIdx: isSeam ? -1 : ti,
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
      paletteIdx: (i * 3) % MOSAIC_COLOR_SETS.length,
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

/**
 * ★ 运行时色板轮换（2026-09-24 用户反馈「背景 6 句才换、色彩灰暗」）：
 * 同段落内 sectionId 不变导致版式哈希恒定 → 色板整段不变。此函数按句组
 * 把 pattern 重新着色为指定色板（几何/家族/mood 全不变，只换颜色）。
 * @param {Object} pattern buildMosaicPatterns 产物（blocks 带 toneIdx）
 * @param {number} colorSetIdx 色板索引（调用方按 sectionId*3+groupId 轮换）
 * @param {Function} normBlock TunnelEngine._normMosaicBlock
 * @returns {Object} 换色后的新 pattern（原对象不变）
 */
export function applyPalette(pattern, colorSetIdx, normBlock) {
  const colors = MOSAIC_COLOR_SETS[((colorSetIdx % MOSAIC_COLOR_SETS.length) + MOSAIC_COLOR_SETS.length) % MOSAIC_COLOR_SETS.length];
  const tones = tonesOf(colors);
  const ink = shadeHex(colors[0], 0.22);
  const blocks = pattern.blocks.map((b) => {
    const nb = normBlock({
      ...b,
      color: (b.toneIdx == null || b.toneIdx < 0) ? ink : (tones[b.toneIdx - 1] || tones[1]),
      gridColor: b.isGrid ? (colors[0] + 'B8') : b.gridColor,
    });
    return nb;
  });
  return {
    ...pattern,
    blocks,
    paletteIdx: ((colorSetIdx % MOSAIC_COLOR_SETS.length) + MOSAIC_COLOR_SETS.length) % MOSAIC_COLOR_SETS.length,
    gridColor: colors[0],
    accentColor: colors[3],
    background: tones[2],
    bgGradient: `linear-gradient(150deg, ${tones[1]} 0%, ${tones[2]} 55%, ${tones[3]} 100%)`,
  };
}
