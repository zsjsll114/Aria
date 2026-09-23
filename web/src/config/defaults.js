/** config/defaults.js — 默认配置 */
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
        autoScroll: true
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
        lyricWidth: 'medium',
        lyricRadius: 12,
        themeColor: '#ffcc33',
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
            themeColor: '#ffcc33', bgBlur: 60, bgBrightness: 0.35,
            swayEnabled: true, swayAmp: 12, swayDuration: 16, fontFamily: 'default', emotionGlow: 10
        },
        lyrics: {
            align: 'center', fontSize: 1.0, blurLevel: 5,
            highlightColor: '#ffffff', highlightInactiveColor: 'rgba(255,255,255,0.6)', inactiveColor: '#ffffff',
            showTranslation: true, showRomaji: true,
            themeColor: '#ffcc33', bgBlur: 60, bgBrightness: 0.35,
            swayEnabled: true, swayAmp: 12, swayDuration: 16, fontFamily: 'default', emotionGlow: 10
        },
        flyin: {
            align: 'center', fontSize: 1.0, blurLevel: 5,
            highlightColor: '#ffffff', showTranslation: true, showRomaji: true,
            themeColor: '#ffcc33', bgBlur: 80, bgBrightness: 0.12,
            swayEnabled: true, swayAmp: 12, swayDuration: 16, fontFamily: 'default',
            flyinTranslateY: 14, flyinScale: 0.8, flyinGlow: 8, flyinTransSize: 15, flyinTransBottom: 16, emotionGlow: 10
        },
        wordcloud: {
            align: 'center', fontSize: 1.0, blurLevel: 5,
            highlightColor: '#ffffff', showTranslation: true, showRomaji: true,
            themeColor: '#ffcc33', bgBlur: 60, bgBrightness: 0.35,
            swayEnabled: true, swayAmp: 12, swayDuration: 16, fontFamily: 'default',
            wordcloudFov: 60, wordcloudMinFont: 14, wordcloudMaxFont: 36, wordcloudDepth: 400, emotionGlow: 10
        },
        pv: {
            align: 'center', fontSize: 1.5, blurLevel: 5,
            highlightColor: '#ffffff', showTranslation: true, showRomaji: true,
            themeColor: '#ffcc33', graphicColor: '#ffcc33', bgBlur: 60, bgBrightness: 0.35,
            swayEnabled: true, swayAmp: 12, swayDuration: 16, fontFamily: 'default',
            preset: 'dream', cameraSpeed: 1.0, cameraZoom: 1.0, showHud: true, showParticles: true, showDecorations: true, aiColorSync: true, emotionGlow: 10
        },
        tunnel: {
            align: 'center', fontSize: 1.1, blurLevel: 5,
            highlightColor: '#ffffff', showTranslation: true, showRomaji: true,
            themeColor: '#ffcc33', graphicColor: '#ffcc33', bgBlur: 60, bgBrightness: 0.35,
            swayEnabled: true, swayAmp: 12, swayDuration: 16, fontFamily: 'default',
            cameraSpeed: 1.0, cameraDamping: 0.045, transitDuration: 450, rowGap: 90,
            showStreaks: true, showEcho: true, aiColorSync: true, emotionGlow: 12,
            /* ★ 蒙德里安排版模式：false=横平竖直（默认，无旋转只留字号差）；true=活泼（允许词块倾斜） */
            mosaicTilt: false
        },
        dimension: {
            fontSize: 1.3, highlightColor: '#ffffff', themeColor: '#ffcc33',
            showTranslation: true, showRomaji: true, fontFamily: 'default', emotionGlow: 10
        },
        /* ★ 活字 Letterpress：fontSize 为 px（与 pv/dimension 一致），
           设置面板的字体/字号才能落到这个模式上 */
        letterpress: {
            fontSize: 1.0, highlightColor: '#ffffff', themeColor: '#ffcc33',
            showTranslation: true, fontFamily: 'default', emotionGlow: 12
        },
        /* ★ 霓虹 Neon Sign：fontSize 为乘数（基准 4.4vw）；emotionGlow
           控制点亮字符最外层光晕的扩散半径 */
        neon: {
            fontSize: 1.0, highlightColor: '#ffffff', themeColor: '#ffcc33',
            showTranslation: true, fontFamily: 'default', emotionGlow: 14
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
