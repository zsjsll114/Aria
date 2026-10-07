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
        /* ★ 起播淡入（需求 18，2026-10-06）：默认开。点播放 / 切歌 / 从暂停恢复时
           音量在 100~300ms 内从 0 平滑升到设定值（时长夹取在 core/fadeController.js）。
           与 fadeInOut（切歌淡入淡出）是**两个独立偏好**：本项开启时，若 fadeInOut
           也开着，则**让位**给后者（它已经在做淡入），避免两套斜坡抢写 audio.volume。
           落地：core/fadeController.js 的 fadeInOnStart() + app/307-start-fade.js。 */
        startFade: true,
        /* Automix 智能交叉混音（Automix-技术方案.md）：默认关——开启后本地/缓存源
           在歌尾自动进入等功率交叉，在线源 v1 仍走原生 ended。 */
        automix: { enabled: false },
        retryOnFail: true,
        retryCount: 3,
        /* ★ 听力健康提醒（需求 16，2026-10-05）：默认开。连续播放 2 小时或音量
           ≥85% 累计 30 分钟时弹一条温和提示（底部 toast，2 秒自动淡出），
           **不打断播放、不自动降音量**。判定在 core/hearingGuard.js。 */
        hearingGuard: true,
        /* ★ 练习模式变速（需求 15，2026-10-05）：默认关。开启后速度固定到
           `practiceRate`（0.5×~2.0×，0.05 一档），并**强制 preservesPitch=false** ——
           独占路径的变速是 Rust 侧的线性重采样（音色随速度变，像黑胶），
           Web 侧必须一致，否则两条路径听感不同。控制面在 app/85-rate-download.js。 */
        practiceMode: false,
        practiceRate: 1
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
        brightness: 0.35,
        /* MV 动态背景（搜索结果里点 MV 卡片 → 铺满整窗循环播放）。
           默认开：点 MV 卡片本身就是一次明确动作，开着才有"点了就有反应"。
           mvDim 是压暗比例(0~0.9)、mvBlur 是模糊像素(0~30)，
           二者都作用在 video 的内联 filter 上，见 app/101-mv-background.js。 */
        mvBg: true,
        mvDim: 0.45,
        mvBlur: 8,
        /* MV 画质增强（2026-10-04）：Anime4K Restore+Upscale 的 WebGL 上行渲染。
           MV 直链普遍只有 768x432 级别的低码率，铺满窗口后模糊/噪点明显 ——
           默认开。见 services/mvUpscale.js 与 app/103-mv-upscale.js。
           ★ 判定一律用 `!== false`（缺省即开）—— user_config.json 里的 background
           是整对象覆盖，老配置没有这个键时不能因此变成"关"。 */
        mvUpscale: true,
        /* Anime4K 强度档（2026-10-04 用户需求「自行选择 S、M、L 强度」）。
           S = 9 pass 最轻 / M = 17 / L = 19 最重（细节最强，也最容易把噪点当细节锐出来，
           且明显更吃 GPU）。缺省 S：跑不动时它最不容易触发降级闸。
           ★ 与 mvUpscale 同样**不能用"缺省即关"的判定**：老配置没有这个键时必须回落 S，
             见 app/103-mv-upscale.js 的 currentTier()（非法值一律回落 S）。 */
        mvUpscaleTier: 'S',
        /* 音画偏移矫正（2026-10-04 用户报「感觉还是音画不同步…歌曲和 MV 的歌词总是
           差了一句左右的时间」）。自动算出 MV 音轨相对歌曲音轨的恒定偏移，把画面
           seek 到对齐的位置。成本：每首自动匹配的 MV 会多下 ≤12MB 做包络分析
           （只取文件头，见 services/mvSync.js 的 ANALYZE_MAX_BYTES）。
           默认开 —— 这个能力本来就是用户提的；担心流量/CPU 时可在设置里关掉。
           ★ 缺省即开，判定一律 `!== false`（老配置没有这个键时不能变成"关"）。 */
        mvSync: true
    },
    interface: {
        language: 'zh-CN',
        glassStrength: 40,
        compactMode: false,
        /* 「动效强度」滑杆（todos #6）：0~100，null = 跟随性能等级（不覆盖任何 vfx 键）。
           刻意挂在 interface 下——180 的 loadSettings 只全量展开 interface/shortcuts，
           顶层新键不补合并块就会重启后被静默丢掉（AGENTS.md 约束 11）。 */
        vfxIntensity: null,
        /* 能量微动效（需求 19）：低频强时封面轻微放大（硬上限 +2%）+ 光晕增强再回弹。
           默认开；但没有音频能量来源时完全静止（见 app/306-energy-motion.js 的头注释）。
           挂在 interface 下 —— 180 的 loadSettings 只全量展开 interface/shortcuts，
           顶层新键不补合并块会被静默丢掉（AGENTS.md 约束 11）。 */
        energyMotion: true,
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
        volumeNorm: false,
        /* ★ 虚拟声场（P1，2026-10-05，方案 §8 用户拍板）：
           ① 默认关（false）；② 档位枚举 off|light|medium，**无 high**（不上跨耳抵消）。
           落地见 core/spatialTuning.js（档位→参数的唯一源）与 core/equalizer.js 插点。 */
        virtualStage: false,
        stageStrength: 'light',
        /* ★ 空间音频（P2，2026-10-05）：双耳 HRTF 卷积，dry/wet 并联。
           ① 默认关；② 档位 off|light|medium|strong（wet 0.35/0.60/0.85）；
           ③ IR 预设 near|hall|wide（方案 §8.3 用户拍板「多组可选」）。
           WASAPI 独占下由 Rust 侧承担（native_audio_set_spatial），不再置灰。
           ★ 与虚拟声场各自独立开关（用户拍板「两个独立开关 + 档位」）。 */
        spatialAudio: false,
        spatialStrength: 'light',
        spatialIr: 'near',
        /* ★ 输出声道（需求 20）：stereo（默认）/ mono / left / right / swap。
           纯声道矩阵，接在链路最末端（compressor 之后）。stereo 逐样本透明。 */
        channelMode: 'stereo'
    },
    /* ★ 自动备份（需求 23，2026-10-05）：默认关（要用户选文件夹才有意义）。
       lastAt 是上次成功备份的时间戳，用于按间隔触发。目录句柄另存 IndexedDB
       `aria_backup`（句柄是结构化克隆对象，塞不进 user_config.json）。 */
    backup: {
        autoEnabled: false,
        intervalHours: 24,
        lastAt: 0
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
        /* ★ 字面 · Jizura（2026-10-06）：JIZURA 引擎移植（MIT © 2026 hakoniwa）。
           `style` 是上游 27 套风格的键（J.STYLE_ORDER，默认 noir）；
           res/fps 决定分镜设计尺寸与动画时基（24fps、on twos 取 12 拍，上游默认）；
           `fast: null` 表示"按性能档自动"（低配/软件渲染自动关滤镜与色差通道）。
           fontSize 为乘数口径（与 letterpress/neon 一致），但本模式画布字号由引擎
           自持，这里只用于与其他模式共享的通用设置不至于缺键。 */
        jizura: {
            fontSize: 1.0, highlightColor: '#ffffff', themeColor: DEFAULT_ACCENT,
            showTranslation: true, fontFamily: 'default', emotionGlow: 12,
            /* ★ 这里**没有 res**（2026-10-07 撤掉）：引擎的画幅由 aspect 决定 ——
               `08_planner.js:283 const [W,H] = J.designSize(project.aspect)`，
               而 `J.designSize = (aspect) => …` 按 aspect 返回硬编码尺寸（16:9 → 1920×1080），
               全程没人读 project.res。曾经它是个"改了没反应"的面板项（用户报障），
               真正控制像素量的旋钮是 perf（DPR/渲染倍率）。 */
            style: 'noir', mood: null, aspect: '16:9', fps: 24, fast: null,
            /* ★ beat：动画节拍。'every' = **逐帧**（每个输出帧一张，节拍 = fps）；
               'onTwos' = 引擎原味「一拍两格」（koma=12，12 张/秒）。
               默认 'every' —— 上游默认是 onTwos，实测画面变化率只有 32/s 且单帧仅 4.2ms，
               余量很大；用户要的也是"顺"而不是"省"（2026-10-06 决定）。
               落地：JizuraVisualizer 把它翻成引擎的 fx.koma/onTwos 并纳入 plan 指纹；
               帧节流也跟着走引擎的 stepDur（koma>0 → 按 koma Hz 采样，不白渲）。 */
            beat: 'every',
            /* wordSync：按真实字时间切分镜。**默认 off**（2026-10-07 用户实测：本引擎
               一个 cut 就是一次分镜，切字 = 把一行拆成多个画面，切到每字一块观感崩）。
               面板只暴露 off / cuts 两档，且文案写明"会把一行切成多个分镜"。 */
            wordSync: 'off',
            /* 画面细节（引擎 fx）：六个 0~1 数值 + flash/hud。默认值与上游
               `J.defaultProject().fx` 对齐。★ 面板按**单键**下发（一个 data-var 一个键），
               由 core/visualizers/jizura/jizuraBridge.js 的 collectJizuraFx 收敛成 fx 对象；
               改这里的键必须同步 vfxRecipe 的 MODE_FIELD_POOL 与 190 的兜底表。 */
            motion: 0.7, glitch: 0.55, chroma: 0.7, decor: 0.5,
            density: 0.55, texture: 0.6, flash: true, hud: 'auto',
            /* ★ fontFamily 的语义在本模式与其它模式**相反方向**，别照抄：
               'default' / 'inherit' / '' = **不覆写**，用引擎自带的角色字体（那 27 套风格
               本来就是围绕日文字面设计的，缺字自动回落到系统字体）；
               给具体字体（键或整条 CSS 栈）= 覆写字形链，只换 family、保留各角色 weight。
               见 core/visualizers/jizura/jizuraBridge.js 的 applyJizuraFontOverride。 */
            /* perf：面板上的性能档。auto = 按实测帧耗时自动升降清晰度（推荐）；
               eco = 钉在最低档（省电优先）；hd = DPR 上限放到 2（高 DPI 屏更锐利，更吃显卡）。
               ★ 默认 auto 且 DPR 上限为 1 —— 实测 dpr2 单帧 43.5ms（≈23fps）而 dpr1 是 11.0ms。 */
            perf: 'auto'
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
