/* ============================================================
 * 80-context-menu.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 1798-2004 行 | 单元数: 24
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { flyinAutoScaleFont } from './56-playback-misc.js';
import { updatePlayModeIcon } from './75-play-mode.js';
import { moreBtn } from './90-eq.js';
import { esc } from '../utils/formatters.js';

updatePlayModeIcon();

/* ========== 通用右键/更多菜单系统 ========== */
const ctxMenu = typeof document !== 'undefined' ? document.getElementById('ctxMenu') : null;

const ctxConfirm = typeof document !== 'undefined' ? document.getElementById('ctxConfirm') : null;

const ctxConfirmTitle = typeof document !== 'undefined' ? document.getElementById('ctxConfirmTitle') : null;

const ctxConfirmMsg = typeof document !== 'undefined' ? document.getElementById('ctxConfirmMsg') : null;

const ctxConfirmOk = typeof document !== 'undefined' ? document.getElementById('ctxConfirmOk') : null;

const ctxConfirmCancel = typeof document !== 'undefined' ? document.getElementById('ctxConfirmCancel') : null;

globalThis.ctxSubmenuEl = null;

/* 二级菜单元素 */
globalThis.ctxConfirmCallback = null;

/* 通用 SVG 图标 */
const CTX_ICONS = {
            speed: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>',
            download: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>',
            rename: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>',
            trash: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>',
            check: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
            arrow: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>',
            eq: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line></svg>',
            settings: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>'
        };

globalThis.submenuHideTimer = null;

/* 显示一级菜单 */
function showCtxMenu(items, x, y) {
            hideCtxMenu();
            const html = items.map(it => {
                if (it.separator) return '<div class="ctx-separator"></div>';
                const danger = it.danger ? ' danger' : '';
                const active = it.active ? ' active-rate' : '';
                const arrow = it.submenu ? `<span class="ctx-arrow">${CTX_ICONS.arrow}</span>` : '';
                return `<div class="ctx-item${danger}${active}" data-ctx-key="${esc(it.key || '')}">${it.icon || ''}<span>${esc(it.label)}</span>${arrow}</div>`;
            }).join('');
            ctxMenu.innerHTML = html;
            ctxMenu.style.left = '0px';
            ctxMenu.style.top = '0px';
            ctxMenu.classList.add('visible');

            /* 修正位置防止溢出 */
            const rect = ctxMenu.getBoundingClientRect();
            const winW = window.innerWidth, winH = window.innerHeight;
            let px = x, py = y;
            if (px + rect.width > winW - 8) px = winW - rect.width - 8;
            if (py + rect.height > winH - 8) py = winH - rect.height - 8;
            ctxMenu.style.left = Math.max(8, px) + 'px';
            ctxMenu.style.top = Math.max(8, py) + 'px';

            /* 绑定菜单项事件 */
            ctxMenu.querySelectorAll('.ctx-item').forEach(el => {
                const key = el.dataset.ctxKey;
                const item = items.find(i => i.key === key);
                if (!item) return;
                if (item.submenu) {
                    /* 鼠标移入或点击均显示二级菜单 */
                    const openSub = () => {
                        clearTimeout(submenuHideTimer);
                        showCtxSubmenu(item.submenu, el);
                    };
                    el?.addEventListener('mouseenter', openSub);
                    el?.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        openSub();
                    });
                    /* 鼠标离开父项时延迟收起二级菜单 */
                    el?.addEventListener('mouseleave', () => {
                        submenuHideTimer = setTimeout(() => {
                            hideCtxSubmenu();
                        }, 200);
                    });
                } else if (item.onClick) {
                    el?.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        const cb = item.onClick;
                        hideCtxMenu();
                        cb();
                    });
                }
            });
        }

/* 显示二级菜单 */
function showCtxSubmenu(items, parentEl) {
            hideCtxSubmenu();
            ctxSubmenuEl = document.createElement('div');
            ctxSubmenuEl.className = 'ctx-menu';
            const html = items.map(it => {
                if (it.separator) return '<div class="ctx-separator"></div>';
                const danger = it.danger ? ' danger' : '';
                const active = it.active ? ' active-rate' : '';
                const icon = it.active ? CTX_ICONS.check : (it.icon || '');
                return `<div class="ctx-item${danger}${active}" data-ctx-key="${esc(it.key || '')}">${icon}<span>${esc(it.label)}</span></div>`;
            }).join('');
            ctxSubmenuEl.innerHTML = html;
            document.body.appendChild(ctxSubmenuEl);
            /* 先定位再触发动画 */
            const parentRect = parentEl.getBoundingClientRect();
            ctxSubmenuEl.style.left = '0px';
            ctxSubmenuEl.style.top = '0px';
            const subRect = ctxSubmenuEl.getBoundingClientRect();
            let px = parentRect.right - 4;
            let py = parentRect.top - 5;
            if (px + subRect.width > window.innerWidth - 8) {
                px = parentRect.left - subRect.width + 4;
            }
            if (py + subRect.height > window.innerHeight - 8) {
                py = window.innerHeight - subRect.height - 8;
            }
            ctxSubmenuEl.style.left = Math.max(8, px) + 'px';
            ctxSubmenuEl.style.top = Math.max(8, py) + 'px';
            /* 强制 reflow 后添加 visible 触发淡入动画 */
            void ctxSubmenuEl.offsetHeight;
            ctxSubmenuEl.classList.add('visible');

            /* 鼠标进入二级菜单时取消收起定时器 */
            ctxSubmenuEl?.addEventListener('mouseenter', () => {
                clearTimeout(submenuHideTimer);
            });
            /* 鼠标离开二级菜单时收起 */
            ctxSubmenuEl?.addEventListener('mouseleave', () => {
                submenuHideTimer = setTimeout(() => {
                    hideCtxSubmenu();
                }, 200);
            });

            ctxSubmenuEl.querySelectorAll('.ctx-item').forEach(el => {
                const key = el.dataset.ctxKey;
                const item = items.find(i => i.key === key);
                if (item && item.onClick) {
                    el?.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        const cb = item.onClick;
                        hideCtxMenu();
                        cb();
                    });
                }
            });
        }

function hideCtxSubmenu() {
            if (ctxSubmenuEl) {
                const el = ctxSubmenuEl;
                ctxSubmenuEl = null;
                el.classList.remove('visible');
                /* 等淡出动画结束后移除 */
                setTimeout(() => { if (el.parentNode) el.remove(); }, 250);
            }
        }

function hideCtxMenu() {
            ctxMenu.classList.remove('visible');
            hideCtxSubmenu();
        }

/* 显示确认对话框 */
function showCtxConfirm(title, msg, onConfirm) {
            ctxConfirmTitle.textContent = title;
            ctxConfirmMsg.textContent = msg;
            ctxConfirmCallback = onConfirm;
            /* 使用 offsetWidth/offsetHeight（不受 transform 影响）来居中 */
            const w = ctxConfirm.offsetWidth;
            const h = ctxConfirm.offsetHeight;
            ctxConfirm.style.left = ((window.innerWidth - w) / 2) + 'px';
            ctxConfirm.style.top = ((window.innerHeight - h) / 2) + 'px';
            ctxConfirm.classList.add('visible');
        }

function hideCtxConfirm() {
            ctxConfirm.classList.remove('visible');
            ctxConfirmCallback = null;
            /* 重置按钮状态（可能被 EQ 错误提示修改过） */
            ctxConfirmCancel.textContent = '取消';
            ctxConfirmOk.textContent = '确定';
            ctxConfirmCancel.style.display = '';
            ctxConfirmOk.style.display = '';
        }

ctxConfirmOk?.addEventListener('click', () => {
            const cb = ctxConfirmCallback;
            hideCtxConfirm();
            if (cb) cb();
        });

ctxConfirmCancel?.addEventListener('click', hideCtxConfirm);

/* 点击空白关闭菜单 */
if (typeof document !== "undefined") document.addEventListener('click', (e) => {
            if (!ctxMenu.contains(e.target) && (!ctxSubmenuEl || !ctxSubmenuEl.contains(e.target)) && e.target !== moreBtn && !moreBtn.contains(e.target)) {
                hideCtxMenu();
            }
        });

if (typeof document !== "undefined") document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { hideCtxMenu(); hideCtxConfirm(); }
        });

if (typeof window !== "undefined") window.addEventListener('blur', hideCtxMenu);

if (typeof window !== "undefined") window.addEventListener('resize', hideCtxMenu);

/* 窗口缩放时：视觉模式、PV模式与飞入模式自适应重绘 */
if (typeof window !== "undefined") window.addEventListener('resize', () => {
    if (document.querySelector('.player-container.view-flyin') && typeof flyinAutoScaleFont === 'function') {
        flyinAutoScaleFont();
    }
    if (typeof mainVisManager !== 'undefined' && mainVisManager) {
        mainVisManager.handleResize();
    }
    if (typeof pvEngineInstance !== 'undefined' && pvEngineInstance && typeof pvEngineInstance.handleResize === 'function') {
        pvEngineInstance.handleResize();
    }
});

export { CTX_ICONS, ctxConfirm, ctxConfirmCancel, ctxConfirmMsg, ctxConfirmOk, ctxConfirmTitle, ctxMenu, hideCtxConfirm, hideCtxMenu, hideCtxSubmenu, showCtxConfirm, showCtxMenu, showCtxSubmenu };
