/* ============================================================
 * 300-hearing-guard.js — 听力健康提醒（需求 16）
 *
 * 连续播放超 2 小时、或音量长时间偏高（≥85% 累计 30 分钟）时，在界面底部弹一条
 * **温和**提示，建议休息或降音量。**绝不打断播放**，也不做任何自动降音量。
 *
 * 判定逻辑全在 `core/hearingGuard.js`（纯状态机 + 单测，时间源可注入）；
 * 本分片只做「取当前播放态与音量 → 喂给状态机 → 弹提示」。
 *
 * ★ 音量取 `globalThis.volume`（0~100 的用户音量），不是元素 volume —— 后者在
 *   淡入淡出期间会在 0 与目标值之间来回跑，用它判定会把淡入误判成"音量骤降"。
 * ★ 用 `getActiveAudio()` 而不是 HTML 元素常量：原生独占时活跃 deck 是 nativeDeck，
 *   元素常量的 paused 恒为 true，判定会永远"没在播"。
 * ★ 提示走 `Aria.showHint`（底部 toast，2 秒自动淡出）—— 与全库其余一次性反馈同源。
 * ============================================================ */
import { createHearingGuard, SAMPLE_MS } from '../core/hearingGuard.js';
import { getActiveAudio } from '../core/dualDeck.js';
import { translatePhrase } from '../core/i18n.js';
import { logCatch } from '../services/log.js';

const tx = translatePhrase;
const TAG = 'hearingGuard';

/** 唯一的状态机实例（导出供诊断/测试读取） */
export const hearingGuard = createHearingGuard();

/** 用户是否开启（缺省开；显式 false 才关） */
function isEnabled() {
    try {
        const s = (typeof globalThis !== 'undefined') ? globalThis.appSettings : null;
        const p = s && s.playback;
        return !p || p.hearingGuard !== false;
    } catch { return true; }
}

/** 一次采样（导出出来，方便探针手动触发而不必等 10 秒） */
export function hearingGuardTick() {
    try {
        if (!isEnabled()) return;
        const a = getActiveAudio();
        const playing = !!(a && a.paused === false);
        const vol = (typeof globalThis !== 'undefined' && typeof globalThis.volume === 'number')
            ? globalThis.volume : NaN;
        const warn = hearingGuard.sample(playing, vol);
        if (!warn) return;
        const text = warn.kind === 'continuous'
            ? tx('已经连续播放 2 小时了，建议歇一会儿，让耳朵透透气')
            : `${tx('音量偏高已持续 30 分钟')}（${warn.volume}%）`;
        if (typeof Aria !== 'undefined' && Aria.showHint) Aria.showHint(text);
    } catch (e) {
        logCatch(TAG, e);
    }
}

if (typeof window !== 'undefined' && typeof setInterval === 'function') {
    setInterval(hearingGuardTick, SAMPLE_MS);
}
