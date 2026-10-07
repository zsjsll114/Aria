/* ============================================================
 * core/automix/decision.js — 交叉决策纯函数（Automix Phase 2）
 *
 * 方案 §3.3.1 三层策略。核心认知：BPM 差距大 ≠ 不能交叉——节奏打架的
 * 真正条件是「重叠区两首歌同时有明显鼓点」，BPM 差距只是它的代理指标。
 *
 * 纯函数、零副作用、零 DOM 依赖，node 单测直接喂结构化对象。
 * 「单曲循环 / AB 循环 / 用户刚手动切歌」等**播放语义层**的前置否决不在这里
 * ——那是 scheduler 的职责（它拿得到队列状态），本模块只做信号层决策。
 * ============================================================ */

export const DECISION_DEFAULTS = {
    gapBeatmatch: 8,        /* |Δbpm| ≤ 8 → 可对拍 */
    gapBreath: 30,          /* 8 < gap ≤ 30 → 呼吸点交叉；> 30 → segue */
    minConfidence: 1.5,     /* bpmConfidence 低于此值视为「不收敛」（与 envelope 阈值同源） */
    maxRateDeviation: 0.05, /* 对拍变速窗口 ±5%（DJ 行业常规，preservesPitch 无感区） */
};

/**
 * 三层策略决策。
 * @param {{bpm:number|null, bpmConfidence:number, outroPointMs:number}|null} a 当前曲分析结果
 * @param {{bpm:number|null, bpmConfidence:number, introPointMs:number}|null} b 下一曲分析结果
 * @param {Partial<typeof DECISION_DEFAULTS>} [opts]
 * @returns {'beatmatch'|'breath'|'segue'|'none'}
 *   none = 不做 automix，走原生 ended（分析缺失/无有效出口点）
 *   segue = BPM 不收敛或差距过大 → **不做对拍变速**。重叠时长仍由 A 的结构出口
 *           （outroPointMs）决定，只是两端都不变速——BPM 打架的窗口因此落在
 *           A 的自然衰减段之后，靠等功率曲线掩盖节奏差异。
 */
export function decideCrossfade(a, b, opts = {}) {
    if (!a || !b) return 'none';
    /* A 没有有效出口点（outroPointMs=0 = 没找到能量衰减段）→ 无处可出。
       ★ 键名必须与 analyzer.js 的返回结构同源（*Ms 后缀）——E2E 曾抓到
       decision 读 outroPoint / analyzer 产 outroPointMs 的键名错位，
       单测注入的假结果掩盖了它，真链路上决策永远 'none'。 */
    if (!(a.outroPointMs > 0)) return 'none';
    const o = Object.assign({}, DECISION_DEFAULTS, opts);
    const confOk = (t) => t != null && t.bpm != null && t.bpmConfidence >= o.minConfidence;
    if (confOk(a) && confOk(b)) {
        const gap = Math.abs(a.bpm - b.bpm);
        if (gap <= o.gapBeatmatch) {
            /* gap 小仍要过变速窗：100 vs 108 BPM 的 rate=1.08 已超 ±5%，
               preservesPitch 变速会可闻 → 降呼吸点交叉（不对拍） */
            const rate = b.bpm / a.bpm;
            if (Math.abs(rate - 1) <= o.maxRateDeviation) return 'beatmatch';
            return 'breath';
        }
        if (gap <= o.gapBreath) return 'breath';
    }
    return 'segue';
}

/**
 * 对拍速率（beatmatch 决策通过时使用）：B 的 playbackRate。
 * 重叠时长按此缩放：T_real = T_overlap / rate。
 * @returns {number} >0；调用方保证仅在 'beatmatch' 时使用
 */
export function beatmatchRate(a, b) {
    if (!a || !b || !a.bpm || !b.bpm) return 1;
    return b.bpm / a.bpm;
}
