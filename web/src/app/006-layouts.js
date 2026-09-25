/* ============================================================
 * 006-layouts.js — 列表/卡片 布局切换（统一规范）
 * ------------------------------------------------------------
 * B1 歌曲列表视图：list(行式) ⇄ grid(宫格卡)
 *    __songViewBtn(listEl) → 返回切换按钮（已绑定 listEl）
 *    __setSongView/__applySongViewTo → 读/写模式（持久化 aria_song_view）
 * B2 卡片宫格 ⇄ 横向轮播
 *    __cardsCarouselBarHTML() → 「cards-head」工具条（含切换按钮）
 *    __bindCardsCarouselBar(containerEl) → 绑定按钮并应用当前模式
 *    （持久化 aria_cards_carousel，作用于 .rank-board-grid）
 * 样式在 rankings.css「布局切换」段；静态布局不受 perf/reduced-motion 影响。
 * 本模块须在运行时最早期加载（index.js 第三个 import）。
 * ============================================================ */
import { logCatch } from '../services/log.js';
const readPref = (key, on) => { try { return localStorage.getItem(key) === on; } catch (e) { return false; } };
const writePref = (key, v) => { try { localStorage.setItem(key, v ? '1' : '0'); } catch (e) { logCatch('layouts', e); } };

/* ---------- B1 歌曲列表视图 ---------- */
Aria.__songView = readPref('aria_song_view', '1') ? 'grid' : 'list';

Aria.__setSongView = function (mode) {
    Aria.__songView = (mode === 'grid') ? 'grid' : 'list';
    writePref('aria_song_view', Aria.__songView === 'grid');
};

Aria.__applySongViewTo = function (el) {
    if (!el) return;
    el.classList.toggle('song-grid-view', Aria.__songView === 'grid');
};

const VIEW_ICOS = {
    list: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13"></path><circle cx="3.5" cy="6" r="1.1" fill="currentColor" stroke="none"></circle><circle cx="3.5" cy="12" r="1.1" fill="currentColor" stroke="none"></circle><circle cx="3.5" cy="18" r="1.1" fill="currentColor" stroke="none"></circle></svg>',
    grid: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="4" width="7" height="7" rx="1.5"></rect><rect x="14" y="4" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect></svg>'
};

Aria.__songViewBtn = function (listEl) {
    const b = document.createElement('button');
    b.type = 'button';
    const paint = () => {
        const isGrid = Aria.__songView === 'grid';
        b.className = 'view-toggle-btn' + (isGrid ? ' active' : '');
        b.title = isGrid ? '当前：宫格视图，点击切回列表' : '当前：列表视图，点击切换宫格';
        b.innerHTML = isGrid ? VIEW_ICOS.grid : VIEW_ICOS.list;
    };
    paint();
    b.addEventListener('click', (e) => {
        e.stopPropagation();
        Aria.__setSongView(Aria.__songView === 'grid' ? 'list' : 'grid');
        Aria.__applySongViewTo(listEl);
        paint();
    });
    return b;
};

/* ---------- B2 卡片宫格 ⇄ 横向轮播 ---------- */
Aria.__cardsCarousel = readPref('aria_cards_carousel', '1');

Aria.__cardsCarouselBarHTML = function () {
    return '<div class="cards-head"><button class="view-toggle-btn" data-cards-carousel title="布局切换"></button></div>';
};

Aria.__applyCardsCarouselTo = function (gridEl) {
    if (gridEl) gridEl.classList.toggle('cards-carousel', Aria.__cardsCarousel);
};

Aria.__bindCardsCarouselBar = function (containerEl) {
    if (!containerEl) return;
    const btn = containerEl.querySelector('[data-cards-carousel]');
    const gridEl = containerEl.querySelector('.rank-board-grid') || containerEl;
    const paint = () => {
        const on = Aria.__cardsCarousel;
        if (btn) {
            btn.className = 'view-toggle-btn' + (on ? ' active' : '');
            btn.title = on ? '当前：横向轮播，点击切回网格' : '当前：网格，点击切换横向轮播';
            btn.innerHTML = on
                ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="2.5" y="6" width="8" height="11" rx="1.5"></rect><rect x="13" y="6" width="8" height="11" rx="1.5"></rect><path d="M20 8.5h1.2v-3M21.2 8.5v-3M20 15.5h1.2v3M21.2 15.5v3" stroke-linecap="round"></path></svg>'
                : '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M3 9h18M3 15h18" opacity=".5"></path></svg>';
        }
    };
    paint();
    Aria.__applyCardsCarouselTo(gridEl);
    if (btn) {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            Aria.__cardsCarousel = !Aria.__cardsCarousel;
            writePref('aria_cards_carousel', Aria.__cardsCarousel);
            Aria.__applyCardsCarouselTo(gridEl);
            paint();
        });
    }
};