/* ============================================================
 * 200-settings-panel.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 9260-12644 行 | 单元数: 4
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { AI_PROVIDERS, EQ_STORAGE_KEY, FAV_STORAGE_KEY, FONT_DB_NAME, PLAYLIST_STORAGE_KEY, SETTINGS_STORAGE_KEY } from '../config/constants.js';
import { DEFAULT_SETTINGS, DEFAULT_SHORTCUTS } from '../config/defaults.js';
import { getBlurBgLayers } from '../infrastructure/dom.js';
import { formatTime } from '../utils/formatters.js';
import PreviewEngine from '../core/previewEngine.js';
import ChorusDetector from '../core/chorusDetector.js';
import { GEMINI_DEFAULT_BASE, GEMINI_DEFAULT_MODEL, cleanApiBase, extractGeminiText, formatGeminiError, testGeminiConnection } from '../services/aiClient.js';
import { aiCacheBulkSet, aiCacheClear, aiCacheCount, aiCacheGet, aiCacheGetAll, aiCacheSet, chorusCacheClear, chorusCacheCount, chorusCacheGet, chorusCacheSet } from '../services/aiCache.js';
import { buildEmotionSystemPrompt, buildAIRequest } from '../core/aiAnalyzer.js'; // ★ 情绪分析提示词与请求构建；排版分页已改程序化本地生成（proceduralLayout.js），LLM 只出情绪一路
import { audio, renderLyrics } from './20-lyrics-render.js';
import { searchResultsEl } from './30-dom-refs.js';
import { aiThemeCache } from './40-playback-state.js';
import { wcApplyLerpToTween, wcLerpToDuration } from './55-wc-tuning.js';
import { layoutWordCloud } from './56-playback-misc.js';
import { applyPreservesPitch } from './85-rate-download.js';
import { openEqPanel } from './90-eq.js';
import { getFavorites } from './120-search-results.js';
import { getPlaylists, playlistsHintEl } from './130-playlists.js';
import { saveSettings } from './180-boot-config.js';
import { applyBackgroundSettings, applyHighlightColor, applyInterfaceSettings, applyLyricAlign, applyLyricBlurLevel, applyLyricFontSize, applyModeSettings, applyThemeColor, setSettingValue } from './190-settings-fontsize.js';
import { applyFontFamily, applyGlassStrength, bindColorRow, openColorPicker } from './210-color-multilang.js';
import { buildAdvancedFontUI, initFontUploadBindings, loadFontFace, refreshAdvancedFontDropdowns, refreshFontDropdown, renderFontManagerUI, saveCustomFont, saveFontToDB } from './215-multilang-fonts.js';
import { downloadJSON, importData, initCustomDropdowns, initPerformanceSettings, initShortcutRecording, refreshSettingsUI, refreshShortcutUI, showSettingsHint } from './220-shortcuts-viewmode.js';
import { initSelfhostSection } from './selfhost-settings.js';
import { logInfo, logWarn, logError, logCatch } from '../services/log.js';
import { applyLyricSetting, applySharedSetting, ensureEmotionGlowSliders, buildAppearanceControls, showModeSection, bindAppearanceEvents, syncGlobalThemeSwatches, syncModeSectionValues, loadAiCacheFromDB } from './202-settings-appearance.js';
import { initSettingsAI } from './201-settings-ai.js'; // AI 域平铺绑定入口（initSettingsPanel 调用）
import { initNowPlayingSettings } from './232-nowplaying-follow.js'; // Now Playing 接管配置绑定（initSettingsMisc 调用；232→175→180→200 属既有分片环，运行时才解引用）
import { renderSettingsNav } from '../config/settingsNav.js'; // 设置声明式导航（分组侧栏唯一事实源）
import { conceal } from '../utils/motion.js'; // 分区交叉退场：演完才 display:none

/* ========== 全局选项卡与模式切换引擎 ========== */

function initSettingsPanel() {
            const overlay = typeof document !== 'undefined' ? document.getElementById('settingsOverlay') : null;
            const openBtn = typeof document !== 'undefined' ? document.getElementById('openSettingsBtn') : null;
            const closeBtn = typeof document !== 'undefined' ? document.getElementById('settingsCloseBtn') : null;
            const tabsEl = typeof document !== 'undefined' ? document.getElementById('settingsTabs') : null;
            const bodyEl = typeof document !== 'undefined' ? document.getElementById('settingsBody') : null;
            const panel = typeof document !== 'undefined' ? document.getElementById('settingsPanel') : null;
            const bodyWrapper = typeof document !== 'undefined' ? document.getElementById('settingsBodyWrapper') : null;

            /* ★ 声明式导航侧栏（settingsNav.js 唯一事实源）：渲染分组导航 +
               事件委托——替换原 13 份复制粘贴的内联 onclick。点击仍走
               window.switchSettingsTab（唯一收敛的切换函数，副作用全保留）。 */
            if (tabsEl && tabsEl.dataset.navReady !== '1') {
                tabsEl.dataset.navReady = '1';
                try { renderSettingsNav(tabsEl); } catch (e) { logWarn('settingsPanel', 'renderSettingsNav:', e); }
                tabsEl.addEventListener('click', (ev) => {
                    const btn = ev.target.closest('.settings-tab');
                    if (btn && window.switchSettingsTab) {
                        window.switchSettingsTab(btn.dataset.tab);
                        /* ★ 小项深搜跳转：有搜索词时滚到该节首个命中行并闪烁高亮 */
                        try {
                            const q = (tabsEl.querySelector('#settingsNavSearch') || {}).value || '';
                            if (q.trim().length >= 2 && bodyEl) {
                                setTimeout(() => {
                                    const first = bodyEl.querySelector('.settings-section.active .settings-hit');
                                    if (first) {
                                        first.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                        first.classList.add('settings-flash');
                                        setTimeout(() => first.classList.remove('settings-flash'), 1600);
                                    }
                                }, 60);
                            }
                        } catch (e) { logWarn('settingsPanel', 'deep-search jump:', e); }
                    }
                });
            }

                        /* 打开/关闭 */
            openBtn?.addEventListener('click', () => {
                overlay.classList.add('visible');
                panel.classList.add('fullscreen-mode');
                
                const activeTab = tabsEl?.querySelector('.settings-tab.active')?.dataset?.tab || 'appearance';
                if (bodyEl) {
                    bodyEl.querySelectorAll('.settings-section').forEach(s => {
                        if (s.dataset.section === activeTab) {
                            s.classList.add('active');
                            s.style.display = (activeTab === 'appearance') ? 'flex' : 'block';
                        } else {
                            s.classList.remove('active');
                            s.style.display = 'none';
                        }
                    });
                }

                initCustomDropdowns();
                refreshSettingsUI();
                if (activeTab === 'appearance') {
                    try { initPreviewEngine(); } catch(e) { logWarn('settingsPanel', e); }
                    try { buildAppearanceControls(); } catch(e) { logWarn('settingsPanel', e); }
                }
            });
            closeBtn?.addEventListener('click', () => {
                overlay.classList.remove('visible');
                /* 关闭时暂停预览引擎 */
                if (previewEngineInstance) {
                    previewEngineInstance.isPlaying = false;
                    previewEngineInstance.updatePlayIcon();
                }
            });

            /* ★ 重新打开新手引导向导 (OOBE) 事件绑定 */
            const triggerOobe = () => {
                if (overlay) overlay.classList.remove('visible');
                if (previewEngineInstance) {
                    previewEngineInstance.isPlaying = false;
                    previewEngineInstance.updatePlayIcon();
                }
                if (typeof window.showAriaOobe === 'function') {
                    window.showAriaOobe(true);
                }
            };
            document.getElementById('btnOpenOobeGuide')?.addEventListener('click', triggerOobe);
            document.getElementById('btnOpenOobeGuide2')?.addEventListener('click', triggerOobe);

            /* 点击遮罩关闭 */
            overlay?.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    overlay.classList.remove('visible');
                    if (previewEngineInstance) { previewEngineInstance.isPlaying = false; previewEngineInstance.updatePlayIcon(); }
                }
            });
            /* ESC 关闭 */
            if (typeof document !== "undefined") document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && overlay.classList.contains('visible')) {
                    overlay.classList.remove('visible');
                    if (previewEngineInstance) { previewEngineInstance.isPlaying = false; previewEngineInstance.updatePlayIcon(); }
                }
            });

            /* 设置选项卡的点击委托只留上面 navReady 那一份（同一个 tabsEl 上曾挂着第二个
               平行处理器，一次点击跑两遍 switchSettingsTab：第二遍会把正在淡出的
               分区立刻拍成 display:none，交叉退场就没了。i18n 已并入 switchSettingsTab）。 */

            /* 初始化自定义下拉与外观控件（appearanceControlsEl 已随外观域迁至 202-settings-appearance.js） */
            initCustomDropdowns();
            buildAppearanceControls();
            /* ★ i18n 静态文本应用（2026-09-22）：声明式词表扫描兜底，
               面板首次渲染后立即按当前语言出英文 */
            try {
                import('../core/i18n.js').then(m => m.applyLanguageToDocument()).catch((e) => logCatch('settingsPanel', e));
            } catch(e) { logWarn('settingsPanel', e); }
            /* ★ AI 域平铺绑定入口（原模块加载即执行，收敛为函数后在此调用一次，等价于原加载时机后的首次初始化） */
            try { initSettingsAI(); } catch(e) { logWarn('settingsPanel', 'initSettingsAI:', e); }


                        /* ★ 初始化外观设置 PreviewEngine + 右侧控件 */
            function initPreviewEngine() {
                const activeMode = (previewEngineInstance && previewEngineInstance.currentMode) || currentViewMode || 'cover';
                if (previewEngineInstance) {
                    /* 已存在：恢复播放 + 设置激活模式 + 重新构建控件面板 */
                    previewEngineInstance.isPlaying = true;
                    previewEngineInstance.startTime = performance.now() - (previewEngineInstance.lastTime || 0);
                    try { previewEngineInstance.setMode(activeMode); } catch (e) { logCatch('settingsPanel', e); }
                    previewEngineInstance.updatePlayIcon();
                    previewEngineInstance.loop();
                    buildAppearanceControls();
                    return;
                }
                const container = typeof document !== 'undefined' ? document.getElementById('lyricPreviewContainer') : null;
                if (!container || typeof PreviewEngine === 'undefined') {
                    logWarn('settingsPanel', 'PreviewEngine 未加载');
                    buildAppearanceControls();
                    return;
                }
                previewEngineInstance = new PreviewEngine(container, appSettings);
                previewEngineInstance.currentMode = activeMode;
                /* ★ 设置变更回调 — 同步到主播放器 appSettings 并调用 apply 函数 */
                previewEngineInstance.onSettingChange = function(name, value, mode) {
                    syncPreviewToMain(name, value, mode);
                };
                /* ★ 先构建控件面板（同步 modeVars 可用），再等待 init() 完成后同步控件值 */
                buildAppearanceControls();
                previewEngineInstance.init().then(() => {
                    logInfo('settingsPanel', 'PreviewEngine 初始化完成');
                    const curMode = document.querySelector('#lyricStyleControls .appearance-mode-btn.active')?.dataset?.mode || activeMode;
                    if (previewEngineInstance) {
                        try { previewEngineInstance.setMode(curMode); } catch (e) { logCatch('settingsPanel', e); }
                        /* ★ init 完成后重新同步控件值，确保预览 DOM 已就绪 */
                        try { buildAppearanceControls(); } catch (e) { logCatch('settingsPanel', e); }
                        try { syncModeSectionValues(curMode); } catch (e) { logCatch('settingsPanel', e); }
                    }
                }).catch((e) => {
                    logWarn('settingsPanel', 'PreviewEngine.init catch:', e);
                });
            }

            /* ★ 注册全局外观模式切换函数（在 initSettingsPanel 闭包内，可访问 previewEngineInstance） */
            window.switchAppearanceMode = function(mode) {
                if (!mode) return;
                logInfo('settingsPanel', '[switchAppearanceMode] mode=', mode, '| previewEngineInstance=', previewEngineInstance);
                // 同步右侧面板的数值
                try { syncModeSectionValues(mode); } catch(e) { logWarn('settingsPanel', '[SAM] syncModeSectionValues error:', e); }
                // 通知左侧预览引擎切换模式
                if (previewEngineInstance && typeof previewEngineInstance.setMode === 'function') {
                    try {
                        previewEngineInstance.setMode(mode);
                        logInfo('settingsPanel', '[switchAppearanceMode] setMode done, currentMode=', previewEngineInstance.currentMode);
                    } catch(err) {
                        logWarn('settingsPanel', '[PreviewEngine] setMode error:', err);
                    }
                } else {
                    logWarn('settingsPanel', '[switchAppearanceMode] previewEngineInstance NOT ready:', previewEngineInstance);
                }
            };

            /* ★ 注册全局主设置 Tab 切换函数（唯一生效版本；显隐切换收敛于此，
               供程序化跳转（如 130-playlists → selfhost 登录引导）与 onclick 共用） */
            window.switchSettingsTab = function(tabName) {
                if (!tabName) return;
                const tabsEl = typeof document !== 'undefined' ? document.getElementById('settingsTabs') : null;
                const bodyEl = typeof document !== 'undefined' ? document.getElementById('settingsBody') : null;
                if (tabsEl) {
                    tabsEl.querySelectorAll('.settings-tab').forEach(t => {
                        t.classList.toggle('active', t.dataset.tab === tabName);
                    });
                }
                if (bodyEl) {
                    /* 交叉替换：新分区立刻显示（下面的副作用也照旧同步跑），
                       旧分区先脱流淡出、演完再 display:none——见 motion.css .is-leaving。
                       连点时多个分区可能同时在退，各自一条 conceal，互不影响。 */
                    const next = bodyEl.querySelector('.settings-section[data-section="' + CSS.escape(tabName) + '"]');
                    const prev = bodyEl.querySelector('.settings-section.active');
                    const leaving = (prev && next && prev !== next) ? prev : null;
                    if (next && next.classList.contains('is-leaving')) {
                        /* 又切回正在退的那个：作废它的退场回调，否则会被藏掉 */
                        next.classList.remove('is-leaving');
                        if (next.__ariaConceal) next.__ariaConceal.superseded = true;
                    }
                    if (leaving) leaving.classList.replace('active', 'is-leaving');
                    bodyEl.querySelectorAll('.settings-section').forEach(s => {
                        if (s.dataset.section === tabName) {
                            s.classList.add('active');
                            s.style.setProperty('display', (tabName === 'appearance') ? 'flex' : 'block', 'important');
                        } else if (s !== leaving) {
                            s.classList.remove('active');
                            s.style.setProperty('display', 'none', 'important');
                        }
                    });
                    if (leaving) {
                        conceal(leaving, {
                            onHidden: () => {
                                leaving.style.setProperty('display', 'none', 'important');
                                leaving.classList.remove('is-leaving');
                            }
                        });
                    }
                    bodyEl.scrollTop = 0;
                }
                if (tabName === 'appearance') {
                    try { initPreviewEngine(); } catch(e) { logWarn('settingsPanel', e); }
                    try { buildAppearanceControls(); } catch(e) { logWarn('settingsPanel', e); }
                } else {
                    if (previewEngineInstance) {
                        previewEngineInstance.isPlaying = false;
                        try { previewEngineInstance.updatePlayIcon(); } catch (e) { logCatch('settingsPanel', e); }
                    }
                    try { initCustomDropdowns(); } catch (e) { logCatch('settingsPanel', e); }
                    try { refreshSettingsUI(); } catch (e) { logCatch('settingsPanel', e); }
                    if (tabName === 'selfhost') {
                        try { initSelfhostSection(); } catch(e) { logWarn('settingsPanel', e); }
                    }
                    if (tabName === 'fonts') {
                        try { renderFontManagerUI(); } catch (e) { logCatch('settingsPanel', e); }
                        try { buildAdvancedFontUI(); } catch (e) { logCatch('settingsPanel', e); }
                        try { initFontUploadBindings(); } catch (e) { logCatch('settingsPanel', e); }
                        try { refreshFontDropdown(); } catch (e) { logCatch('settingsPanel', e); }
                    }
                }
                /* ★ 语言包应用：每个 Tab 的 DOM 都是动态渲染的，切换后对新节点补跑一次
                   静态文本映射。从原重复 Tab 处理器搬进来——放这里程序化跳转
                   （130-playlists 直接调 switchSettingsTab('selfhost')）才同样享受到。 */
                try {
                    import('../core/i18n.js').then(mi => mi.applyLanguageToDocument()).catch((e) => logCatch('settingsPanel', e));
                } catch (e) { logWarn('settingsPanel', e); }
            };

            /* ★ 预览设置 → 主播放器同步映射（每种视图模式完全独立隔离存储） */
            function syncPreviewToMain(name, value, mode) {
                try {
                    if (!appSettings.modeSettings) appSettings.modeSettings = { cover:{}, lyrics:{}, flyin:{}, wordcloud:{}, pv:{} };
                    if (!appSettings.modeSettings[mode]) appSettings.modeSettings[mode] = {};
                    
                    /* ★ 全局共享设置 — 同时写入对应全局配置并立即应用 */
                    if (name === 'glassStrength') {
                        appSettings.interface.glassStrength = parseInt(value);
                        applyGlassStrength(appSettings.interface.glassStrength);
                    } else if (name === 'themeColor') {
                        /* ★ 主题色必须保存到 interface.themeColor，并应用到页面控件 */
                        appSettings.interface.themeColor = value;
                        appSettings.modeSettings[mode].themeColor = value;
                        applyThemeColor(value);
                        syncGlobalThemeSwatches(value);
                    } else if (name === 'bgBlur') {
                        appSettings.background.blur = parseInt(value);
                        appSettings.modeSettings[mode][name] = value;
                        applyBackgroundSettings();
                    } else if (name === 'bgBrightness') {
                        appSettings.background.brightness = parseFloat(value);
                        appSettings.modeSettings[mode][name] = value;
                        applyBackgroundSettings();
                    } else if (name === 'swayEnabled') {
                        appSettings.background.swayEnabled = value;
                        appSettings.modeSettings[mode][name] = value;
                        applyBackgroundSettings();
                    } else if (name === 'swayAmp') {
                        appSettings.background.swayAmp = parseInt(value);
                        appSettings.modeSettings[mode][name] = value;
                        applyBackgroundSettings();
                    } else if (name === 'swayDuration') {
                        appSettings.background.swayDuration = parseInt(value);
                        appSettings.modeSettings[mode][name] = value;
                        applyBackgroundSettings();
                    } else {
                        /* ★ 模式独立设置 — 写入当前模式的独立存储 */
                        /* fontSize 迁移：旧像素值 → 倍率 */
                        if (name === 'fontSize') {
                            let scale = parseFloat(value);
                            if (isNaN(scale)) scale = 1.0;
                            if (scale > 3) scale = scale / 24;
                            value = scale;
                        }
                        appSettings.modeSettings[mode][name] = value;
                        
                        /* ★ 词云字号/密度变更：轻量快速路径，跳过重型 applyModeSettings */
                        if (mode === 'wordcloud' && (name === 'wcFontMin' || name === 'wcFontMax' || name === 'wcDensity')) {
                            /* 仅更新 CSS 变量 */
                            if (typeof document !== 'undefined') {
                                const root = document.documentElement;
                                if (name === 'wcFontMin') root.style.setProperty('--wc-font-min', value + 'rem');
                                if (name === 'wcFontMax') root.style.setProperty('--wc-font-max', value + 'rem');
                                if (name === 'wcDensity') root.style.setProperty('--wc-density', value + 'px');
                            }
                            /* 防抖重布局：拖动时不触发，停止 300ms 后才重新排版 */
                            const playerContainer = typeof document !== 'undefined' ? document.querySelector('.player-container:not(.preview-player)') : null;
                            const isWordcloud = playerContainer && playerContainer.classList.contains('view-wordcloud');
                            if (isWordcloud) {
                                if (window._wcMainLayoutTimer) clearTimeout(window._wcMainLayoutTimer);
                                window._wcMainLayoutTimer = setTimeout(() => {
                                    window._wcMainLayoutTimer = null;
                                    layoutWordCloud();
                                }, 300);
                            }
                            /* 防抖保存（拖动时不频繁写入） */
                            if (window._wcSaveTimer) clearTimeout(window._wcSaveTimer);
                            window._wcSaveTimer = setTimeout(() => { saveSettings(); }, 500);
                            return;
                        }

                        /* ★ 词云纯视觉参数快速通道：跳过重型 applyModeSettings
                           （其会对齐/模糊/颜色/背景/情感词全量重应用，拖动滑块时每帧执行是卡顿主因）。
                           这些参数仅靠 CSS 变量或相机每帧实时读取生效。 */
                        if (mode === 'wordcloud' && (name === 'wcLerpFactor' || name === 'wcDimBlur' || name === 'wcDimOpacity')) {
                            const root = typeof document !== 'undefined' ? document.documentElement : null;
                            if (name === 'wcDimBlur' && root) root.style.setProperty('--wc-dim-blur', value + 'px');
                            if (name === 'wcDimOpacity' && root) root.style.setProperty('--wc-dim-opacity', value);
                            /* 相机阻尼：主播放器相机每帧直接读取 appSettings，无需任何应用动作；
                               仅需让进行中的补间立即采用新时长（保持进度平滑过渡） */
                            if (name === 'wcLerpFactor') {
                                const pc = typeof document !== 'undefined' ? document.querySelector('.player-container:not(.preview-player)') : null;
                                if (pc && pc.classList.contains('view-wordcloud')) {
                                    wcApplyLerpToTween(wcTween, wcLerpToDuration(value));
                                }
                            }
                            /* 防抖保存（拖动时不频繁序列化/写 localStorage） */
                            if (window._wcSaveTimer) clearTimeout(window._wcSaveTimer);
                            window._wcSaveTimer = setTimeout(() => { saveSettings(); }, 500);
                            return;
                        }
                        
                        /* 仅当主播放器当前处于被修改模式时才实时应用到主界面 */
                        const playerContainer = typeof document !== 'undefined' ? document.querySelector('.player-container:not(.preview-player)') : null;
                        let mainMode = 'cover';
                        if (playerContainer) {
                            const modes = ['dimension', 'letterpress', 'neon', 'pv', 'tunnel', 'flyin', 'wordcloud', 'lyrics', 'cover'];
                            for (const m of modes) {
                                if (playerContainer.classList.contains(`view-${m}`)) {
                                    mainMode = m;
                                    break;
                                }
                            }
                        }
                        
                        if (mainMode === mode) {
                            applyModeSettings(mode);
                        }
                    }
                    saveSettings();
                } catch (e) { logWarn('settingsPanel', '[Appearance] 同步设置到主播放器失败:', e); }
            }

            /* ★ 应用单个歌词设置到主播放器 */
                        /* ============================================================
               外观控制域已迁移至 202-settings-appearance.js：
               applyLyricSetting / applySharedSetting / ensureEmotionGlowSliders /
               buildAppearanceControls / showModeSection / bindAppearanceEvents /
               syncGlobalThemeSwatches / syncModeSectionValues / loadAiCacheFromDB
               （loadAiCacheFromDB() 调用随迁，模块加载时执行）
               ============================================================ */
/* ★ 暴露到 window：refreshSettingsUI 与 initSettingsPanel 是同级作用域，
               无法直接访问闭包内的 syncModeSectionValues，否则抛 ReferenceError */
            Aria.__syncModeSectionValues = syncModeSectionValues;

            /* ★ aiCache* / chorusCache* 已收敛到 services/aiCache.js（唯一属主，幂等建
               aiThemeCache+chorusCache 双 store），本地不再重复定义 IndexedDB 包装函数，
               避免并发 open 竞争漏建 store（v3 历史 bug，v4 起统一收口） */

            



            /* ============================================================
               人工智能分析域已迁移至 201-settings-ai.js：
               getLyricsTextForAI / analyzeSongWithAI / 流式情绪 /
               applyEmotionWordColors / triggerAiAnalysisIfNeeded /
               detectChorus / renderChorusMarkers / batchAnalyzePlaylist /
               updateAiProviderUI / initSettingsAI（由 initSettingsPanel 调用）
               ============================================================ */
            /* ★ 剩余设置绑定（播放/歌词/背景/界面/音效/快捷键/数据）收敛为模块级函数，initSettingsPanel 只做装配调度 */
            try { initSettingsMisc(); } catch(e) { logWarn('settingsPanel', 'initSettingsMisc:', e); }
            try { initNowPlayingSettings(); } catch(e) { logWarn('settingsPanel', 'initNowPlayingSettings:', e); }
        }

        /* ★ 剩余设置绑定（原 initSettingsPanel 内平铺，收敛为模块级函数；panel 为 initSettingsPanel 局部，函数内自取） */
        function initSettingsMisc() {
            const panel = typeof document !== "undefined" ? document.getElementById("settingsPanel") : null;

            /* ========== 播放设置 ========== */
            const sv = typeof document !== 'undefined' ? document.getElementById('setInitialVolume') : null;
            const svVal = typeof document !== 'undefined' ? document.getElementById('setInitialVolumeVal') : null;
            sv.value = appSettings.playback.initialVolume;
            svVal.textContent = appSettings.playback.initialVolume;
            sv?.addEventListener('input', () => {
                svVal.textContent = sv.value;
                appSettings.playback.initialVolume = parseInt(sv.value);
                saveSettings();
            });

            bindToggle('setPreservesPitch', appSettings.playback.preservesPitch, (v) => {
                appSettings.playback.preservesPitch = v;
                applyPreservesPitch(v);
                saveSettings();
            });
            bindToggle('setAutoPlayNext', appSettings.playback.autoPlayNext, (v) => {
                appSettings.playback.autoPlayNext = v;
                saveSettings();
            });
            bindToggle('setFadeInOut', appSettings.playback.fadeInOut, (v) => {
                appSettings.playback.fadeInOut = v;
                saveSettings();
            });

            const sfd = typeof document !== 'undefined' ? document.getElementById('setFadeDuration') : null;
            const sfdVal = typeof document !== 'undefined' ? document.getElementById('setFadeDurationVal') : null;
            sfd.value = appSettings.playback.fadeDuration;
            sfdVal.textContent = appSettings.playback.fadeDuration;
            sfd?.addEventListener('input', () => {
                sfdVal.textContent = sfd.value;
                appSettings.playback.fadeDuration = parseInt(sfd.value);
                saveSettings();
            });

            bindToggle('setRetryOnFail', appSettings.playback.retryOnFail, (v) => {
                appSettings.playback.retryOnFail = v;
                saveSettings();
            });

            const src = typeof document !== 'undefined' ? document.getElementById('setRetryCount') : null;
            const srcVal = typeof document !== 'undefined' ? document.getElementById('setRetryCountVal') : null;
            src.value = appSettings.playback.retryCount;
            srcVal.textContent = appSettings.playback.retryCount;
            src?.addEventListener('input', () => {
                srcVal.textContent = src.value;
                appSettings.playback.retryCount = parseInt(src.value);
                saveSettings();
            });

            /* ========== 歌词设置 ========== */
            bindBtnGroup('setLyricFontSize', appSettings.lyrics.fontSize, (v) => {
                appSettings.lyrics.fontSize = v;
                applyLyricFontSize(v);
                saveSettings();
            });

            const slb = typeof document !== 'undefined' ? document.querySelector('[data-var="blurLevel"]') : null;
            const slbVal = typeof document !== 'undefined' ? document.querySelector('[data-val="blurLevel"]') : null;
            if (slb && appSettings.lyrics) {
                slb.value = appSettings.lyrics.blurLevel;
                if (slbVal) slbVal.textContent = appSettings.lyrics.blurLevel;
            }
            slb?.addEventListener('input', () => {
                if (slbVal) slbVal.textContent = slb.value;
                appSettings.lyrics.blurLevel = parseInt(slb.value);
                applyLyricBlurLevel(appSettings.lyrics.blurLevel);
                saveSettings();
            });

            bindColorRow('setHighlightColor', appSettings.lyrics.highlightColor, (v) => {
                appSettings.lyrics.highlightColor = v;
                applyHighlightColor(v);
                saveSettings();
            });

            bindColorRow('setHighlightInactiveColor', appSettings.lyrics.highlightInactiveColor, (v) => {
                appSettings.lyrics.highlightInactiveColor = v;
                applyHighlightColor(appSettings.lyrics.highlightColor);
                saveSettings();
            });

            bindColorRow('setInactiveColor', appSettings.lyrics.inactiveColor, (v) => {
                appSettings.lyrics.inactiveColor = v;
                applyHighlightColor(appSettings.lyrics.highlightColor);
                saveSettings();
            });

            bindBtnGroup('setLyricAlign', appSettings.lyrics.align || 'left', (v) => {
                appSettings.lyrics.align = v;
                applyLyricAlign(v);
                saveSettings();
            });

            bindToggle('setShowTranslation', appSettings.lyrics.showTranslation, (v) => {
                appSettings.lyrics.showTranslation = v;
                saveSettings();
                if (lyrics.length > 0) renderLyrics(lyrics);
            });
            bindToggle('setShowRomaji', appSettings.lyrics.showRomaji, (v) => {
                appSettings.lyrics.showRomaji = v;
                saveSettings();
                if (lyrics.length > 0) renderLyrics(lyrics);
            });
            bindToggle('setAutoScroll', appSettings.lyrics.autoScroll, (v) => {
                appSettings.lyrics.autoScroll = v;
                saveSettings();
            });

            /* ========== 背景设置 ========== */
            bindToggle('setDynamicBg', appSettings.background.dynamicBg, (v) => {
                appSettings.background.dynamicBg = v;
                applyBackgroundSettings();
                saveSettings();
            });
            bindToggle('setSwayEnabled', appSettings.background.swayEnabled, (v) => {
                appSettings.background.swayEnabled = v;
                applyBackgroundSettings();
                saveSettings();
            });

            const ssa = typeof document !== 'undefined' ? document.getElementById('setSwayAmp') : null;
            const ssaVal = typeof document !== 'undefined' ? document.getElementById('setSwayAmpVal') : null;
            ssa.value = appSettings.background.swayAmp;
            ssaVal.textContent = appSettings.background.swayAmp + '°';
            ssa?.addEventListener('input', () => {
                ssaVal.textContent = ssa.value + '°';
                appSettings.background.swayAmp = parseInt(ssa.value);
                applyBackgroundSettings();
                saveSettings();
            });

            const ssd = typeof document !== 'undefined' ? document.getElementById('setSwayDuration') : null;
            const ssdVal = typeof document !== 'undefined' ? document.getElementById('setSwayDurationVal') : null;
            ssd.value = appSettings.background.swayDuration;
            ssdVal.textContent = appSettings.background.swayDuration + 's';
            ssd?.addEventListener('input', () => {
                ssdVal.textContent = ssd.value + 's';
                appSettings.background.swayDuration = parseInt(ssd.value);
                applyBackgroundSettings();
                saveSettings();
            });

            const sbb = typeof document !== 'undefined' ? document.getElementById('setBgBlur') : null;
            const sbbVal = typeof document !== 'undefined' ? document.getElementById('setBgBlurVal') : null;
            sbb.value = appSettings.background.blur;
            sbbVal.textContent = appSettings.background.blur + 'px';
            sbb?.addEventListener('input', () => {
                sbbVal.textContent = sbb.value + 'px';
                appSettings.background.blur = parseInt(sbb.value);
                applyBackgroundSettings();
                saveSettings();
            });

            const sbbr = typeof document !== 'undefined' ? document.getElementById('setBgBrightness') : null;
            const sbbrVal = typeof document !== 'undefined' ? document.getElementById('setBgBrightnessVal') : null;
            sbbr.value = appSettings.background.brightness;
            sbbrVal.textContent = appSettings.background.brightness;
            sbbr?.addEventListener('input', () => {
                sbbrVal.textContent = sbbr.value;
                appSettings.background.brightness = parseFloat(sbbr.value);
                applyBackgroundSettings();
                saveSettings();
            });

            /* ========== 界面设置 ========== */
            const sgs = typeof document !== 'undefined' ? document.getElementById('setGlassStrength') : null;
            const sgsVal = typeof document !== 'undefined' ? document.getElementById('setGlassStrengthVal') : null;
            sgs.value = appSettings.interface.glassStrength;
            sgsVal.textContent = appSettings.interface.glassStrength + 'px';
            sgs?.addEventListener('input', () => {
                sgsVal.textContent = sgs.value + 'px';
                appSettings.interface.glassStrength = parseInt(sgs.value);
                applyGlassStrength(appSettings.interface.glassStrength);
                saveSettings();
            });

            bindToggle('setCompactMode', appSettings.interface.compactMode, (v) => {
                appSettings.interface.compactMode = v;
                applyInterfaceSettings();
                saveSettings();
            });

            bindColorRow('setThemeColor', appSettings.interface.themeColor, (v) => {
                appSettings.interface.themeColor = v;
                if (appSettings.modeSettings) {
                    Object.keys(appSettings.modeSettings).forEach(m => {
                        appSettings.modeSettings[m].themeColor = v;
                    });
                }
                applyThemeColor(v);
                saveSettings();
            });

            /* 导入自定义字体 */
            const importFontBtn = typeof document !== 'undefined' ? document.getElementById('setImportFont') : null;
            const importFontFile = typeof document !== 'undefined' ? document.getElementById('setImportFontFile') : null;
            importFontBtn?.addEventListener('click', () => importFontFile.click());
            importFontFile?.addEventListener('change', async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                importFontFile.value = '';
                /* 生成字体标识 */
                const baseName = file.name.replace(/\.[^.]+$/, '');
                const fontKey = 'custom_' + Date.now();
                const family = 'CustomFont_' + fontKey;
                const label = baseName;
                try {
                    const buffer = await file.arrayBuffer();
                    const ok = await loadFontFace(fontKey, family, buffer);
                    if (!ok) {
                        showSettingsHint('字体加载失败，文件可能已损坏');
                        return;
                    }
                    await saveFontToDB(fontKey, family, label, buffer);
                    customFonts[fontKey] = { key: fontKey, family, label, buffer };
                    refreshFontDropdown();
                    refreshAdvancedFontDropdowns();
                    /* 自动选中新导入的字体 */
                    setSettingValue('fontFamily', fontKey);
                    const dd = typeof document !== 'undefined' ? document.getElementById('dropdown-fontFamily') : null;
                    const trigger = dd.querySelector('.setting-dropdown-trigger');
                    const menu = dd.querySelector('.setting-dropdown-menu');
                    trigger.textContent = label;
                    menu.querySelectorAll('.setting-dropdown-item').forEach(i => i.classList.remove('selected'));
                    const newItem = menu.querySelector(`[data-value="${fontKey}"]`);
                    if (newItem) newItem.classList.add('selected');
                    showSettingsHint(`已导入字体：${label}`);
                } catch (err) {
                    logError('settingsPanel', '导入字体失败:', err);
                    showSettingsHint('导入字体失败');
                }
            });

            /* ========== 高级字体设置 ========== */
            const advFontsToggle = typeof document !== 'undefined' ? document.getElementById('setAdvancedFonts') : null;
            const advFontsSection = typeof document !== 'undefined' ? document.getElementById('advancedFontsSection') : null;
            if (appSettings.interface.advancedFonts && appSettings.interface.advancedFonts.enabled) {
                advFontsToggle.classList.add('on');
                advFontsSection.classList.add('open');
                advFontsSection.classList.add('overflow-visible');
            }
            /* 构建高级字体设置 UI */
            buildAdvancedFontUI();
            advFontsToggle?.addEventListener('click', () => {
                advFontsToggle.classList.toggle('on');
                const isOn = advFontsToggle.classList.contains('on');
                appSettings.interface.advancedFonts.enabled = isOn;
                if (isOn) {
                    advFontsSection.classList.add('open');
                    /* 展开动画结束后再允许溢出，使下拉菜单不被裁切 */
                    advFontsSection.classList.remove('overflow-visible');
                    setTimeout(() => advFontsSection.classList.add('overflow-visible'), 350);
                } else {
                    advFontsSection.classList.remove('open');
                    advFontsSection.classList.remove('overflow-visible');
                }
                applyFontFamily(appSettings.interface.fontFamily);
                /* ★ 刷新字体下拉框以更新禁用状态 */
                refreshFontDropdown();
                saveSettings();
            });

            /* ========== 音效设置 ========== */

document.getElementById('setOpenEq')?.addEventListener('click', () => {
                panel.classList.remove('visible');
                if (typeof openEqPanel === 'function') openEqPanel();
            });

            bindToggle('setVolumeNorm', appSettings.audio.volumeNorm, (v) => {
                appSettings.audio.volumeNorm = v;
                saveSettings();
            });

            /* ========== 快捷键设置 ========== */
            initShortcutRecording();

document.getElementById('setResetShortcuts')?.addEventListener('click', () => {
                appSettings.shortcuts = { ...DEFAULT_SHORTCUTS };
                saveSettings();
                refreshShortcutUI();
            });

            /* ========== 前进/后退秒数设置 ========== */
            const seekStepSlider = typeof document !== 'undefined' ? document.getElementById('setSeekStep') : null;
            const seekStepInput = typeof document !== 'undefined' ? document.getElementById('setSeekStepInput') : null;
            if (seekStepSlider && seekStepInput) {
                const val = appSettings.playback.seekStep || 5;
                seekStepSlider.value = val;
                seekStepInput.value = val;
                seekStepSlider?.addEventListener('input', () => {
                    const v = parseInt(seekStepSlider.value);
                    seekStepInput.value = v;
                    appSettings.playback.seekStep = v;
                    saveSettings();
                });
                seekStepInput?.addEventListener('change', () => {
                    let v = parseInt(seekStepInput.value);
                    if (isNaN(v)) v = 5;
                    v = Math.max(1, Math.min(10, v));
                    seekStepInput.value = v;
                    seekStepSlider.value = v;
                    appSettings.playback.seekStep = v;
                    saveSettings();
                });
            }

            /* ========== 性能设置 ========== */
            initPerformanceSettings();

            /* ========== 数据管理 ========== */
document.getElementById('setExportFav')?.addEventListener('click', () => {
                const favs = getFavorites();
                downloadJSON(favs, 'favorites.json');
            });
document.getElementById('setExportPl')?.addEventListener('click', () => {
                const pls = getPlaylists();
                downloadJSON(pls, 'playlists.json');
            });
document.getElementById('setExportAll')?.addEventListener('click', () => {
                const all = {
                    favorites: getFavorites(),
                    playlists: getPlaylists(),
                    settings: appSettings,
                    eq: JSON.parse(localStorage.getItem(EQ_STORAGE_KEY) || '{}')
                };
                downloadJSON(all, 'lyrics_player_backup.json');
            });

document.getElementById('setImportBtn')?.addEventListener('click', () => {
document.getElementById('setImportFile').click();
            });
document.getElementById('setImportFile')?.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (ev) => {
                    try {
                        const data = JSON.parse(ev.target.result);
                        importData(data);
                    } catch (err) {
                        window.showGlassAlert({ title: '导入失败', desc: 'JSON 格式错误', });
                    }
                };
                reader.readAsText(file);
                e.target.value = '';
            });

document.getElementById('setClearSearch')?.addEventListener('click', () => {
                lastSearchKeyword = { tencent: '', netease: '', kugou: '', kuwo: '' };
                searchPageCache = { tencent: null, netease: null, kugou: null, kuwo: null };
                searchPagingBusy = false;
                searchResultsCache = [];
                if (searchResultsEl) searchResultsEl.innerHTML = '';
                showSettingsHint('搜索缓存已清除');
            });

document.getElementById('setClearAll')?.addEventListener('click', () => {
                window.showGlassConfirm({ title: '清除所有数据', desc: '确定要清除所有数据吗？此操作不可撤销，包括收藏、歌单、设置、均衡器和自定义字体。', danger: true }).then((ok) => {
                if (!ok) return;
                localStorage.removeItem(FAV_STORAGE_KEY);
                localStorage.removeItem(PLAYLIST_STORAGE_KEY);
                localStorage.removeItem(SETTINGS_STORAGE_KEY);
                localStorage.removeItem(EQ_STORAGE_KEY);
                indexedDB.deleteDatabase(FONT_DB_NAME);
                showSettingsHint('所有数据已清除，请刷新页面');
            });
            });
        }

/* 通用绑定函数 */
function bindToggle(id, initialVal, onChange) {
            const el = typeof document !== 'undefined' ? document.getElementById(id) : null;
            if (!el) return;
            if (initialVal) el.classList.add('on');
            el?.addEventListener('click', () => {
                el.classList.toggle('on');
                onChange(el.classList.contains('on'));
            });
        }

function bindBtnGroup(containerId, currentVal, onChange) {
            const container = typeof document !== 'undefined' ? document.getElementById(containerId) : null;
            if (!container) return;
            const btns = container.querySelectorAll('.setting-btn');
            let matched = false;
            btns.forEach(btn => {
                const isMatch = String(btn.dataset.val) === String(currentVal);
                if (isMatch) {
                    btn.classList.add('active');
                    matched = true;
                } else {
                    btn.classList.remove('active');
                }
                btn?.addEventListener('click', () => {
                    container.querySelectorAll('.setting-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    onChange(btn.dataset.val);
                });
            });
            if (!matched && btns.length > 0) {
                btns[0].classList.add('active');
            }
        }

/* ★ 设置 → 关于：作者链接呼出系统浏览器。
   Tauri 桌面壳里 <a target="_blank"> 默认不外开（WebView 内导航风险），
   优先走已注册的 opener 插件（capabilities 放行 opener:default），
   网页版回退 window.open。 */
function openExternalUrl(url) {
    try {
        const TA = window.__TAURI__;
        if (TA && TA.opener && typeof TA.opener.openUrl === 'function') {
            TA.opener.openUrl(url);
            return;
        }
        if (TA && TA.shell && typeof TA.shell.open === 'function') {
            TA.shell.open(url);
            return;
        }
    } catch (e) { /* 忽略：桌面 API 不可用时走网页回退 */ }
    try { window.open(url, '_blank', 'noopener'); } catch (e) { /* 忽略 */ }
}

function initAboutLinks() {
    /* 所有带 href 的链接卡片（作者 / 致谢 / folia 参考 / Star）统一呼出系统浏览器。
       ★ .about-project-card（folia-major 致谢卡）此前不在选择器里 → Tauri 壳内
       target=_blank 不外开且无 opener 绑定 → 用户反馈「打不开浏览器」 */
    const links = typeof document !== 'undefined'
        ? document.querySelectorAll('.about-link-card[href], .about-project-card[href], .about-star-btn[href]')
        : [];
    links.forEach((link) => {
        if (link.dataset.bound === '1') return;
        link.dataset.bound = '1';
        link.addEventListener('click', (ev) => {
            ev.preventDefault();
            openExternalUrl(link.href);
        });
    });
    /* 版本 chip：点击复制版本号（上游参考项目 help-tab 同款交互） */
    const chip = document.getElementById('aboutVersionChip');
    if (chip && chip.dataset.bound !== '1') {
        chip.dataset.bound = '1';
        chip.addEventListener('click', () => {
            const ver = chip.textContent.trim();
            const done = () => {
                const old = chip.textContent;
                chip.textContent = '已复制';
                setTimeout(() => { chip.textContent = old; }, 1200);
            };
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(`Aria ${ver}`).then(done, done);
                } else { done(); }
            } catch (e) { done(); }
        });
    }
}

export { bindBtnGroup, bindToggle, initSettingsPanel, initAboutLinks, openExternalUrl };
