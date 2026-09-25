/* ============================================================
 * 230-touch-gestures.js — 手机触控适配 P0（手写分片，不参与自动切割）
 * 构建脚本会：语法校验本文件 + 同步下方 import 的 ?v= 版本号
 *
 * 1) 双页左右滑动手势：仅窄屏(matchMedia ≤700px) + 默认封面模式；
 *    歌词滚动区/表单控件/底部栏内触摸不拦截，纵向滚动优先。
 *    左滑 → 歌词页；右滑 → 播放控件页（与双页空间顺序一致）。
 * 2) 滑杆触摸拖拽：主进度条 / 底部进度条 / 音量条原有实现只绑鼠标
 *    事件，触屏拖动失效；此处用 touchstart/touchmove 补齐，
 *    preventDefault 阻止浏览器将其误转为滚动/缩放手势。
 * 3) 配套样式见 styles/touch.css（touch-action、触控目标尺寸）。
 * ============================================================ */
import { audio } from './20-lyrics-render.js';
import { volumePercentToGain } from '../utils/volumeCurve.js';
import { playerContainer } from './40-playback-state.js';
import { mobilePageMq, syncMobilePageState } from './60-mobile-dual-page.js';
import { logCatch } from '../services/log.js';

/* ---------- 1. 双页滑动手势 ---------- */
(function bindMobilePageSwipe() {
    if (typeof document === 'undefined' || !playerContainer) return;

    /* 桌面调试入口：URL 带 ?forceMobile=1 时跳过窄屏检测（便于宽屏窗口验证手势逻辑） */
    const FORCE_MOBILE = /(?:^|[?&])forceMobile=1/.test(location.search);
    const isNarrow = function () { return FORCE_MOBILE || mobilePageMq.matches; };

    let startX = 0, startY = 0, tracking = false;

    /* 命中这些区域的触摸不参与翻页手势 */
    const GESTURE_BLOCK_SELECTOR =
        '.lyrics-container, .lyrics-area-wrapper, input, select, textarea, ' +
        '.bottom-control-bar, .modal, [class*="overlay"], [class*="menu"]';

    playerContainer.addEventListener('touchstart', function (e) {
        tracking = false;
        if (!isNarrow()) return;                                        /* 仅窄屏 */
        if (!playerContainer.classList.contains('view-cover')) return;  /* 仅默认封面模式 */
        if (e.touches.length !== 1) return;                             /* 单指 */
        const target = e.target;
        if (target && target.closest && target.closest(GESTURE_BLOCK_SELECTOR)) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        tracking = true;
    }, { passive: true });

    playerContainer.addEventListener('touchmove', function (e) {
        if (!tracking) return;
        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;
        /* 水平主导位移且超过阈值才判定翻页，避免误伤纵向滚动 */
        if (Math.abs(dx) >= 56 && Math.abs(dx) >= Math.abs(dy) * 1.6) {
            tracking = false;
            const toLyrics = dx < 0;
            if (toLyrics !== playerContainer.classList.contains('mobile-page-lyrics')) {
                playerContainer.classList.toggle('mobile-page-lyrics', toLyrics);
                syncMobilePageState();
                try { if (navigator.vibrate) navigator.vibrate(10); } catch (_) { logCatch('touchGestures', _); }
            }
        }
    }, { passive: true });

    const stopTracking = function () { tracking = false; };
    playerContainer.addEventListener('touchend', stopTracking, { passive: true });
    playerContainer.addEventListener('touchcancel', stopTracking, { passive: true });
})();

/* ---------- 2. 滑杆触摸拖拽 ---------- */
(function bindTouchSliders() {
    if (typeof document === 'undefined') return;

    function setFill(el, pct) {
        if (el) el.style.width = (pct * 100) + '%';
    }

    function bindSlider(track, fillEl, onPercent) {
        if (!track || track.dataset.touchBound === '1') return;
        track.dataset.touchBound = '1';
        let dragging = false;
        const applyFrom = function (touch) {
            const rect = track.getBoundingClientRect();
            if (!rect.width) return;
            const pct = Math.min(1, Math.max(0, (touch.clientX - rect.left) / rect.width));
            onPercent(pct);
            setFill(fillEl, pct);
        };
        track.addEventListener('touchstart', function (e) {
            dragging = true;
            applyFrom(e.touches[0]);
            e.preventDefault();     /* 阻止浏览器把后续 move 转为页面滚动 */
        }, { passive: false });
        track.addEventListener('touchmove', function (e) {
            if (!dragging) return;
            applyFrom(e.touches[0]);
            e.preventDefault();
        }, { passive: false });
        const endDrag = function () { dragging = false; };
        track.addEventListener('touchend', endDrag);
        track.addEventListener('touchcancel', endDrag);
    }

    /* 主进度条（控件页）：seek + 同步填充宽度；seeked 后歌词等由既有监听器接管 */
    const progressTrack = document.getElementById('progressTrack');
    const progressFill = document.getElementById('progress');
    bindSlider(progressTrack, progressFill, function (pct) {
        if (typeof window !== 'undefined' && window.Aria && window.Aria.__npActive && window.Aria.__npActive()) return; /* 接管只读：不可拖 */
        if (!audio || !audio.duration || audio.duration <= 0) return;
        audio.currentTime = pct * audio.duration;
    });

    /* 底部进度条：与既有鼠标拖拽行为一致（即时 seek） */
    const bottomProgressTrack = document.getElementById('bottomProgressTrack');
    const bottomProgressFill = document.getElementById('bottomProgressBar');
    bindSlider(bottomProgressTrack, bottomProgressFill, function (pct) {
        if (typeof window !== 'undefined' && window.Aria && window.Aria.__npActive && window.Aria.__npActive()) return; /* 接管只读：不可拖 */
        if (!audio || !audio.duration || audio.duration <= 0) return;
        audio.currentTime = pct * audio.duration;
    });

    /* 音量条：iOS Safari 的 audio.volume 只读，视觉仍同步（平台限制）；使用对数曲线
       （手柄位置 → dB → 声压），与主音量条 updateVolume 行为一致 */
    const volumeTrack = document.getElementById('volumeTrack');
    const volumeFill = document.getElementById('volumeBar');
    bindSlider(volumeTrack, volumeFill, function (pct) {
        if (typeof window !== 'undefined' && window.Aria && window.Aria.__npActive && window.Aria.__npActive()) return; /* 接管只读：音量不可调 */
        if (!audio) return;
        try { audio.volume = volumePercentToGain(pct * 100); } catch (_) { logCatch('touchGestures', _); }
    });
})();
