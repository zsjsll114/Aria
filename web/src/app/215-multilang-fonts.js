/* ============================================================
 * 215-multilang-fonts.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 13015-13952 行 | 单元数: 28
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { FONT_DB_NAME, FONT_STORE } from '../config/constants.js';
import { DROPDOWN_OPTIONS, FONT_FAMILY_MAP, FONT_LOCAL_NAMES, LANG_INFO, langFamilyName } from './10-config-state.js';
import { saveSettings } from './180-boot-config.js';
import { setSettingValue } from './190-settings-fontsize.js';
import { applyFontFamily } from './210-color-multilang.js';
import { showSettingsHint } from './220-shortcuts-viewmode.js';
import { logInfo, logWarn, logError } from '../services/log.js';

/* ========== 高级字体设置：按语言 Unicode 范围注入 @font-face ========== */
/* MULTILANG_FAMILY、multilangFontFaces、advFontsGeneration 已提升至顶部 */
/* ★ 按行检测歌词语言（用于多语言字体整行生效）：
         * 日文与中文共享 CJK 统一表意文字码位（如"歌""楽"等繁体/共通汉字），
         * 仅靠 unicode-range 无法区分——同一汉字会同时命中中/日两个 face，
         * 导致日文歌词里假名用日文字体、汉字却落到中文字体。
         * 解决方案：检测整行文本语言，给歌词行打 data-line-lang 标记，
         * 由 CSS 把该语言的字体族提到 font-family 列表最前（日文 face 同时扩展了汉字范围）。
         * 检测优先级：假名→日文；谚文→韩文；仅汉字→中文（中日共码时无法判定，按中文处理） */
function detectLineLang(text) {
            if (!text) return null;
            const adv = appSettings.interface && appSettings.interface.advancedFonts;
            if (!adv || !adv.enabled || !adv.fonts) return null;
            const f = adv.fonts;
            const configured = (k) => f[k] && f[k] !== 'default';
            if (/[\u3041-\u309F\u30A0-\u30FF\u31F0-\u31FF\uFF66-\uFF9D]/.test(text)) {
                return configured('ja') ? 'ja' : null;
            }
            if (/[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/.test(text)) {
                return configured('ko') ? 'ko' : null;
            }
            if (/[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/.test(text)) {
                return configured('zh') ? 'zh' : null;
            }
            return null;
        }

if (typeof window !== 'undefined') Aria.__detectLineLang = detectLineLang;

/* 为已渲染的歌词行补打/清除 data-line-lang 标记（应用字体设置后刷新用） */
function markRenderedLineLangs() {
            if (typeof document === 'undefined') return;
            document.querySelectorAll('.lrc-original').forEach(el => {
                const lang = detectLineLang(el.textContent || '');
                if (lang) el.dataset.lineLang = lang;
                else el.removeAttribute('data-line-lang');
            });
        }

/* 移除旧的多语言 @font-face（CSS + FontFace API） */
function removeAdvancedFontFaces() {
            const oldStyle = typeof document !== 'undefined' ? document.getElementById('adv-font-style') : null;
            if (oldStyle) oldStyle.textContent = '';
            /* 移除通过 FontFace API 注册的多语言字体 */
            multilangFontFaces.forEach(f => document.fonts.delete(f));
            multilangFontFaces = [];
        }

/* 获取字体显示名称（用于下拉选项 label） */
function getFontLabel(fontKey) {
            if (customFonts[fontKey]) return customFonts[fontKey].label;
            const opt = DROPDOWN_OPTIONS.fontFamily.find(o => o.value === fontKey);
            return opt ? opt.label : fontKey;
        }

/* 生成所有可选字体选项（内置 + 自定义）
           ★ 用于"字体设置"内的下拉（全局字体 / 各语言字体）：这里的 default 就是
           "使用全局默认字体"，不应出现"跟随字体设置"这种相对表述（那是外观设置里
           模式字体下拉的专属选项，表示该模式跟随全局字体） */
function getAllFontOptions() {
            const opts = [{ value: 'default', label: '默认（全局字体）' }, ...DROPDOWN_OPTIONS.fontFamily.filter(o => o.value !== 'default')];
            Object.values(customFonts).forEach(cf => {
                opts.push({ value: cf.key, label: cf.label });
            });
            return opts;
        }

/* 应用高级字体设置：为每种语言生成 @font-face + unicode-range */
async function applyAdvancedFonts() {
            const adv = appSettings.interface.advancedFonts;
            if (!adv || !adv.enabled) {
                removeAdvancedFontFaces();
                /* 恢复全局字体 */
                let style = document.getElementById('font-family-style');
                if (style) {
                    style.textContent = `
                        body, button, input, select, textarea, .song-title, .song-artist, .song-album, .playlist-name, .playlist-track-title {
                            font-family: var(--app-font-family) !important;
                        }
                        .player-container,
                        .player-container *,
                        .lyrics-container,
                        .lyrics-container *,
                        .scroll-container,
                        .scroll-container *,
                        .line,
                        .line *,
                        .lrc-original,
                        .lrc-translation,
                        .lrc-romaji,
                        .words-container,
                        .words-container *,
                        .word,
                        .word *,
                        .word-highlight,
                        .pv-poster-container,
                        .pv-poster-container *,
                        .pv-poster-line,
                        .pv-word-block,
                        .pv-char,
                        .pv-bg-text,
                        .vis-dimension-stage,
                        .vis-dimension-stage *,
                        .dim-line,
                        .dim-char,
                        .dim-word,
                        .vis-polyphony-view,
                        .vis-polyphony-view *,
                        .vis-polyphony-words,
                        .vis-polyphony-word {
                            font-family: var(--app-font-family) !important;
                        }
                        .preview-player,
                        .preview-player * {
                            font-family: var(--preview-font-family, var(--app-font-family)) !important;
                        }
                        /* ★ 弹层界面跟随字体设置 */
                        .search-overlay, .search-overlay *,
                        .welcome-overlay, .welcome-overlay *,
                        .view-mode-overlay, .view-mode-overlay *,
                        .eq-panel, .eq-panel *,
                        .ai-models-overlay, .ai-models-overlay *,
                        .lyric-source-overlay, .lyric-source-overlay *,
                        .color-picker-overlay, .color-picker-overlay *,
                        .global-floating-toast, .global-floating-toast * {
                            font-family: var(--app-font-family) !important;
                        }
                    `;
                }
                return;
            }

            /* 防竞态：递增 generation，后续异步操作前检查是否已过期 */
            const gen = ++advFontsGeneration;

            /* 清理旧的 @font-face */
            removeAdvancedFontFaces();

            let cssRules = '';
            /* ★ 自定义字体策略：FontFace API 注册（按语言带 unicode-range），系统字体用 CSS local()
             * 同一 buffer 不重复嵌入 base64，避免 CSS 膨胀导致全局卡顿
             * ★ 每种语言使用独立字体族名（MultiLangFont-<lang>），避免所有语言共用
             *   MULTILANG_FAMILY 造成 face 互相覆盖/回退到错误字体 */
            const customFontTasks = [];
            const usedFams = [];
            /* ★ 语言 → 字体族 映射：供按行语言 CSS 规则使用（见 detectLineLang） */
            const langToFam = {};
            /* ★ 仅当中文字体也已配置时才为日文 face 扩展汉字范围：
             * 日文歌词的"歌""楽"等汉字与中文共享 CJK 统一表意文字码位，
             * 日文 face 若不含汉字范围，这些字符会落到中文字体/全局字体上，
             * 造成同一行"假名衬线、汉字像素"的混排 */
            const zhConfigured = adv.fonts.zh && adv.fonts.zh !== 'default';

            for (const [langCode, info] of Object.entries(LANG_INFO)) {
                const fontKey = adv.fonts[langCode] || 'default';
                if (fontKey === 'default') continue;

                const fam = langFamilyName(langCode);
                /* ★ 日文 face 扩展覆盖 CJK 汉字区（仅当中文字体同时启用，
                 *   避免只配日文字体时接管全部界面汉字） */
                let range = info.range;
                if (langCode === 'ja' && zhConfigured) {
                    range += ', U+4E00-9FFF, U+3400-4DBF, U+F900-FAFF';
                }
                langToFam[langCode] = fam;
                const cf = customFonts[fontKey] || Object.values(customFonts).find(c => c.key === fontKey || c.family === fontKey || c.label === fontKey);
                if (cf && cf.buffer) {
                    /* 自定义字体：收集任务，稍后通过 FontFace API 注册（独立字体族名） */
                    customFontTasks.push({ langCode, fam, cf, range });
                    usedFams.push(fam);
                } else {
                    /* 系统字体：生成 @font-face local() 规则 */
                    let localSrc;
                    if (FONT_LOCAL_NAMES[fontKey]) {
                        localSrc = FONT_LOCAL_NAMES[fontKey].map(n => `local('${n}')`).join(', ');
                    } else if (cf && cf.family) {
                        localSrc = `local('${cf.family}'), local('${cf.label}')`;
                    }
                    if (localSrc) {
                        cssRules += `@font-face { font-family: '${fam}'; src: ${localSrc}; unicode-range: ${range}; }\n`;
                        usedFams.push(fam);
                    }
                }
            }

            /* 先注入系统字体的 CSS @font-face 规则（同步生效） */
            let style = document.getElementById('adv-font-style');
            if (!style) {
                style = document.createElement('style');
                style.id = 'adv-font-style';
                document.head.appendChild(style);
            }
            style.textContent = cssRules;

            /* 应用全局 font-family：各语言独立字体族优先，回退到全局字体 */
            const globalFF = document.documentElement.style.getPropertyValue('--app-font-family') || FONT_FAMILY_MAP.default;
            const headFF = usedFams.length ? usedFams.map(f => `'${f}'`).join(', ') + ', ' + globalFF : globalFF;
            /* ★ 供预览框等消费：仅各语言字体族（不含全局回退），其自行拼接回退 */
            if (typeof window !== 'undefined') Aria.__multilangFamilyList = usedFams.map(f => `'${f}'`).join(', ');
            document.documentElement.style.setProperty('--app-multilang-fonts', usedFams.map(f => `'${f}'`).join(', '));
            /* ★ 导出语言 → 字体族映射（预览引擎按行语言规则消费） */
            if (typeof window !== 'undefined') Aria.__multilangFamMap = langToFam;
            /* ★ 按行语言规则：把该行语言的字体族提到 font-family 最前，
             * 整行（含与中文共享码位的汉字）统一使用同一字体，属性选择器优先级高于类选择器 */
            let lineLangRules = '';
            for (const lc in langToFam) {
                lineLangRules += `
                .lrc-original[data-line-lang="${lc}"],
                .lrc-original[data-line-lang="${lc}"] * {
                    font-family: '${langToFam[lc]}', ${headFF} !important;
                }`;
            }
            let ffStyle = document.getElementById('font-family-style');
            if (!ffStyle) {
                ffStyle = document.createElement('style');
                ffStyle.id = 'font-family-style';
                document.head.appendChild(ffStyle);
            }
            ffStyle.textContent = `
                body, button, input, select, textarea, .song-title, .song-artist, .song-album, .playlist-name, .playlist-track-title {
                            font-family: ${headFF} !important;
                        }
                .player-container,
                .player-container *,
                .lyrics-container,
                .lyrics-container *,
                .scroll-container,
                .scroll-container *,
                .line,
                .line *,
                .lrc-original,
                .lrc-translation,
                .lrc-romaji,
                .words-container,
                .words-container *,
                .word,
                .word *,
                .word-highlight,
                .pv-poster-container,
                .pv-poster-container *,
                .pv-poster-line,
                .pv-word-block,
                .pv-char,
                .pv-bg-text,
                .vis-dimension-stage,
                .vis-dimension-stage *,
                .dim-line,
                .dim-char,
                .dim-word,
                .vis-polyphony-view,
                .vis-polyphony-view *,
                .vis-polyphony-words,
                .vis-polyphony-word {
                    font-family: ${headFF} !important;
                }
                .preview-player,
                .preview-player * {
                    font-family: var(--preview-font-family, ${headFF}) !important;
                }
                .settings-overlay, .settings-overlay *,
                .settings-panel, .settings-panel *,
                .settings-body, .settings-body *,
                .dropdown-menu, .dropdown-menu *,
                .context-menu, .context-menu *,
                .modal, .modal * {
                    font-family: ${headFF} !important;
                }
                /* ★ 弹层界面（搜索/听歌识曲/歌单/收藏/导入/欢迎页/视图切换/
                 *   均衡器/AI模型/歌词源/取色器/全局提示）同样跟随字体设置 */
                .search-overlay, .search-overlay *,
                .welcome-overlay, .welcome-overlay *,
                .view-mode-overlay, .view-mode-overlay *,
                .eq-panel, .eq-panel *,
                .ai-models-overlay, .ai-models-overlay *,
                .lyric-source-overlay, .lyric-source-overlay *,
                .color-picker-overlay, .color-picker-overlay *,
                .global-floating-toast, .global-floating-toast * {
                    font-family: ${headFF} !important;
                }${lineLangRules}
            `;

            /* 异步注册自定义字体（并行，带防竞态检查） */
            if (customFontTasks.length > 0) {
                const registerPromises = customFontTasks.map(({ langCode, fam, cf, range }) => {
                    return (async () => {
                        try {
                            const face = new FontFace(fam, cf.buffer, { unicodeRange: range });
                            await face.load();
                            if (gen !== advFontsGeneration) return;
                            document.fonts.add(face);
                            multilangFontFaces.push(face);
                        } catch (e) {
                            logWarn('multilangFonts', '自定义字体注册多语言失败 (' + langCode + '):', e);
                        }
                    })();
                });
                await Promise.all(registerPromises);
            }

            /* ★ 刷新已渲染歌词行的语言标记（播放中调整字体设置时立即生效） */
            markRenderedLineLangs();
        }

/* 构建高级字体设置区域 UI */
function buildAdvancedFontUI() {
            const container = typeof document !== 'undefined' ? document.getElementById('advancedFontsSection') : null;
            if (!container) return;
            const adv = appSettings.interface.advancedFonts;
            let html = '';
            for (const [langCode, info] of Object.entries(LANG_INFO)) {
                const currentFont = (adv.fonts && adv.fonts[langCode]) || 'default';
                html += `<div class="adv-font-row">
                    <div class="adv-font-info">
                        <div class="adv-font-lang">${info.name}</div>
                        <div class="adv-font-preview" id="advFontPreview-${langCode}" style="font-family: ${getPreviewFontFamily(currentFont)} !important;">${info.preview}</div>
                    </div>
                    <div class="setting-dropdown" id="dropdown-advFont-${langCode}" data-lang="${langCode}"></div>
                </div>`;
            }
            container.innerHTML = html;

            /* 为每个语言下拉初始化选项 */
            for (const langCode of Object.keys(LANG_INFO)) {
                initAdvFontDropdown(langCode);
            }
        }

/* 获取预览文本的内联 font-family */
function getPreviewFontFamily(fontKey) {
            if (fontKey === 'default') return 'inherit';
            if (customFonts[fontKey]) return `'${customFonts[fontKey].family}', sans-serif`;
            return FONT_FAMILY_MAP[fontKey] || 'inherit';
        }

/* 初始化单个语言字体下拉 */
function initAdvFontDropdown(langCode) {
            const dd = typeof document !== 'undefined' ? document.getElementById(`dropdown-advFont-${langCode}`) : null;
            if (!dd) return;
            const adv = appSettings.interface.advancedFonts;
            const currentVal = (adv.fonts && adv.fonts[langCode]) || 'default';
            const options = getAllFontOptions();

            const trigger = document.createElement('div');
            trigger.className = 'setting-dropdown-trigger';
            const currentOpt = options.find(o => o.value === currentVal);
            trigger.textContent = currentOpt ? currentOpt.label : '默认（全局字体）';

            const menu = document.createElement('div');
            menu.className = 'setting-dropdown-menu';
            options.forEach(opt => {
                const item = document.createElement('div');
                item.className = 'setting-dropdown-item' + (opt.value === currentVal ? ' selected' : '');
                item.textContent = opt.label;
                item.dataset.value = opt.value;
                item?.addEventListener('click', () => {
                    trigger.textContent = opt.label;
                    menu.querySelectorAll('.setting-dropdown-item').forEach(i => i.classList.remove('selected'));
                    item.classList.add('selected');
                    /* 更新设置 */
                    if (!appSettings.interface.advancedFonts.fonts) {
                        appSettings.interface.advancedFonts.fonts = {};
                    }
                    appSettings.interface.advancedFonts.fonts[langCode] = opt.value;
                    /* 更新预览字体（!important 防止被全局字体规则覆盖） */
                    const preview = typeof document !== 'undefined' ? document.getElementById(`advFontPreview-${langCode}`) : null;
                    if (preview) preview.style.setProperty('font-family', getPreviewFontFamily(opt.value), 'important');
                    /* 应用高级字体 */
                    applyAdvancedFonts();
                    saveSettings();
                    dd.classList.remove('open');
                });
                menu.appendChild(item);
            });

            /* ★ 双 handler 防重：initCustomDropdowns（220:512）会给所有
               .setting-dropdown 的触发器补绑开合事件（_ariaToggleBound 约定）——
               两处都绑会让一次点击 toggle 两次 = 开了又关（"点不开"的根因） */
            if (!trigger._ariaToggleBound) {
                trigger._ariaToggleBound = true;
                trigger?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    document.querySelectorAll('.setting-dropdown.open').forEach(d => {
                        if (d !== dd) d.classList.remove('open');
                    });
                    dd.classList.toggle('open');
                });
            }

            dd.appendChild(trigger);
            dd.appendChild(menu);
        }

/* 刷新高级字体下拉（自定义字体增删后调用） */
function refreshAdvancedFontDropdowns() {
            const container = typeof document !== 'undefined' ? document.getElementById('advancedFontsSection') : null;
            if (!container) return;
            /* 重建所有下拉 */
            for (const langCode of Object.keys(LANG_INFO)) {
                const dd = typeof document !== 'undefined' ? document.getElementById(`dropdown-advFont-${langCode}`) : null;
                if (!dd) continue;
                const trigger = dd.querySelector('.setting-dropdown-trigger');
                const menu = dd.querySelector('.setting-dropdown-menu');
                if (!trigger || !menu) continue;
                const adv = appSettings.interface.advancedFonts;
                const currentVal = (adv.fonts && adv.fonts[langCode]) || 'default';
                const options = getAllFontOptions();
                menu.innerHTML = '';
                options.forEach(opt => {
                    const item = document.createElement('div');
                    item.className = 'setting-dropdown-item' + (opt.value === currentVal ? ' selected' : '');
                    item.textContent = opt.label;
                    item.dataset.value = opt.value;
                    item?.addEventListener('click', () => {
                        trigger.textContent = opt.label;
                        menu.querySelectorAll('.setting-dropdown-item').forEach(i => i.classList.remove('selected'));
                        item.classList.add('selected');
                        if (!appSettings.interface.advancedFonts.fonts) {
                            appSettings.interface.advancedFonts.fonts = {};
                        }
                        appSettings.interface.advancedFonts.fonts[langCode] = opt.value;
                        const preview = typeof document !== 'undefined' ? document.getElementById(`advFontPreview-${langCode}`) : null;
                        if (preview) preview.style.setProperty('font-family', getPreviewFontFamily(opt.value), 'important');
                        applyAdvancedFonts();
                        saveSettings();
                        dd.classList.remove('open');
                    });
                    menu.appendChild(item);
                });
                const currentOpt = options.find(o => o.value === currentVal);
                trigger.textContent = currentOpt ? currentOpt.label : '默认（全局字体）';
                /* 同步更新预览文本字体 */
                const preview = typeof document !== 'undefined' ? document.getElementById(`advFontPreview-${langCode}`) : null;
                if (preview) preview.style.setProperty('font-family', getPreviewFontFamily(currentVal), 'important');
            }
        }

/* ========== 自定义字体导入与全生命周期管理（IndexedDB + 本地磁盘持久化 + FontFace API） ========== */
globalThis.fontDB = null;

function openFontDB() {
            return new Promise((resolve, reject) => {
                const req = indexedDB.open(FONT_DB_NAME, 1);
                req.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains(FONT_STORE)) {
                        db.createObjectStore(FONT_STORE, { keyPath: 'key' });
                    }
                };
                req.onsuccess = (e) => { fontDB = e.target.result; resolve(fontDB); };
                req.onerror = () => reject(req.error);
            });
        }

function saveFontToDB(key, family, label, buffer, fileName, size) {
            return new Promise((resolve, reject) => {
                const tx = fontDB.transaction([FONT_STORE], 'readwrite');
                tx.objectStore(FONT_STORE).put({ key, family, label, buffer, fileName, size });
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        }

function getAllFontsFromDB() {
            return new Promise((resolve, reject) => {
                const tx = fontDB.transaction([FONT_STORE], 'readonly');
                const req = tx.objectStore(FONT_STORE).getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
            });
        }

function deleteFontFromDB(key) {
            return new Promise((resolve, reject) => {
                const tx = fontDB.transaction([FONT_STORE], 'readwrite');
                tx.objectStore(FONT_STORE).delete(key);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        }

async function saveFontToBackend(fileName, base64Data) {
            try {
                const res = await fetch('/api/font/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    /* 后端 handle_save_font 读取 'fileName' 键；此前误传 'name' 导致
                       字体从未落盘，IndexedDB 一旦清空字体即永久丢失（英文自定义字体失效的根因） */
                    body: JSON.stringify({ fileName: fileName, data: base64Data })
                });
                return res.ok;
            } catch (e) {
                logWarn('multilangFonts', '[Font] 上传字体到本地后端失败:', e);
                return false;
            }
        }

async function deleteFontFromBackend(fileName) {
            try {
                const res = await fetch('/api/font/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    /* 后端 handle_delete_font 同样读取 'fileName' 键 */
                    body: JSON.stringify({ fileName: fileName })
                });
                return res.ok;
            } catch (e) {
                logWarn('multilangFonts', '[Font] 从后端删除字体失败:', e);
                return false;
            }
        }

async function fetchBackendFonts() {
            try {
                const res = await fetch('/api/font/list');
                if (res.ok) {
                    const data = await res.json();
                    return Array.isArray(data) ? data : (data.fonts || []);
                }
            } catch (e) {
                logWarn('multilangFonts', '[Font] 获取本地字体列表失败:', e);
            }
            return [];
        }

function bufferToBase64(buffer) {
            let binary = '';
            const bytes = new Uint8Array(buffer);
            const len = bytes.byteLength;
            for (let i = 0; i < len; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            return window.btoa(binary);
        }

function base64ToBuffer(base64) {
            const binary_string = window.atob(base64);
            const len = binary_string.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                bytes[i] = binary_string.charCodeAt(i);
            }
            return bytes.buffer;
        }

/* 加载单个字体到文档 */
/* ★ 可变字体检测（label/family/fileName 含 VF/variable）——VF 必须声明
   weight range 注册，否则停在默认字重 400：界面 900 字重全靠合成仿粗
   （synthetic bold），文本光栅化成本翻倍 → 全局掉帧 + 观感糊（用户实测
   「思源宋体-VF 显示成黑体观感 + 全页面 1% low 3~5 帧」的联合根因） */
function isVariableFontFace(label, family, fileName) {
    return /(^|[-_.\s])vf([-_.\s]|$)|variable/i.test(`${label || ''} ${family || ''} ${fileName || ''}`);
}

async function loadFontFace(key, family, buffer, label = '', descriptors = null) {
            if (!descriptors && isVariableFontFace(label, family)) {
                descriptors = { weight: '100 900' };
            }
            try {
                /* ★ descriptors：可变字体传 { weight: '100 900' } 后，CSS 的 font-weight
                   会从可变轴取真实字重——否则停在默认字重，900 只能靠浏览器仿粗 */
                const fontFace = descriptors ? new FontFace(family, buffer, descriptors) : new FontFace(family, buffer);
                await fontFace.load();
                document.fonts.add(fontFace);
                if (label && label !== family) {
                    try {
                        const lFace = new FontFace(label, buffer);
                        await lFace.load();
                        document.fonts.add(lFace);
                    } catch(e) {}
                }
                return true;
            } catch (e) {
                logError('multilangFonts', '字体加载失败:', e);
                return false;
            }
        }

/* 保存新字体：保存到 IndexedDB + 本地 src/font/ 磁盘 + FontFace 激活 */
async function saveCustomFont(file) {
            if (!file) return null;
            const baseName = file.name.replace(/\.[^.]+$/, '');
            const fontKey = 'custom_' + Date.now();
            const family = 'CustomFont_' + fontKey;
            const label = baseName;
            try {
                const buffer = await file.arrayBuffer();
                const ok = await loadFontFace(fontKey, family, buffer, label);
                if (!ok) {
                    showSettingsHint('字体加载失败，文件可能已损坏');
                    return null;
                }
                const b64 = bufferToBase64(buffer);
                await saveFontToDB(fontKey, family, label, buffer, file.name, file.size);
                await saveFontToBackend(file.name, b64);
                customFonts[fontKey] = {
                    key: fontKey,
                    family,
                    label,
                    fileName: file.name,
                    size: file.size,
                    buffer
                };
                if (typeof window !== 'undefined') window.customFonts = customFonts;

                refreshFontDropdown();
                refreshAdvancedFontDropdowns();
                /* ★ 重放字体应用：boot 时 applyFontFamily 先于 customFonts 注册执行，
                   resolveFontFamily 匹配不到 → CSS 变量落到键名回退分支
                   （'custom_xxx', sans-serif ≠ 注册族名 CustomFont_custom_xxx）
                   → 自定义字体设置重启后丢失（用户反馈）。注册完成后重放一次。 */
                if (typeof window !== 'undefined' && typeof window.__reapplyFontSettings === 'function') {
                    try { window.__reapplyFontSettings(); } catch (e) {}
                }
                /* ★ 派发确定性就绪事件：document.fonts.ready 在自定义字体开始加载
                   之前就可能已 resolve（之后的新加载不会重新触发它），依赖它做
                   「字体就绪门」的模块（如活字）会永远等不到 → 显示滞后数行。
                   此事件是字体注册完成的权威信号。 */
                try {
                    window.__ariaFontsReady = true;
                    window.dispatchEvent(new CustomEvent('aria-custom-fonts-ready'));
                } catch (e) {}
                renderFontManagerUI();
                showSettingsHint(`已导入并保存字体：${label}`);
                return fontKey;
            } catch (err) {
                logError('multilangFonts', '导入字体失败:', err);
                showSettingsHint('导入字体失败');
                return null;
            }
        }

/* 删除自定义字体：从 IndexedDB + 本地 src/font/ 磁盘删除，并安全重置关联模式的字体 */
async function deleteCustomFont(fontKey) {
            const cf = customFonts[fontKey];
            if (!cf) return;
            try {
                await deleteFontFromDB(fontKey);
                const fileName = cf.fileName || (cf.label + '.ttf');
                await deleteFontFromBackend(fileName);

                delete customFonts[fontKey];

                if (appSettings.interface && appSettings.interface.fontFamily === fontKey) {
                    appSettings.interface.fontFamily = 'default';
                }
                if (appSettings.modeSettings) {
                    for (const m of Object.keys(appSettings.modeSettings)) {
                        if (appSettings.modeSettings[m] && appSettings.modeSettings[m].fontFamily === fontKey) {
                            appSettings.modeSettings[m].fontFamily = 'default';
                        }
                    }
                }
                if (appSettings.interface && appSettings.interface.advancedFonts && appSettings.interface.advancedFonts.fonts) {
                    for (const lang of Object.keys(appSettings.interface.advancedFonts.fonts)) {
                        if (appSettings.interface.advancedFonts.fonts[lang] === fontKey) {
                            appSettings.interface.advancedFonts.fonts[lang] = 'default';
                        }
                    }
                }
                saveSettings();
                applyFontFamily(appSettings.interface.fontFamily || 'default');

                if (previewEngineInstance) {
                    const curM = previewEngineInstance.currentMode || 'cover';
                    if (previewEngineInstance.modeVars && previewEngineInstance.modeVars[curM] && previewEngineInstance.modeVars[curM].fontFamily === fontKey) {
                        previewEngineInstance.setModeVar('fontFamily', 'default');
                    }
                }

                refreshFontDropdown();
                refreshAdvancedFontDropdowns();
                /* ★ 重放字体应用：boot 时 applyFontFamily 先于 customFonts 注册执行，
                   resolveFontFamily 匹配不到 → CSS 变量落到键名回退分支
                   （'custom_xxx', sans-serif ≠ 注册族名 CustomFont_custom_xxx）
                   → 自定义字体设置重启后丢失（用户反馈）。注册完成后重放一次。 */
                if (typeof window !== 'undefined' && typeof window.__reapplyFontSettings === 'function') {
                    try { window.__reapplyFontSettings(); } catch (e) {}
                }
                /* ★ 派发确定性就绪事件：document.fonts.ready 在自定义字体开始加载
                   之前就可能已 resolve（之后的新加载不会重新触发它），依赖它做
                   「字体就绪门」的模块（如活字）会永远等不到 → 显示滞后数行。
                   此事件是字体注册完成的权威信号。 */
                try {
                    window.__ariaFontsReady = true;
                    window.dispatchEvent(new CustomEvent('aria-custom-fonts-ready'));
                } catch (e) {}
                renderFontManagerUI();
                showSettingsHint(`已删除字体：${cf.label}`);
            } catch (e) {
                logError('multilangFonts', '删除字体失败:', e);
                showSettingsHint('删除字体失败');
            }
        }

/* 渲染独立字体管理中心 UI */
function renderFontManagerUI() {
            const listEl = typeof document !== 'undefined' ? document.getElementById('customFontsManagerList') : null;
            if (!listEl) return;
            const fontEntries = Object.values(customFonts);
            if (fontEntries.length === 0) {
                listEl.innerHTML = `
                    <div style="grid-column: 1 / -1; padding: 24px; text-align: center; color: rgba(255,255,255,0.4); font-size: 13px; background: rgba(255,255,255,0.02); border-radius: 10px; border: 1px dashed rgba(255,255,255,0.1);">
                        暂无已安装的自定义字体，请在下方拖拽或点击上传字体文件 (.ttf / .otf / .woff / .woff2)
                    </div>
                `;
                return;
            }

            /* ★ 分类识别（用户要求：按衬线/黑体/楷体/像素等打 tag 并分组折叠）——
               关键词按 label/family/fileName 匹配，命中顺序即优先级 */
            const classifyFont = (cf) => {
                const s = `${cf.label || ''} ${cf.family || ''} ${cf.fileName || ''}`.toLowerCase();
                if (/pixel|像素|fusion|cubic|方舟|zpix|ark|bitmap/.test(s)) return 'pixel';
                if (/kai|楷|文楷|wenkai|hand|script|行书|草书/.test(s)) return 'kai';
                if (/serif|宋|song|明朝|mincho/.test(s)) return 'serif';
                if (/mono|等宽|consolas|courier/.test(s)) return 'mono';
                return 'hei';   // 黑体/无衬线为兜底组（覆盖 Sans/黑/MiSans/HarmonyOS 等大多数）
            };
            const CAT_META = {
                hei:    { label: '黑体 / 无衬线' },
                serif:  { label: '衬线 / 宋体' },
                kai:    { label: '楷体 / 手写' },
                pixel:  { label: '像素' },
                mono:   { label: '等宽' },
                other:  { label: '其他' },
            };
            let collapsed = {};
            try { collapsed = JSON.parse(localStorage.getItem('aria_fontcat_collapsed') || '{}'); } catch (e) { collapsed = {}; }

            const groups = new Map();
            fontEntries.forEach(cf => {
                const c = classifyFont(cf);
                if (!groups.has(c)) groups.set(c, []);
                groups.get(c).push(cf);
            });

            const cardHtml = (cf) => {
                const ext = (cf.fileName ? cf.fileName.split('.').pop() : 'TTF').toUpperCase();
                const sizeStr = cf.size ? (cf.size > 1024 * 1024 ? (cf.size / (1024 * 1024)).toFixed(1) + ' MB' : Math.round(cf.size / 1024) + ' KB') : '';
                const isCurrentGlobal = (appSettings.interface && appSettings.interface.fontFamily === cf.key);
                return `
                    <div class="font-card" data-font-key="${cf.key}">
                        <div class="font-card-header">
                            <div class="font-card-title" title="${cf.label}">
                                <span>${cf.label}</span>
                                <span class="font-card-badge">${ext}</span>
                            </div>
                            ${sizeStr ? `<span class="font-card-size">${sizeStr}</span>` : ''}
                        </div>
                        <div class="font-card-preview" style="font-family: '${cf.family}', sans-serif !important;">
                            歌词播放器 · 永恒记忆 Typography 123
                        </div>
                        <div class="font-card-actions">
                            <button class="font-card-btn apply-btn" data-action="apply">${isCurrentGlobal ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1.5px"><polyline points="20 6 9 17 4 12"/></svg> 当前全局' : '设为全局'}</button>
                            <button class="font-card-btn delete-btn" data-action="delete">删除</button>
                        </div>
                    </div>`;
            };

            let html = '';
            for (const [cat, entries] of groups) {
                const meta = CAT_META[cat] || CAT_META.other;
                const isCollapsed = !!collapsed[cat];
                html += `
                    <div class="font-cat${isCollapsed ? ' collapsed' : ''}" data-cat="${cat}">
                        <div class="font-cat-header" data-cat="${cat}">
                            <span class="font-cat-tag">${meta.label}</span>
                            <span class="font-cat-count">${entries.length}</span>
                            <svg class="font-cat-arrow${isCollapsed ? ' collapsed' : ''}" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                        </div>
                        <div class="font-cat-body-wrap">
                            <div class="font-cat-body">
                                ${entries.map(cardHtml).join('')}
                            </div>
                        </div>
                    </div>`;
            }
            listEl.innerHTML = html;

            /* 分组折叠：header 点击切换（grid-template-rows 0fr/1fr 过渡 = 非线性
               收缩动画），状态持久化 */
            listEl.querySelectorAll('.font-cat-header').forEach(h => {
                h.addEventListener('click', () => {
                    const cat = h.dataset.cat;
                    const catEl = listEl.querySelector(`.font-cat[data-cat="${cat}"]`);
                    const arrow = h.querySelector('.font-cat-arrow');
                    const nowCollapsed = !catEl.classList.contains('collapsed');
                    catEl.classList.toggle('collapsed', nowCollapsed);
                    if (arrow) arrow.classList.toggle('collapsed', nowCollapsed);
                    collapsed[cat] = nowCollapsed;
                    try { localStorage.setItem('aria_fontcat_collapsed', JSON.stringify(collapsed)); } catch (e) {}
                });
            });

            listEl.querySelectorAll('.font-card').forEach(card => {
                const fontKey = card.dataset.fontKey;
                card.querySelector('[data-action="apply"]')?.addEventListener('click', () => {
                    setSettingValue('fontFamily', fontKey);
                    renderFontManagerUI();
                    showSettingsHint(`已应用全局字体：${customFonts[fontKey]?.label}`);
                });
                card.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
                    const cf = customFonts[fontKey];
                    const doDelete = () => deleteCustomFont(fontKey);
                    if (typeof window.showGlassConfirm === 'function') {
                        window.showGlassConfirm({
                            title: '删除字体',
                            desc: `确定要删除字体 "${cf?.label}" 吗？此操作将同时从本地磁盘及各模式设置中移除。`,
                            danger: true,
                        }).then(ok => { if (ok) doDelete(); });
                    } else if (confirm(`确定要删除字体 "${cf?.label}" 吗？此操作将同时从本地磁盘及各模式设置中移除。`)) {
                        doDelete();
                    }
                });
            });
        }

/* 绑定字体上传区域拖拽与点击事件 */
function initFontUploadBindings() {
            if (typeof document === 'undefined') return;
            const dropzone = document.getElementById('fontUploadDropzone');
            const fileInput = document.getElementById('fontUploadFileInput');
            if (dropzone && fileInput) {
                if (dropzone._hasBound) return;
                dropzone._hasBound = true;
                dropzone.addEventListener('click', () => fileInput.click());
                dropzone.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    dropzone.classList.add('dragover');
                });
                dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
                dropzone.addEventListener('drop', async (e) => {
                    e.preventDefault();
                    dropzone.classList.remove('dragover');
                    const files = Array.from(e.dataTransfer.files).filter(f => /\.(ttf|otf|woff|woff2)$/i.test(f.name));
                    for (const f of files) {
                        await saveCustomFont(f);
                    }
                });
                fileInput.addEventListener('change', async (e) => {
                    const files = Array.from(e.target.files);
                    for (const f of files) {
                        await saveCustomFont(f);
                    }
                    fileInput.value = '';
                });
            }
        }

/* 刷新字体下拉列表（重建下拉项）—— 遍历所有字体下拉（外观设置、界面设置、字体设置） */
function refreshFontDropdown() {
            /* ★ 选项所见即所得（用户要求）：每个选项/trigger 用对应字体渲染，
               不跟随全局设置字体。内置五类映射同 FONT_FAMILY_MAP（10-config-state），
               自定义字体用注册族名。 */
            const FONT_PREVIEW_FAMILY = {
                default:  "'Segoe UI', 'Microsoft YaHei', sans-serif",
                serif:    "'SimSun', 'Songti SC', 'STSong', serif",
                kai:      "'KaiTi', 'STKaiti', '楷体', serif",
                hei:      "'SimHei', 'Microsoft YaHei', 'STHeiti', sans-serif",
                fangsong: "'FangSong', 'STFangsong', '仿宋', serif",
                mono:     "'Consolas', 'Courier New', 'Microsoft YaHei', monospace",
            };
            const previewFamilyOf = (val) => (customFonts[val]
                ? `'${customFonts[val].family}', sans-serif`
                : FONT_PREVIEW_FAMILY[val] || 'inherit');
            if (typeof document === 'undefined') return;
            const dds = Array.from(document.querySelectorAll('.setting-dropdown[data-var="fontFamily"], .setting-dropdown[data-setting="fontFamily"], #dropdown-fontFamily, #dropdown-fontFamily-main, .appearance-font-dropdown'));
            const uniqueDds = Array.from(new Set(dds));
            uniqueDds.forEach(dd => {
                let trigger = dd.querySelector('.setting-dropdown-trigger');
                if (!trigger) {
                    trigger = document.createElement('div');
                    trigger.className = 'setting-dropdown-trigger';
                    dd.appendChild(trigger);
                }
                let menu = dd.querySelector('.setting-dropdown-menu');
                if (!menu) {
                    menu = document.createElement('div');
                    menu.className = 'setting-dropdown-menu';
                    dd.appendChild(menu);
                }

                /* ★ 开合事件统一由 initCustomDropdowns（220-shortcuts-viewmode.js）幂等挂载，
                   本函数只维护内容（trigger 文本 / menu 选项），避免 addEventListener 与
                   onclick 双重绑定互相"开→关"抵消导致下拉无法弹出 */
                const isAppearanceModeDropdown = dd.hasAttribute('data-var') || dd.classList.contains('appearance-font-dropdown') || Boolean(dd.closest('[data-mode-section]'));
                const parentModeSec = dd.closest('[data-mode-section]');
                const modeName = parentModeSec ? parentModeSec.dataset.modeSection : null;

                /* 获取当前配置值 */
                let currentVal = 'default';
                if (isAppearanceModeDropdown && modeName && appSettings.modeSettings && appSettings.modeSettings[modeName]) {
                    const raw = appSettings.modeSettings[modeName].fontFamily;
                    currentVal = (raw === 'inherit' || !raw) ? 'default' : raw;
                } else if (isAppearanceModeDropdown && previewEngineInstance && previewEngineInstance.modeVars) {
                    const curM = previewEngineInstance.currentMode || currentViewMode || 'cover';
                    const raw = previewEngineInstance.modeVars[curM] && previewEngineInstance.modeVars[curM].fontFamily;
                    currentVal = (raw === 'inherit' || !raw) ? 'default' : raw;
                } else {
                    const raw = appSettings.interface && appSettings.interface.fontFamily;
                    currentVal = (raw === 'inherit' || !raw) ? 'default' : raw;
                }

                menu.innerHTML = '';
                /* ★ 外观设置下拉框才有"跟随字体设置"，字体设置下拉框用"默认" */
                const allOpts = isAppearanceModeDropdown
                    ? [
                        { value: 'default', label: '跟随字体设置' },
                        { value: 'serif', label: '宋体' },
                        { value: 'kai', label: '楷体' },
                        { value: 'hei', label: '黑体' },
                        { value: 'fangsong', label: '仿宋' },
                        { value: 'mono', label: '等宽字体' }
                    ]
                    : [
                        { value: 'default', label: '默认' },
                        { value: 'serif', label: '宋体' },
                        { value: 'kai', label: '楷体' },
                        { value: 'hei', label: '黑体' },
                        { value: 'fangsong', label: '仿宋' },
                        { value: 'mono', label: '等宽字体' }
                    ];
                Object.values(customFonts).forEach(cf => {
                    /* ★ 可变字体标注（用户实测：16.9MB 的 -VF 全屏大字渲染成本高，
                       全局掉帧）——label 明示 + title 提示开销，引导低端设备用静态
                       字重版 */
                    const isVf = isVariableFontFace(cf.label, cf.family, cf.fileName);
                    allOpts.push({ value: cf.key, label: isVf ? `${cf.label}（可变字体）` : cf.label, vf: isVf });
                });

                const onSelectFont = (fontVal, fontLabel) => {
                    trigger.textContent = fontLabel;
                    trigger.dataset.value = fontVal;
                    trigger.title = fontLabel;
                    menu.querySelectorAll('.setting-dropdown-item').forEach(i => i.classList.remove('selected'));
                    dd.classList.remove('open');

                    if (isAppearanceModeDropdown) {
                        const targetMode = modeName || (previewEngineInstance && previewEngineInstance.currentMode) || currentViewMode || 'cover';
                        if (!appSettings.modeSettings) appSettings.modeSettings = {};
                        if (!appSettings.modeSettings[targetMode]) appSettings.modeSettings[targetMode] = {};
                        appSettings.modeSettings[targetMode].fontFamily = fontVal;
                        if (previewEngineInstance) {
                            previewEngineInstance.setModeVar('fontFamily', fontVal);
                        }
                        if (currentViewMode === targetMode) {
                            /* ★ 模式字体独立生效，不覆盖全局字体设置：
                               default/inherit 表示「跟随字体设置」 */
                            applyFontFamily(fontVal === 'default' || fontVal === 'inherit'
                                ? (appSettings.interface && appSettings.interface.fontFamily) || 'default'
                                : fontVal);
                        }
                        saveSettings();
                    } else {
                        setSettingValue('fontFamily', fontVal);
                    }
                };

                allOpts.forEach(opt => {
                    const item = document.createElement('div');
                    const isSel = (opt.value === currentVal || (opt.value === 'default' && (currentVal === 'inherit' || !currentVal)));
                    item.className = 'setting-dropdown-item' + (isSel ? ' selected' : '');
                    item.textContent = opt.label;
                    item.dataset.value = opt.value;
                    /* ★ 所见即所得：选项本身用对应字体渲染 */
                    item.style.fontFamily = previewFamilyOf(opt.value);
                    item.onclick = (e) => {
                        e.stopPropagation();
                        item.classList.add('selected');
                        onSelectFont(opt.value, opt.label);
                    };
                    menu.appendChild(item);
                });

                const activeOpt = allOpts.find(o => o.value === currentVal || (o.value === 'default' && (currentVal === 'inherit' || !currentVal))) || allOpts[0];
                trigger.textContent = activeOpt ? activeOpt.label : (isAppearanceModeDropdown ? '跟随字体设置' : '默认');
                trigger.dataset.value = activeOpt ? activeOpt.value : 'default';
                trigger.title = trigger.textContent;
                /* ★ 可变字体选中时提示渲染开销 */
                if (activeOpt && activeOpt.vf) trigger.title += '（可变字体：全屏大字渲染开销较高，低端设备建议换用静态字重版本）';
                /* ★ trigger 用当前选中字体渲染（所见即所得） */
                trigger.style.fontFamily = previewFamilyOf(activeOpt ? activeOpt.value : 'default');

                /* ★ 多语言字体匹配开启时不拦截全局字体下拉：各语言设置优先、未配置的语言
                   仍回退到全局字体（applyAdvancedFonts 的 unicode-range 回退链依赖它），
                   故全局字体下拉应保持可点，仅以 title 提示作用域。 */
                const advEnabled = appSettings.interface && appSettings.interface.advancedFonts && appSettings.interface.advancedFonts.enabled;
                if (!isAppearanceModeDropdown && advEnabled) {
                    trigger.title = '已开启多语言字体匹配：全局字体作为未配置语言的回退字体';
                }
            });
        }

/* 初始化自定义字体：从 IndexedDB + 本地磁盘 src/font/ 加载所有字体 */
async function initCustomFonts() {
            try {
                await openFontDB();
                const fonts = await getAllFontsFromDB();
                for (const f of fonts) {
                    const ok = await loadFontFace(f.key, f.family, f.buffer, f.label);
                    if (ok) {
                        customFonts[f.key] = {
                            key: f.key,
                            family: f.family,
                            label: f.label,
                            fileName: f.fileName || (f.label + '.ttf'),
                            size: f.size || (f.buffer ? f.buffer.byteLength : 0),
                            buffer: f.buffer
                        };
                    }
                }

                if (typeof window !== 'undefined') window.customFonts = customFonts;

                /* 同步后端本地 src/font/ 文件夹中的字体文件 */
                try {
                    const backendFonts = await fetchBackendFonts();
                    for (const bf of backendFonts) {
                        const baseName = (bf.name || bf.fileName || '').replace(/\.[^.]+$/, '');
                        const alreadyExists = Object.values(customFonts).some(c => c.fileName === (bf.fileName || bf.name) || c.label === baseName);
                        if (!alreadyExists && (bf.url || bf.data)) {
                            let buffer = null;
                            if (bf.data) {
                                buffer = base64ToBuffer(bf.data);
                            } else if (bf.url) {
                                try {
                                    const resp = await fetch(bf.url);
                                    if (resp.ok) buffer = await resp.arrayBuffer();
                                } catch(e) {}
                            }
                            if (buffer) {
                                const fontKey = 'custom_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
                                const family = 'CustomFont_' + fontKey;
                                /* 文件名含 VF 的可变字体：声明字重区间，各档字重取真实轴值 */
                                const isVF = /\bVF\b|Variable/i.test(baseName) || /VF/.test(bf.fileName || '');
                                const ok = await loadFontFace(fontKey, family, buffer, baseName, isVF ? { weight: '100 900' } : null);
                                if (ok) {
                                    customFonts[fontKey] = {
                                        key: fontKey,
                                        family,
                                        label: baseName,
                                        fileName: bf.fileName || bf.name,
                                        size: bf.size || buffer.byteLength,
                                        buffer
                                    };
                                    await saveFontToDB(fontKey, family, baseName, buffer, bf.fileName || bf.name, bf.size);
                                }
                            }
                        }
                    }
                } catch (beErr) {
                    logWarn('multilangFonts', '[Font] 同步本地字体后端失败:', beErr);
                }

                if (typeof window !== 'undefined') window.customFonts = customFonts;

                refreshFontDropdown();
                refreshAdvancedFontDropdowns();
                /* ★ 重放字体应用：boot 时 applyFontFamily 先于 customFonts 注册执行，
                   resolveFontFamily 匹配不到 → CSS 变量落到键名回退分支
                   （'custom_xxx', sans-serif ≠ 注册族名 CustomFont_custom_xxx）
                   → 自定义字体设置重启后丢失（用户反馈）。注册完成后重放一次。 */
                if (typeof window !== 'undefined' && typeof window.__reapplyFontSettings === 'function') {
                    try { window.__reapplyFontSettings(); } catch (e) {}
                }
                /* ★ 派发确定性就绪事件：document.fonts.ready 在自定义字体开始加载
                   之前就可能已 resolve（之后的新加载不会重新触发它），依赖它做
                   「字体就绪门」的模块（如活字）会永远等不到 → 显示滞后数行。
                   此事件是字体注册完成的权威信号。 */
                try {
                    window.__ariaFontsReady = true;
                    window.dispatchEvent(new CustomEvent('aria-custom-fonts-ready'));
                } catch (e) {}
                renderFontManagerUI();
                initFontUploadBindings();

                /* 重新应用当前激活的字体 */
                const curMode = (previewEngineInstance && previewEngineInstance.currentMode) || currentViewMode || 'cover';
                const modeFont = (appSettings.modeSettings && appSettings.modeSettings[curMode] && appSettings.modeSettings[curMode].fontFamily);
                const globalFont = appSettings.interface && appSettings.interface.fontFamily;
                applyFontFamily(modeFont && modeFont !== 'default' ? modeFont : globalFont);
                if (previewEngineInstance) {
                    previewEngineInstance.setModeVar('fontFamily', modeFont || globalFont || 'default');
                }
            } catch (e) {
                logError('multilangFonts', '加载自定义字体失败:', e);
            }
        }

export { applyAdvancedFonts, base64ToBuffer, bufferToBase64, buildAdvancedFontUI, deleteCustomFont, deleteFontFromBackend, deleteFontFromDB, detectLineLang, fetchBackendFonts, getAllFontOptions, getAllFontsFromDB, getFontLabel, getPreviewFontFamily, initAdvFontDropdown, initCustomFonts, initFontUploadBindings, loadFontFace, markRenderedLineLangs, openFontDB, refreshAdvancedFontDropdowns, refreshFontDropdown, removeAdvancedFontFaces, renderFontManagerUI, saveCustomFont, saveFontToBackend, saveFontToDB };
