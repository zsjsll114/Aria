/**
 * sonnetMode.js — sonnet 视觉模式的引擎单例与驱动（M1）
 *
 * 对应 folia 的 VisualizerSonnet.tsx 宿主职责：Pixi 引擎懒加载（首次进入 sonnet
 * 模式才拉起 1.5MB 的 Pixi bundle）、rAF 时间驱动、切换模式的挂起/恢复。
 * 220-shortcuts-viewmode 的 switchView('sonnet') 分支通过动态 import 调用这里。
 */

import { SonnetEngine, deriveCoverBackground } from './SonnetEngine.js';
import { resolveSonnetAudioLevels } from './sonnetAudioLevels.js';
/* ★ 2026-10-11 纯音乐（无歌词 ⇒ 虚拟 ♪ 行）：纯逻辑与 tempera 共用，见该文件头 */
import {
    INSTRUMENTAL_GRACE_SEC, buildVirtualInstrumentalLines, advanceInstrumental, instrumentalSongKey,
} from '../instrumentalLines.js';
import { sanitizeCssFontFamily } from '../../../utils/fontStacks.js';
import { logCatch } from '../../../services/log.js';

/** 引擎 canvas 需要随容器重建（切模式时 pvViewContainer 可能被 innerHTML 清空） */
function containerElFix(container) {
    if (engine && engine.canvas && engine.canvas.parentNode !== container) {
        container.appendChild(engine.canvas);
    }
}

let engine = null;
let rafId = null;
let suspended = false;
let lastLyricsRef = null;   /* 引用比较：切歌/重解析时自动重编译 program */
let lastEmotionRef = null;  /* 引用比较：AI 情感词更新时刷新 wordColors */
let lastFontKey = null;     /* 引用比较：全局字体设置变更时热切换（Pixi 字体烘焙进 TextStyle，CSS 变量无效） */
let freqBuf = null;         /* 音频驱动用的可复用频谱缓冲（按 analyser.frequencyBinCount 尺寸，见 pushAudioLevels） */
let clockInited = false;
let clockRawSec = 0;
let clockSmoothSec = 0;
let clockPerfMs = 0;

function resetAudioClock() {
    clockInited = false;
    clockRawSec = 0;
    clockSmoothSec = 0;
    clockPerfMs = 0;
}

/** 情感词 → 上游 theme.wordColors 形状（[{word,color}]，TextViewBuilder isKeyword 消费） */
function emotionWordsToColors(list) {
    return (Array.isArray(list) ? list : [])
        .filter(item => item && item.word && item.color)
        .map(item => ({ word: String(item.word), color: String(item.color) }));
}

function currentEmotionList() {
    const list = (typeof globalThis !== 'undefined' && Array.isArray(globalThis.aiEmotionWords))
        ? globalThis.aiEmotionWords : [];
    return list;
}

/** 全局字体设置 → 引擎字体栈（appSettings.interface.fontFamily 是 key，resolveFontFamily 出真栈）
    ★ 2026-10-01 过 sanitizeCssFontFamily：resolveFontFamily 返回整串栈，直接进 Pixi
    TextStyle 会被 toFontString 按逗号误拆出引号不配对段，渲染回退 10px 字体
    （字号再大也只见小字——tempera 同源问题的 sonnet 侧）。 */
function currentFontStack() {
    try {
        const fontKey = (typeof globalThis !== 'undefined' && globalThis.appSettings
            && globalThis.appSettings.interface && globalThis.appSettings.interface.fontFamily) || 'inherit';
        if (typeof window !== 'undefined' && typeof window.resolveFontFamily === 'function') {
            const stack = window.resolveFontFamily(fontKey);
            return stack ? sanitizeCssFontFamily(stack) : null;
        }
    } catch { /* 字体管理器未就绪不阻塞 */ }
    return null;
}

/** 把已存的 PV 模式设置（modeSettings.pv）下发给引擎（进入模式时一次性对齐） */
function applyStoredModeSettings() {
    try {
        const pv = (typeof globalThis !== 'undefined' && globalThis.appSettings
            && globalThis.appSettings.modeSettings && globalThis.appSettings.modeSettings.pv) || null;
        if (pv && engine) engine.applySettings(pv);
        /* 仅当未显式指定模式字体时，再回落到全局字体栈 */
        const explicitPvFont = pv && pv.fontFamily && pv.fontFamily !== 'default' && pv.fontFamily !== 'inherit';
        if (engine && !explicitPvFont) {
            const stack = currentFontStack();
            if (stack) engine.fontFamily = stack;
        }
    } catch { /* 设置形状异常不阻塞进入 */ }
}

function rawAudioBaseTimeSec() {
    const audio = typeof document !== 'undefined' ? document.getElementById('audioPlayer') : null;
    const sec = audio && Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    return { audio, sec };
}

function audioTime() {
    /* ★ 与 70 主循环同一公式 + 亚帧单调锁相插值（2026-11-20）：
       Chromium 的 audio.currentTime 按音频缓冲量子刷新（10~25ms 才跳一格），在 60/120/144Hz
       显示器直接读原值会出现连续两帧时间为 0 步进随后突跳 2~3 倍的微卡顿；用 performance.now()
       做单调 PLL 亚帧插值（seek / 暂停 / 偏移>80ms 立即硬对齐），高刷下逐帧绝对均匀丝滑。 */
    const { audio, sec: rawSec } = rawAudioBaseTimeSec();
    const offsetSec = (typeof globalThis.lyricOffset === 'number' ? globalThis.lyricOffset : 0) / 1000;
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const isPlayingNow = Boolean(audio && !audio.paused && (typeof document === 'undefined' || !document.hidden));

    if (!isPlayingNow) {
        clockInited = true;
        clockRawSec = rawSec;
        clockSmoothSec = rawSec;
        clockPerfMs = now;
        return rawSec + offsetSec;
    }

    const rate = (audio && Number.isFinite(audio.playbackRate) && audio.playbackRate > 0) ? audio.playbackRate : 1;
    if (!clockInited || rawSec < clockRawSec - 0.01 || Math.abs(rawSec - clockSmoothSec) > 0.08) {
        clockInited = true;
        clockRawSec = rawSec;
        clockSmoothSec = rawSec;
        clockPerfMs = now;
        return rawSec + offsetSec;
    }

    const dtSec = Math.max(0, Math.min(0.05, (now - clockPerfMs) * 0.001)) * rate;
    let est = clockSmoothSec + dtSec;
    if (Math.abs(rawSec - clockRawSec) > 1e-4) {
        clockRawSec = rawSec;
        est += Math.max(-0.015, Math.min(0.015, (rawSec - est) * 0.25));
    }
    /* 上限防超前冻结：外推最多超前最新音频采样 45ms，且严格单调不回退 */
    if (est > clockRawSec + 0.045) est = clockRawSec + 0.045;
    if (est < clockSmoothSec) est = clockSmoothSec;

    clockSmoothSec = est;
    clockPerfMs = now;
    return est + offsetSec;
}

/* ★ 2026-10-11 纯音乐（上游 songHandover.ts 的 decideSongCommit + VisualizerSonnet.tsx:89-107）：
   无歌词的歌在 verse 里此前是**全黑空白** —— `setLyrics([])` → 0 段落 → 什么都不画。
   判定与虚拟 ♪ 行的实现都在 `../instrumentalLines.js`（与 tempera 共用同一套纯逻辑，
   理由见该文件头；上游两个 visualizer 的这段也是逐字相同，只差 id 前缀）。
   这里只保留本模式的**别名与私有状态**：观察窗状态按模式各自持有——两个模式可能同时
   存在（一个挂起一个活跃），共享状态会互踩。 */
export const SONNET_INSTRUMENTAL_GRACE_SEC = INSTRUMENTAL_GRACE_SEC;

let instrumentalState = { instrumental: false, watch: null };

/** 上游 VisualizerSonnet.tsx:91-101 同参（60 条 / 每 8s 一条 / 长 6s；sonnet 的 id 前缀是
    `virtual-staff-`，tempera 是 `virtual-block-`）。时间毫秒制，编译期归一为秒。 */
export const buildSonnetVirtualStaffLines = (count = 60, stepSec = 8, holdSec = 6) => (
    buildVirtualInstrumentalLines('virtual-staff-', count, stepSec, holdSec)
);

/** 共享判定函数的本模式出口（测试与调用方沿用 sonnet 名） */
export const advanceSonnetInstrumental = advanceInstrumental;

/* 当前歌曲身份：共享实现，本文件沿用原名以免无谓改动调用点 */
const currentSongKey = instrumentalSongKey;

/**
 * 把共享频谱折算成三个频段量并推给引擎（bass / power / vocal，0~255）。
 *
 * ★ 上游对应的是 `audioBands` / `audioPower` 作为 props 一路传进运行时；本仓没有那条
 *   React 链路，所以由这个逐帧循环充当宿主（等价于 VisualizerSonnet 的职责）。
 * ★ 复用 core/equalizer.js:849 建的那颗 `window.playerAudioAnalyser`（fftSize=128），
 *   **不新建音频节点**，也**不改它的 fftSize**（改了会连带改掉 306-energy-motion 的
 *   低频口径）。精度代价与频段切分见 sonnetAudioLevels.js 的头注释。
 * ★ 边界：原生 WASAPI 独占输出时音频不过 WebAudio 图 → 这里恒 0（与 306 同一条边界，不是坏）。
 */
function pushAudioLevels() {
    if (!engine || typeof engine.setAudioLevels !== 'function') return;
    try {
        const an = (typeof window !== 'undefined') ? window.playerAudioAnalyser : null;
        if (!an || typeof an.getByteFrequencyData !== 'function') { engine.setAudioLevels(null); return; }
        /* 暂停/停止时不消费频谱：否则会挂着最后一帧的高值，画面僵在"正响着"的样子 */
        const audio = document.getElementById('audioPlayer');
        if (audio && audio.paused) { engine.setAudioLevels(null); return; }
        const bins = an.frequencyBinCount;
        if (!freqBuf || freqBuf.length !== bins) freqBuf = new Uint8Array(bins);
        an.getByteFrequencyData(freqBuf);
        const sampleRate = an.context && an.context.sampleRate;
        engine.setAudioLevels(resolveSonnetAudioLevels(freqBuf, sampleRate, an.fftSize));
    } catch (e) {
        logCatch('sonnetMode', e);
        /* 出错帧按静音处理：宁可不反应，也别让画面卡在上一帧的响度上 */
        try { engine.setAudioLevels(null); } catch { /* 引擎已销毁 */ }
    }
}

function tick() {
    if (!engine || suspended) { rafId = null; return; }
    try {
        tickBody();
    } catch (e) {
        logCatch('sonnetMode', e);
    }
    if (!suspended) rafId = requestAnimationFrame(tick);
    else rafId = null;
}

function tickBody() {
        if (suspended) return;
        const current = (typeof globalThis.lyrics !== 'undefined' && Array.isArray(globalThis.lyrics))
            ? globalThis.lyrics : null;
        let lyricsApplied = false;
        if (current !== lastLyricsRef) {
            lastLyricsRef = current;
            engine.setLyrics(current || []);
            lyricsApplied = true;
        }
        /* ★ 2026-10-11 纯音乐：无歌词 ⇒ 喂虚拟 ♪ 行（见 buildSonnetVirtualStaffLines 的说明）。
           只在**判定翻转**的那一帧重编译——setLyrics 会重建整个 program（段落/镜头/场景
           全部作废重建），逐帧调用等于逐帧重建，会把 rAF 拖死。 */
        const hasWords = !!(current && current.length);
        const wasInstrumental = instrumentalState.instrumental;
        instrumentalState = advanceSonnetInstrumental(instrumentalState, {
            hasWords,
            timeSec: audioTime(),
            songKey: currentSongKey(),
        });
        if (instrumentalState.instrumental !== wasInstrumental) {
            if (instrumentalState.instrumental) engine.setLyrics(buildSonnetVirtualStaffLines());
            /* 离开纯音乐：本帧若已因「歌词引用变化」灌过同一份真实歌词，就不必再来一次 */
            else if (!lyricsApplied) engine.setLyrics(current || []);
        }
        /* ★ AI 情感词 → theme.wordColors（上游 isKeyword 着色链路）：
           AI 分析完成时 aiEmotionWords 引用更新 → 引擎清场景用新色重建 */
        const emotion = currentEmotionList();
        if (emotion !== lastEmotionRef) {
            lastEmotionRef = emotion;
            engine.theme.wordColors = emotionWordsToColors(emotion);
            engine.invalidateScenes();
        }
        /* ★ 全局字体热跟随（2026-09-30 二修）：每帧比对「解析出的真字体栈」而非 key——
           自定义字体走 IndexedDB 异步注册，注册完成前 resolveFontFamily 回退默认栈，
           仅监听 key 变化会永远停在回退栈（用户实测「不能跟随全局字体」的根因）。
           栈变化（含注册完成、用户换字体）即重烘焙。 */
        try {
            const pvFont = globalThis.appSettings?.modeSettings?.pv?.fontFamily;
            const explicitPvFont = pvFont && pvFont !== 'default' && pvFont !== 'inherit';
            if (!explicitPvFont) {
                const stack = currentFontStack();
                if (stack && stack !== lastFontKey) {
                    lastFontKey = stack;
                    if (stack !== engine.fontFamily) {
                        engine.fontFamily = stack;
                        engine.invalidateScenes();
                    }
                }
            }
        } catch { /* 字体管理器未就绪 */ }
        /* 音频驱动：必须在 update 之前灌，本帧的 MG 才能拿到当前响度 */
        pushAudioLevels();
        engine.update(audioTime());
}

/* 验证/调试探针：E2E 与诊断页通过它读取 engine 实例（program/场景树/_lastError） */
function probe() {
    return engine ? {
        program: engine.program,
        engine,
        ready: !!(engine.app && engine.program),
        update: t => engine.update(t),
    } : null;
}

/* E2E 挂起 rAF 驱动（audio 停走时会用 0 覆盖测试注入的时间）；Pixi ticker 独立不受影响 */
function suspendRaf() {
    suspended = true;
}

function startTicker() {
    /* ★ 2026-11-20 单一 rAF 合拍：优先通过 engine.onBeforeTick 在 Pixi app.ticker
       同一帧渲染前就地更新时间/歌词/频谱，彻底消除双 rAF 相位错位与 1 帧滞后。 */
    if (rafId !== null) {
        try { cancelAnimationFrame(rafId); } catch { /* 句柄已失效 */ }
        rafId = null;
    }
    if (engine && engine.app && engine.app.ticker) {
        engine.onBeforeTick = () => {
            if (!engine || suspended) return;
            try {
                tickBody();
            } catch (e) {
                logCatch('sonnetMode', e);
            }
        };
        return;
    }
    rafId = requestAnimationFrame(tick);
}

/** 进入 sonnet 模式：懒建引擎并接上歌词。返回 Promise<SonnetEngine> */
export async function ensureSonnetEngine(container) {
    /* 探针先于 init 挂（Pixi init / 滤镜编译在低端 GPU 上可能秒级挂起，
       E2E 需要在此期间就能 suspend/读状态）
       ★ 2026-10-03 另设语义化就绪标志 __sonnetEngineReady：此前 100/190/220 三处
       业务逻辑拿「调试探针名是否存在」当引擎就绪判断——探针是调试设施，随时可能
       被清理（本轮收尾删探针时就差点把设置下发整条链断掉）。业务判断改读这个标志，
       探针保留给 E2E。 */
    if (typeof window !== 'undefined') {
        window.__sonnetEngineReady = true;
        window.__sonnetProbe = () => probe();
        window.__sonnetSuspend = suspendRaf;
        window.__sonnetCtrl = { isRunning: isSonnetRunning, pause: suspendSonnetEngine, resume: resumeSonnetEngine };
    }
    containerElFix(container);
    if (!engine) {
        engine = new SonnetEngine(container);
        /* ★ 色板对齐 folia Midnight Default（baseThemes.ts）：zinc-950 底 / zinc-100 主字 /
           zinc-500 副色。accent 用 Aria 主题色做点缀（上游 accent=zinc-100，Aria 保留品牌色）。
           之前用专辑取色当主字色——彩色大字 + 彩色 CA 是「不像 folia」的另一主因。 */
        /* ★ 色板对齐 folia Midnight Default（baseThemes.ts）：zinc-950 底 / zinc-100 主字 /
           zinc-500 副色。accent 用 Aria 主题色做点缀（上游 accent=zinc-100，Aria 保留品牌色）。
           之前用专辑取色当主字色——彩色大字 + 彩色 CA 是「不像 folia」的另一主因。
           fontStyle/fontFamilyStack/fontWeight 是上游 fontStacks/排版链消费的主题字段。
           ★ 2026-09-30 背景不再纯黑：backgroundColor 由封面主色混 75% 黑派生
           （保 hue 压亮度），每首歌背景色随封面变化；情感词经 wordColors 接通上游着色。 */
        const palette = (typeof window !== 'undefined' && window.coverPalette) || null;
        engine.theme = {
            name: 'Aria',
            backgroundColor: deriveCoverBackground(palette),
            primaryColor: '#f4f4f5',
            /* ★ 2026-10-01 背景图形跟随主题色（用户实测）：MG 几何/装饰线主色
               secondaryColor 此前恒定 zinc 灰——跟随封面 secondary（换歌时
               applyCoverPalette 持续更新），用户手动设置「图形色」时不被覆盖 */
            secondaryColor: (palette && (palette.secondary || palette.primary)) || '#71717a',
            accentColor: (palette && palette.accent) || '#E8BE6A',
            fontStyle: 'sans',
            fontFamily: null,
            fontFamilyStack: null,
            fontWeight: null,
            wordColors: emotionWordsToColors(currentEmotionList()),
            /* 动效强度：上游 Theme 字段。设置项「动态强度」到达时会覆盖它
               （见 SonnetEngine.applySettings → applyStoredModeSettings），
               这里先立上游默认值 'normal'，免得设置到达前它是 undefined
               （undefined 会落回 1，碰巧等于 normal，但那不显式、也不可追踪）。 */
            animationIntensity: 'normal',
        };
        /* ★ 2026-10-11 回退到上游：上游 `lyricsFontScale` 是 tuning 调试项，
           用户场景恒为 1（见 SonnetEngine.applySettings 的注释），字号一律交给
           设置项「基础字号」。本地曾把它硬提到 1.25×→1.4×，等于整体放大字号。 */
        engine.lyricsFontScale = 1;
        applyStoredModeSettings();
        await engine.init();
    } else {
        container.appendChild(engine.canvas);
    }
    suspended = false;
    resetAudioClock();
    /* ★ 2026-10-01：suspend 时 app.stop() 了，恢复进入必须重启 ticker（配对 setPaused） */
    const current = (typeof globalThis.lyrics !== 'undefined' && Array.isArray(globalThis.lyrics))
        ? globalThis.lyrics : [];
    if (current !== lastLyricsRef) {
        lastLyricsRef = current;
        engine.setLyrics(current);
    }
    engine.update(audioTime());
    startTicker();
    engine.setPaused(false);
    return engine;
}

/** 歌词变化（切歌/重解析）时由外部调用 */
export function setSonnetLyrics(lines) {
    if (engine) engine.setLyrics(lines);
}

/** 封面取色更新（100-cover-background 调用）：accent 跟随新封面，场景重建换色 */
export function applySonnetCoverPalette(palette) {
    if (engine && palette) engine.applyCoverPalette(palette);
}

/** 模式设置下发（190-settings-fontsize 调用），等价旧 pvEngineInstance.applySettings */
export function applySonnetSettings(settings) {
    if (engine) engine.applySettings(settings);
}

/** 立即喂时间（不依赖自身 rAF，供 70-audio-engine 主循环同路驱动） */
export function updateSonnetEngine(timeSec) {
    if (engine && !suspended) engine.update(timeSec);
}

/** 切走时挂起：停渲染省 GPU，引擎与场景缓存保留（切回秒恢复） */
export function suspendSonnetEngine() {
    suspended = true;
    resetAudioClock();
    if (rafId !== null) {
        try { cancelAnimationFrame(rafId); } catch { /* 句柄已失效 */ }
        rafId = null;
    }
    if (engine) {
        engine.onBeforeTick = null;
        engine.setPaused(true);
    }
}

/** 从后台节流恢复诗镜渲染循环 */
export function resumeSonnetEngine() {
    if (!engine) return;
    suspended = false;
    resetAudioClock();
    engine.update(audioTime());
    startTicker();
    engine.setPaused(false);
}

export function isSonnetRunning() {
    return !!(engine && !suspended);
}

/** 真正销毁（页面卸载/内存回收） */
export function destroySonnetEngine() {
    resetAudioClock();
    lastFontKey = null;
    if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
    }
    if (engine) {
        engine.onBeforeTick = null;
        engine.destroy();
        engine = null;
    }
}

/** 供 220 每帧循环顺路驱动（与 pv/tunnel 同一调用点形态） */
export function isSonnetActive() {
    return !!(engine && !suspended);
}

/**
 * 取当前 SonnetEngine 实例（只读）。
 * ★ 歌词海报（需求 2）要用它抓一帧真画面：Pixi 的 WebGL 画布在
 *   `preserveDrawingBuffer:false` 下 `toDataURL()` 恒为空，必须「同一任务内
 *   `renderer.render(stage)` 后立刻 `toDataURL()`」。调用方不得修改返回对象。
 */
export function getSonnetEngine() {
    return engine;
}

/**
 * 海报抓帧前将 诗境(pv) 引擎定格到「当前句完整显形」的瞬间（全部字素入场完毕、未退场前）。
 * 解决截帧恰好落在刚唱头两个字（如仅显示「一眨」）时海报缺少整句歌词的问题。
 * @param {number} [targetLineIndex]
 * @returns {(() => void)|null}
 */
export function stageSonnetForPoster(targetLineIndex) {
    if (!engine || !engine.app || !engine.program) return null;
    const prevTime = engine.currentTime || 0;
    const prevSuspended = suspended;
    let queryTime = prevTime;
    const rawLyrics = (typeof globalThis.lyrics !== 'undefined' && Array.isArray(globalThis.lyrics))
        ? globalThis.lyrics : [];
    if (Number.isInteger(targetLineIndex) && targetLineIndex >= 0 && rawLyrics[targetLineIndex]) {
        const isMs = rawLyrics.some((l) => l && typeof l.start === 'number' && l.start >= 1000);
        const div = isMs ? 1000 : 1;
        const item = rawLyrics[targetLineIndex];
        const st = Number(item.start ?? item.time) / div;
        const ed = item.end != null ? Number(item.end) / div : st + 3.0;
        if (Number.isFinite(st)) {
            queryTime = st + Math.max(0.05, ed - st) * 0.55;
        }
    }
    const paragraphs = engine.program.paragraphs || [];
    let bestTime = queryTime;
    let matchedParaIdx = -1;
    let matchedPara = null;
    let matchedShotIdx = -1;
    let matchedHit = null;
    for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
        const para = paragraphs[pIdx];
        if (!para || !Array.isArray(para.shots)) continue;
        let hitIdx = para.shots.findIndex((sh) => queryTime >= sh.startTime && queryTime <= sh.endTime);
        if (hitIdx < 0 && queryTime >= para.startTime && queryTime <= para.endTime && para.shots.length > 0) {
            hitIdx = 0;
        }
        if (hitIdx >= 0) {
            matchedParaIdx = pIdx;
            matchedPara = para;
            matchedShotIdx = hitIdx;
            matchedHit = para.shots[hitIdx];
            const span = Math.max(0.1, matchedHit.endTime - matchedHit.startTime);
            bestTime = Math.min(matchedHit.endTime - Math.min(0.12, span * 0.08), matchedHit.startTime + span * 0.86);
            break;
        }
    }
    const prevEnginePaused = !!engine.paused;
    suspended = true;
    engine.setPaused(true);
    engine.renderAtTimeSync(bestTime);
    if (matchedHit && matchedPara) {
        const span = Math.max(0.1, matchedHit.endTime - matchedHit.startTime);
        const nextShot = matchedPara.shots[matchedShotIdx + 1];
        let exitCeiling = matchedHit.endTime - 0.04;
        if (nextShot) {
            const transDur = Math.min(0.24, Math.max(0.14, (nextShot.startTime - matchedHit.startTime) * 0.18));
            exitCeiling = Math.min(exitCeiling, nextShot.startTime - transDur - 0.02);
        }
        if (matchedShotIdx === matchedPara.shots.length - 1 && matchedPara.transitionOut) {
            exitCeiling = Math.min(exitCeiling, matchedPara.transitionOut.startTime - 0.02);
        }
        exitCeiling = Math.max(matchedHit.startTime + Math.min(0.1, span * 0.5), exitCeiling);

        const scene = matchedParaIdx >= 0 ? engine.scenes?.get?.(matchedParaIdx) : null;
        const shotView = scene?.shots?.get?.(matchedHit.id);
        if (shotView?.segments) {
            let maxStart = matchedHit.startTime;
            let maxSettle = bestTime;
            for (const seg of shotView.segments) {
                if (!seg || seg.role === 'decoration') continue;
                for (const g of seg.glyphs || []) {
                    if (g?.isTextGlyph === false) continue;
                    if (Number.isFinite(g?.startTime) && g.startTime > maxStart) maxStart = g.startTime;
                    if (Number.isFinite(g?.settleTime) && g.settleTime > maxSettle) maxSettle = g.settleTime;
                }
            }
            const fullRevealMin = Math.min(matchedHit.endTime - 0.03, maxStart + 0.04);
            const settledTarget = Math.max(fullRevealMin, Math.min(exitCeiling, maxSettle + 0.02));
            const targetTime = Math.max(bestTime, settledTarget);
            if (Math.abs(targetTime - bestTime) > 0.01) {
                bestTime = targetTime;
                engine.renderAtTimeSync(bestTime);
            }
        }
    }
    return () => {
        suspended = prevSuspended;
        engine.renderAtTimeSync(audioTime());
        engine.setPaused(prevEnginePaused);
    };
}
