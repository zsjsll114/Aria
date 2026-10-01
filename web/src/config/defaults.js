/** config/defaults.js — 默认配置 */
/* 默认强调色指向 config/themePalette.js 的 DEFAULT_ACCENT：色板只有一份，
   这里再写字面量就会出现「改了色板但新装用户还是旧金色」的分裂。 */
import { DEFAULT_ACCENT } from './themePalette.js';
export const DEFAULT_SONG = {
    id: '2716424334',
    mid: '',
    song: 'T氏の話を信じるな (feat. 初音ミク & 重音テト)',
    singer: 'ピノキオピー/初音ミク/重音テト',
    cover: 'https://p3.music.126.net/DmrEz0M4GwSeISIReCNNgw==/109951171319581237.jpg',
    source: 'netease',
    url: 'https://music.163.com/song/media/outer/url?id=2716424334'
};

export const playerConfig = {
    songTitle: '嘘つきは恋のはじまり',
    songArtist: '洛天依',
    coverUrl: 'https://p2.music.126.net/8i-fh32MJD0mbOAAoiaCNw==/109951170729335255.jpg',
    initialVolume: 80,
    enableBlurBackground: true
};

export const DEFAULT_SHORTCUTS = {
    playPause: ' ', prev: 'ArrowLeft', next: 'ArrowRight',
    volumeUp: 'F3', volumeDown: 'F2',
    favorite: 'f', toggleLyrics: 'l', more: 'm'
};
export const DEFAULT_SETTINGS = {
    playback: {
        initialVolume: 80,
        defaultPlayMode: 'sequence',
        defaultRate: 1,
        preservesPitch: true,
        autoPlayNext: true,
        fadeInOut: false,
        fadeDuration: 300,
        retryOnFail: true,
        retryCount: 3
    },
    lyrics: {
        fontSize: 1.0,
        blurLevel: 8,
        highlightColor: '#ffffff',
        highlightInactiveColor: 'rgba(255,255,255,0.6)',
        inactiveColor: '#ffffff',
        align: 'left',
        showTranslation: true,
        showRomaji: true,
        autoScroll: true,
        /* 开关1：只有行级时间戳的歌词，要不要按行时长摊平成逐字（约束 17 的合成兜底）。
           关掉就是整行一起跳——有人觉得摊出来的节拍反而晃眼。
           ★ 只对 PER_CHAR_MODES 那三个模式生效，见 config/wordPerChar.js。 */
        perCharFromLineLyrics: true,
        /* 开关2：当前是行级歌词时，去其它音源找 >90% 文本匹配的逐字版并替换。
           开了就把开关1 让位（宁可整行一跳，也不要贴一份编出来的节拍）。 */
        autoUpgradeWordLyrics: false
    },
    background: {
        dynamicBg: true,
        swayEnabled: true,
        swayAmp: 12,
        swayDuration: 16,
        blur: 60,
        brightness: 0.35
    },
    interface: {
        language: 'zh-CN',
        glassStrength: 40,
        compactMode: false,
        /* 「动效强度」滑杆（todos #6）：0~100，null = 跟随性能等级（不覆盖任何 vfx 键）。
           刻意挂在 interface 下——180 的 loadSettings 只全量展开 interface/shortcuts，
           顶层新键不补合并块就会重启后被静默丢掉（AGENTS.md 约束 11）。 */
        vfxIntensity: null,
        lyricWidth: 'medium',
        lyricRadius: 12,
        themeColor: DEFAULT_ACCENT,
        fontFamily: 'default',
        desktopLyrics: { fontSize: 34, fontFamily: 'default', emotionWords: true },
        advancedFonts: {
            enabled: false,
            fonts: {}
        }
    },
    audio: {
        defaultEqPreset: 'default',
        volumeNorm: false
    },
    sleepTimer: {
        lastMinutes: 30,
        lastCustomMinutes: 0
    },
    nowPlaying: {
        enabled: false,
        url: 'http://localhost:9863/api/query',
        interval: 5,
        autoFollow: true
    },
    quality: {
        qqPlayback: '320',
        qqDownload: 'flac',
        neteasePlayback: 'exhigh',
        neteaseDownload: 'lossless',
        kugouPlayback: '320',
        kugouDownload: 'flac'
    },
    shortcuts: { ...DEFAULT_SHORTCUTS },
    modeSettings: {
        cover: {
            align: 'left', fontSize: 1.0, blurLevel: 5,
            highlightColor: '#ffffff', highlightInactiveColor: 'rgba(255,255,255,0.6)', inactiveColor: '#ffffff',
            showTranslation: true, showRomaji: true,
            themeColor: DEFAULT_ACCENT, bgBlur: 60, bgBrightness: 0.35,
            swayEnabled: true, swayAmp: 12, swayDuration: 16, fontFamily: 'default', emotionGlow: 10
        },
        lyrics: {
            align: 'center', fontSize: 1.0, blurLevel: 5,
            highlightColor: '#ffffff', highlightInactiveColor: 'rgba(255,255,255,0.6)', inactiveColor: '#ffffff',
            showTranslation: true, showRomaji: true,
            themeColor: DEFAULT_ACCENT, bgBlur: 60, bgBrightness: 0.35,
            swayEnabled: true, swayAmp: 12, swayDuration: 16, fontFamily: 'default', emotionGlow: 10
        },
        flyin: {
            align: 'center', fontSize: 1.0, blurLevel: 5,
            highlightColor: '#ffffff', showTranslation: true, showRomaji: true,
            themeColor: DEFAULT_ACCENT, bgBlur: 80, bgBrightness: 0.12,
            swayEnabled: true, swayAmp: 12, swayDuration: 16, fontFamily: 'default',
            flyinTranslateY: 14, flyinScale: 0.8, flyinGlow: 8, flyinTransSize: 15, flyinTransBottom: 16, emotionGlow: 10
        },
        wordcloud: {
            align: 'center', fontSize: 1.0, blurLevel: 5,
            highlightColor: '#ffffff', showTranslation: true, showRomaji: true,
            themeColor: DEFAULT_ACCENT, bgBlur: 60, bgBrightness: 0.35,
            swayEnabled: true, swayAmp: 12, swayDuration: 16, fontFamily: 'default',
            wordcloudFov: 60, wordcloudMinFont: 14, wordcloudMaxFont: 36, wordcloudDepth: 400, emotionGlow: 10
        },
        pv: {
            align: 'center', fontSize: 1.5, blurLevel: 5,
            highlightColor: '#ffffff', showTranslation: true, showRomaji: true,
            themeColor: DEFAULT_ACCENT, graphicColor: DEFAULT_ACCENT, bgBlur: 60, bgBrightness: 0.35,
            swayEnabled: true, swayAmp: 12, swayDuration: 16, fontFamily: 'default',
            preset: 'dream', cameraSpeed: 1.0, cameraZoom: 1.0, showHud: true, showParticles: true, showDecorations: true, aiColorSync: true, emotionGlow: 10
        },
        tunnel: {
            align: 'center', fontSize: 1.1, blurLevel: 5,
            highlightColor: '#ffffff', showTranslation: true, showRomaji: true,
            themeColor: DEFAULT_ACCENT, graphicColor: DEFAULT_ACCENT, bgBlur: 60, bgBrightness: 0.35,
            swayEnabled: true, swayAmp: 12, swayDuration: 16, fontFamily: 'default',
            cameraSpeed: 1.0, cameraDamping: 0.045, transitDuration: 450, rowGap: 90,
            showStreaks: true, showEcho: true, aiColorSync: true, emotionGlow: 12,
            /* ★ 蒙德里安排版模式：false=横平竖直（默认，无旋转只留字号差）；true=活泼（允许词块倾斜） */
            mosaicTilt: false
        },
        dimension: {
            fontSize: 1.3, highlightColor: '#ffffff', themeColor: DEFAULT_ACCENT,
            showTranslation: true, showRomaji: true, fontFamily: 'default', emotionGlow: 10
        },
        /* ★ 活字 Letterpress：fontSize 为 px（与 pv/dimension 一致），
           设置面板的字体/字号才能落到这个模式上 */
        letterpress: {
            fontSize: 1.0, highlightColor: '#ffffff', themeColor: DEFAULT_ACCENT,
            showTranslation: true, fontFamily: 'default', emotionGlow: 12
        },
        /* ★ 霓虹 Neon Sign：fontSize 为乘数（基准 4.4vw）；emotionGlow
           控制点亮字符最外层光晕的扩散半径 */
        neon: {
            fontSize: 1.0, highlightColor: '#ffffff', themeColor: DEFAULT_ACCENT,
            showTranslation: true, fontFamily: 'default', emotionGlow: 14
        },
        /* ★ 版画 Tempera（2026-10-01 补设置面板）：fontSize 乘基准引擎字号；
           cameraIntensity/glyphMotion 对齐上游 DEFAULT_TEMPERA_TUNING；
           布尔项直通 tuning（textInversion/showBlocks/showDecor/showCornerMarks/enableTransitions） */
        tempera: {
            fontSize: 1.0, highlightColor: '#ffffff', themeColor: DEFAULT_ACCENT,
            fontFamily: 'default',
            cameraIntensity: 1.0, glyphMotion: 1.0,
            textInversion: true, showBlocks: true, showDecor: true,
            showCornerMarks: true, enableTransitions: true
        },
        /* ★ 长卷 Scroll（2026-10-01 补设置面板）：fontSize 乘卷面基准字号（屏高 8%）；
           scrollSpeed 为时间→空间推进倍率；showChapters 控制章节色带 */
        scroll: {
            fontSize: 1.0, scrollSpeed: 1.0, highlightColor: '#ffffff',
            themeColor: DEFAULT_ACCENT, showChapters: true, fontFamily: 'default', emotionGlow: 10
        }
    },
    ai: {
        provider: 'openai',
        apiKey: '',
        apiBase: '',
        model: '',
        enabled: false,
        providerConfigs: {
            openai:     { apiKey: '', apiBase: '', model: 'gpt-4o-mini' },
            deepseek:   { apiKey: '', apiBase: '', model: 'deepseek-chat' },
            gemini:     { apiKey: '', apiBase: 'https://zsjsll-cf.de5.net', model: 'gemini-3.5-flash-lite' },
            openrouter: { apiKey: '', apiBase: '', model: 'google/gemini-2.0-flash-exp:free' },
            'z-ai':     { apiKey: '', apiBase: '', model: 'glm-4-flash' },
            aliyun:     { apiKey: '', apiBase: '', model: 'qwen-plus' },
            minimax:    { apiKey: '', apiBase: '', model: 'MiniMax-Text-01' },
            hunyuan:    { apiKey: '', apiBase: '', model: 'hunyuan-standard' },
            nvidia:     { apiKey: '', apiBase: '', model: 'meta/llama-3.3-70b-instruct' },
            custom:     { apiKey: '', apiBase: '', model: 'gpt-4o-mini' }
        }
    }
};
