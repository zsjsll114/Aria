/* Portions ported from chthollyphile/folia-major (AGPL-3.0) — Copyright (c) chthollyphile and contributors. See THIRD_PARTY_NOTICES.md */
// temperaMode.js — 凝彩 · Tempera 模式接入层（folia tempera 复刻，独立于 sonnet/诗镜）。
// 引擎 = TemperaPixiRuntime（上游 createTemperaPixiRuntime 机械移植），懒加载 + 单例。
// 与 sonnetMode 同构：进入建引擎、切走挂起省 GPU、歌词/情感词变化热重建。

import { compileTemperaProgram } from './temperaProgram.js';
import { ensureWordColorContrast, luminanceOfColor } from './temperaPalette.js';
import { TemperaPixiRuntime } from './createTemperaPixiRuntime.js';
/* ★ 2026-10-11 纯音乐（无歌词 ⇒ 虚拟 ♪ 行）：判定与生成器与 verse 共用同一套纯逻辑
   —— 上游 VisualizerTempera.tsx:87-101 与 VisualizerSonnet.tsx:89-107 这段**逐字相同**，
   只差 id 前缀（tempera `virtual-block-` / sonnet `virtual-staff-`）。见该文件头。 */
import {
    buildVirtualInstrumentalLines, advanceInstrumental, instrumentalSongKey,
} from '../instrumentalLines.js';

/* ★ 2026-10-01 歌词基准字号倍率（主画面与预览共用；改动会触发单例重建生效）
   1.9→2.1：用户二轮反馈「还是太小」（此前他看到的可能是预览 404 假象，但宁可再大） */
const TEMPERA_LYRICS_FONT_SCALE = 2.1;

/* 上游 types.ts DEFAULT_TEMPERA_TUNING（1:1 数值） */
const DEFAULT_TEMPERA_TUNING = {
    cameraIntensity: 1,
    glyphMotion: 1,
    wholeLineLyrics: false,
    glyphSettleStretch: 0.5,
    colorMode: 'duo',
    showBlocks: true,
    showDecor: true,
    showCornerMarks: true,
    textInversion: true,
    layerImages: [],
    layerImageDepth: 'back',
    layerImageFrequency: 0.6,
    enableTransitions: true,
    textureResolution: 1.5,
    postProcessEnabled: true,
    postProcessTextureCompression: false,
    postProcessGrain: 0.2,
    postProcessContrast: 0,
    postProcessRgbShift: 0,
    postProcessVignette: 0.85,
    postProcessLensDistortion: 0.3,
};

let runtime = null;
let rafId = null;
let paused = false;
let lastLyricsRef = null;
let lastEmotionRef = null;
let swapping = false;
/* 纯音乐观察窗（空歌词 + 播放推进 ≥3s ⇒ 纯音乐，喂虚拟 ♪ 行）。按歌重置，
   语义与上游 songHandover.decideSongCommit 一致，见 instrumentalLines.js 头部。 */
let instrumentalState = { instrumental: false, watch: null };

/* MotionValue 等价物：runtime 每帧 renderFrame 读 currentTime.get()（秒） */
const currentTimeBox = {
    value: 0,
    get() { return this.value; },
};

function audioTime() {
    const audio = document.getElementById('audioPlayer');
    const baseMs = (audio ? audio.currentTime : 0) * 1000;
    const offset = typeof globalThis.lyricOffset === 'number' ? globalThis.lyricOffset : 0;
    return (baseMs + offset) / 1000;
}

function currentLyrics() {
    return (typeof globalThis.lyrics !== 'undefined' && Array.isArray(globalThis.lyrics))
        ? globalThis.lyrics : [];
}

function currentSongSeed() {
    const meta = (typeof globalThis !== 'undefined' && globalThis.currentSongData) || {};
    const stack = currentFontStack() || '';
    /* ★ 2026-10-11 纯音乐参与 seed：判定翻转必须让 seed 变化，否则下面的 swapSong 直通
       提交（`context.seed === runtime.songSeed`）——而**空歌词的数组引用可能整首歌不变**，
       靠引用分支永远不会重建。 */
    const instrumental = instrumentalState.instrumental ? '|inst' : '';
    /* 字体栈参与 seed：换字体 → seed 变化 → swapSong 真重建（否则同 seed 直通提交，
       场景里烘焙的旧字体不刷新） */
    return String(meta.mid || meta.id || meta.song || meta.title || 'aria-tempera')
        + '|' + (stack ? stack.length + ':' + stack.slice(0, 40) : 'default') + instrumental;
}

/* ★ Aria 行形状 → folia tempera 输入（2026-09-30）：
   folia 行契约 = { fullText, startTime, endTime, words:[{text,startTime,endTime}] }（秒制）。
   Aria 行时间是毫秒（parseLma 契约）、words 是秒（yrc）——与 sonnet 同一启发式：
   全集任一行 start≥1000 判毫秒，整体 ÷1000。 */
function normalizeTemperaLines(lines) {
    const isMs = lines.some(l => typeof l.start === 'number' && l.start >= 1000);
    const div = isMs ? 1000 : 1;
    return lines.map(l => {
        const words = Array.isArray(l.words) ? l.words : [];
        const fullText = l.original || l.text || words.map(w => w.text || '').join('');
        if (!fullText) return null;
        const startS = typeof l.start === 'number' ? l.start / div : 0;
        /* ★ 2026-10-02 首词消失根修：词级时间此前逐词用 `>= 1000` 猜毫秒——
           首词 <1s 开唱（如 800ms）不被除 1000 → start=800 秒，第一个字
           整首歌不可见（探针 glyph0 恒 vis:false 实锤），开头像「没有动画」。
           词级必须沿用行级的全集判定（div），禁止逐词猜。 */
        const normWords = words.map(w => {
            const ws = typeof w.start === 'number' ? w.start / div : startS;
            const we = typeof w.end === 'number' ? w.end / div : ws + 0.3;
            return {
                text: w.text || '',
                startTime: Math.max(ws, startS),
                endTime: Math.max(we, ws + 0.05),
            };
        }).filter(w => w.text.trim());
        const lastEnd = normWords.length ? Math.max(...normWords.map(w => w.endTime)) : startS + 4;
        return {
            fullText,
            text: fullText,
            startTime: startS,
            endTime: Math.max(lastEnd, startS + 0.5),
            words: normWords,
            isChorus: l.isChorus,
        };
    }).filter(Boolean);
}

function buildTheme() {
    const emotion = (typeof globalThis !== 'undefined' && Array.isArray(globalThis.aiEmotionWords))
        ? globalThis.aiEmotionWords : [];
    /* temperaPalette 消费四色：paper(backgroundColor)/ink(primaryColor)/accent/secondary。
       纸色随封面主色混黑派生（同 sonnet 背景策略），缺色会让 Pixi Color 抛
       「Unable to convert color undefined」。 */
    const cover = (typeof globalThis !== 'undefined' && globalThis.coverPalette) || {};
    /* ★ 2026-09-30 夜修「歌词和背景融为一体」：paper 用封面原色（中亮度）时，
       blockA/B= paper±55% 主题色全是中间调，文字反色（ink/paper 逐像素取对比高者）
       在中间调上没有赢家。paper 必须压到深色域：封面主色混 78% 黑保色相。 */
    const mixToBlack = (hex, ratio) => {
        const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
        if (!m) return '#111114';
        const n = parseInt(m[1], 16);
        const ch = (shift) => Math.round(((n >> shift) & 0xff) * (1 - ratio));
        return '#' + [16, 8, 0].map(shift => ch(shift).toString(16).padStart(2, '0')).join('');
    };
    const backgroundColor = mixToBlack(cover.primary || '#111114', 0.78);
    /* ★ 2026-10-02（用户实测「有的歌词与背景区分不开」）：情感词直涂绕过反色滤镜，
       明度贴近背景即隐身——按背景明度把词色推开 ≥96（保色相）。 */
    const bgLum = luminanceOfColor(backgroundColor);
    return {
        /* ★ 2026-10-11 修正非法枚举值：上游 `Theme.animationIntensity` 只有
           calm | normal | chaotic（见 src/types.ts）。此前写的是 'standard' ——
           它落不进任何一个分支，于是 multiply 恒为 1（效果上等于 normal，但值是错的，
           一旦以后有人按枚举做校验/序列化就会出问题）。 */
        animationIntensity: 'normal',
        backgroundColor,
        primaryColor: '#f4f4f5',
        /* ★ 2026-10-01 夜修「背景变黑白灰」：settings 面板的 highlightColor 默认值
           是 '#ffffff'（defaults 合并后必存在），直接覆盖会把 accent/blockA/tone ladder
           全部去饱和（palette.blockA = mix(paper, accent, 0.55)）——封面彩色全丢。
           白色是面板默认哨兵 = 未自定义，回落封面 accent；用户显式选的其它色才覆盖。 */
        accentColor: (temperaSettings && temperaSettings.highlightColor
            && temperaSettings.highlightColor !== '#ffffff')
            ? temperaSettings.highlightColor
            : (cover.accent || '#E8BE6A'),
        secondaryColor: cover.secondary || '#4a4e57',
        /* ★ 跟随全局字体设置（2026-09-30）：resolveThemeFontStack 把 theme.fontFamily
           前置到字体栈——与 sonnetMode 同款解析（含自定义字体 IndexedDB 注册） */
        fontFamily: currentFontStack(),
        wordColors: emotion.map(e => ({
            word: e.word,
            color: ensureWordColorContrast(e.color, bgLum),
        })).filter(e => e.word),
    };
}

/* ★ 2026-10-01 设置面板接入：modeSettings.tempera 落地
   （tuning 直通 + 字号倍率经重建生效） */
let temperaSettings = null;
let temperaRebuildTimer = null;
let lastAppliedFontStack = null;

export function applyTemperaSettings(settings) {
    if (!settings) return;
    /* ★ 2026-10-03 字体变更检测（修复「tempera 无法切换字体」）：字体在 buildSongContext
       时烘焙进 runtime.options.fontFamily，setTuning 覆盖不到——必须走重建，此前只有
       字号变化才重建。merge 前取旧值比较。 */
    const prevFont = temperaSettings ? temperaSettings.fontFamily : undefined;
    temperaSettings = { ...(temperaSettings || {}), ...settings };
    const nextStack = currentFontStack();
    const fontChanged = (settings.fontFamily !== undefined && settings.fontFamily !== prevFont)
        || Boolean(runtime && nextStack && lastAppliedFontStack && nextStack !== lastAppliedFontStack);
    if (typeof document !== 'undefined' && settings.highlightColor) {
        document.documentElement.style.setProperty('--tempera-accent', settings.highlightColor);
    }
    if (!runtime) return;
    const t = { ...runtime.options.tuning };
    ['textInversion', 'showBlocks', 'showDecor', 'showCornerMarks', 'enableTransitions'].forEach(k => {
        if (settings[k] !== undefined) t[k] = settings[k] !== false;
    });
    ['cameraIntensity', 'glyphMotion'].forEach(k => {
        const v = parseFloat(settings[k]);
        if (!Number.isNaN(v)) t[k] = v;
    });
    runtime.setTuning(t);
    /* 字号倍率 / 字体烘焙在 options/布局里：变化经去抖后销毁重建（setTuning 覆盖不了） */
    const scale = TEMPERA_LYRICS_FONT_SCALE * (parseFloat(settings.fontSize) || 1);
    if (fontChanged || runtime.options.lyricsFontScale !== scale) {
        clearTimeout(temperaRebuildTimer);
        temperaRebuildTimer = setTimeout(() => { destroyTemperaRuntime(); }, 280);
    }
}

/* Aria 全局字体 key → 真字体栈（window.resolveFontFamily 由 210-color-multilang 暴露）
   ★ 2026-10-03 修复「tempera 无法切换字体」：tempera 面板的字体项写在
   modeSettings.tempera.fontFamily（面板直通到 applyTemperaSettings），而此前只读
   全局 interface.fontFamily——两个字段不通，面板里换字体永不生效。现在优先用
   tempera 自己的值（'default' 是哨兵 = 跟随全局）。 */
function currentFontStack() {
    try {
        const localKey = (temperaSettings && temperaSettings.fontFamily) || null;
        const fontKey = (localKey && localKey !== 'default')
            ? localKey
            : ((typeof globalThis !== 'undefined' && globalThis.appSettings
                && globalThis.appSettings.interface && globalThis.appSettings.interface.fontFamily) || 'inherit');
        if (typeof window !== 'undefined' && typeof window.resolveFontFamily === 'function') {
            return window.resolveFontFamily(fontKey) || null;
        }
    } catch { /* 字体管理器未就绪 */ }
    return null;
}

function buildSongContext() {
    const meta = (typeof globalThis !== 'undefined' && globalThis.currentSongData) || {};
    /* ★ 2026-10-11 纯音乐：歌词为空且已确认纯音乐 ⇒ 用 60 条虚拟 ♪ 行
       （上游 VisualizerTempera.tsx:104 `committedLines.length > 0 ? committedLines : virtualLines`）。
       归一化（毫秒判定 / words 映射）由下面的 normalizeTemperaLines 照旧处理。 */
    const sourceLines = instrumentalState.instrumental
        ? buildVirtualInstrumentalLines('virtual-block-')
        : currentLyrics();
    const normLines = normalizeTemperaLines(sourceLines);
    const context = {
        seed: currentSongSeed(),
        program: compileTemperaProgram(normLines, 'tempera'),
        theme: buildTheme(),
        coverColors: (globalThis.coverPalette
            && [globalThis.coverPalette.primary, globalThis.coverPalette.secondary, globalThis.coverPalette.accent].filter(Boolean)) || [],
    };
    lastAppliedFontStack = (context.theme && context.theme.fontFamily) || null;
    return context;
}

/** 进入凝彩模式：懒建 runtime 并接上歌词。返回 Promise<runtime> */
export async function ensureTemperaRuntime(container) {
    /* ★ 2026-10-01 设置面板接入：首建时读入 modeSettings.tempera */
    if (!temperaSettings) {
        try {
            temperaSettings = (typeof globalThis !== 'undefined' && globalThis.appSettings
                && globalThis.appSettings.modeSettings
                && globalThis.appSettings.modeSettings.tempera) || null;
        } catch (e) { /* ignore */ }
    }
    const userFontScale = (temperaSettings && parseFloat(temperaSettings.fontSize)) || 1;
    const effFontScale = TEMPERA_LYRICS_FONT_SCALE * userFontScale;
    if (runtime) {
        /* ★ 2026-10-01 字号热更新：lyricsFontScale 在 create 时烘焙进 options，
           单例挂起/恢复不会重读——常量改动后旧 runtime 永远用旧字号
           （用户实测「改了没生效」的根因）。不一致就销毁重建。 */
        if (runtime.options && runtime.options.lyricsFontScale !== effFontScale) {
            destroyTemperaRuntime();
        } else {
            runtime.setPaused(false);
            paused = false;
            return runtime;
        }
    }
    const meta = (typeof globalThis !== 'undefined' && globalThis.currentSongData) || {};
    const context = buildSongContext();
    const tuning = { ...DEFAULT_TEMPERA_TUNING };
    if (temperaSettings) {
        ['textInversion', 'showBlocks', 'showDecor', 'showCornerMarks', 'enableTransitions'].forEach(k => {
            if (temperaSettings[k] !== undefined) tuning[k] = temperaSettings[k] !== false;
        });
        ['cameraIntensity', 'glyphMotion'].forEach(k => {
            const v = parseFloat(temperaSettings[k]);
            if (!Number.isNaN(v)) tuning[k] = v;
        });
    }
    runtime = await TemperaPixiRuntime.create({
        host: container,
        songSeed: context.seed,
        program: context.program,
        theme: context.theme,
        tuning,
        currentTime: currentTimeBox,
        lyricsFontScale: effFontScale,   /* ★ 2026-10-01 「歌词太小」：1.55→1.9 基准 × 用户倍率（配合布局 fit 下限 + 非 hero 词下限上调） */
        staticMode: false,
        paused: false,
        songTitle: meta.song || meta.title || null,
        songArtist: meta.singer || meta.artist || null,
        songAlbum: meta.album || null,
    });
    lastLyricsRef = currentLyrics();
    lastEmotionRef = globalThis.aiEmotionWords || null;
    if (typeof window !== 'undefined') {
        window.__temperaActive = true;
        /* ★ 调试口（2026-10-01）：主单例状态一目了然（探针/排障用） */
        window.__temperaDebug = () => {
            if (!runtime) return null;
            const scene = runtime.sceneCache.get(runtime.activeParagraphIndex)
                || [...runtime.sceneCache.values()][0] || null;
            const shot0 = scene && scene.shots[0];
            return {
                songSeed: runtime.songSeed,
                fontScale: runtime.options && runtime.options.lyricsFontScale,
                paraN: runtime.options && runtime.options.program ? runtime.options.program.paragraphs.length : null,
                activeIdx: runtime.activeParagraphIndex,
                scenes: [...runtime.sceneCache.keys()],
                lastErr: runtime._lastError,
                time: currentTimeBox.value,
                paused: runtime.options && runtime.options.paused,
                sceneVis: scene ? scene.container.visible : null,
                sceneAlpha: scene ? +scene.container.alpha.toFixed(2) : null,
                sceneXY: scene ? [Math.round(scene.container.x), Math.round(scene.container.y)] : null,
                shot0: shot0 ? {
                    vis: shot0.container.visible,
                    parked: !!shot0._parkedInPlace,
                    startTime: shot0.shot.startTime,
                    x: Math.round(shot0.container.x), y: Math.round(shot0.container.y),
                    alpha: +shot0.container.alpha.toFixed(2),
                    scale: +shot0.container.scale.x.toFixed(2),
                    glyph0: shot0.glyphs[0] ? {
                        vis: shot0.glyphs[0].display.visible,
                        alpha: +shot0.glyphs[0].display.alpha.toFixed(2),
                        sx: +shot0.glyphs[0].display.scale.x.toFixed(2),
                    } : null,
                    /* ★ 2026-10-02 开场动画探针：字形入场位移（display 相对 layout 基点） */
                    glyphOffsets: shot0.glyphs.slice(0, 6).map(g => ({
                        vis: g.display.visible,
                        alpha: +g.display.alpha.toFixed(2),
                        dx: Math.round(g.display.x - g.baseX),
                        dy: Math.round(g.display.y - g.baseY),
                        s: +g.display.scale.x.toFixed(2),
                        start: g.motion ? +g.motion.startTime.toFixed(2) : null,
                    })),
                } : null,
            };
        };
    }
    startTicker();
    if (typeof window !== 'undefined') {
        window.__temperaCtrl = { isRunning: isTemperaRunning, pause: suspendTemperaRuntime, resume: resumeTemperaRuntime };
    }
    return runtime;
}

function startTicker() {
    if (rafId !== null) return;
    const tick = () => {
        if (!runtime || paused) { rafId = null; return; }
        {
            const current = currentLyrics();
            if (current !== lastLyricsRef && !swapping) {
                lastLyricsRef = current;
                /* 换曲/歌词重解析：swapSong 两帧交接（确定性 seed 变化才真切换） */
                const context = buildSongContext();
                if (context.seed !== runtime.songSeed && typeof runtime.swapSong === 'function') {
                    swapping = true;
                    Promise.resolve(runtime.swapSong(context)).catch(() => {}).finally(() => { swapping = false; });
                }
            }
            /* ★ 2026-10-11 纯音乐（无歌词）：判定翻转时**显式走一次上面的 swapSong 交接**
               ——空歌词的数组引用可能整首歌都不变，引用分支永远不会触发；而翻转已写进
               currentSongSeed（`|inst`），所以这里的 seed 比对必然成立。 */
            const inst = advanceInstrumental(instrumentalState, {
                hasWords: current.length > 0,
                timeSec: audioTime(),
                songKey: instrumentalSongKey(),
            });
            const instFlipped = inst.instrumental !== instrumentalState.instrumental;
            instrumentalState = inst;
            if (instFlipped && !swapping && typeof runtime.swapSong === 'function') {
                const context = buildSongContext();
                if (context.seed !== runtime.songSeed) {
                    swapping = true;
                    Promise.resolve(runtime.swapSong(context)).catch(() => {}).finally(() => { swapping = false; });
                }
            }
            const emotion = (typeof globalThis !== 'undefined' && globalThis.aiEmotionWords) || null;
            if (emotion !== lastEmotionRef) {
                lastEmotionRef = emotion;
                /* AI 情感词更新：经 swapSong 重建 wordColors（theme 原地写回由 runtime 管理） */
                if (!swapping && typeof runtime.swapSong === 'function') {
                    const context = buildSongContext();
                    context.seed = currentSongSeed();
                    swapping = true;
                    Promise.resolve(runtime.swapSong(context)).catch(() => {}).finally(() => { swapping = false; });
                }
            }
            currentTimeBox.value = audioTime();
        }
        if (!paused) rafId = requestAnimationFrame(tick);
        else rafId = null;
    };
    rafId = requestAnimationFrame(tick);
}

/** 立即喂时间（主循环同路驱动备用） */
export function updateTemperaEngine(timeSec) {
    currentTimeBox.value = timeSec;
}

/** 切走时挂起：runtime 内部 app.stop()，场景与纹理缓存保留（切回秒恢复） */
export function suspendTemperaRuntime() {
    paused = true;
    if (rafId !== null) {
        try { cancelAnimationFrame(rafId); } catch { /* ignore */ }
        rafId = null;
    }
    if (runtime) {
        try { runtime.setPaused(true); } catch { /* ignore */ }
    }
}

/** 从后台节流恢复凝彩渲染循环 */
export function resumeTemperaRuntime() {
    if (!runtime) return;
    paused = false;
    try { runtime.setPaused(false); } catch { /* ignore */ }
    startTicker();
}

export function isTemperaRunning() {
    return !!(runtime && !paused);
}

/** 真正销毁（页面卸载/内存回收） */
export function destroyTemperaRuntime() {
    if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
    }
    if (runtime) {
        try { runtime.destroy(); } catch (e) { /* ignore */ }
        runtime = null;
    }
}

/**
 * 取当前 TemperaPixiRuntime 实例（只读）。
 * ★ 同 sonnetMode.getSonnetEngine：歌词海报要抓一帧真画面，而 Pixi 的 WebGL 画布
 *   在 `preserveDrawingBuffer:false` 下 `toDataURL()` 恒为空，必须「同一任务内先
 *   `renderer.render(stage)` 再立刻 `toDataURL()`」。调用方不得修改返回对象。
 */
export function getTemperaRuntime() {
    return runtime;
}

/**
 * 海报抓帧前将 版画(tempera) 渲染到当前（或指定）歌词行完全显形的保持瞬间。
 * @param {number} [targetLineIndex]
 * @returns {(() => void)|null}
 */
export function stageTemperaForPoster(targetLineIndex) {
    if (!runtime || runtime.destroyed || typeof runtime.renderOnce !== 'function') return null;
    const prevPaused = paused;
    let targetSec = currentTimeBox.value;
    const lines = currentLyrics();
    const isMs = lines.some((l) => l && typeof l.start === 'number' && l.start >= 1000);
    const div = isMs ? 1000 : 1;
    let line = (Number.isInteger(targetLineIndex) && targetLineIndex >= 0) ? lines[targetLineIndex] : null;
    if (!line && lines.length) {
        line = lines.find((l) => {
            const st = Number(l?.start ?? l?.time) / div;
            const ed = l?.end != null ? Number(l.end) / div : st + 3.0;
            return targetSec >= st && targetSec <= ed;
        }) || lines[Math.max(0, Math.min(lines.length - 1, Number(globalThis.activeLineIndex) || 0))];
    }
    let prevCtx = null;
    if (line && typeof runtime.commitSongContext === 'function') {
        const normSingle = normalizeTemperaLines([line]);
        if (normSingle.length) {
            const fullProg = compileTemperaProgram(normSingle, 'tempera-poster', { wholeLineLyrics: true });
            const shot0 = fullProg.paragraphs?.[0]?.shots?.[0] || null;
            if (shot0) {
                prevCtx = {
                    seed: runtime.songSeed,
                    program: runtime.options.program,
                    theme: runtime.options.theme,
                    coverColors: runtime.options.coverColors,
                };
                runtime.commitSongContext({
                    seed: 'tempera-poster-' + String(targetLineIndex ?? 'cur'),
                    program: fullProg,
                    theme: prevCtx.theme,
                    coverColors: prevCtx.coverColors,
                });
                const span = Math.max(0.2, shot0.endTime - shot0.startTime);
                targetSec = shot0.startTime + span * 0.72;
            }
        }
    }
    if (!prevCtx && line) {
        const st = Number(line.start ?? line.time) / div;
        const ed = line.end != null ? Number(line.end) / div : st + 3.0;
        const span = Math.max(0.2, ed - st);
        targetSec = st + span * 0.72;
    }
    paused = true;
    try { runtime.setPaused(true); } catch (e) { /* poster capture freeze */ }
    currentTimeBox.value = targetSec;
    try {
        runtime.renderOnce();
        let activeShot = null;
        if (runtime.sceneCache) {
            for (const sc of runtime.sceneCache.values()) {
                if (!sc || !Array.isArray(sc.shots)) continue;
                const hit = sc.shots.find((sh) => sh?.shot && targetSec >= sh.shot.startTime && targetSec <= sh.shot.endTime)
                    || (typeof sc.activeShotIndex === 'number' ? sc.shots[sc.activeShotIndex] : null);
                if (hit) {
                    activeShot = hit;
                    break;
                }
            }
        }
        if (activeShot && activeShot.shot) {
            let maxStart = activeShot.shot.startTime;
            for (const g of activeShot.glyphs || []) {
                const gst = g?.motion?.startTime;
                if (Number.isFinite(gst) && gst > maxStart) maxStart = gst;
            }
            const maxSettle = Number.isFinite(activeShot.revealDoneTime)
                ? Math.max(maxStart, activeShot.revealDoneTime)
                : maxStart;
            const safeEnd = Math.max(activeShot.shot.startTime + 0.05, activeShot.shot.endTime - 0.02);
            const betterSec = Math.max(targetSec, Math.min(safeEnd, Math.max(maxStart + 0.16, maxSettle + 0.02)));
            if (Math.abs(betterSec - targetSec) > 0.01) {
                currentTimeBox.value = betterSec;
                runtime.renderOnce();
            }
        }
    } catch (e) { /* poster capture render fallback */ }
    return () => {
        paused = prevPaused;
        if (prevCtx && !runtime.destroyed && typeof runtime.commitSongContext === 'function') {
            try { runtime.commitSongContext(prevCtx); } catch (e) { /* ignore */ }
        }
        currentTimeBox.value = audioTime();
        try {
            runtime.setPaused(prevPaused);
            if (!prevPaused) runtime.renderOnce();
        } catch (e) { /* ignore */ }
    };
}

/** 独立实例（设置页预览窗）：与主单例互不影响。返回 { setTime, setPaused, destroy } */export async function createDetachedTemperaRuntime(container, lyrics, meta = {}) {
    const box = { value: 0, get() { return this.value; } };
    const normLines = normalizeTemperaLines(lyrics || []);
    const rt = await TemperaPixiRuntime.create({
        host: container,
        songSeed: 'preview-' + String(meta.title || 'tempera'),
        program: compileTemperaProgram(normLines, 'tempera'),
        theme: buildTheme(),
        tuning: { ...DEFAULT_TEMPERA_TUNING },
        currentTime: box,
        lyricsFontScale: TEMPERA_LYRICS_FONT_SCALE,   /* ★ 2026-10-01 预览与主画面同字号（此前恒 1.0） */
        staticMode: false,
        paused: false,
        songTitle: meta.title || null,
        songArtist: meta.artist || null,
        songAlbum: meta.album || null,
    });
    return {
        runtime: rt,
        setTime(t) { box.value = t; },
        setPaused(p) { try { rt.setPaused(p); } catch (e) { /* ignore */ } },
        destroy() { try { rt.destroy(); } catch (e) { /* ignore */ } },
    };
}
