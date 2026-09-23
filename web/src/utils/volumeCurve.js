/* ============================================================
 * volumeCurve.js — 音量对数（分贝）映射工具
 * 苹果/三星式「听觉均匀步进」音量曲线：
 *
 * 核心思路：把滑动条位置 p（0~100，线性手柄位）映射到分贝区间
 * [-60dB, 0dB] 上做【均匀步进】，再经指数逆运算还原为声压幅值
 * 设给 <audio>.volume。这样每拖动一档听到的响度变化基本一致，
 * 低音量区更细腻、高音量区不过分放大。
 *
 * 公式（与系统内 dB 表示互逆，亦满足"线性百分比 ↔ 分贝"）：
 *   · 手柄位置 p → dB：          db = 0.6 * p - 60        （-60~0dB 均匀）
 *   · dB → 声压幅值 gain：        gain = 10^(db/20)
 *   · 声压百分比 → dB（校验）：   db  = 20 * log10(percent/100)
 *   · dB → 声压百分比（回调）：   percent = 10^(db/20) * 100
 *
 * 注：1% 以下位置视为静音（避免指数给出手柄下沿非零残响），
 * p=0 严格为 0（静音），p=100 为满量程 0dB。
 * ============================================================ */

const DB_MIN = -60;   // 最低可分辨档位（静音上一档）
const DB_MAX = 0;     // 满量程

/** 手柄位置（0~100）→ 分贝值（-60~0），dB 均匀步进 */
export function volumePercentToDb(pct) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    return DB_MIN + (DB_MAX - DB_MIN) * (p / 100);
}

/** 分贝值 → 声压幅值（0~1），即 <audio>.volume 的物理值 */
export function dbToGain(db) {
    return Math.pow(10, db / 20);
}

/** 手柄位置（0~100）→ <audio>.volume（0~1） */
export function volumePercentToGain(pct) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    if (p <= 0) return 0;
    return dbToGain(volumePercentToDb(p));
}

/** 声压幅值（0~1）→ 手柄位置（0~100）（指数逆运算回调，用于 UI 同步） */
export function gainToVolumePercent(gain) {
    const g = Math.max(0, Math.min(1, Number(gain) || 0));
    if (g <= 0) return 0;
    const db = 20 * Math.log10(g);            // 用户公式①：percent/100 → dB
    const p = ((db - DB_MIN) / (DB_MAX - DB_MIN)) * 100;
    return Math.max(0, Math.min(100, Math.round(p)));
}

/** 声压幅值 → 分贝（供 tooltip/aria 展示，用户公式①一致性） */
export function gainToDb(gain) {
    const g = Math.max(0, Math.min(1, Number(gain) || 0));
    if (g <= 0) return DB_MIN;
    return 20 * Math.log10(g);
}

/** 手柄位置（0~100）→ 实际声压百分比（用户公式②：percentage = 10^(db/20)*100） */
export function volumePercentToPercent(pct) {
    return dbToGain(volumePercentToDb(pct)) * 100;
}