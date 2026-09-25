/* ============================================================
 * 287-bg-throttle.js — 窗口不可见时自动轻量的接线层（todos #18）
 *
 * 判定与协调全在 core/backgroundThrottle.js，本分片只负责「把每个绘制循环
 * 翻译成一组 get/isBusy/pause/resume」，全部用这些引擎**现成**的接口，
 * 一行业务逻辑都不写进引擎文件（共享 rAF 闸属下一轮侵入式重构，本轮不撞车）。
 *
 * 实测过的外部可停性（详见交付报告）：
 *   ✓ 主歌词 rAF（70-audio-engine 导出 startLyricsLoop/stopLyricsLoop）
 *   ✓ PVEngine 摄像机 rAF（实例自带 start/stop + isRunning）
 *   ✓ VisualizerManager.activeInstance（VisualizerBase 统一 start/stop + isRunning）
 *   ✓ previewEngine（自带 pause/start + isPlaying，且它内部是**另一套**引擎实例）
 *   △ PVBackground 丝绸 canvas：**没有**公开停口，只能掐它自己持有的 animId/
 *     _silkTimer 再用私有 _startSilkLoop 重开 —— 已按「缺任一即不动」写，
 *     将来它加了公开 API 只需替换这两个函数。
 *   ✗ 57-wordcloud-camera 的常驻弹簧 rAF（开关是模块内 let，外面读不到）
 *   ✗ 60-mobile-dual-page 的逐字进度 rAF（busy 标志 _mlpRafId 未导出）
 *   ✗ TunnelEngine（自持循环早先已被删空，本来就不耗帧，不注册）
 * 前两项要等分片补导出，已进交付报告的接线清单。
 * ============================================================ */
import { audio } from './20-lyrics-render.js';
import { startLyricsLoop, stopLyricsLoop } from './70-audio-engine.js';
import { logCatch, logInfo } from '../services/log.js';
import {
    TIER_HIDDEN,
    TIER_IDLE,
    backgroundThrottleSnapshot,
    installBackgroundThrottle,
    onBackgroundThrottleChange,
    registerThrottleTarget,
} from '../core/backgroundThrottle.js';

function g(key) {
    return (typeof globalThis !== 'undefined' && globalThis[key]) || null;
}

/* 桌面歌词窗口靠主窗口的 activeLineIndex/currentTime 供给内容（250 每 120ms 推一次），
   而这两个值由主歌词 rAF 推进 —— 桌面歌词开着时停主循环等于把另一个**可见**窗口冻住，
   所以那种情况下主歌词循环不降档（其余装饰循环照停）。 */
function desktopLyricsOn() {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem('aria_dtk_enabled') === '1';
    } catch (e) {
        /* 隐私模式/配额下读不到就当作没开：宁可少降一档，不可冻住桌面歌词 */
        logCatch('bgThrottle', e);
        return false;
    }
}

/* ---- 1. 主歌词 rAF：逐字高亮 + 进度 + 各引擎 update 的总闸 ---- */
registerThrottleTarget({
    id: 'lyricsLoop',
    tier: TIER_HIDDEN,
    get: () => null,
    isBusy: () => (typeof globalThis !== 'undefined' && globalThis.isLyricsLoopRunning) === true,
    pause: () => stopLyricsLoop(),
    resume: () => { if (audio && !audio.paused) startLyricsLoop(); },
    skipWhen: () => desktopLyricsOn(),
});

/* ---- 2. PV 摄像机视差 rAF ---- */
registerThrottleTarget({
    id: 'pvCamera',
    tier: TIER_HIDDEN,
    get: () => g('pvEngineInstance'),
    isBusy: inst => !!inst && inst.isRunning === true,
    pause: inst => inst.stop(),
    /* PVEngine.stop() 把翻译层写成 opacity:0 + display:none，而 start() 只恢复 display：
       从外面补一次显隐，否则回前台后要等到下一句带翻译的歌词才重新看得见。 */
    resume: (inst) => {
        inst.start();
        const ta = inst.translationArea;
        if (ta && ta.style && ta.textContent && ta.textContent.trim()) ta.style.opacity = '1';
    },
});

/* ---- 3. PV 丝绸背景 canvas（全屏 2D 重绘，整台机器最贵的一帧预算）---- */
function pauseSilk(bg) {
    /* 没有 _startSilkLoop 就没有对称的恢复手段：这种情况一律不动它
       （core 复查 isBusy 仍为真，会自动放弃记账，不会把「暂停」变成「关掉」） */
    if (!bg || typeof bg._startSilkLoop !== 'function') return;
    if (bg.animId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(bg.animId);
    if (bg._silkTimer && typeof clearTimeout === 'function') clearTimeout(bg._silkTimer);
    bg.animId = null;
    bg._silkTimer = null;
}

registerThrottleTarget({
    id: 'pvSilkBackground',
    tier: TIER_IDLE,
    get: () => {
        const pv = g('pvEngineInstance');
        return (pv && pv.background) || null;
    },
    isBusy: bg => !!(bg && (bg.animId || bg._silkTimer)),
    pause: pauseSilk,
    resume: bg => { if (bg && typeof bg._startSilkLoop === 'function') bg._startSilkLoop(); },
});

/* ---- 4. 当前视觉模式的自持循环（浮空 Dimension 有，活字/霓虹没有）---- */
registerThrottleTarget({
    id: 'activeVisualizer',
    tier: TIER_HIDDEN,
    get: () => {
        const mgr = g('mainVisManager');
        return (mgr && mgr.activeInstance) || null;
    },
    isBusy: inst => !!inst && inst.isRunning === true,
    pause: inst => inst.stop(),
    resume: inst => inst.start(),
});

/* ---- 5. 外观设置里的预览引擎（独立实例，与主画面互不影响）---- */
registerThrottleTarget({
    id: 'appearancePreview',
    tier: TIER_HIDDEN,
    get: () => g('previewEngineInstance'),
    isBusy: inst => !!inst && inst.isPlaying === true,
    pause: inst => inst.pause(),
    resume: inst => inst.start(),
});

installBackgroundThrottle({
    env: {
        window: typeof window !== 'undefined' ? window : null,
        document: typeof document !== 'undefined' ? document : null,
    },
    silent: true,
});

/* 封面背景的摇摆是 CSS 动画（190-settings-fontsize 用内联 animation 简写挂在
   .blur-background 上），rAF 停不停它照跑不误 —— 而这一层是 150% 面积 + blur(60px)
   的全屏合成，正是无 GPU 设备上最贵的一笔。暂停手法与既有的
   `.blur-background.paused { animation-play-state: paused }`（暂停时不摇摆）完全一致，
   只多两处必要项：① 锚到 html#ariaRoot（硬约束 12：纯类选择器比特异性会被组件侧
   !important 顶掉）；② 必须带 !important —— animation 简写会把 animation-play-state
   一并重置为 running，普通作者规则压不过内联样式。 */
function injectThrottleStyle() {
    if (typeof document === 'undefined' || document.getElementById('bg-throttle-style')) return;
    const css = [
        'html#ariaRoot.is-bg-throttled .blur-background {',
        '    animation-play-state: paused !important;',
        '}',
    ].join('\n');
    const node = document.createElement('style');
    node.id = 'bg-throttle-style';
    node.textContent = css;
    (document.head || document.documentElement).appendChild(node);
}

try { injectThrottleStyle(); } catch (e) { logCatch('bgThrottle', e); }

/* 留痕：这类「画面为什么不动了」的疑问只能靠一条日志回答，不然第一个反馈会是「播放器坏了」 */
onBackgroundThrottleChange(() => {
    try {
        const s = backgroundThrottleSnapshot();
        logInfo('bgThrottle', `档位 ${s.tier || 'normal'} · 已停 ${s.paused.length ? s.paused.join('/') : '无'}`);
    } catch (e) { logCatch('bgThrottle', e); }
});
