/* ============================================================
 * 110-keyboard-nav.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 3070-3539 行 | 单元数: 16
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { audio } from './20-lyrics-render.js';
import { favoriteBtn, nextBtn, playBtn, prevBtn } from './30-dom-refs.js';
import { getDuration } from './56-playback-misc.js';
import { updateLyricsHighlight } from './57-wordcloud-camera.js';
import { updatePlaybackPosition } from './65-playback-position.js';
import { updateVolume } from './70-audio-engine.js';
import { moreBtn } from './90-eq.js';

/* ========== 全键盘导航系统 ==========
           Tab / Shift+Tab → 在功能区之间切换
           ↑↓←→           → 在当前功能区内切换选中项
           Enter / Space   → 激活当前选中项
           5秒无操作自动退出导航模式，恢复快捷键
        */
globalThis.kbNavActive = false;

/* 是否处于键盘导航模式 */
globalThis.kbNavTimer = null;

/* 5秒超时计时器 */
globalThis.kbCurrentGroup = -1;

/* 当前功能组索引 */
globalThis.kbCurrentIndex = -1;

/* 当前组内元素索引 */
function kbClearSelected() {
document.querySelectorAll('.kb-nav-selected').forEach(el => el.classList.remove('kb-nav-selected'));
        }

function kbApplySelected() {
            const groups = getKbFocusGroups();
            if (kbCurrentGroup < 0 || kbCurrentGroup >= groups.length) return;
            const group = groups[kbCurrentGroup];
            if (!group || kbCurrentIndex < 0 || kbCurrentIndex >= group.length) return;
            kbClearSelected();
            const el = group[kbCurrentIndex];
            if (el) {
                el.classList.add('kb-nav-selected');
                /* 滚动到可见 */
                el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                /* P5：滑条被选中时同步 aria 数值（避免每帧写 DOM） */
                if (el.hasAttribute && el.hasAttribute('data-kb-slider')) kbUpdateSliderAria(el);
            }
        }

function kbEnterNavMode() {
            kbNavActive = true;
            document.body.classList.add('kb-nav-active');
            if (kbNavTimer) clearTimeout(kbNavTimer);
            kbNavTimer = setTimeout(kbExitNavMode, 5000);
        }

function kbExitNavMode() {
            kbNavActive = false;
            document.body.classList.remove('kb-nav-active');
            kbClearSelected();
            kbCurrentGroup = -1;
            kbCurrentIndex = -1;
            if (kbNavTimer) { clearTimeout(kbNavTimer); kbNavTimer = null; }
        }

function kbResetTimer() {
            if (kbNavActive && kbNavTimer) {
                clearTimeout(kbNavTimer);
                kbNavTimer = setTimeout(kbExitNavMode, 5000);
            }
        }

/* 判断元素是否可见且可交互 */
function kbIsVisible(el) {
            if (!el) return false;
            if (el.disabled) return false;
            if (typeof el.checkVisibility === 'function') {
                /* P5：checkVisibility 能正确处理 position:fixed（offsetParent 恒为 null 的误判）
                   与 visibility:hidden 的弹出子菜单 */
                try {
                    if (!el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })) return false;
                } catch (err) {
                    if (el.offsetParent === null && el.tagName !== 'INPUT') return false;
                }
            } else if (el.offsetParent === null && el.tagName !== 'INPUT') {
                /* 老浏览器回退（对 fixed 元素可能漏判，但仅作兜底） */
                return false;
            }
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return false;
            return true;
        }

/* P5：通用可交互元素选择器 —— 新增控件只要语义正确即自动纳入 Tab 导航 */
const KB_INTERACTIVE_SELECTOR = [
            'button:not([disabled])',
            'a[href]',
            'input:not([type="hidden"])',
            'textarea',
            'select',
            '[tabindex]:not([tabindex="-1"])',
            '.setting-toggle', '.color-swatch', '.setting-btn', '.shortcut-key',
            '.setting-dropdown-trigger', '.setting-dropdown-item',
            '.ctx-item', '.ctx-confirm-btn', '.source-btn',
            '.result-item', '.playlist-item', '.add-to-playlist-item',
            '.settings-tab', '.eq-preset', '.view-mode-card', '.welcome-btn',
            '.speed-option', '.more-item', '#mobileLyricPreview'
        ].join(',');

/* P5：主界面分簇容器 —— 同一容器内的控件归为一组，Tab 在组间跳转 */
const KB_CLUSTER_SELECTOR = [
            '.top-action-buttons', '#mobilePageToggle',
            '.song-info-container', '#mobileLyricPreview',
            '.progress-container', '.playback-controls', '.volume-container',
            '.lyric-offset-control',
            '.bottom-song-card', '.bottom-progress-area', '.bottom-controls-row',
            '.bottom-center-area', '.bottom-control-bar'
        ].join(',');

/* P5：同步滑条的 aria 数值（选中或调整时调用，避免每帧写 DOM） */
function kbUpdateSliderAria(el) {
            if (!el || !el.hasAttribute('data-kb-slider')) return;
            const type = el.getAttribute('data-kb-slider');
            let val = 0;
            if (type === 'volume') {
                /* 显示手柄位置（全局 volume），与主音量条一致（音量已走对数曲线，勿用 audio.volume 直读） */
                val = Math.round(typeof volume !== 'undefined' ? volume : ((audio.volume || 0) * 100));
            } else if (audio.duration && isFinite(audio.duration)) {
                val = Math.round((audio.currentTime / audio.duration) * 100);
            }
            el.setAttribute('aria-valuenow', String(val));
            el.setAttribute('aria-valuetext', val + '%');
        }

/* P5：方向键调整当前选中的滑条值（返回 true 表示消费了该按键） */
function kbAdjustSelectedSlider(delta) {
            const gs = getKbFocusGroups();
            if (kbCurrentGroup < 0 || kbCurrentGroup >= gs.length) return false;
            const group = gs[kbCurrentGroup];
            if (!group || kbCurrentIndex < 0 || kbCurrentIndex >= group.length) return false;
            const el = group[kbCurrentIndex];
            if (!el || !el.hasAttribute('data-kb-slider')) return false;
            const type = el.getAttribute('data-kb-slider');
            if (type === 'volume') {
                const cur = Math.round(typeof volume !== 'undefined' ? volume : 80);
                if (typeof updateVolume === 'function') updateVolume(cur + delta);
                else audio.volume = Math.max(0, Math.min(1, ((cur + delta) / 100)));
            } else {
                const durationSec = getDuration() / 1000;
                if (durationSec > 0 && isFinite(durationSec)) {
                    const stepSec = durationSec * 0.02; /* 每次步进总时长 2% */
                    audio.currentTime = Math.max(0, Math.min(durationSec - 0.05, audio.currentTime + delta * stepSec));
                    currentTime = audio.currentTime * 1000;
                    isUserScrolling = false;
                    if (typeof scrollTimeout !== 'undefined' && scrollTimeout) clearTimeout(scrollTimeout);
                    updateLyricsHighlight();
                    updatePlaybackPosition();
                }
            }
            kbUpdateSliderAria(el);
            return true;
        }

/* 动态获取当前所有可见的功能区列表 */
function getKbFocusGroups() {
            const groups = [];
            const pc = typeof document !== 'undefined' ? document.querySelector('.player-container') : null;

            /* === 弹窗/面板优先 === */

            /* 确认对话框（最高优先级） */
            const ctxConfirm = typeof document !== 'undefined' ? document.getElementById('ctxConfirm') : null;
            if (ctxConfirm && ctxConfirm.classList.contains('visible')) {
                const btns = Array.from(ctxConfirm.querySelectorAll('.ctx-confirm-btn')).filter(kbIsVisible);
                if (btns.length) groups.push(btns);
                return groups; /* 确认框打开时只聚焦它 */
            }

            /* 右键菜单 */
            const ctxMenu = typeof document !== 'undefined' ? document.getElementById('ctxMenu') : null;
            if (ctxMenu && ctxMenu.classList.contains('visible')) {
                const items = Array.from(ctxMenu.querySelectorAll('.ctx-item')).filter(kbIsVisible);
                if (items.length) groups.push(items);
                return groups;
            }

            /* 欢迎页 */
            const welcomeOverlay = typeof document !== 'undefined' ? document.getElementById('welcomeOverlay') : null;
            if (welcomeOverlay && !welcomeOverlay.classList.contains('hidden')) {
                const btn = welcomeOverlay.querySelector('.welcome-btn');
                if (btn && kbIsVisible(btn)) groups.push([btn]);
                return groups;
            }

            /* 搜索弹窗 */
            const searchOverlay = typeof document !== 'undefined' ? document.getElementById('searchOverlay') : null;
            if (searchOverlay && searchOverlay.classList.contains('visible')) {
                /* 源切换 + 搜索框 */
                const header = Array.from(searchOverlay.querySelectorAll('.source-btn')).filter(kbIsVisible);
                const closeBtn = searchOverlay.querySelector('#searchCloseBtn');
                if (closeBtn && kbIsVisible(closeBtn)) header.push(closeBtn);
                if (header.length) groups.push(header);
                /* 搜索输入 + 按钮 */
                const searchBox = [];
                const inp = searchOverlay.querySelector('#searchInput');
                const sBtn = searchOverlay.querySelector('#searchBtn');
                if (inp && kbIsVisible(inp)) searchBox.push(inp);
                if (sBtn && kbIsVisible(sBtn)) searchBox.push(sBtn);
                if (searchBox.length) groups.push(searchBox);
                /* 搜索结果 */
                const results = Array.from(searchOverlay.querySelectorAll('.result-item')).filter(kbIsVisible);
                if (results.length) groups.push(results);
                return groups;
            }

            /* 收藏列表弹窗 */
            const favOverlay = typeof document !== 'undefined' ? document.getElementById('favoritesOverlay') : null;
            if (favOverlay && favOverlay.classList.contains('visible')) {
                const closeBtn = favOverlay.querySelector('#favoritesCloseBtn');
                if (closeBtn && kbIsVisible(closeBtn)) groups.push([closeBtn]);
                const items = Array.from(favOverlay.querySelectorAll('.result-item')).filter(kbIsVisible);
                if (items.length) groups.push(items);
                return groups;
            }

            /* 歌单弹窗 */
            const plOverlay = typeof document !== 'undefined' ? document.getElementById('playlistsOverlay') : null;
            if (plOverlay && plOverlay.classList.contains('visible')) {
                /* 头部按钮组 */
                const headerBtns = Array.from(plOverlay.querySelectorAll('.playlist-header-actions button')).filter(kbIsVisible);
                const closeBtn = plOverlay.querySelector('#playlistsCloseBtn');
                if (closeBtn && kbIsVisible(closeBtn)) headerBtns.push(closeBtn);
                if (headerBtns.length) groups.push(headerBtns);
                /* 歌单/歌曲列表 */
                const items = Array.from(plOverlay.querySelectorAll('.playlist-item, .result-item')).filter(kbIsVisible);
                if (items.length) groups.push(items);
                return groups;
            }

            /* 添加到歌单弹窗 */
            const addPlOverlay = typeof document !== 'undefined' ? document.getElementById('addToPlaylistOverlay') : null;
            if (addPlOverlay && addPlOverlay.classList.contains('visible')) {
                const closeBtn = addPlOverlay.querySelector('#addToPlaylistCloseBtn');
                if (closeBtn && kbIsVisible(closeBtn)) groups.push([closeBtn]);
                const items = Array.from(addPlOverlay.querySelectorAll('.add-to-playlist-item')).filter(kbIsVisible);
                if (items.length) groups.push(items);
                return groups;
            }

            /* 导入歌单弹窗 */
            const importOverlay = typeof document !== 'undefined' ? document.getElementById('importPlaylistOverlay') : null;
            if (importOverlay && importOverlay.classList.contains('visible')) {
                const inp = importOverlay.querySelector('#importUrlInput');
                const btn = importOverlay.querySelector('#importConfirmBtn');
                const closeBtn = importOverlay.querySelector('#importPlaylistCloseBtn');
                const g = [];
                if (closeBtn && kbIsVisible(closeBtn)) g.push(closeBtn);
                if (inp && kbIsVisible(inp)) g.push(inp);
                if (btn && kbIsVisible(btn)) g.push(btn);
                if (g.length) groups.push(g);
                return groups;
            }

            /* 设置面板 */
            const settingsOverlay = typeof document !== 'undefined' ? document.getElementById('settingsOverlay') : null;
            if (settingsOverlay && settingsOverlay.classList.contains('visible')) {
                /* 关闭按钮 */
                const closeBtn = settingsOverlay.querySelector('#settingsCloseBtn');
                if (closeBtn && kbIsVisible(closeBtn)) groups.push([closeBtn]);
                /* Tab 标签栏 */
                const tabs = Array.from(settingsOverlay.querySelectorAll('.settings-tab')).filter(kbIsVisible);
                if (tabs.length) groups.push(tabs);
                /* 当前活动 section 中的可交互控件（P5：改用通用选择器，新增控件自动纳入） */
                const activeSection = settingsOverlay.querySelector('.settings-section.active');
                if (activeSection) {
                    const controls = Array.from(activeSection.querySelectorAll(KB_INTERACTIVE_SELECTOR)).filter(kbIsVisible);
                    if (controls.length) groups.push(controls);
                    /* 如果有下拉菜单打开，加入其选项 */
                    const openMenus = activeSection.querySelectorAll('.setting-dropdown.open');
                    openMenus.forEach(dd => {
                        const items = Array.from(dd.querySelectorAll('.setting-dropdown-item')).filter(kbIsVisible);
                        if (items.length) groups.push(items);
                    });
                }
                return groups;
            }

            /* 样式切换弹窗 */
            const viewModeOverlay = typeof document !== 'undefined' ? document.getElementById('viewModeOverlay') : null;
            if (viewModeOverlay && viewModeOverlay.classList.contains('visible')) {
                const closeBtn = viewModeOverlay.querySelector('#viewModeCloseBtn');
                if (closeBtn && kbIsVisible(closeBtn)) groups.push([closeBtn]);
                const cards = Array.from(viewModeOverlay.querySelectorAll('.view-mode-card')).filter(kbIsVisible);
                if (cards.length) groups.push(cards);
                return groups;
            }

            /* EQ 面板（P5：通用扫描 —— 头部按钮/预设/频段滑块按 DOM 顺序自动覆盖） */
            const eqPanel = typeof document !== 'undefined' ? document.getElementById('eqPanel') : null;
            if (eqPanel && eqPanel.classList.contains('visible')) {
                const ctrl = Array.from(eqPanel.querySelectorAll(KB_INTERACTIVE_SELECTOR)).filter(kbIsVisible);
                if (ctrl.length) groups.push(ctrl);
                return groups;
            }

            /* === 主播放器界面（无弹窗时）：P5 通用扫描 —— 一切可交互控件自动纳入，
               歌词行除外；按功能容器分簇，Tab 在簇间跳转、方向键在簇内移动 === */
            if (!pc) return groups;

            const all = Array.from(pc.querySelectorAll(KB_INTERACTIVE_SELECTOR)).filter(el => {
                if (!kbIsVisible(el)) return false;
                /* 歌词行与逐字词块不参与 Tab 导航（需求明确排除） */
                if (el.closest('.line, .word, .preview-line, .preview-word')) return false;
                return true;
            });

            /* Map 保持插入序：各簇按其中首个元素出现的文档顺序排列 */
            const hostMap = new Map();
            for (const el of all) {
                const host = el.closest(KB_CLUSTER_SELECTOR);
                if (!hostMap.has(host)) hostMap.set(host, []);
                hostMap.get(host).push(el);
            }
            for (const els of hostMap.values()) {
                if (els.length) groups.push(els);
            }

            return groups;
        }

/* Tab 键处理：在功能区之间切换 */
if (typeof document !== "undefined") document.addEventListener('keydown', function(event) {
            const tag = document.activeElement?.tagName;
            const inInput = (tag === 'INPUT' || tag === 'TEXTAREA');
            const key = event.key;

            /* 快捷键录制模式不干预 */
            if (typeof recordingShortcut !== 'undefined' && recordingShortcut) return;

            /* ★ 接管只读显示模式：本地键盘快捷键全部让位（播放/切歌/进度/音量） */
            if (typeof window !== 'undefined' && window.Aria && window.Aria.__npActive && window.Aria.__npActive()) return;

            /* === Tab 键：进入/切换功能区 === */
            if (key === 'Tab' && !event.ctrlKey && !event.altKey) {
                /* 在输入框中允许原生 Tab 行为 */
                if (inInput && !kbNavActive) return;

                event.preventDefault();
                kbEnterNavMode();

                const groups = getKbFocusGroups();
                if (groups.length === 0) return;

                if (event.shiftKey) {
                    /* Shift+Tab：上一个功能区 */
                    kbCurrentGroup--;
                    if (kbCurrentGroup < 0) kbCurrentGroup = groups.length - 1;
                } else {
                    /* Tab：下一个功能区 */
                    kbCurrentGroup++;
                    if (kbCurrentGroup >= groups.length) kbCurrentGroup = 0;
                }
                /* 选中该组第一个元素 */
                kbCurrentIndex = 0;
                kbApplySelected();
                kbResetTimer();
                return;
            }

            /* === 导航模式下的方向键和 Enter === */
            if (kbNavActive) {
                /* 在输入框中不拦截方向键 */
                if (inInput && key !== 'Escape') {
                    kbResetTimer();
                    return;
                }

                if (key === 'ArrowDown' || key === 'ArrowRight') {
                    event.preventDefault();
                    /* P5：当前选中项是滑条时，方向键调整数值而非移动焦点 */
                    if (!kbAdjustSelectedSlider(+1)) {
                        const groups = getKbFocusGroups();
                        if (kbCurrentGroup >= 0 && kbCurrentGroup < groups.length) {
                            const group = groups[kbCurrentGroup];
                            kbCurrentIndex = (kbCurrentIndex + 1) % group.length;
                            kbApplySelected();
                        }
                    }
                    kbResetTimer();
                    return;
                }

                if (key === 'ArrowUp' || key === 'ArrowLeft') {
                    event.preventDefault();
                    /* P5：同上，反方向调值 */
                    if (!kbAdjustSelectedSlider(-1)) {
                        const groups = getKbFocusGroups();
                        if (kbCurrentGroup >= 0 && kbCurrentGroup < groups.length) {
                            const group = groups[kbCurrentGroup];
                            kbCurrentIndex = (kbCurrentIndex - 1 + group.length) % group.length;
                            kbApplySelected();
                        }
                    }
                    kbResetTimer();
                    return;
                }

                if (key === 'Enter' || key === ' ') {
                    event.preventDefault();
                    const groups = getKbFocusGroups();
                    if (kbCurrentGroup >= 0 && kbCurrentGroup < groups.length) {
                        const group = groups[kbCurrentGroup];
                        if (kbCurrentIndex >= 0 && kbCurrentIndex < group.length) {
                            const el = group[kbCurrentIndex];
                            if (el) {
                                /* P5：滑条不响应 Enter 点击激活（合成事件坐标为 0 会误跳到进度开头） */
                                if (el.hasAttribute && el.hasAttribute('data-kb-slider')) {
                                    /* no-op */
                                } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                                    el.focus();
                                    if (el.type === 'text') { try { el.select(); } catch (eSel) {} }
                                } else {
                                    el.click();
                                }
                            }
                        }
                    }
                    kbResetTimer();
                    return;
                }

                if (key === 'Escape') {
                    event.preventDefault();
                    kbExitNavMode();
                    return;
                }

                /* 其他按键重置计时器 */
                kbResetTimer();
                /* 导航模式下不执行下面的快捷键逻辑 */
                return;
            }

            /* === 非导航模式：原有快捷键逻辑 === */
            const sc = appSettings.shortcuts;

            /* Ctrl+← / Ctrl+→ = 前进/后退 */
            if (event.ctrlKey && !event.shiftKey && !event.altKey) {
                if (key === 'ArrowLeft' && !inInput) {
                    event.preventDefault();
                    const step = (appSettings.playback.seekStep || 5) * 1000;
                    if (audio.duration) audio.currentTime = Math.max(0, audio.currentTime - step / 1000);
                    return;
                } else if (key === 'ArrowRight' && !inInput) {
                    event.preventDefault();
                    const step = (appSettings.playback.seekStep || 5) * 1000;
                    if (audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + step / 1000);
                    return;
                }
            }

            if (key === sc.playPause) {
                if (inInput) return;
                event.preventDefault();
                playBtn.click();
            } else if (key === sc.prev) {
                if (inInput) return;
                if (event.ctrlKey) return;
                event.preventDefault();
                prevBtn.click();
            } else if (key === sc.next) {
                if (inInput) return;
                if (event.ctrlKey) return;
                event.preventDefault();
                nextBtn.click();
            } else if (key === sc.volumeUp) {
                if (inInput) return;
                event.preventDefault();
                updateVolume(Math.min(100, volume + 5));
            } else if (key === sc.volumeDown) {
                if (inInput) return;
                event.preventDefault();
                updateVolume(Math.max(0, volume - 5));
            } else if (key === sc.favorite) {
                if (inInput) return;
                event.preventDefault();
                favoriteBtn.click();
            } else if (key === sc.toggleLyrics) {
                if (inInput) return;
                event.preventDefault();
                const lc = typeof document !== 'undefined' ? document.querySelector('.lyrics-container') : null;
                if (lc) lc.style.display = (lc.style.display === 'none' ? '' : 'none');
            } else if (key === sc.more) {
                if (inInput) return;
                event.preventDefault();
                moreBtn.click();
            }
        });

export { KB_CLUSTER_SELECTOR, KB_INTERACTIVE_SELECTOR, getKbFocusGroups, kbAdjustSelectedSlider, kbApplySelected, kbClearSelected, kbEnterNavMode, kbExitNavMode, kbIsVisible, kbResetTimer, kbUpdateSliderAria };
