/**
 * PreviewEngine v4 — 设置面板外观预览引擎
 * - 逐字符拆分（所有行都有逐字效果）
 * - 无缝循环播放（句间无间隔，最后一句播完立即切到第一句）
 * - 播放器控件（播放/暂停、进度条）
 * - 禁用歌词行点击跳转
 * - 四种模式独立设置面板
 * - ★ 所有逐字歌词硬编码，不再从 API 获取
 * - ★ 设置改动同步到主播放器
 */
import { PVEngine } from './pvEngine/PVEngine.js';
import { TunnelEngine } from './tunnelEngine/TunnelEngine.js';
import { VisualizerManager } from './visualizers/VisualizerManager.js';
import { parseYrc } from '../parsers/yrcParser.js';
import { logInfo, logWarn, logError, logCatch } from '../services/log.js';

const global = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);

export function resolveFontFamily(fontKey, globalFontKey) {
    /* ★ 当选择"跟随字体设置"时，解析为全局字体设置 */
    if (!fontKey || fontKey === 'default' || fontKey === 'inherit') {
        if (globalFontKey && globalFontKey !== 'default' && globalFontKey !== 'inherit') {
            /* 递归解析全局字体（但避免无限递归） */
            return resolveFontFamilyInner(globalFontKey);
        }
        return "'Segoe UI', 'Microsoft YaHei', sans-serif";
    }
    return resolveFontFamilyInner(fontKey);
}

function resolveFontFamilyInner(fontKey) {
    if (!fontKey || fontKey === 'default' || fontKey === 'inherit') {
        return "'Segoe UI', 'Microsoft YaHei', sans-serif";
    }
    const cfList = (typeof window !== 'undefined' && window.customFonts) ? window.customFonts : (typeof globalThis !== 'undefined' && globalThis.customFonts ? globalThis.customFonts : {});
    if (cfList) {
        if (cfList[fontKey]) {
            const cf = cfList[fontKey];
            return `'${cf.family}', '${cf.label}', sans-serif`;
        }
        const match = Object.values(cfList).find(c => 
            c.key === fontKey || 
            c.family === fontKey || 
            c.label === fontKey || 
            c.fileName === fontKey ||
            (c.label && fontKey && c.label.toLowerCase() === fontKey.toLowerCase())
        );
        if (match) {
            return `'${match.family}', '${match.label}', sans-serif`;
        }
    }

    const FONT_MAP = {
        'default': "'Segoe UI', 'Microsoft YaHei', sans-serif",
        'serif': "'SimSun', 'Songti SC', 'STSong', serif",
        'kai': "'KaiTi', 'STKaiti', '楷体', serif",
        'hei': "'SimHei', 'Microsoft YaHei', 'STHeiti', '黑体', sans-serif",
        'fangsong': "'FangSong', 'STFangsong', '仿宋', serif",
        'mono': "'Consolas', 'Courier New', 'Microsoft YaHei', monospace"
    };
    if (FONT_MAP[fontKey]) return FONT_MAP[fontKey];
    if (fontKey.includes("'") || fontKey.includes(',') || fontKey.includes('sans-serif') || fontKey.includes('serif')) {
        return fontKey;
    }
    return `'${fontKey}', sans-serif`;
}

    /* ★ 硬编码所有语言的逐字歌词数据（无缝紧凑排布） */
    const FALLBACK_SONGS = [
        { lang: '英文', langCode: 'en', title: 'golden hour', artist: 'JVKE', target: "Sittin' in the car listening to the Blonde fallin' for each other", yrc: "[0,5500](0,500)Sittin'(500,200) in(700,300)the(1000,500) car(1500,1000)listening(2500,200)to(2700,400)the(3100,700)Blonde(3800,700)fallin'(4500,500)for(5000,500)each(5500,300)other", translation: '坐在车里听着金发乐队为彼此倾倒', romaji: '' },
        { lang: '日文', langCode: 'ja', title: 'Bad Apple!!', artist: 'nomico', target: '気だるさがほらグルグル廻って', yrc: '[5600,4400](5600,800)気(6400,1000)だるさが(7400,500)ほら(7900,1000)グルグル(8900,700)廻って', translation: '倦怠感看啊一圈圈转着', romaji: 'kidarusaga hora guruguru mawatte' },
        { lang: '韩文', langCode: 'ko', title: '나만 바라봐', artist: 'TAEYANG', target: '내가 기댈 곳은 너 하나뿐 이지만', yrc: '[10100,4900](10100,700)내가(10800,700)기댈(11500,500)곳은(12000,500)너(12500,1000)하나뿐(13500,600)이지만', translation: '我能依靠的地方只有你一个', romaji: '' },
        { lang: '中文', langCode: 'zh', title: '搁浅', artist: '周杰伦', target: '我拉着线复习你给的温柔', yrc: '[15100,4400](15100,500)我(15600,600)拉着(16200,400)线(16600,600)复习(17200,400)你(17600,500)给的(18100,1000)温柔', translation: '', romaji: '' },
        { lang: '葡萄牙语', langCode: 'pt', title: 'MONTAGEM XONADA', artist: 'DJ Javi26 / DJ Samir / MXZI', target: 'Eu vou viver a minha vida dançando', yrc: '[19600,5200](19600,300)Eu(19900,300)vou(20200,700)viver(20900,300)a(21200,700)minha(21900,1000)vida(22900,900)dançando(23800,1000)', translation: '我要过着我的生活跳舞', romaji: '' },
        { lang: '俄语', langCode: 'ru', title: "L'internationale", artist: 'Degeyter / Yakovlevich', target: 'Воспрянет род людской!', yrc: '[24900,4100](24900,1200)Воспрянет(26100,800)род(26900,1800)людской!', translation: '人类将奋起！', romaji: '' }
    ];
    const COVER_URL = 'https://y.qq.com/music/photo_new/T002R800x800M000002OR8wD3Lo3E5.jpg';

    /* ★ 用户原版播放/暂停 SVG 图标（精准 32x28 视口，完全居中且不裁切） */
    const PLAY_SVG = '<svg viewBox="0 0 32 28" width="18" height="16" fill="currentColor" style="display:block;margin:auto;"><path d="M10.345 23.287c.415 0 .763-.15 1.22-.407l12.742-7.404c.838-.481 1.178-.855 1.178-1.46 0-.599-.34-.972-1.178-1.462L11.565 5.158c-.457-.265-.805-.407-1.22-.407-.789 0-1.345.606-1.345 1.57V21.71c0 .971.556 1.577 1.345 1.577z" fill-rule="nonzero"></path></svg>';
    const PAUSE_SVG = '<svg viewBox="0 0 32 28" width="18" height="16" fill="currentColor" style="display:block;margin:auto;"><path d="M13.293 22.772c.955 0 1.436-.481 1.436-1.436V6.677c0-.98-.481-1.427-1.436-1.427h-2.457c-.954 0-1.436.473-1.436 1.427v14.66c-.008.954.473 1.435 1.436 1.435h2.457zm7.87 0c.954 0 1.427-.481 1.427-1.436V6.677c0-.98-.473-1.427-1.428-1.427h-2.465c-.955 0-1.428.473-1.428 1.427v14.66c0 .954.473 1.435 1.428 1.435h2.465z" fill-rule="nonzero"></path></svg>';

    class PreviewEngine {
        constructor(containerEl, appSettings) {
            this.container = containerEl;
            this.visManager = new VisualizerManager();
            this.lyrics = []; this.activeLineIndex = -1; this.currentMode = 'cover';
            this.startTime = 0; this.isPlaying = true; this.rafId = null;
            this.lineElements = []; this.wordElementsByLine = []; this.wordHighlightElementsByLine = [];
            this.wcCanvasW = 0; this.wcCanvasH = 0; this.wcCurrentX = 0; this.wcCurrentY = 0;
            this.wcCurrentScale = 1; this.wcLayoutDone = false;
            /* 词云相机优化：布局版本号 + 焦点坐标缓存（避免每帧强制布局） */
            this._wcLayoutVer = 0; this._wcCamCache = null; this._wcLayoutTimer = null;
            this._wcBumpedIdx = null;   /* 已做"字号上采样(真实放大)"的焦点行索引 */
            /* 总时长：无缝循环（最后一句结束时间 = 循环周期） */
            this.cycleDuration = 29500;
            /* ★ 从主播放器 appSettings 读取初始值 */
            this.appSettings = appSettings || {};
            const s = this.appSettings;
            const tc = (s.interface && s.interface.themeColor) || '#ffcc33';
            const ly = s.lyrics || {};
            const bg = s.background || {};
            const intf = s.interface || {};
            const ms = s.modeSettings || {};
            
            const globalFontKey = intf.fontFamily || 'default';
            /* ★ 辅助：将旧像素值迁移为倍率 (FONT_BASE = 24) */
            const migrateFontScale = (v, defaultVal) => {
                const n = parseFloat(v);
                if (isNaN(n) || n <= 0) return defaultVal;
                return n > 3 ? (n / 24) : n;
            };
            const getMS = (mode, key, fallback) => {
                const raw = (ms[mode] && ms[mode][key] !== undefined) ? ms[mode][key] : fallback;
                if (key === 'fontSize') return migrateFontScale(raw, fallback);
                return raw;
            };

            const defaultVisModeVar = (modeKey) => ({
                fontSize: getMS(modeKey, 'fontSize', 1.0),
                highlightColor: getMS(modeKey, 'highlightColor', '#ffffff'),
                themeColor: tc,
                graphicColor: getMS(modeKey, 'graphicColor', tc),
                bgColor: getMS(modeKey, 'bgColor', tc),
                showTranslation: getMS(modeKey, 'showTranslation', ly.showTranslation !== false),
                showRomaji: getMS(modeKey, 'showRomaji', ly.showRomaji !== false),
                fontFamily: getMS(modeKey, 'fontFamily', globalFontKey),
                emotionGlow: getMS(modeKey, 'emotionGlow', 10)
            });
            /* 模式独立设置（每个模式完全独立，包括背景/字体/情感发光） */
            this.modeVars = {
                cover: {
                    fontSize: getMS('cover', 'fontSize', 1.0),
                    blurLevel: getMS('cover', 'blurLevel', ly.blurLevel !== undefined ? ly.blurLevel : 2),
                    highlightColor: getMS('cover', 'highlightColor', ly.highlightColor || '#ffffff'),
                    highlightInactiveColor: getMS('cover', 'highlightInactiveColor', ly.highlightInactiveColor || 'rgba(255,255,255,0.6)'),
                    inactiveColor: getMS('cover', 'inactiveColor', ly.inactiveColor || 'rgba(255,255,255,0.4)'),
                    align: getMS('cover', 'align', ly.align || 'left'),
                    showTranslation: getMS('cover', 'showTranslation', ly.showTranslation !== false),
                    showRomaji: getMS('cover', 'showRomaji', ly.showRomaji !== false),
                    themeColor: tc,
                    bgBlur: getMS('cover', 'bgBlur', bg.blur !== undefined ? bg.blur : 60),
                    bgBrightness: getMS('cover', 'bgBrightness', bg.brightness !== undefined ? bg.brightness : 0.35),
                    swayEnabled: getMS('cover', 'swayEnabled', bg.swayEnabled !== false),
                    swayAmp: getMS('cover', 'swayAmp', bg.swayAmp || 12),
                    swayDuration: getMS('cover', 'swayDuration', bg.swayDuration || 16),
                    fontFamily: getMS('cover', 'fontFamily', globalFontKey),
                    emotionGlow: getMS('cover', 'emotionGlow', 10)
                },
                lyrics: {
                    fontSize: getMS('lyrics','fontSize', 1.0),
                    blurLevel: getMS('lyrics','blurLevel', 2),
                    highlightColor: getMS('lyrics','highlightColor', '#ffffff'),
                    highlightInactiveColor: getMS('lyrics','highlightInactiveColor', 'rgba(255,255,255,0.6)'),
                    inactiveColor: getMS('lyrics','inactiveColor', 'rgba(255,255,255,0.4)'),
                    align: getMS('lyrics','align', 'center'),
                    showTranslation: getMS('lyrics','showTranslation', ly.showTranslation !== false),
                    showRomaji: getMS('lyrics','showRomaji', ly.showRomaji !== false),
                    themeColor: tc,
                    bgBlur: getMS('lyrics','bgBlur', 60),
                    bgBrightness: getMS('lyrics','bgBrightness', 0.35),
                    swayEnabled: getMS('lyrics', 'swayEnabled', bg.swayEnabled !== false),
                    swayAmp: getMS('lyrics', 'swayAmp', bg.swayAmp || 12),
                    swayDuration: getMS('lyrics', 'swayDuration', bg.swayDuration || 16),
                    fontFamily: getMS('lyrics','fontFamily', globalFontKey),
                    emotionGlow: getMS('lyrics','emotionGlow', 10)
                },
                flyin: {
                    fontSize: getMS('flyin','fontSize', 1.0),
                    flyinTranslateY: getMS('flyin','flyinTranslateY', 16),
                    flyinScale: getMS('flyin','flyinScale', 0.85),
                    flyinGlow: getMS('flyin','flyinGlow', 8),
                    flyinTransSize: getMS('flyin','flyinTransSize', 14),
                    flyinTransBottom: getMS('flyin','flyinTransBottom', 16),
                    align: getMS('flyin','align', 'center'),
                    highlightColor: getMS('flyin','highlightColor', '#ffffff'),
                    showTranslation: getMS('flyin','showTranslation', ly.showTranslation !== false),
                    showRomaji: getMS('flyin','showRomaji', ly.showRomaji !== false),
                    themeColor: tc,
                    graphicColor: getMS('flyin', 'graphicColor', getMS('flyin', 'themeColor', tc)),
                    bgBlur: getMS('flyin','bgBlur', 80),
                    bgBrightness: getMS('flyin','bgBrightness', 0.12),
                    swayEnabled: getMS('flyin','swayEnabled', bg.swayEnabled !== false),
                    swayAmp: getMS('flyin','swayAmp', bg.swayAmp || 12),
                    swayDuration: getMS('flyin','swayDuration', bg.swayDuration || 16),
                    fontFamily: getMS('flyin','fontFamily', globalFontKey),
                    emotionGlow: getMS('flyin','emotionGlow', 10)
                },
                wordcloud: {
                    wcFontMin: getMS('wordcloud', 'wcFontMin', 1.2),
                    wcFontMax: getMS('wordcloud', 'wcFontMax', 4.5),
                    wcDensity: getMS('wordcloud', 'wcDensity', 18),
                    wcLerpFactor: getMS('wordcloud', 'wcLerpFactor', 0.04),
                    wcDimBlur: getMS('wordcloud', 'wcDimBlur', 6),
                    wcDimOpacity: getMS('wordcloud', 'wcDimOpacity', 0.15),
                    highlightColor: getMS('wordcloud', 'highlightColor', '#ffffff'),
                    showTranslation: getMS('wordcloud', 'showTranslation', ly.showTranslation !== false),
                    showRomaji: getMS('wordcloud', 'showRomaji', ly.showRomaji !== false),
                    themeColor: tc,
                    bgBlur: getMS('wordcloud', 'bgBlur', 80),
                    bgBrightness: getMS('wordcloud', 'bgBrightness', 0.10),
                    swayEnabled: getMS('wordcloud', 'swayEnabled', bg.swayEnabled !== false),
                    swayAmp: getMS('wordcloud', 'swayAmp', bg.swayAmp || 12),
                    swayDuration: getMS('wordcloud', 'swayDuration', bg.swayDuration || 16),
                    fontFamily: getMS('wordcloud', 'fontFamily', globalFontKey),
                    emotionGlow: getMS('wordcloud','emotionGlow', 10)
                },
                pv: {
                    fontSize: getMS('pv', 'fontSize', 1.5),
                    preset: getMS('pv', 'preset', 'dream'),
                    halftoneSize: getMS('pv', 'halftoneSize', 6),
                    cameraSpeed: getMS('pv', 'cameraSpeed', 1.0),
                    cameraZoom: getMS('pv', 'cameraZoom', 1.0),
                    showHud: getMS('pv', 'showHud', true),
                    showParticles: getMS('pv', 'showParticles', true),
                    showDecorations: getMS('pv', 'showDecorations', true),
                    aiColorSync: getMS('pv', 'aiColorSync', true),
                    highlightColor: getMS('pv', 'highlightColor', '#ffffff'),
                    showTranslation: getMS('pv', 'showTranslation', ly.showTranslation !== false),
                    showRomaji: getMS('pv', 'showRomaji', ly.showRomaji !== false),
                    themeColor: tc,
                    graphicColor: getMS('pv', 'graphicColor', getMS('pv', 'themeColor', tc)),
                    fontFamily: getMS('pv', 'fontFamily', globalFontKey),
                    emotionGlow: getMS('pv','emotionGlow', 10)
                },
                tunnel: {
                    fontSize: getMS('tunnel', 'fontSize', 1.1),
                    cameraSpeed: getMS('tunnel', 'cameraSpeed', 1.0),
                    cameraDamping: getMS('tunnel', 'cameraDamping', 0.045),
                    transitDuration: getMS('tunnel', 'transitDuration', 450),
                    rowGap: getMS('tunnel', 'rowGap', 90),
                    showStreaks: getMS('tunnel', 'showStreaks', true),
                    showEcho: getMS('tunnel', 'showEcho', true),
                    aiColorSync: getMS('tunnel', 'aiColorSync', true),
                    highlightColor: getMS('tunnel', 'highlightColor', '#ffffff'),
                    showTranslation: getMS('tunnel', 'showTranslation', ly.showTranslation !== false),
                    showRomaji: getMS('tunnel', 'showRomaji', ly.showRomaji !== false),
                    themeColor: tc,
                    graphicColor: getMS('tunnel', 'graphicColor', getMS('tunnel', 'themeColor', tc)),
                    fontFamily: getMS('tunnel', 'fontFamily', globalFontKey),
                    emotionGlow: getMS('tunnel','emotionGlow', 12)
                },
                dimension: defaultVisModeVar('dimension')
            };
            this.globalVars = { 
                glassStrength: (intf.glassStrength != null ? intf.glassStrength : 40),
                themeColor: tc
            };
            /* ★ 设置变更回调（同步到主播放器） */
            this.onSettingChange = null;
            this._blurStyleEl = null;
            this._swayStyleEl = null;
            this._emotionStyleEl = null;
        }

        async init() {
            this.buildDOM();
            this.applyAllVars();
            this.loadLyrics();
            this.updateCycleDuration();
            /* ★ 修复首次打开不显示：等待容器和歌词容器都有非零尺寸 */
            const waitForLayout = (maxRetries = 15) => new Promise(resolve => {
                let retries = 0;
                const check = () => {
                    const r = this.container.getBoundingClientRect();
                    const lc = this.lyricsContainerEl;
                    const lcR = lc ? lc.getBoundingClientRect() : { width: 0, height: 0 };
                    if (((r.width > 50 && r.height > 50 && lcR.width > 10 && lcR.height > 10)) || retries >= maxRetries) {
                        resolve();
                        return;
                    }
                    retries++;
                    requestAnimationFrame(check);
                };
                requestAnimationFrame(check);
            });
            await waitForLayout();
            this.setMode(this.currentMode || 'cover');
            this.start();

            if (typeof ResizeObserver !== 'undefined' && this.container) {
                this._resizeObserver = new ResizeObserver((entries) => {
                    for (const entry of entries) {
                        if (entry.contentRect.width > 50 && entry.contentRect.height > 50) {
                            if (this.currentMode === 'flyin') {
                                this.flyinAutoScaleFont();
                            } else if (this.currentMode === 'wordcloud' && (!this.wcLayoutDone || this.wcCanvasW === 0)) {
                                this.layoutWordCloud();
                            }
                        }
                    }
                });
                this._resizeObserver.observe(this.container);
            }

            /* ★ 多次延迟重渲染，覆盖面板动画展开的各种时序 */
            const reRender = () => {
                if (this.currentMode) {
                    this.setMode(this.currentMode);
                    this.update(this.lastTime || 0);
                }
            };
            setTimeout(reRender, 150);
            setTimeout(reRender, 300);
            setTimeout(reRender, 600);
        }

        /* ★ 加载硬编码歌词（不再从 API 获取） */
        loadLyrics() {
            const parser = (typeof parseYrc === 'function') ? parseYrc : (typeof window !== 'undefined' && typeof window.parseYrc === 'function' ? window.parseYrc : null);
            if (parser) {
                try {
                    this.lyrics = FALLBACK_SONGS.map(song => {
                        const p = parser(song.yrc);
                        if (p && p.length > 0) {
                            p[0].translation = song.translation || '';
                            p[0].romaji = song.romaji || '';
                            p[0].lang = song.lang;
                            p[0].langCode = song.langCode;
                            return p[0];
                        }
                        return null;
                    }).filter(Boolean);
                } catch (e) {
                    logWarn('previewEngine', '[PreviewEngine] 解析 YRC 异常，启用纯文本词级拆分回退:', e);
                }
            }

            // 兜底保障：若解析失败或 lyrics 为空，自动通过 target 文本生成逐字时间轴
            if (!this.lyrics || this.lyrics.length === 0) {
                let cumulativeTime = 0;
                this.lyrics = FALLBACK_SONGS.map(song => {
                    const chars = song.target.split('');
                    const dur = 5000;
                    const charDur = Math.floor(dur / Math.max(chars.length, 1));
                    const words = chars.map((ch, idx) => ({
                        text: ch,
                        start: cumulativeTime + idx * charDur,
                        end: cumulativeTime + (idx + 1) * charDur
                    }));
                    const lineObj = {
                        start: cumulativeTime,
                        duration: dur,
                        end: cumulativeTime + dur,
                        original: song.target,
                        translation: song.translation || '',
                        romaji: song.romaji || '',
                        lang: song.lang,
                        langCode: song.langCode,
                        words: words
                    };
                    cumulativeTime += dur + 500;
                    return lineObj;
                });
            }
        }

        buildDOM() {
            this.container.innerHTML = '';
            this._emotionStyleEl = null;
            this._blurStyleEl = null;
            this._swayStyleEl = null;
            const player = document.createElement('div');
            player.className = 'player-container preview-player view-cover';
            this.playerEl = player;

            const bg = document.createElement('div'); bg.className = 'blur-background preview-blur-bg visible'; bg.style.backgroundImage = `url('${COVER_URL}')`; bg.style.opacity = '1'; bg.style.zIndex = '0'; this.bgEl = bg;
            const overlay = document.createElement('div'); overlay.className = 'preview-dark-overlay'; overlay.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.15);backdrop-filter:blur(8px) saturate(140%);-webkit-backdrop-filter:blur(8px) saturate(140%);z-index:0;pointer-events:none;';

            const coverArea = document.createElement('div'); coverArea.className = 'cover-area preview-cover-area';
            const cover = document.createElement('img'); cover.className = 'song-cover preview-cover'; cover.src = COVER_URL; cover.style.objectFit = 'cover'; coverArea.appendChild(cover); this.coverEl = cover;

            const lyricsContainer = document.createElement('div'); lyricsContainer.className = 'lyrics-container preview-lyrics-container';
            const scrollEl = document.createElement('div'); scrollEl.className = 'scroll-container preview-lyrics-scroll'; scrollEl.id = 'previewLyricsScroll';
            lyricsContainer.appendChild(scrollEl); this.scrollEl = scrollEl; this.lyricsContainerEl = lyricsContainer;

            const flyinArea = document.createElement('div'); flyinArea.className = 'flyin-translation-area preview-flyin-trans-area'; flyinArea.id = 'previewFlyinTransArea';
            const flyinTrans = document.createElement('div'); flyinTrans.className = 'flyin-translation-text preview-flyin-trans'; flyinTrans.id = 'previewFlyinTrans';
            const flyinRoma = document.createElement('div'); flyinRoma.className = 'flyin-romaji-text preview-flyin-roma'; flyinRoma.id = 'previewFlyinRoma';
            flyinArea.appendChild(flyinTrans); flyinArea.appendChild(flyinRoma);

            const wireframes = document.createElement('div'); wireframes.className = 'view-flyin-wireframes preview-wireframes';
            wireframes.innerHTML = '<svg class="wf-svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" /><circle cx="50" cy="50" r="30" /><circle cx="50" cy="50" r="15" /></svg><svg class="wf-svg" viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" rx="8" /><rect x="25" y="25" width="50" height="50" rx="4" /></svg><svg class="wf-svg" viewBox="0 0 100 100"><polygon points="50,10 90,90 10,90" /><polygon points="50,30 75,80 25,80" /></svg><svg class="wf-svg" viewBox="0 0 100 100"><path d="M10,50 Q50,10 90,50 Q50,90 10,50 Z" /><path d="M25,50 Q50,25 75,50 Q50,75 25,50 Z" /></svg><svg class="wf-svg" viewBox="0 0 100 100"><polygon points="50,5 95,50 50,95 5,50" /><polygon points="50,25 75,50 50,75 25,50" /></svg><svg class="wf-svg" viewBox="0 0 100 100"><polygon points="50,5 89,27 89,73 50,95 11,73 11,27" /></svg>';
            this.wireframesEl = wireframes;

            /* ★ 播放器控件栏 — 移除前后按钮，只保留播放/暂停 + 进度条 */
            const controlsBar = document.createElement('div');
            controlsBar.className = 'preview-controls-bar';
            controlsBar.innerHTML = `
                <button class="preview-ctrl-btn preview-play-btn" id="previewPlayBtn" title="播放/暂停">${PAUSE_SVG}</button>
                <div class="preview-progress-wrap">
                    <div class="preview-progress-bar" id="previewProgressBar"><div class="preview-progress-fill" id="previewProgressFill"></div><div class="preview-progress-thumb" id="previewProgressThumb"></div></div>
                </div>
                <span class="preview-time" id="previewTime">0:00 / 0:00</span>
            `;
            this.controlsBar = controlsBar;

            player.appendChild(bg); player.appendChild(overlay); player.appendChild(wireframes); player.appendChild(coverArea); player.appendChild(lyricsContainer); player.appendChild(flyinArea); player.appendChild(controlsBar);
            this.container.appendChild(player);
            this.bindControlEvents();
        }

        bindControlEvents() {
            document.getElementById('previewPlayBtn')?.addEventListener('click', () => this.togglePlay());
            const bar = document.getElementById('previewProgressBar');
            if (bar) {
                /* ★ 点击进度条跳转（暂停时也能立即跳转） */
                const seekFromEvent = (e) => {
                    const rect = bar.getBoundingClientRect();
                    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                    this.seekTo(pct * this.cycleDuration);
                };
                bar.addEventListener('click', seekFromEvent);
                /* ★ 拖拽进度条 */
                let isDragging = false;
                bar.addEventListener('mousedown', (e) => { isDragging = true; seekFromEvent(e); });
                document.addEventListener('mousemove', (e) => { if (isDragging) seekFromEvent(e); });
                document.addEventListener('mouseup', () => { isDragging = false; });
            }
        }

        /* ★ 修复：播放时显示暂停图标，暂停时显示播放图标 */
        togglePlay() {
            this.isPlaying = !this.isPlaying;
            this.updatePlayIcon();
            if (this.isPlaying) {
                this.startTime = performance.now() - (this.lastTime || 0);
                this.loop();
            }
        }

        /* ★ 更新播放按钮图标 */
        updatePlayIcon() {
            const btn = document.getElementById('previewPlayBtn');
            if (btn) btn.innerHTML = this.isPlaying ? PAUSE_SVG : PLAY_SVG;
        }

        /* ★ 修复：seekTo 不修改播放状态，只更新时间和显示 */
        seekTo(t) {
            this.lastTime = t;
            this.startTime = performance.now() - t;
            this.update(t);
            this.updateControls(t);
        }

        updateCycleDuration() {
            if (this.lyrics.length > 0) {
                const last = this.lyrics[this.lyrics.length - 1];
                this.cycleDuration = last.end + 200;
            }
        }

        /* ========== 渲染（所有行逐字拆分） ========== */
        render() {
            if (!this.scrollEl) return;
            if (!this.lyrics || this.lyrics.length === 0) {
                this.loadLyrics();
            }
            if (!this.lyrics || this.lyrics.length === 0) return;

            // 确保当前模式下的容器与滚动层可见性
            const isVisualizerMode = this.currentMode === 'pv' || this.currentMode === 'tunnel' || (this.visManager && this.visManager.has(this.currentMode));
            if (this.scrollEl) {
                this.scrollEl.style.display = isVisualizerMode ? 'none' : '';
            }
            if (this.lyricsContainerEl) {
                this.lyricsContainerEl.style.display = (this.currentMode === 'pv' || this.currentMode === 'tunnel') ? 'none' : '';
            }

            this.activeLineIndex = -1; /* 强制重置当前行索引，确保后续 update 能正确为新 DOM 节点挂载 .active 类 */
            this.scrollEl.innerHTML = ''; this.lineElements = []; this.wordElementsByLine = []; this.wordHighlightElementsByLine = [];
            if (this.currentMode === 'wordcloud') { this.scrollEl.style.width = ''; this.scrollEl.style.height = ''; }

            const RTL_RE = /[\u0590-\u05ff\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb1d-\ufbff\ufb50-\ufdff\ufe70-\ufeff]/u;
            const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff]/u;
            const isFlyin = this.currentMode === 'flyin';
            const isWordcloud = this.currentMode === 'wordcloud';
            /* ★ 飞入模式微动画：仅旋转角度，无字符偏移（与主播放器一致） */
            const microPatterns = [{ y: '0px', r: '1.5deg', s: '1' }, { y: '0px', r: '-1deg', s: '1' }, { y: '0px', r: '2deg', s: '1' }];
            const vars = this.modeVars[this.currentMode] || this.modeVars.cover;
            const align = vars.align || 'left';
            const transformOrigin = align === 'left' ? 'left center'
                                  : align === 'right' ? 'right center'
                                  : 'center center';
            const showTrans = vars.showTranslation !== false;
            const showRoma = vars.showRomaji !== false;

            /* 预设多语言情感词及其高亮色彩映射表，便于直观调试 */
            const EMOTION_SAMPLE_MAP = {
                'golden': '#ffd700',
                'blonde': '#ff5c7c',
                'fallin': '#ff9100',
                'sittin': '#ff5c7c',
                '気': '#00e5ff',
                'だるさ': '#00e5ff',
                'だるさが': '#00e5ff',
                'グルグル': '#00e5ff',
                '廻って': '#00e676',
                '기댈': '#ff5c7c',
                '하나뿐': '#ffd700',
                '내가': '#00e676',
                '线': '#00e5ff',
                '温柔': '#e040fb',
                '拉着': '#ff9100',
                '我': '#ff5c7c',
                'vida': '#00e676',
                'dançando': '#ff9100',
                'воспрянет': '#ffd700',
                'людской': '#ff5c7c'
            };

            for (let i = 0; i < this.lyrics.length; i++) {
                const line = this.lyrics[i];
                const lineEl = document.createElement('div');
                lineEl.className = 'line preview-line'; lineEl.style.textAlign = align;
                lineEl.dataset.index = i; lineEl.dataset.start = line.start;
                lineEl.style.pointerEvents = 'none'; lineEl.style.cursor = 'default';
                lineEl.style.overflow = 'visible';

                const originalEl = document.createElement('div');
                originalEl.className = 'lrc-original preview-lrc-original';
                originalEl.style.textAlign = align;
                originalEl.style.transformOrigin = transformOrigin;
                originalEl.style.overflow = 'visible';

                if (line.words && line.words.length > 0) {
                    const wordsContainer = document.createElement('div');
                    wordsContainer.className = 'words-container preview-words-container'; wordsContainer.style.textAlign = align;
                    wordsContainer.style.overflow = 'visible';
                    let lineHasRTL = false; let gci = 0;

                    for (let j = 0; j < line.words.length; j++) {
                        const word = line.words[j];
                        const lowerWord = (word.text || '').toLowerCase();
                        let isEmotionWord = false;
                        let emotionColor = null;
                        for (const [kw, col] of Object.entries(EMOTION_SAMPLE_MAP)) {
                            if (lowerWord.includes(kw.toLowerCase())) {
                                isEmotionWord = true;
                                emotionColor = col;
                                break;
                            }
                        }

                        const isLatin = !CJK_RE.test(word.text) && /^[\p{L}\p{M}\p{N}\s\p{P}\p{S}]+$/u.test(word.text) && /[\p{L}]/u.test(word.text);
                        const isRTL = RTL_RE.test(word.text); if (isRTL) lineHasRTL = true;
                        /* ★ 飞入模式逐字符已有数据内嵌空格，避免插入额外空格造成双倍间距 */
                        if (isLatin && j > 0 && !isFlyin) { const sp = document.createElement('span'); sp.style.display = 'inline'; sp.style.position = 'relative'; sp.textContent = ' '; wordsContainer.appendChild(sp); }
                        const ccAll = word.text.length, dur = word.end - word.start;
                        /* ★ 词首/词尾空白剥离为独立占位 span（与主播放器一致）：
                           flex 下纯空白字符元素会折叠成 0 宽，导致飞入英文词间距丢失 */
                        const leadingWs = (word.text.match(/^[\s\u00a0]+/) || [''])[0];
                        const trailingWs = (word.text.match(/[\s\u00a0]+$/) || [''])[0];
                        const coreText = word.text.slice(leadingWs.length, word.text.length - trailingWs.length);
                        const isWsOnly = coreText.length === 0;
                        const cc = Math.max(1, coreText.length);

                        if (isRTL && !isFlyin) {
                            const we = document.createElement('span'); we.className = 'word preview-word' + (isEmotionWord ? ' word-emotion' : '');
                            we.style.cssText = 'position:relative;display:inline-block;direction:rtl;white-space:nowrap;overflow:visible;';
                            if (isEmotionWord && emotionColor) we.style.setProperty('--emotion-color', emotionColor);
                            const hl = document.createElement('span'); hl.className = 'word-highlight rtl-highlight preview-word-highlight'; hl.style.cssText = 'left:auto;right:0;direction:rtl;'; hl.textContent = word.text;
                            const te = document.createElement('span'); te.style.cssText = 'position:relative;z-index:0;direction:rtl;'; te.textContent = word.text;
                            we.appendChild(hl); we.appendChild(te); we.dataset.start = word.start; we.dataset.end = word.end;
                            wordsContainer.appendChild(we);
                            if (!this.wordElementsByLine[i]) this.wordElementsByLine[i] = [];
                            if (!this.wordHighlightElementsByLine[i]) this.wordHighlightElementsByLine[i] = [];
                            this.wordElementsByLine[i].push(we); this.wordHighlightElementsByLine[i].push(hl);
                        } else {
                            /* ★ 预览飞入模式必须逐字符飞入（与主播放器一致）；
                               词云模式保留英文整词上采样。 */
                            const wholeMode = isWordcloud && isLatin && !isRTL;
                            const core = wholeMode ? coreText : '';
                            if (wholeMode && core.length > 0 && core.length <= 10) {
                                const we = document.createElement('span'); we.className = 'word preview-word' + (isEmotionWord ? ' word-emotion' : '');
                                if (isLatin) we.classList.add('word-latin');
                                we.style.cssText = 'position:relative;display:inline-block;white-space:nowrap;overflow:visible;';
                                if (isEmotionWord && emotionColor) we.style.setProperty('--emotion-color', emotionColor);
                                const hl = document.createElement('span'); hl.className = 'word-highlight preview-word-highlight';
                                if (isLatin) hl.classList.add('word-highlight-latin');
                                hl.textContent = core;
                                const te = document.createElement('span'); te.style.cssText = 'position:relative;z-index:0;'; te.textContent = core;
                                we.appendChild(hl); we.appendChild(te); we.dataset.start = word.start; we.dataset.end = word.end;
                                wordsContainer.appendChild(we);
                                if (!this.wordElementsByLine[i]) this.wordElementsByLine[i] = [];
                                if (!this.wordHighlightElementsByLine[i]) this.wordHighlightElementsByLine[i] = [];
                                this.wordElementsByLine[i].push(we); this.wordHighlightElementsByLine[i].push(hl);
                                continue;
                            }
                            const cd = dur / cc; const uww = !(isRTL && isFlyin);
                            const ww = uww ? document.createElement('span') : null;
                            if (ww) { ww.style.cssText = 'display:inline-block;white-space:nowrap;position:relative;overflow:visible;'; if (isRTL) ww.style.direction = 'rtl'; }
                            /* 纯空白词：整段空白以占位 span 输出，不产生字符元素 */
                            if (isWsOnly) {
                                const ge = document.createElement('span'); ge.style.whiteSpace = 'pre'; ge.style.display = 'inline-block'; ge.textContent = word.text;
                                if (ww) ww.appendChild(ge); else wordsContainer.appendChild(ge);
                                if (ww) wordsContainer.appendChild(ww);
                                continue;
                            }
                            /* 前导空白占位（追加进 ww 起点，保持词间距） */
                            if (leadingWs) {
                                const ge = document.createElement('span'); ge.style.whiteSpace = 'pre'; ge.style.display = 'inline-block'; ge.textContent = leadingWs;
                                if (ww) ww.appendChild(ge); else wordsContainer.appendChild(ge);
                            }
                            for (let c = 0; c < cc; c++) {
                                const cs = Math.round(word.start + c * cd), ce = Math.round(word.start + (c + 1) * cd);
                                const we = document.createElement('span'); we.className = 'word preview-word' + (isEmotionWord ? ' word-emotion' : '');
                                if (isLatin) we.classList.add('word-latin');
                                if (isRTL) we.classList.add('word-rtl-char');
                                we.style.cssText = 'position:relative;display:inline-block;overflow:visible;';
                                if (isEmotionWord && emotionColor) we.style.setProperty('--emotion-color', emotionColor);
                                if (isFlyin) { const mc = microPatterns[gci % 3]; we.style.setProperty('--micro-y', mc.y); we.style.setProperty('--micro-r', mc.r); we.style.setProperty('--micro-s', mc.s); gci++; }
                                const hl = document.createElement('span'); hl.className = 'word-highlight preview-word-highlight';
                                if (isLatin) hl.classList.add('word-highlight-latin');
                                if (isRTL) hl.classList.add('rtl-highlight');
                                hl.textContent = coreText[c];
                                const te = document.createElement('span'); te.style.cssText = 'position:relative;z-index:0;'; te.textContent = coreText[c];
                                we.appendChild(hl); we.appendChild(te); we.dataset.start = cs; we.dataset.end = ce;
                                if (ww) ww.appendChild(we); else wordsContainer.appendChild(we);
                                if (!this.wordElementsByLine[i]) this.wordElementsByLine[i] = [];
                                if (!this.wordHighlightElementsByLine[i]) this.wordHighlightElementsByLine[i] = [];
                                this.wordElementsByLine[i].push(we); this.wordHighlightElementsByLine[i].push(hl);
                            }
                            /* 尾随空白占位（追加进 ww 末尾，保持词间距） */
                            if (trailingWs) {
                                const ge = document.createElement('span'); ge.style.whiteSpace = 'pre'; ge.style.display = 'inline-block'; ge.textContent = trailingWs;
                                if (ww) ww.appendChild(ge); else wordsContainer.appendChild(ge);
                            }
                            if (ww) wordsContainer.appendChild(ww);
                        }
                    }
                    if (lineHasRTL) wordsContainer.style.direction = 'rtl';
                    originalEl.appendChild(wordsContainer);
                } else if (line.original) { originalEl.textContent = line.original; }

                /* ★ 按行语言标记：与主播放器一致，中日共享 CJK 码位时整行统一字体 */
                if (typeof window !== 'undefined' && Aria.__detectLineLang) {
                    const llText = line.words ? line.words.map(w => w.text || '').join('') : (line.original || line.text || '');
                    const ll = Aria.__detectLineLang(llText);
                    if (ll) { originalEl.dataset.lineLang = ll; } else { originalEl.removeAttribute('data-line-lang'); }
                }

                lineEl.appendChild(originalEl);

                if (showTrans && line.translation && line.translation.trim() !== '//') {
                    const te = document.createElement('div');
                    te.className = 'lrc-translation preview-lrc-translation';
                    te.style.textAlign = align;
                    te.style.transformOrigin = transformOrigin;
                    te.textContent = line.translation;
                    lineEl.appendChild(te);
                }
                if (showRoma && line.romaji && line.romaji.trim()) {
                    const re = document.createElement('div');
                    re.className = 'lrc-romaji preview-lrc-romaji';
                    re.style.textAlign = align;
                    re.style.transformOrigin = transformOrigin;
                    re.textContent = line.romaji;
                    lineEl.appendChild(re);
                }

                this.scrollEl.appendChild(lineEl); this.lineElements.push(lineEl);
            }

            if (this.currentMode === 'wordcloud') { this.scrollEl.style.transition = 'none'; setTimeout(() => this.layoutWordCloud(), 60); }
            else if (this.currentMode === 'flyin') { this.scrollEl.style.transition = 'none'; this.scrollEl.style.transform = 'none'; }
            else if (this.currentMode === 'pv') { this.scrollEl.style.transition = 'none'; this.scrollEl.style.transform = 'none'; }
            else { this.scrollEl.style.width = ''; this.scrollEl.style.height = ''; this.scrollEl.style.transition = 'transform 0.5s cubic-bezier(0.15,0.85,0.25,1)'; this.scrollEl.style.transform = 'translateY(0px)'; }

            this.activeLineIndex = -1; this.updateLineBlur();
            this.applyModeVars();
        }

        updateLineBlur() { const a = this.activeLineIndex; for (let i = 0; i < this.lineElements.length; i++) { const el = this.lineElements[i]; const d = Math.abs(i - a); el.classList.remove('blur-d0','blur-d1','blur-d2','blur-d3','blur-d4','blur-d5','blur-d6','blur-d7','blur-d8'); if (a < 0) { el.classList.add('blur-d4'); continue; } if (d <= 8) el.classList.add('blur-d' + d); else el.classList.add('blur-d8'); } }

        layoutWordCloud() {
            const c = this.lyricsContainerEl;
            if (!c) return;
            const vw = c.clientWidth, vh = c.clientHeight;
            if (vw === 0 || vh === 0) return;
            this.wcCanvasW = Math.max(vw * 4, 2400);
            this.wcCanvasH = Math.max(vh * 4, 2400);
            this.scrollEl.style.width = this.wcCanvasW + 'px';
            this.scrollEl.style.height = this.wcCanvasH + 'px';
            /* ★ 缓存视口尺寸供相机每帧使用，避免每帧读取 clientWidth 触发同步布局 */
            this._wcViewW = vw; this._wcViewH = vh;
            const placed = [], cx = this.wcCanvasW / 2, cy = this.wcCanvasH / 2;
            /* 确定性随机数生成器（固定种子，保证每次布局结果一致） */
            let seed = 42;
            const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
            const v = this.modeVars.wordcloud;
            const pad = parseFloat(v.wcDensity) || 24;
            /* ★ 使用 parseFloat 确保 fmin/fmax 是数字，单位改为 px 避免 rem 受根字号影响 */
            const WC_BASE_PX = 16;
            const fmin = parseFloat(v.wcFontMin);
            const fmax = parseFloat(v.wcFontMax);
            const minRem = (isNaN(fmin) ? 1.2 : fmin);
            const maxRem = (isNaN(fmax) ? 4.5 : fmax);
            const n = this.lineElements.length;
            /* ★ 批量读写分离（消除布局抖动）：
               阶段1 批量写入字号（行内随机字号存 rem，供相机按 rem 语义计算缩放） */
            for (let i = 0; i < n; i++) {
                const el = this.lineElements[i];
                const fr = minRem + rand() * Math.max(0.1, maxRem - minRem);
                el.style.fontSize = (fr * WC_BASE_PX) + 'px';
                el.dataset.wcFontSize = fr.toFixed(2);
                el.style.left = '0px';
                el.style.top = '0px';
            }
            /* 阶段2：一次性读取全部行尺寸（首个读取触发唯一一次重排，其余命中布局缓存；
               此前逐行"写字号→读尺寸"交替执行会导致 N 次强制同步布局，滑块拖动卡顿的根因） */
            const dims = new Array(n);
            for (let i = 0; i < n; i++) {
                const el = this.lineElements[i];
                dims[i] = { w: el.offsetWidth, h: el.offsetHeight };
            }
            /* 阶段3：纯计算放置（螺旋碰撞检测 + 网格兜底），随后批量写回位置 */
            for (let i = 0; i < n; i++) {
                const el = this.lineElements[i];
                const w = dims[i].w, h = dims[i].h;
                if (w === 0 || h === 0) continue;
                /* 螺旋碰撞检测：从中心向外旋转搜索可用位置 */
                let ok = false, ang = rand() * Math.PI * 2, rad = 0;
                let px = 0, py = 0;
                for (let it = 0; it < 3000; it++) {
                    const x = cx + rad * Math.cos(ang) - w / 2, y = cy + rad * Math.sin(ang) - h / 2;
                    if (x < pad || y < pad || x + w + pad > this.wcCanvasW || y + h + pad > this.wcCanvasH) {
                        ang += 0.35; rad += 4;
                        if (rad > Math.max(this.wcCanvasW, this.wcCanvasH)) break;
                        continue;
                    }
                    let col = false;
                    for (let p = 0; p < placed.length; p++) {
                        const b = placed[p];
                        if (x - pad < b.x + b.w && x + w > b.x - pad && y - pad < b.y + b.h && y + h > b.y - pad) {
                            col = true; break;
                        }
                    }
                    if (!col) { px = x; py = y; ok = true; break; }
                    ang += 0.35;
                    if (ang > Math.PI * 2) { ang -= Math.PI * 2; rad += pad; }
                }
                /* 兜底：螺旋搜索失败后网格扫描放置（仍做碰撞检测） */
                if (!ok) {
                    px = pad; py = pad;
                    let found = false;
                    for (let ty = pad; ty < this.wcCanvasH - h - pad; ty += h + pad) {
                        for (let tx = pad; tx < this.wcCanvasW - w - pad; tx += w + pad) {
                            let col = false;
                            for (let p = 0; p < placed.length; p++) {
                                const b = placed[p];
                                if (tx - pad < b.x + b.w && tx + w > b.x - pad && ty - pad < b.y + b.h && ty + h > b.y - pad) {
                                    col = true; break;
                                }
                            }
                            if (!col) { px = tx; py = ty; found = true; break; }
                        }
                        if (found) break;
                    }
                }
                el.style.left = px + 'px';
                el.style.top = py + 'px';
                placed.push({ x: px, y: py, w, h });
            }
            this.wcLayoutDone = true;
            this._wcLayoutVer++; this._wcCamCache = null;
            this._wcTween = null; this._wcFocusEl = null; this._wcFocusSeq = 0;
            this._wcBumpedIdx = null;   /* 布局已重建，旧焦点行引用失效 */
            this.wcCurrentX = vw / 2 - this.wcCanvasW / 2;
            this.wcCurrentY = vh / 2 - this.wcCanvasH / 2;
            this.wcCurrentScale = 1;
            this._wcLastTransform = '';   /* 重布局后强制下一帧重写 transform */
            this.scrollEl.style.transform = `translate(${this.wcCurrentX}px,${this.wcCurrentY}px) scale(1)`;
        }

        updateWordcloudCamera() {
            if (this.activeLineIndex < 0) return;
            const c = this.lyricsContainerEl;
            if (!c || !this.scrollEl) return;
            /* ★ 使用布局时缓存的视口尺寸，避免每帧读取 clientWidth/Height */
            const vw = this._wcViewW || c.clientWidth || this.playerEl.clientWidth || 400;
            const vh = this._wcViewH || c.clientHeight || this.playerEl.clientHeight || 300;
            if (!this.wcLayoutDone) {
                this.layoutWordCloud();
            }
            const aw = this.wordElementsByLine[this.activeLineIndex] || [];
            let fe = null;
            for (let j = aw.length - 1; j >= 0; j--) {
                if (aw[j] && aw[j].classList.contains('active')) {
                    fe = aw[j];
                    break;
                }
            }
            if (!fe) fe = this.lineElements[this.activeLineIndex];
            if (!fe) return;

            const v = this.modeVars.wordcloud || {};
            /* ★ 阻尼系数 → 补间时长：与主播放器同一换算（等效指数平滑时间常数），
               滑块 0.01~0.15 映射约 1.66s ~ 0.10s，使"相机阻尼系数"真正可调 */
            const tweenDur = this.wcLerpToDuration(v.wcLerpFactor);

            /* ★ 缩放/坐标缓存：仅在焦点元素或布局版本变化时重算。
               getBoundingClientRect 会强制同步布局，若每帧调用会严重拖慢动画，故命中缓存时跳过 */
            const ale = this.lineElements[this.activeLineIndex];
            const rf = parseFloat(ale?.dataset.wcFontSize || '2.5');
            const tfr = this.getWcTargetFontRem();
            /* ★ 与主播放器一致：真实放大焦点行字号（只放大不缩小），摄像机缩放固定 1，
               而非靠摄像机变焦放大整个画布（文字以原生字号渲染、边缘锐利） */
            if (this._wcBumpedIdx !== this.activeLineIndex) {
                if (this._wcBumpedIdx != null && this.lineElements[this._wcBumpedIdx]) {
                    const prev = this.lineElements[this._wcBumpedIdx];
                    prev.style.fontSize = (prev.dataset.wcFontSize || '2.5') * 16 + 'px';
                    prev.style.zIndex = '';
                }
                this._wcBumpedIdx = this.activeLineIndex;
                if (tfr > rf) ale.style.fontSize = (tfr * 16) + 'px';
                ale.style.zIndex = '5';
                this._wcCamCache = null;   /* 字号已变 → 强制重新测量焦点坐标 */
            }
            if (!this._wcCamCache || this._wcCamCache.el !== fe || this._wcCamCache.ver !== this._wcLayoutVer) {
                const ts = 1;   /* 摄像机不承担放大，缩放恒为 1 */

                /* ★ 修正：测量时 DOM 处于"当前缩放 S"下，视口坐标差 = S × 未缩放画布坐标，
                   必须除以测量时的实际缩放 S 才得到未缩放坐标。
                   此前误除目标缩放 ts，导致跟焦目标系统性偏移（焦点行字号与前一行差异越大偏移越大），
                   相机向错误位置飞行，表现为预览动画"莫名卡顿/乱跳" */
                const s0 = this.wcCurrentScale || 1;
                const wr = fe.getBoundingClientRect(), cr = this.scrollEl.getBoundingClientRect();
                const wx = (wr.left + wr.width / 2 - cr.left) / s0;
                const wy = (wr.top + wr.height / 2 - cr.top) / s0;
                this._wcCamCache = { el: fe, ver: this._wcLayoutVer, wx, wy, ts };
            }
            const { wx, wy, ts } = this._wcCamCache;
            /* ★ 与主播放器一致：用"时间驱动 + easeOutQuart"的非线性补间替代固定比例 Lerp。
               时长由阻尼系数 wcLerpFactor 决定（wcLerpToDuration 换算），且时长有界 →
               补间在有限时间精确收敛停稳，不会像旧 Lerp 那样无限逐帧逼近 + 持续重栅格化。
               旧版此处写死 dur: 0.42 且从不使用 lerpFactor，导致滑块完全无效。 */
            const targetX = vw / 2 - wx * ts;
            const targetY = vh / 2 - wy * ts;
            if (this._wcFocusSeq === undefined) this._wcFocusSeq = 0;
            if (this._wcFocusEl !== fe) { this._wcFocusEl = fe; this._wcFocusSeq++; }
            const sig = `${this._wcLayoutVer}:${this._wcFocusSeq}:${ts.toFixed(3)}`;
            if (this._wcTween && this._wcTween.sig !== sig) {
                this._wcTween = {
                    sig, t0: performance.now(), dur: tweenDur,
                    start: { x: this.wcCurrentX, y: this.wcCurrentY, s: this.wcCurrentScale },
                    target: { x: targetX, y: targetY, s: ts }
                };
            } else if (!this._wcTween) {
                const settled = Math.abs(this.wcCurrentX - targetX) < 0.5 &&
                                Math.abs(this.wcCurrentY - targetY) < 0.5 &&
                                Math.abs(this.wcCurrentScale - ts) < 0.002;
                if (!settled) {
                    this._wcTween = {
                        sig, t0: performance.now(), dur: tweenDur,
                        start: { x: this.wcCurrentX, y: this.wcCurrentY, s: this.wcCurrentScale },
                        target: { x: targetX, y: targetY, s: ts }
                    };
                }
            }
            if (this._wcTween) {
                const tt = (performance.now() - this._wcTween.t0) / (this._wcTween.dur * 1000);
                const k = tt >= 1 ? 1 : (1 - Math.pow(1 - tt, 4));   /* easeOutQuart，与主播放器一致 */
                this.wcCurrentX = this._wcTween.start.x + (this._wcTween.target.x - this._wcTween.start.x) * k;
                this.wcCurrentY = this._wcTween.start.y + (this._wcTween.target.y - this._wcTween.start.y) * k;
                this.wcCurrentScale = this._wcTween.start.s + (this._wcTween.target.s - this._wcTween.start.s) * k;
                if (tt >= 1) this._wcTween = null;
            }
            /* ★ 静止时跳过重复写入：值不变的 transform 赋值仍触发样式失效检查，
               预览与主播放器同时运行时省一次是一次 */
            const camTransform = `translate(${this.wcCurrentX.toFixed(2)}px,${this.wcCurrentY.toFixed(2)}px) scale(${this.wcCurrentScale.toFixed(4)})`;
            if (camTransform !== this._wcLastTransform) {
                this._wcLastTransform = camTransform;
                this.scrollEl.style.transform = `translate(${this.wcCurrentX}px,${this.wcCurrentY}px) scale(${this.wcCurrentScale})`;
            }
        }

        /* ★ 相机阻尼系数 wcLerpFactor → 缓动补间时长（秒）。
           等效指数平滑时间常数：τ = 帧长 / -ln(1-λ)，默认 0.04 ≈ 0.41s；
           与主播放器 app.js 的 wcLerpToDuration 保持一致（两处需同步修改） */
        wcLerpToDuration(lerp) {
            let f = parseFloat(lerp);
            if (!isFinite(f) || f <= 0) f = 0.04;
            f = Math.min(0.5, Math.max(0.005, f));
            return Math.min(2.5, Math.max(0.08, 0.0166667 / -Math.log(1 - f)));
        }

        /* ★ 阻尼变化时调整进行中的补间时长：保持进度比例，仅改变剩余流速 */
        wcApplyLerpToTween(durSec) {
            const tw = this._wcTween;
            if (!tw || !isFinite(durSec) || tw.dur === durSec) return;
            const now = performance.now();
            const prog = Math.min(1, Math.max(0, (now - tw.t0) / (tw.dur * 1000)));
            tw.dur = durSec;
            tw.t0 = now - prog * durSec * 1000;
        }
        getWcTargetFontRem() {
            /* ★ 与主播放器一致：按窗口宽度决定目标字号（rem），保证预览框缩放与外部实际一致 */
            const w = (typeof window !== 'undefined' && window.innerWidth) || 800;
            if (w < 500) return 3.0;
            if (w < 800) return 3.5;
            if (w < 1200) return 4.0;
            if (w < 1600) return 5.0;
            return 6.0;
        }

        /* ★ 修复：飞入/词云翻译区尊重 showTranslation / showRomaji 设置并支持即时渲染 */
        updateFlyinTranslation(li, immediate = false) {
            const fa = document.getElementById('previewFlyinTransArea');
            if (!fa) return;
            const ft = document.getElementById('previewFlyinTrans'), fr = document.getElementById('previewFlyinRoma');
            const line = this.lyrics[li] || this.lyrics[0];
            if (!line) return;
            const vars = this.modeVars[this.currentMode] || this.modeVars.flyin;
            const showTrans = vars.showTranslation !== false;
            const showRoma = vars.showRomaji !== false;

            const applyContent = () => {
                if (ft) ft.textContent = (showTrans && line.translation && line.translation.trim() !== '//') ? line.translation : '';
                if (fr) fr.textContent = (showRoma && line.romaji && line.romaji.trim()) ? line.romaji : '';
                fa.style.display = (showTrans || showRoma) ? '' : 'none';
                fa.style.opacity = '1';
            };

            if (immediate) {
                applyContent();
            } else {
                fa.style.opacity = '0';
                setTimeout(applyContent, 200);
            }
        }
        flyinAutoScaleFont() {
            const c = this.lyricsContainerEl;
            if (!c) return;
            const fa = document.getElementById('previewFlyinTransArea');
            const al = this.playerEl.querySelector('.preview-line.active');
            if (!al) return;
            const le = al.querySelector('.lrc-original');
            if (!le) return;
            const tr = 20, br = fa ? fa.offsetHeight + 20 : 60;
            const mh = c.clientHeight - tr - br - (this.controlsBar ? this.controlsBar.offsetHeight : 40);
            if (mh <= 0) return;
            const v = this.modeVars.flyin;
            const baseFontPx = 24;
            const bs = (parseFloat(v.fontSize) || 1.0) * baseFontPx;
            le.style.fontSize = bs + 'px';
            le.style.maxHeight = 'none';
            const nh = le.scrollHeight;
            if (nh > mh) {
                const s = mh / nh;
                le.style.fontSize = (bs * s) + 'px';
                le.style.maxHeight = mh + 'px';
            }
        }

        start() {
            if (this.rafId) {
                cancelAnimationFrame(this.rafId);
                this.rafId = null;
            }
            this.startTime = performance.now() - (this.lastTime || 0);
            this.isPlaying = true;
            this.updatePlayIcon();
            this.loop();
        }

        pause() {
            this.isPlaying = false;
            if (this.rafId) {
                cancelAnimationFrame(this.rafId);
                this.rafId = null;
            }
            this.updatePlayIcon();
        }

        stop() {
            this.pause();
            if (this.pvEngine) {
                try { this.pvEngine.stop(); } catch (e) { logCatch('previewEngine', e); }
            }
            if (this.visManager) {
                try { this.visManager.stop(); } catch (e) { logCatch('previewEngine', e); }
            }
        }

        loop() {
            if (!this.isPlaying) return;
            const now = performance.now();
            const e = now - this.startTime;
            /* ★ 预览引擎限频 ~60fps：外观设置开着时预览与主播放器同时存在，预览让步给主画面，
               在高刷屏(120/144Hz)上不再抢占主播放器帧预算；不影响预览节奏 */
            if (this._lastPreviewFrame == null) this._lastPreviewFrame = now;
            if (now - this._lastPreviewFrame >= 16.6) {
                this._lastPreviewFrame = now;
                const t = e % this.cycleDuration;
                this.update(t);
                this.updateControls(t);
            }
            this.rafId = requestAnimationFrame(() => this.loop());
        }

        update(t) {
            if (this.lyrics.length === 0) return;
            let ni = -1, lo = 0, hi = this.lyrics.length - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (this.lyrics[mid].start <= t) { ni = mid; lo = mid + 1; }
                else { hi = mid - 1; }
            }
            if (ni === -1) ni = 0;
            if (ni !== this.activeLineIndex) {
                const oi = this.activeLineIndex;
                this.activeLineIndex = ni;
                if (oi >= 0 && this.lineElements[oi]) {
                    this.lineElements[oi].classList.remove('active');
                    const ow = this.wordElementsByLine[oi] || [], oh = this.wordHighlightElementsByLine[oi] || [];
                    for (let i = 0; i < ow.length; i++) {
                        if (ow[i] && ow[i].classList.contains('active')) ow[i].classList.remove('active');
                        /* ★ P1 性能：高亮归零改为重置裁切前沿（恒定盒，无重排） */
                        if (oh[i]) {
                            if (oh[i].classList.contains('rtl-highlight')) oh[i].style.clipPath = 'inset(-0.4em 0 -0.4em 100%)';
                            else oh[i].style.setProperty('--reveal', '0%');
                            oh[i].dataset.lw = '';
                        }
                    }
                }
                if (this.lineElements[this.activeLineIndex]) this.lineElements[this.activeLineIndex].classList.add('active');
                this.updateLineBlur();
                if (this.currentMode === 'flyin') {
                    this.updateFlyinTranslation(this.activeLineIndex);
                    this.flyinAutoScaleFont();
                } else if (this.currentMode === 'wordcloud') {
                    this.updateFlyinTranslation(this.activeLineIndex);
                } else {
                    if (this.lineElements[this.activeLineIndex]) {
                        const ae = this.lineElements[this.activeLineIndex];
                        const ch = this.lyricsContainerEl.clientHeight;
                        /* ★ 容器高度为 0 时跳过滚动定位，防止歌词被滚动到视图外 */
                        if (ch > 0) {
                            const ty = ae.offsetTop - ch / 2 + ae.clientHeight / 2;
                            this.scrollEl.style.transition = 'transform 0.5s cubic-bezier(0.25,0.46,0.45,0.94)';
                            this.scrollEl.style.transform = `translateY(-${ty}px)`;
                        }
                    }
                }
            }
            /* 逐字高亮（仅计算当前行） */
            const aw = this.wordElementsByLine[this.activeLineIndex] || [], ah = this.wordHighlightElementsByLine[this.activeLineIndex] || [];
            for (let j = 0; j < aw.length; j++) {
                const we = aw[j], hl = ah[j];
                if (!hl) continue;
                const ws = parseInt(we.dataset.start), we_ = parseInt(we.dataset.end);
                /* ★ P1 性能：数值百分比 + 恒定盒，写 --reveal（LTR）/ clip-path（RTL），零重排 */
                let pct;
                if (t < ws) pct = 0;
                else if (t >= we_) pct = 100;
                else pct = Math.round((t - ws) / (we_ - ws) * 1000) / 10;
                if (t >= ws && !we.classList.contains('active')) we.classList.add('active');
                const ps = String(pct);
                if (hl.dataset.lw === ps) continue;
                hl.dataset.lw = ps;
                if (hl.classList.contains('rtl-highlight')) {
                    /* ★ 上下 -0.4em 外扩（2026-09-20 裁剪彻底修复，见 base.css .word-highlight） */
                    hl.style.clipPath = `inset(-0.4em 0 -0.4em ${100 - pct}%)`;
                } else {
                    hl.style.setProperty('--reveal', pct + '%');
                }
                if (pct >= 100) hl.classList.add('done');
                else hl.classList.remove('done');
            }
            
            /* 词云模式相机推进 */
            if (this.currentMode === 'wordcloud') {
                this.updateWordcloudCamera();
            }
            /* PV 模式海报推进 */
            if (this.currentMode === 'pv' && this.pvEngine) {
                this.pvEngine.update(t / 1000);
            }
            /* 流光隧道模式推进 */
            if (this.currentMode === 'tunnel' && this.tunnelEngine) {
                this.tunnelEngine.update(t / 1000);
            }
            /* 全景视觉渲染器推进 (浮空/活字/霓虹，见 VisualizerManager 注册表) */
            if (this.visManager && this.visManager.has(this.currentMode)) {
                this.visManager.update(t / 1000);
            }
        }

        updateControls(t) {
            this.lastTime = t;
            const fill = document.getElementById('previewProgressFill');
            const thumb = document.getElementById('previewProgressThumb');
            const timeEl = document.getElementById('previewTime');
            const pct = Math.min(1, t / this.cycleDuration);
            if (fill) fill.style.width = (pct * 100) + '%';
            if (thumb) thumb.style.left = (pct * 100) + '%';
            if (timeEl) { const cur = Math.floor(t / 1000); const tot = Math.floor(this.cycleDuration / 1000); timeEl.textContent = `${Math.floor(cur/60)}:${String(cur%60).padStart(2,'0')} / ${Math.floor(tot/60)}:${String(tot%60).padStart(2,'0')}`; }
        }

        setMode(mode) {
            this.currentMode = mode;
            this._wcLastTransform = '';   /* 切模式后 scrollEl 的 transform 可能被其他模式改写，强制相机重写 */
            this.playerEl.classList.remove('view-cover', 'view-lyrics', 'view-flyin', 'view-wordcloud', 'view-pv', 'view-tunnel', 'view-dimension', 'view-letterpress', 'view-neon');
            
            const ca = this.playerEl.querySelector('.preview-cover-area');
            if (ca) ca.style.display = (mode === 'cover') ? '' : 'none';

            if (this.visManager && this.visManager.has(mode)) {
                this.playerEl.classList.add(`view-${mode}`);
                if (this.scrollEl) this.scrollEl.style.display = 'none';
                if (this.wireframesEl) this.wireframesEl.style.display = 'none';
                if (this.pvPreviewContainer) this.pvPreviewContainer.style.display = 'none';
                if (this.pvEngine) this.pvEngine.stop();
                if (this.tunnelPreviewContainer) this.tunnelPreviewContainer.style.display = 'none';
                if (this.tunnelEngine) this.tunnelEngine.stop();

                this.visManager.switchMode(mode, this.playerEl);
                this.visManager.setLyrics(this.lyrics, {
                    accent_color: (this.modeVars[mode] && this.modeVars[mode].themeColor) || '#ffcc33'
                });
                this.visManager.applySettings(this.modeVars[mode] || {});
            } else if (mode === 'pv') {
                if (this.visManager) this.visManager.destroy();
                this.playerEl.classList.add('view-pv');
                if (!this.pvPreviewContainer) {
                    this.pvPreviewContainer = document.createElement('div');
                    this.pvPreviewContainer.className = 'pv-view-container';
                    this.pvPreviewContainer.style.position = 'absolute';
                    this.pvPreviewContainer.style.inset = '0';
                    this.pvPreviewContainer.style.width = '100%';
                    this.pvPreviewContainer.style.height = '100%';
                    this.pvPreviewContainer.style.zIndex = '20';
                    this.playerEl.appendChild(this.pvPreviewContainer);
                }
                this.pvPreviewContainer.style.display = 'block';
                /* ★ 预览容器远小于主播放器全屏舞台：按容器宽度计算字号密度系数，
                   使 PV 海报文字适配预览窗（pv.css 中 .pv-char 字号乘 --pv-dens） */
                const pvW = this.pvPreviewContainer.clientWidth || this.playerEl.clientWidth || 320;
                this.pvPreviewContainer.style.setProperty('--pv-dens', Math.max(0.14, Math.min(1, pvW / 900)).toFixed(3));
                if (this.scrollEl) this.scrollEl.style.display = 'none';
                if (this.wireframesEl) this.wireframesEl.style.display = 'none';
                
                if (!this.pvEngine) {
                    /* ★ 修复：若首个模式即为 PV（尚未经历 render→loadLyrics），先装载硬编码歌词 */
                    if (!this.lyrics || !this.lyrics.length) this.loadLyrics();
                    const EngineClass = (typeof PVEngine !== 'undefined') ? PVEngine : (typeof window !== 'undefined' ? window.PVEngine : null);
                    if (EngineClass) {
                        this.pvEngine = new EngineClass(this.pvPreviewContainer);
                        this.pvEngine.init(this.pvPreviewContainer);
                        this.pvEngine.setLyrics(this.lyrics, {
                            accent_color: (this.modeVars.pv && this.modeVars.pv.themeColor) || '#ffcc33',
                            emotion_words: ['golden', 'Bad', '温柔', 'vida', 'darkness']
                        });
                    }
                }
                if (this.pvEngine) {
                    this.pvEngine.start();
                    this.pvEngine.applySettings(this.modeVars.pv || {});
                    if (this.pvEngine.background && typeof this.pvEngine.background._handleResize === 'function') {
                        setTimeout(() => this.pvEngine.background._handleResize(), 50);
                    }
                    this.pvEngine.update((this.lastTime || 0) / 1000);
                }
            } else if (mode === 'tunnel') {
                if (this.visManager) this.visManager.destroy();
                this.playerEl.classList.add('view-tunnel');
                if (!this.tunnelPreviewContainer) {
                    this.tunnelPreviewContainer = document.createElement('div');
                    this.tunnelPreviewContainer.className = 'tunnel-view-container';
                    this.tunnelPreviewContainer.style.position = 'absolute';
                    this.tunnelPreviewContainer.style.inset = '0';
                    this.tunnelPreviewContainer.style.width = '100%';
                    this.tunnelPreviewContainer.style.height = '100%';
                    this.tunnelPreviewContainer.style.zIndex = '20';
                    this.playerEl.appendChild(this.tunnelPreviewContainer);
                }
                this.tunnelPreviewContainer.style.display = 'block';
                /* ★ 预览容器字号密度系数（pv-tunnel.css 中 .tunnel-char 字号乘 --tunnel-dens） */
                const tlW = this.tunnelPreviewContainer.clientWidth || this.playerEl.clientWidth || 320;
                this.tunnelPreviewContainer.style.setProperty('--tunnel-dens', Math.max(0.2, Math.min(1, tlW / 900)).toFixed(3));
                if (this.scrollEl) this.scrollEl.style.display = 'none';
                if (this.wireframesEl) this.wireframesEl.style.display = 'none';

                if (!this.tunnelEngine) {
                    if (!this.lyrics || !this.lyrics.length) this.loadLyrics();
                    const EngineClass = (typeof TunnelEngine !== 'undefined') ? TunnelEngine : (typeof window !== 'undefined' ? window.TunnelEngine : null);
                    if (EngineClass) {
                        this.tunnelEngine = new EngineClass(this.tunnelPreviewContainer);
                        this.tunnelEngine.init(this.tunnelPreviewContainer);
                        this.tunnelEngine.setLyrics(this.lyrics, {
                            accent_color: (this.modeVars.tunnel && this.modeVars.tunnel.themeColor) || '#ffcc33',
                            emotion_words: ['golden', 'Bad', '温柔', 'vida', 'darkness']
                        });
                    }
                }
                if (this.tunnelEngine) {
                    this.tunnelEngine.start();
                    this.tunnelEngine.applySettings(this.modeVars.tunnel || {});
                    this.tunnelEngine.update((this.lastTime || 0) / 1000);
                }
            } else {
                if (this.visManager) this.visManager.destroy();
                if (this.pvPreviewContainer) {
                    this.pvPreviewContainer.style.display = 'none';
                }
                if (this.pvEngine) {
                    this.pvEngine.stop();
                }
                if (this.tunnelPreviewContainer) {
                    this.tunnelPreviewContainer.style.display = 'none';
                }
                if (this.tunnelEngine) {
                    this.tunnelEngine.stop();
                }
                if (mode === 'lyrics') this.playerEl.classList.add('view-lyrics');
                else if (mode === 'flyin') this.playerEl.classList.add('view-lyrics', 'view-flyin');
                else if (mode === 'wordcloud') this.playerEl.classList.add('view-lyrics', 'view-wordcloud');
                else this.playerEl.classList.add('view-cover');

                if (this.scrollEl) this.scrollEl.style.display = '';
                if (this.wireframesEl) this.wireframesEl.style.display = (mode === 'flyin') ? '' : 'none';
            }

            /* ★ 严格互斥控制悬浮翻译区的显示（仅 flyin 和 wordcloud 模式显示底栏悬浮翻译） */
            const flyinTransArea = this.playerEl.querySelector('#previewFlyinTransArea');
            if (flyinTransArea) {
                if (mode === 'flyin' || mode === 'wordcloud') {
                    flyinTransArea.style.display = '';
                } else {
                    flyinTransArea.style.display = 'none';
                    flyinTransArea.style.opacity = '0';
                }
            }

            /* ★ 确保播放器控件栏始终处于 DOM 最顶层，防止被全屏/3D视觉舞台遮挡 */
            if (this.controlsBar && this.playerEl) {
                this.playerEl.appendChild(this.controlsBar);
            }

            this.render();
            if (mode === 'flyin') {
                this.scrollEl.style.transform = 'none';
                const curT = this.lastTime || 0;
                let ni = -1, lo = 0, hi = this.lyrics.length - 1;
                while (lo <= hi) { const mid = (lo + hi) >> 1; if (this.lyrics[mid].start <= curT) { ni = mid; lo = mid + 1; } else { hi = mid - 1; } }
                if (ni === -1) ni = 0;
                this.activeLineIndex = ni;
                if (this.lineElements[ni]) {
                    this.lineElements.forEach((el, idx) => el.classList.toggle('active', idx === ni));
                }
                this.updateFlyinTranslation(ni, true);
                setTimeout(() => this.flyinAutoScaleFont(), 30);
                /* ★ 修复：从 PV/浮空模式切换到飞入模式后歌词不显示，强制延迟重渲染 */
                requestAnimationFrame(() => {
                    if (this.lineElements[ni]) {
                        this.lineElements.forEach((el, idx) => el.classList.toggle('active', idx === ni));
                    }
                    this.updateFlyinTranslation(ni, true);
                    setTimeout(() => this.flyinAutoScaleFont(), 50);
                });
                /* ★ 概率空白根修（用户实测：切模式时概率出现）：切模式瞬间容器可能
                   还在面板展开动画中（尺寸 0），flyinAutoScaleFont 量到 0 宽会把
                   歌词字号算成 0 且不再补救（ResizeObserver 只在尺寸变化时触发，
                   若切模式前后容器尺寸没变就不会再回调）。多重延迟兜底覆盖时序窗。 */
                [140, 320, 650].forEach(d => setTimeout(() => {
                    try { if (this.currentMode === 'flyin') this.flyinAutoScaleFont(); } catch (_e) { logCatch('previewEngine', _e); }
                }, d));
            } else if (mode === 'wordcloud') {
                this.layoutWordCloud();
                /* ★ 修复：如果容器尺寸为 0 导致布局跳过，延迟重试 */
                const vw = this.lyricsContainerEl?.clientWidth || 0;
                const vh = this.lyricsContainerEl?.clientHeight || 0;
                if (vw === 0 || vh === 0) {
                    setTimeout(() => this.layoutWordCloud(), 100);
                    setTimeout(() => this.layoutWordCloud(), 300);
                }
            }
            this.applyAllVars();
            this.update(this.lastTime || 0);
        }

        /* ========== CSS 变量应用 ========== */
        applyAllVars() {
            this.applyModeVars();
        }

        applyModeVars() {
            const r = this.container;
            const v = this.modeVars[this.currentMode] || this.modeVars.cover;

            /* 基础文字样式变量（全局各模式生效） */
            const baseFontPx = 24; /* medium 基准 */
            const fontScale = parseFloat(v.fontSize); 
            const fontSizePx = (isNaN(fontScale) ? 1.0 : fontScale) * baseFontPx;
            r.style.setProperty('--preview-font-size', fontSizePx + 'px');
            r.style.setProperty('--preview-highlight-color', v.highlightColor || '#ffffff');
            r.style.setProperty('--preview-highlight-inactive-color', v.highlightInactiveColor || 'rgba(255,255,255,0.6)');
            r.style.setProperty('--preview-inactive-color', v.inactiveColor || '#ffffff');
            r.style.setProperty('--preview-align', v.align || 'left');

            /* 飞入模式特定变量 */
            if (v.flyinTranslateY !== undefined) r.style.setProperty('--preview-flyin-translateY', v.flyinTranslateY + 'px');
            if (v.flyinScale !== undefined) r.style.setProperty('--preview-flyin-scale', v.flyinScale);
            if (v.flyinGlow !== undefined) r.style.setProperty('--preview-flyin-glow', v.flyinGlow + 'px');
            if (v.flyinTransSize !== undefined) r.style.setProperty('--preview-flyin-trans-size', v.flyinTransSize + 'px');
            if (v.flyinTransBottom !== undefined) r.style.setProperty('--preview-flyin-trans-bottom', v.flyinTransBottom + 'px');

            /* 词云模式特定变量 */
            if (v.wcFontMin !== undefined) r.style.setProperty('--preview-wc-font-min', v.wcFontMin + 'rem');
            if (v.wcFontMax !== undefined) r.style.setProperty('--preview-wc-font-max', v.wcFontMax + 'rem');
            if (v.wcDensity !== undefined) r.style.setProperty('--preview-wc-density', v.wcDensity + 'px');
            if (v.wcDimBlur !== undefined) r.style.setProperty('--preview-wc-dim-blur', v.wcDimBlur + 'px');
            if (v.wcDimOpacity !== undefined) r.style.setProperty('--preview-wc-dim-opacity', v.wcDimOpacity);

            /* 每个模式独立的背景/图形色/字体/情感词发光设置，全局主题色控制控件与强调色 */
            const globalThemeCol = (this.globalVars && this.globalVars.themeColor) || '#ffcc33';
            const highlightCol = v.highlightColor || '#ffffff';
            const graphicCol = v.graphicColor || v.themeColor || globalThemeCol;
            const bgCol = v.bgColor || v.themeColor || globalThemeCol;
            const rgbStr = this.hexToRgb(globalThemeCol);

            r.style.setProperty('--preview-theme-color', globalThemeCol);
            r.style.setProperty('--theme-color', globalThemeCol);
            r.style.setProperty('--preview-theme-color-rgb', rgbStr);
            r.style.setProperty('--theme-color-rgb', rgbStr);
            r.style.setProperty('--preview-highlight-color', highlightCol);
            r.style.setProperty('--highlight-color', highlightCol);
            r.style.setProperty('--preview-graphic-color', graphicCol);
            r.style.setProperty('--preview-graphic-color-rgb', this.hexToRgb(graphicCol));
            r.style.setProperty('--preview-bg-color', bgCol);
            r.style.setProperty('--preview-bg-color-rgb', this.hexToRgb(bgCol));

            /* ★ 传入全局字体键，使 'default'/'inherit' 能解析为全局字体 */
            const globalFk = (this.appSettings && this.appSettings.interface && this.appSettings.interface.fontFamily) || 'default';
            const adv = this.appSettings && this.appSettings.interface && this.appSettings.interface.advancedFonts;
            const modeFont = v.fontFamily || 'default';
            let resolvedFont;
            if (adv && adv.enabled) {
                /* 高级字体开启时，无论该模式字体是否显式设为 globalFontKey（v.fontFamily 默认
                   等于 interface.fontFamily，而非 'default' 字面量），都应优先使用各语言独立字体族
                   （MultiLangFont-<lang>），尊重按语言的 @font-face / FontFace unicode-range 规则，
                   与主播放器行为一致；模式自定义字体仅作回退 */
                const ml = (typeof window !== 'undefined' && Aria.__multilangFamilyList) || '';
                const fallback = resolveFontFamily(modeFont, globalFk);
                resolvedFont = ml ? ml + ", " + fallback : fallback;
            } else {
                resolvedFont = resolveFontFamily(modeFont, globalFk);
            }
            r.style.setProperty('--preview-font-family', resolvedFont);
            if (this.playerEl) {
                this.playerEl.style.fontFamily = resolvedFont;
            }

            const glowVal = (v.emotionGlow !== undefined && v.emotionGlow !== null) ? parseFloat(v.emotionGlow) : 10;
            r.style.setProperty('--emotion-glow', glowVal + 'px');
            r.style.setProperty('--preview-emotion-glow', glowVal + 'px');

            if (!this._emotionStyleEl || !this.container.contains(this._emotionStyleEl)) {
                this._emotionStyleEl = document.createElement('style');
                this._emotionStyleEl.className = 'preview-emotion-style';
                this.container.appendChild(this._emotionStyleEl);
            }
            /* 柔和低亮度、高透明度发光：压暗颜色并使用柔和单层阴影，字迹笔画加黑色描边阴影确保绝对清晰 */
            const shadowText = glowVal > 0 
                ? `0 1px 3px rgba(0,0,0,0.85), 0 0 ${glowVal}px color-mix(in srgb, var(--emotion-color, ${globalThemeCol}) 40%, transparent)`
                : '0 1px 3px rgba(0,0,0,0.85) !important';
            let emotionCss = `
                .preview-player,
                .preview-player .lyrics-container,
                .preview-player .scroll-container,
                .preview-player .preview-line,
                .preview-player .preview-lrc-original,
                .preview-player .preview-lrc-translation,
                .preview-player .preview-lrc-romaji,
                .preview-player .preview-words-container {
                    overflow: visible !important;
                    contain: none !important;
                }
                .preview-player .word {
                    overflow: visible !important;
                    contain: none !important;
                }
                /* 高亮颜色支持
                   ★ 不强制整行/已激活字符的底色变为高亮色：
                     让 .preview-word-highlight 层依靠 JS 驱动的宽度百分比从左到右填充，
                     普通词与情感词保持一致"渐入"效果。若强制底色变亮会导致整字瞬间高亮 */
                .preview-player .preview-line.active .preview-word.done:not(.word-emotion) {
                    color: ${highlightCol} !important;
                }
                .preview-player .preview-word-highlight {
                    color: ${highlightCol} !important;
                }
                /* 纯文字 text-shadow 柔和微光发光：彻底避免干扰字迹阅读与方形背景框
                   ★ P2 修复：底色染色改为 done 门控——仅当逐字高亮层扫完
                     （.preview-word-highlight.done）才整字转情感色，修复首次进入时
                     "情感词整个字直接上色而非从左向右逐渐高亮"的概率性问题。
                     第一条反制规则用于压制全局 ai-emotion-word-style 中
                     ".line.active .word.word-emotion.active > span:last-child"
                     泄漏进预览 DOM（预览行同时带 line/preview-line 类）造成的抢跑染色 */
                .preview-player .word.word-emotion.active:not(:has(.preview-word-highlight.done)) > span:last-child {
                    color: inherit !important;
                    text-shadow: none !important;
                }
                .preview-player .word.word-emotion.active:has(.preview-word-highlight.done) > span:last-child {
                    color: var(--emotion-color, ${globalThemeCol}) !important;
                    text-shadow: ${shadowText};
                }
                .preview-player .word.word-emotion.active .preview-word-highlight {
                    color: var(--emotion-color, ${globalThemeCol}) !important;
                    text-shadow: none !important;
                    contain: none !important;
                }
                .preview-player .word.word-emotion {
                    overflow: visible !important;
                }
                .preview-player .word.word-emotion .preview-word-highlight {
                    contain: none !important;
                }
                .preview-player,
                .preview-player * {
                    font-family: var(--preview-font-family, var(--app-multilang-fonts, var(--app-font-family))) !important;
                }
            `;
            /* ★ 按行语言规则：多语言高级字体开启时，把该行语言的字体族提到最前
             * （解决中日共享 CJK 码位导致的"假名一种字体、汉字另一种字体"混排） */
            const famMap = (typeof window !== 'undefined' && Aria.__multilangFamMap) || null;
            if (famMap) {
                for (const lc in famMap) {
                    emotionCss += `
                .preview-player [data-line-lang="${lc}"],
                .preview-player [data-line-lang="${lc}"] * {
                    font-family: '${famMap[lc]}', ${resolvedFont} !important;
                }`;
                }
            }
            this._emotionStyleEl.textContent = emotionCss;

            /* 模糊度与亮度 */
            const blurVal = v.bgBlur != null ? v.bgBlur : 60;
            const brightVal = v.bgBrightness != null ? v.bgBrightness : 0.35;
            r.style.setProperty('--preview-bg-blur', blurVal + 'px');
            r.style.setProperty('--preview-bg-brightness', brightVal);
            if (this.bgEl) {
                this.bgEl.style.filter = `blur(${blurVal}px) brightness(${brightVal})`;
            }

            /* 摇摆动画 */
            if (v.swayEnabled !== false && this.bgEl) {
                const amp = v.swayAmp || 12;
                const dur = v.swayDuration || 16;
                if (!this._swayStyleEl || !this.container.contains(this._swayStyleEl)) {
                    this._swayStyleEl = document.createElement('style');
                    this.container.appendChild(this._swayStyleEl);
                }
                this._swayStyleEl.textContent = `@keyframes previewBgSway { 0%,100% { transform: rotate(-${amp}deg) scale(1.1); } 50% { transform: rotate(${amp}deg) scale(1.1); } }`;
                this.bgEl.style.animation = `previewBgSway ${dur}s ease-in-out infinite`;
            } else if (this.bgEl) {
                this.bgEl.style.animation = 'none';
            }

            /* 动态强化全部行、原文、翻译、罗马音节点的对齐与缩放轴，解决左右溢出 */
            const align = v.align || 'left';
            const transformOrigin = align === 'left' ? 'left center'
                                  : align === 'right' ? 'right center'
                                  : 'center center';
            if (this.lineElements && this.lineElements.length > 0) {
                this.lineElements.forEach(lineEl => {
                    lineEl.style.textAlign = align;
                    const orig = lineEl.querySelector('.preview-lrc-original');
                    if (orig) { orig.style.textAlign = align; orig.style.transformOrigin = transformOrigin; }
                    const wc = lineEl.querySelector('.preview-words-container');
                    if (wc) { wc.style.textAlign = align; }
                    const tr = lineEl.querySelector('.preview-lrc-translation');
                    if (tr) { tr.style.textAlign = align; tr.style.transformOrigin = transformOrigin; }
                    const rm = lineEl.querySelector('.preview-lrc-romaji');
                    if (rm) { rm.style.textAlign = align; rm.style.transformOrigin = transformOrigin; }
                });
            }

            this.applyBlurCSS();
        }

        /* ★ 动态模糊CSS — 根据 blurLevel 生成逐级模糊样式 */
        applyBlurCSS() {
            const v = this.modeVars[this.currentMode] || this.modeVars.cover;
            const level = v.blurLevel != null ? v.blurLevel : 5;
            const blurSteps = [0, 1.5, 3, 4.5, 6, 7.5, 9, 10.5, 12];
            const opacitySteps = [1, 0.55, 0.45, 0.38, 0.32, 0.28, 0.24, 0.22, 0.20];
            let css = '';
            for (let d = 0; d <= 8; d++) {
                const bl = (d <= level) ? blurSteps[d] : blurSteps[Math.min(level, 8)];
                const op = (d <= level) ? opacitySteps[d] : opacitySteps[Math.min(level, 8)];
                css += `.preview-line.blur-d${d} { opacity: ${op}; filter: blur(${bl}px); }\n`;
            }
            /* 活动行始终无模糊 */
            css += `.preview-line.active { opacity: 1 !important; filter: none !important; }\n`;
            if (!this._blurStyleEl || !this.container.contains(this._blurStyleEl)) {
                this._blurStyleEl = document.createElement('style');
                this._blurStyleEl.className = 'preview-blur-style';
                this.container.appendChild(this._blurStyleEl);
            }
            this._blurStyleEl.textContent = css;
        }

        setModeVar(name, value) {
            const v = this.modeVars[this.currentMode]; if (!v) return;
            v[name] = value;
            /* ★ 零开销快速通道：词云纯视觉参数不需要任何 DOM/样式重应用 —
               wcLerpFactor 由相机每帧实时读取 modeVars；
               wcDimBlur/wcDimOpacity 仅是两个 CSS 变量。
               旧版走 applyModeVars（每次重设 25+ 个 CSS 变量 → 整个预览子树样式失效），
               拖动滑块时每帧执行一次是"调节阻尼就卡顿"的主因 */
            if (this.currentMode === 'wordcloud' && (name === 'wcLerpFactor' || name === 'wcDimBlur' || name === 'wcDimOpacity')) {
                if (name === 'wcDimBlur') this.container.style.setProperty('--preview-wc-dim-blur', value + 'px');
                if (name === 'wcDimOpacity') this.container.style.setProperty('--preview-wc-dim-opacity', value);
                if (name === 'wcLerpFactor') this.wcApplyLerpToTween(this.wcLerpToDuration(value));
                if (this.onSettingChange) this.onSettingChange(name, value, this.currentMode);
                return;
            }
            /* ★ 性能优化：仅更新值显示和 CSS 变量，不做重渲染（高频滑块） */
            const highFreqKeys = ['blurLevel', 'bgBlur', 'bgBrightness', 'swayAmp', 'swayDuration', 'emotionGlow', 'flyinGlow', 'flyinTranslateY', 'flyinScale', 'flyinTransSize', 'flyinTransBottom', 'wcDensity', 'wcDimBlur', 'wcDimOpacity', 'fontSize', 'wcFontMin', 'wcFontMax'];
            if (highFreqKeys.includes(name)) {
                /* ★ 词云字体/密度滑块：拖动时仅更新值 + 防抖重布局，跳过每次 applyModeVars
                   重建 emotion 样式与大量 CSS 变量导致的卡顿（200ms 后一次性重排并同步样式） */
                if ((name === 'wcFontMin' || name === 'wcFontMax' || name === 'wcDensity') && this.currentMode === 'wordcloud') {
                    if (this._wcLayoutTimer) clearTimeout(this._wcLayoutTimer);
                    this._wcLayoutTimer = setTimeout(() => {
                        this._wcLayoutTimer = null;
                        this.layoutWordCloud();
                        this.applyModeVars();
                    }, 200);
                    if (this.onSettingChange) this.onSettingChange(name, value, this.currentMode);
                    return;
                }
                this.applyModeVars();
                if (name === 'blurLevel') this.applyBlurCSS();
                if ((name === 'fontSize') && this.currentMode === 'flyin') this.flyinAutoScaleFont();
                if (this.onSettingChange) this.onSettingChange(name, value, this.currentMode);
                return;
            }
            this.applyModeVars();
            /* ★ PV 模式：实时将设置应用到 PVEngine */
            if (this.currentMode === 'pv' && this.pvEngine) {
                this.pvEngine.applySettings(this.modeVars.pv || {});
                if (name === 'themeColor' || name === 'graphicColor' || name === 'highlightColor') {
                    this.pvEngine.setLyrics(this.lyrics, {
                        accent_color: (this.modeVars.pv && this.modeVars.pv.themeColor) || '#ffcc33',
                        emotion_words: ['golden', 'Bad', '温柔', 'vida', 'darkness']
                    });
                }
            }
            if (this.visManager && this.visManager.has(this.currentMode)) {
                this.visManager.applySettings(this.modeVars[this.currentMode] || {});
                if (name === 'themeColor' || name === 'highlightColor' || name === 'bgColor') {
                    this.visManager.setLyrics(this.lyrics, {
                        accent_color: (this.modeVars[this.currentMode] && this.modeVars[this.currentMode].bgColor) || (this.modeVars[this.currentMode] && this.modeVars[this.currentMode].themeColor) || '#ffcc33'
                    });
                }
            }
            /* ★ 需要重新渲染 DOM 的设置变更 */
            const rerenderKeys = ['align', 'fontFamily', 'showTranslation', 'showRomaji'];
            if (rerenderKeys.includes(name)) {
                this.render();
                requestAnimationFrame(() => {
                    this.update(this.lastTime || 0);
                    if (this.currentMode === 'flyin') {
                        this.updateFlyinTranslation(this.activeLineIndex >= 0 ? this.activeLineIndex : 0, true);
                        this.flyinAutoScaleFont();
                    } else if (this.currentMode === 'wordcloud') {
                        this.layoutWordCloud();
                    }
                    this.applyModeVars();
                });
            }
            /* ★ 同步设置到主播放器 */
            if (this.onSettingChange) this.onSettingChange(name, value, this.currentMode);
        }

        setGlobalVar(name, value) {
            this.globalVars[name] = value;
            this.applyAllVars();
            if (this.onSettingChange) this.onSettingChange(name, value, this.currentMode);
        }

        hexToRgb(hex) {
            if (!hex || !hex.startsWith('#')) return '255,204,51';
            const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
            return `${r},${g},${b}`;
        }

        destroy() { this.isPlaying = false; if (this.rafId) cancelAnimationFrame(this.rafId); if (this.container) this.container.innerHTML = ''; }
    }

    global.PreviewEngine = PreviewEngine;


export default PreviewEngine;
export { PreviewEngine };
