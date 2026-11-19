/* ============================================================
 * 275-play-source.js — 取链透明化的 UI 层（todos #15）
 *
 * 数据在 services/playSource.js（命中记录）+ services/log.js（降级轨迹），
 * 本分片只做渲染与开合，不产生任何取链判断。
 * 弹窗壳复用 .lyric-source-*（与「选择歌词来源」「下载歌词」同一套）。
 * ============================================================ */
import { escapeHtml } from '../utils/formatters.js';
import { channelMeta, describeBadge, describeDetail, getResolveTrace, onResolveChange, qualityLabel } from '../services/playSource.js';
import { getLanguage, translatePhrase } from '../core/i18n.js';
import { logCatch } from '../services/log.js';

const tx = translatePhrase;

/* 日志等级白名单：等级要拼进 class，不能直接信缓冲里的值 */
const LV_CLASSES = new Set(['info', 'warn', 'error', 'catch']);

const PLATFORM_ICON_SRC = {
    qq: 'src/img/QQMusicIcon.svg',
    netease: 'src/img/NeteaseMusicIcon.svg',
    kugou: 'src/img/KugouMusicIcon.svg',
    kuwo: 'src/img/KuwoMusicIcon.svg',
};

const LOCAL_ICON_SVG = '<svg class="ps-platform-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>';
const GENERIC_ICON_SVG = '<svg class="ps-platform-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5l3 2"></path></svg>';

const PLATFORM_LABEL_BY_KEY = {
    qq: 'QQ音乐',
    netease: '网易云音乐',
    kugou: '酷狗音乐',
    kuwo: '酷我音乐',
    local: '本地文件',
};

/* 同一首歌的角标可能有两枚（底栏 + 默认模式主信息列），按属性一次刷新，
   免得两份渲染逻辑各写一半、切歌后其中一枚停在上一首的来源。 */
function badgeEls() { return Array.from(document.querySelectorAll('[data-play-source-badge]')); }

function badgeTooltip(info) {
    if (!info) return '';
    const isEn = getLanguage() === 'en-US';
    const platZh = PLATFORM_LABEL_BY_KEY[info.platformKey] || '';
    const platLabel = platZh ? tx(platZh) : '';
    if (info.tier === 'pending') return platLabel ? `${platLabel} · ${tx('正在获取…')}` : tx('正在获取…');
    if (info.tier === 'failed') return platLabel ? `${platLabel} · ${tx('取链失败')}` : tx('取链失败');
    if (info.tier === 'retry') return isEn ? (platLabel ? `${platLabel} · Retrying` : 'Retrying') : info.text;
    return platLabel || (isEn ? tx('Unknown source') : info.text);
}

function badgeIconHtml(platformKey) {
    const src = PLATFORM_ICON_SRC[platformKey];
    if (src) return `<img class="ps-platform-icon" src="${escapeHtml(src)}" alt="">`;
    if (platformKey === 'local') return LOCAL_ICON_SVG;
    return GENERIC_ICON_SVG;
}

function renderBadge() {
    const els = badgeEls();
    if (!els.length) return;
    const info = describeBadge();
    for (const el of els) {
        if (!info) {
            el.hidden = true;
            el.innerHTML = '';
            el.removeAttribute('data-ps-platform');
            el.removeAttribute('title');
            el.removeAttribute('aria-label');
            continue;
        }
        el.hidden = false;
        el.innerHTML = badgeIconHtml(info.platformKey);
        if (info.platformKey) el.dataset.psPlatform = info.platformKey;
        else el.removeAttribute('data-ps-platform');
        el.classList.toggle('is-fallback', !!info.fallback);
        el.classList.toggle('is-pending', info.tier === 'pending' || info.tier === 'retry');
        const tip = badgeTooltip(info);
        el.setAttribute('title', tip);
        el.setAttribute('aria-label', tip);
    }
}

function translateDetailValue(val) {
    const s = String(val || '');
    if (!s || getLanguage() !== 'en-US') return s;
    const hit = tx(s);
    if (hit !== s) return hit;
    return s;
}

/** 打开取链详情面板 */
export function showPlaySourceModal() {
    const overlay = document.getElementById('playSourceOverlay');
    const body = document.getElementById('playSourceBody');
    if (!overlay || !body) return;

    const isEn = getLanguage() === 'en-US';
    const { rows, logs, hit } = describeDetail();
    const csd = (typeof globalThis !== 'undefined' && globalThis.currentSongData) || {};
    const songTitle = csd.title || tx('（当前未播放歌曲）');
    const songArtist = csd.artist || '';

    let html = `<div class="ps-hint">${escapeHtml(songTitle)}${songArtist ? ' - ' + escapeHtml(songArtist) : ''}</div>`;

    html += '<div class="ps-rows">' + (rows.length
        ? rows.map(r => `<div class="k">${escapeHtml(tx(r.k))}</div><div class="v">${escapeHtml(translateDetailValue(r.v))}</div>`).join('')
        : `<div class="k">${escapeHtml(tx('状态'))}</div><div class="v">${escapeHtml(tx('尚未记录到取链过程'))}</div>`) + '</div>';

    /* 命中渠道的完整名字单独一行：日志里只有简称，图标角标不展示文字 */
    if (hit) {
        const meta = channelMeta(hit.channelId);
        html += `<div class="lyric-badge ${meta.tier === 'selfhost' || meta.tier === 'local' ? 'score-high' : 'score-med'}">${escapeHtml(tx(meta.name))}</div>`;
        const q = qualityLabel(hit.quality);
        if (q) html += ` <span class="lyric-badge score-med">${escapeHtml(tx(q))}</span>`;
    }

    /* 解析池会带回逐源尝试的结构化结果——这才是「每一级为什么失败」的权威答案 */
    if (hit && hit.tried && hit.tried.length) {
        const title = isEn ? `Resolve-pool attempts (${hit.tried.length})` : `解析池逐源尝试（${hit.tried.length} 级）`;
        html += `<div class="ps-section-title">${escapeHtml(title)}</div><div class="ps-log">`;
        html += hit.tried.map((step, i) => {
            const state = tx(step.ok ? '命中' : '失败');
            const ms = typeof step.ms === 'number' ? `${step.ms}ms` : '';
            const q = tx(qualityLabel(step.quality)) || (step.ext ? String(step.ext).toLowerCase() : '');
            const bits = [`#${i + 1}`, step.provider || '?', q, state, ms].filter(Boolean).join(' · ');
            return `<div class="row ${step.ok ? 'lv-ok' : 'lv-fail'}"><span class="m">${escapeHtml(bits)}</span>`
                + (step.err ? `<span class="err">${escapeHtml(tx(step.err))}</span>` : '') + '</div>';
        }).join('');
        html += '</div>';
    }

    const traceTitle = isEn ? `Fallback trace (${logs.length})` : `降级轨迹（${logs.length} 条）`;
    html += `<div class="ps-section-title">${escapeHtml(traceTitle)}</div>`;
    html += '<div class="ps-log">' + (logs.length
        ? logs.map(r => {
            const t = new Date(r.ts);
            const hhmmss = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
            const lv = LV_CLASSES.has(r.level) ? r.level : 'info';
            return `<div class="row lv-${lv}"><span class="t">${hhmmss}</span><span class="tag">[${escapeHtml(r.tag)}]</span><span class="m">${escapeHtml(r.msg)}</span></div>`;
          }).join('')
        : `<div class="row"><span class="m">${escapeHtml(tx('本次取链没有留下日志（说明第一级就命中了）'))}</span></div>`) + '</div>';

    body.innerHTML = html;
    overlay.classList.add('visible');
}

function closePlaySourceModal() {
    document.getElementById('playSourceOverlay')?.classList.remove('visible');
}

export function initPlaySourceUI() {
    renderBadge();
    onResolveChange(() => {
        try { renderBadge(); } catch (e) { logCatch('playSource', e); }
    });
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('aria:languagechange', () => {
            try {
                renderBadge();
                if (document.getElementById('playSourceOverlay')?.classList.contains('visible')) {
                    showPlaySourceModal();
                }
            } catch (e) { logCatch('playSource', e); }
        });
    }

    badgeEls().forEach(el => {
        el.addEventListener('click', () => {
            try { showPlaySourceModal(); } catch (e) { logCatch('playSource', e); }
        });
    });
    document.getElementById('playSourceCloseBtn')?.addEventListener('click', closePlaySourceModal);
    document.getElementById('playSourceOverlay')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closePlaySourceModal();
    });

    /* 右下角「更多」菜单入口（与「切换歌词来源」同级） */
    document.getElementById('morePlaySourceItem')?.addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('moreSubmenu')?.classList.remove('open');
        try { showPlaySourceModal(); } catch (err) { logCatch('playSource', err); }
    });
}

initPlaySourceUI();
if (typeof window !== 'undefined') {
    window.showPlaySourceModal = showPlaySourceModal;
    /* 控制台只读探针：低配设备上「为什么只有 128k」要能不刷日志就看出答案 */
    if (window.Aria) window.Aria.playSource = { getTrace: getResolveTrace, describe: describeBadge, show: showPlaySourceModal };
}
