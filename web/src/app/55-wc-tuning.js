/* ============================================================
 * 55-wc-tuning.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 770-785 行 | 单元数: 2
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */

/* 上次写入的相机 transform 字符串（静止时跳过重复写入） */
/* ★ 将相机阻尼系数 wcLerpFactor 换算为缓动补间时长（秒）。
           等效指数平滑：每帧趋近比例 λ ≈ 时间常数 τ = 帧长 / -ln(1-λ)，
           默认 0.04 ≈ 0.41s（与旧版固定 0.42s 手感一致）；
           滑块范围 0.01~0.15 映射为约 1.66s ~ 0.10s，滑块真正可调。
           时长有界 → 补间必然在有限时间精确收敛停稳，不会像旧 Lerp 那样
           无限逐帧逼近导致持续重栅格化卡顿。 */
function wcLerpToDuration(lerp) {
            let f = parseFloat(lerp);
            if (!isFinite(f) || f <= 0) f = 0.04;
            f = Math.min(0.5, Math.max(0.005, f));
            return Math.min(2.5, Math.max(0.08, 0.0166667 / -Math.log(1 - f)));
        }

/* ★ 阻尼系数变化时调整进行中的补间时长：保持已完成的进度比例不变，
            仅改变剩余时间的流速，避免重启补间造成画面顿挫 */
function wcApplyLerpToTween(tween, durSec) {
            if (!tween || !isFinite(durSec) || tween.dur === durSec) return;
            const now = performance.now();
            const prog = Math.min(1, Math.max(0, (now - tween.t0) / (tween.dur * 1000)));
            tween.dur = durSec;
            tween.t0 = now - prog * durSec * 1000;
        }

export { wcApplyLerpToTween, wcLerpToDuration };
