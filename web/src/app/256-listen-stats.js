/* ============================================================
 * app/256-listen-stats.js — 听歌统计「声音手账 / 情绪档案」渲染与纪念卡导出
 *
 * 定位：替换 258-rankings.js 原来干瘪的三组横条计数，提供带情绪温度与叙事感的
 * 听觉档案弹窗（保持 #statsOverlay / .search-modal 既有宿主与无障碍契约）：
 *   1) 听觉人格主视觉卡（零点守夜人 / 晨光拾音者 / 暮色收藏家 / 光影漫游者…）
 *   2) 心头白月光单曲焦点（模糊封面氛围铺底 + 反复聆听统计 + 一键重播）
 *   3) AI 情绪光谱与情感关键词（聚合 LyricsPlayerDB.aiThemeCache + 当前分析结果）
 *   4) 24 小时昼夜音律弧（SVG 波形 + 柱状图实时悬停读数）+ 近 14 日节拍日历
 *   5) 带封面图与收藏徽标的 Top 歌曲 / 可直达歌手页的 Top 歌手
 *   6) 本地 High-DPI 声音纪念卡 PNG 导出（复用 lyricPoster 的代理拉封面与保存工具）
 * ============================================================ */
import { esc } from '../utils/formatters.js';
import { translatePhrase } from '../core/i18n.js';
import { sanitizeImageUrl } from './100-cover-background.js';
import { getFavorites } from './120-search-results.js';
import { loadPlaylistTrack } from './135-crossfade.js';
import { loadOnlineSong } from './175-track-index-online.js';
import { buildCollectionQueue } from '../core/playlistQueue.js';
import { aiCacheGetAll } from '../services/aiCache.js';
import { POSTER_FONT, loadCoverImage, loadLogoImage, saveBlob } from '../core/lyricPoster.js';
import { logCatch, logWarn } from '../services/log.js';
import {
    buildStatsReport,
    defaultPlayStats,
    formatCompactDuration,
    formatStatsDuration,
    normalizeStatsData,
    sanitizeHexColor,
} from '../core/listenStatsReport.js';

export const STATS_STORAGE_KEY = 'aria_play_stats';
const RECENT_STORAGE_KEY = 'aria_recent_history';
const TAG = 'listenStats';
const tx = translatePhrase;

const $ = (id) => (typeof document !== 'undefined' ? document.getElementById(id) : null);

let _openSeq = 0;
let _lastReport = null;
let _exportBusy = false;

function toast(zh) {
    const msg = tx(zh);
    try {
        if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
            window.showToast(msg);
            return;
        }
    } catch (e) { logCatch(TAG, e); }
}

function safeCoverUrl(raw) {
    const cleaned = sanitizeImageUrl(String(raw || ''));
    if (!cleaned || typeof cleaned !== 'string') return '';
    if (/^(https?:|blob:|data:image\/|\/)/i.test(cleaned)) return cleaned;
    return '';
}

function hexToRgbTuple(hex) {
    const h = sanitizeHexColor(hex);
    if (!h) return '';
    const r = parseInt(h.slice(1, 3), 16);
    const g = parseInt(h.slice(3, 5), 16);
    const b = parseInt(h.slice(5, 7), 16);
    return `${r}, ${g}, ${b}`;
}

export function loadStoredStats() {
    try {
        return normalizeStatsData(JSON.parse(localStorage.getItem(STATS_STORAGE_KEY) || 'null'));
    } catch (e) {
        logCatch(TAG, e);
        return defaultPlayStats();
    }
}

export function saveStoredStats(st) {
    try {
        localStorage.setItem(STATS_STORAGE_KEY, JSON.stringify(st));
    } catch (e) {
        logCatch(TAG, e);
    }
}

function readRecentHistorySafe() {
    try {
        if (typeof window !== 'undefined' && typeof window.getRecentHistory === 'function') {
            const arr = window.getRecentHistory();
            if (Array.isArray(arr)) return arr;
        }
    } catch (e) { logCatch(TAG, e); }
    try {
        const raw = JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY) || '[]');
        return Array.isArray(raw) ? raw : [];
    } catch (e) {
        logCatch(TAG, e);
        return [];
    }
}

function personaGlyphSvg(id) {
    if (id === 'lateNight') {
        return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    }
    if (id === 'dawn') {
        return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 18a5 5 0 0 0-10 0"/><line x1="12" y1="2" x2="12" y2="9"/><line x1="4.22" y1="10.22" x2="5.64" y2="11.64"/><line x1="1" y1="18" x2="3" y2="18"/><line x1="21" y1="18" x2="23" y2="18"/><line x1="18.36" y1="11.64" x2="19.78" y2="10.22"/><line x1="23" y1="22" x2="1" y2="22"/></svg>';
    }
    if (id === 'dusk') {
        return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>';
}

function musicNoteSvg(size = 18) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
}

function renderEmptyStateHtml() {
    return `
        <div class="stats-empty-stage">
            <div class="stats-empty-rings" aria-hidden="true">
                <span></span><span></span><span></span>
                <div class="stats-empty-disc">${musicNoteSvg(26)}</div>
            </div>
            <div class="stats-empty-title">${esc(tx('初遇频段'))}</div>
            <p class="stats-empty-desc">${esc(tx('点亮任意一首歌，这里会慢慢写下你的深夜时段、偏爱声线与情绪色卡'))}</p>
            <button type="button" class="stats-cta-btn" id="statsExploreBtn">${esc(tx('去发现音乐'))}</button>
        </div>`;
}

function renderHeroHtml(report) {
    const ov = report.overview;
    const p = report.persona;
    const durMain = formatStatsDuration(ov.totalMs, tx);
    const todayStr = formatCompactDuration(ov.todayMs, tx);
    const weekStr = formatCompactDuration(ov.weekMs, tx);

    const chips = [];
    if (ov.companionDays > 0) {
        chips.push(`<span class="stats-chip"><span>${esc(tx('相伴'))}</span><strong>${ov.companionDays}</strong><span>${esc(tx('天'))}</span></span>`);
    }
    if (ov.streakDays > 0) {
        chips.push(`<span class="stats-chip"><span>${esc(tx('连续聆听'))}</span><strong>${ov.streakDays}</strong><span>${esc(tx('天'))}</span></span>`);
    }
    if (p.dominantSharePct > 0) {
        chips.push(`<span class="stats-chip"><span>${esc(tx(p.peakWindowLabel))}</span><strong>${p.dominantSharePct}%</strong></span>`);
    }
    if (ov.albumEquiv >= 1) {
        chips.push(`<span class="stats-chip"><span>${esc(tx('约听完'))}</span><strong>${esc(ov.albumEquiv)}</strong><span>${esc(tx('张专辑'))}</span></span>`);
    }

    const sinceHtml = ov.firstDateLabel
        ? `<span class="stats-kicker-dot"></span><span>${esc(tx('自'))} ${esc(ov.firstDateLabel)} ${esc(tx('起相伴'))}</span>`
        : '';

    return `
        <section class="stats-hero">
            <div class="stats-hero-glow" aria-hidden="true"></div>
            <div class="stats-hero-wave" aria-hidden="true">${buildHeroWaveSvg(report.circadian.hours)}</div>
            <div class="stats-hero-top">
                <div class="stats-hero-copy">
                    <div class="stats-kicker">
                        <span class="stats-kicker-icon">${personaGlyphSvg(p.id)}</span>
                        <span>${esc(tx('声音手账'))}</span>
                        ${sinceHtml}
                    </div>
                    <h2 class="stats-persona-title">${esc(tx(p.title))}</h2>
                    <p class="stats-persona-quote">${esc(tx(p.quote))}</p>
                </div>
                <button type="button" class="stats-card-export-btn" id="statsExportCardBtn" title="${esc(tx('保存声音纪念卡'))}">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="1.5"/><path d="m21 15-4.5-4.5a2 2 0 0 0-2.83 0L6 18"/></svg>
                    <span>${esc(tx('生成纪念卡'))}</span>
                </button>
            </div>
            ${chips.length ? `<div class="stats-hero-chips">${chips.join('')}</div>` : ''}
            <div class="stats-kpis">
                <div class="stats-kpi">
                    <div class="l">${esc(tx('累计聆听'))}</div>
                    <div class="v">${esc(durMain)}</div>
                    <div class="sub"><span>${esc(tx('今日'))}</span> <span>${esc(todayStr)}</span></div>
                </div>
                <div class="stats-kpi">
                    <div class="l">${esc(tx('完整驻足'))}</div>
                    <div class="v">${ov.totalPlays}<span class="u">${esc(tx('次'))}</span></div>
                    <div class="sub"><span>${esc(tx('本周'))}</span> <span>${esc(weekStr)}</span></div>
                </div>
                <div class="stats-kpi">
                    <div class="l">${esc(tx('听过的歌'))}</div>
                    <div class="v">${ov.uniqueSongs}<span class="u">${esc(tx('首'))}</span></div>
                    <div class="sub"><span>${esc(tx('已收藏'))}</span> <span>${ov.favoriteCount}${esc(tx('首'))}</span></div>
                </div>
                <div class="stats-kpi">
                    <div class="l">${esc(tx('重逢歌手'))}</div>
                    <div class="v">${esc(ov.uniqueArtists)}<span class="u">${esc(tx('位'))}</span></div>
                    <div class="sub"><span>${esc(tx('活跃'))}</span> <span>${ov.activeDays}${esc(tx('天'))}</span></div>
                </div>
            </div>
        </section>`;
}

function buildHeroWaveSvg(hours) {
    const arr = Array.isArray(hours) && hours.length === 24 ? hours : new Array(24).fill({ pct: 15 });
    const w = 320;
    const h = 88;
    const step = w / 23;
    let pts = [];
    for (let i = 0; i < 24; i++) {
        const x = +(i * step).toFixed(1);
        const pct = Math.max(8, Number(arr[i] && arr[i].pct) || 8);
        const y = +(h - 10 - (pct / 100) * (h - 28)).toFixed(1);
        pts.push([x, y]);
    }
    let d = `M ${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) {
        const prev = pts[i - 1];
        const cur = pts[i];
        const mx = +((prev[0] + cur[0]) / 2).toFixed(1);
        d += ` Q ${prev[0]} ${prev[1]}, ${mx} ${+((prev[1] + cur[1]) / 2).toFixed(1)}`;
    }
    const last = pts[pts.length - 1];
    d += ` T ${last[0]} ${last[1]}`;
    const areaD = `${d} L ${w} ${h} L 0 ${h} Z`;
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><defs><linearGradient id="statsHeroGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="currentColor" stop-opacity="0.32"/><stop offset="100%" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><path d="${areaD}" fill="url(#statsHeroGrad)"/><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-opacity="0.45"/></svg>`;
}

function renderSpotlightHtml(sp) {
    if (!sp) return '';
    const cover = safeCoverUrl(sp.cover);
    const ey = sp.fromRecent ? tx('最近心动旋律') : tx('单曲偏爱 · #1');
    const favBadge = sp.isFav
        ? `<span class="stats-spot-fav" aria-label="${esc(tx('已收藏'))}">♥ ${esc(tx('已收藏'))}</span>`
        : '';
    const metricsHtml = sp.n > 0
        ? `<span>${esc(tx('反复倾听'))}</span> <strong>${sp.n}</strong> <span>${esc(tx('次'))}</span> · <span>${esc(formatCompactDuration(sp.ms, tx))}</span>${sp.sharePct >= 5 ? ` · <span>${esc(tx('占总播放'))}</span> <strong>${sp.sharePct}%</strong>` : ''}`
        : `<span>${esc(tx('刚刚响起'))}</span>`;

    return `
        <section class="stats-spotlight">
            ${cover ? `<img class="stats-spot-bg" src="${esc(cover)}" alt="" aria-hidden="true" loading="lazy" onerror="this.remove()">` : ''}
            <div class="stats-spot-cover-wrap ${cover ? '' : 'no-cover'}">
                <span class="stats-spot-vinyl" aria-hidden="true"></span>
                ${cover ? `<img class="stats-spot-cover" src="${esc(cover)}" alt="" loading="lazy" onerror="this.parentElement?.classList.add('no-cover');this.remove()">` : ''}
                <span class="stats-spot-ph">${musicNoteSvg(24)}</span>
            </div>
            <div class="stats-spot-meta">
                <div class="stats-spot-eyebrow">
                    <span>${esc(ey)}</span>
                    ${favBadge}
                </div>
                <div class="stats-spot-title">${esc(sp.title)}</div>
                <div class="stats-spot-artist">${esc(sp.artist)}</div>
                <div class="stats-spot-stat">${metricsHtml}</div>
            </div>
            <button type="button" class="stats-play-cta" id="statsSpotlightPlayBtn">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M7 4l13 8-13 8V4z"/></svg>
                <span>${esc(tx('再听一遍'))}</span>
            </button>
        </section>`;
}

function renderMoodSpectrumHtml(mood) {
    if (!mood || mood.analyzedCount === 0 || mood.swatches.length === 0) {
        return `
            <section class="stats-block stats-mood-empty">
                <div class="stats-block-head">
                    <div class="stats-block-title">${esc(tx('情绪光谱'))}</div>
                </div>
                <div class="stats-mood-empty-body">
                    <div class="stats-mood-empty-copy">
                        <div class="stats-mood-empty-h">${esc(tx('声音色卡尚未显影'))}</div>
                        <p>${esc(tx('开启「AI 情绪分析」后，歌词里的心境色彩与情感词会在这里汇成你的情绪光谱'))}</p>
                    </div>
                    <button type="button" class="stats-ghost-btn" id="statsOpenAiBtn">${esc(tx('前往开启'))}</button>
                </div>
            </section>`;
    }

    const gradColors = mood.swatches.map((s) => sanitizeHexColor(s.color)).filter(Boolean);
    const ribbonStyle = gradColors.length >= 2
        ? `background: linear-gradient(90deg, ${gradColors.join(', ')})`
        : `background: ${gradColors[0] || 'var(--aria-accent)'}`;

    const swatchesHtml = mood.swatches.map((s) => {
        const col = sanitizeHexColor(s.color) || '#E8BE6A';
        const tip = [s.mood, s.title].filter(Boolean).join(' · ');
        return `<span class="stats-swatch" style="--sw-col:${esc(col)}" title="${esc(tip)}"><i></i><span>${esc(s.mood)}</span></span>`;
    }).join('');

    const wordsHtml = mood.words.length
        ? `<div class="stats-word-cloud-wrap">
            <div class="stats-sub-caption">${esc(tx('声音气质关键词'))}</div>
            <div class="stats-word-cloud">${mood.words.map((w, i) => {
                const wc = sanitizeHexColor(w.color) || 'var(--aria-accent)';
                const rgb = hexToRgbTuple(wc);
                const weightCls = i < 3 ? ' is-major' : '';
                const st = rgb ? `--ew-rgb:${rgb};--ew-hex:${esc(wc)}` : `--ew-hex:${esc(wc)}`;
                return `<span class="stats-ew-pill${weightCls}" style="${st}" title="${esc(w.emotion || '')}">${esc(w.word)}</span>`;
            }).join('')}</div>
           </div>`
        : '';

    return `
        <section class="stats-block stats-mood-card">
            <div class="stats-block-head">
                <div class="stats-block-title">${esc(tx('情绪光谱'))}</div>
                <div class="stats-head-pill"><span>${esc(tx('已显影心境'))}</span><strong>${mood.analyzedCount}</strong></div>
            </div>
            <div class="stats-aurora-ribbon" style="${esc(ribbonStyle)}"></div>
            <div class="stats-swatch-row">${swatchesHtml}</div>
            ${wordsHtml}
        </section>`;
}

function renderCircadianHtml(circ, persona) {
    const peakHourLabel = persona.peakRangeLabel;
    const peakH = circ.hours[circ.peakHour];
    const initialReadout = circ.hourSource === 'live' && peakH && peakH.ms > 0
        ? `${peakHourLabel} · ${formatCompactDuration(peakH.ms, tx)}`
        : (circ.hourSource === 'recent' ? `${peakHourLabel} · ${tx('按近期播放估算')}` : tx('暂无数据'));

    const barsHtml = circ.hours.map((h) => {
        const isPeak = circ.maxHourVal > 0 && h.hour === circ.peakHour;
        const barH = h.weight > 0 ? Math.max(14, h.pct) : 6;
        const valText = circ.hourSource === 'live'
            ? (h.ms > 0 ? formatCompactDuration(h.ms, tx) : tx('安静休息'))
            : (h.weight > 0 ? `${h.weight} ${tx('次')}` : tx('安静休息'));
        const showTick = h.hour === 0 || h.hour === 6 || h.hour === 12 || h.hour === 18 || h.hour === 23;
        return `
            <button type="button" class="stats-hour-col${isPeak ? ' is-peak' : ''}${h.weight > 0 ? ' has-val' : ''}" data-hour-label="${esc(h.label)}" data-hour-val="${esc(valText)}" aria-label="${esc(h.label)} ${esc(valText)}">
                <span class="stats-hour-track"><span class="stats-hour-bar" style="height:${barH}%"></span></span>
                <span class="stats-hour-tick">${showTick ? esc(String(h.hour).padStart(2, '0')) : ''}</span>
            </button>`;
    }).join('');

    const zonesHtml = circ.zones.map((z) => `
        <div class="stats-zone-pill${z.id === persona.peakWindowId ? ' is-active' : ''}">
            <span class="stats-zone-name">${esc(tx(z.label))}</span>
            <span class="stats-zone-pct">${z.sharePct}%</span>
        </div>`).join('');

    return `
        <section class="stats-block stats-circadian">
            <div class="stats-block-head">
                <div class="stats-block-title">${esc(tx('昼夜音律'))}</div>
                <div class="stats-live-readout" id="statsHourReadout">${esc(initialReadout)}</div>
            </div>
            <div class="stats-hour-chart">${barsHtml}</div>
            <div class="stats-zones-row">${zonesHtml}</div>
        </section>`;
}

function renderRhythm14Html(r14) {
    const readoutInit = r14.bestDay && r14.bestDay.ms > 0
        ? `${tx('最沉浸')} ${r14.bestDay.shortDate} · ${formatCompactDuration(r14.bestDay.ms, tx)}`
        : tx('暂无连续记录');

    const colsHtml = r14.days.map((d, idx) => {
        const barH = d.ms > 0 ? Math.max(14, d.pct) : 6;
        const valText = d.ms > 0 ? formatCompactDuration(d.ms, tx) : tx('安静休息');
        const label = `${d.shortDate} ${tx(d.weekdayKey)}`;
        const showDate = idx === 0 || idx === 6 || d.isToday;
        return `
            <button type="button" class="stats-day-col${d.isToday ? ' is-today' : ''}${d.isPeak ? ' is-peak' : ''}${d.ms > 0 ? ' has-val' : ''}" data-day-label="${esc(label)}" data-day-val="${esc(valText)}" aria-label="${esc(label)} ${esc(valText)}">
                <span class="stats-day-track"><span class="stats-day-bar" style="height:${barH}%"></span></span>
                <span class="stats-day-tick">${d.isToday ? esc(tx('今日')) : (showDate ? esc(d.shortDate) : '')}</span>
            </button>`;
    }).join('');

    return `
        <section class="stats-block stats-rhythm">
            <div class="stats-block-head">
                <div class="stats-block-title">${esc(tx('近 14 日节拍'))}</div>
                <div class="stats-live-readout" id="statsDayReadout">${esc(readoutInit)}</div>
            </div>
            <div class="stats-day-chart">${colsHtml}</div>
        </section>`;
}

function renderTopSongsHtml(songs) {
    const rows = songs.length
        ? songs.map((s, idx) => {
            const cover = safeCoverUrl(s.cover);
            const rankStr = String(s.rank).padStart(2, '0');
            const topCls = s.rank <= 3 ? ` is-top${s.rank}` : '';
            const countLabel = s.n > 0 ? `${s.n} ${tx('次')}` : formatCompactDuration(s.ms, tx);
            const subLabel = s.n > 0 && s.ms > 0 ? formatCompactDuration(s.ms, tx) : '';
            return `
                <button type="button" class="stats-song-row${topCls}" data-song-idx="${idx}">
                    <span class="stats-rank-no">${esc(rankStr)}</span>
                    <span class="stats-row-cover ${cover ? '' : 'no-cover'}">
                        ${cover ? `<img src="${esc(cover)}" alt="" loading="lazy" onerror="this.parentElement?.classList.add('no-cover');this.remove()">` : ''}
                        <span class="stats-row-ph">${musicNoteSvg(15)}</span>
                    </span>
                    <span class="stats-row-info">
                        <span class="stats-row-title">${esc(s.title)}${s.isFav ? '<span class="stats-row-heart" aria-hidden="true">♥</span>' : ''}</span>
                        <span class="stats-row-artist">${esc(s.artist)}</span>
                    </span>
                    <span class="stats-row-right">
                        <span class="stats-row-count">${esc(countLabel)}</span>
                        ${subLabel ? `<span class="stats-row-dur">${esc(subLabel)}</span>` : ''}
                    </span>
                    <span class="stats-row-whisper" style="width:${s.pctOfTop}%"></span>
                </button>`;
        }).join('')
        : `<div class="stats-empty">${esc(tx('暂无数据'))}</div>`;

    return `
        <section class="stats-block stats-songs-card">
            <div class="stats-block-head">
                <div class="stats-block-title">${esc(tx('常听旋律'))}</div>
                <div class="stats-head-pill">${songs.length} ${esc(tx('首'))}</div>
            </div>
            <div class="stats-rank-list">${rows}</div>
        </section>`;
}

function renderTopArtistsHtml(artists) {
    const rows = artists.length
        ? artists.map((a, idx) => {
            const cover = safeCoverUrl(a.cover);
            const metaParts = [];
            if (a.songCount > 0) metaParts.push(`${a.songCount} ${tx('首')}`);
            if (a.ms > 0) metaParts.push(formatCompactDuration(a.ms, tx));
            const countLabel = a.n > 0 ? `${a.n} ${tx('次')}` : formatCompactDuration(a.ms, tx);
            return `
                <button type="button" class="stats-artist-row" data-artist-idx="${idx}">
                    <span class="stats-artist-avatar ${cover ? '' : 'no-cover'}">
                        ${cover ? `<img src="${esc(cover)}" alt="" loading="lazy" onerror="this.parentElement?.classList.add('no-cover');this.remove()">` : ''}
                        <span class="stats-artist-init">${esc(a.initial)}</span>
                    </span>
                    <span class="stats-row-info">
                        <span class="stats-row-title">${esc(a.name)}</span>
                        <span class="stats-row-artist">${esc(metaParts.join(' · '))}</span>
                    </span>
                    <span class="stats-row-right">
                        <span class="stats-row-count">${esc(countLabel)}</span>
                    </span>
                    <span class="stats-row-whisper" style="width:${a.pctOfTop}%"></span>
                </button>`;
        }).join('')
        : `<div class="stats-empty">${esc(tx('暂无数据'))}</div>`;

    return `
        <section class="stats-block stats-artists-card">
            <div class="stats-block-head">
                <div class="stats-block-title">${esc(tx('常伴声线'))}</div>
                <div class="stats-head-pill">${artists.length} ${esc(tx('位'))}</div>
            </div>
            <div class="stats-rank-list">${rows}</div>
        </section>`;
}

function renderFooterHtml() {
    return `
        <footer class="stats-footer">
            <span class="stats-footer-note">${esc(tx('仅统计本机聆听记忆'))}</span>
            <div class="stats-footer-actions">
                <button type="button" class="stats-ghost-btn" id="statsResetBtn">${esc(tx('清空统计'))}</button>
                <button type="button" class="stats-ghost-btn is-accent" id="statsExportCardBtnBottom">${esc(tx('保存声音纪念卡'))}</button>
            </div>
        </footer>`;
}

async function playSongFromStats(song) {
    if (!song) { toast('暂无可用播放信息'); return; }
    try {
        if (song.source === 'local' && song.id) {
            const info = { source: 'local', id: song.id, song: song.title, singer: song.artist, cover: song.cover, url: song.id };
            const q = buildCollectionQueue([info], 0, 'local');
            if (q.playlist.length && typeof playlist !== 'undefined') {
                playlist = q.playlist;
                currentTrackIndex = 0;
                closeListenStatsOverlay();
                await loadPlaylistTrack(0);
                if (typeof window.recordRecentPlay === 'function') window.recordRecentPlay(q.playlist[0]);
                return;
            }
        }
        if (song.source && (song.id || song.mid || song.hash)) {
            const info = {
                source: song.source,
                id: song.id || song.mid || song.hash,
                mid: song.mid || '',
                hash: song.hash || '',
                song: song.title,
                singer: song.artist,
                cover: song.cover || '',
            };
            closeListenStatsOverlay();
            await loadOnlineSong(info);
            if (typeof window.recordRecentPlay === 'function') window.recordRecentPlay(info);
            return;
        }
        toast('暂无可用播放信息');
    } catch (e) {
        logWarn(TAG, '播放统计歌曲失败:', e);
        toast('暂无可用播放信息');
    }
}

function roundRectBox(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x, y, w, h, r);
    } else {
        const rr = Math.min(r, w / 2, h / 2);
        ctx.moveTo(x + rr, y);
        ctx.arcTo(x + w, y, x + w, y + h, rr);
        ctx.arcTo(x + w, y + h, x, y + h, rr);
        ctx.arcTo(x, y + h, x, y, rr);
        ctx.arcTo(x, y, x + w, y, rr);
        ctx.closePath();
    }
}

function drawTruncatedText(ctx, text, x, y, maxW) {
    const s = String(text || '');
    if (ctx.measureText(s).width <= maxW) { ctx.fillText(s, x, y); return; }
    let end = s.length;
    while (end > 1 && ctx.measureText(s.slice(0, end) + '…').width > maxW) end--;
    ctx.fillText(s.slice(0, end) + '…', x, y);
}

function wrapLines(ctx, text, maxW, maxLines) {
    const chars = Array.from(String(text || ''));
    const lines = [];
    let cur = '';
    for (const ch of chars) {
        if (ctx.measureText(cur + ch).width > maxW && cur) {
            lines.push(cur);
            cur = ch;
            if (lines.length >= maxLines) break;
        } else {
            cur += ch;
        }
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    return lines;
}

async function exportStatsKeepsakeCard(report) {
    if (_exportBusy || !report) return;
    _exportBusy = true;
    toast('正在生成纪念卡...');
    try {
        const W = 900;
        const H = 1220;
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d context');

        const accentCss = getComputedStyle(document.documentElement).getPropertyValue('--aria-accent').trim();
        const colA = sanitizeHexColor(report.moodSpectrum.dominantColor) || sanitizeHexColor(accentCss) || '#E8BE6A';
        const colB = sanitizeHexColor(report.moodSpectrum.secondaryColor) || '#6FA8DC';
        const rgbA = hexToRgbTuple(colA) || '232, 190, 106';
        const rgbB = hexToRgbTuple(colB) || '111, 168, 220';

        /* 1. 深邃渐变夜幕背景 + 情绪光晕 */
        const bgGrad = ctx.createLinearGradient(0, 0, W, H);
        bgGrad.addColorStop(0, '#0E1018');
        bgGrad.addColorStop(0.55, '#131624');
        bgGrad.addColorStop(1, '#0A0C12');
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, W, H);

        const glow1 = ctx.createRadialGradient(180, 180, 20, 180, 180, 560);
        glow1.addColorStop(0, `rgba(${rgbA}, 0.28)`);
        glow1.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = glow1;
        ctx.fillRect(0, 0, W, H);

        const glow2 = ctx.createRadialGradient(740, 880, 20, 740, 880, 520);
        glow2.addColorStop(0, `rgba(${rgbB}, 0.22)`);
        glow2.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = glow2;
        ctx.fillRect(0, 0, W, H);

        /* 2. 顶部题头 */
        const pad = 64;
        ctx.fillStyle = `rgba(${rgbA}, 0.92)`;
        ctx.font = `600 22px ${POSTER_FONT}`;
        ctx.fillText(tx('Aria · 声音手账'), pad, 92);

        const nowD = new Date();
        const stamp = `${nowD.getFullYear()}.${String(nowD.getMonth() + 1).padStart(2, '0')}.${String(nowD.getDate()).padStart(2, '0')}`;
        ctx.fillStyle = 'rgba(255,255,255,0.48)';
        ctx.textAlign = 'right';
        ctx.fillText(stamp, W - pad, 92);
        ctx.textAlign = 'left';

        /* 3. 人格主标题与寄语 */
        ctx.fillStyle = '#FFFFFF';
        ctx.font = `800 58px ${POSTER_FONT}`;
        ctx.fillText(tx(report.persona.title), pad, 198);

        ctx.fillStyle = 'rgba(255,255,255,0.74)';
        ctx.font = `400 26px ${POSTER_FONT}`;
        const quoteLines = wrapLines(ctx, tx(report.persona.quote), W - pad * 2, 2);
        quoteLines.forEach((line, idx) => {
            ctx.fillText(line, pad, 256 + idx * 40);
        });

        /* 4. 24 小时声波指纹曲线 */
        const waveY = 336;
        const waveH = 134;
        const waveW = W - pad * 2;
        ctx.fillStyle = 'rgba(255,255,255,0.04)';
        roundRectBox(ctx, pad, waveY, waveW, waveH, 22);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1;
        ctx.stroke();

        const barGap = 10;
        const bw = (waveW - 48 - barGap * 23) / 24;
        report.circadian.hours.forEach((hr, idx) => {
            const x = pad + 24 + idx * (bw + barGap);
            const bh = Math.max(8, (Math.max(6, hr.pct) / 100) * (waveH - 48));
            const y = waveY + waveH - 30 - bh;
            ctx.fillStyle = idx === report.circadian.peakHour ? colA : `rgba(${rgbA}, ${hr.weight > 0 ? 0.42 : 0.14})`;
            roundRectBox(ctx, x, y, bw, bh, bw / 2);
            ctx.fill();
            if (idx === 0 || idx === 6 || idx === 12 || idx === 18 || idx === 23) {
                ctx.fillStyle = idx === report.circadian.peakHour ? colA : 'rgba(255,255,255,0.36)';
                ctx.font = `600 13px ${POSTER_FONT}`;
                ctx.textAlign = 'center';
                ctx.fillText(String(idx).padStart(2, '0'), x + bw / 2, waveY + waveH - 10);
            }
        });
        ctx.textAlign = 'left';

        /* 5. 三项核心数字 */
        const kpiY = 504;
        const kpiW = (waveW - 32) / 3;
        const kpiItems = [
            { l: tx('相伴'), v: `${report.overview.companionDays}${tx('天')}` },
            { l: tx('累计聆听'), v: formatStatsDuration(report.overview.totalMs, tx) },
            { l: tx('完整驻足'), v: `${report.overview.totalPlays}${tx('次')}` },
        ];
        kpiItems.forEach((it, idx) => {
            const x = pad + idx * (kpiW + 16);
            ctx.fillStyle = 'rgba(255,255,255,0.05)';
            roundRectBox(ctx, x, kpiY, kpiW, 118, 22);
            ctx.fill();
            ctx.fillStyle = 'rgba(255,255,255,0.52)';
            ctx.font = `500 20px ${POSTER_FONT}`;
            ctx.fillText(it.l, x + 22, kpiY + 42);
            ctx.fillStyle = '#FFFFFF';
            ctx.font = `700 32px ${POSTER_FONT}`;
            drawTruncatedText(ctx, it.v, x + 22, kpiY + 90, kpiW - 44);
        });

        /* 6. 单曲白月光框 */
        const sp = report.spotlight;
        if (sp) {
            const cardY = 660;
            const cardH = 228;
            ctx.fillStyle = 'rgba(255,255,255,0.06)';
            roundRectBox(ctx, pad, cardY, waveW, cardH, 28);
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.1)';
            ctx.stroke();

            const covSz = 160;
            const covX = pad + 32;
            const covY = cardY + 32;
            const covUrl = safeCoverUrl(sp.cover);
            const covImg = covUrl ? await loadCoverImage(covUrl, 4000) : null;
            ctx.save();
            roundRectBox(ctx, covX, covY, covSz, covSz, 20);
            ctx.clip();
            if (covImg) {
                ctx.drawImage(covImg, covX, covY, covSz, covSz);
            } else {
                ctx.fillStyle = `rgba(${rgbA}, 0.18)`;
                ctx.fillRect(covX, covY, covSz, covSz);
            }
            ctx.restore();

            const txX = covX + covSz + 32;
            const txW = waveW - 64 - covSz - 32;
            ctx.fillStyle = colA;
            ctx.font = `600 20px ${POSTER_FONT}`;
            ctx.fillText(tx(sp.fromRecent ? '最近心动旋律' : '单曲偏爱 · #1'), txX, covY + 34);
            ctx.fillStyle = '#FFFFFF';
            ctx.font = `700 34px ${POSTER_FONT}`;
            drawTruncatedText(ctx, sp.title, txX, covY + 86, txW);
            ctx.fillStyle = 'rgba(255,255,255,0.68)';
            ctx.font = `500 24px ${POSTER_FONT}`;
            drawTruncatedText(ctx, sp.artist, txX, covY + 126, txW);
            if (sp.n > 0) {
                ctx.fillStyle = 'rgba(255,255,255,0.48)';
                ctx.font = `500 20px ${POSTER_FONT}`;
                drawTruncatedText(ctx, `${sp.n}${tx('次')} · ${formatCompactDuration(sp.ms, tx)}`, txX, covY + 158, txW);
            }
        }

        /* 7. 情绪色卡 + 关键词 */
        const moodY = 934;
        if (report.moodSpectrum.swatches.length > 0) {
            let sx = pad;
            for (const sw of report.moodSpectrum.swatches) {
                ctx.fillStyle = sanitizeHexColor(sw.color) || colA;
                ctx.beginPath();
                ctx.arc(sx + 14, moodY + 14, 14, 0, Math.PI * 2);
                ctx.fill();
                sx += 40;
            }
        }
        if (report.moodSpectrum.words.length > 0) {
            const lineWords = report.moodSpectrum.words.slice(0, 6).map((w) => `#${w.word}`).join('  ');
            ctx.fillStyle = 'rgba(255,255,255,0.58)';
            ctx.font = `500 22px ${POSTER_FONT}`;
            drawTruncatedText(ctx, lineWords, pad, moodY + 72, waveW);
        }

        /* 8. 底部品牌水印 */
        const logo = await loadLogoImage();
        const footY = H - 64;
        if (logo) {
            ctx.save();
            roundRectBox(ctx, pad, footY - 22, 34, 34, 9);
            ctx.clip();
            ctx.drawImage(logo, pad, footY - 22, 34, 34);
            ctx.restore();
        }
        ctx.fillStyle = 'rgba(255,255,255,0.46)';
        ctx.font = `600 22px ${POSTER_FONT}`;
        ctx.fillText('Aria Player', logo ? pad + 48 : pad, footY + 3);

        const blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
        if (!blob) throw new Error('canvas toBlob null');
        const fname = `aria-sound-journal-${stamp.replace(/\./g, '')}.png`;
        await saveBlob(blob, fname);
        toast('声音纪念卡已保存');
    } catch (e) {
        logWarn(TAG, '生成声音纪念卡失败:', e);
        toast('生成纪念卡失败');
    } finally {
        _exportBusy = false;
    }
}

function bindStatsInteractions(body, report) {
    body.querySelector('#statsExploreBtn')?.addEventListener('click', () => {
        closeListenStatsOverlay();
        $('openDailyBtn')?.click();
    });

    body.querySelector('#statsOpenAiBtn')?.addEventListener('click', () => {
        closeListenStatsOverlay();
        const ob = $('openSettingsBtn');
        if (ob) {
            ob.click();
            if (typeof window !== 'undefined' && typeof window.switchSettingsTab === 'function') {
                setTimeout(() => {
                    try { window.switchSettingsTab('ai'); } catch (e) { logCatch(TAG, e); }
                }, 80);
            }
        }
    });

    body.querySelector('#statsSpotlightPlayBtn')?.addEventListener('click', () => {
        if (report.spotlight) playSongFromStats(report.spotlight);
    });

    const hourReadout = body.querySelector('#statsHourReadout');
    const hourInitial = hourReadout ? hourReadout.textContent : '';
    const hourChart = body.querySelector('.stats-hour-chart');
    if (hourChart && hourReadout) {
        hourChart.addEventListener('pointerover', (e) => {
            const col = /** @type {HTMLElement|null} */ (e.target && /** @type {HTMLElement} */ (e.target).closest('.stats-hour-col'));
            if (col) hourReadout.textContent = `${col.dataset.hourLabel || ''} · ${col.dataset.hourVal || ''}`;
        });
        hourChart.addEventListener('focusin', (e) => {
            const col = /** @type {HTMLElement|null} */ (e.target && /** @type {HTMLElement} */ (e.target).closest('.stats-hour-col'));
            if (col) hourReadout.textContent = `${col.dataset.hourLabel || ''} · ${col.dataset.hourVal || ''}`;
        });
        hourChart.addEventListener('mouseleave', () => { hourReadout.textContent = hourInitial; });
    }

    const dayReadout = body.querySelector('#statsDayReadout');
    const dayInitial = dayReadout ? dayReadout.textContent : '';
    const dayChart = body.querySelector('.stats-day-chart');
    if (dayChart && dayReadout) {
        dayChart.addEventListener('pointerover', (e) => {
            const col = /** @type {HTMLElement|null} */ (e.target && /** @type {HTMLElement} */ (e.target).closest('.stats-day-col'));
            if (col) dayReadout.textContent = `${col.dataset.dayLabel || ''} · ${col.dataset.dayVal || ''}`;
        });
        dayChart.addEventListener('focusin', (e) => {
            const col = /** @type {HTMLElement|null} */ (e.target && /** @type {HTMLElement} */ (e.target).closest('.stats-day-col'));
            if (col) dayReadout.textContent = `${col.dataset.dayLabel || ''} · ${col.dataset.dayVal || ''}`;
        });
        dayChart.addEventListener('mouseleave', () => { dayReadout.textContent = dayInitial; });
    }

    body.querySelectorAll('.stats-song-row[data-song-idx]').forEach((row) => {
        row.addEventListener('click', () => {
            const idx = Number(/** @type {HTMLElement} */ (row).dataset.songIdx);
            const item = report.topSongs[idx];
            if (item) playSongFromStats(item);
        });
    });

    body.querySelectorAll('.stats-artist-row[data-artist-idx]').forEach((row) => {
        row.addEventListener('click', () => {
            const idx = Number(/** @type {HTMLElement} */ (row).dataset.artistIdx);
            const item = report.topArtists[idx];
            if (!item) return;
            if (typeof globalThis.Aria !== 'undefined' && typeof globalThis.Aria.openArtist === 'function') {
                globalThis.Aria.openArtist({
                    source: item.source || 'netease',
                    name: item.name,
                    avatar: safeCoverUrl(item.cover),
                });
            }
        });
    });

    const exportHandler = () => exportStatsKeepsakeCard(_lastReport || report);
    body.querySelector('#statsExportCardBtn')?.addEventListener('click', exportHandler);
    body.querySelector('#statsExportCardBtnBottom')?.addEventListener('click', exportHandler);

    body.querySelector('#statsResetBtn')?.addEventListener('click', async () => {
        const confirmFn = typeof window !== 'undefined' ? window.showGlassConfirm : null;
        const ok = typeof confirmFn === 'function'
            ? await confirmFn({
                title: tx('重置听歌统计'),
                desc: tx('确定清空累计播放时长、单曲排行与时段分布记忆吗？此操作无法撤销。'),
                okText: tx('确定'),
                cancelText: tx('取消'),
            })
            : false;
        if (!ok) return;
        saveStoredStats(defaultPlayStats(Date.now()));
        try {
            if (typeof globalThis.Aria !== 'undefined' && typeof globalThis.Aria.__resetPlayStatsTick === 'function') {
                globalThis.Aria.__resetPlayStatsTick();
            }
        } catch (e) { logCatch(TAG, e); }
        toast('听歌统计已清空');
        renderStatsBody();
    });
}

function renderReportIntoBody(body, report) {
    const rgbA = hexToRgbTuple(report.moodSpectrum.dominantColor);
    const rgbB = hexToRgbTuple(report.moodSpectrum.secondaryColor);
    if (rgbA) body.style.setProperty('--stats-mood-a-rgb', rgbA);
    else body.style.removeProperty('--stats-mood-a-rgb');
    if (rgbB) body.style.setProperty('--stats-mood-b-rgb', rgbB);
    else body.style.removeProperty('--stats-mood-b-rgb');

    if (!report.overview.hasAnyData) {
        body.innerHTML = renderEmptyStateHtml();
        bindStatsInteractions(body, report);
        return;
    }

    body.innerHTML = [
        renderHeroHtml(report),
        renderSpotlightHtml(report.spotlight),
        `<div id="statsMoodMount">${renderMoodSpectrumHtml(report.moodSpectrum)}</div>`,
        `<div class="stats-charts-grid">${renderCircadianHtml(report.circadian, report.persona)}${renderRhythm14Html(report.rhythm14)}</div>`,
        `<div class="stats-lists-grid">${renderTopSongsHtml(report.topSongs)}${renderTopArtistsHtml(report.topArtists)}</div>`,
        renderFooterHtml(),
    ].join('');

    bindStatsInteractions(body, report);
}

function bindMoodSectionEvents(mount) {
    mount?.querySelector('#statsOpenAiBtn')?.addEventListener('click', () => {
        closeListenStatsOverlay();
        const ob = $('openSettingsBtn');
        if (ob) {
            ob.click();
            if (typeof window !== 'undefined' && typeof window.switchSettingsTab === 'function') {
                setTimeout(() => {
                    try { window.switchSettingsTab('ai'); } catch (e) { logCatch(TAG, e); }
                }, 80);
            }
        }
    });
}

export async function renderStatsBody() {
    const body = $('statsBody');
    if (!body) return;
    const seq = ++_openSeq;
    const st = loadStoredStats();
    const recentHistory = readRecentHistorySafe();
    const favorites = (() => {
        try { return getFavorites() || []; } catch (e) { logCatch(TAG, e); return []; }
    })();
    const curTheme = typeof currentAiTheme !== 'undefined' ? currentAiTheme : null;

    /* 首帧立刻用本地同步数据绘制，随后仅局部补刷 AI 情绪色卡区（不重建滚动列表，避免闪烁/丢滚动位） */
    const immediateReport = buildStatsReport({
        stats: st,
        recentHistory,
        favorites,
        aiThemes: {},
        currentAiTheme: curTheme,
    });
    _lastReport = immediateReport;
    renderReportIntoBody(body, immediateReport);

    try {
        const aiThemes = await aiCacheGetAll();
        if (seq !== _openSeq) return;
        const ov = $('statsOverlay');
        if (!ov || !ov.classList.contains('visible')) return;
        if (aiThemes && Object.keys(aiThemes).length > 0) {
            const enriched = buildStatsReport({
                stats: loadStoredStats(),
                recentHistory: readRecentHistorySafe(),
                favorites,
                aiThemes,
                currentAiTheme: curTheme,
            });
            _lastReport = enriched;
            const rgbA = hexToRgbTuple(enriched.moodSpectrum.dominantColor);
            const rgbB = hexToRgbTuple(enriched.moodSpectrum.secondaryColor);
            if (rgbA) body.style.setProperty('--stats-mood-a-rgb', rgbA);
            if (rgbB) body.style.setProperty('--stats-mood-b-rgb', rgbB);
            const mount = body.querySelector('#statsMoodMount');
            if (mount) {
                mount.innerHTML = renderMoodSpectrumHtml(enriched.moodSpectrum);
                bindMoodSectionEvents(mount);
            }
        }
    } catch (e) {
        logCatch(TAG, e);
    }
}

export function openListenStatsOverlay() {
    const ov = $('statsOverlay');
    if (!ov) return;
    ov.classList.add('visible');
    const body = $('statsBody');
    if (body) body.scrollTop = 0;
    renderStatsBody();
}

export function closeListenStatsOverlay() {
    $('statsOverlay')?.classList.remove('visible');
}
