/* ============================================================
 * 287-bg-throttle.js — 后台/失焦自动省电降载接线层
 *
 * 游戏等全屏/无边框窗口遮挡 Aria 时（!document.hasFocus()），浏览器不会自动
 * 触发 document.hidden，所以所有重 GPU/CPU 渲染目标统一挂进 TIER_IDLE，
 * 失去焦点 500ms 或最小化后全部立即休眠，仅保留音频播放与轻量 10Hz 桌面歌词同步。
 * ============================================================ */
import { audio } from './20-lyrics-render.js';
import { startLyricsLoop, stopLyricsLoop, syncForegroundLyricsNow } from './70-audio-engine.js';
import { isLyricsFxLoopRunning, snapLyricsWaveOnResume, startLyricsFxLoop, stopLyricsFxLoop } from './57-wordcloud-camera.js';
import { isMobileLyricProgressRunning, startMobileLyricProgress, stopMobileLyricProgress } from './60-mobile-dual-page.js';
import { isMvUpscaleRunning, startMvUpscale, stopMvUpscale } from './103-mv-upscale.js';
import { isEnergyMotionRunning, pauseEnergyMotion, resumeEnergyMotion } from './306-energy-motion.js';
import { probeInfo, startHeartbeat, stopHeartbeat } from '../core/frameProbe.js';
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

function desktopLyricsOn() {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem('aria_dtk_enabled') === '1';
    } catch (e) {
        logCatch('bgThrottle', e);
        return false;
    }
}

/* ---- 1. 主歌词循环（仅真正最小化/后台不可见 TIER_HIDDEN 暂停；失焦但窗口可见不冻结歌词） ---- */
registerThrottleTarget({
    id: 'lyricsLoop',
    tier: TIER_HIDDEN,
    get: () => null,
    isBusy: () => (typeof globalThis !== 'undefined' && globalThis.isLyricsLoopRunning) === true,
    pause: () => stopLyricsLoop(),
    resume: () => { if (audio && !audio.paused) startLyricsLoop(); },
    skipWhen: () => desktopLyricsOn(),
});

/* ---- 2. 诗镜（Sonnet Pixi WebGL + rAF） ---- */
registerThrottleTarget({
    id: 'sonnetEngine',
    tier: TIER_HIDDEN,
    get: () => g('__sonnetCtrl'),
    isBusy: ctrl => !!(ctrl && ctrl.isRunning()),
    pause: ctrl => ctrl.pause(),
    resume: ctrl => ctrl.resume(),
});

/* ---- 3. 凝彩（Tempera Pixi WebGL + rAF） ---- */
registerThrottleTarget({
    id: 'temperaRuntime',
    tier: TIER_HIDDEN,
    get: () => g('__temperaCtrl'),
    isBusy: ctrl => !!(ctrl && ctrl.isRunning()),
    pause: ctrl => ctrl.pause(),
    resume: ctrl => ctrl.resume(),
});

/* ---- 4. VisualizerManager 当前实例（琉璃龛 WebGL2 / 棱镜 / 画册 / 穿行 / 镜幕 / 活字 / 字面） ---- */
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

/* ---- 5. 外观设置预览引擎 ---- */
registerThrottleTarget({
    id: 'appearancePreview',
    tier: TIER_IDLE,
    get: () => g('previewEngineInstance'),
    isBusy: inst => !!inst && inst.isPlaying === true,
    pause: inst => inst.pause(),
    resume: inst => inst.start(),
});

/* ---- 6. 音频能量动态呼吸（每帧 FFT + CSS 变量变更） ---- */
registerThrottleTarget({
    id: 'energyMotion',
    tier: TIER_IDLE,
    get: () => null,
    isBusy: () => isEnergyMotionRunning(),
    pause: () => pauseEnergyMotion(),
    resume: () => resumeEnergyMotion(),
});

/* ---- 7. MV 画质增强 WebGL2 多 pass 着色器 ---- */
registerThrottleTarget({
    id: 'mvUpscale',
    tier: TIER_HIDDEN,
    get: () => null,
    isBusy: () => isMvUpscaleRunning(),
    pause: () => stopMvUpscale(),
    resume: () => {
        if (typeof document !== 'undefined' && document.body && document.body.classList.contains('mv-bg-on')) {
            startMvUpscale();
        }
    },
});

/* ---- 8. MV 背景视频解码（后台隐藏暂停硬解，回前台按音频进度对齐续播） ---- */
registerThrottleTarget({
    id: 'mvBgVideo',
    tier: TIER_HIDDEN,
    get: () => (typeof document !== 'undefined' ? document.getElementById('mvBgVideo') : null),
    isBusy: v => !!(v && v.src && !v.paused),
    pause: v => { try { v.pause(); } catch (e) { logCatch('bgThrottle', e); } },
    resume: v => {
        if (!v || !v.src) return;
        if (typeof document !== 'undefined' && document.body && !document.body.classList.contains('mv-bg-on')) return;
        if (audio && audio.paused) return;
        try {
            if (audio && Number.isFinite(audio.currentTime) && Math.abs((v.currentTime || 0) - audio.currentTime) > 0.6) {
                v.currentTime = audio.currentTime;
            }
            const p = v.play();
            if (p && typeof p.catch === 'function') p.catch(e => logCatch('bgThrottle', e));
        } catch (e) { logCatch('bgThrottle', e); }
    },
});

/* ---- 9. 默认/歌词模式弹簧与纵波常驻 rAF ---- */
registerThrottleTarget({
    id: 'lyricsFxLoop',
    tier: TIER_HIDDEN,
    get: () => null,
    isBusy: () => isLyricsFxLoopRunning(),
    pause: () => stopLyricsFxLoop(),
    resume: () => startLyricsFxLoop(),
});

/* ---- 10. 窄屏双页逐字进度 rAF ---- */
registerThrottleTarget({
    id: 'mobileLyricProgress',
    tier: TIER_HIDDEN,
    get: () => null,
    isBusy: () => isMobileLyricProgressRunning(),
    pause: () => stopMobileLyricProgress(),
    resume: () => startMobileLyricProgress(),
});

/* ---- 11. 全局帧时采样心跳 rAF ---- */
registerThrottleTarget({
    id: 'frameProbeHeartbeat',
    tier: TIER_IDLE,
    get: () => null,
    isBusy: () => !!probeInfo().heartbeatOn,
    pause: () => stopHeartbeat(),
    resume: () => startHeartbeat(),
});

installBackgroundThrottle({
    env: {
        window: typeof window !== 'undefined' ? window : null,
        document: typeof document !== 'undefined' ? document : null,
    },
    silent: true,
});

/* 后台/失焦时冻结所有无限 CSS 动画并撤掉高开销合成器层提升（will-change） */
function injectThrottleStyle() {
    if (typeof document === 'undefined' || document.getElementById('bg-throttle-style')) return;
    const css = [
        'html#ariaRoot.is-bg-throttled .blur-background,',
        'html#ariaRoot.is-bg-throttled .pv-fluid-img,',
        'html#ariaRoot.is-bg-throttled .pv-fluid-blob,',
        'html#ariaRoot.is-bg-throttled .tunnel-bg-streaks,',
        'html#ariaRoot.is-bg-throttled .visualizer-stage *,',
        'html#ariaRoot.is-bg-throttled .vinyl-disc,',
        'html#ariaRoot.is-bg-throttled .vinyl-tonearm,',
        'html#ariaRoot.is-bg-throttled .fc-beam,',
        'html#ariaRoot.is-bg-throttled .fc-shutter {',
        '    animation-play-state: paused !important;',
        '    will-change: auto !important;',
        '}',
    ].join('\n');
    const node = document.createElement('style');
    node.id = 'bg-throttle-style';
    node.textContent = css;
    (document.head || document.documentElement).appendChild(node);
}

try { injectThrottleStyle(); } catch (e) { logCatch('bgThrottle', e); }

onBackgroundThrottleChange((snap) => {
    try {
        const s = backgroundThrottleSnapshot();
        logInfo('bgThrottle', `档位 ${s.tier || 'normal'} · 已停 ${s.paused.length ? s.paused.join('/') : '无'}`);
        /* ★ 2026-11-19：回到前台时彻底校准歌词行、纵波位置与视觉引擎尺寸/时钟，
           修复切后台再切回来时歌词停滞、纵波飞跃、视觉模式尺寸错乱等异常。 */
        if (snap && !snap.tier) {
            try { snapLyricsWaveOnResume(); } catch (e) { logCatch('bgThrottle', e); }
            try { syncForegroundLyricsNow(); } catch (e) { logCatch('bgThrottle', e); }
        }
    } catch (e) { logCatch('bgThrottle', e); }
});
