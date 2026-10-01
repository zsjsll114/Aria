// temperaMode.js — 凝彩 · Tempera 模式接入层（folia tempera 复刻，独立于 sonnet/诗镜）。
// 引擎 = TemperaPixiRuntime（上游 createTemperaPixiRuntime 机械移植），懒加载 + 单例。
// 与 sonnetMode 同构：进入建引擎、切走挂起省 GPU、歌词/情感词变化热重建。

import { compileTemperaProgram } from './temperaProgram.js';
import { ensureWordColorContrast, luminanceOfColor } from './temperaPalette.js';
import { TemperaPixiRuntime } from './createTemperaPixiRuntime.js';

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
    /* 字体栈参与 seed：换字体 → seed 变化 → swapSong 真重建（否则同 seed 直通提交，
       场景里烘焙的旧字体不刷新） */
    return String(meta.mid || meta.id || meta.song || meta.title || 'aria-tempera')
        + '|' + (stack ? stack.length + ':' + stack.slice(0, 40) : 'default');
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
        animationIntensity: 'standard',
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

export function applyTemperaSettings(settings) {
    if (!settings) return;
    temperaSettings = { ...(temperaSettings || {}), ...settings };
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
    /* 字号倍率烘焙在 options/布局里：变化经去抖后销毁重建（setTuning 覆盖不了字号） */
    const scale = TEMPERA_LYRICS_FONT_SCALE * (parseFloat(settings.fontSize) || 1);
    if (runtime.options.lyricsFontScale !== scale) {
        clearTimeout(temperaRebuildTimer);
        temperaRebuildTimer = setTimeout(() => { destroyTemperaRuntime(); }, 280);
    }
}

/* Aria 全局字体 key → 真字体栈（window.resolveFontFamily 由 210-color-multilang 暴露） */
function currentFontStack() {
    try {
        const fontKey = (typeof globalThis !== 'undefined' && globalThis.appSettings
            && globalThis.appSettings.interface && globalThis.appSettings.interface.fontFamily) || 'inherit';
        if (typeof window !== 'undefined' && typeof window.resolveFontFamily === 'function') {
            return window.resolveFontFamily(fontKey) || null;
        }
    } catch { /* 字体管理器未就绪 */ }
    return null;
}

function buildSongContext() {
    const meta = (typeof globalThis !== 'undefined' && globalThis.currentSongData) || {};
    const normLines = normalizeTemperaLines(currentLyrics());
    return {
        seed: currentSongSeed(),
        program: compileTemperaProgram(normLines, 'tempera'),
        theme: buildTheme(),
        coverColors: (globalThis.coverPalette
            && [globalThis.coverPalette.primary, globalThis.coverPalette.secondary, globalThis.coverPalette.accent].filter(Boolean)) || [],
    };
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
    return runtime;
}

function startTicker() {
    if (rafId !== null) return;
    const tick = () => {
        if (!runtime) { rafId = null; return; }
        if (!paused) {
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
        rafId = requestAnimationFrame(tick);
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
    if (runtime) {
        try { runtime.setPaused(true); } catch (e) { /* ignore */ }
    }
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

/** 独立实例（设置页预览窗）：与主单例互不影响。返回 { setTime, setPaused, destroy } */
export async function createDetachedTemperaRuntime(container, lyrics, meta = {}) {
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
