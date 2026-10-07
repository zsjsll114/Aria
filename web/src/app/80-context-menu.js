/* ============================================================
 * 80-context-menu.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 1798-2004 行 | 单元数: 24
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { flyinAutoScaleFont } from './56-playback-misc.js';
import { updatePlayModeIcon } from './75-play-mode.js';
import { moreBtn } from './90-eq.js';
import { esc } from '../utils/formatters.js';
import { logWarn } from '../services/log.js';

updatePlayModeIcon();

/* ========== 通用右键/更多菜单系统 ========== */
const ctxMenu = typeof document !== 'undefined' ? document.getElementById('ctxMenu') : null;

globalThis.ctxSubmenuEl = null;

/* ★ 2026-10-05（P3-a）：静态确认框 #ctxConfirm 及其 .ctx-confirm-* 节点、
   dom 缓存与 globalThis.ctxConfirmCallback 全部退役 —— 那是本仓第三份
   确认框实现（手写居中 + 手绑按钮 + 靠全局变量传回调）。
   确认框现在统一走 021-aria-dialog.js + ui/overlay.js 的浮层契约。 */

/* 通用 SVG 图标 */
const CTX_ICONS = {
            speed: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>',
            download: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>',
            rename: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>',
            trash: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>',
            check: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
            arrow: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>',
            eq: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line></svg>',
            settings: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>',
            /* 默认（cover）模式没有 .bottom-control-bar 的 display:flex 规则，整条底栏隐藏，
               双语排版 / 取链详情 / 应用诊断 三个面板的唯一入口因此挂在「更多」菜单上。 */
            bilingual: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><line x1="4" y1="8.5" x2="20" y2="8.5"></line><line x1="4" y1="15.5" x2="16" y2="15.5" stroke-opacity=".6"></line></svg>',
            link: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>',
            pulse: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>',
            loop: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>',
            /* 歌词海报（需求 2）：相框 + 山，一眼是「出图」 */
            photo: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>'
        };

globalThis.submenuHideTimer = null;

/* 显示一级菜单
   opts.columns：>1 时排成多列网格。「更多」菜单在默认模式下已经堆到 10 项，
   单列会在小窗口/低分辨率下溢出屏幕底（用户反馈），分隔线跨整行。 */
function showCtxMenu(items, x, y, opts = {}) {
            hideCtxMenu();
            const html = items.map(it => {
                if (it.separator) return '<div class="ctx-separator"></div>';
                const danger = it.danger ? ' danger' : '';
                const active = it.active ? ' active-rate' : '';
                const arrow = it.submenu ? `<span class="ctx-arrow">${CTX_ICONS.arrow}</span>` : '';
                return `<div class="ctx-item${danger}${active}" data-ctx-key="${esc(it.key || '')}">${it.icon || ''}<span>${esc(it.label)}</span>${arrow}</div>`;
            }).join('');
            ctxMenu.innerHTML = html;
            const cols = Math.max(1, Math.min(3, Number(opts.columns) || 1));
            ctxMenu.classList.toggle('is-multi', cols > 1);
            ctxMenu.style.setProperty('--ctx-cols', String(cols));
            ctxMenu.style.left = '0px';
            ctxMenu.style.top = '0px';
            ctxMenu.classList.add('visible');

            /* ★ 尺寸必须读 offsetWidth/offsetHeight，不能读 getBoundingClientRect()：
               .ctx-menu 的进场是 transform: scale(0.95)→1，而这一行紧跟在 classList.add('visible')
               之后，transition 还没跑，getBoundingClientRect() 拿到的是**缩放后**的盒子，
               比真实尺寸小 5% → 夹不准，菜单底部照样溢出屏幕（默认模式 10 项时实测 bottom=521 > vh=520）。
               offset* 是布局盒，不受 transform 影响。 */
            const w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
            const winW = window.innerWidth, winH = window.innerHeight;
            let px = x, py = y;
            if (px + w > winW - 8) px = winW - w - 8;
            if (py + h > winH - 8) py = winH - h - 8;
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
            /* 同 showCtxMenu：测量发生在 classList.add('visible') 之前，
               基态的 transform: scale(0.95) 会让 getBoundingClientRect() 小 5%，夹不准。 */
            const subW = ctxSubmenuEl.offsetWidth, subH = ctxSubmenuEl.offsetHeight;
            let px = parentRect.right - 4;
            let py = parentRect.top - 5;
            if (px + subW > window.innerWidth - 8) {
                px = parentRect.left - subW + 4;
            }
            if (py + subH > window.innerHeight - 8) {
                py = window.innerHeight - subH - 8;
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

/* 通用确认对话框：委托到统一的玻璃对话框（021 + ui/overlay.js）。
   保留原签名 (title, msg, onConfirm)，130 / 145 / 90 三处调用点无需改动。
   收益：不再手写居中、不再手绑按钮、不再靠全局变量传回调；
   ESC / 点遮罩 / 焦点陷阱 / dialog 语义 / 层级全部由浮层契约提供。 */
function showCtxConfirm(title, msg, onConfirm) {
            const api = typeof window !== 'undefined' ? window.showGlassConfirm : null;
            if (typeof api !== 'function') {
                /* 021 排在 80 之前求值，这里理论上不可达；真出现也绝不放行
                   「删除歌单 / 删除本地歌曲」这类不可撤销操作（宁可没反应也不误删）。 */
                logWarn('ctxMenu', '[showCtxConfirm] 玻璃确认框未就绪，已放弃这次确认');
                return;
            }
            api({ title: title, desc: msg }).then((ok) => {
                if (ok && typeof onConfirm === 'function') onConfirm();
            });
        }

/* 点击空白关闭菜单 */
if (typeof document !== "undefined") document.addEventListener('click', (e) => {
            if (!ctxMenu.contains(e.target) && (!ctxSubmenuEl || !ctxSubmenuEl.contains(e.target)) && e.target !== moreBtn && !moreBtn.contains(e.target)) {
                hideCtxMenu();
            }
        });

if (typeof document !== "undefined") document.addEventListener('keydown', (e) => {
            /* 确认框的 ESC 交给 ui/overlay.js 的浮层契约（只关最顶层），
               这里只收右键菜单 —— 否则同一次 ESC 会把菜单和对话框一起关掉 */
            if (e.key === 'Escape') hideCtxMenu();
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

export { CTX_ICONS, ctxMenu, hideCtxMenu, hideCtxSubmenu, showCtxConfirm, showCtxMenu, showCtxSubmenu };
