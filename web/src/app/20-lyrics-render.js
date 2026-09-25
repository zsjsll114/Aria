/* ============================================================
 * 20-lyrics-render.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 231-586 行 | 单元数: 6
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { PVEngine } from '../core/pvEngine/PVEngine.js';
import { TunnelEngine } from '../core/tunnelEngine/TunnelEngine.js';
import { LYRICS_VIRTUAL_SCROLL } from '../config/constants.js';
import { escapeHtml, formatTime, processTextForLatin } from '../utils/formatters.js';
import { getCoverLayers } from '../infrastructure/dom.js';
import { playerContainer } from './40-playback-state.js';
import { layoutWordCloud } from './56-playback-misc.js';
import { updateWordcloudCamera } from './57-wordcloud-camera.js';
import { logInfo, logWarn, logError } from '../services/log.js';
import { ensureWordTiming } from '../parsers/wordTiming.js'; // 行级歌词 → 逐字时间补全

/* 全景视觉模式调度器 */
if (typeof window !== 'undefined') { window.currentViewMode = 'cover'; }

/* ============ 行内单词渲染（renderLyrics 拆分出的私有辅助） ============
   集中处理五种分叉：RTL 整词（非飞入连写）/ RTL 飞入逐字 / 词云英文整词
   上采样 / 普通逐字（含前后空白占位）/ 纯空白词；另含飞入微动画错落。
   逻辑从 renderLyrics 原 for-words 循环原样抽出，DOM 输出结构零变化。 */

/* ★ RTL 文字检测（阿拉伯语/希伯来语等） */
const RTL_RE = /[\u0590-\u05ff\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb1d-\ufbff\ufb50-\ufdff\ufe70-\ufeff]/u;
/* ★ CJK 检测 */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff]/u;
/* 飞入模式下用于微动画错落的全局字符索引（每行重置） */
const MICRO_PATTERNS = [
    { y: '-2px', r: '1.5deg', s: '1.02' },
    { y: '1px', r: '-1deg', s: '0.98' },
    { y: '-1px', r: '2deg', s: '1.01' },
];

/**
 * 把一个词数组(line.words)渲染进 wordsContainer。
 * 五种分叉：RTL 整词（非飞入连写）/ RTL 飞入逐字 / 词云英文整词上采样 /
 * 普通逐字（含前后空白占位）/ 纯空白词；另含飞入微动画错落。
 * 注意：循环体缩进沿用历史拼片风格（多套两层），重构仅收敛位置，不改逻辑。
 * @param {HTMLElement} wordsContainer 行内歌词容器
 * @param {Object} line 歌词行对象（取 line.words）
 * @param {number} lineIndex 行索引（写入元素 dataset.index）
 * @param {{isFlyinMode: boolean}} opts 渲染选项（飞入模式影响多处分叉）
 * @returns {boolean} 该行是否含 RTL 文字（供外层设置容器 direction）
 */
function buildWordsInto(wordsContainer, line, lineIndex, opts) {
    const isFlyinMode = opts.isFlyinMode;
    /* 飞入模式下用于微动画的全局字符索引（每行重置） */
    let globalCharIndex = 0;
    let lineHasRTL = false;
    for (let j = 0; j < line.words.length; j++) {
                        const word = line.words[j];
                        const isLatin = !CJK_RE.test(word.text) && /^[\p{L}\p{M}\p{N}\s\p{P}\p{S}]+$/u.test(word.text) && /[\p{L}]/u.test(word.text);
                        const isRTL = RTL_RE.test(word.text);
                        if (isRTL) lineHasRTL = true;
                        /* 单词间距已由 yrcParser 内嵌到 word.text 中，不再额外插入空格 span，
                           避免与内嵌空格叠加造成正式歌词英文词间距过大 */
                        const charCount = word.text.length;
                        const duration = word.end - word.start;
                        /* ★ RTL 文字（阿拉伯语等）：在飞入模式下逐字拆分以实现飞入效果，
                           普通模式下不拆字以保持连写形变 */
                        if (isRTL && !isFlyinMode) {
                            /* 普通模式：整个词作为一个元素，高亮从右向左展开 */
                            const wordEl = document.createElement('span');
                            wordEl.className = 'word';
                            wordEl.style.position = 'relative';
                            wordEl.style.display = 'inline-block';
                            wordEl.style.direction = 'rtl';
                            wordEl.style.whiteSpace = 'nowrap';
                            const highlightEl = document.createElement('span');
                            highlightEl.className = 'word-highlight rtl-highlight';
                            highlightEl.style.left = 'auto';
                            highlightEl.style.right = '0';
                            highlightEl.style.direction = 'rtl';
                            highlightEl.textContent = word.text;
                            const textEl = document.createElement('span');
                            textEl.style.position = 'relative';
                            textEl.style.zIndex = '0';
                            textEl.style.direction = 'rtl';
                            textEl.textContent = word.text;
                            wordEl.appendChild(highlightEl);
                            wordEl.appendChild(textEl);
                            wordEl.dataset.index = lineIndex;
                            wordEl.dataset.wordIndex = j;
                            wordEl.dataset.charIndex = 0;
                            wordEl.dataset.start = word.start;
                            wordEl.dataset.end = word.end;
                            wordsContainer.appendChild(wordEl);
                        } else {
                            /* 非 RTL 或飞入模式下的 RTL：按单字符拆分，逐字上浮
                               RTL 字符保持连写通过 CSS 处理 */
                            /* ★ 词首/词尾空白剥离为独立占位 span：
                               flex 布局(flex-wrap)下纯空白字符元素会被折叠成 0 宽，
                               导致飞入模式英文歌词词间距丢失。拆字只针对文字核心，
                               空白由 white-space:pre 占位符原样保留，词间距不变。 */
                            const leadingWs = (word.text.match(/^[\s\u00a0]+/) || [''])[0];
                            const trailingWs = (word.text.match(/[\s\u00a0]+$/) || [''])[0];
                            const coreText = word.text.slice(leadingWs.length, word.text.length - trailingWs.length);
                            const isWsOnly = coreText.length === 0;
                            const charCount = Math.max(1, coreText.length);
                            const charDuration = duration / charCount;
                            /* ★ 词云模式：拉丁英文整词上采样；飞入模式必须逐字符飞入（用户需求：按"字符"而非按"词"） */
                            const isLatinWholeMode = playerContainer.classList.contains('view-wordcloud') && isLatin && !isRTL && !isWsOnly;
                            const wordCore = isLatinWholeMode ? coreText : '';
                            const hasGap = isLatinWholeMode && (leadingWs || trailingWs);
                            if (isLatinWholeMode && wordCore.length > 0 && wordCore.length <= 10) {
                                /* 整词 = 单个 .word：white-space:nowrap 保持词完整，
                                   一个高亮层覆盖整词，mask 前沿随时间插值填充 */
                                const wordEl = document.createElement('span');
                                wordEl.className = 'word';
                                if (isLatin) { wordEl.classList.add('word-latin'); }
                                wordEl.style.position = 'relative';
                                wordEl.style.display = 'inline-block';
                                wordEl.style.whiteSpace = 'nowrap';
                                wordEl.style.overflow = 'visible';
                                const highlightEl = document.createElement('span');
                                highlightEl.className = 'word-highlight';
                                if (isLatin) { highlightEl.classList.add('word-highlight-latin'); }
                                highlightEl.textContent = wordCore;
                                const textEl = document.createElement('span');
                                textEl.style.position = 'relative';
                                textEl.style.zIndex = '0';
                                textEl.textContent = wordCore;
                                wordEl.appendChild(highlightEl);
                                wordEl.appendChild(textEl);
                                wordEl.dataset.index = lineIndex;
                                wordEl.dataset.wordIndex = j;
                                wordEl.dataset.charIndex = 0;
                                wordEl.dataset.start = word.start;
                                wordEl.dataset.end = word.end;
                                wordsContainer.appendChild(wordEl);
                                /* 词间空格：整词渲染时空白被剥离到文字外，
                                   若该词带前导/尾随空格需补一个间距占位，保持词距 */
                                if (hasGap) {
                                    const gapEl = document.createElement('span');
                                    gapEl.style.whiteSpace = 'pre';
                                    gapEl.textContent = ' ';
                                    wordsContainer.appendChild(gapEl);
                                }
                                continue;
                            }
                            /* ★ 飞入模式下的 RTL：不使用 wordWrap 包裹，每个字符直接
                               作为 flex item 放入 wordsContainer，这样 flex-wrap 可以
                               在字符之间自由换行，避免长词导致整行不换行 */
                            const useWordWrap = !(isRTL && isFlyinMode);
                            const wordWrap = useWordWrap ? document.createElement('span') : null;
                            if (wordWrap) {
                                wordWrap.style.display = 'inline-block';
                                wordWrap.style.whiteSpace = 'nowrap';
                                wordWrap.style.position = 'relative';
                                if (isRTL) {
                                    wordWrap.style.direction = 'rtl';
                                }
                            }
                            /* 纯空白词：整段空白以占位 span 输出，不产生字符元素 */
                            if (isWsOnly) {
                                const ge = document.createElement('span');
                                ge.style.whiteSpace = 'pre';
                                ge.style.display = 'inline-block';
                                ge.textContent = word.text;
                                (wordWrap || wordsContainer).appendChild(ge);
                                if (wordWrap) { wordsContainer.appendChild(wordWrap); }
                                continue;
                            }
                            /* 前导空白占位（追加进 wordWrap 起点，保持词间距） */
                            if (leadingWs) {
                                const ge = document.createElement('span');
                                ge.style.whiteSpace = 'pre';
                                ge.style.display = 'inline-block';
                                ge.textContent = leadingWs;
                                (wordWrap || wordsContainer).appendChild(ge);
                            }
                            for (let c = 0; c < charCount; c++) {
                                const charStart = Math.round(word.start + c * charDuration);
                                const charEnd = Math.round(word.start + (c + 1) * charDuration);
                                const wordEl = document.createElement('span');
                                wordEl.className = 'word';
                                if (isLatin) { wordEl.classList.add('word-latin'); }
                                if (isRTL) { wordEl.classList.add('word-rtl-char'); }
                                wordEl.style.position = 'relative';
                                wordEl.style.display = 'inline-block';
                                /* ★ 飞入模式：给每个字符设置全局索引，用于微动画错落效果 */
                                if (isFlyinMode) {
                                    const micro = MICRO_PATTERNS[globalCharIndex % 3];
                                    wordEl.style.setProperty('--micro-y', micro.y);
                                    wordEl.style.setProperty('--micro-r', micro.r);
                                    wordEl.style.setProperty('--micro-s', micro.s);
                                    globalCharIndex++;
                                }
                                const highlightEl = document.createElement('span');
                                highlightEl.className = 'word-highlight';
                                if (isLatin) { highlightEl.classList.add('word-highlight-latin'); }
                                if (isRTL) { highlightEl.classList.add('rtl-highlight'); }
                                highlightEl.textContent = coreText[c];
                                const textEl = document.createElement('span');
                                textEl.style.position = 'relative';
                                textEl.style.zIndex = '0';
                                textEl.textContent = coreText[c];
                                wordEl.appendChild(highlightEl);
                                wordEl.appendChild(textEl);
                                wordEl.dataset.index = lineIndex;
                                wordEl.dataset.wordIndex = j;
                                wordEl.dataset.charIndex = c;
                                wordEl.dataset.start = charStart;
                                wordEl.dataset.end = charEnd;
                                if (wordWrap) {
                                    wordWrap.appendChild(wordEl);
                                } else {
                                    wordsContainer.appendChild(wordEl);
                                }
                            }
                            /* 尾随空白占位（追加进 wordWrap 末尾，保持词间距） */
                            if (trailingWs) {
                                const ge = document.createElement('span');
                                ge.style.whiteSpace = 'pre';
                                ge.style.display = 'inline-block';
                                ge.textContent = trailingWs;
                                (wordWrap || wordsContainer).appendChild(ge);
                            }
                            if (wordWrap) {
                                wordsContainer.appendChild(wordWrap);
                            }
                        }
                    }
    return lineHasRTL;
}

function renderLyrics(lyrics) {
            /* ★ 逐字兜底：只有行级时间戳的歌词（普通 LRC、多数外部源）按行时长摊平出
               逐字时间，否则下面 `line.words.length` 分支不成立、整行一跳。
               已有真实逐字会原样返回（不覆盖平台给的精确节拍）；合成行带
               wordTiming='synthesized'，下载/标签/选源三处真值判定靠它区分假时间戳。
               放在这个函数入口而不是各加载点：23 个 renderLyrics 调用点一次覆盖，
               且 globalThis.lyrics 一起被补齐，桌面歌词/PV/词云/手机远端都受益。 */
            lyrics = ensureWordTiming(lyrics, {
                totalMs: (typeof audio !== 'undefined' && audio && Number.isFinite(audio.duration))
                    ? Math.round(audio.duration * 1000) : 0
            });
            /* ★ 当前歌词全局缓存：供"下载歌词"(90-eq.js)读取即时数据 */
            if (typeof window !== 'undefined') { Aria.__ariaLyrics = lyrics; }
            /* ★ 同步 globalThis.lyrics：形参 lyrics 会遮蔽全局名，
               模块内的 cacheLyricElements 等函数引用的是 globalThis.lyrics（10-config-state.js 初始化为 []），
               不在此同步会导致 PV/Tunnel 等场景拿到的仍是上一首歌的旧歌词 */
            globalThis.lyrics = lyrics;
            const scrollEl = typeof document !== 'undefined' ? document.getElementById('lyricsScroll') : null;
            scrollEl.innerHTML = '';

            const styleId = 'lyrics-render-style';
            let style = document.getElementById(styleId);
            if (!style) {
                style = document.createElement('style');
                style.id = styleId;
                style.textContent = `
                    .line, .lrc-original, .lrc-translation, .lrc-romaji, .words-container, .word {
                        white-space: pre-wrap;
                        word-spacing: normal;
                        letter-spacing: normal;
                    }
                    .lrc-original, .lrc-translation, .lrc-romaji {
                        overflow-wrap: break-word;
                        word-break: keep-all;
                    }
                    .line-placeholder {
                        /* 不设固定高度：保持行的自然高度（含翻译/罗马音），
                           防止虚拟化/恢复时 offsetTop 跳变导致滚动回弹。
                           子元素 visibility:hidden 已避免绘制，性能足够。 */
                        box-sizing: border-box;
                    }
                `;
                document.head.appendChild(style);
            }

            /* 虚拟滚动：只渲染视口附近的歌词，其余用占位符 */
            const renderRange = LYRICS_VIRTUAL_SCROLL.renderRange;
            const totalLines = lyrics.length;

            for (let i = 0; i < totalLines; i++) {
                const line = lyrics[i];
                const lineEl = document.createElement('div');
                lineEl.className = 'line';
                lineEl.dataset.index = i;
                lineEl.dataset.start = line.start;

                /* 标记是否为虚拟渲染（超出视口范围） */
                lineEl.dataset.virtual = 'true';

                const timeEl = document.createElement('div');
                timeEl.className = 'line-time';
                timeEl.textContent = formatTime(Math.max(0, line.start - lyricOffset));
                lineEl.appendChild(timeEl);

                const originalEl = document.createElement('div');
                originalEl.className = 'lrc-original';

                if (line.words && line.words.length > 0) {
                    const wordsContainer = document.createElement('div');
                    wordsContainer.className = 'words-container';
                    /* ★ 行内单词渲染（RTL 整词/飞入逐字/词云英文整词/空白占位/微动画
                       全部分叉已收敛到模块级私有函数 buildWordsInto，见文件头部） */
                    const lineHasRTL = buildWordsInto(wordsContainer, line, i, {
                        isFlyinMode: playerContainer.classList.contains('view-flyin')
                    });
                    if (lineHasRTL) {
                        wordsContainer.style.direction = 'rtl';
                    }
                    originalEl.appendChild(wordsContainer);
                }
                else if (line.original) {
                    originalEl.innerHTML = processTextForLatin(escapeHtml(line.original));
                } else {
                    originalEl.innerHTML = processTextForLatin(escapeHtml(line.text || ""));
                }

                /* ★ 按行语言标记：中日文共享 CJK 码位，标记后由 CSS 整行统一字体（见 detectLineLang） */
                const lineLang = (typeof window !== 'undefined' && Aria.__detectLineLang)
                    ? Aria.__detectLineLang(
                        line.words ? line.words.map(w => w.text || '').join('') : (line.original || line.text || '')
                    )
                    : null;
                if (lineLang) { originalEl.dataset.lineLang = lineLang; }
                else { originalEl.removeAttribute('data-line-lang'); }

                lineEl.appendChild(originalEl);

                if (line.translation && line.translation.trim() !== '//' && appSettings.lyrics.showTranslation) {
                    const transEl = document.createElement('div');
                    transEl.className = 'lrc-translation';
                    transEl.textContent = line.translation;
                    lineEl.appendChild(transEl);
                }

                if (line.romaji && appSettings.lyrics.showRomaji) {
                    const romaEl = document.createElement('div');
                    romaEl.className = 'lrc-romaji';
                    romaEl.textContent = line.romaji;
                    lineEl.appendChild(romaEl);
                }

                scrollEl.appendChild(lineEl);
            }
            /* 渲染完成后缓存元素引用，供高亮更新高效使用 */
            cacheLyricElements();

            /* ★ 词云模式：切歌后重新排版 */
            if (playerContainer.classList.contains('view-wordcloud') && lineElements.length > 0) {
                setTimeout(() => {
                    layoutWordCloud();
                    if (activeLineIndex >= 0) {
                        updateWordcloudCamera();
                    }
                }, 60);
            }
        }

/* 渲染后缓存行/单词/高亮元素，避免每次动画帧全量查询DOM */
function cacheLyricElements() {
            const mainScroll = typeof document !== 'undefined' ? document.getElementById('lyricsScroll') : null;
            lineElements = mainScroll ? Array.from(mainScroll.querySelectorAll('.line')) : [];
            wordElementsByLine = [];
            wordHighlightElementsByLine = [];
            lineElements.forEach(line => {
                const words = Array.from(line.querySelectorAll('.word'));
                wordElementsByLine.push(words);
                wordHighlightElementsByLine.push(words.map(w => w.querySelector('.word-highlight')));
            });
            lastWordProgress.clear();
            activeLineIndex = -1;
            /* 切歌时歌词滚动复位到顶部 */
            currentScrollY = 0;
            const scrollEl = mainScroll;
            /* ★ 词云模式：不重置 transform（词云有自己的 translate(X,Y) 镜头平移），
               也不初始化虚拟滚动（词云要求所有行始终可见） */
            const isWordcloudMode = playerContainer.classList.contains('view-wordcloud');
            if (!isWordcloudMode) {
                scrollEl.style.transition = 'none';
                scrollEl.style.transform = 'translateY(0px)';

                /* 初始化虚拟滚动：标记当前可见区域 */
                if (LYRICS_VIRTUAL_SCROLL.enabled) {
                    updateVirtualLyricsRender(0);
                }
            }

            /* ★ 重建逐行牵动链（57 的链式弹簧）：行距/位置缓存 + 弹簧复位。
               行级 transform 由新行自然归零；master/三点弹簧一并复位。 */
            if (typeof globalThis.Aria?.__lyricsRebuildChain === 'function') {
                globalThis.Aria.__lyricsRebuildChain();
            }

            /* 如果有 AI 情感词，重新应用着色（首曲/切歌后歌词重新渲染） */
            if (typeof applyEmotionWordColors === 'function') {
                applyEmotionWordColors();
                setTimeout(() => { if (typeof applyEmotionWordColors === 'function') applyEmotionWordColors(); }, 80);
            }
            if (currentViewMode === 'pv') {
                let pvContainer = typeof document !== 'undefined' ? document.getElementById('pvViewContainer') : null;
                if (!pvContainer && typeof document !== 'undefined' && playerContainer) {
                    pvContainer = document.createElement('div');
                    pvContainer.id = 'pvViewContainer';
                    pvContainer.className = 'pv-view-container';
                    playerContainer.appendChild(pvContainer);
                }
                if (pvContainer) pvContainer.style.display = 'block';
                if (!pvEngineInstance && typeof PVEngine === 'function' && pvContainer) {
                    pvEngineInstance = new PVEngine(pvContainer);
                    pvEngineInstance.init(pvContainer);
                    pvEngineInstance.start();
                }
                if (pvEngineInstance) {
                    logInfo('lyricsRender', '[PV Mode] renderLyrics: 传送', lyrics.length, '行歌词到 PVEngine');
                    pvEngineInstance.setLyrics(lyrics, currentAiTheme || {});
                    if (appSettings.modeSettings && appSettings.modeSettings.pv) {
                        pvEngineInstance.applySettings(appSettings.modeSettings.pv);
                    }
                    /* ★ 上游参考项目 流体背景：当前封面喂入背景层（缩图模糊底，切歌交叉淡化） */
                    if (pvEngineInstance.background && typeof pvEngineInstance.background.setCover === 'function') {
                        const coverEl = getCoverLayers().find(l => l && (l.currentSrc || l.src));
                        const coverUrl = coverEl ? (coverEl.currentSrc || coverEl.src) : null;
                        if (coverUrl) pvEngineInstance.background.setCover(coverUrl);
                    }
                    if (window.coverPalette && pvEngineInstance.background) {
                        pvEngineInstance.background.updateTheme(window.coverPalette.primary, window.coverPalette.secondary, window.coverPalette.accent);
                    }
                    pvEngineInstance.update(audio ? audio.currentTime : 0);
                }
            }
            if (currentViewMode === 'tunnel') {
                let tunnelContainer = typeof document !== 'undefined' ? document.getElementById('tunnelViewContainer') : null;
                if (!tunnelContainer && typeof document !== 'undefined' && playerContainer) {
                    tunnelContainer = document.createElement('div');
                    tunnelContainer.id = 'tunnelViewContainer';
                    tunnelContainer.className = 'tunnel-view-container';
                    playerContainer.appendChild(tunnelContainer);
                }
                if (tunnelContainer) tunnelContainer.style.display = 'block';
                if (!tunnelEngineInstance && typeof TunnelEngine === 'function' && tunnelContainer) {
                    tunnelEngineInstance = new TunnelEngine(tunnelContainer);
                    tunnelEngineInstance.init(tunnelContainer);
                    tunnelEngineInstance.start();
                }
                if (tunnelEngineInstance) {
                    logInfo('lyricsRender', '[Tunnel Mode] renderLyrics: 传送', lyrics.length, '行歌词到 TunnelEngine');
                    const sig = (Array.isArray(lyrics) && lyrics.length > 0
                        ? String((lyrics[0] && (lyrics[0].original || lyrics[0].text)) || '') + '|' + lyrics.length
                        : 'empty');
                    const feedTunnel = (theme) => {
                        tunnelEngineInstance.setLyrics(lyrics, theme || currentAiTheme || {});
                        if (appSettings.modeSettings && appSettings.modeSettings.tunnel) {
                            tunnelEngineInstance.applySettings(appSettings.modeSettings.tunnel);
                        }
                        tunnelEngineInstance.update(audio ? audio.currentTime : 0);
                    };
                    /* ★ 切歌确认：进模式后的新歌渲染走同一 token 确认流程（而非直喂），
                       3s 护栏防「进入时已弹 + 渲染又弹」双弹；同歌重复渲染不重弹 */
                    const shAsk = typeof window !== 'undefined' && Aria.__tunnelEnsureAnalysis === 'function'
                        && (Aria.__tunnelLastAskAt || 0) < Date.now() - 3000
                        && Aria.__tunnelFedSong !== sig;
                    if (typeof window !== 'undefined') Aria.__tunnelFedSong = sig;
                    if (shAsk) {
                        Aria.__tunnelEnsureAnalysis(feedTunnel);
                    } else {
                        feedTunnel(currentAiTheme || {});
                    }
                }
            }
            if (mainVisManager) {
                if (!mainVisManager.activeMode && currentViewMode && mainVisManager.has(currentViewMode)) {
                    mainVisManager.switchMode(currentViewMode);
                }
                if (mainVisManager.has(currentViewMode)) {
                    mainVisManager.setLyrics(lyrics, currentAiTheme || {});
                    if (appSettings.modeSettings && appSettings.modeSettings[currentViewMode]) {
                        mainVisManager.applySettings(appSettings.modeSettings[currentViewMode]);
                    }
                    mainVisManager.update(audio ? audio.currentTime : 0);
                }
            }
        }

/* 虚拟滚动：根据当前活动行更新渲染范围 */
function updateVirtualLyricsRender(centerIndex) {
            if (!LYRICS_VIRTUAL_SCROLL.enabled || !lineElements.length) return;

            const renderRange = LYRICS_VIRTUAL_SCROLL.renderRange;
            const totalLines = lineElements.length;
            const startIdx = Math.max(0, centerIndex - renderRange);
            const endIdx = Math.min(totalLines - 1, centerIndex + renderRange);

            for (let i = 0; i < totalLines; i++) {
                const lineEl = lineElements[i];
                if (!lineEl) continue;

                const isInRange = i >= startIdx && i <= endIdx;
                const wasVirtual = lineEl.dataset.virtual === 'true';

                if (isInRange && wasVirtual) {
                    /* 进入渲染范围：恢复可见性与交互 */
                    lineEl.dataset.virtual = 'false';
                    lineEl.classList.remove('line-placeholder');
                    const originalEl = lineEl.querySelector('.lrc-original');
                    if (originalEl) originalEl.style.visibility = '';
                    const transEl = lineEl.querySelector('.lrc-translation');
                    if (transEl) transEl.style.visibility = '';
                    const romaEl = lineEl.querySelector('.lrc-romaji');
                    if (romaEl) romaEl.style.visibility = '';
                } else if (!isInRange && !wasVirtual) {
                    /* 离开渲染范围：隐藏绘制但保留布局尺寸（防止 offsetTop 高度塌陷导致滚动回弹反跳） */
                    lineEl.dataset.virtual = 'true';
                    lineEl.classList.add('line-placeholder');
                    const originalEl = lineEl.querySelector('.lrc-original');
                    if (originalEl) originalEl.style.visibility = 'hidden';
                    const transEl = lineEl.querySelector('.lrc-translation');
                    if (transEl) transEl.style.visibility = 'hidden';
                    const romaEl = lineEl.querySelector('.lrc-romaji');
                    if (romaEl) romaEl.style.visibility = 'hidden';
                }
            }
        }

/* 按与当前活动行的距离更新单行的模糊类；只操作 className 不写内联样式。
   ★ 用 dataset 缓存级别，级别未变直接跳过（大幅减少切行时整页 class 操作） */
function updateLineBlur(lineIndex) {
            if (!lineElements[lineIndex]) return;
            const el = lineElements[lineIndex];
            const level = activeLineIndex < 0 ? 8 : Math.min(Math.abs(lineIndex - activeLineIndex), 8);
            if (el.dataset.blur === String(level)) return;
            el.dataset.blur = String(level);
            el.classList.remove('blur-d0', 'blur-d1', 'blur-d2', 'blur-d3', 'blur-d4', 'blur-d5', 'blur-d6', 'blur-d7', 'blur-d8');
            el.classList.add(`blur-d${level}`);
        }

/* ========== 播放器配置和状态 ========== */
const audio = typeof document !== 'undefined' ? document.getElementById('audioPlayer') : null;
/* ★ audio 单例挂全局：供 core/ 层（如 DimensionVisualizer）跨层获取同一播放元素，
   避免误走 document.querySelector('audio') 拿到非播放器元素 */
if (typeof globalThis !== 'undefined' && audio) globalThis.audio = audio;

export { audio, cacheLyricElements, renderLyrics, updateLineBlur, updateVirtualLyricsRender };
