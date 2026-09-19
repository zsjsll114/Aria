/* ============================================================
 * 60-mobile-dual-page.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 1389-1440 行 | 单元数: 12
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { playerContainer } from './40-playback-state.js';

/* ========== ★ P4 手机版双页布局：歌词预览 + 页面切换 ==========
           窄屏(≤700px)默认模式下分两页：播放控件页 / 歌词页。
           预览卡片随行变化更新文本，点击进入歌词页；切换按钮两页通用。 */
const mobilePreviewEl = document.getElementById('mobileLyricPreview');

const mobileToggleEl = document.getElementById('mobilePageToggle');

const mobilePageMq = window.matchMedia('(max-width: 700px)');

let _mlpTransitionSeq = 0;
let _mlpRafId = null;

function renderPreviewContent(line, origEl, transEl) {
    if (!origEl) return;
    if (!line) {
        origEl.textContent = '暂无歌词';
        origEl.classList.remove('has-words');
        if (mobilePreviewEl) {
            mobilePreviewEl._mlpWords = [];
            mobilePreviewEl.style.setProperty('--mlp-progress', '0');
        }
        if (transEl) transEl.style.display = 'none';
        return;
    }

    const text = line.original || line.text || '';
    if (line.words && line.words.length > 0) {
        origEl.innerHTML = '';
        origEl.classList.add('has-words');
        const wordsContainer = document.createElement('span');
        wordsContainer.className = 'mlp-words-container';

        const cachedWords = [];
        for (let j = 0; j < line.words.length; j++) {
            const word = line.words[j];
            const charCount = word.text.length;
            const duration = word.end - word.start;
            const charDuration = charCount > 0 ? duration / charCount : 0;

            for (let c = 0; c < charCount; c++) {
                const charStart = Math.round(word.start + c * charDuration);
                const charEnd = Math.round(word.start + (c + 1) * charDuration);
                const charText = word.text[c];

                const wordEl = document.createElement('span');
                wordEl.className = 'mlp-word';
                wordEl.dataset.start = charStart;
                wordEl.dataset.end = charEnd;

                const highlightEl = document.createElement('span');
                highlightEl.className = 'mlp-word-highlight';
                highlightEl.textContent = charText;

                const textEl = document.createElement('span');
                textEl.className = 'mlp-word-text';
                textEl.textContent = charText;

                wordEl.appendChild(highlightEl);
                wordEl.appendChild(textEl);
                wordsContainer.appendChild(wordEl);

                cachedWords.push({
                    el: wordEl,
                    highlightEl: highlightEl,
                    start: charStart,
                    end: charEnd,
                    lastPct: -1
                });
            }
        }
        origEl.appendChild(wordsContainer);
        if (mobilePreviewEl) mobilePreviewEl._mlpWords = cachedWords;
    } else {
        origEl.classList.remove('has-words');
        origEl.textContent = text;
        if (mobilePreviewEl) mobilePreviewEl._mlpWords = [];
    }

    if (transEl) {
        const tr = (line.translation && line.translation.trim() !== '//') ? line.translation : '';
        transEl.textContent = tr;
        transEl.style.display = tr ? '' : 'none';
    }
}

/**
 * 切歌或开始加载时立即重置预览歌词为"加载中..."
 */
function resetMobileLyricPreview(loadingText = '加载中...') {
    if (!mobilePreviewEl) return;
    stopMobileLyricProgress();
    mobilePreviewEl._mlpLine = null;
    mobilePreviewEl._mlpWords = [];
    mobilePreviewEl._lastLineKey = '__loading__';
    mobilePreviewEl.style.setProperty('--mlp-progress', '0');
    const origEl = mobilePreviewEl.querySelector('.mlp-original');
    const transEl = mobilePreviewEl.querySelector('.mlp-translation');
    if (origEl) {
        origEl.classList.remove('has-words');
        origEl.textContent = loadingText;
    }
    if (transEl) {
        transEl.style.display = 'none';
        transEl.textContent = '';
    }
}

function updateMobileLyricPreview(force = false) {
    if (!mobilePreviewEl) return;
    const origEl = mobilePreviewEl.querySelector('.mlp-original');
    const transEl = mobilePreviewEl.querySelector('.mlp-translation');
    let line = null;
    if (globalThis.lyrics && Array.isArray(globalThis.lyrics) && globalThis.lyrics.length > 0) {
        if (globalThis.activeLineIndex >= 0 && globalThis.activeLineIndex < globalThis.lyrics.length) {
            line = globalThis.lyrics[globalThis.activeLineIndex];
        } else {
            line = globalThis.lyrics[0];
        }
    }
    const lineKey = line ? `${line.start}_${line.original || line.text || ''}` : '__none__';

    if (!force && mobilePreviewEl._lastLineKey === lineKey) {
        /* 行未变化时，确保动画循环已启动（如从歌词页切回时） */
        startMobileLyricProgress();
        return;
    }
    mobilePreviewEl._lastLineKey = lineKey;
    mobilePreviewEl._mlpLine = line;

    const seq = ++_mlpTransitionSeq;

    // 首次渲染或未处于就绪状态直接渲染展示，无需提前淡出
    if (force || !mobilePreviewEl.classList.contains('mlp-ready')) {
        mobilePreviewEl.classList.add('mlp-ready', 'mlp-fade-in');
        renderPreviewContent(line, origEl, transEl);
        startMobileLyricProgress();
        return;
    }

    // 切换歌词行：先渐隐 (Fade Out)，再替换内容并渐显 (Fade In)
    mobilePreviewEl.classList.remove('mlp-fade-in');
    mobilePreviewEl.classList.add('mlp-fade-out');

    setTimeout(() => {
        if (seq !== _mlpTransitionSeq) return;
        renderPreviewContent(line, origEl, transEl);
        mobilePreviewEl.classList.remove('mlp-fade-out');
        mobilePreviewEl.classList.add('mlp-fade-in');
        startMobileLyricProgress();
    }, 120);
}

/* ★ 逐字扫过：根据当前播放进度设置唱词推进的高亮或百分比 */
function updateMobileLyricProgress() {
    /* 预览不可见时停止；暂停时保持轮询但无 DOM 变动，恢复播放自动继续扫过 */
    if (!mobilePreviewEl || !mobilePreviewEl.offsetParent) {
        _mlpRafId = null;
        return;
    }
    const line = mobilePreviewEl._mlpLine;
    if (!line) {
        mobilePreviewEl.style.setProperty('--mlp-progress', '0');
        _mlpRafId = null;
        return;
    }
    const t = (globalThis.currentTime != null ? globalThis.currentTime : 0) + (globalThis.lyricOffset != null ? globalThis.lyricOffset : 0);
    const words = mobilePreviewEl._mlpWords;

    if (words && words.length > 0) {
        for (let i = 0; i < words.length; i++) {
            const w = words[i];
            let pct;
            if (t < w.start) {
                pct = 0;
            } else if (t >= w.end) {
                pct = 100;
            } else {
                pct = Math.round((t - w.start) / (w.end - w.start) * 1000) / 10;
            }

            if (t >= w.start && !w.el.classList.contains('active')) {
                w.el.classList.add('active');
            } else if (t < w.start && w.el.classList.contains('active')) {
                w.el.classList.remove('active');
            }

            if (w.lastPct === pct) continue;
            w.lastPct = pct;

            w.highlightEl.style.setProperty('--reveal', pct + '%');
            if (pct >= 100) {
                w.highlightEl.classList.add('done');
            } else {
                w.highlightEl.classList.remove('done');
            }
        }
    } else {
        const startMs = line.start != null ? line.start : 0;
        let endMs;
        if (line.end != null) endMs = line.end;
        else if (line.duration != null) endMs = startMs + line.duration;
        else {
            const lines = globalThis.lyrics || [];
            const idx = lines.indexOf(line);
            endMs = (idx >= 0 && idx + 1 < lines.length && lines[idx + 1].start != null)
                ? lines[idx + 1].start
                : startMs + 2500;
        }
        let progress = 0;
        if (endMs > startMs) progress = (t - startMs) / (endMs - startMs);
        progress = Math.max(0, Math.min(1, progress));
        mobilePreviewEl.style.setProperty('--mlp-progress', progress.toFixed(4));
    }

    _mlpRafId = requestAnimationFrame(updateMobileLyricProgress);
}
function startMobileLyricProgress() { if (!_mlpRafId) _mlpRafId = requestAnimationFrame(updateMobileLyricProgress); }
function stopMobileLyricProgress() { if (_mlpRafId) { cancelAnimationFrame(_mlpRafId); _mlpRafId = null; } }

function syncMobilePageState() {
    if (!mobileToggleEl || !playerContainer) return;
    const onLyrics = playerContainer.classList.contains('mobile-page-lyrics');
    mobileToggleEl.classList.toggle('on-lyrics', onLyrics);
    mobileToggleEl.setAttribute('aria-label', onLyrics ? '切换到播放页面' : '切换到歌词页面');
    /* 胶囊双段高亮同步：当前页对应的 icon 段点亮 */
    mobileToggleEl.querySelectorAll('.mpt-seg').forEach(seg => {
        seg.classList.toggle('active', (seg.dataset.page === 'lyrics') === onLyrics);
    });

    /* ★ 关键修复：当从歌词页切回播放控件页（!onLyrics）时：
       1. 强制重新同步当前活动行
       2. 重置 cachedWords 里的 lastPct，确保立刻应用当前播放进度的高亮
       3. 立即恢复逐字扫过 requestAnimationFrame 循环 */
    if (!onLyrics) {
        if (mobilePreviewEl && mobilePreviewEl._mlpWords) {
            mobilePreviewEl._mlpWords.forEach(w => { w.lastPct = -1; });
        }
        updateMobileLyricPreview(true);
        startMobileLyricProgress();
    }
}

if (mobileToggleEl) {
            mobileToggleEl.addEventListener('click', (e) => {
                /* 胶囊分段：点哪个 icon 就去哪一页；点当前页则不动 */
                const seg = e.target.closest('.mpt-seg');
                const wantLyrics = seg ? (seg.dataset.page === 'lyrics')
                                       : !playerContainer.classList.contains('mobile-page-lyrics');
                if (wantLyrics === playerContainer.classList.contains('mobile-page-lyrics')) return;
                playerContainer.classList.toggle('mobile-page-lyrics');
                syncMobilePageState();
            });
        }

if (mobilePreviewEl) {
            mobilePreviewEl.addEventListener('click', () => {
                /* 点击预览歌词 → 切换到歌词页 */
                playerContainer.classList.add('mobile-page-lyrics');
                syncMobilePageState();
            });
        }

const onMobilePageMqChange = () => {
            /* 离开窄屏（恢复宽屏左右布局）时复位到播放控件页，防止残留隐藏状态 */
            if (!mobilePageMq.matches) playerContainer.classList.remove('mobile-page-lyrics');
            syncMobilePageState();
        };

if (mobilePageMq.addEventListener) mobilePageMq.addEventListener('change', onMobilePageMqChange);

syncMobilePageState();

globalThis.lastPercent = -1;

globalThis.lastFormattedTime = '';

export { mobilePageMq, mobilePreviewEl, mobileToggleEl, onMobilePageMqChange, resetMobileLyricPreview, syncMobilePageState, updateMobileLyricPreview, updateMobileLyricProgress, startMobileLyricProgress, stopMobileLyricProgress };
