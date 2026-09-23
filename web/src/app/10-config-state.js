/* ============================================================
 * 10-config-state.js — 全局 state 分片（首片：状态键注册中心）
 * 由 src/app.js 拆分自动生成；拆分脚本 split_app.js 已删除，勿再引用
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { VisualizerManager } from '../core/visualizers/VisualizerManager.js';
import { DEFAULT_SETTINGS, playerConfig } from '../config/defaults.js';
import { initDom } from '../infrastructure/dom.js';
import ChorusDetector from '../core/chorusDetector.js';
import AIAnalyzer from '../core/aiAnalyzer.js';
import { LocalMusicManager } from '../services/localMusicManager.js';
import { registerGlobal } from '../core/globalRegistry.js';

/* 相机"非线性(缓动)补间"状态 {start, target, sig}（时间驱动 easeOut） */
globalThis.wcCacheSeq = 0;

globalThis.wcScrollRef = null;

/* ========== 词云模式：镜头阻尼跟焦 ==========
         * 在 rAF 循环中计算"当前字"中心点，
         * 通过 Lerp 插值平移画布使活动字始终居中。
         */
/* ★ P1 性能：容器/滚动容器引用惰性缓存，避免 rAF 每帧 querySelector */
globalThis.wcContainerRef = null;

/* 词云拖动状态（拖动时暂停自动跟焦） */
globalThis.wcZoomTimer = null;

/* 相机焦点缓存 {el, ver, wx, wy}（未缩放画布坐标） */
globalThis.wcBumpedIdx = null;

/* 词云布局版本号（重布局后使相机缓存失效） */
globalThis.wordcloudCamCache = null;

/* 词云拖动后抑制一次点击（防止误切行） */
globalThis.wordcloudLayoutVer = 0;

globalThis.isUserScrolling = false;

/* 相机焦点缓存序号：焦点/布局每次变化递增，作为补间切换信号 */
globalThis.wcLastTransform = '';

/* 缓存歌词颜色样式元素，避免重复创建 */
globalThis.lyricsColorStyleEl = null;

globalThis.fadeInVolumeTimeoutId = null;

/* ========== 封面与背景颜色 ========== */
/* 封面交叉淡入淡出：当前活动封面索引（0 或 1） */
globalThis.activeCoverIndex = 0;

globalThis.currentScrollY = 0;

/* 词进度映射：word 元素 → 当前 0~1 进度（逐字高亮） */
globalThis.lastWordProgress = new Map();

/* 每行内所有 .word-highlight 元素数组 */
globalThis.wordHighlightElementsByLine = [];

globalThis.eqInited = false;

globalThis.eqSourceNode = null;

globalThis.eqFilterNodes = [];

/* 搜索提示元素缓存 */
globalThis.searchHintEl = null;

globalThis.fadeOutVolumeTimeoutId = null;

/* 淡入音量到目标值 */
globalThis.fadeInVolumeRafId = null;

/* 淡出当前音量到 0 */
globalThis.fadeOutVolumeRafId = null;

/* 背景切换代际计数器——每次调用 setBlurBackground 递增，
   旧的 img.onload / setTimeout 回调通过比对代际自动作废 */
globalThis.bgGen = 0;

/* 封面切换代际计数器——每次调用 setCoverImage 递增，
           旧的 onload / onerror / setTimeout 回调通过比对代际自动作废 */
globalThis.coverGen = 0;

/* 词云滚轮缩放超时（3s 后恢复自动跟焦） */
globalThis.wcSuppressClick = false;

/* 词云当前缩放比例（1 = 原尺寸；滚轮缩放钳制 0.2~5，Lerp 插值中） */
globalThis.wordcloudCurrentScale = 1;

/* 画布当前平移 X（Lerp 插值中） */
globalThis.wordcloudCurrentX = 0;

/* 画布当前平移 Y（Lerp 插值中） */
globalThis.wordcloudCurrentY = 0;

globalThis.wcDragState = null;

/* ========== 词云模式状态 ========== */
/* 词云排版是否完成 */
globalThis.wordcloudLayoutDone = false;

/* 歌词元素缓存（避免每次动画帧全量querySelectorAll，大幅减少卡顿） */
globalThis.lineElements = [];

/* 当前可见的背景层索引（0 或 1），用于交叉淡入淡出 */
globalThis.activeBgIndex = 0;

globalThis.eqInitFailed = false;

/* 当前搜索结果缓存 */
globalThis.searchResultsCache = [];

/* 歌词来源覆盖（切换歌词来源时使用，null=跟随歌曲来源） */
globalThis.lyricSourceOverride = null;

/* 当前是否正在加载歌曲（防止重复点歌） */
globalThis.isLoadingSong = false;

globalThis.currentTime = 0;

globalThis.activeLineIndex = -1;

/* ========== 歌词延时/提前偏移（毫秒，正=延迟，负=提前） ========== */
globalThis.lyricOffset = 0;

/* 代际计数器：每次开始加载新歌时递增，异步回调通过检查此值判断是否已过期 */
globalThis.playbackGeneration = 0;

/* ========== 下一首歌预加载（URL/歌词/高潮/AI） ========== */
globalThis.nextSongPreload = null;

globalThis._preloadedLyricData = null;

/* ========== 切歌音量处理：淡入淡出 / 音量标准化 / 重试 ========== */
globalThis.retryCount = 0;

globalThis.currentPlaylistId = null;

/* 歌单视图状态：'list' = 歌单列表，'detail' = 歌单详情 */
globalThis.playlistViewMode = 'list';

/* 记录当前已应用的 AI 主题 */
globalThis.currentAiTheme = null;

/* 每行内所有 .word 元素数组 */
globalThis.wordElementsByLine = [];

/* 当前分析的 AbortController */
globalThis.currentAiAbortController = null;

/* 防止并发分析 */
globalThis.isAiAnalyzing = false;

/* 词云相机当前补间状态 {start:{x,y,s}, target:{x,y,s}}（非线性 easeOut，见 57-wordcloud-camera） */
globalThis.wcTween = null;

globalThis.lyrics = [];

/* AI 返回的情感关键词列表：[{word, color, emotion}, ...] */
globalThis.aiEmotionWords = [];

globalThis.preservesPitch = true;

/* ========== 倍速 / 变速不变调 / 下载 状态 ========== */
globalThis.currentPlaybackRate = 1;

/* PVEngine 实例 */
globalThis.mainVisManager = new VisualizerManager();

/* 用户点击公告后是否需要立即播放（预加载尚未完成时置为 true） */
globalThis.pendingPlayAfterPreload = false;

/* ========== 均衡器（Web Audio API） ========== */
globalThis.audioCtx = null;

/* ========== 在线搜索与播放（vkeys.cn API） ========== */
globalThis.currentSource = 'tencent';

globalThis.currentTrackIndex = 0;

/* 播放列表 */
globalThis.playlist = [];

/* 预加载状态：false=加载中, true=已就绪, null=失败/未开始 */
globalThis.preloadedSongReady = null;

/* 初始化默认歌曲：优先收藏列表，无收藏则播放硬编码默认歌曲 */
globalThis.initSongStarted = false;

/* 当前播放歌曲的标识（用于判断收藏状态） */
globalThis.currentSongKey = '';

globalThis.currentSongData = null;

/* 当前各频段增益(dB) */
globalThis.eqActivePreset = '默认';

globalThis.eqGains = new Array(10).fill(0);

globalThis.volume = playerConfig.initialVolume;

/* 播放方式: 'sequence' = 顺序播放, 'loop' = 单曲循环, 'random' = 随机播放 */
globalThis.playMode = 'sequence';

const localMusicManager = new LocalMusicManager();

globalThis.localSongsCache = [];

globalThis.appSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

globalThis.customFonts = {};

globalThis.multilangFontFaces = [];

globalThis.advFontsGeneration = 0;

/* ========== 全局常量与配置映射 (提升至顶部防止 TDZ 错误) ========== */
const LYRIC_FONT_MAP = {
    small:  { original: 'clamp(14px, 1.8vw, 22px)', sub: 'clamp(12px, 1.2vw, 14px)' },
    medium: { original: 'clamp(18px, 2.4vw, 28px)', sub: 'clamp(14px, 1.6vw, 18px)' },
    large:  { original: 'clamp(22px, 3vw, 34px)', sub: 'clamp(16px, 1.8vw, 20px)' },
    xlarge: { original: 'clamp(26px, 3.6vw, 40px)', sub: 'clamp(18px, 2vw, 22px)' }
};

const FONT_FAMILY_MAP = {
    default:  "'Segoe UI', 'Microsoft YaHei', sans-serif",
    serif:    "'SimSun', 'Songti SC', 'STSong', serif",
    kai:      "'KaiTi', 'STKaiti', '楷体', serif",
    hei:      "'SimHei', 'Microsoft YaHei', 'STHeiti', '黑体', sans-serif",
    fangsong: "'FangSong', 'STFangsong', '仿宋', serif",
    mono:     "'Consolas', 'Courier New', 'Microsoft YaHei', monospace"
};

const FONT_LOCAL_NAMES = {
    default:  null,
    serif:    ['SimSun', '宋体', 'Songti SC', 'STSong', 'NSimSun', '新宋体'],
    kai:      ['KaiTi', '楷体', 'STKaiti', 'Kaiti SC', '华文楷体'],
    hei:      ['SimHei', '黑体', 'Microsoft YaHei', 'STHeiti', 'Heiti SC', '微软雅黑'],
    fangsong: ['FangSong', '仿宋', 'STFangsong', '华文仿宋'],
    mono:     ['Consolas', 'Courier New', 'Microsoft YaHei', '微软雅黑']
};

const LANG_INFO = {
    zh: { name: '中文',     preview: '春花秋月何时了，往事知多少',  range: 'U+4E00-9FFF, U+3400-4DBF, U+20000-2A6DF, U+F900-FAFF' },
    ja: { name: '日文',     preview: 'さくらが咲く季節、春の風',      range: 'U+3040-309F, U+30A0-30FF, U+31F0-31FF, U+FF65-FF9F' },
    ko: { name: '韩文',     preview: '벚꽃이 피는 봄날의 바람',        range: 'U+AC00-D7AF, U+1100-11FF, U+3130-318F' },
    en: { name: '英文',     preview: 'The quick brown fox jumps',     range: 'U+0020-007E, U+00A0-01A0, U+01B1-024F, U+1E00-1E9F, U+2000-206F, U+2070-209F, U+20A0-20BF, U+2100-214F' },
    ru: { name: '俄文',     preview: 'Весенний ветер, цветение',      range: 'U+0400-04FF, U+0500-052F' },
    th: { name: '泰文',     preview: 'ลมฤดูใบไม้ผลิ เบ่งบาน',           range: 'U+0E00-0E7F, U+0E80-0EFF' },
    ar: { name: '阿拉伯文', preview: 'ريح الربيع، الأزهار تتفتح',      range: 'U+0600-06FF, U+0750-077F, U+FB50-FDFF, U+FE70-FEFF' },
    vi: { name: '越南文',   preview: 'Gió mùa xuân, hoa nở rộ',        range: 'U+01A0-01B0, U+1EA0-1EFF' },
    hi: { name: '印地文',   preview: 'वसंत हवा, फूल खिलते हैं',          range: 'U+0900-097F, U+A8E0-A8FF' },
    el: { name: '希腊文',   preview: 'Ανοιξιάτικος αέρας, άνθηση',     range: 'U+0370-03FF, U+1F00-1FFF' }
};

const MULTILANG_FAMILY = 'MultiLangFont';

/* ★ 每种语言使用独立的字体族名：避免把所有语言的 @font-face/FontFace 挤进同一个
   'MultiLangFont' 家族，导致语言之间按 unicode-range 互相覆盖或失败后回退到错误字体
   （典型症状：英文自定义字体不生效、非英语种预设字体统一显示楷体） */
const langFamilyName = (langCode) => MULTILANG_FAMILY + '-' + langCode;

const PERFORMANCE_PROFILES = {
    high: {
        name: '高性能',
        description: '流畅运行所有视效与全量特效',
        background: { dynamicBg: true, swayEnabled: true, swayAmp: 12, swayDuration: 16, blur: 60 },
        lyrics: { blurLevel: 8, showTranslation: true, showRomaji: true },
        interface: { glassStrength: 40, compactMode: false },
        animation: { crossfadeDuration: 800, colorExtract: true },
        flyin: { maxActiveBlocks: 16, enableGlow: true, enable3DDepth: true, blurFx: true },
        wordcloud: { maxParticles: 60, updateIntervalMs: 16, enableRandomDrift: true },
        floating: { parallaxLayers: 5, precisionSample: 'high' },
        pv: { renderDpr: 1.25, maxParticles: 120, enableBloom: true, bufferCleanupMs: 15000 },
        /* ★ 流光隧道 / 浮空 / 和鸣（原分档缺失，现补齐，供各引擎全量消费） */
        tunnel: { particleCount: 60, depthDpr: 2, decorLevel: 3, dofEnabled: true, animBlur: true },
        dimension: { particleScale: 1, shadowEnabled: true, canvasDpr: 2, bgLayers: 3 },
        polyphony: { maxBubbles: 30, glow: 10 },
        /* ★ 全局视觉效果模糊/粒子矩阵：各模式共享的降级开关，供设置项手动调整与 CSS/引擎读取 */
        vfx: { renderScale: 1, coverBlur: 60, glassBlur: 40, lyricBlur: 8, textBlur: 6, pvBloom: true, flyinGlow: true, wcParticles: true, tunnelParticles: true, dimParticles: true, polyGlow: 10 },
        memory: { maxProbeCache: 50, aggressiveGC: false }
    },
    medium: {
        name: '中性能',
        description: '平衡画质与流畅度，适中资源占用',
        background: { dynamicBg: true, swayEnabled: true, swayAmp: 8, swayDuration: 20, blur: 40 },
        lyrics: { blurLevel: 5, showTranslation: true, showRomaji: true },
        interface: { glassStrength: 25, compactMode: false },
        animation: { crossfadeDuration: 500, colorExtract: true },
        flyin: { maxActiveBlocks: 10, enableGlow: true, enable3DDepth: false, blurFx: true },
        wordcloud: { maxParticles: 40, updateIntervalMs: 33, enableRandomDrift: true },
        floating: { parallaxLayers: 3, precisionSample: 'medium' },
        pv: { renderDpr: 1.0, maxParticles: 60, enableBloom: false, bufferCleanupMs: 10000 },
        tunnel: { particleCount: 40, depthDpr: 1.5, decorLevel: 2, dofEnabled: true, animBlur: true },
        dimension: { particleScale: 0.8, shadowEnabled: false, canvasDpr: 1.5, bgLayers: 2 },
        polyphony: { maxBubbles: 20, glow: 6 },
        vfx: { renderScale: 0.9, coverBlur: 40, glassBlur: 25, lyricBlur: 5, textBlur: 4, pvBloom: false, flyinGlow: true, wcParticles: true, tunnelParticles: true, dimParticles: true, polyGlow: 6 },
        memory: { maxProbeCache: 30, aggressiveGC: false }
    },
    low: {
        name: '低性能',
        description: '大幅降低视觉与内存开销，提升流畅度',
        background: { dynamicBg: true, swayEnabled: false, swayAmp: 0, swayDuration: 20, blur: 20 },
        lyrics: { blurLevel: 0, showTranslation: true, showRomaji: false },
        interface: { glassStrength: 15, compactMode: false },
        animation: { crossfadeDuration: 300, colorExtract: false },
        flyin: { maxActiveBlocks: 6, enableGlow: false, enable3DDepth: false, blurFx: false },
        wordcloud: { maxParticles: 20, updateIntervalMs: 60, enableRandomDrift: false },
        floating: { parallaxLayers: 2, precisionSample: 'low' },
        pv: { renderDpr: 0.75, maxParticles: 30, enableBloom: false, bufferCleanupMs: 5000 },
        tunnel: { particleCount: 20, depthDpr: 1, decorLevel: 1, dofEnabled: false, animBlur: false },
        dimension: { particleScale: 0.5, shadowEnabled: false, canvasDpr: 1, bgLayers: 1 },
        polyphony: { maxBubbles: 12, glow: 4 },
        vfx: { renderScale: 0.75, coverBlur: 20, glassBlur: 12, lyricBlur: 0, textBlur: 0, pvBloom: false, flyinGlow: false, wcParticles: false, tunnelParticles: false, dimParticles: false, polyGlow: 4 },
        memory: { maxProbeCache: 15, aggressiveGC: true }
    },
    minimal: {
        name: '极简',
        description: '极低内存与GPU占用，专注极速播放',
        background: { dynamicBg: false, swayEnabled: false, swayAmp: 0, swayDuration: 20, blur: 0 },
        lyrics: { blurLevel: 0, showTranslation: false, showRomaji: false },
        interface: { glassStrength: 10, compactMode: true },
        animation: { crossfadeDuration: 200, colorExtract: false },
        flyin: { maxActiveBlocks: 4, enableGlow: false, enable3DDepth: false, blurFx: false },
        wordcloud: { maxParticles: 12, updateIntervalMs: 100, enableRandomDrift: false },
        floating: { parallaxLayers: 1, precisionSample: 'minimal' },
        pv: { renderDpr: 0.6, maxParticles: 10, enableBloom: false, bufferCleanupMs: 3000 },
        tunnel: { particleCount: 0, depthDpr: 1, decorLevel: 0, dofEnabled: false, animBlur: false },
        dimension: { particleScale: 0.3, shadowEnabled: false, canvasDpr: 1, bgLayers: 0 },
        polyphony: { maxBubbles: 8, glow: 0 },
        vfx: { renderScale: 0.6, coverBlur: 0, glassBlur: 8, lyricBlur: 0, textBlur: 0, pvBloom: false, flyinGlow: false, wcParticles: false, tunnelParticles: false, dimParticles: false, polyGlow: 0 },
        memory: { maxProbeCache: 8, aggressiveGC: true }
    }
};

const DROPDOWN_OPTIONS = {
    defaultPlayMode: [
        { value: 'sequence', label: '顺序播放' },
        { value: 'loop', label: '单曲循环' },
        { value: 'random', label: '随机播放' }
    ],
    defaultRate: [
        { value: '0.5', label: '0.5x' },
        { value: '0.75', label: '0.75x' },
        { value: '1', label: '1x' },
        { value: '1.25', label: '1.25x' },
        { value: '1.5', label: '1.5x' },
        { value: '2', label: '2x' }
    ],
    defaultEqPreset: [
        { value: 'default', label: '默认' },
        { value: 'pop', label: '流行' },
        { value: 'rock', label: '摇滚' },
        { value: 'jazz', label: '爵士' },
        { value: 'classical', label: '古典' },
        { value: 'electronic', label: '电子' },
        { value: 'light', label: '轻音乐' },
        { value: 'vocal', label: '人声' },
        { value: 'bass', label: '重低音' },
        { value: 'metal', label: '金属' }
    ],
    fontFamily: [
        { value: 'default', label: '默认' },
        { value: 'serif', label: '宋体' },
        { value: 'kai', label: '楷体' },
        { value: 'hei', label: '黑体' },
        { value: 'fangsong', label: '仿宋' },
        { value: 'mono', label: '等宽字体' }
    ],
    aiProvider: [
        { value: 'openai', label: 'OpenAI 官方/兼容' },
        { value: 'deepseek', label: 'DeepSeek (深度求索)' },
        { value: 'gemini', label: 'Google Gemini' },
        { value: 'openrouter', label: 'OpenRouter 聚合网关' },
        { value: 'z-ai', label: '智谱 AI (GLM / Z-AI)' },
        { value: 'aliyun', label: '阿里云百炼 (通义千问)' },
        { value: 'minimax', label: 'MiniMax / 海螺' },
        { value: 'hunyuan', label: '腾讯混元 (Hunyuan)' },
        { value: 'nvidia', label: 'NVIDIA NIM' },
        { value: 'custom', label: '自定义 (OpenAI 兼容)' }
    ],
    language: [
        { value: 'zh-CN', label: '简体中文' },
        { value: 'en-US', label: 'English' }
    ],
    qqPlaybackQuality: [
        { value: '128', label: '标准 128kbps' },
        { value: '320', label: '高品质 320kbps' },
        { value: 'flac', label: '无损 FLAC' },
        { value: 'atmos', label: '全景声' },
        { value: 'master', label: '臻品母带' }
    ],
    qqDownloadQuality: [
        { value: '128', label: '标准 128kbps' },
        { value: '320', label: '高品质 320kbps' },
        { value: 'flac', label: '无损 FLAC' },
        { value: 'atmos', label: '全景声' },
        { value: 'master', label: '臻品母带' }
    ],
    neteasePlaybackQuality: [
        { value: 'standard', label: '标准' },
        { value: 'higher', label: '较高' },
        { value: 'exhigh', label: '极高' },
        { value: 'lossless', label: '无损' },
        { value: 'hires', label: 'Hi-Res' }
    ],
    neteaseDownloadQuality: [
        { value: 'standard', label: '标准' },
        { value: 'higher', label: '较高' },
        { value: 'exhigh', label: '极高' },
        { value: 'lossless', label: '无损' },
        { value: 'hires', label: 'Hi-Res' }
    ],
    kugouPlaybackQuality: [
        { value: '128', label: '标准 128kbps' },
        { value: '320', label: '高品质 320kbps' },
        { value: 'flac', label: '无损 FLAC' },
        { value: 'high', label: '超高解析 / 母带' }
    ],
    kugouDownloadQuality: [
        { value: '128', label: '标准 128kbps' },
        { value: '320', label: '高品质 320kbps' },
        { value: 'flac', label: '无损 FLAC' },
        { value: 'high', label: '超高解析 / 母带' }
    ]
};

const CUSTOM_COLOR_SVG = `<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M511.97 0.07c96.04 0 185.89 26.45 262.72 72.44l-6.74-3.84-127.95 221.64A254.79 254.79 0 0 0 511.97 256.05V0.07z" fill="#E70212"/><path d="M767.95 68.67a509.58 509.58 0 0 1 191.3 194.12l-3.92-3.74-221.64 127.99a257.26 257.26 0 0 0-93.69-93.69L767.95 68.67z" fill="#EA6101"/><path d="M955.33 256.05a509.58 509.58 0 0 1 68.6 263.75v-7.77h-255.98a254.79 254.79 0 0 0-34.26-127.99l221.64-127.99z" fill="#F39801"/><path d="M1023.93 512.03c0 90.02-23.25 174.67-64.04 248.18l-4.57 7.8-221.64-127.95c21.76-37.67 34.26-81.4 34.26-128.03v-0.04l255.98-0.04z" fill="#FCC902"/><path d="M733.69 640.03l221.64 127.99a509.66 509.66 0 0 1-179.53 182.9l-7.85 4.48-127.99-221.64a257.26 257.26 0 0 0 93.69-93.69z" fill="#FEF200"/><path d="M640 733.76l127.95 221.64A509.66 509.66 0 0 1 521.01 1024h-9.04v-255.98a254.79 254.79 0 0 0 128.03-34.26z" fill="#90C320"/><path d="M511.97 768.02v255.98c-90.02 0-174.67-23.25-248.18-64.04l-7.8-4.57 127.99-221.64c37.67 21.76 81.4 34.26 128.03 34.26z" fill="#019A44"/><path d="M383.97 733.76l-127.99 221.64a509.66 509.66 0 0 1-182.9-179.53l-4.48-7.85 221.64-127.99a257.26 257.26 0 0 0 93.69 93.69z" fill="#019E97"/><path d="M255.98 512.03c0 46.63 12.46 90.36 34.26 128.03L68.6 768.02A509.66 509.66 0 0 1 0 521.08v-9.05h255.98z" fill="#0169B8"/><path d="M68.6 256.05l221.64 127.99A254.79 254.79 0 0 0 255.98 512.03H0c0-90.02 23.25-174.67 64.04-248.18l4.57-7.8z" fill="#1C2089"/><path d="M262.68 64.75l-6.7 3.92 127.99 221.64A257.26 257.26 0 0 0 290.24 384.04L68.6 256.05A509.58 509.58 0 0 1 262.68 64.75z" fill="#621988"/><path d="M519.73 0.07h-7.77v255.98a254.79 254.79 0 0 0-128.03 34.26L255.98 68.67A509.58 509.58 0 0 1 519.73 0.07z" fill="#910783"/></svg>`;

if (typeof window !== 'undefined') {
    if (typeof ChorusDetector !== 'undefined') window.ChorusDetector = ChorusDetector;
    if (typeof AIAnalyzer !== 'undefined') window.AIAnalyzer = AIAnalyzer;
    window.localMusicManager = localMusicManager;
    window.appSettings = appSettings;
}

/* ========== 初始化 DOM 缓存 ========== */
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        if (typeof document !== "undefined") document.addEventListener('DOMContentLoaded', () => initDom());
    } else {
        initDom();
    }
}

/* ========== 歌词数据 ========== */
const apiResponse = {};

globalThis.currentViewMode = 'cover';

globalThis.pvEngineInstance = null;

globalThis.tunnelEngineInstance = null;

/* ========== P1 全局状态收敛：注册中心清单 ==========
   向 core/globalRegistry.js 登记本文件注册的全部全局键（P1 审计统计：76 键）。
   registerGlobal 只登记不改值 —— 既有裸赋值/裸读取协议完全不受影响；
   multiWrite:true 的键为跨分片多处写入状态（当前TrackIndex/播放数据/歌词等），
   由 999-global-audit.js 在启动末尾打日志提示，不改动行为。 */
registerGlobal('wcCacheSeq', { owner: '10-config-state' });
registerGlobal('wcScrollRef', { owner: '10-config-state' });
registerGlobal('wcContainerRef', { owner: '10-config-state' });
registerGlobal('wcZoomTimer', { owner: '10-config-state' });
registerGlobal('wcBumpedIdx', { owner: '10-config-state' });
registerGlobal('wordcloudCamCache', { owner: '10-config-state' });
registerGlobal('wordcloudLayoutVer', { owner: '10-config-state' });
registerGlobal('isUserScrolling', { owner: '10-config-state' });
registerGlobal('wcLastTransform', { owner: '10-config-state' });
registerGlobal('lyricsColorStyleEl', { owner: '10-config-state' });
registerGlobal('fadeInVolumeTimeoutId', { owner: '10-config-state' });
registerGlobal('activeCoverIndex', { owner: '10-config-state' });
registerGlobal('currentScrollY', { owner: '10-config-state' });
registerGlobal('lastWordProgress', { owner: '10-config-state' });
registerGlobal('wordHighlightElementsByLine', { owner: '10-config-state' });
registerGlobal('eqInited', { owner: '10-config-state' });
registerGlobal('eqSourceNode', { owner: '10-config-state' });
registerGlobal('eqFilterNodes', { owner: '10-config-state' });
registerGlobal('searchHintEl', { owner: '10-config-state' });
registerGlobal('fadeOutVolumeTimeoutId', { owner: '10-config-state' });
registerGlobal('fadeInVolumeRafId', { owner: '10-config-state' });
registerGlobal('fadeOutVolumeRafId', { owner: '10-config-state' });
registerGlobal('bgGen', { owner: '10-config-state' });
registerGlobal('coverGen', { owner: '10-config-state' });
registerGlobal('wcSuppressClick', { owner: '10-config-state' });
registerGlobal('wordcloudCurrentScale', { owner: '10-config-state' });
registerGlobal('wordcloudCurrentX', { owner: '10-config-state' });
registerGlobal('wordcloudCurrentY', { owner: '10-config-state' });
registerGlobal('wcDragState', { owner: '10-config-state' });
registerGlobal('wordcloudLayoutDone', { owner: '10-config-state' });
registerGlobal('lineElements', { owner: '10-config-state' });
registerGlobal('activeBgIndex', { owner: '10-config-state' });
registerGlobal('eqInitFailed', { owner: '10-config-state' });
registerGlobal('searchResultsCache', { owner: '10-config-state' });
registerGlobal('lyricSourceOverride', { owner: '10-config-state' });
registerGlobal('isLoadingSong', { owner: '10-config-state' });
registerGlobal('currentTime', { owner: '10-config-state', multiWrite: true });
registerGlobal('activeLineIndex', { owner: '10-config-state' });
registerGlobal('lyricOffset', { owner: '10-config-state' });
registerGlobal('playbackGeneration', { owner: '10-config-state' });
registerGlobal('nextSongPreload', { owner: '10-config-state' });
registerGlobal('_preloadedLyricData', { owner: '10-config-state' });
registerGlobal('retryCount', { owner: '10-config-state' });
registerGlobal('currentPlaylistId', { owner: '10-config-state' });
registerGlobal('playlistViewMode', { owner: '10-config-state' });
registerGlobal('currentAiTheme', { owner: '10-config-state', multiWrite: true });
registerGlobal('wordElementsByLine', { owner: '10-config-state' });
registerGlobal('currentAiAbortController', { owner: '10-config-state' });
registerGlobal('isAiAnalyzing', { owner: '10-config-state' });
registerGlobal('wcTween', { owner: '10-config-state' });
registerGlobal('lyrics', { owner: '10-config-state', multiWrite: true });
registerGlobal('aiEmotionWords', { owner: '10-config-state', multiWrite: true });
registerGlobal('preservesPitch', { owner: '10-config-state' });
registerGlobal('currentPlaybackRate', { owner: '10-config-state' });
registerGlobal('mainVisManager', { owner: '10-config-state' });
registerGlobal('pendingPlayAfterPreload', { owner: '10-config-state' });
registerGlobal('audioCtx', { owner: '10-config-state' });
registerGlobal('currentSource', { owner: '10-config-state' });
registerGlobal('currentTrackIndex', { owner: '10-config-state', multiWrite: true });
registerGlobal('playlist', { owner: '10-config-state', multiWrite: true });
registerGlobal('preloadedSongReady', { owner: '10-config-state' });
registerGlobal('initSongStarted', { owner: '10-config-state' });
registerGlobal('currentSongKey', { owner: '10-config-state', multiWrite: true });
registerGlobal('currentSongData', { owner: '10-config-state', multiWrite: true });
registerGlobal('eqActivePreset', { owner: '10-config-state' });
registerGlobal('eqGains', { owner: '10-config-state' });
registerGlobal('volume', { owner: '10-config-state', multiWrite: true });
registerGlobal('playMode', { owner: '10-config-state' });
registerGlobal('localSongsCache', { owner: '10-config-state' });
registerGlobal('appSettings', { owner: '10-config-state' });
registerGlobal('customFonts', { owner: '10-config-state' });
registerGlobal('multilangFontFaces', { owner: '10-config-state' });
registerGlobal('advFontsGeneration', { owner: '10-config-state' });
registerGlobal('currentViewMode', { owner: '10-config-state' });
registerGlobal('pvEngineInstance', { owner: '10-config-state' });
registerGlobal('tunnelEngineInstance', { owner: '10-config-state' });

export { CUSTOM_COLOR_SVG, DROPDOWN_OPTIONS, FONT_FAMILY_MAP, FONT_LOCAL_NAMES, LANG_INFO, LYRIC_FONT_MAP, MULTILANG_FAMILY, PERFORMANCE_PROFILES, apiResponse, langFamilyName, localMusicManager };
