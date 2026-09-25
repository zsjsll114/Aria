/* ============================================================
 * 90-eq.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 2145-2476 行 | 单元数: 21
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { EQ_BANDS, EQ_LABELS, EQ_PRESETS } from '../config/constants.js';
import { audio } from './20-lyrics-render.js';
import { nextBtn, prevBtn } from './30-dom-refs.js';
import { handleAudioPlayError } from './70-audio-engine.js';
import { CTX_ICONS, ctxConfirmCancel, ctxConfirmOk, ctxMenu, hideCtxMenu, showCtxConfirm, showCtxMenu } from './80-context-menu.js';
import { RATE_OPTIONS, applyPlaybackRate, applyPreservesPitch, downloadCurrentSong } from './85-rate-download.js';
import { nextTrack, prevTrack } from './95-track-loading.js';
import { fetchLyricLinesFromSource, probeLyricSourcesAvailability, renderSourceBadges, switchLyricSource } from './170-lyric-sources.js';
import { convertToEnhancedLrc, formatTimestamp } from '../services/enhancedLrcConverter.js';
import { KRC_XOR_KEY } from '../services/krcParser.js';
import { logError } from '../services/log.js';
import { setHint } from './120-search-results.js'; // 提示条唯一入口（90↔120 无环：120 不 import 90）
import { escapeHtml as _escapeHtml } from '../utils/formatters.js';
import { realWordsOf } from '../parsers/wordTiming.js'; // 下载歌词时区分真实逐字 / 兜底合成
/* EQ 模型层。本分片把它原样 re-export（见文件末尾），所以 175/190/258 等消费方无需改动。 */
import {
    applyEqGains, applyEqPreset, cleanupEqAudioGraph, getCustomEqs, initEqAudioGraph,
    initEqualizer, loadEqSettings, saveEqPreset, saveEqSettings, setEqBand,
} from '../core/equalizer.js';

/* 是否因跨域失败，避免重复尝试 */
/* EQ 的音频图 / 增益状态 / 持久化已迁到 core/equalizer.js（core 层接管第 4 个模块，2026-09-25）。
   逻辑逐行照搬自本分片，行为不变——包括用户自定义预设（getCustomEqs）与输出链上的
   响度归一化压缩器，旧快照这两块都缺，所以是重新抽取而不是接线。
   本分片只保留 DOM：频段滑块、预设按钮、面板开合、分享码 UI。

   三个刷新回调对应活实现里三种不同的重渲染范围，别合并：拖频段时只刷新数值文本与
   预设高亮，绝不重建滑块，否则拖拽会被自己的重渲染打断。 */
initEqualizer({
    audio,
    onPlayError: () => handleAudioPlayError(),
    onChanged: () => buildEqPresets(),
    onPresetApplied: () => { buildEqBands(); buildEqPresets(); },
    onBandChanged: (idx) => {
        const valEl = typeof document !== 'undefined' ? document.getElementById('eq-val-' + idx) : null;
        if (valEl) valEl.textContent = (eqGains[idx] > 0 ? '+' : '') + eqGains[idx];
    },
});

/* 启动时读回上次增益 */
loadEqSettings();

/* 预设保存入口（设置面板与 HTML onclick 都用这个名字） */
window.saveEqPreset = (name) => saveEqPreset(name);

/* 单个频段改变：状态与持久化在 core，这里只负责它不重建滑块的那部分刷新 */
function onEqBandChange(idx, val) {
            setEqBand(idx, val);
        }

/* 渲染频段滑块 */
function buildEqBands() {
            const container = typeof document !== 'undefined' ? document.getElementById('eqBands') : null;
            if (!container) return;
            container.innerHTML = EQ_BANDS.map((freq, i) => `
                <div class="eq-band">
                    <div class="eq-band-value" id="eq-val-${i}">${(eqGains[i] > 0 ? '+' : '') + eqGains[i]}</div>
                    <input type="range" class="eq-slider" min="-12" max="12" step="1" value="${eqGains[i]}" data-band="${i}" orient="vertical">
                    <div class="eq-band-label">${EQ_LABELS[i]}</div>
                </div>
            `).join('');
            container.querySelectorAll('.eq-slider').forEach(slider => {
                slider?.addEventListener('input', (e) => {
                    onEqBandChange(parseInt(e.target.dataset.band), e.target.value);
                });
            });
        }

/* 渲染预设按钮（内置 + 自定义） */
function buildEqPresets() {
            const container = typeof document !== 'undefined' ? document.getElementById('eqPresets') : null;
            if (!container) return;
            const customs = getCustomEqs();
            const names = [...Object.keys(EQ_PRESETS), ...Object.keys(customs)];
            container.innerHTML = names.map(name => {
                const active = name === eqActivePreset ? ' active' : '';
                return `<button class="eq-preset${active}" data-preset="${_escapeHtml(name)}">${_escapeHtml(name)}</button>`;
            }).join('');
            container.querySelectorAll('.eq-preset').forEach(btn => {
                btn?.addEventListener('click', () => {
                    applyEqPreset(btn.dataset.preset);
                });
            });
        }

/* 打开 / 关闭面板 */
async function openEqPanel() {
            /* 懒初始化音频图（异步，需测试跨域） */
            const ok = await initEqAudioGraph();
            if (!ok) {
                /* 初始化失败（通常因跨域限制），用确认对话框提示 */
                showCtxConfirm('均衡器不可用', '当前歌曲不支持均衡器（跨域限制），请尝试本地文件或支持 CORS 的音源。', () => {});
                ctxConfirmCancel.style.display = 'none';
                ctxConfirmOk.textContent = '知道了';
                return;
            }
            /* 应用当前增益 */
            if (eqInited) {
                eqGains.forEach((g, i) => {
                    if (eqFilterNodes[i]) eqFilterNodes[i].gain.setValueAtTime(g, audioCtx.currentTime);
                });
            }
            /* 设置标题 */
            const titleEl = typeof document !== 'undefined' ? document.getElementById('eqTitle') : null;
            if (titleEl) titleEl.innerHTML = CTX_ICONS.eq + '<span>均衡器</span>';
            /* 渲染内容 */
            buildEqPresets();
            buildEqBands();
            /* 居中显示 */
            const panel = typeof document !== 'undefined' ? document.getElementById('eqPanel') : null;
            panel.style.left = '0px';
            panel.style.top = '0px';
            panel.classList.add('visible');
            const w = panel.offsetWidth;
            const h = panel.offsetHeight;
            panel.style.left = ((window.innerWidth - w) / 2) + 'px';
            panel.style.top = ((window.innerHeight - h) / 2) + 'px';
        }

function hideEqPanel() {
document.getElementById('eqPanel').classList.remove('visible');
        }

if (typeof document !== 'undefined') {
            document.getElementById('eqCloseBtn')?.addEventListener('click', hideEqPanel);
            document.getElementById('eqResetBtn')?.addEventListener('click', () => {
                applyEqPreset('默认');
            });
            /* ★ 保存为自定义预设：毛玻璃命名弹窗（showGlassPrompt 由 258 提供） */
            document.getElementById('eqSaveBtn')?.addEventListener('click', () => {
                if (typeof window.showGlassPrompt !== 'function') { if (typeof setHint === 'function') setHint('预设面板未就绪'); return; }
                window.showGlassPrompt({
                    title: '保存为自定义预设',
                    placeholder: '例如：我的重低音',
                    value: '',
                    onSubmit(name) {
                        if (name) window.saveEqPreset(name);
                    }
                });
            });
        }

/* 点击面板外部关闭 */
if (typeof document !== "undefined") document.addEventListener('click', (e) => {
            const panel = typeof document !== 'undefined' ? document.getElementById('eqPanel') : null;
            if (!panel || !panel.classList.contains('visible')) return;
            if (!panel.contains(e.target) && 
                !e.target.closest('#eqPanel') && 
                !e.target.closest('#moreBtn') && 
                !e.target.closest('#bottomMoreBtn') && 
                !e.target.closest('#moreSubmenu') && 
                !e.target.closest('#moreEqItem') && 
                !e.target.closest('#setOpenEq')) {
                hideEqPanel();
            }
        });

if (typeof document !== "undefined") document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') hideEqPanel();
        });

/* 构建更多菜单 */
function openMoreMenu() {
            const items = [
                {
                    key: 'speed',
                    label: '倍速',
                    icon: CTX_ICONS.speed,
                    submenu: buildSpeedSubmenu()
                },
                { key: 'eq', label: '均衡器', icon: CTX_ICONS.eq, onClick: openEqPanel },
                { key: 'viewmode', label: '切换样式', icon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>', onClick: () => document.getElementById('openViewModeBtn').click() },
                { key: 'lyricsource', label: '切换歌词来源', icon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4"></path><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><path d="M7 23l-4-4 4-4"></path><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>', onClick: switchLyricSource },
                { key: 'lyric-download', label: '下载歌词', icon: CTX_ICONS.download, onClick: openLyricDownloadModal },
                { key: 'download', label: '下载', icon: CTX_ICONS.download, onClick: downloadCurrentSong },
                { key: 'settings', label: '设置', icon: CTX_ICONS.settings, onClick: () => document.getElementById('openSettingsBtn').click() }
            ];
            const rect = moreBtn.getBoundingClientRect();
            showCtxMenu(items, rect.left, rect.bottom + 4);
        }

function buildSpeedSubmenu() {
            const items = RATE_OPTIONS.map(r => ({
                key: 'rate-' + r,
                label: r + 'x',
                active: Math.abs(currentPlaybackRate - r) < 0.001,
                onClick: () => applyPlaybackRate(r)
            }));
            items.push({
                key: 'sep-pitch',
                separator: true
            });
            items.push({
                key: 'preserve-pitch',
                label: '变速不变调',
                active: preservesPitch,
                onClick: () => applyPreservesPitch(!preservesPitch)
            });
            return items;
        }

/* ==================== 下载歌词（弹窗：先选歌词来源，再选保存格式） ==================== */

/* 歌词下载弹窗可选来源（以当前正在使用的来源为首选） */
const LYRIC_DL_SOURCES = [
    { key: 'current', name: '当前歌词', desc: '使用当前正在显示的歌词' },
    { key: 'tencent', name: 'QQ音乐', desc: '从QQ音乐获取官方歌词与翻译' },
    { key: 'netease', name: '网易云音乐', desc: '从网易云音乐获取官方歌词与翻译' },
    { key: 'kuwo', name: '酷我音乐', desc: '从酷我音乐获取官方高匹配度歌词' },
    { key: 'kugou', name: '酷狗音乐 (KRC)', desc: '从酷狗音乐获取高精度逐字歌词' },
    { key: 'amll', name: 'AMLL 歌词库 (TTML)', desc: '开源社区贡献的高质量逐字歌词' },
    { key: 'lrclib', name: 'LRCLIB (开放词库)', desc: '全球开源开放歌词数据库' }
];

const LYRIC_DL_FORMATS = [
    { key: 'lrc', name: 'LRC', desc: '逐行歌词 · 兼容性最好' },
    { key: 'elrc', name: 'E-LRC', desc: '增强逐字时间轴' },
    { key: 'qrc', name: 'QRC', desc: 'QQ 音乐逐字格式' },
    { key: 'krc', name: 'KRC', desc: '酷狗音乐加密格式' }
];

function openLyricDownloadModal() {
    const overlay = typeof document !== 'undefined' ? document.getElementById('lyricDownloadOverlay') : null;
    if (!overlay) return;
    hideCtxMenu();

    const body = typeof document !== 'undefined' ? document.getElementById('lyricDownloadBody') : null;
    if (!body) return;

    const curLyricLines = (typeof window !== 'undefined' && Array.isArray(Aria.__ariaLyrics) && Aria.__ariaLyrics.length) ? Aria.__ariaLyrics : null;
    const isPlayingSong = !!(typeof globalThis !== 'undefined' && globalThis.currentSongData && globalThis.currentSongData.title);
    const songTitle = (globalThis.currentSongData && globalThis.currentSongData.title) ? globalThis.currentSongData.title : '';
    const songArtist = (globalThis.currentSongData && globalThis.currentSongData.artist) ? globalThis.currentSongData.artist : '';
    const songSource = (globalThis.currentSongData && globalThis.currentSongData.source) || (globalThis.currentSongData && globalThis.currentSongData.mid ? 'tencent' : 'netease');
    const currentLyricSrc = (typeof switchLyricSource === 'function' && globalThis.lyricSourceOverride) ? globalThis.lyricSourceOverride : (globalThis.lyricSourceOverride || songSource);

    let html = '';
    html += `<div class="lyric-source-hint" id="lyricDownloadHint">选择下载歌词的来源（当前歌曲: <b>${_escapeHtml(songTitle || '未播放')}</b>）</div>`;
    html += '<div class="lyric-download-step">步骤 1 · 选择歌词来源</div>';
    html += '<div id="lyricDownloadSources" class="lyric-download-sources">';
    LYRIC_DL_SOURCES.forEach(src => {
        const disabled = src.key === 'current' && !curLyricLines;
        const name = src.key === 'current' ? `${src.name}${curLyricLines ? `（${curLyricLines.length} 行）` : ''}` : src.name;
        html += `
            <div class="lyric-source-option ${disabled ? 'unavailable' : ''}" data-source="${src.key}" id="ldlOpt_${src.key}">
                <div class="lyric-source-info">
                    <div class="lyric-source-name">${_escapeHtml(name)}</div>
                    <div class="lyric-source-desc">${_escapeHtml(src.desc)}</div>
                    <div class="lyric-source-badges" id="ldlBadges_${src.key}"></div>
                    <div class="lyric-download-src-status" id="ldlStatus_${src.key}"></div>
                </div>
                <div class="lyric-download-check" id="ldlCheck_${src.key}"></div>
            </div>`;
    });
    html += '</div>';
    html += `
        <div class="lyric-download-format-section" id="lyricDownloadFormatSection" style="display:none;">
            <div class="lyric-download-step">步骤 2 · 选择保存格式（${LYRIC_DL_FORMATS.length} 种格式可导出）</div>
            <div class="lyric-download-formats" id="lyricDownloadFormats"></div>
        </div>`;
    body.innerHTML = html;

    overlay.classList.add('visible');
    window._lyricDlData = null;

    /* ★ 当前歌词来源：直接用已加载歌词计算 tag（行数/逐字逐行/翻译） */
    if (curLyricLines) {
        const badgesEl = typeof document !== 'undefined' ? document.getElementById('ldlBadges_current') : null;
        if (badgesEl) {
            const hasWord = curLyricLines.some(l => l.words && l.words.length > 0 && l.words.some(w => w.start !== undefined || w.end !== undefined));
            const hasTrans = curLyricLines.some(l => l.translation && String(l.translation).trim() && String(l.translation).trim() !== '//');
            let tagHtml = `<span class="lyric-badge score-high">${curLyricLines.length} 行</span>`;
            tagHtml += hasWord ? '<span class="lyric-badge feat-word">逐字歌词</span>' : '<span class="lyric-badge score-med">逐行歌词</span>';
            if (hasTrans) tagHtml += '<span class="lyric-badge feat-trans">双语翻译</span>';
            badgesEl.innerHTML = tagHtml;
        }
    }

    /* ★ 其余来源：复用歌词源弹窗的并发探测，实时渲染 匹配度/逐字/逐行/翻译 tag */
    if (isPlayingSong && typeof probeLyricSourcesAvailability === 'function') {
        probeLyricSourcesAvailability(songTitle, songArtist, currentLyricSrc, 'ldlBadges_', 'ldlOpt_');
    }

    /* 来源点击 */
    body.querySelectorAll('.lyric-source-option').forEach(opt => {
        opt.addEventListener('click', async () => {
            const srcKey = opt.dataset.source;
            if (opt.classList.contains('unavailable')) {
                if (typeof window.showToast === 'function') window.showToast('当前没有可用的歌词');
                return;
            }
            if (opt.classList.contains('loading')) return;
            body.querySelectorAll('.lyric-source-option').forEach(o => o.classList.remove('active'));
            opt.classList.add('loading');
            const statusEl = typeof document !== 'undefined' ? document.getElementById('ldlStatus_' + srcKey) : null;
            if (statusEl) statusEl.innerHTML = '<span class="lyric-badge score-med">获取中…</span>';

            let lines = null;
            if (srcKey === 'current') {
                lines = curLyricLines;
            } else {
                if (!isPlayingSong) {
                    if (typeof window.showToast === 'function') window.showToast('请先播放歌曲，再从该来源获取歌词');
                } else if (typeof fetchLyricLinesFromSource === 'function') {
                    try {
                        const fetched = await fetchLyricLinesFromSource(srcKey);
                        if (fetched && Array.isArray(fetched.originals) && fetched.originals.length > 0) {
                            lines = fetched.originals;
                        }
                    } catch (e) { lines = null; }
                }
            }

            opt.classList.remove('loading');
            if (lines && lines.length) {
                opt.classList.add('active');
                if (statusEl) statusEl.innerHTML = `<span class="lyric-badge score-high">${lines.length} 行歌词已就绪</span>`;
                window._lyricDlData = lines;
                _buildLyricDlFormats(srcKey);
            } else {
                opt.classList.remove('active');
                if (statusEl) statusEl.innerHTML = '<span class="lyric-badge score-low">未获取到有效歌词</span>';
                if (typeof window.showToast === 'function') window.showToast('该来源未能获取到有效歌词，请换一个来源');
            }
        });
    });
}

function _buildLyricDlFormats(srcKey) {
    const fmtBox = typeof document !== 'undefined' ? document.getElementById('lyricDownloadFormats') : null;
    const sec = typeof document !== 'undefined' ? document.getElementById('lyricDownloadFormatSection') : null;
    if (!fmtBox || !sec) return;
    let html = '';
    LYRIC_DL_FORMATS.forEach(f => {
        html += `
            <div class="lyric-download-format" data-format="${f.key}" title="${_escapeHtml(f.desc)}">
                <div class="lyric-download-format-name">${_escapeHtml(f.name)}</div>
                <div class="lyric-download-format-desc">${_escapeHtml(f.desc)}</div>
            </div>`;
    });
    fmtBox.innerHTML = html;
    sec.style.display = 'block';
    fmtBox.querySelectorAll('.lyric-download-format').forEach(el => {
        el.addEventListener('click', () => {
            const fmt = el.dataset.format;
            const lines = window._lyricDlData;
            if (lines && lines.length) downloadLyric(fmt, lines);
            else if (typeof window.showToast === 'function') window.showToast('请先选择歌词来源');
        });
    });
}

function closeLyricDownloadModal() {
    const overlay = typeof document !== 'undefined' ? document.getElementById('lyricDownloadOverlay') : null;
    if (overlay) overlay.classList.remove('visible');
    window._lyricDlData = null;
}

function _sanitizeFileName(s) {
            return String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || '歌词';
        }

function _currentLyricMeta() {
            const sd = globalThis.currentSongData || {};
            const duration = audio && typeof audio.duration === 'number' && isFinite(audio.duration) ? audio.duration : 0;
            return {
                title: sd.title || '未知歌曲',
                artist: sd.artist || sd.singer || '未知歌手',
                duration
            };
        }

function _plainLrcText(lines) {
            const out = [];
            for (const line of lines) {
                const start = line.start !== undefined ? line.start : (line.time || 0);
                const text = (line.original || line.text || '').trim();
                if (text) out.push(`${formatTimestamp(start)}${text}`);
            }
            return out.join('\n');
        }

function _base64EncodeUtf8(text) {
            const bytes = new TextEncoder().encode(text);
            let bin = '';
            for (const b of bytes) bin += String.fromCharCode(b);
            return btoa(bin);
        }

/* KRC 语法: [lineStart,lineDuration]<relStart,wordDur,0>word... */
function _krcText(lines) {
            const out = [];
            for (const line of lines) {
                const start = line.start !== undefined ? line.start : (line.time || 0);
                const end = line.end !== undefined ? line.end : (start + 3500);
                const dur = Math.max(1, Math.round(end - start));
                const words = realWordsOf(line);
                if (words) {
                    let s = `[${Math.round(start)},${dur}]`;
                    for (const w of words) {
                        const ws = w.start !== undefined ? w.start : start;
                        const we = w.end !== undefined ? w.end : (ws + 250);
                        const rel = Math.max(0, Math.round(ws - start));
                        const wd = Math.max(1, Math.round(we - ws));
                        const wt = String(w.text || '').replace(/</g, '&lt;');
                        s += `<${rel},${wd},0>${wt}`;
                    }
                    out.push(s);
                } else {
                    const text = (line.original || line.text || '').trim();
                    if (text) out.push(`[${Math.round(start)},${dur}]<0,${dur},0>${text}`);
                }
            }
            return out.join('\n');
        }

/* KRC 加密: deflate 压缩 → XOR → _base64，前置 'krc1' 魔数 */
async function _krcEncode(krcText) {
            let bytes;
            if (typeof CompressionStream !== 'undefined') {
                const raw = new TextEncoder().encode(krcText);
                const ds = new CompressionStream('deflate');
                const writer = ds.writable.getWriter();
                writer.write(raw);
                writer.close();
                bytes = new Uint8Array(await new Response(ds.readable).arrayBuffer());
            } else {
                bytes = new TextEncoder().encode(krcText);
            }
            const xored = new Uint8Array(bytes.length);
            for (let i = 0; i < bytes.length; i++) xored[i] = bytes[i] ^ KRC_XOR_KEY[i % KRC_XOR_KEY.length];
            const full = new Uint8Array(bytes.length + 4);
            full.set([0x6b, 0x72, 0x63, 0x31]); /* 'krc1' */
            full.set(xored, 4);
            let bin = '';
            for (const b of full) bin += String.fromCharCode(b);
            return btoa(bin);
        }

function _triggerLyricDownload(content, filename, mime) {
            const blob = new Blob(['\ufeff' + content], { type: mime + ';charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 800);
        }

async function downloadLyric(format, linesOverride) {
            const lines = linesOverride || ((typeof window !== 'undefined' && Array.isArray(Aria.__ariaLyrics)) ? Aria.__ariaLyrics : null);
            if (!lines || lines.length === 0) {
                if (typeof window.showToast === 'function') window.showToast('当前没有可下载的歌词');
                return;
            }
            const meta = _currentLyricMeta();
            const base = `${_sanitizeFileName(meta.title)} - ${_sanitizeFileName(meta.artist)}`;
            try {
                let content = '';
                let ext = 'lrc';
                let mime = 'text/plain';
                if (format === 'lrc') {
                    content = _plainLrcText(lines);
                } else if (format === 'elrc') {
                    content = convertToEnhancedLrc(lines, { title: meta.title, artist: meta.artist, duration: meta.duration });
                    ext = 'elrc';
                } else if (format === 'qrc') {
                    content = _base64EncodeUtf8(convertToEnhancedLrc(lines, { title: meta.title, artist: meta.artist, duration: meta.duration }));
                    ext = 'qrc';
                    mime = 'application/octet-stream';
                } else if (format === 'krc') {
                    content = await _krcEncode(_krcText(lines));
                    ext = 'krc';
                    mime = 'application/octet-stream';
                }
                if (!content) throw new Error('empty content');
                _triggerLyricDownload(content, `${base}.${ext}`, mime);
                if (typeof window.showToast === 'function') window.showToast(`歌词已导出为 ${ext.toUpperCase()}`);
            } catch (err) {
                logError('eq', '[Lyric Download] 导出失败:', err);
                if (typeof window.showToast === 'function') window.showToast('歌词导出失败');
            }
        }

const moreBtn = typeof document !== 'undefined' ? document.getElementById('moreBtn') : null;

moreBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (ctxMenu.classList.contains('visible')) {
                hideCtxMenu();
            } else {
                hideEqPanel();
                openMoreMenu();
            }
        });

/* 上一曲/下一曲 */
prevBtn?.addEventListener('click', () => {
            prevTrack();
        });

nextBtn?.addEventListener('click', () => {
            nextTrack();
        });

/* 下载歌词弹窗：关闭按钮 / 点击遮罩关闭（复用歌词来源弹窗样式体系） */
(function wireLyricDownloadModal() {
    const overlay = typeof document !== 'undefined' ? document.getElementById('lyricDownloadOverlay') : null;
    if (!overlay) return;
    const closeBtn = typeof document !== 'undefined' ? document.getElementById('lyricDownloadCloseBtn') : null;
    closeBtn?.addEventListener('click', () => closeLyricDownloadModal());
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeLyricDownloadModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.classList.contains('visible')) closeLyricDownloadModal();
    });
})();

/* _krcText 一并导出：它是纯函数，且「合成逐字不得写进下载文件」这条正确性
   只有它能被单测覆盖到（走完整下载弹窗要网络 + 模态，测不动）。 */
export { applyEqGains, applyEqPreset, buildEqBands, buildEqPresets, buildSpeedSubmenu, cleanupEqAudioGraph, closeLyricDownloadModal, hideEqPanel, initEqAudioGraph, loadEqSettings, moreBtn, onEqBandChange, openEqPanel, openLyricDownloadModal, openMoreMenu, saveEqSettings, _krcText };
