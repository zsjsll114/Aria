/**
 * sonnetMode.js — sonnet 视觉模式的引擎单例与驱动（M1）
 *
 * 对应 folia 的 VisualizerSonnet.tsx 宿主职责：Pixi 引擎懒加载（首次进入 sonnet
 * 模式才拉起 1.5MB 的 Pixi bundle）、rAF 时间驱动、切换模式的挂起/恢复。
 * 220-shortcuts-viewmode 的 switchView('sonnet') 分支通过动态 import 调用这里。
 */

import { SonnetEngine, deriveCoverBackground } from './SonnetEngine.js';
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
        /* ★ 2026-09-30：跟随全局字体设置（用户实测「没有跟随字体设置」）。
           pv.fontFamily 不存在时也强制用全局栈——文字视图烘焙进 TextStyle，
           必须显式传入，CSS 变量对 Pixi canvas 无效。 */
        if (engine) {
            const stack = currentFontStack();
            if (stack) engine.fontFamily = stack;
        }
    } catch { /* 设置形状异常不阻塞进入 */ }
}

function audioTime() {
    /* ★ 与 70 主循环同一公式（2026-09-29）：audio.currentTime*1000 + lyricOffset(毫秒)
       再 /1000 转秒——此前直接用 audio.currentTime（秒）但没加偏移，且与旧 PV 的
       ((currentTime + lyricOffset) / 1000) 公式不一致，歌词偏移在 sonnet 里不生效。 */
    const audio = document.getElementById('audioPlayer');
    const baseMs = (audio ? audio.currentTime : 0) * 1000;
    const offset = typeof globalThis.lyricOffset === 'number' ? globalThis.lyricOffset : 0;
    return (baseMs + offset) / 1000;
}

function tick() {
    if (!engine) { rafId = null; return; }
    /* ★ 2026-10-03 帧级异常不再中断 rAF（「verse 有时没有歌词」的兜底）：此前 tick 里
       任何异常（setLyrics 编译、场景构建、字体解析…）都会跳过末尾的
       requestAnimationFrame，rAF 链一断歌词就彻底不再更新且永不恢复。现在吞异常、
       记日志、保证调度继续——单帧失败下一帧自愈。 */
    try {
        tickBody();
    } catch (e) {
        logCatch('sonnetMode', e);
    }
    rafId = requestAnimationFrame(tick);
}

function tickBody() {
        const current = (typeof globalThis.lyrics !== 'undefined' && Array.isArray(globalThis.lyrics))
            ? globalThis.lyrics : null;
        if (current !== lastLyricsRef) {
            lastLyricsRef = current;
            engine.setLyrics(current || []);
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
            const stack = currentFontStack();
            if (stack && stack !== engine.fontFamily) {
                engine.fontFamily = stack;
                engine.invalidateScenes();
            }
        } catch { /* 字体管理器未就绪 */ }
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
    /* ★ 2026-10-03 幂等重启：此前只在 rafId === null 时启动——而 tick 内异常中断时
       rafId 会留下一个「非 null 的死 id」（旧代码的崩溃后遗症），此后再也不重启。
       现在先取消旧句柄再无条件调度，任何入口调用都能让渲染循环复活。 */
    if (rafId !== null) {
        try { cancelAnimationFrame(rafId); } catch { /* 句柄已失效 */ }
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
        };
        /* ★ 2026-09-29：全局字号档 1.25×——用户实测 support 词在全屏下偏小；
           2026-09-30 提到 1.4×（「默认焦距太小」反馈） */
        engine.lyricsFontScale = 1.4;
        applyStoredModeSettings();
        await engine.init();
    } else {
        container.appendChild(engine.canvas);
    }
    suspended = false;
    /* ★ 2026-10-01：suspend 时 app.stop() 了，恢复进入必须重启 ticker（配对 setPaused） */
    engine.setPaused(false);
    const current = (typeof globalThis.lyrics !== 'undefined' && Array.isArray(globalThis.lyrics))
        ? globalThis.lyrics : [];
    if (current !== lastLyricsRef) {
        lastLyricsRef = current;
        engine.setLyrics(current);
    }
    engine.update(audioTime());
    startTicker();
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
    /* ★ 2026-10-01 卡顿修复：此前只置模块 flag——engine 的 Pixi ticker 仍在每帧
       全屏渲染（见 SonnetEngine.setPaused 注释）。真正停掉 ticker。 */
    if (engine) engine.setPaused(true);
}

/** 真正销毁（页面卸载/内存回收） */
export function destroySonnetEngine() {
    if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
    }
    if (engine) {
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
