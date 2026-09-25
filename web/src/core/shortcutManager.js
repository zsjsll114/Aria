/* ============================================================
 * core/shortcutManager.js — 设置项驱动的快捷键派发（core 层接管第 3 个模块，2026-09-25）
 *
 * 来历：本文件原先是「没接线的目标架构快照」，且与活实现有三处**实质性不一致**，直接接线会坏：
 *   · 快照调 `handlers.togglePlay()`，活实现是 `playBtn.click()` —— 只有走按钮才会带上
 *     按钮自身的全部副作用（禁用态、UI 同步、埋点）；
 *   · 快照音量按 0~1（`changeVolume(±0.05)`），活实现按 0~100 百分比
 *     （`updateVolume(volume ± 5)`）—— 单位不同，接上就是音量键失灵；
 *   · 快照注册了两个 keydown 监听，空格会被「设置项 playPause」和「硬编码空格」各触发一次
 *     = 双切换互相抵消；活实现只有一个监听，且 prev/next 带 ctrlKey 让位、另有
 *     Ctrl+←/→ 按 seekStep 逐段跳转。
 * 所以接管动作是从 app/110-keyboard-nav.js 的「非导航模式：原有快捷键逻辑」整段**重新抽取**，
 * 逻辑逐行照搬、行为不变。Tab/方向键的焦点导航仍留在该分片（那是另一个关注点）。
 *
 * 依赖注入：DOM 引用与 updateVolume 由调用方经 ctx 传入，core 不 import app/* 分片。
 * 设置项与音量读 infrastructure/state.js（globalBridge 已保证与裸标识符同源）。
 * ============================================================ */
import { state } from '../infrastructure/state.js';
import { showSeek, showVolume } from './osd.js';

/**
 * 处理非导航模式下的用户快捷键。
 * @param {KeyboardEvent} event
 * @param {{inInput: boolean, audio: HTMLAudioElement, playBtn: Element, prevBtn: Element,
 *          nextBtn: Element, favoriteBtn: Element, moreBtn: Element,
 *          updateVolume: (percent: number) => void}} ctx
 * @returns {boolean} true = 本次按键已被消费（调用方应直接 return，不再走后续逻辑）
 */
export function handleShortcutKeys(event, ctx) {
    const key = event.key;
    const { inInput, playBtn, prevBtn, nextBtn, favoriteBtn, moreBtn, updateVolume } = ctx;
    const settings = state.appSettings || {};
    const sc = settings.shortcuts || {};

    /* Ctrl+← / Ctrl+→ = 按 seekStep 前进/后退（无论是否真的改动都算已消费） */
    if (event.ctrlKey && !event.shiftKey && !event.altKey) {
        if (key === 'ArrowLeft' && !inInput) {
            event.preventDefault();
            seekBy(ctx, settings, -1);
            return true;
        }
        if (key === 'ArrowRight' && !inInput) {
            event.preventDefault();
            seekBy(ctx, settings, +1);
            return true;
        }
    }

    if (key === sc.playPause) {
        if (inInput) return true;
        event.preventDefault();
        playBtn.click();
    } else if (key === sc.prev) {
        if (inInput || event.ctrlKey) return true;
        event.preventDefault();
        prevBtn.click();
    } else if (key === sc.next) {
        if (inInput || event.ctrlKey) return true;
        event.preventDefault();
        nextBtn.click();
    } else if (key === sc.volumeUp) {
        if (inInput) return true;
        event.preventDefault();
        const volUp = Math.min(100, (state.volume || 0) + 5);
        updateVolume(volUp);
        showVolume(volUp);
    } else if (key === sc.volumeDown) {
        if (inInput) return true;
        event.preventDefault();
        const volDown = Math.max(0, (state.volume || 0) - 5);
        updateVolume(volDown);
        showVolume(volDown);
    } else if (key === sc.favorite) {
        if (inInput) return true;
        event.preventDefault();
        favoriteBtn.click();
    } else if (key === sc.toggleLyrics) {
        if (inInput) return true;
        event.preventDefault();
        const lc = typeof document !== 'undefined' ? document.querySelector('.lyrics-container') : null;
        if (lc) lc.style.display = (lc.style.display === 'none' ? '' : 'none');
    } else if (key === sc.more) {
        if (inInput) return true;
        event.preventDefault();
        moreBtn.click();
    } else {
        return false;
    }
    return true;
}

function seekBy(ctx, settings, direction) {
    const audio = ctx.audio;
    if (!audio || !audio.duration) return;
    const step = ((settings.playback && settings.playback.seekStep) || 5) * 1000;
    const before = audio.currentTime;
    audio.currentTime = direction < 0
        ? Math.max(0, audio.currentTime - step / 1000)
        : Math.min(audio.duration, audio.currentTime + step / 1000);
    /* OSD 报实际位移：已夹到 0/时长端点时不谎称跳了整步 */
    const moved = (audio.currentTime - before) * 1000;
    if (moved) showSeek(moved, audio.currentTime, audio.duration);
}
