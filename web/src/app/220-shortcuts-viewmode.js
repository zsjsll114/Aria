/* ============================================================
 * 220-shortcuts-viewmode.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 13955-15012 行 | 单元数: 14
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { PVEngine } from '../core/pvEngine/PVEngine.js';
import { TunnelEngine } from '../core/tunnelEngine/TunnelEngine.js';
import { triggerAiAnalysisIfNeeded } from '../core/aiAnalyzer.js';
import { state } from '../infrastructure/state.js';
import { EQ_STORAGE_KEY, SETTINGS_STORAGE_KEY } from '../config/constants.js';
import { formatTime } from '../utils/formatters.js';
import { volumePercentToGain } from '../utils/volumeCurve.js';
import { aiCacheCount } from '../services/aiCache.js';
import { buildShapeFieldHTML } from '../core/shapeField.js';
import { DROPDOWN_OPTIONS, PERFORMANCE_PROFILES } from './10-config-state.js';
import { audio, renderLyrics } from './20-lyrics-render.js';
import { flyinAutoScaleFont, getDuration, layoutWordCloud, updateFlyinTranslation } from './56-playback-misc.js';
import { cleanupWordCloud, updateLyricsHighlight, updateWordcloudCamera } from './57-wordcloud-camera.js';
import { syncMobilePageState, updateMobileLyricPreview } from './60-mobile-dual-page.js';
import { togglePlayPause } from './65-playback-position.js';
import { cyclePlayMode, playModeIcons } from './75-play-mode.js';
import { applyPreservesPitch, downloadCurrentSong } from './85-rate-download.js';
import { openEqPanel } from './90-eq.js';
import { nextTrack, prevTrack } from './95-track-loading.js';
import { saveFavorites } from './120-search-results.js';
import { savePlaylists } from './130-playlists.js';
import { showLyricSourceModal, switchLyricSource } from './170-lyric-sources.js';
import { applyPerformanceProfile, autoDetectAndApplyPerformance, cleanGpuName, getPerformanceSettings, getPerfVfx, getVfxOverrides, initDefaultSong, loadSettings, savePerformanceSettings, saveSettings, setVfxOverride, showPerformanceDialog } from './180-boot-config.js';
import { applyAllSettings, applyModeSettings, getSettingValue, setSettingValue } from './190-settings-fontsize.js';
import { bindBtnGroup } from './200-settings-panel.js';
import { logInfo, logWarn, logError } from '../services/log.js';

/* 快捷键录制 */
globalThis.recordingShortcut = null;

function initShortcutRecording() {
document.querySelectorAll('.shortcut-key').forEach(el => {
                el?.addEventListener('click', () => {
                    if (recordingShortcut) recordingShortcut.classList.remove('recording');
                    recordingShortcut = el;
                    el.classList.add('recording');
                    el.textContent = '按下按键...';
                });
            });

            if (typeof document !== "undefined") document.addEventListener('keydown', (e) => {
                if (!recordingShortcut) return;
                e.preventDefault();
                e.stopPropagation();
                if (e.key === 'Escape') {
                    recordingShortcut.classList.remove('recording');
                    refreshShortcutUI(recordingShortcut.dataset.shortcut);
                    recordingShortcut = null;
                    return;
                }
                const keyName = e.key === ' ' ? ' ' : e.key;
                /* 检查冲突 */
                const sc = appSettings.shortcuts;
                for (const k in sc) {
                    if (sc[k] === keyName && k !== recordingShortcut.dataset.shortcut) {
                        showSettingsHint('按键已被「' + shortcutLabel(k) + '」占用');
                        return;
                    }
                }
                appSettings.shortcuts[recordingShortcut.dataset.shortcut] = keyName;
                saveSettings();
                recordingShortcut.classList.remove('recording');
                refreshShortcutUI(recordingShortcut.dataset.shortcut);
                recordingShortcut = null;
            });
        }

function shortcutLabel(key) {
            const map = { playPause: '播放/暂停', prev: '上一曲', next: '下一曲', volumeUp: '音量+', volumeDown: '音量-', favorite: '收藏', toggleLyrics: '歌词', more: '更多' };
            return map[key] || key;
        }

function refreshShortcutUI(keyName) {
            const sc = appSettings.shortcuts;
            const keys = keyName ? [keyName] : Object.keys(sc);
            keys.forEach(k => {
                const el = typeof document !== 'undefined' ? document.querySelector(`[data-shortcut="${k}"]`) : null;
                if (!el) return;
                let v = sc[k];
                let display = v;
                if (v === ' ') display = 'Space';
                else if (v === 'ArrowLeft') display = '←';
                else if (v === 'ArrowRight') display = '→';
                else if (v === 'ArrowUp') display = '↑';
                else if (v === 'ArrowDown') display = '↓';
                else if (v.length === 1) display = v.toUpperCase();
                el.textContent = display;
            });
        }

/* 刷新所有设置控件到当前值 */
function refreshSettingsUI() {
            refreshShortcutUI();
            refreshDropdowns();
            refreshPerformanceUI();
            
            // 1. 播放设置
            const setInitialVolume = document.getElementById('setInitialVolume');
            const setInitialVolumeVal = document.getElementById('setInitialVolumeVal');
            if (setInitialVolume && appSettings.playback) {
                setInitialVolume.value = appSettings.playback.initialVolume ?? 80;
                if (setInitialVolumeVal) setInitialVolumeVal.textContent = setInitialVolume.value;
            }
            const setPreservesPitch = document.getElementById('setPreservesPitch');
            if (setPreservesPitch && appSettings.playback) {
                setPreservesPitch.classList.toggle('on', !!appSettings.playback.preservesPitch);
            }
            const setAutoPlayNext = document.getElementById('setAutoPlayNext');
            if (setAutoPlayNext && appSettings.playback) {
                setAutoPlayNext.classList.toggle('on', !!appSettings.playback.autoPlayNext);
            }
            const setFadeInOut = document.getElementById('setFadeInOut');
            if (setFadeInOut && appSettings.playback) {
                setFadeInOut.classList.toggle('on', !!appSettings.playback.fadeInOut);
            }
            const setFadeDuration = document.getElementById('setFadeDuration');
            const setFadeDurationVal = document.getElementById('setFadeDurationVal');
            if (setFadeDuration && appSettings.playback) {
                setFadeDuration.value = appSettings.playback.fadeDuration ?? 300;
                if (setFadeDurationVal) setFadeDurationVal.textContent = setFadeDuration.value;
            }
            const setRetryOnFail = document.getElementById('setRetryOnFail');
            if (setRetryOnFail && appSettings.playback) {
                setRetryOnFail.classList.toggle('on', !!appSettings.playback.retryOnFail);
            }
            const setRetryCount = document.getElementById('setRetryCount');
            const setRetryCountVal = document.getElementById('setRetryCountVal');
            if (setRetryCount && appSettings.playback) {
                setRetryCount.value = appSettings.playback.retryCount ?? 2;
                if (setRetryCountVal) setRetryCountVal.textContent = setRetryCount.value;
            }

            // 2. 背景设置
            const setDynamicBg = document.getElementById('setDynamicBg');
            if (setDynamicBg && appSettings.background) {
                setDynamicBg.classList.toggle('on', !!appSettings.background.dynamicBg);
            }
            const setBgBlur = document.getElementById('setBgBlur');
            const setBgBlurVal = document.getElementById('setBgBlurVal');
            if (setBgBlur && appSettings.background) {
                setBgBlur.value = appSettings.background.blur ?? 60;
                if (setBgBlurVal) setBgBlurVal.textContent = setBgBlur.value + 'px';
            }
            const setBgBrightness = document.getElementById('setBgBrightness');
            const setBgBrightnessVal = document.getElementById('setBgBrightnessVal');
            if (setBgBrightness && appSettings.background) {
                const bVal = Math.round((appSettings.background.brightness ?? 0.35) * 100);
                setBgBrightness.value = bVal;
                if (setBgBrightnessVal) setBgBrightnessVal.textContent = bVal + '%';
            }
            const setSwayEnabled = document.getElementById('setSwayEnabled');
            if (setSwayEnabled && appSettings.background) {
                setSwayEnabled.classList.toggle('on', !!appSettings.background.swayEnabled);
            }
            const setSwayAmp = document.getElementById('setSwayAmp');
            const setSwayAmpVal = document.getElementById('setSwayAmpVal');
            if (setSwayAmp && appSettings.background) {
                setSwayAmp.value = appSettings.background.swayAmp ?? 12;
                if (setSwayAmpVal) setSwayAmpVal.textContent = setSwayAmp.value + 'px';
            }
            const setSwayDuration = document.getElementById('setSwayDuration');
            const setSwayDurationVal = document.getElementById('setSwayDurationVal');
            if (setSwayDuration && appSettings.background) {
                setSwayDuration.value = appSettings.background.swayDuration ?? 16;
                if (setSwayDurationVal) setSwayDurationVal.textContent = setSwayDuration.value + 's';
            }

            // 3. 界面设置
            const setGlassStrength = document.getElementById('setGlassStrength');
            const setGlassStrengthVal = document.getElementById('setGlassStrengthVal');
            if (setGlassStrength && appSettings.interface) {
                setGlassStrength.value = appSettings.interface.glassStrength ?? 40;
                if (setGlassStrengthVal) setGlassStrengthVal.textContent = setGlassStrength.value + 'px';
            }
            const themeContainer = document.getElementById('setThemeColor');
            if (themeContainer && appSettings.interface) {
                const curTheme = appSettings.interface.themeColor || '#ffcc33';
                let matched = false;
                themeContainer.querySelectorAll('.color-swatch').forEach(sw => {
                    if (sw.dataset.color === curTheme) {
                        sw.classList.add('active');
                        matched = true;
                    } else {
                        sw.classList.remove('active');
                    }
                });
                if (!matched) {
                    const customSw = themeContainer.querySelector('.color-swatch.custom');
                    if (customSw) customSw.classList.add('active');
                }
            }

            // 4. 音效设置
            const setVolumeNorm = document.getElementById('setVolumeNorm');
            if (setVolumeNorm && appSettings.audio) {
                setVolumeNorm.classList.toggle('on', !!appSettings.audio.volumeNorm);
            }

            // 5. 快捷键与跳转步长
            const setSeekStep = document.getElementById('setSeekStep');
            const setSeekStepInput = document.getElementById('setSeekStepInput');
            if (setSeekStep && appSettings.playback) {
                const sStep = appSettings.playback.seekStep ?? 5;
                setSeekStep.value = sStep;
                if (setSeekStepInput) setSeekStepInput.value = sStep;
            }

            // 6. AI 设置
            const setAiApiKey = document.getElementById('setAiApiKey');
            if (setAiApiKey && appSettings.ai) setAiApiKey.value = appSettings.ai.apiKey || '';
            const setAiApiBase = document.getElementById('setAiApiBase');
            if (setAiApiBase && appSettings.ai) setAiApiBase.value = appSettings.ai.apiBase || '';
            const setAiModel = document.getElementById('setAiModel');
            if (setAiModel && appSettings.ai) setAiModel.value = appSettings.ai.model || '';
            const setAiEnabled = document.getElementById('setAiEnabled');
            if (setAiEnabled && appSettings.ai) setAiEnabled.classList.toggle('on', !!appSettings.ai.enabled);
            const setAiUseProxy = document.getElementById('setAiUseProxy');
            if (setAiUseProxy && appSettings.ai) setAiUseProxy.classList.toggle('on', appSettings.ai.useProxy !== false);

            /* 刷新当前歌曲 AI 分析状态 */
            if (typeof currentAiTheme !== 'undefined' && currentAiTheme) {
                try {
                    updateAiSettingsPreview(currentAiTheme, '已分析', currentAiTheme.description || `情绪：${currentAiTheme.mood || '未知'} · 风格：${currentAiTheme.animation_style || '默认'}`);
                } catch (e) {}
            } else if (typeof isAiAnalyzing !== 'undefined' && isAiAnalyzing) {
                const statusText = document.getElementById('aiStatusText');
                const statusDetail = document.getElementById('aiStatusDetail');
                if (statusText) statusText.textContent = '正在分析...';
                if (statusDetail && currentSongData) statusDetail.textContent = `《${currentSongData.title || currentSongData.song}》- ${currentSongData.artist || currentSongData.singer}`;
            } else {
                const statusText = document.getElementById('aiStatusText');
                const statusDetail = document.getElementById('aiStatusDetail');
                if (statusText) {
                    const hasKey = Boolean(appSettings.ai && appSettings.ai.apiKey && appSettings.ai.apiKey.trim().length >= 5);
                    statusText.textContent = hasKey ? '未分析' : '未配置 Key';
                }
                if (statusDetail) {
                    statusDetail.textContent = currentSongData ? `《${currentSongData.title || currentSongData.song}》待分析` : '播放歌曲后自动分析';
                }
            }
            
            // 7. 刷新外观设置模式
            if (previewEngineInstance) {
                const activeMode = previewEngineInstance.currentMode || currentViewMode || 'cover';
                if (typeof Aria.__syncModeSectionValues === 'function') Aria.__syncModeSectionValues(activeMode);
            }

            /* 刷新 AI 缓存数量显示 */
            aiCacheCount().then(cnt => {
                const cacheInfoEl = typeof document !== 'undefined' ? document.getElementById('aiCacheInfo') : null;
                if (cacheInfoEl) cacheInfoEl.textContent = `已缓存 ${cnt} 首歌曲的分析结果`;
            }).catch(() => {});
        }

/* ========== 性能设置初始化 ========== */
function initPerformanceSettings() {
            /* 性能等级按钮组 */
            const perfSaved = getPerformanceSettings();
            const currentProfile = perfSaved ? perfSaved.profile : 'medium';

            bindBtnGroup('setPerformanceProfile', currentProfile, (v) => {
                applyPerformanceProfile(v);
                savePerformanceSettings({
                    profile: v,
                    manuallyConfigured: true,
                    configuredAt: Date.now()
                });
                refreshPerformanceUI();
                /* 应用设置到界面 */
                applyAllSettings();
                showSettingsHint(`已切换到${PERFORMANCE_PROFILES[v].name}模式`);
            });

            /* 自动检测按钮 */
document.getElementById('setAutoDetectPerf')?.addEventListener('click', async () => {
                const btn = typeof document !== 'undefined' ? document.getElementById('setAutoDetectPerf') : null;
                btn.textContent = '检测中...';
                btn.disabled = true;

                const result = await autoDetectAndApplyPerformance(false);

                btn.textContent = '立即检测';
                btn.disabled = false;

                /* 更新UI */
                refreshPerformanceUI();
                applyAllSettings();

                /* 显示结果对话框 */
                showPerformanceDialog(result);
            });

            /* ★ 恢复推荐性能配置（同时清空「视觉开销」手动覆盖 → 重新按硬件检测） */
            const resetRecommendedBtn = document.getElementById('btnResetPerfRecommended');
            if (resetRecommendedBtn) {
                resetRecommendedBtn.addEventListener('click', async () => {
                    const btn = document.getElementById('btnResetPerfRecommended');
                    if (btn) { btn.textContent = '重置中...'; btn.disabled = true; }
                    try { localStorage.removeItem('perf_vfx_overrides_v1'); } catch(e) {}
                    const result = await autoDetectAndApplyPerformance(false);
                    if (btn) { btn.textContent = '恢复推荐配置'; btn.disabled = false; }
                    if (typeof initVisualOverheadUI === 'function') initVisualOverheadUI();
                    refreshPerformanceUI();
                    applyAllSettings();
                    showSettingsHint(`已重置为硬件推荐配置（${PERFORMANCE_PROFILES[result.profile].name}）`);
                });
            }

            /* ★ 恢复出厂性能配置按钮（同时清空「视觉开销」手动覆盖）
               ★ 二次确认（2026-09-22 操作性自查）：破坏性操作此前一键直执行，
               误触即丢失全部手动微调——改走 aria-dialog 确认框 */
            document.getElementById('btnResetPerfFactory')?.addEventListener('click', () => {
                const doReset = () => {
                    try { localStorage.removeItem('perf_vfx_overrides_v1'); } catch(e) {}
                    applyPerformanceProfile('high');
                    savePerformanceSettings({
                        profile: 'high',
                        manuallyConfigured: false,
                        configuredAt: Date.now()
                    });
                    if (typeof initVisualOverheadUI === 'function') initVisualOverheadUI();
                    refreshPerformanceUI();
                    applyAllSettings();
                    showSettingsHint('已恢复出厂默认性能配置（高性能）');
                };
                if (typeof window !== 'undefined' && typeof window.showGlassConfirm === 'function') {
                    /* 走统一毛玻璃确认弹窗（021-aria-dialog），无则退回原生 confirm */
                    window.showGlassConfirm({
                        title: '恢复出厂性能配置？',
                        desc: '将清空全部「视觉开销」手动微调并回到高性能档，此操作不可撤销。',
                        okText: '恢复',
                        danger: true
                    }).then((ok) => { if (ok) doReset(); }).catch(() => {});
                } else if (typeof window !== 'undefined' && window.confirm && window.confirm('恢复出厂性能配置？将清空全部手动微调，此操作不可撤销。')) {
                    doReset();
                } else {
                    doReset();
                }
            });

            /* ★「视觉开销」手动微调：渲染缩放 + 各模式特效开关 */
            initVisualOverheadUI();

            /* 初始刷新硬件信息显示 */
            refreshPerformanceUI();
        }

/* 「视觉开销」手动微调初始化与状态同步 */
let _vfxBound = false;
function initVisualOverheadUI() {
            const vfxKeys = [
                ['vfxPvBloom', 'pvBloom'],
                ['vfxWcParticles', 'wcParticles'],
                ['vfxTunnelParticles', 'tunnelParticles'],
                ['vfxDimParticles', 'dimParticles'],
                ['vfxPolyGlow', 'polyGlow']
            ];

            function syncVfxUI() {
                const cur = getPerfVfx();
                const o = getVfxOverrides();
                const slider = document.getElementById('vfxRenderScale');
                if (slider) {
                    const v = o.renderScale !== undefined ? o.renderScale : cur.renderScale;
                    slider.value = String(v !== undefined ? v : 1);
                    const span = document.querySelector('[data-val="vfxRenderScale"]');
                    if (span) span.textContent = Math.round((v !== undefined ? v : 1) * 100) + '%';
                }
                vfxKeys.forEach(([id, key]) => {
                    const el = document.getElementById(id);
                    if (!el) return;
                    const on = o[key] !== undefined ? o[key] : (cur[key] !== false && cur[key] !== undefined);
                    el.classList.toggle('on', !!on);
                });
            }

            function reapplyPerfProfile() {
                const saved = getPerformanceSettings();
                const prof = (saved && saved.profile) ? saved.profile : 'medium';
                try {
                    applyPerformanceProfile(prof);
                } catch(e) { logWarn('shortcutsViewmode', '应用性能配置失败:', e); }
                try { applyAllSettings(); } catch(e) {}
            }

            if (!_vfxBound) {
                _vfxBound = true;
                const slider = document.getElementById('vfxRenderScale');
                if (slider) {
                    slider.addEventListener('input', (e) => {
                        const v = parseFloat(e.target.value);
                        if (isNaN(v)) return;
                        setVfxOverride('renderScale', v);
                        const span = document.querySelector('[data-val="vfxRenderScale"]');
                        if (span) span.textContent = Math.round(v * 100) + '%';
                        reapplyPerfProfile();
                    });
                }
                vfxKeys.forEach(([id, key]) => {
                    const el = document.getElementById(id);
                    if (!el) return;
                    el.addEventListener('click', () => {
                        const turnOn = !el.classList.contains('on');
                        setVfxOverride(key, turnOn);
                        syncVfxUI();
                        reapplyPerfProfile();
                    });
                });
            }

            syncVfxUI();
        }

/* 仅刷新「视觉开销」控件状态（设置面板打开/档位切换时调用，不重复绑定） */
function refreshVfxOverheadUI() {
            if (!_vfxBound) initVisualOverheadUI();
            else {
                const cur = getPerfVfx();
                const o = getVfxOverrides();
                const slider = document.getElementById('vfxRenderScale');
                if (slider) {
                    const v = o.renderScale !== undefined ? o.renderScale : cur.renderScale;
                    slider.value = String(v !== undefined ? v : 1);
                    const span = document.querySelector('[data-val="vfxRenderScale"]');
                    if (span) span.textContent = Math.round((v !== undefined ? v : 1) * 100) + '%';
                }
                [
                    ['vfxPvBloom', 'pvBloom'],
                    ['vfxWcParticles', 'wcParticles'],
                    ['vfxTunnelParticles', 'tunnelParticles'],
                    ['vfxDimParticles', 'dimParticles'],
                    ['vfxPolyGlow', 'polyGlow']
                ].forEach(([id, key]) => {
                    const el = document.getElementById(id);
                    if (!el) return;
                    const on = o[key] !== undefined ? o[key] : (cur[key] !== false && cur[key] !== undefined);
                    el.classList.toggle('on', !!on);
                });
            }
        }

/* 刷新性能设置UI */
function refreshPerformanceUI() {
            const perfSaved = getPerformanceSettings();
            const hw = perfSaved ? perfSaved.hardware : null;
            const profile = perfSaved ? perfSaved.profile : 'medium';
            const isEn = (globalThis.AriaI18n && globalThis.AriaI18n.getLanguage() === 'en-US');
            const yes = isEn ? 'Yes' : '是';
            const no = isEn ? 'No' : '否';

            /* 更新硬件信息显示（★ GPU 显示清洗后的真实型号，无 ANGLE 别名包装；
               旧缓存数据里存的是原始串，显示时再兜底清洗一次） */
            if (hw) {
                document.getElementById('hwGpu').textContent = cleanGpuName(hw.gpu) || hw.gpu || (isEn ? 'Unknown' : '未知');
                document.getElementById('hwCpu').textContent = (hw.cpuCores || '?') + (isEn ? ' cores' : ' 核');
                document.getElementById('hwMemory').textContent = (hw.memory || '?') + ' GB';
                document.getElementById('hwResolution').textContent =
                    `${Math.round(Math.sqrt(hw.screenResolution))}p`;
                document.getElementById('hwPixelRatio').textContent =
                    (hw.pixelRatio || 1) + 'x';
                document.getElementById('hwScore').textContent =
                    (hw.performanceScore ?? '--') + ' / 12';
            } else {
                /* 显示当前浏览器信息 */
                document.getElementById('hwGpu').textContent = isEn ? 'Click Detect' : '点击检测以获取';
                document.getElementById('hwCpu').textContent = (navigator.hardwareConcurrency || '?') + (isEn ? ' cores' : ' 核');
                document.getElementById('hwMemory').textContent = (navigator.deviceMemory || '?') + ' GB';
                document.getElementById('hwResolution').textContent = window.screen.width + 'x' + window.screen.height;
                document.getElementById('hwPixelRatio').textContent = (window.devicePixelRatio || 1) + 'x';
                document.getElementById('hwScore').textContent = '--';
            }

            /* 更新当前配置效果显示 */
            const p = PERFORMANCE_PROFILES[profile];
            const effectsHtml = `
                <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                    <span style="color: rgba(255,255,255,0.5)" data-i18n="perf.dynamicBg">动态背景</span>
                    <span>${p.background.dynamicBg ? (p.background.swayEnabled ? (isEn ? 'On (sway)' : '开（带摇摆）') : (isEn ? 'On' : '开')) : (isEn ? 'Off' : '关')}</span>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                    <span style="color: rgba(255,255,255,0.5)" data-i18n="perf.bgBlur">背景模糊</span>
                    <span>${p.background.blur}px</span>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                    <span style="color: rgba(255,255,255,0.5)" data-i18n="perf.lyricBlur">歌词模糊</span>
                    <span>${p.lyrics.blurLevel}${isEn ? ' lvl' : '级'}</span>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                    <span style="color: rgba(255,255,255,0.5)" data-i18n="perf.showTrans">显示翻译</span>
                    <span>${p.lyrics.showTranslation ? yes : no}</span>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                    <span style="color: rgba(255,255,255,0.5)" data-i18n="perf.showRomaji">显示罗马音</span>
                    <span>${p.lyrics.showRomaji ? yes : no}</span>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                    <span style="color: rgba(255,255,255,0.5)" data-i18n="perf.glass">毛玻璃强度</span>
                    <span>${p.interface.glassStrength}px</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                    <span style="color: rgba(255,255,255,0.5)" data-i18n="perf.compact">紧凑模式</span>
                    <span>${p.interface.compactMode ? yes : no}</span>
                </div>
            `;
document.getElementById('profileEffectItems').innerHTML = effectsHtml;

            /* 更新按钮组选中状态 */
            const btnGroup = typeof document !== 'undefined' ? document.getElementById('setPerformanceProfile') : null;
            if (btnGroup) {
                btnGroup.querySelectorAll('.setting-btn').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.val === profile);
                });
            }

            /* 如果当前已分析出 AI 主题，同步渲染 AI 主题信息与色块列表 */
            if (typeof currentAiTheme !== 'undefined' && currentAiTheme) {
                try { updateAiSettingsPreview(currentAiTheme); } catch (e) {}
            }

            /* ★ 同步「视觉开销」手动微调控件状态 */
            if (typeof refreshVfxOverheadUI === 'function') refreshVfxOverheadUI();
        }

/* ========== 自定义下拉选择器 ========== */
/* DROPDOWN_OPTIONS 已提升至顶部 */
function initCustomDropdowns() {
            /* ★ 文档级「点击外部关闭」只全局挂载一次（避免每次打开面板/切 tab 叠加多个监听） */
            if (typeof document !== 'undefined' && !Aria.__ariaDropdownDocCloseBound) {
                Aria.__ariaDropdownDocCloseBound = true;
                document.addEventListener('click', () => {
                    document.querySelectorAll('.setting-dropdown.open').forEach(d => d.classList.remove('open'));
                });
            }

            document.querySelectorAll('.setting-dropdown').forEach(dd => {
                /* ★ 开合事件唯一挂载点：
                   若 trigger 已被其他模块（refreshFontDropdown 等）预建，只补绑开合事件、
                   不重建内容 —— 避免 addEventListener 与 onclick 双 handler 互相 toggle 抵消
                   （表现为点击下拉无法弹出） */
                const existingTrigger = dd.querySelector('.setting-dropdown-trigger');
                if (existingTrigger) {
                    if (!existingTrigger._ariaToggleBound) {
                        existingTrigger._ariaToggleBound = true;
                        existingTrigger.addEventListener('click', (e) => {
                            e.stopPropagation();
                            document.querySelectorAll('.setting-dropdown.open').forEach(d => {
                                if (d !== dd) d.classList.remove('open');
                            });
                            dd.classList.toggle('open');
                        });
                    }
                    return;
                }

                const setting = dd.dataset.setting;
                const options = DROPDOWN_OPTIONS[setting] || [];
                const currentVal = getSettingValue(setting);

                /* 构建 trigger */
                const trigger = document.createElement('div');
                trigger.className = 'setting-dropdown-trigger';
                trigger._ariaToggleBound = true;
                const currentOpt = options.find(o => String(o.value) === String(currentVal)) || options[0];
                trigger.textContent = currentOpt ? currentOpt.label : '';

                /* 构建 menu */
                const menu = document.createElement('div');
                menu.className = 'setting-dropdown-menu';
                options.forEach(opt => {
                    const item = document.createElement('div');
                    item.className = 'setting-dropdown-item' + (String(opt.value) === String(currentVal) ? ' selected' : '');
                    item.textContent = opt.label;
                    item.dataset.value = opt.value;
                    item?.addEventListener('click', () => {
                        trigger.textContent = opt.label;
                        menu.querySelectorAll('.setting-dropdown-item').forEach(i => i.classList.remove('selected'));
                        item.classList.add('selected');
                        setSettingValue(setting, opt.value);
                        dd.classList.remove('open');
                    });
                    menu.appendChild(item);
                });

                trigger?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    document.querySelectorAll('.setting-dropdown.open').forEach(d => {
                        if (d !== dd) d.classList.remove('open');
                    });
                    dd.classList.toggle('open');
                });

                dd.appendChild(trigger);
                dd.appendChild(menu);
            });
        }

function refreshDropdowns() {
            document.querySelectorAll('.setting-dropdown').forEach(dd => {
                const setting = dd.dataset.setting;
                /* ★ fontFamily 下拉由 refreshFontDropdown（215-multilang-fonts）私有
                   管理：选项含 customFonts 动态项，静态 DROPDOWN_OPTIONS 匹配不到
                   当前值时会 fallback 到 options[0] 把 trigger 重置成「默认」——
                   用户实测：选宋体后 trigger 显示「默认」而 menu 选中仍正确（两组
                   逻辑各写各的）。显示统一以 refreshFontDropdown 为准，此处跳过。 */
                if (setting === 'fontFamily') return;
                const options = DROPDOWN_OPTIONS[setting] || [];
                const currentVal = getSettingValue(setting);
                const trigger = dd.querySelector('.setting-dropdown-trigger');
                const currentOpt = options.find(o => String(o.value) === String(currentVal)) || options[0];
                if (trigger && currentOpt) trigger.textContent = currentOpt.label;
                dd.querySelectorAll('.setting-dropdown-item').forEach(item => {
                    item.classList.toggle('selected', String(item.dataset.value) === String(currentVal));
                });
            });
        }

/* 导出/导入 */
function downloadJSON(data, filename) {
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
            showSettingsHint('已导出 ' + filename);
        }

function importData(data) {
            let imported = 0;
            if (Array.isArray(data)) {
                /* 单独收藏或歌单 */
                if (data.length > 0 && data[0].songs) {
                    savePlaylists(data);
                    imported = 1;
                } else {
                    saveFavorites(data);
                    imported = 1;
                }
            } else if (data.favorites || data.playlists || data.settings || data.eq) {
                /* 全部数据 */
                if (data.favorites) { saveFavorites(data.favorites); imported++; }
                if (data.playlists) { savePlaylists(data.playlists); imported++; }
                if (data.settings) {
                    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(data.settings));
                    loadSettings();
                    applyAllSettings();
                    imported++;
                }
                if (data.eq) {
                    localStorage.setItem(EQ_STORAGE_KEY, JSON.stringify(data.eq));
                    imported++;
                }
            }
            showSettingsHint(imported > 0 ? `导入成功（${imported} 项）` : '未识别到有效数据');
        }

function showSettingsHint(text) {
            const hint = document.createElement('div');
            hint.textContent = text;
            hint.style.cssText = 'position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.8);color:var(--theme-color);padding:8px 20px;border-radius:8px;font-size:13px;z-index:10001;backdrop-filter:blur(20px);transition:opacity 0.3s';
            document.body.appendChild(hint);
            setTimeout(() => { hint.style.opacity = '0'; setTimeout(() => hint.remove(), 300); }, 2000);
        }

if (typeof window !== "undefined") window.addEventListener('load', function() {
            /* 仅在欢迎页已关闭且仍无歌曲时才回退初始化 */
            const welcomeOverlay = typeof document !== 'undefined' ? document.getElementById('welcomeOverlay') : null;
            if (!welcomeOverlay && lyrics.length === 0 && !currentSongData) {
                /* 预加载可能已将 initSongStarted 置为 true 但失败了，需重置 */
                if (preloadedSongReady === null) initSongStarted = false;
                initDefaultSong();
            }
        });

/* ========== 视图模式切换 & 底部控制栏逻辑 ========== */
/* 注意：此代码块在全局 IIFE 中，可以访问 playMode, cyclePlayMode, setPlayMode 等变量和函数 */
(function initViewMode() {
            const playerContainer = typeof document !== 'undefined' ? document.querySelector('.player-container') : null;
            const openViewModeBtn = typeof document !== 'undefined' ? document.getElementById('openViewModeBtn') : null;
            const viewModeOverlay = typeof document !== 'undefined' ? document.getElementById('viewModeOverlay') : null;
            const viewModeCloseBtn = typeof document !== 'undefined' ? document.getElementById('viewModeCloseBtn') : null;
            const viewModeCards = typeof document !== 'undefined' ? document.querySelectorAll('.view-mode-card') : null;
            const bottomControlBar = typeof document !== 'undefined' ? document.getElementById('bottomControlBar') : null;

            /* 如果必要元素不存在，提前退出 */
            if (!playerContainer || !openViewModeBtn) {
                logWarn('shortcutsViewmode', '视图切换: 必要元素不存在');
                return;
            }

            /* currentViewMode 已在顶层声明 */

            /* ========== ★ 第 16.1/16.4 节：流光隧道 AI 分析确认（token 消耗提醒） ==========
             * 流程：查内存/DB 缓存（analyzeSongWithAI 内置） → 命中直接就绪；
             * 未命中 → 每次都弹确认框（预计 Token/时间/分析内容 + 三种模式），不再记住偏好。
             * ★ 每次进入需要分析时都提醒，避免"只弹过一次、之后静默消耗 token"。 */
            function ensureTunnelAnalysis(onReady) {
                const hasTheme = (typeof currentAiTheme !== 'undefined' && currentAiTheme) || (window.currentAiTheme) || state.currentAiTheme;
                const aiCfg = appSettings.ai || {};
                const hasKey = Boolean(aiCfg.apiKey && String(aiCfg.apiKey).trim().length >= 5);
                const lineCount = (typeof lyrics !== 'undefined' && Array.isArray(lyrics)) ? lyrics.length : 0;

                // 1. 缓存命中（16.4：切歌先查缓存，命中不耗 token）
                if (hasTheme) { onReady(state.currentAiTheme || window.currentAiTheme || currentAiTheme); return; }

                // 2. 无 Key 或无歌词 → 直接轻量就绪
                if (!hasKey || lineCount === 0) { onReady(null); return; }

                // 3. 每次未缓存都要分析时，都弹确认框（16.1）提醒 token 消耗
                showTunnelAiConfirm(onReady, lineCount, hasKey);
            }

            async function runTunnelAi(onReady) {
                try {
                    await triggerAiAnalysisIfNeeded(); // 缓存内置：命中不请求
                } catch (e) {
                    logWarn('shortcutsViewmode', '[Tunnel AI] 分析失败，回退词典模式:', e);
                }
                onReady(state.currentAiTheme || window.currentAiTheme || null);
            }

            function showTunnelAiConfirm(onReady, lineCount, hasKey, opts) {
                opts = opts || {};
                const cached = !!opts.cached;
                // 第 16.4 节 token 估算：歌词行数 × 8 + 2000
                const tokenEst = Math.round(lineCount * 8 + 2000);

                const overlay = document.createElement('div');
                overlay.className = 'tunnel-ai-confirm-overlay';
                overlay.innerHTML = `
                    <div class="tunnel-ai-confirm-modal">
                        <div class="tunnel-ai-confirm-title">「格律 · Mondrian」需要 AI 分析歌词以生成最佳视觉效果</div>
                        <div class="tunnel-ai-confirm-desc">分析内容包括：每句歌词的语义情感标签、歌曲段落结构（主歌/副歌/桥段）、逐词权重与强调标记、装饰组合与运镜编排。</div>
                        <div class="tunnel-ai-confirm-cost">
                            <div class="tunnel-ai-cost-item"><div class="tunnel-ai-cost-label">预计消耗 Token</div><div class="tunnel-ai-cost-value">${cached ? '0（已缓存）' : '~' + tokenEst.toLocaleString()}</div></div>
                            <div class="tunnel-ai-cost-item"><div class="tunnel-ai-cost-label">预计耗时</div><div class="tunnel-ai-cost-value">${cached ? '立即' : '15-30 秒'}</div></div>
                            <div class="tunnel-ai-cost-item"><div class="tunnel-ai-cost-label">缓存</div><div class="tunnel-ai-cost-value">${cached ? '已命中，不消耗' : '分析后缓存'}</div></div>
                        </div>
                        <div class="tunnel-ai-mode-list">
                            <button class="tunnel-ai-mode-btn selected" data-mode="ai">
                                <div><div class="tunnel-ai-mode-name">AI 联网完整分析（效果最佳）</div>
                                <div class="tunnel-ai-mode-sub">语义情感 + 段落结构 + 逐词权重，生成后缓存，同一首歌不再消耗${hasKey ? '' : '（未配置 API Key，不可用）'}</div></div>
                            </button>
                            <button class="tunnel-ai-mode-btn" data-mode="lightweight">
                                <div><div class="tunnel-ai-mode-name">轻量分析（无 AI，不耗 Token）</div>
                                <div class="tunnel-ai-mode-sub">用情感词典 + 节奏密度推断，效果略简化</div></div>
                            </button>
                            <button class="tunnel-ai-mode-btn" data-mode="preset">
                                <div><div class="tunnel-ai-mode-name">纯预设（无分析，最简单）</div>
                                <div class="tunnel-ai-mode-sub">只用预设风格卡 + 逐字时间戳</div></div>
                            </button>
                        </div>
                        <div class="tunnel-ai-confirm-actions">
                            <button class="tunnel-ai-btn ghost" data-act="cancel">取消</button>
                            <button class="tunnel-ai-btn primary" data-act="go">开始生成</button>
                        </div>
                    </div>`;

                document.body.appendChild(overlay);

                let chosen = hasKey ? 'ai' : 'lightweight';
                if (!hasKey) {
                    const aiBtn = overlay.querySelector('[data-mode="ai"]');
                    if (aiBtn) { aiBtn.classList.remove('selected'); aiBtn.disabled = true; aiBtn.style.opacity = '0.45'; }
                    const lwBtn = overlay.querySelector('[data-mode="lightweight"]');
                    if (lwBtn) lwBtn.classList.add('selected');
                }

                overlay.querySelectorAll('.tunnel-ai-mode-btn').forEach(btn => {
                    btn.addEventListener('click', () => {
                        if (btn.disabled) return;
                        overlay.querySelectorAll('.tunnel-ai-mode-btn').forEach(b => b.classList.remove('selected'));
                        btn.classList.add('selected');
                        chosen = btn.dataset.mode;
                    });
                });

                const close = () => { if (overlay.parentNode) overlay.remove(); };

                overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => {
                    close();
                    onReady(); // 取消 = 纯预设直接播放，不阻断
                });

                overlay.querySelector('[data-act="go"]').addEventListener('click', () => {
                    close();
                    if (chosen === 'ai' && hasKey) {
                        runTunnelAi(onReady);
                    } else {
                        onReady(); // lightweight / preset：词典与节奏内置降级
                    }
                });
            }

            function switchView(mode) {
                /* ★ 模式切换丝滑过渡：快速主题色弥散遮罩淡入→切换→淡出，消除硬切感 */
                try {
                    const fade = document.createElement('div');
                    fade.className = 'view-switch-fade';
                    document.body.appendChild(fade);
                    requestAnimationFrame(() => {
                        fade.style.opacity = '1';
                        setTimeout(() => {
                            fade.style.opacity = '0';
                            setTimeout(() => fade.remove(), 420);
                        }, 150);
                    });
                } catch (e) { /* 过渡失败不影响切换 */ }

                const wasFlyin = playerContainer.classList.contains('view-flyin');
                const wasWordcloud = playerContainer.classList.contains('view-wordcloud');
                currentViewMode = mode;
                if (typeof window !== 'undefined') window.currentViewMode = mode;
                
                /* ★ 先移除并更新所有视图模式 class */
                playerContainer.classList.remove('view-lyrics', 'view-flyin', 'view-wordcloud', 'view-pv', 'view-tunnel', 'view-dimension', 'view-polyphony', 'view-letterpress', 'view-neon');
                
                if (mainVisManager && mainVisManager.has(mode)) {
                    playerContainer.classList.add(`view-${mode}`);
                    mainVisManager.switchMode(mode, playerContainer);
                    if (typeof lyrics !== 'undefined' && lyrics.length > 0) {
                        mainVisManager.setLyrics(lyrics, currentAiTheme || {});
                    }
                    if (appSettings.modeSettings && appSettings.modeSettings[mode]) {
                        mainVisManager.applySettings(appSettings.modeSettings[mode]);
                    }
                    mainVisManager.update(audio ? audio.currentTime : 0);
                } else {
                    if (mainVisManager) mainVisManager.destroy();
                }

                if (mode === 'lyrics') {
                    playerContainer.classList.add('view-lyrics');
                } else if (mode === 'flyin') {
                    playerContainer.classList.add('view-lyrics');
                    playerContainer.classList.add('view-flyin');
                } else if (mode === 'wordcloud') {
                    playerContainer.classList.add('view-lyrics');
                    playerContainer.classList.add('view-wordcloud');
                } else if (mode === 'pv') {
                    playerContainer.classList.add('view-pv');
                    let pvContainer = document.getElementById('pvViewContainer');
                    if (!pvContainer) {
                        pvContainer = document.createElement('div');
                        pvContainer.id = 'pvViewContainer';
                        pvContainer.className = 'pv-view-container';
                        playerContainer.appendChild(pvContainer);
                    }
                    pvContainer.style.display = 'block';
                    {
                        if (!pvEngineInstance) {
                            pvEngineInstance = new PVEngine(pvContainer);
                        }
                        pvContainer.innerHTML = '';
                        pvEngineInstance.init(pvContainer);
                        /* ★ 创建晚于配置下发：补发性能档位（DPR降采样/粒子预算/发光开关） */
                        if (typeof window !== 'undefined' && Aria.__lastPerfProfile &&
                            typeof pvEngineInstance.setPerformanceConfig === 'function') {
                            pvEngineInstance.setPerformanceConfig({ pv: Aria.__lastPerfProfile.pv, vfx: Aria.__lastPerfProfile.vfx });
                        }
                        logInfo('shortcutsViewmode', '[PV Mode] PVEngine 初始化完成, lyrics:', typeof lyrics !== 'undefined' ? lyrics.length : 0, '条');
                        if (typeof lyrics !== 'undefined' && lyrics.length > 0) {
                            pvEngineInstance.setLyrics(lyrics, currentAiTheme || {});
                        }
                        if (window.coverPalette && pvEngineInstance.background) {
                            pvEngineInstance.background.updateTheme(window.coverPalette.primary, window.coverPalette.secondary, window.coverPalette.accent);
                        }
                        pvEngineInstance.start();
                        pvEngineInstance.update(audio ? audio.currentTime : 0);
                    }
                } else if (mode === 'tunnel') {
                    playerContainer.classList.add('view-tunnel');
                    let tunnelContainer = document.getElementById('tunnelViewContainer');
                    if (!tunnelContainer) {
                        tunnelContainer = document.createElement('div');
                        tunnelContainer.id = 'tunnelViewContainer';
                        tunnelContainer.className = 'tunnel-view-container';
                        playerContainer.appendChild(tunnelContainer);
                    }
                    tunnelContainer.style.display = 'block';
                    {
                        if (!tunnelEngineInstance) {
                            tunnelEngineInstance = new TunnelEngine(tunnelContainer);
                        }
                        tunnelContainer.innerHTML = '';
                        tunnelEngineInstance.init(tunnelContainer);
                        /* ★ 创建晚于配置下发：补发性能档位（粒子预算/DPR/装饰降级） */
                        if (typeof window !== 'undefined' && Aria.__lastPerfProfile &&
                            typeof tunnelEngineInstance.setPerfConfig === 'function') {
                            tunnelEngineInstance.setPerfConfig(Aria.__lastPerfProfile);
                        }
                        logInfo('shortcutsViewmode', '[Tunnel Mode] TunnelEngine 初始化完成, lyrics:', typeof lyrics !== 'undefined' ? lyrics.length : 0, '条');
                        if (appSettings.modeSettings && appSettings.modeSettings.tunnel) {
                            tunnelEngineInstance.applySettings(appSettings.modeSettings.tunnel);
                        }
                        /* ★ 切歌复用口：20-lyrics-render 渲染新歌时用它重走确认流程（防止切歌绕过弹窗） */
                        if (typeof window !== 'undefined') {
                            Aria.__tunnelEnsureAnalysis = ensureTunnelAnalysis;
                            Aria.__tunnelLastAskAt = Date.now();   // 本次进入已弹，供 3s 护栏防双弹
                        }
                        /* ★ 第 16.1/16.4 节：进入 PV 需 AI 分析 → 先查缓存，未命中弹确认框提醒 token 消耗 */
                        ensureTunnelAnalysis((theme) => {
                            if (typeof lyrics !== 'undefined' && lyrics.length > 0) {
                                tunnelEngineInstance.setLyrics(lyrics, theme || window.currentAiTheme || currentAiTheme || {});
                            }
                            tunnelEngineInstance.start();
                            tunnelEngineInstance.update(audio ? audio.currentTime : 0);
                        });
                    }
                }

                /* ★ P4：默认（封面）模式显式标记 view-cover，作为手机版双页布局的样式作用域；
                   可视化模式（星雾/光曜等）由 mainVisManager 添加各自的 view-* 类，不标记 */
                const isDefaultCoverMode = !(mainVisManager && mainVisManager.has(mode))
                    && mode !== 'lyrics' && mode !== 'flyin' && mode !== 'wordcloud' && mode !== 'pv' && mode !== 'tunnel';
                playerContainer.classList.toggle('view-cover', isDefaultCoverMode);

                /* ★ P4：离开默认模式时退出手机版歌词页；每次切换后同步按钮态与预览文本 */
                if (!isDefaultCoverMode) playerContainer.classList.remove('mobile-page-lyrics');
                syncMobilePageState();
                updateMobileLyricPreview();

                if (mode !== 'pv') {
                    if (mode !== 'tunnel') {
                        const pvContainer = document.getElementById('pvViewContainer');
                        if (pvContainer) {
                            pvContainer.style.display = 'none';
                        }
                        if (pvEngineInstance) {
                            pvEngineInstance.stop();
                        }
                    }
                    const tunnelContainer = document.getElementById('tunnelViewContainer');
                    if (tunnelContainer) {
                        tunnelContainer.style.display = 'none';
                    }
                    if (tunnelEngineInstance) {
                        tunnelEngineInstance.stop();
                    }
                }

                /* ★ 保存当前视图模式到本地存储 */
                try { localStorage.setItem('player_view_mode', mode); } catch(e) {}

                /* ★ 再应用该模式的独立歌词设置（使 renderLyrics 能识别正确的 view-flyin 状态） */
                applyModeSettings(mode);

                if (mode === 'flyin') {
                    /* ★ 飞入模式需要重新渲染歌词以应用 RTL 拆分逻辑 */
                    if (lyrics.length > 0) {
                        renderLyrics(lyrics);
                        /* 重新渲染后需要重新应用高亮 */
                        if (activeLineIndex >= 0) {
                            updateLyricsHighlight();
                        }
                    }
                    /* 注入背景图形层 — ★ folia 式全屏图形场（icon + 几何 + 粒子，
                       与 PV 共用 shapeField.js 与同一套 CSS；同曲布局稳定） */
                    if (!document.getElementById('view-flyin-wireframes')) {
                        const wfLayer = document.createElement('div');
                        wfLayer.id = 'view-flyin-wireframes';
                        wfLayer.className = 'view-flyin-wireframes pv-shape-field';
                        const songData = (typeof window !== 'undefined' && window.currentSongData) || {};
                        const songSeed = songData.songMid || songData.songId || songData.id || songData.song || songData.title || 'flyin';
                        wfLayer.innerHTML = buildShapeFieldHTML(songSeed);
                        document.body.appendChild(wfLayer);
                    }
                    /* 飞入模式：重置滚动 transform，更新底部翻译区域 */
                    const scrollEl = typeof document !== 'undefined' ? document.getElementById('lyricsScroll') : null;
                    if (scrollEl) {
                        scrollEl.style.transition = 'none';
                        scrollEl.style.transform = 'none';
                    }
currentScrollY = 0;
if (activeLineIndex >= 0 && typeof updateFlyinTranslation === 'function') {
updateFlyinTranslation(activeLineIndex);
}
/* ★ 飞入切换：立即把滚动位置吸附到当前播放行（updateLyricsHighlight 在索引未变时不滚动） */
if (activeLineIndex >= 0 && lyrics.length > 0) snapScrollToActiveLine();
/* 飞入模式：延迟调用动态字体缩放，确保 DOM 已渲染 */
setTimeout(() => { if (typeof flyinAutoScaleFont === 'function') flyinAutoScaleFont(); }, 100);
                } else if (mode === 'wordcloud') {
                    playerContainer.classList.add('view-lyrics'); /* 词云模式也使用全屏歌词布局 */
                    playerContainer.classList.add('view-wordcloud');
                    wcLastTransform = '';   /* 切入词云：scrollEl transform 可能被其他模式改写过，强制相机重写 */
                    /* 词云模式需要重新渲染歌词 */
                    if (lyrics.length > 0) {
                        renderLyrics(lyrics);
                        if (activeLineIndex >= 0) {
                            updateLyricsHighlight();
                        }
                    }
                    /* 延迟执行词云排版，确保 DOM 已渲染 */
                    setTimeout(() => {
                        layoutWordCloud();
                        if (activeLineIndex >= 0) {
                            updateWordcloudCamera();
                        }
                    }, 60);
                } else {
                    /* 移除飞入模式几何线框 */
                    const wfEl = typeof document !== 'undefined' ? document.getElementById('view-flyin-wireframes') : null;
                    if (wfEl) wfEl.remove();
                }
                /* 从飞入或词云模式切回普通模式：重新渲染歌词，清除模式特有内联样式 */
                if ((wasFlyin || wasWordcloud) && mode !== 'flyin' && mode !== 'wordcloud') {
                    /* ★ 从飞入/词云模式切回普通模式时重新渲染歌词，恢复正常的字符渲染 */
                    if (lyrics.length > 0) {
                        renderLyrics(lyrics);
                        if (activeLineIndex >= 0) {
                            updateLyricsHighlight();
                        }
                    }
                    /* 清除所有歌词行的飞入模式内联样式（fontSize/maxHeight/overflow） */
                    lineElements.forEach(el => {
                        const lrc = el.querySelector('.lrc-original');
                        if (lrc) {
                            lrc.style.fontSize = '';
                            lrc.style.maxHeight = '';
                            lrc.style.overflow = '';
                        }
                    });
                    if (activeLineIndex >= 0 && lineElements.length > 0) {
                        /* ★ 渲染后立即吸附到当前行（旧逻辑手写同一计算，改为复用统一函数） */
                        snapScrollToActiveLine();
                    }
                }
                /* 从词云模式切回其他模式：清理排版内联样式并重新渲染 */
                if (wasWordcloud && mode !== 'wordcloud') {
                    cleanupWordCloud();
                    if (lyrics.length > 0) {
                        renderLyrics(lyrics);
                        if (activeLineIndex >= 0) {
                            updateLyricsHighlight();
                        }
                    }
                    /* 恢复滚动定位 */
                    if (activeLineIndex >= 0 && lineElements.length > 0) {
                        snapScrollToActiveLine();
                    }
                }
                /* ★ 切换歌词样式后立即把滚动位置吸附到当前播放行。
                   背景：updateLyricsHighlight 只在「活动行索引变化」时才滚动定位
                   （新增活动行时 newActiveIndex !== activeLineIndex），而切换样式瞬间
                   当前行索引并未改变（封面模式每帧已在推进 activeLineIndex），
                   因此切到歌词/飞入后它不会触发滚动 → 必现"停在旧位置/下一次跳变"。
                   这里强制定位：transition:'none' 瞬时到位，下一帧交还原 rAF/自动滚动接管。 */
                function snapScrollToActiveLine() {
                    if (activeLineIndex < 0 || !lineElements || !lineElements[activeLineIndex]) return;
                    const scrollEl = typeof document !== 'undefined' ? document.getElementById('lyricsScroll') : null;
                    if (!scrollEl) return;
                    const activeLineEl = lineElements[activeLineIndex];
                    const lyricsContainerEl = typeof document !== 'undefined' ? document.querySelector('.lyrics-container') : null;
                    const scrollViewHeight = lyricsContainerEl ? lyricsContainerEl.clientHeight : 0;
                    if (scrollViewHeight <= 0) return;
                    const activeLineOffset = activeLineEl.offsetTop;
                    const targetTranslateY = activeLineOffset - scrollViewHeight / 2 + activeLineEl.clientHeight / 2;
                    /* ★ 统一走 57 弹簧系统：歌曲类模式瞬时吸附整条链（逐行牵动），
                       非歌曲模式（飞入）由入口回退到容器 transform 平移 */
                    if (typeof Aria !== 'undefined' && typeof Aria.__lyricsScrollTo === 'function') {
                        Aria.__lyricsScrollTo(targetTranslateY, true);
                        return;
                    }
                    scrollEl.style.transition = 'none';
                    scrollEl.style.transform = `translateY(-${targetTranslateY}px)`;
                    currentScrollY = targetTranslateY;
                    requestAnimationFrame(() => { scrollEl.style.transition = ''; });
                }

                /* ★ 修复：切入歌词滚动类模式时，歌词容器立即吸附到当前播放进度，避免先显示上次在该模式冻结的旧滚动位置再跳变 */
                if ((mode === 'lyrics' || isDefaultCoverMode) && lyrics.length > 0 && lineElements[activeLineIndex]) {
                    snapScrollToActiveLine();
                }
                /* 更新弹窗卡片选中状态 */
                viewModeCards.forEach(card => {
                    card.classList.toggle('active', card.dataset.mode === mode);
                });
                /* 保存偏好 */
                try { localStorage.setItem('player_view_mode', mode); } catch(e) {}
            }

            /* 打开样式切换弹窗 */
            function openViewModePopup() {
                if (!viewModeOverlay) return;
                /* 先更新选中状态 */
                viewModeCards.forEach(card => {
                    card.classList.toggle('active', card.dataset.mode === currentViewMode);
                });
                viewModeOverlay.classList.add('visible');
            }

            /* 关闭样式切换弹窗 */
            function closeViewModePopup() {
                if (!viewModeOverlay) return;
                viewModeOverlay.classList.remove('visible');
            }

            /* 右上角按钮 → 打开弹窗 */
            openViewModeBtn?.addEventListener('click', openViewModePopup);

            /* 关闭按钮 */
            if (viewModeCloseBtn) {
                viewModeCloseBtn?.addEventListener('click', closeViewModePopup);
            }

            /* 点击遮罩关闭 */
            if (viewModeOverlay) {
                viewModeOverlay?.addEventListener('click', (e) => {
                    if (e.target === viewModeOverlay) closeViewModePopup();
                });
            }

            /* 卡片点击 → 立即切换模式并立即关闭弹窗 (采用事件委托确保动态卡片即时响应) */
            if (viewModeOverlay) {
                viewModeOverlay.addEventListener('click', (e) => {
                    const card = e.target.closest('.view-mode-card');
                    if (card && card.dataset.mode) {
                        const mode = card.dataset.mode;
                        // 立即更新卡片选中样式
                        const allCards = viewModeOverlay.querySelectorAll('.view-mode-card');
                        allCards.forEach(c => c.classList.toggle('active', c.dataset.mode === mode));
                        try {
                            // 立即执行模式切换
                            switchView(mode);
                        } catch (err) {
                            logError('shortcutsViewmode', '[ViewMode] switchView error:', err);
                        } finally {
                            // 无论如何绝对立即关闭弹窗
                            closeViewModePopup();
                        }
                    }
                });
            }

            /* 恢复保存的视图模式 */
            try {
                const saved = localStorage.getItem('player_view_mode');
                if (saved) switchView(saved);
            } catch(e) {}

            /* 如果底部控制栏不存在，跳过相关初始化 */
            if (!bottomControlBar) {
                logWarn('shortcutsViewmode', '底部控制栏: 元素不存在');
                return;
            }

            /* ========== 底部控制栏元素引用 ========== */
            const bottomProgressTrack = typeof document !== 'undefined' ? document.getElementById('bottomProgressTrack') : null;
            const bottomProgressBar = typeof document !== 'undefined' ? document.getElementById('bottomProgressBar') : null;
            const bottomCurrentTimeEl = typeof document !== 'undefined' ? document.getElementById('bottomCurrentTime') : null;
            const bottomTotalTimeEl = typeof document !== 'undefined' ? document.getElementById('bottomTotalTime') : null;
            const bottomPlayBtn = typeof document !== 'undefined' ? document.getElementById('bottomPlayBtn') : null;
            const bottomPlayIcon = typeof document !== 'undefined' ? document.getElementById('bottomPlayIcon') : null;
            const bottomPrevBtn = typeof document !== 'undefined' ? document.getElementById('bottomPrevBtn') : null;
            const bottomNextBtn = typeof document !== 'undefined' ? document.getElementById('bottomNextBtn') : null;
            const bottomPlayModeBtn = typeof document !== 'undefined' ? document.getElementById('bottomPlayModeBtn') : null;
            const bottomLoopOneBtn = typeof document !== 'undefined' ? document.getElementById('bottomLoopOneBtn') : null;
            const bottomModeText = typeof document !== 'undefined' ? document.getElementById('bottomModeText') : null;
            const bottomSpeedBtn = typeof document !== 'undefined' ? document.getElementById('bottomSpeedBtn') : null;
            const speedSubmenu = typeof document !== 'undefined' ? document.getElementById('speedSubmenu') : null;
            const bottomSpeedValue = typeof document !== 'undefined' ? document.getElementById('bottomSpeedValue') : null;
            const bottomVolumeBtn = typeof document !== 'undefined' ? document.getElementById('bottomVolumeBtn') : null;
            const volumeSliderPopup = typeof document !== 'undefined' ? document.getElementById('volumeSliderPopup') : null;
            const bottomVolumeTrack = typeof document !== 'undefined' ? document.getElementById('bottomVolumeTrack') : null;
            const bottomVolumeBar = typeof document !== 'undefined' ? document.getElementById('bottomVolumeBar') : null;
            const bottomVolumeValue = typeof document !== 'undefined' ? document.getElementById('bottomVolumeValue') : null;
            const bottomMoreBtn = typeof document !== 'undefined' ? document.getElementById('bottomMoreBtn') : null;
            const moreSubmenu = typeof document !== 'undefined' ? document.getElementById('moreSubmenu') : null;
            const moreEqItem = typeof document !== 'undefined' ? document.getElementById('moreEqItem') : null;
            const moreDownloadItem = typeof document !== 'undefined' ? document.getElementById('moreDownloadItem') : null;
            const moreLyricSourceItem = typeof document !== 'undefined' ? document.getElementById('moreLyricSourceItem') : null;
            const moreSettingsItem = typeof document !== 'undefined' ? document.getElementById('moreSettingsItem') : null;

            /* 底部歌曲信息元素 */
            const bottomSongCover = typeof document !== 'undefined' ? document.getElementById('bottomSongCover') : null;
            const bottomSongTitle = typeof document !== 'undefined' ? document.getElementById('bottomSongTitle') : null;
            const bottomSongArtist = typeof document !== 'undefined' ? document.getElementById('bottomSongArtist') : null;

            /* ========== 同步底部歌曲信息 ========== */
            function syncBottomSongInfo() {
                const cover1 = typeof document !== 'undefined' ? document.getElementById('songCover') : null;
                const cover2 = typeof document !== 'undefined' ? document.getElementById('songCover2') : null;
                const title = typeof document !== 'undefined' ? document.getElementById('songTitle') : null;
                const artist = typeof document !== 'undefined' ? document.getElementById('songArtist') : null;
                /* 获取当前显示的封面（opacity=1的那个） */
                if (bottomSongCover) {
                    const activeCover = cover1 && cover1.style.opacity !== '0' ? cover1 : cover2;
                    if (activeCover && activeCover.src && activeCover.src !== window.location.href) {
                        bottomSongCover.src = activeCover.src;
                    }
                }
                if (bottomSongTitle && title) bottomSongTitle.textContent = title.textContent;
                if (bottomSongArtist && artist) bottomSongArtist.textContent = artist.textContent;
            }

            /* 监听歌曲变化 */
            const songObserver = new MutationObserver(syncBottomSongInfo);
            const songTitleEl = typeof document !== 'undefined' ? document.getElementById('songTitle') : null;
            const songArtistEl = typeof document !== 'undefined' ? document.getElementById('songArtist') : null;
            const songCoverEl = typeof document !== 'undefined' ? document.getElementById('songCover') : null;
            const songCover2El = typeof document !== 'undefined' ? document.getElementById('songCover2') : null;
            if (songTitleEl) songObserver.observe(songTitleEl, { childList: true });
            if (songArtistEl) songObserver.observe(songArtistEl, { childList: true });
            /* 监听封面变化（src属性和style变化）- 监听两个封面层 */
            if (songCoverEl) songObserver.observe(songCoverEl, { attributes: true, attributeFilter: ['src', 'style'] });
            if (songCover2El) songObserver.observe(songCover2El, { attributes: true, attributeFilter: ['src', 'style'] });

            /* ========== 底部进度条同步 ========== */
            function syncBottomProgress() {
                if (!audio.duration) return;
                const pct = (audio.currentTime / audio.duration) * 100;
                bottomProgressBar.style.width = pct + '%';
                bottomCurrentTimeEl.textContent = formatTime(audio.currentTime * 1000).replace(/^0/, '');
                bottomTotalTimeEl.textContent = formatTime(audio.duration * 1000).replace(/^0/, '');
            }

            /* 监听原有进度更新 */
            audio?.addEventListener('timeupdate', syncBottomProgress);
            audio?.addEventListener('loadedmetadata', () => {
                bottomTotalTimeEl.textContent = formatTime(getDuration()).replace(/^0/, '');
            });

            /* 底部进度条点击拖拽 */
            let isDraggingBottomProgress = false;
            function setBottomProgressFromEvent(e) {
                const rect = bottomProgressTrack.getBoundingClientRect();
                const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                if (audio.duration) audio.currentTime = pct * audio.duration;
                bottomProgressBar.style.width = (pct * 100) + '%';
            }
            bottomProgressTrack?.addEventListener('mousedown', (e) => {
                isDraggingBottomProgress = true;
                setBottomProgressFromEvent(e);
                e.preventDefault();
            });
            if (typeof document !== "undefined") document.addEventListener('mousemove', (e) => {
                if (isDraggingBottomProgress) setBottomProgressFromEvent(e);
            });
            if (typeof document !== "undefined") document.addEventListener('mouseup', () => { isDraggingBottomProgress = false; });

            /* ========== 底部播放/暂停同步 ========== */
            function updateBottomPlayIcon() {
                if (audio.paused) {
                    /* 播放图标（三角形） */
                    bottomPlayIcon.innerHTML = '<path d="M10.345 23.287c.415 0 .763-.15 1.22-.407l12.742-7.404c.838-.481 1.178-.855 1.178-1.46 0-.599-.34-.972-1.178-1.462L11.565 5.158c-.457-.265-.805-.407-1.22-.407-.789 0-1.345.606-1.345 1.57V21.71c0 .971.556 1.577 1.345 1.577z" fill-rule="nonzero"></path>';
                } else {
                    /* 暂停图标（双竖线）与原播放器一致 */
                    bottomPlayIcon.innerHTML = '<path d="M13.293 22.772c.955 0 1.436-.481 1.436-1.436V6.677c0-.98-.481-1.427-1.436-1.427h-2.457c-.954 0-1.436.473-1.436 1.427v14.66c-.008.954.473 1.435 1.436 1.435h2.457zm7.87 0c.954 0 1.427-.481 1.427-1.436V6.677c0-.98-.473-1.427-1.428-1.427h-2.465c-.955 0-1.428.473-1.428 1.427v14.66c0 .954.473 1.435 1.428 1.435h2.465z" fill-rule="nonzero"></path>';
                }
            }
            audio?.addEventListener('play', updateBottomPlayIcon);
            audio?.addEventListener('pause', updateBottomPlayIcon);

            bottomPlayBtn?.addEventListener('click', togglePlayPause);
            bottomPrevBtn?.addEventListener('click', prevTrack);
            bottomNextBtn?.addEventListener('click', nextTrack);

            /* ========== 播放方式同步 ========== */
            const bottomPlayModeIcon = typeof document !== 'undefined' ? document.getElementById('bottomPlayModeIcon') : null;
            function updateBottomPlayMode() {
                const modeLabels = { loop: '单曲循环', random: '随机播放', sequence: '顺序播放' };
                if (bottomModeText) bottomModeText.textContent = modeLabels[playMode] || playMode;
                /* 同步图标 */
                if (bottomPlayModeIcon && playModeIcons[playMode]) {
                    bottomPlayModeIcon.innerHTML = playModeIcons[playMode];
                }
            }
            if (bottomPlayModeBtn) bottomPlayModeBtn?.addEventListener('click', cyclePlayMode);
            /* ★ 性能（2026-09-23）：原 setInterval(500ms) 每次无条件 innerHTML 重写 SVG 子树
               ——常驻 DOM churn。playMode 只在点击/设置加载时变，改事件驱动：
               75-play-mode.updatePlayModeIcon 在变更点回调本函数，此处仅初始化一次 */
            globalThis.__updateBottomPlayMode = updateBottomPlayMode;
            updateBottomPlayMode();

            /* ========== 倍速菜单 ========== */
            if (bottomSpeedBtn && speedSubmenu) {
                bottomSpeedBtn?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    closeAllPopups();
                    speedSubmenu.classList.toggle('open');
                });

                speedSubmenu.querySelectorAll('.speed-option[data-speed]').forEach(opt => {
                    opt?.addEventListener('click', () => {
                        const spd = parseFloat(opt.dataset.speed);
                        audio.playbackRate = spd;
                        if (bottomSpeedValue) bottomSpeedValue.textContent = spd + 'x';
                        speedSubmenu.querySelectorAll('.speed-option[data-speed]').forEach(o => o.classList.remove('active'));
                        opt.classList.add('active');
                        speedSubmenu.classList.remove('open');
                    });
                });

                /* 变速不变调开关 */
                const bottomPitchToggle = typeof document !== 'undefined' ? document.getElementById('bottomPitchToggle') : null;
                if (bottomPitchToggle) {
                    if (preservesPitch) bottomPitchToggle.classList.add('active');
                    bottomPitchToggle?.addEventListener('click', () => {
                        applyPreservesPitch(!preservesPitch);
                        bottomPitchToggle.classList.toggle('active', preservesPitch);
                        speedSubmenu.classList.remove('open');
                    });
                }
            }

            /* ========== 音量滑块 ========== */
            if (bottomVolumeBtn && volumeSliderPopup) {
                bottomVolumeBtn?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    closeAllPopups();
                    volumeSliderPopup.classList.toggle('open');
                });
            }

            if (bottomVolumeTrack) {
                let isDraggingVol = false;
                function setBottomVolumeFromEvent(e) {
                    const rect = bottomVolumeTrack.getBoundingClientRect();
                    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                    const pct100 = Math.round(pct * 100);
                    /* ★ 对数曲线：手柄位置 → dB → 声压；同时同步全局 volume 供主音量条/键盘快捷键使用 */
                    if (typeof updateVolume === 'function') {
                        updateVolume(pct100);
                    } else {
                        globalThis.volume = pct100;
                        audio.volume = volumePercentToGain(pct100);
                    }
                    if (bottomVolumeBar) bottomVolumeBar.style.width = (pct * 100) + '%';
                    if (bottomVolumeValue) bottomVolumeValue.textContent = Math.round(pct * 100);
                }
                bottomVolumeTrack?.addEventListener('mousedown', (e) => {
                    isDraggingVol = true;
                    setBottomVolumeFromEvent(e);
                    e.preventDefault();
                });
                if (typeof document !== "undefined") document.addEventListener('mousemove', (e) => { if (isDraggingVol) setBottomVolumeFromEvent(e); });
                if (typeof document !== "undefined") document.addEventListener('mouseup', () => { isDraggingVol = false; });
            }

            /* 同步音量显示（显示手柄位置而非原始声压，保持与主音量条一致） */
            if (bottomVolumeBar && bottomVolumeValue) {
                /* 初始化音量显示 */
                const _pctInit = Math.max(0, Math.min(100, typeof volume !== 'undefined' ? volume : 80));
                bottomVolumeBar.style.width = _pctInit + '%';
                bottomVolumeValue.textContent = _pctInit;
                audio?.addEventListener('volumechange', () => {
                    /* 音量被外部（主音量条/键盘）修改时，底部条同步为手柄位置 */
                    const _cur = (typeof volume !== 'undefined') ? Math.max(0, Math.min(100, volume)) : 80;
                    bottomVolumeBar.style.width = _cur + '%';
                    bottomVolumeValue.textContent = Math.round(_cur);
                });
            }

            /* ========== 更多菜单 ========== */
            if (bottomMoreBtn && moreSubmenu) {
                bottomMoreBtn?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    closeAllPopups();
                    moreSubmenu.classList.toggle('open');
                });
            }

            if (moreEqItem) {
                moreEqItem?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (moreSubmenu) moreSubmenu.classList.remove('open');
                    /* 打开均衡器设置面板 */
                    if (typeof openEqPanel === 'function') openEqPanel();
                });
            }

            if (moreDownloadItem) {
                moreDownloadItem?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (moreSubmenu) moreSubmenu.classList.remove('open');
                    /* 触发下载功能 */
                    if (typeof downloadCurrentSong === 'function') downloadCurrentSong();
                });
            }

            /* 歌词来源弹窗交互 */
            const lyricSourceOverlay = typeof document !== 'undefined' ? document.getElementById('lyricSourceOverlay') : null;
            const lyricSourceCloseBtn = typeof document !== 'undefined' ? document.getElementById('lyricSourceCloseBtn') : null;
            if (lyricSourceCloseBtn) {
                lyricSourceCloseBtn?.addEventListener('click', () => {
                    lyricSourceOverlay?.classList.remove('visible');
                });
            }
            if (lyricSourceOverlay) {
                lyricSourceOverlay?.addEventListener('click', (e) => {
                    if (e.target === lyricSourceOverlay) lyricSourceOverlay.classList.remove('visible');
                });
            }

            if (moreLyricSourceItem) {
                moreLyricSourceItem?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (moreSubmenu) moreSubmenu.classList.remove('open');
                    if (typeof showLyricSourceModal === 'function') {
                        showLyricSourceModal();
                    } else if (typeof switchLyricSource === 'function') {
                        switchLyricSource();
                    }
                });
            }

            if (moreSettingsItem) {
                moreSettingsItem?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (moreSubmenu) moreSubmenu.classList.remove('open');
                    const openBtn = document.getElementById('openSettingsBtn');
                    if (openBtn) {
                        openBtn.click();
                    } else {
                        const settingsOverlay = document.getElementById('settingsOverlay');
                        const settingsPanel = document.getElementById('settingsPanel');
                        if (settingsOverlay) settingsOverlay.classList.add('visible');
                        if (settingsPanel) settingsPanel.classList.add('fullscreen-mode');
                        if (typeof refreshSettingsUI === 'function') refreshSettingsUI();
                    }
                });
            }

            /* ========== 关闭所有弹出菜单 ========== */
            function closeAllPopups() {
                speedSubmenu.classList.remove('open');
                volumeSliderPopup.classList.remove('open');
                moreSubmenu.classList.remove('open');
            }
            if (typeof document !== "undefined") document.addEventListener('click', (e) => {
                if (!e.target.closest('.speed-menu-wrapper') &&
                    !e.target.closest('.volume-menu-wrapper') &&
                    !e.target.closest('.more-menu-wrapper')) {
                    closeAllPopups();
                }
            });

            /* 键盘快捷键支持（主快捷键在 window keydown 中统一处理，此处仅保留工具函数） */
            function seekRelative(ms) {
                if (audio.duration) {
                    audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + ms / 1000));
                }
            }

            function changeVolume(delta) {
                audio.volume = Math.max(0, Math.min(1, audio.volume + delta));
                /* ★ 该旁路不改 globalThis.volume，同步一份并持久化 */
                try {
                    const pct = Math.round(audio.volume / volumePercentToGain(1) * 100);
                    if (typeof updateVolume === 'function') updateVolume(pct);
                } catch (e) { /* ignore */ }
            }
        })();

export { downloadJSON, importData, initCustomDropdowns, initPerformanceSettings, initShortcutRecording, refreshDropdowns, refreshPerformanceUI, refreshSettingsUI, refreshShortcutUI, shortcutLabel, showSettingsHint };
