/* ============================================================
 * prismTypes.js — 「棱镜 · Prism」多镜头光学切面视觉引擎类型与常量表
 *
 * 6 大分镜构图家族 × 6 款 = 36 种镜头构图（PRISM_SHOT_KINDS）
 * 8 种歌词排版流向（PRISM_LAYOUT_KINDS）
 * 6 种逐字光学入场（PRISM_ENTER_STYLES）
 * 6 种镜头切换转场（PRISM_TRANSITION_KINDS）
 * ============================================================ */

/** 36 种分镜构图：按 6 大光学几何家族组织 */
export const PRISM_SHOT_FAMILIES = {
    split: [
        'birefringent-slash',   // 双折射斜切面：对角主切缝将画面一分为二，字跨中缝错位反色
        'fault-chevron',        // 折角V形棱镜：中央折角切面，光线向两侧偏折
        'twin-wedge',           // 双楔形对冲：左右两枚锐角玻璃楔穿插咬合
        'stepped-shear',        // 阶梯断层切面：三段平行错位棱柱，形成级联折射带
        'crossed-blades',       // 十字交叉刀锋：两条锐利晶面斜交出四个象限色域
        'offset-fault',         // 偏心断层带：黄金分割处的宽幅斜向折射槽
    ],
    aperture: [
        'diamond-aperture',     // 菱形晶窗：中央旋转菱形高反差折射窗，切穿主歌词
        'hex-iris',             // 六棱光阑：蜂巢六边形光学孔径与外环副晶面
        'revolving-monocle',    // 偏轴单晶镜：偏心多边形透镜框 + 切线导引光束
        'octagonal-well',       // 八角深井：双层同心八角切面，内圈高倍色散
        'eclipse-ring',         // 日冕环切：错位双多边形环，环带内反色折射
        'double-loupe',         // 双焦点取景：主副两枚斜置晶窗呼应主词与尾词
    ],
    shard: [
        'crystal-cluster',      // 晶簇生长：3~5 枚不规则多面体碎片围绕版心交叠
        'shattered-crown',      // 碎冕放射：从焦点向外辐射的楔形玻璃碎片群
        'radial-burst',         // 极轴散射：高潮段落专用的多角星芒切面场
        'ice-fracture',         // 冰裂纹场：非对称几何冰裂块面与细密光缝
        'floating-polyhedra',   // 悬浮多面体：错落漂浮的切角棱柱与散景光斑
        'prism-confetti',       // 光谱切屑：大小交错的平行四边形色散片阵列
    ],
    corridor: [
        'prism-corridor',       // 折光回廊：透视收束的左右立柱晶面，引导镜头纵深推进
        'staircase-refraction', // 旋梯折光：由左上向右下递进的阶梯状透明切层
        'kaleidoscope-hall',    // 万花筒镜像廊：四向对称斜切面围合出中央舞台
        'periscope-shaft',      // 潜望镜井道：上下双斜面反射板夹持宽幅文字带
        'infinite-facets',      // 多重叠镜：层层内缩的斜置画框切面
        'tilted-gallery',       // 倾角画廊：14°倾斜的连续平行玻璃幕墙
    ],
    monolith: [
        'obsidian-pillar',      // 黑曜石巨碑：竖向擎天暗色晶柱，文字横跨碑身内外反色
        'suspended-obelisk',    // 悬浮方碑：中央偏左/右的斜切尖顶方碑与横贯光带
        'cantilever-glass',     // 悬挑玻璃翼：从画幅边缘强力伸出的大面积三角翼面
        'triptych-panes',       // 三联屏切面：左中右三扇不同折射率与色偏的竖向晶屏
        'horizon-prism',        // 地平线三棱镜：横贯全屏的宽幅三棱柱切面
        'diagonal-beam',        // 斜贯主梁：45°巨型光梁切穿画幅对角线
    ],
    cinema: [
        'anamorphic-band',      // 变形宽银幕光带：上下暗角切面 + 中央高色散宽幅带
        'letterbox-prism',      // 电影遮幅斜窗：带光学刻度与斜切开口的宽画幅构图
        'corner-triad',         // 三角隅切：三个角落切入大型多面体，留出非对称张力版心
        'sparse-zenith',        // 极简天顶：间奏/呼吸段专用的大留白 + 单道锐利折光刃
        'poster-refract',       // 海报级对角构图：超大背景折射水印字 + 前景精排歌词
        'spectral-frame',       // 光谱画框：内嵌色散边线的偏移双层几何画框
    ],
};

/** 扁平化的 36 种分镜构图列表 */
export const PRISM_SHOT_KINDS = Object.values(PRISM_SHOT_FAMILIES).flat();

/** 8 种歌词排版几何流向 */
export const PRISM_LAYOUT_KINDS = [
    'horizontal-cascade',     // 错落阶梯横排：每词/行带微倾与水平阶梯缩进
    'diagonal-climb',         // 斜向攀升：沿棱镜切线方向斜置排布
    'stepped-columns',        // 高低错位分栏：短词组按左中右高度差拼贴
    'vertical-triptych',      // 竖排/半竖排杂志风：主词醒目放大，其余错落环绕
    'split-antiphony',        // 跨缝对唱：前半句与后半句分置主切缝两侧呼应
    'arc-orbit',              // 弧线轨迹：沿晶体孔径边缘微弧排布
    'scattered-constellation',// 星群散点构图：每个词占据独立切面锚点，字号随重音起伏
    'monumental-poster',      // 巨物海报式：核心词超大居中/偏置，前后词紧凑贴合
];

/** 6 种逐字入场动效 */
export const PRISM_ENTER_STYLES = [
    'refract-snap',           // 折光归位：从切面法线方向高速滑入并伴随色散收敛
    'dispersion-converge',    // 三原色合焦：RGB三色分身从散开状态合拢定焦成实字
    'shard-rise',             // 晶刃上浮：带倾角与拉伸比变化的上浮定格
    'caustic-bloom',          // 焦散绽放：由高光模糊态瞬间凝结为锐利字形
    'shear-lock',             // 错切咬合：上下半字或斜向错切滑入锁死
    'spiral-focus',           // 旋焦落位：伴随微旋转与镜头缩放落入版心
];

/** 6 种分镜切换转场 */
export const PRISM_TRANSITION_KINDS = [
    'shatter-wipe',           // 晶面斜切扫掠：多道平行棱镜面斜向划过切换场景
    'iris-refract',           // 菱形光阑开合：中央菱形折光孔径急速扩张/收拢
    'shear-slide',            // 断层错动：旧镜头沿切缝向两侧滑开，露出新镜头
    'spectral-flash',         // 光谱棱光闪白：短暂色散高光脉冲过渡
    'prism-rotate',           // 晶体翻折：伴随镜头倾角翻转与缩放衔接
    'cross-dissolve',         // 光学叠化：柔和散景过渡（呼吸段/慢歌段）
];

/** 默认参数（与 defaults.js / vfxRecipe.js 对齐） */
export const PRISM_DEFAULTS = {
    fontSize: 1.0,
    highlightColor: '#7ce8ff',
    themeColor: '#E8BE6A',
    fontFamily: 'default',
    showTranslation: true,
    showRomaji: true,
    prismPreset: 'auto',          // auto | diamond | amber | obsidian | aurora
    prismCutRate: 'phrase',       // phrase (多镜头分镜) | line (整句一镜) | fast (高频快切)
    prismRefraction: 0.75,        // 跨切面折射错位与反色强度 0~1
    prismDispersion: 0.68,        // 光谱色散（RGB棱边分离）强度 0~1
    prismCaustics: 0.72,          // 逐字焦散光束与高光脉冲强度 0~1
    prismCamera: 0.85,            // 镜头运镜（推拉/摇移/倾角）幅度 0~1.5
    prismHud: true,               // 显示光学刻度与棱镜角标装饰
};
