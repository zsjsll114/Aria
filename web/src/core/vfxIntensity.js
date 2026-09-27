/**
 * core/vfxIntensity.js — 「动效强度」0~100 与 vfx 矩阵之间的纯映射（todos #6）
 *
 * 要解决的问题：设置页只有「高/中/低/极简」四个按钮，低配设备用户既不知道该选哪个，
 * 也不知道选了会**损失什么**。一根滑杆 + 实时说明比四档好懂，而且能自己找到跑得动的点。
 *
 * 两个不显然的决定：
 *  1. **不新建参数体系**，四档就是插值端点（`PERFORMANCE_PROFILES.*.vfx`）。所以滑杆
 *     产出的是同一组 10 个 vfx 键，引擎侧一行都不用改——新增第 11 个旋钮才会分裂出
 *     第二套事实源。
 *  2. **滑杆值不写进 perf_vfx_overrides_v1**，而是各自存、读取时叠加
 *     （见 180-boot-config 的 getVfxOverrides：滑杆在下、手动微调在上）。
 *     反过来写的话，用户拖一次滑杆就把他手调过的 4 个特效开关无声覆盖了——那是数据丢失，
 *     不是「重置」。代价是「滑杆拉满但某个开关仍关着」这种显示需要解释，已写进行说明。
 *
 * 数值全是端点间的线性插值，端点即档位，所以 0/33/67/100 读回来的就是档位原值；
 * 中间点是「两端之间」，不会出现任何档位都没定义过的怪值。纯函数，不碰 DOM/localStorage。
 */
import { PERFORMANCE_PROFILES } from '../config/performance.js';

/** 成本从低到高的档位键——顺序即插值轴，别打乱 */
export const VFX_INTENSITY_ANCHORS = ['minimal', 'low', 'medium', 'high'];

export const VFX_INTENSITY_MIN = 0;
export const VFX_INTENSITY_MAX = 100;

/** 数值键与取整规则：渲染缩放对齐到 per-key 滑条的 0.05 网格，模糊量取整像素 */
const NUMERIC_KEYS = ['renderScale', 'coverBlur', 'glassBlur', 'lyricBlur', 'textBlur'];
const BOOL_KEYS = ['pvBloom', 'flyinGlow', 'wcParticles', 'tunnelParticles', 'dimParticles'];
const RENDER_SCALE_STEP = 0.05;
/** 0.05 网格的整数刻度（1/step），插值后用 `×RENDER_SCALE_GRID ÷RENDER_SCALE_GRID` 吸附 */
const RENDER_SCALE_GRID = Math.round(1 / RENDER_SCALE_STEP);

export function clampIntensity(value) {
    /* ★ 必须先挡 nullish / 空串再 Number：`Number(null) === 0`、`Number('') === 0`，
       直接转换会把「未设定」读成 0 = 极简档，等于每次启动都把用户拖到最低特效
       （本仓库同类坑已踩过一次：lineRangeMs 的 null 索引）。 */
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;   // NaN / 脏值 = 「跟随性能等级」，不是 0
    return Math.min(VFX_INTENSITY_MAX, Math.max(VFX_INTENSITY_MIN, n));
}

/** 落在哪两个端点之间：{lo, hi, t}，t 是 lo→hi 的插值比例 */
export function intensitySegment(value) {
    const n = clampIntensity(value) ?? 0;
    const pos = (n / VFX_INTENSITY_MAX) * (VFX_INTENSITY_ANCHORS.length - 1);
    const lo = Math.min(VFX_INTENSITY_ANCHORS.length - 2, Math.floor(pos));
    return { lo, hi: lo + 1, t: pos - lo };
}

function vfxOf(anchor) {
    return PERFORMANCE_PROFILES[anchor].vfx || {};
}

/** 0~100 → 生效的 vfx 矩阵（10 个键，与档位 vfx 同形） */
export function vfxFromIntensity(value) {
    const n = clampIntensity(value);
    if (n === null) return {};                 // 未设定 → 不覆盖任何键
    const { lo, hi, t } = intensitySegment(n);
    const a = vfxOf(VFX_INTENSITY_ANCHORS[lo]);
    const b = vfxOf(VFX_INTENSITY_ANCHORS[hi]);
    const out = {};
    for (const key of NUMERIC_KEYS) {
        const raw = (a[key] ?? 0) * (1 - t) + (b[key] ?? 0) * t;
        out[key] = key === 'renderScale'
            /* 用 ×20/÷20 而不是 ×0.05 再乘回来：后者会让 0.6 变成 0.6000000000000001，
               端点「还原档位原值」那条断言就红了（滑杆显示也跟着多出一串小数）。 */
            ? Math.round(raw * RENDER_SCALE_GRID) / RENDER_SCALE_GRID
            : Math.round(raw);
    }
    for (const key of BOOL_KEYS) {
        /* 权重过半才算「开」：只有 high 档为真的键（pvBloom）要到 83 以上才点亮，
           不会出现「拉了一半就给了满档特效」。 */
        const on = ((a[key] ? 1 : 0) * (1 - t)) + ((b[key] ? 1 : 0) * t);
        out[key] = on >= 0.5;
    }
    return out;
}

/** 档位 → 滑杆初始位置（滑杆未设定时用它显示「现在跟着哪一档」） */
export function intensityForProfile(profileName) {
    const i = VFX_INTENSITY_ANCHORS.indexOf(profileName);
    if (i < 0) return null;
    return Math.round((i / (VFX_INTENSITY_ANCHORS.length - 1)) * VFX_INTENSITY_MAX);
}

/** 最近的端点名：说明行用它告诉用户「这一点约等于哪一档」 */
export function nearestAnchor(value) {
    const { lo, hi, t } = intensitySegment(value);
    return VFX_INTENSITY_ANCHORS[t < 0.5 ? lo : hi];
}

/**
 * 说明文案的分档键（返回**键**而不是中文：文案要走 i18n 登记处，见约束 7）。
 * 分界刻意与端点重合，所以「拉满 = full」「拉到 0 = bare」不会和上面的数字打架。
 */
export function intensityBand(value) {
    const n = clampIntensity(value);
    if (n === null) return 'follow';
    if (n <= 0) return 'bare';
    if (n < 40) return 'light';
    if (n < 75) return 'balanced';
    if (n < 100) return 'rich';
    return 'full';
}

/** 说明行里各键的中文名——全是已登记词表里的短语，走 tx() 出英文 */
const LABELS = {
    coverBlur: '背景模糊',
    glassBlur: '毛玻璃强度',
    lyricBlur: '歌词模糊',
    renderScale: '渲染分辨率',
    pvBloom: 'PV 发光',
    flyinGlow: '飞入光晕',
    wcParticles: '词云跟焦',
    tunnelParticles: '隧道粒子',
    dimParticles: '浮空粒子',
};

/**
 * 滑杆下方那句「这一档到底给了我什么」——四档最难懂的地方就在于用户看不出损失了什么，
 * 所以这里把插值结果**逐项报出来**，而不是只报一个百分比。
 *
 * 纯函数 + 注入 `tx`（默认原样返回），这样文案的分档与数字都能在 node 里断言，
 * 不必起浏览器；真正的中英转换由调用方走 `core/i18n.js` 的 translatePhrase。
 *
 * @param {number|string|null} value 滑杆值，null = 跟随档位
 * @param {string} profileName 当前性能档位键（跟随态要用它算出等效值）
 * @param {(zh:string)=>string} [tx]
 */
export function describeVfxIntensity(value, profileName, tx = (s) => s) {
    const n = clampIntensity(value);
    const followTier = PERFORMANCE_PROFILES[profileName] ? profileName : 'medium';
    const shown = n === null ? intensityForProfile(followTier) : n;
    const vfx = vfxFromIntensity(shown);
    const parts = [
        `${tx(LABELS.coverBlur)} ${vfx.coverBlur}px`,
        `${tx(LABELS.glassBlur)} ${vfx.glassBlur}px`,
        `${tx(LABELS.lyricBlur)} ${vfx.lyricBlur}px`,
        `${tx(LABELS.renderScale)} ${Math.round(vfx.renderScale * 100)}%`,
    ];
    for (const key of BOOL_KEYS) {
        parts.push(`${tx(LABELS[key])} ${vfx[key] ? tx('开') : tx('关')}`);
    }
    const head = n === null
        ? `${tx('当前跟随档位')}「${tx(PERFORMANCE_PROFILES[followTier].name)}」${tx('等效')} ${shown}`
        : `${tx('动效强度')} ${n}${n <= 0 ? '（' + tx('只保留逐字高亮，不做背景模糊与粒子') + '）' : ''}`;
    return `${head} —— ${parts.join(' · ')}`;
}
