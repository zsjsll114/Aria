/* ============================================================
 * eslint.config.mjs — Aria 播放器 ESLint 扁平配置（v10 flat config）
 *
 * 策略（对齐项目六大约束）：
 * 1. 全局键协议：10-config-state.js 用 `globalThis.x = ...` 建立状态，
 *    其余分片裸标识符读写（浏览器全局 env 解析链）。no-undef 必须把
 *    这些键（+ window.* 挂载 + CDN 注入 + Tauri 运行时）显式声明为
 *    globals，否则误报。清单来源见 PROJECT_GLOBAL_KEYS 注释。
 *    写入侧另有「棘轮白名单」封增量（见下方门禁 B），只减不增。
 * 2. 日志唯一出口：全库只允许 services/log.js 直接 console.*，
 *    其余经 logInfo/logWarn/logError；吞掉异常处一律 logCatch(tag, e)
 *    （按 tag+错误信息 5s 去重，所以热路径也能无脑留痕）。
 *    no-console 在 web/src 开启，对 log.js 用 files 覆盖豁免（off）。
 * 3. HTML 插值必须转义：自定义规则 aria/no-unescaped-html（实现见
 *    scripts/eslint-rules/），拦「模板里有标签 + ${} 插的是文本数据」。
 *    转义唯一入口是 utils/formatters.js 的 escapeHtml（别名 esc）。
 * 4. 影子层封存：9 个「从入口不可达」的未接线模块禁止被 import（见门禁 A）。
 *    复扫工具 scripts/audits/module-reachability.mjs。
 * 5. 状态单一来源：性能分档等配置只在 config/ 里定义一份；
 *    裸全局键的写入面用棘轮白名单锁死（见门禁 B）。
 * 6. 门禁策略：存量代码带历史债，no-unused-vars 先按 warn 放行
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
import noUnescapedHtml from './scripts/eslint-rules/no-unescaped-html.mjs';

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
    'lyricsColorStyleEl', 'activeCoverIndex', 'currentScrollY',
    'lastWordProgress', 'wordHighlightElementsByLine', 'eqInited', 'eqSourceNode',
    'eqFilterNodes', 'searchHintEl',
    'bgGen', 'coverGen', 'wcSuppressClick', 'wordcloudCurrentScale',
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
        plugins: {
            aria: {
                rules: {
                    'no-unescaped-html': noUnescapedHtml,
                },
            },
        },
        rules: {
            ...js.configs.recommended.rules,

            /* ---- 硬约束（error）---- */
            'no-undef': 'error',                    // 拼写错误 / 漏导入拦截（全局键白名单在上）
            'no-console': 'error',                  // 日志唯一出口：只有 services/log.js 豁免（下方 files 覆盖）
            'eqeqeq': ['error', 'smart'],           // 严格相等（允许 == null 短路）
            'aria/no-unescaped-html': 'error',      // HTML 插值转义门禁（见文件头策略 3）
            /* 空块/空 catch 一律阻断（2026-09-25 收口：129 处静默 catch 已全部改为
               services/log.js 的 logCatch 留痕）。有意吞掉的异常必须写注释——
               no-empty 天然放过含注释的块，所以「静默」只能以「写明理由」的形式存在。 */
            'no-empty': ['error', { allowEmptyCatch: false }],

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

    /* ---------- 门禁 A：影子层封存 ----------
     * 下列模块经 scripts/audits/module-reachability.mjs 判定「从入口 web/src/app/index.js
     * 静态不可达」——运行期根本不加载，改它们不生效，是「改了错的那一份」事故的温床。
     * 按 2026-09-25 的决定：不删（docs/模块化重构方案.md 把它们列为目标架构），原地冻结 +
     * 禁止存活模块 import，防止半接线。文件头有封存注释与活实现指路。
     * 解冻流程（stallDetector / fadeController / shortcutManager / equalizer 已走完）：
     * 先由 infrastructure/globalBridge.js 收口 state 与 globalThis 双写 → 以分片活实现为准
     * 重新抽取 core 模块（旧快照缺活实现后来补的修复，别直接接线）→ 从本名单移除 →
     * 补 tests/js 行为测试并进 CI → 跑 4 套 playwright + 浏览器实测。剩余 4 个，复扫
     * `node scripts/audits/module-reachability.mjs`。 */
    {
        files: ['web/src/**/*.js'],
        rules: {
            'no-restricted-imports': ['error', {
                patterns: [
                    {
                        group: [
                            '**/core/audioPlayer.js',
                            '**/services/favoritesService.js', '**/services/playlistService.js',
                            '**/services/fontService.js',
                        ],
                        message: '该模块从入口不可达（未接线的影子层），改动不会生效，活实现见其文件头封存注释。确需接线：先修 state.xxx 与 globalThis 的双写，再连同本条规则一起改。',
                    },
                ],
            }],
        },
    },

    /* ---------- 门禁 B：globalThis 裸键写入棘轮 ----------
     * 「globalThis.x = ... 建立状态 + 裸标识符跨分片读写」是既有协议（10-config-state 登记
     * 76 键，另散布在 30 个分片）。整体迁移风险过高，所以先封增量：新文件不得再加裸全局写，
     * 状态请走所属模块的 export/import。下面白名单 = 2026-09-25 当天已有的 30 个写入分片，
     * 只减不增；每迁走一个就从白名单删一个。 */
    {
        files: ['web/src/**/*.js'],
        rules: {
            'no-restricted-syntax': ['error',
                {
                    selector: 'AssignmentExpression[left.object.name="globalThis"]',
                    message: '禁止新增 globalThis 裸键写入。状态请由所属模块 export、使用方 import；确需全局共享时改到 10-config-state.js 登记（registerGlobal + 同步本文件 PROJECT_GLOBAL_KEYS），并把键的读写收敛到单一 owner 分片。',
                },
                {
                    selector: 'UpdateExpression[left.object.name="globalThis"]',
                    message: '禁止新增 globalThis 裸键自增/自减（同 AssignmentExpression 规则）。',
                },
                {
                    selector: 'CallExpression[callee.object.name="Object"][callee.property.name="assign"][arguments.0.name="globalThis"]',
                    message: '禁止 Object.assign(globalThis, ...) 批量注入裸键：绕过 registerGlobal 登记与类型审计。',
                },
            ],
        },
    },
    {
        /* 棘轮白名单：2026-09-25 已存在的 30 个裸全局写入分片（只减不增） */
        files: [
            'web/src/app/000-aria-ns.js', 'web/src/app/10-config-state.js', 'web/src/app/110-keyboard-nav.js',
            'web/src/app/130-playlists.js', 'web/src/app/135-crossfade.js', 'web/src/app/140-playlist-ui-events.js',
            'web/src/app/150-search-engine.js', 'web/src/app/155-random-toast-match.js', 'web/src/app/165-audio-recognize.js',
            'web/src/app/170-lyric-sources.js', 'web/src/app/175-track-index-online.js', 'web/src/app/180-boot-config.js',
            'web/src/app/20-lyrics-render.js', 'web/src/app/201-settings-ai.js', 'web/src/app/210-color-multilang.js',
            'web/src/app/215-multilang-fonts.js', 'web/src/app/220-shortcuts-viewmode.js', 'web/src/app/240-titlebar.js',
            'web/src/app/245-playlist-manager.js', 'web/src/app/258-rankings.js', 'web/src/app/259-selfhost-favorites.js',
            'web/src/app/40-playback-state.js', 'web/src/app/57-wordcloud-camera.js', 'web/src/app/60-mobile-dual-page.js',
            'web/src/app/70-audio-engine.js', 'web/src/app/80-context-menu.js', 'web/src/app/95-track-loading.js',
            'web/src/app/999-global-audit.js', 'web/src/core/globalRegistry.js', 'web/src/core/i18n.js',
        ],
        rules: {
            'no-restricted-syntax': 'off',
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