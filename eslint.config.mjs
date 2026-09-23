/* ============================================================
 * eslint.config.mjs — Aria 播放器 ESLint 扁平配置（v10 flat config）
 *
 * 策略（对齐项目三大约束）：
 * 1. 全局键协议：10-config-state.js 用 `globalThis.x = ...` 建立状态，
 *    其余分片裸标识符读写（浏览器全局 env 解析链）。no-undef 必须把
 *    这些键（+ window.* 挂载 + CDN 注入 + Tauri 运行时）显式声明为
 *    globals，否则误报。清单来源见 PROJECT_GLOBAL_KEYS 注释。
 * 2. 日志唯一出口：全库只允许 services/log.js 直接 console.*，
 *    其余经 logInfo/logWarn/logError。no-console 在 web/src 开启，
 *    对 log.js 用 files 覆盖豁免（off）。
 * 3. 门禁策略：存量代码带历史债，no-unused-vars 先按 warn 放行
 *    （不清账不阻断）；no-undef / no-console / no-var / eqeqeq
 *    属硬约束按 error。存量零错误后可逐步把 warn 提到 error。
 *
 * 用法：
 *   npx eslint web/src          # 检查
 *   npx eslint --fix ...        # 自动修复（no-console 之类不自动改）
 *   npm run lint / lint:fix     # scripts 别名
 * ============================================================ */
import js from '@eslint/js';
import globals from 'globals';

/* ---------- 项目自有全局键（no-undef 白名单） ----------
 * 1) globalThis.* 赋值键（10-config-state 注册 76 键 + 各分片散布键）
 * 2) window.* 挂载键（函数入口 / 单例 / 跨分片握手）
 * 3) CDN 注入：Segmentit / kuromoji（web/index.html async script）
 * 4) Tauri 运行时：__TAURI__ / __TAURI_API_ORIGIN（Rust 端注入，勿迁移）
 * 说明：新加全局键时在此追加一行即被 no-undef 认可；更严格的
 *       「键必须注册」审计由 999-global-audit.js 运行时兜底。
 */
const PROJECT_GLOBAL_KEYS = [
    // ---- 10-config-state 注册的状态键（globalThis 裸引用协议） ----
    'wcCacheSeq', 'wcScrollRef', 'wcContainerRef', 'wcZoomTimer', 'wcBumpedIdx',
    'wordcloudCamCache', 'wordcloudLayoutVer', 'isUserScrolling', 'wcLastTransform',
    'lyricsColorStyleEl', 'fadeInVolumeTimeoutId', 'activeCoverIndex', 'currentScrollY',
    'lastWordProgress', 'wordHighlightElementsByLine', 'eqInited', 'eqSourceNode',
    'eqFilterNodes', 'searchHintEl', 'fadeOutVolumeTimeoutId', 'fadeInVolumeRafId',
    'fadeOutVolumeRafId', 'bgGen', 'coverGen', 'wcSuppressClick', 'wordcloudCurrentScale',
    'wordcloudCurrentX', 'wordcloudCurrentY', 'wcDragState', 'wordcloudLayoutDone',
    'lineElements', 'activeBgIndex', 'eqInitFailed', 'searchResultsCache',
    'lyricSourceOverride', 'isLoadingSong', 'currentTime', 'activeLineIndex', 'lyricOffset',
    'playbackGeneration', 'nextSongPreload', '_preloadedLyricData', 'retryCount',
    'currentPlaylistId', 'playlistViewMode', 'currentAiTheme', 'wordElementsByLine',
    'currentAiAbortController', 'isAiAnalyzing', 'wcTween', 'lyrics', 'aiEmotionWords',
    'preservesPitch', 'currentPlaybackRate', 'mainVisManager', 'pendingPlayAfterPreload',
    'audioCtx', 'currentSource', 'currentTrackIndex', 'playlist', 'preloadedSongReady',
    'initSongStarted', 'currentSongKey', 'currentSongData', 'eqActivePreset', 'eqGains',
    'volume', 'playMode', 'localSongsCache', 'appSettings', 'customFonts',
    'multilangFontFaces', 'advFontsGeneration', 'currentViewMode', 'pvEngineInstance',
    'tunnelEngineInstance',
    // ---- 各分片 globalThis.* 散布键 ----
    '__autoRefill', '__listGlobals', '__wcCamSettled', '__wcSetCam',
    '_configSaveDebounceTimer', '_isLocalBackendAvailable', '_playLocalTrackOnReady',
    'colorPickerCallback', 'ctxConfirmCallback', 'ctxSubmenuEl', 'currentChorusSegments',
    'fontDB', 'fullChorusSegments', 'globalToastEl', 'globalToastTimer', 'isBuffering',
    'isImportingPlaylist', 'isLyricsLoopRunning', 'isLyricSwitching', 'isPlaying',
    'isRecordingAudio', 'kbCurrentGroup', 'kbCurrentIndex', 'kbNavActive', 'kbNavTimer',
    'lastFormattedTime', 'lastLoadedSongInfo', 'lastPercent', 'lastSearchKeyword',
    'lyricsRafId', 'plMultiEdit', 'plMultiSel', 'preloadAbortFlag',
    'previewEngineInstance', 'randomFetchCount', 'randomFetchResetTime', 'recAnalyser',
    'recAnimFrameId', 'recAudioChunks', 'recAudioContext', 'recMediaRecorder',
    'recMediaStream', 'recordingShortcut', 'recStartTime', 'recTimerInterval',
    'saveQueueMode', 'scrollTimeout', 'searchPage', 'searchPageCache', 'searchPagingBusy',
    'stallCheckGeneration', 'stallLastTime', 'stallTimer', 'submenuHideTimer',
    'triggerPostLoadTasks', 'updateVolume', 'wordcloudCanvasH', 'wordcloudCanvasW',
    // ---- window.* 挂载键（函数入口/单例/握手） ----
    'Aria', 'AIAnalyzer', 'ChorusDetector', 'aiClient', 'applicationCache',
    'applyEmotionWordColors', 'backToBoards', 'batchDownloadSongs', 'closeRecent',
    'closeSelfFavorites', 'copyEqShareCode', 'coverPalette', 'debugEmotionWords',
    'detectChorus', 'dominantColor', 'getPerfVfx', 'getRecentHistory', 'importEqShareCode',
    'localMusicManager', 'mergePlaylistInto', 'openBoard', 'openRecent', 'openSelfFavorites',
    'openSelfHostLogin', 'parseYrc', 'playerAudioAnalyser', 'playerLoudnessComp',
    'playLocalMusicSong', 'preloadNextSong', 'recordPlayStats', 'recordRecentPlay',
    'renderChorusMarkers', 'resetListScroll', 'resolveFontFamily', 'saveEqPreset',
    'showGlassAlert', 'showGlassConfirm', 'showGlassPick', 'showGlassPrompt',
    'showLyricSourceModal', 'showToast', 'switchAppearanceMode', 'switchLyricSource',
    'switchSettingsTab', 'syncConfigToBackend', 'triggerAiAnalysisIfNeeded',
    'updateAIProviderUI', '_dtkPosCfgT', '_lyricDlData', '_wcMainLayoutTimer',
    '_wcSaveTimer', 'BG_CROSSFADE_DURATION',
    // ---- CDN 注入 + Tauri 运行时 ----
    'Segmentit', 'kuromoji', '__TAURI__', '__TAURI_API_ORIGIN',
    // ---- globalThis.audio（audio 元素实例，10-config-state 挂载，PV/均衡器等裸引用） ----
    'audio',
    // ---- 跨分片握手函数（定义方嵌在闭包内未导出；引用方用 typeof 探测守护，
    //      运行时若不存在则静默跳过——属项目既有防御模式，白名单声明避免误报） ----
    'showAiPanel', 'hideAiPanel', 'setAiPanelDone', 'applyAITheme',
    'updateAiSettingsPreview', 'initPreviewEngine', 'updateAiProviderUI',
    'currentEditingMode',
];

const projectGlobals = {};
for (const k of PROJECT_GLOBAL_KEYS) {
    projectGlobals[k] = 'writable';
}

export default [
    { ignores: ['node_modules/**', '_eval/**', 'web/node_modules/**', 'dist/**', 'build/**',
                /* 同源托管的第三方浏览器构建（segmentit / kuromoji），压缩单行、非自有代码，
                   不参与 lint（否则 3.8MB 的 vendor 会拖垮 npm run lint） */
                'web/src/vendor/**'] },

    // ---------- web 前端（浏览器环境 + 项目全局键） ----------
    {
        files: ['web/src/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...projectGlobals,
            },
        },
        plugins: {},
        rules: {
            ...js.configs.recommended.rules,

            /* ---- 硬约束（error）---- */
            'no-undef': 'error',                    // 拼写错误 / 漏导入拦截（全局键白名单在上）
            'no-console': 'error',                  // 日志唯一出口：只有 services/log.js 豁免（下方 files 覆盖）
            'eqeqeq': ['error', 'smart'],           // 严格相等（允许 == null 短路）

            /* ---- 存量债务（warn，先清零再提 error）---- */
            'no-unused-vars': [
                'warn',
                { varsIgnorePattern: '^_', argsIgnorePattern: '^_' },
            ],
            'no-var': 'off',                         // var 历史遗留不参与自动修复（var→let 有作用域语义差异，清账须人工）；如需提示改为 warn 但不建议 --fix
            'no-useless-escape': 'warn',            // 正则字符类内冗余转义，行为等价
            'no-useless-assignment': 'warn',        // 防御性初始化赋值冗余
            'no-redeclare': 'warn',                 // var 语义下的重复声明（模块化改造后自动消失）
            'no-control-regex': 'warn',             // 文件名净化/ASCII 判定的 \x00-\x1f 范围是数据清洗的正规用途
            'no-empty': ['warn', { allowEmptyCatch: true }],
            'no-constant-condition': ['warn', { checkLoops: false }],

            /* ---- 关闭的推荐项（项目风格/运行时依赖） ---- */
            'no-prototype-builtins': 'off',     // 常见 .hasOwnProperty 直调
            'no-useless-catch': 'off',          // 包装层保留错误签名
            'no-case-declarations': 'off',      // switch 内 let 声明（存量多）
            'no-fallthrough': 'off',            // 播放器 switch 分支有有意穿透
        },
    },

    // ---------- services/log.js 豁免 no-console（唯一直接 console.* 使用点） ----------
    {
        files: ['web/src/services/log.js'],
        rules: {
            'no-console': 'off',
        },
    },

    // ---------- 双环境文件（浏览器 + Node 测试/打包共用）：Node 探测分支需 module/require/exports ----------
    {
        files: [
            'web/src/core/chorusDetector.js',
            'web/src/core/pvEngine/WordSegmenter.js',
        ],
        languageOptions: {
            globals: {
                module: 'readonly',
                exports: 'readonly',
                require: 'readonly',
            },
        },
    },

    // ---------- Node 侧（scripts / tests/js，commonjs 或 ESM node） ----------
    {
        files: ['scripts/**/*.js', 'scripts/**/*.mjs', 'tests/js/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.node,
            },
        },
        rules: {
            ...js.configs.recommended.rules,
            'no-undef': 'error',
            'no-unused-vars': ['warn', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
            'no-console': 'off',
        },
    },
];