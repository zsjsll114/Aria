/* ============================================================
 * 275-play-source.js — 取链透明化的 UI 层（todos #15）
 *
 * 数据在 services/playSource.js（命中记录）+ services/log.js（降级轨迹），
 * 本分片只做渲染与开合，不产生任何取链判断。
 * 弹窗壳复用 .lyric-source-*（与「选择歌词来源」「下载歌词」同一套）。
 * ============================================================ */
import { escapeHtml } from '../utils/formatters.js';
import { channelMeta, describeBadge, describeDetail, getResolveTrace, onResolveChange, qualityLabel } from '../services/playSource.js';
import { logCatch } from '../services/log.js';

/* 日志等级白名单：等级要拼进 class，不能直接信缓冲里的值 */
const LV_CLASSES = new Set(['info', 'warn', 'error', 'catch']);

function badgeEl() { return document.getElementById('playSourceBadge'); }

function renderBadge() {
    const el = badgeEl();
    if (!el) return;
    const info = describeBadge();
    if (!info) {
        el.hidden = true;
        el.textContent = '';
        return;
    }
    el.hidden = false;
    el.textContent = info.text;
    el.classList.toggle('is-fallback', !!info.fallback);
    el.setAttribute('aria-label', info.text);
}

/** 打开取链详情面板 */
export function showPlaySourceModal() {
    const overlay = document.getElementById('playSourceOverlay');
    const body = document.getElementById('playSourceBody');
    if (!overlay || !body) return;

    const { rows, logs, hit } = describeDetail();
    const csd = (typeof globalThis !== 'undefined' && globalThis.currentSongData) || {};
    const songTitle = csd.title || '（当前未播放歌曲）';
    const songArtist = csd.artist || '';

    let html = `<div class="ps-hint">${escapeHtml(songTitle)}${songArtist ? ' - ' + escapeHtml(songArtist) : ''}</div>`;

    html += '<div class="ps-rows">' + (rows.length
        ? rows.map(r => `<div class="k">${escapeHtml(r.k)}</div><div class="v">${escapeHtml(r.v)}</div>`).join('')
        : '<div class="k">状态</div><div class="v">尚未记录到取链过程</div>') + '</div>';

    /* 命中渠道的完整名字单独一行：日志里只有简称，角标又放不下 */
    if (hit) {
        const meta = channelMeta(hit.channelId);
        html += `<div class="lyric-badge ${meta.tier === 'selfhost' || meta.tier === 'local' ? 'score-high' : 'score-med'}">${escapeHtml(meta.name)}</div>`;
        const q = qualityLabel(hit.quality);
        if (q) html += ` <span class="lyric-badge score-med">${escapeHtml(q)}</span>`;
    }

    /* 解析池会带回逐源尝试的结构化结果——这才是「每一级为什么失败」的权威答案 */
    if (hit && hit.tried && hit.tried.length) {
        html += `<div class="ps-section-title">解析池逐源尝试（${hit.tried.length} 级）</div><div class="ps-log">`;
        html += hit.tried.map((step, i) => {
            const state = step.ok ? '命中' : '失败';
            const ms = typeof step.ms === 'number' ? `${step.ms}ms` : '';
            const q = qualityLabel(step.quality) || (step.ext ? String(step.ext).toLowerCase() : '');
            const bits = [`#${i + 1}`, step.provider || '?', q, state, ms].filter(Boolean).join(' · ');
            return `<div class="row ${step.ok ? 'lv-ok' : 'lv-fail'}"><span class="m">${escapeHtml(bits)}</span>`
                + (step.err ? `<span class="err">${escapeHtml(step.err)}</span>` : '') + '</div>';
        }).join('');
        html += '</div>';
    }

    html += `<div class="ps-section-title">降级轨迹（${logs.length} 条）</div>`;
    html += '<div class="ps-log">' + (logs.length
        ? logs.map(r => {
            const t = new Date(r.ts);
            const hhmmss = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
            const lv = LV_CLASSES.has(r.level) ? r.level : 'info';
            return `<div class="row lv-${lv}"><span class="t">${hhmmss}</span><span class="tag">[${escapeHtml(r.tag)}]</span><span class="m">${escapeHtml(r.msg)}</span></div>`;
          }).join('')
        : '<div class="row"><span class="m">本次取链没有留下日志（说明第一级就命中了）</span></div>') + '</div>';

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

    badgeEl()?.addEventListener('click', () => {
        try { showPlaySourceModal(); } catch (e) { logCatch('playSource', e); }
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
