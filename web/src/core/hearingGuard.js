/* ============================================================
 * core/hearingGuard.js — 听力健康提醒（纯逻辑，不碰 DOM / 不自己开计时器）
 *
 * 需求：连续播放超 2 小时、或音量长时间偏高时，在界面角落弹一条**温和**提示，
 * 建议休息或降音量。**绝不强制打断播放** —— 只提示。
 *
 * 设计取舍：
 *   · 本模块是**纯状态机**：外部按周期调 `sample(playing, volumePct)`，返回
 *     `null` 或一条提示描述。时间源可注入（`now`），单测不用真等 2 小时。
 *   · 用**增量 dt 累加**而不是"记起点" —— 起点式写法在「暂停再恢复」时只能
 *     整段重算，做不到"短暂停保留累计、长暂停清零"这个需求。
 *   · 暂停 ≥ RESET_AFTER_PAUSE_MS 视为「休息过了」，连续计时清零；
 *     **短暂停（接杯水）不清零** —— 否则 2 小时的累计永远攒不满，提醒形同虚设。
 *   · 音量判定带**迟滞**：一旦低于阈值立刻清 `loudMs`，不累积零散的高音量时刻。
 *   · 提醒后累计归零 + 冷却窗 —— 否则阈值一到会每个采样周期弹一次。
 * ============================================================ */

/** 连续播放多久提醒（2 小时） */
export const CONTINUOUS_LIMIT_MS = 2 * 60 * 60 * 1000;
/** 连续播放提醒的文案参数（分钟） */
export const CONTINUOUS_LIMIT_MIN = Math.round(CONTINUOUS_LIMIT_MS / 60000);
/** 达到或超过这个音量（百分比）视为「偏高」 */
export const LOUD_VOLUME_PCT = 85;
/** 音量偏高累计多久提醒（30 分钟） */
export const LOUD_LIMIT_MS = 30 * 60 * 1000;
export const LOUD_LIMIT_MIN = Math.round(LOUD_LIMIT_MS / 60000);
/** 同一类提醒的冷却时间（30 分钟） */
export const COOLDOWN_MS = 30 * 60 * 1000;
/** 暂停达到这个时长才算「休息过」，连续计时清零（5 分钟） */
export const RESET_AFTER_PAUSE_MS = 5 * 60 * 1000;
/** 建议的采样周期（外部 setInterval 用；10 秒精度足够） */
export const SAMPLE_MS = 10 * 1000;

/**
 * 建一个听力提醒状态机。
 * @param {{now?: () => number}} [opts] now 可注入（测试用，默认 Date.now）
 */
export function createHearingGuard(opts = {}) {
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

    let playedMs = 0;        /* 本轮连续播放累计 */
    let loudMs = 0;          /* 音量偏高累计（不播放时清零） */
    let lastTickAt = 0;      /* 上次采样时刻，用于算增量 */
    let lastPausedAt = 0;    /* 最近一次由播转停的时刻 */
    let wasPlaying = false;
    const lastWarn = { continuous: 0, loud: 0 };

    return {
        /**
         * 采样一次（外部按 SAMPLE_MS 周期调用）。
         * @param {boolean} playing 音频是否正在播放
         * @param {number} volumePct 当前音量 0~100（非法值按"不偏高"处理）
         * @returns {null|{kind:'continuous'|'loud', minutes:number, volume?:number}}
         */
        sample(playing, volumePct) {
            const t = now();
            const dt = lastTickAt ? Math.max(0, t - lastTickAt) : 0;
            lastTickAt = t;

            if (!playing) {
                if (wasPlaying) lastPausedAt = t;
                wasPlaying = false;
                loudMs = 0;      /* 没在播就谈不上"长时间高音量" */
                return null;
            }

            /* 从暂停恢复 */
            if (lastPausedAt) {
                if ((t - lastPausedAt) >= RESET_AFTER_PAUSE_MS) {
                    playedMs = 0;             /* 休息够了，重新计时 */
                    lastWarn.continuous = 0;  /* 同时解除连续提醒的冷却（那也算休息） */
                }
                lastPausedAt = 0;
            }
            wasPlaying = true;
            playedMs += dt;

            /* ① 连续播放超限 */
            if (playedMs >= CONTINUOUS_LIMIT_MS && (t - lastWarn.continuous) >= COOLDOWN_MS) {
                lastWarn.continuous = t;
                playedMs = 0;
                return { kind: 'continuous', minutes: CONTINUOUS_LIMIT_MIN };
            }

            /* ② 音量长时间偏高 */
            const vol = Number(volumePct);
            if (Number.isFinite(vol) && vol >= LOUD_VOLUME_PCT) loudMs += dt;
            else loudMs = 0;

            if (Number.isFinite(vol) && vol >= LOUD_VOLUME_PCT
                && loudMs >= LOUD_LIMIT_MS && (t - lastWarn.loud) >= COOLDOWN_MS) {
                lastWarn.loud = t;
                loudMs = 0;
                return { kind: 'loud', volume: Math.round(vol), minutes: LOUD_LIMIT_MIN };
            }
            return null;
        },

        /** 复位全部状态（用户关闭提醒后又打开时用） */
        reset() {
            playedMs = 0;
            loudMs = 0;
            lastTickAt = 0;
            lastPausedAt = 0;
            wasPlaying = false;
            lastWarn.continuous = 0;
            lastWarn.loud = 0;
        },

        /** 诊断快照（诊断页 / 测试用） */
        snapshot() {
            return {
                playedMs: Math.round(playedMs),
                loudMs: Math.round(loudMs),
                lastPausedAt,
                wasPlaying,
                lastWarn: { ...lastWarn },
                limits: {
                    CONTINUOUS_LIMIT_MS, LOUD_VOLUME_PCT, LOUD_LIMIT_MS,
                    COOLDOWN_MS, RESET_AFTER_PAUSE_MS,
                },
            };
        },
    };
}
