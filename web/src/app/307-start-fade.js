/* ============================================================
 * 307-start-fade.js — 起播淡入（需求 18）
 *
 * 点播放 / 切歌 / 从暂停恢复时，把音量在 100~300ms 内从 0 平滑升到设定值。
 * 开关是 `appSettings.playback.startFade`（默认开，设置页「播放」里可关）。
 *
 * ★ 为什么用「document 捕获阶段的 play 事件」而不是改播放按钮：
 *   三种触发点（点播放、切歌、从暂停恢复）**在 DOM 上是同一个事件**——
 *   都是某个 deck 开始播放。media 事件不冒泡，但捕获阶段会经过 document，
 *   所以一个 capture 监听就覆盖全部三条路径；改按钮只能覆盖第一条，
 *   而且按钮那条路径（65-playback-position 的 togglePlayPause）自己也不发信号。
 *
 * ★ 两道**必须**的互斥（需求原文："别影响淡入淡出和无缝衔接"）：
 *   ① 用户开了「切歌淡入淡出」（fadeInOut）：那条链（135-crossfade 的
 *      applyVolumeOnSongChange）已经在做淡出+淡入，起播淡入再叠一层就是
 *      "两套斜坡抢着写 audio.volume" → 听感是抖动。所以直接让位。
 *   ② Automix 正在交叉（body.automix-crossing）：此时两个 deck 各有自己的
 *      增益斜坡，同理让位。
 *
 * ★ 只认自家 deck 的 play 事件：页面里还有别的 <audio>（歌手页试听、
 *   听歌识曲的录音回放）。不做这个过滤就会"试听一首，主播放器音量被拉上去"。
 *   判定用 dualDeck 的活跃/影子元素，而不是"猜哪个元素在响"。
 * ============================================================ */
import { fadeInOnStart, isStartFadeOn } from '../core/fadeController.js';
import { getActiveAudio, getShadowAudio } from '../core/dualDeck.js';
import { volumePercentToGain } from '../utils/volumeCurve.js';
import { logCatch } from '../services/log.js';

const TAG = 'startFade';

function playbackCfg() {
    const s = (typeof globalThis !== 'undefined') ? globalThis.appSettings : null;
    return (s && s.playback) || {};
}

/** 目标音量（0~1）：与 135-crossfade 同口径 —— 「音量标准化」开着时用初始音量 */
function targetVolume() {
    const p = playbackCfg();
    const s = (typeof globalThis !== 'undefined') ? globalThis.appSettings : null;
    const norm = !!(s && s.audio && s.audio.volumeNorm);
    const pct = norm ? p.initialVolume : (typeof globalThis !== 'undefined' ? globalThis.volume : 100);
    const n = Number(pct);
    return volumePercentToGain(Number.isFinite(n) ? n : 100);
}

function isOwnDeck(el) {
    try {
        if (!el) return false;
        if (el === getActiveAudio() || el === getShadowAudio()) return true;
        /* dualDeck 尚未初始化时（启动极早期）退化判定：主音频元素带 src 且在页内 */
        return false;
    } catch { return false; }
}

function isAutomixCrossing() {
    try {
        return !!(typeof document !== 'undefined' && document.body
            && document.body.classList.contains('automix-crossing'));
    } catch { return false; }
}

/** 捕获阶段的 play：覆盖"点播放 / 切歌 / 从暂停恢复"三条路径 */
function onPlay(e) {
    try {
        if (!isStartFadeOn()) return;
        /* 让位给切歌淡入淡出（它自己会淡入） */
        if (playbackCfg().fadeInOut) return;
        if (isAutomixCrossing()) return;
        if (!isOwnDeck(e && e.target)) return;
        fadeInOnStart(targetVolume(), playbackCfg().fadeDuration);
    } catch (err) {
        logCatch(TAG, err);
    }
}

if (typeof document !== 'undefined') {
    document.addEventListener('play', onPlay, true);
}

export { onPlay as handleStartFade };
