/* ============================================================
 * 103-mv-upscale.js — MV 画质增强的「驱动层」（Anime4K 上行渲染）
 *
 * 分工：services/mvUpscale.js 负责 GL（编译 shader、多 pass、分配纹理）；
 *   这一层负责**什么时候画、画多大、什么时候放弃**：
 *     · `requestVideoFrameCallback` 驱动 —— 只在**解码出新帧**时渲染，
 *       MV 常见 24/30fps，用 rAF 会有一半的帧在白跑（浪费 GPU 与电）；
 *     · canvas 内部分辨率跟随窗口（上限 2560x1440），窗口变化时重建；
 *     · 两道降级闸：render() 失败、或单帧耗时连续超预算 ⇒ 自动关掉并
 *       广播 `aria:mv-upscale-off`，由 101 把 video 恢复成可见（用户至少能看）。
 *
 * 为什么 video 要 crossOrigin="anonymous"：WebGL 的 texImage2D 对**跨源**
 *   媒体会抛 SecurityError，除非该请求是 CORS 模式且对方给了 ACAO。实测
 *   酷狗 / 网易 / QQ 三家 MV 直链**都带 `Access-Control-Allow-Origin: *`**，
 *   所以不需要同源代理（也就不必改 server.py、不必重打包 server.exe）。
 *   个别源若拒绝，101 会去掉 crossOrigin 重试，只是这一支不做增强。
 * ============================================================ */
import { createUpscaler, isUpscaleSupported } from '../services/mvUpscale.js';
import { logInfo, logWarn, logCatch } from '../services/log.js';

const MAX_W = 2560;          /* canvas 内部宽度上限（超过就降采样，成本可控） */
const MAX_H = 1440;
/* 单帧耗时预算：**按档位给**。
   MV 多是 24~30fps（每帧 33~40ms），而 M/L 档本身就是"拿 GPU 换画质"——
   一律用 S 档的 12ms 去卡，用户刚切到 L 就会被降级闸关掉，那个档位等于不存在。
   S 保持严格：它默认开、要照顾弱机。 */
const SLOW_MS_BY_TIER = { S: 12, M: 20, L: 28 };
const slowBudget = (tier) => SLOW_MS_BY_TIER[tier] || SLOW_MS_BY_TIER.S;
const SLOW_STREAK = 90;      /* 连续这么多帧都慢才降级（偶发卡顿不误杀） */
const PAUSED_MS = 250;       /* 暂停态的兜底重绘间隔 —— 见 tick() 的说明 */

let _upscaler = null;
let _video = null;
let _canvas = null;
let _running = false;
let _disabled = false;       /* 本会话运行期降级后不再重试（设置改动可复位） */
let _slow = 0;
let _fail = 0;
let _rvfcId = 0;
let _rafId = 0;
let _timerId = 0;
let _lastSize = { w: 0, h: 0 };

function videoEl() {
    if (_video && _video.isConnected) return _video;
    _video = (typeof document !== 'undefined') ? document.getElementById('mvBgVideo') : null;
    return _video;
}
function canvasEl() {
    if (_canvas && _canvas.isConnected) return _canvas;
    _canvas = (typeof document !== 'undefined') ? document.getElementById('mvBgCanvas') : null;
    return _canvas;
}

/** 是否值得尝试（设置开着 + GL 可用 + 本会话没降级过） */
export function mvUpscaleAvailable() {
    if (_disabled) return false;
    if (typeof document === 'undefined') return false;
    return isUpscaleSupported();
}

/** 设置改动后复位降级闸：用户重新打开开关就再给一次机会 */
export function resetMvUpscaleGuard() {
    _disabled = false;
    _slow = 0;
    _fail = 0;
}

export function mvUpscaleActive() { return _running; }

/** canvas 内部分辨率跟随窗口。返回是否发生变化。 */
function syncCanvasSize(cv) {
    if (typeof window === 'undefined') return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    /* .mv-background 是 112% 窗口尺寸；canvas 没有 object-fit，内部分辨率必须
       与显示尺寸同比例，否则会被拉伸变形。等比系数同时受 dpr 与上限约束。 */
    const bw = Math.max(2, window.innerWidth * 1.12);
    const bh = Math.max(2, window.innerHeight * 1.12);
    const k = Math.min(dpr, MAX_W / bw, MAX_H / bh);
    const w = Math.max(2, Math.round(bw * k));
    const h = Math.max(2, Math.round(bh * k));
    if (w === _lastSize.w && h === _lastSize.h && cv.width === w && cv.height === h) return false;
    cv.width = w; cv.height = h;
    _lastSize = { w, h };
    return true;
}

function degrade(why) {
    logWarn('mvUpscale', `[MV] 画质增强已关闭（${why}）`);
    _disabled = true;
    stopMvUpscale();
    try {
        if (typeof document !== 'undefined') {
            document.dispatchEvent(new CustomEvent('aria:mv-upscale-off', { detail: { why } }));
        }
    } catch (e) { logCatch('mvUpscale', e); }
}

function scheduleNext(v) {
    if (!_running) return;
    if (typeof v.requestVideoFrameCallback === 'function') {
        _rvfcId = v.requestVideoFrameCallback(tick);
    } else {
        _rafId = requestAnimationFrame(tick);
    }
}

/* ★ 暂停态也必须画。
   画质增强生效时 video 是 `visibility:hidden`（画面完全由 canvas 提供），
   所以"暂停了就不渲染"的写法会让 MV **整片消失**，露出下面的模糊封面 ——
   正是用户此前报过的「暂停时只显示封面」的另一种形态。
   暂停时用低频定时器兜底重绘，这样拖进度（跟随 seek 改的是 video.currentTime）
   画面也会跟着更新。 */
function schedulePaused() {
    if (!_running) return;
    _timerId = setTimeout(tick, PAUSED_MS);
}

function tick() {
    if (!_running) return;
    const v = videoEl();
    const cv = canvasEl();
    if (!v || !cv || !_upscaler) { stopMvUpscale(); return; }
    const live = v.readyState >= 2 && !v.paused;
    if (v.readyState >= 2) {
        syncCanvasSize(cv);
        let ok = false;
        try {
            ok = _upscaler.render(v, v.videoWidth, v.videoHeight);
        } catch (e) {
            logCatch('mvUpscale', e);
        }
        if (!ok) {
            _fail++;
            if (_fail >= 5) { degrade('渲染连续失败'); return; }
        } else {
            _fail = 0;
            /* 只有播放中才拿耗时当降级依据 —— 暂停态的兜底重绘是"静止帧，
               不该按帧率要求它 */
            const ms = _upscaler.info.avgMs || 0;
            if (live && ms > slowBudget(_upscaler.info.tier)) {
                _slow++;
                if (_slow >= SLOW_STREAK) { degrade(`单帧 ${ms.toFixed(1)}ms 持续超预算`); return; }
            } else if (_slow > 0) {
                _slow = 0;
            }
        }
    }
    if (live) scheduleNext(v);
    else schedulePaused();
}

/** 设置里选的档位（非法值一律回落 S —— S 最轻，跑不动时它最不容易触发降级闸） */
function currentTier() {
    const t = (typeof appSettings !== 'undefined' && appSettings && appSettings.background)
        ? appSettings.background.mvUpscaleTier : '';
    return (t === 'M' || t === 'L') ? t : 'S';
}

export function startMvUpscale() {
    if (_running) return true;
    const v = videoEl();
    const cv = canvasEl();
    if (!v || !cv) return false;
    if (!mvUpscaleAvailable()) return false;
    const tier = currentTier();
    /* ★ 档位变了必须重建：不同档的 pass 图与纹理编号都独立（S 9 / M 17 / L 19 pass），
       拿旧实例画新档等于用错权重。换档成本只是重新编译一次 shader。 */
    if (_upscaler && _upscaler.info.tier !== tier) {
        try { _upscaler.dispose(); } catch (e) { logCatch('mvUpscale', e); }
        _upscaler = null;
        _lastSize = { w: 0, h: 0 };
    }
    if (!_upscaler) {
        _upscaler = createUpscaler(cv, tier);
        if (!_upscaler) { _disabled = true; return false; }
        const i = _upscaler.info;
        logInfo('mvUpscale', `[MV] 画质增强已启用（${i.tier} 档 · ${i.passes} pass · 中间纹理 ${i.float ? 'RGBA16F' : 'RGBA8'}）`);
    }
    syncCanvasSize(cv);
    _running = true;
    _slow = 0;
    _fail = 0;
    cv.classList.add('visible');
    scheduleNext(v);
    return true;
}

export function stopMvUpscale() {
    if (!_running) {
        const cv = canvasEl();
        if (cv) cv.classList.remove('visible');
        return;
    }
    _running = false;
    const v = videoEl();
    if (_rvfcId && v && typeof v.cancelVideoFrameCallback === 'function') {
        try { v.cancelVideoFrameCallback(_rvfcId); } catch (e) { logCatch('mvUpscale', e); }
    }
    _rvfcId = 0;
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
    if (_timerId) { clearTimeout(_timerId); _timerId = 0; }
    const cv = canvasEl();
    if (cv) cv.classList.remove('visible');
}

/** 彻底释放（切到「不用 MV 背景」时调用，避免留着 WebGL 上下文） */
export function disposeMvUpscale() {
    stopMvUpscale();
    if (_upscaler) {
        try { _upscaler.dispose(); } catch (e) { logCatch('mvUpscale', e); }
        _upscaler = null;
    }
    _lastSize = { w: 0, h: 0 };
}

/** 窗口尺寸变化时重建 canvas 尺寸（下一帧 render 会自动跟上） */
export function notifyMvUpscaleResize() {
    if (!_running) return;
    const cv = canvasEl();
    if (cv) syncCanvasSize(cv);
}
