/* ============================================================
 * 202-settings-appearance.js — 外观控制域（自 200-settings-panel.js 拆分）
 * 来源区间: 原 200-settings-panel.js 外观域 | 拆分: 2026-09-12
 * 归属: 歌词样式模式面板构建/事件绑定/预览引擎同步/缓存加载
 * ★ 仅被 200-settings-panel.js import；无对 200 的运行时依赖（无环）
 * ============================================================ */
import { renderLyrics } from './20-lyrics-render.js';
import { aiThemeCache } from './40-playback-state.js';
import { saveSettings } from './180-boot-config.js';
import { applyBackgroundSettings, applyHighlightColor, applyLyricAlign, applyLyricBlurLevel, applyLyricFontSize, applyModeSettings, applyThemeColor } from './190-settings-fontsize.js';
import { applyFontFamily, applyGlassStrength, bindColorRow, openColorPicker } from './210-color-multilang.js';
import { saveCustomFont } from './215-multilang-fonts.js';
import { showSettingsHint } from './220-shortcuts-viewmode.js';
import { aiCacheGetAll } from '../services/aiCache.js';
import { DEFAULT_SETTINGS } from '../config/defaults.js'; // 模式设置默认值兜底
import { logInfo, logWarn, logError } from '../services/log.js';

/* 外观面板容器引用（原为 initSettingsPanel 内局部，重构提升到本模块共享） */
let appearanceControlsEl = null;

function applyLyricSetting(name, value) {
                switch (name) {
                    case 'blurLevel':
                        appSettings.lyrics.blurLevel = parseInt(value);
                        applyLyricBlurLevel(appSettings.lyrics.blurLevel);
                        break;
                    case 'highlightColor':
                        appSettings.lyrics.highlightColor = value;
                        applyHighlightColor(value);
                        break;
                    case 'highlightInactiveColor':
                        appSettings.lyrics.highlightInactiveColor = value;
                        applyHighlightColor(appSettings.lyrics.highlightColor);
                        break;
                    case 'inactiveColor':
                        appSettings.lyrics.inactiveColor = value;
                        applyHighlightColor(appSettings.lyrics.highlightColor);
                        break;
                    case 'align':
                        appSettings.lyrics.align = value;
                        applyLyricAlign(value);
                        break;
                    case 'showTranslation':
                        appSettings.lyrics.showTranslation = value;
                        if (typeof lyrics !== 'undefined' && lyrics.length > 0) renderLyrics(lyrics);
                        break;
                    case 'showRomaji':
                        appSettings.lyrics.showRomaji = value;
                        if (typeof lyrics !== 'undefined' && lyrics.length > 0) renderLyrics(lyrics);
                        break;
                    case 'fontSize':
                        /* ★ 新系统：fontSize 为倍率值 (如 1.0 = 中，0.75 = 小，1.35 = 大，1.7 = 超大) */
                        const scale = parseFloat(value);
                        appSettings.lyrics.fontSize = isNaN(scale) ? 1.0 : scale;
                        applyLyricFontSize(appSettings.lyrics.fontSize);
                        break;
                }
            }

            /* ★ 应用共享设置到主播放器 */
            function applySharedSetting(name, value) {
                switch (name) {
                    case 'themeColor':
                        appSettings.interface.themeColor = value;
                        if (appSettings.modeSettings) {
                            const targetM = (typeof currentEditingMode !== 'undefined' && currentEditingMode) ? currentEditingMode : currentViewMode;
                            if (targetM && appSettings.modeSettings[targetM]) {
                                appSettings.modeSettings[targetM].themeColor = value;
                            }
                        }
                        applyThemeColor(value);
                        saveSettings();
                        break;
                    case 'bgBlur':
                        appSettings.background.blur = parseInt(value);
                        applyBackgroundSettings();
                        break;
                    case 'bgBrightness':
                        appSettings.background.brightness = parseFloat(value);
                        applyBackgroundSettings();
                        break;
                    case 'swayEnabled':
                        appSettings.background.swayEnabled = value;
                        applyBackgroundSettings();
                        break;
                    case 'swayAmp':
                        appSettings.background.swayAmp = parseInt(value);
                        applyBackgroundSettings();
                        break;
                    case 'swayDuration':
                        appSettings.background.swayDuration = parseInt(value);
                        applyBackgroundSettings();
                        break;
                    case 'glassStrength':
                        appSettings.interface.glassStrength = parseInt(value);
                        applyGlassStrength(appSettings.interface.glassStrength);
                        break;
                    case 'fontFamily':
                        const reverseFontMap = {
                            'inherit': 'default', 'monospace': 'mono',
                            "'SimHei', sans-serif": 'hei',
                            "'Microsoft YaHei', sans-serif": 'default'
                        };
                        const fontKey = reverseFontMap[value];
                        if (fontKey) {
                            appSettings.interface.fontFamily = fontKey;
                            applyFontFamily(fontKey);
                        }
                        break;
                }
            }

                                    /* ★ 构建与同步右侧参数控制面板（7大模式独立隔离存储） */
            /* ★ 为每个模式板块动态注入「情感词发光强度」滑块（位置在高亮颜色上方） */
            function ensureEmotionGlowSliders() {
                const controls = appearanceControlsEl || (typeof document !== 'undefined' ? document.getElementById('lyricStyleControls') : null);
                if (!controls) return;
                controls.querySelectorAll('[data-mode-section]').forEach(sec => {
                    if (sec.querySelector('input[data-var="emotionGlow"]')) return;
                    const row = document.createElement('div');
                    row.className = 'setting-row';
                    row.innerHTML = `<div><div class="setting-label">情感词发光强度</div></div><div class="setting-control"><input type="range" class="setting-slider" data-var="emotionGlow" min="0" max="30" step="1" value="10"><span class="setting-value" data-val="emotionGlow">10px</span></div></div>`;
                    const highlightRow = sec.querySelector('[data-var="highlightColor"]')?.closest('.setting-row');
                    if (highlightRow && highlightRow.parentNode) {
                        highlightRow.parentNode.insertBefore(row, highlightRow);
                    } else {
                        sec.appendChild(row);
                    }
                });
            }

            function buildAppearanceControls() {
                const controls = appearanceControlsEl || (typeof document !== 'undefined' ? document.getElementById('lyricStyleControls') : null);
                if (!controls) return;
                appearanceControlsEl = controls;
                ensureEmotionGlowSliders();

                const activeMode = (previewEngineInstance && previewEngineInstance.currentMode) || currentViewMode || 'cover';

                /* 更新视图模式 Segment 按钮激活状态 */
                controls.querySelectorAll('.appearance-mode-btn').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.mode === activeMode);
                });

                /* 显示激活模式的板块并绑定事件与值 */
                showModeSection(activeMode);
                bindAppearanceEvents();
                syncModeSectionValues(activeMode);
                /* ★ 外观板块渲染完成后补跑语言包（2026-09-22）：静态行/滑杆标签
                   按当前语言出英文，切 tab 或重开面板都会走到这里 */
                try {
                    import('../core/i18n.js').then(m => m.applyLanguageToDocument()).catch(() => {});
                } catch (err) { logWarn('settingsPanel', err); }
            }

            /* 按模式显示/隐藏对应板块（带内联样式强力保障） */
            function showModeSection(mode) {
                const controls = appearanceControlsEl || (typeof document !== 'undefined' ? document.getElementById('lyricStyleControls') : null);
                if (!controls) return;
                const sections = controls.querySelectorAll('[data-mode-section]');
                sections.forEach(sec => {
                    if (sec.dataset.modeSection === mode) {
                        sec.classList.add('active');
                        sec.style.display = 'block';
                    } else {
                        sec.classList.remove('active');
                        sec.style.display = 'none';
                    }
                });
            }

                        /* ★ 绑定右侧控件事件 — 使用事件委托保障模式切换 100% 响应 */
            function bindAppearanceEvents() {
                const controls = appearanceControlsEl || (typeof document !== 'undefined' ? document.getElementById('lyricStyleControls') : null);
                if (!controls) return;

                /* 模式切换按钮委托监听（避免重复绑定，永久有效） */
                if (!controls._hasModeDelegation) {
                    controls._hasModeDelegation = true;
                    controls.addEventListener('click', (e) => {
                        const btn = e.target.closest('.appearance-mode-btn');
                        if (!btn) return;
                        const mode = btn.dataset.mode;
                        if (!mode) return;

                        // 1. 更新按钮高亮
                        controls.querySelectorAll('.appearance-mode-btn').forEach(b => b.classList.remove('active'));
                        btn.classList.add('active');

                        // 2. 切换右侧参数面板
                        showModeSection(mode);

                        // 3. 同步参数数值
                        syncModeSectionValues(mode);

                        // 4. 安全通知左侧预览引擎
                        try {
                            if (previewEngineInstance && typeof previewEngineInstance.setMode === 'function') {
                                previewEngineInstance.setMode(mode);
                            }
                        } catch (err) {
                            logWarn('settingsPanel', '[PreviewEngine] setMode error:', err);
                        }
                    });
                }

                /* 滑块 — 使用 .setting-slider */
                controls.querySelectorAll('.setting-slider').forEach(slider => {
                    if (slider._hasAppEvent) return;
                    slider._hasAppEvent = true;
                    const varName = slider.dataset.var;
                    const isGlobal = slider.dataset.scope === 'global';
                    const valEl = slider.parentElement?.querySelector(`[data-val="${varName}"]`);
                    let _rAFpending = false;
                    let _lastVal = null;
                    slider.addEventListener('input', () => {
                        const val = parseFloat(slider.value);
                        _lastVal = val;
                        /* ★ 值显示立即更新（无开销） */
                        if (valEl) {
                            if (varName === 'fontSize') {
                                valEl.textContent = val.toFixed(2) + 'x';
                            } else {
                                const u = (valEl?.textContent || '').replace(/^-?[\d.]+/, '').trim() || '';
                                valEl.textContent = val + u;
                            }
                        }
                        /* ★ 预览引擎更新使用 rAF 节流，每帧最多一次 */
                        if (!_rAFpending) {
                            _rAFpending = true;
                            requestAnimationFrame(() => {
                                _rAFpending = false;
                                if (_lastVal === null) return;
                                if (previewEngineInstance) {
                                    if (isGlobal) previewEngineInstance.setGlobalVar(varName, _lastVal);
                                    else previewEngineInstance.setModeVar(varName, _lastVal);
                                }
                            });
                        }
                    });
                });

                /* 按钮组 — 使用 .setting-btn */
                controls.querySelectorAll('.setting-btn-group .setting-btn[data-var]').forEach(btn => {
                    if (btn._hasAppEvent) return;
                    btn._hasAppEvent = true;
                    btn.addEventListener('click', () => {
                        const grp = btn.parentElement;
                        grp.querySelectorAll('.setting-btn').forEach(b => b.classList.remove('active'));
                        btn.classList.add('active');
                        const varName = btn.dataset.var, val = btn.dataset.val;
                        if (varName === 'fontSizeBtn') {
                            if (previewEngineInstance) previewEngineInstance.setModeVar('fontSize', parseInt(val));
                        } else {
                            if (previewEngineInstance) previewEngineInstance.setModeVar(varName, val);
                        }
                    });
                });

                /* 色块 — 使用 .color-swatch + openColorPicker */
                controls.querySelectorAll('.setting-color-row').forEach(row => {
                    if (row._hasAppEvent) return;
                    row._hasAppEvent = true;
                    const varName = row.dataset.var;
                    const isGlobal = row.dataset.scope === 'global' || varName === 'themeColor';
                    const swatches = row.querySelectorAll('.color-swatch');
                    let customColor = null;
                    swatches.forEach(sw => {
                        sw.addEventListener('click', () => {
                            if (sw.dataset.color === '__custom__') {
                                if (isGlobal) {
                                    customColor = appSettings.interface.themeColor || '#ffcc33';
                                } else if (previewEngineInstance) {
                                    const curM = previewEngineInstance.currentMode || 'cover';
                                    const mv = previewEngineInstance.modeVars?.[curM];
                                    if (mv && mv[varName]) customColor = mv[varName];
                                }
                                const initColor = (customColor && customColor.startsWith('#')) ? customColor : '#ffffff';
                                if (typeof openColorPicker === 'function') {
                                    openColorPicker(initColor, (color) => {
                                        customColor = color;
                                        swatches.forEach(s => s.classList.remove('active'));
                                        sw.classList.add('active');
                                        if (isGlobal) {
                                            if (previewEngineInstance) previewEngineInstance.setGlobalVar('themeColor', color);
                                            appSettings.interface.themeColor = color;
                                            applyThemeColor(color);
                                            saveSettings();
                                            syncGlobalThemeSwatches(color);
                                        } else if (previewEngineInstance) {
                                            previewEngineInstance.setModeVar(varName, color);
                                        }
                                    });
                                }
                            } else {
                                swatches.forEach(s => s.classList.remove('active'));
                                sw.classList.add('active');
                                const col = sw.dataset.color;
                                if (isGlobal) {
                                    if (previewEngineInstance) previewEngineInstance.setGlobalVar('themeColor', col);
                                    appSettings.interface.themeColor = col;
                                    applyThemeColor(col);
                                    saveSettings();
                                    syncGlobalThemeSwatches(col);
                                } else if (previewEngineInstance) {
                                    previewEngineInstance.setModeVar(varName, col);
                                }
                            }
                        });
                    });
                });

                /* 开关 — 使用 .setting-toggle */
                controls.querySelectorAll('.setting-toggle[data-var]').forEach(toggle => {
                    if (toggle._hasAppEvent) return;
                    toggle._hasAppEvent = true;
                    toggle.addEventListener('click', () => {
                        toggle.classList.toggle('on');
                        const varName = toggle.dataset.var;
                        const isGlobal = toggle.dataset.scope === 'global';
                        const val = toggle.classList.contains('on');
                        if (previewEngineInstance) {
                            if (isGlobal) previewEngineInstance.setGlobalVar(varName, val);
                            else previewEngineInstance.setModeVar(varName, val);
                        }
                    });
                });

                /* 兼容原生字体下拉（若存在） */
                controls.querySelectorAll('.appearance-font-select[data-var="fontFamily"]').forEach(sel => {
                    if (sel._hasAppEvent) return;
                    sel._hasAppEvent = true;
                    sel.addEventListener('change', () => {
                        if (previewEngineInstance) previewEngineInstance.setModeVar('fontFamily', sel.value || 'inherit');
                    });
                });

                /* 导入自定义字体按钮 */
                controls.querySelectorAll('.appearance-import-font-btn').forEach(btn => {
                    if (btn._hasAppEvent) return;
                    btn._hasAppEvent = true;
                    btn.addEventListener('click', () => {
                        const fileInput = document.createElement('input');
                        fileInput.type = 'file';
                        fileInput.accept = '.ttf,.otf,.woff,.woff2';
                        fileInput.style.display = 'none';
                        document.body.appendChild(fileInput);
                        fileInput.click();
                        fileInput.addEventListener('change', async (e) => {
                            const file = e.target.files[0];
                            if (!file) { fileInput.remove(); return; }
                            try {
                                const fontKey = await saveCustomFont(file);
                                if (fontKey && previewEngineInstance) {
                                    previewEngineInstance.setModeVar('fontFamily', fontKey);
                                    const curM = previewEngineInstance.currentMode || 'cover';
                                    syncModeSectionValues(curM);
                                }
                            } catch (err) {
                                logError('settingsPanel', '导入字体失败:', err);
                                showSettingsHint('导入字体失败');
                            }
                            fileInput.remove();
                        });
                    });
                });
            }

            /* ★ 同步全局主题色色块 */
            function syncGlobalThemeSwatches(color) {
                const targetColor = color || (appSettings.interface && appSettings.interface.themeColor) || '#ffcc33';
                const controls = appearanceControlsEl || (typeof document !== 'undefined' ? document.getElementById('lyricStyleControls') : null);
                if (!controls) return;
                controls.querySelectorAll('.appearance-global-section .color-swatch[data-var="themeColor"]').forEach(sw => {
                    if (sw.dataset.color === '__custom__') {
                        const isPreset = ['#ffcc33', '#ff6b6b', '#51d0ff', '#a8ff51', '#ff8aff', '#ff9540'].includes(targetColor);
                        sw.classList.toggle('active', !isPreset);
                    } else {
                        sw.classList.toggle('active', sw.dataset.color === targetColor);
                    }
                });
            }

            /* ★ 同步模式板块的控件值为当前配置值 */
            function syncModeSectionValues(mode) {
                const controls = appearanceControlsEl || (typeof document !== 'undefined' ? document.getElementById('lyricStyleControls') : null);
                if (!controls) return;
                const targetMode = mode || (previewEngineInstance && previewEngineInstance.currentMode) || currentViewMode || 'cover';
                const mv = (previewEngineInstance && previewEngineInstance.modeVars && previewEngineInstance.modeVars[targetMode])
                    || (appSettings.modeSettings && appSettings.modeSettings[targetMode])
                    || (DEFAULT_SETTINGS.modeSettings && DEFAULT_SETTINGS.modeSettings[targetMode]) || {};

                // 同步全局主题色选择
                syncGlobalThemeSwatches();

                const section = controls.querySelector(`[data-mode-section="${targetMode}"]`);
                if (!section) return;
                section.querySelectorAll('.setting-slider').forEach(slider => {
                    const vn = slider.dataset.var;
                    if (mv[vn] !== undefined) {
                        slider.value = mv[vn];
                        const ve = slider.parentElement?.querySelector(`[data-val="${vn}"]`);
                        if (ve) {
                            /* ★ fontSize 现在是倍率，单位 'x' 而非 'px' */
                            if (vn === 'fontSize') {
                                ve.textContent = parseFloat(mv[vn]).toFixed(2) + 'x';
                            } else {
                                const u = (ve.textContent || '').replace(/^-?[\d.]+/, '').trim() || '';
                                ve.textContent = mv[vn] + u;
                            }
                        }
                    }
                });
                section.querySelectorAll('.setting-btn-group').forEach(grp => {
                    const btns = grp.querySelectorAll('.setting-btn[data-var]');
                    if (btns.length === 0) return;
                    const vn = btns[0].dataset.var;
                    let targetVal = mv[vn];
                    /* fontSizeBtn 已移除，fontSize 现在是倍率滑条 */
                    let matched = false;
                    btns.forEach(btn => {
                        const isMatch = String(btn.dataset.val) === String(targetVal);
                        btn.classList.toggle('active', isMatch);
                        if (isMatch) matched = true;
                    });
                    if (!matched && btns.length > 0) {
                        btns[0].classList.add('active');
                    }
                });
                section.querySelectorAll('.color-swatch').forEach(sw => {
                    const vn = sw.dataset.var;
                    if (mv[vn] !== undefined) sw.classList.toggle('active', sw.dataset.color === String(mv[vn]));
                });
                section.querySelectorAll('.setting-toggle[data-var]').forEach(tg => {
                    const vn = tg.dataset.var;
                    if (mv[vn] !== undefined) tg.classList.toggle('on', !!mv[vn]);
                });
                
                // 同步毛玻璃字体下拉菜单状态
                section.querySelectorAll('.appearance-font-dropdown, .setting-dropdown[data-var="fontFamily"]').forEach(dd => {
                    const trigger = dd.querySelector('.setting-dropdown-trigger');
                    const menu = dd.querySelector('.setting-dropdown-menu');
                    const varName = dd.dataset.var || 'fontFamily';
                    const rawVal = mv[varName];
                    const targetVal = (rawVal === 'inherit' || !rawVal) ? 'default' : rawVal;
                    if (menu) {
                        let matched = false;
                        menu.querySelectorAll('.setting-dropdown-item').forEach(item => {
                            const isMatch = (item.dataset.value === targetVal || (item.dataset.value === 'default' && targetVal === 'inherit'));
                            item.classList.toggle('selected', isMatch);
                            if (isMatch) {
                                if (trigger) {
                                    trigger.textContent = item.textContent;
                                    trigger.dataset.value = item.dataset.value;
                                    trigger.removeAttribute('title');
                                }
                                matched = true;
                            }
                        });
                        if (!matched && menu.firstElementChild && trigger) {
                            menu.firstElementChild.classList.add('selected');
                            trigger.textContent = menu.firstElementChild.textContent;
                            trigger.dataset.value = menu.firstElementChild.dataset.value;
                            trigger.removeAttribute('title');
                        }
                    }
                });

                section.querySelectorAll('.appearance-font-select[data-var="fontFamily"]').forEach(sel => {
                    if (mv.fontFamily) sel.value = mv.fontFamily;
                });
            }
            
/* 启动时从 IndexedDB 加载缓存到内存 */
            async function loadAiCacheFromDB() {
                const all = await aiCacheGetAll();
                let count = 0;
                for (const [key, data] of Object.entries(all)) {
                    aiThemeCache[key] = data;
                    count++;
                }
                if (count > 0) logInfo('settingsPanel', `AI 缓存已从 IndexedDB 加载 ${count} 条`);
                /* 更新 UI 显示缓存数量 */
                const cacheInfoEl = typeof document !== 'undefined' ? document.getElementById('aiCacheInfo') : null;
                if (cacheInfoEl) cacheInfoEl.textContent = `已缓存 ${count} 首歌曲的分析结果`;
            }
/* 启动时加载 AI 缓存（函数定义在 initSettingsPanel 内部，必须在定义后调用） */
            loadAiCacheFromDB();

/* ========== 对外导出（供 200-settings-panel.js 使用） ========== */
export {
    applyLyricSetting,
    applySharedSetting,
    ensureEmotionGlowSliders,
    buildAppearanceControls,
    showModeSection,
    bindAppearanceEvents,
    syncGlobalThemeSwatches,
    syncModeSectionValues,
    loadAiCacheFromDB,
};
