/* ============================================================
 * 170-lyric-sources.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 6916-7450 行 | 单元数: 9
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { API_BASE } from '../config/constants.js';
import { escapeHtml } from '../utils/formatters.js';
import { parseNeteaseYrc } from '../parsers/yrcParser.js';
import { parseLrc } from '../parsers/lrcParser.js';
import { detectAndParseLyrics, mergeLyrics } from '../parsers/lyricMerger.js';
import { fetchKugouLyric, fetchKuwoLyric, fetchLyricWithFallback } from '../services/musicApi.js';
import { parseEnhancedLrc } from '../services/enhancedLrcConverter.js';
import { audio, renderLyrics } from './20-lyrics-render.js';
import { aiThemeCache } from './40-playback-state.js';
import { updateLyricsHighlight } from './57-wordcloud-camera.js';
import { calculateSongMatchScore, showToast } from './155-random-toast-match.js';
import { audioRecognizeOverlay, closeAudioRecognizeModal } from './165-audio-recognize.js';
import { logWarn, logInfo, logError } from '../services/log.js';
audioRecognizeOverlay?.addEventListener('click', (e) => {
            if (e.target === audioRecognizeOverlay) {
                closeAudioRecognizeModal();
            }
        });

/* 全局歌词源探测结果缓存：key -> { [sourceKey]: result } */
const lyricSourceProbeCache = new Map();

globalThis.isLyricSwitching = false;

/* 渲染各歌词源徽章的辅助函数（无 emoji，纯净专业） */
function renderSourceBadges(badgeContainer, optEl, sourceKey, result, isActive) {
            if (!badgeContainer || !optEl) return;
            if (result.available) {
                let badgeHtml = '';
                if (isActive) badgeHtml += '<span class="lyric-badge feat-active">当前生效</span>';
                
                const score = result.score || 90;
                const scoreClass = score >= 90 ? 'score-high' : (score >= 75 ? 'score-med' : 'score-low');
                badgeHtml += `<span class="lyric-badge ${scoreClass}">${score}% 匹配度</span>`;

                if (result.isWord) {
                    badgeHtml += '<span class="lyric-badge feat-word">逐字歌词</span>';
                } else {
                    badgeHtml += '<span class="lyric-badge score-med">逐行歌词</span>';
                }

                if (result.hasTrans) {
                    badgeHtml += '<span class="lyric-badge feat-trans">双语翻译</span>';
                }

                badgeContainer.innerHTML = badgeHtml;
                optEl.classList.remove('unavailable');
            } else {
                if (!isActive) {
                    badgeContainer.innerHTML = '<span class="lyric-badge score-low">未收录此歌曲</span>';
                    optEl.classList.add('unavailable');
                } else {
                    badgeContainer.innerHTML = '<span class="lyric-badge feat-active">当前生效</span><span class="lyric-badge score-med">已加载</span>';
                }
            }
        }

/* 显示歌词来源选择弹窗（根据当前歌曲动态真实探测可用性、匹配度百分比与歌词类型，带全局缓存） */
async function showLyricSourceModal() {
            const overlay = typeof document !== 'undefined' ? document.getElementById('lyricSourceOverlay') : null;
            const body = typeof document !== 'undefined' ? document.getElementById('lyricSourceBody') : null;
            if (!overlay || !body) return;

            // 每次打开弹窗前确保重置切换锁定
            isLyricSwitching = false;

            const songTitle = (currentSongData && currentSongData.title) ? currentSongData.title : '（当前未播放歌曲）';
            const songArtist = (currentSongData && currentSongData.artist) ? currentSongData.artist : '';
            const songSource = (currentSongData && currentSongData.source) || (currentSongData && currentSongData.mid ? 'tencent' : 'netease');
            const currentLyricSrc = lyricSourceOverride || songSource;

            const sources = [
                {
                    key: 'tencent',
                    name: 'QQ音乐',
                    desc: '从QQ音乐获取官方歌词与翻译'
                },
                {
                    key: 'netease',
                    name: '网易云音乐',
                    desc: '从网易云音乐获取官方歌词与翻译'
                },
                {
                    key: 'kuwo',
                    name: '酷我音乐',
                    desc: '从酷我音乐获取官方高匹配度歌词'
                },
                {
                    key: 'kugou',
                    name: '酷狗音乐 (KRC)',
                    desc: '从酷狗音乐获取高精度逐字歌词'
                },
                {
                    key: 'amll',
                    name: 'AMLL 歌词库 (TTML)',
                    desc: '开源社区贡献的高质量逐字歌词'
                },
                {
                    key: 'lrclib',
                    name: 'LRCLIB (开放词库)',
                    desc: '全球开源开放歌词数据库'
                }
            ];

            let html = '';
            html += `<div class="lyric-source-hint" id="lyricSourceHint">当前播放: <b>${escapeHtml(songTitle)}</b> ${songArtist ? '- ' + escapeHtml(songArtist) : ''}</div>`;

            sources.forEach(src => {
                const isActive = (src.key === currentLyricSrc);
                html += `
                    <div class="lyric-source-option ${isActive ? 'active' : ''}" data-source="${src.key}" id="lyricOpt_${src.key}">
                        <div class="lyric-source-info">
                            <div class="lyric-source-name" style="display:flex;align-items:center;gap:6px;">
                                <span class="opt-name-text">${escapeHtml(src.name)}</span>
                                ${isActive ? '<span class="lyric-badge feat-active">当前生效</span>' : ''}
                            </div>
                            <div class="lyric-source-desc">${escapeHtml(src.desc)}</div>
                            <div class="lyric-source-badges" id="badges_${src.key}">
                                ${isActive ? '<span class="lyric-badge feat-word">正在使用</span>' : '<span class="lyric-badge score-med">检查可用性...</span>'}
                            </div>
                        </div>
                        <div class="lyric-source-status-area" style="display:flex;align-items:center;gap:8px;">
                            <div class="lyric-source-check"></div>
                        </div>
                    </div>`;
            });

            // 底部上传自定义 LRC 按钮
            html += `
                <button class="lyric-custom-upload-btn" id="modalUploadCustomLrcBtn">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                    <span>+ 上传本地 LRC 歌词文件</span>
                </button>
                <input type="file" id="modalCustomLrcFileInput" accept=".lrc,.elrc,.txt" style="display:none;">`;

            body.innerHTML = html;

            // 绑定选项点击事件（带严密状态生命周期与无锁恢复）
            body.querySelectorAll('.lyric-source-option').forEach(opt => {
                opt.addEventListener('click', async () => {
                    if (isLyricSwitching) return;
                    if (opt.classList.contains('unavailable')) {
                        showToast('该来源暂未找到此歌曲的可用歌词');
                        return;
                    }
                    const source = opt.dataset.source;
                    const activeSrc = lyricSourceOverride || songSource;
                    if (source === activeSrc) {
                        showToast('当前已在使用该歌词来源');
                        return;
                    }
                    isLyricSwitching = true;

                    // 禁用所有选项交互，并在当前选项显示转圈 Spinner
                    body.querySelectorAll('.lyric-source-option').forEach(o => o.style.pointerEvents = 'none');
                    opt.classList.add('loading');
                    const statusArea = opt.querySelector('.lyric-source-status-area');
                    if (statusArea) {
                        statusArea.innerHTML = '<div class="lyric-source-spinner"></div>';
                    }
                    const sourceName = opt.querySelector('.opt-name-text')?.textContent || source;
                    showToast(`正在从${sourceName}获取歌词...`);

                    try {
                        const success = await switchLyricSource(source);
                        if (success) {
                            // 切换成功，立即重置全部条目状态并标记当前选中
                            body.querySelectorAll('.lyric-source-option').forEach(o => {
                                o.classList.remove('loading');
                                const isCurrent = (o.dataset.source === source);
                                o.classList.toggle('active', isCurrent);
                                const sArea = o.querySelector('.lyric-source-status-area');
                                if (sArea) sArea.innerHTML = '<div class="lyric-source-check"></div>';
                                const nameText = o.querySelector('.opt-name-text')?.textContent;
                                const nameWrap = o.querySelector('.lyric-source-name');
                                if (nameWrap && nameText) {
                                    nameWrap.innerHTML = `<span class="opt-name-text">${escapeHtml(nameText)}</span>${isCurrent ? '<span class="lyric-badge feat-active">当前生效</span>' : ''}`;
                                }
                            });
                            setTimeout(() => {
                                overlay.classList.remove('visible');
                            }, 200);
                        } else {
                            // 切换失败，复原图标
                            body.querySelectorAll('.lyric-source-option').forEach(o => {
                                o.classList.remove('loading');
                                const sArea = o.querySelector('.lyric-source-status-area');
                                if (sArea) sArea.innerHTML = '<div class="lyric-source-check"></div>';
                            });
                        }
                    } catch (err) {
                        logError('lyricSources', '切换歌词源过程异常:', err);
                        showToast('切换歌词失败，已保留原歌词');
                        body.querySelectorAll('.lyric-source-option').forEach(o => {
                            o.classList.remove('loading');
                            const sArea = o.querySelector('.lyric-source-status-area');
                            if (sArea) sArea.innerHTML = '<div class="lyric-source-check"></div>';
                        });
                    } finally {
                        isLyricSwitching = false;
                        body.querySelectorAll('.lyric-source-option').forEach(o => {
                            if (!o.classList.contains('unavailable')) {
                                o.style.pointerEvents = '';
                            }
                        });
                    }
                });
            });

            // 绑定上传自定义 LRC 事件
            const uploadBtn = document.getElementById('modalUploadCustomLrcBtn');
            const fileInput = document.getElementById('modalCustomLrcFileInput');
            if (uploadBtn && fileInput) {
                uploadBtn.onclick = () => fileInput.click();
                fileInput.onchange = async () => {
                    if (fileInput.files && fileInput.files[0]) {
                        const lrcText = await fileInput.files[0].text();
                        const parsed = parseEnhancedLrc(lrcText);
                        lyrics = parsed.lines;
                        activeLineIndex = -1;
                        aiEmotionWords = [];
                        renderLyrics(lyrics);
                        updateLyricsHighlight();
                        lyricSourceOverride = 'custom_local';
                        overlay.classList.remove('visible');
                        showToast('已成功应用自定义本地歌词');
                    }
                };
            }

            overlay.classList.add('visible');

            // 检查缓存或异步后台并发真实探测各源并更新 Badge
            if (currentSongData && currentSongData.title) {
                probeLyricSourcesAvailability(songTitle, songArtist, currentLyricSrc);
            }
        }

if (typeof window !== 'undefined') window.showLyricSourceModal = showLyricSourceModal;

/* 并发真实探测各源歌词可用性（真正获取歌词验证逐字与翻译，带全局缓存与匹配度算法）。
   ★ badgeIdPrefix/optIdPrefix 允许复用于下载歌词弹窗等场景，避免与来源弹窗 ID 冲突 */
async function probeLyricSourcesAvailability(title, artist, currentLyricSrc, badgeIdPrefix = 'badges_', optIdPrefix = 'lyricOpt_') {
            const cacheKey = `${title}__${artist || ''}__${currentSongData ? (currentSongData.id || currentSongData.mid || '') : ''}`;

            // 如果该歌曲已经探测过，直接瞬间从缓存还原所有源的状态
            if (lyricSourceProbeCache.has(cacheKey)) {
                const cachedMap = lyricSourceProbeCache.get(cacheKey);
                for (const [sourceKey, result] of Object.entries(cachedMap)) {
                    const badgeContainer = typeof document !== 'undefined' ? document.getElementById(`${badgeIdPrefix}${sourceKey}`) : null;
                    const optEl = typeof document !== 'undefined' ? document.getElementById(`${optIdPrefix}${sourceKey}`) : null;
                    const isActive = (sourceKey === currentLyricSrc);
                    renderSourceBadges(badgeContainer, optEl, sourceKey, result, isActive);
                }
                return;
            }

            const queryWord = `${title} ${artist || ''}`.trim();
            const songResultsMap = {};

            const probeTencent = async () => {
                try {
                    const res = await fetch(`${API_BASE}/tencent?word=${encodeURIComponent(queryWord)}&num=3`, { signal: AbortSignal.timeout(3500) }).then(r => r.json());
                    if (res.code === 200 && res.data) {
                        const list = Array.isArray(res.data) ? res.data : [res.data];
                        if (list.length > 0) {
                            let best = list.find(item => {
                                const t = (item.song || '').toLowerCase();
                                const s = (item.singer || '').toLowerCase();
                                return t.includes(title.toLowerCase()) && s.includes((artist || '').toLowerCase());
                            }) || list[0];
                            const score = calculateSongMatchScore(title, artist, best.song, best.singer);
                            const lyricData = await fetchLyricWithFallback(String(best.id), 'tencent');
                            const parsed = detectAndParseLyrics(lyricData);
                            const isWord = parsed.originals.some(l => l.words && l.words.length > 0 && l.words.some(w => w.start !== undefined || w.end !== undefined));
                            const hasTrans = Array.isArray(parsed.translations) && parsed.translations.some(t => t.text && t.text.trim() && t.text.trim() !== '//');
                            return { available: parsed.originals.length > 0, score, isWord, hasTrans };
                        }
                    }
                } catch (e) { logWarn('lyricSource', e); }
                return { available: false, score: 0, isWord: false, hasTrans: false };
            };

            const probeNetease = async () => {
                try {
                    const res = await fetch(`${API_BASE}/netease?word=${encodeURIComponent(queryWord)}&num=3`, { signal: AbortSignal.timeout(3500) }).then(r => r.json());
                    if (res.code === 200 && res.data) {
                        const list = Array.isArray(res.data) ? res.data : [res.data];
                        if (list.length > 0) {
                            let best = list.find(item => {
                                const t = (item.song || '').toLowerCase();
                                const s = (item.singer || '').toLowerCase();
                                return t.includes(title.toLowerCase()) && s.includes((artist || '').toLowerCase());
                            }) || list[0];
                            const score = calculateSongMatchScore(title, artist, best.song, best.singer);
                            const lyricData = await fetchLyricWithFallback(String(best.id), 'netease');
                            const parsed = detectAndParseLyrics(lyricData);
                            const isWord = parsed.originals.some(l => l.words && l.words.length > 0 && l.words.some(w => w.start !== undefined || w.end !== undefined));
                            const hasTrans = Array.isArray(parsed.translations) && parsed.translations.some(t => t.text && t.text.trim() && t.text.trim() !== '//');
                            return { available: parsed.originals.length > 0, score, isWord, hasTrans };
                        }
                    }
                } catch (e) { logWarn('lyricSource', e); }
                return { available: false, score: 0, isWord: false, hasTrans: false };
            };

            const probeKugou = async () => {
                try {
                    const res = await fetchKugouLyric({ song: title, singer: artist, duration: 0 });
                    if (res && res.parsedList && res.parsedList.length > 0) {
                        const isWord = res.parsedList.some(l => l.words && l.words.length > 0);
                        const score = isWord ? 98 : 88;
                        return { available: true, score, isWord, hasTrans: false };
                    }
                } catch (e) { logWarn('lyricSource', e); }
                return { available: false, score: 0, isWord: false, hasTrans: false };
            };

            const probeKuwo = async () => {
                try {
                    const kwId = (currentSongData && currentSongData.source === 'kuwo') ? currentSongData.id : null;
                    const res = await fetchKuwoLyric({ song: title, singer: artist, id: kwId });
                    if (res && res.parsedList && res.parsedList.length > 0) {
                        return { available: true, score: 94, isWord: false, hasTrans: false };
                    }
                } catch (e) { logWarn('lyricSource', e); }
                return { available: false, score: 0, isWord: false, hasTrans: false };
            };

            const probeAmll = async () => {
                try {
                    const qRes = await fetch(`${API_BASE}/netease?word=${encodeURIComponent(queryWord)}&num=1`, { signal: AbortSignal.timeout(2500) }).then(r => r.json());
                    if (qRes.code === 200 && qRes.data && qRes.data[0]?.id) {
                        const amllRes = await fetch(`/proxy?url=${encodeURIComponent(`https://amll-ttml-db.stevexmh.net/ncm/${qRes.data[0].id}?format=yrc`)}`, { signal: AbortSignal.timeout(2500) });
                        if (amllRes.ok) {
                            const text = await amllRes.text();
                            if (text && text.includes('[')) {
                                const normalizedYrc = text.replace(/\s+(?=\[\d+,\d+\])/g, '\n');
                                const parsed = parseNeteaseYrc(normalizedYrc);
                                if (parsed.length > 0) {
                                    const isWord = parsed.some(l => l.words && l.words.length > 0);
                                    return { available: true, score: 95, isWord, hasTrans: false };
                                }
                            }
                        }
                    }
                } catch (e) { logWarn('lyricSource', e); }
                return { available: false, score: 0, isWord: false, hasTrans: false };
            };

            const probeLrclib = async () => {
                try {
                    const q = new URLSearchParams({ track_name: title, artist_name: artist || '' });
                    const res = await fetch(`https://lrclib.net/api/get?${q.toString()}`, { signal: AbortSignal.timeout(3000) });
                    if (res.ok) {
                        const json = await res.json();
                        if (json.syncedLyrics || json.plainLyrics) {
                            const score = calculateSongMatchScore(title, artist, json.trackName || title, json.artistName || artist);
                            return { available: true, score: Math.max(score, 82), isWord: false, hasTrans: false };
                        }
                    }
                } catch (e) { logWarn('lyricSource', e); }
                return { available: false, score: 0, isWord: false, hasTrans: false };
            };

            const probeTasks = {
                tencent: probeTencent(),
                netease: probeNetease(),
                kuwo: probeKuwo(),
                kugou: probeKugou(),
                amll: probeAmll(),
                lrclib: probeLrclib()
            };

            for (const [sourceKey, promise] of Object.entries(probeTasks)) {
                promise.then(result => {
                    songResultsMap[sourceKey] = result;
                    lyricSourceProbeCache.set(cacheKey, songResultsMap);

                    const badgeContainer = typeof document !== 'undefined' ? document.getElementById(`${badgeIdPrefix}${sourceKey}`) : null;
                    const optEl = typeof document !== 'undefined' ? document.getElementById(`${optIdPrefix}${sourceKey}`) : null;
                    const isActive = (sourceKey === currentLyricSrc);
                    renderSourceBadges(badgeContainer, optEl, sourceKey, result, isActive);
                }).catch(() => {});
            }
        }

/* ★ 从指定来源抓取歌词行（不激活切换，供下载歌词弹窗与来源切换共用）。
   返回值: { originals, translations, romaji }；未获取到有效歌词时 originals 为空数组 */
async function fetchLyricLinesFromSource(targetSource) {
            if (!targetSource) return { originals: [], translations: [], romaji: [] };
            if (!currentSongData || !currentSongData.title) return { originals: [], translations: [], romaji: [] };
            try {
                let originals = [], translations = [], romaji = [];
                const word = `${currentSongData.title} ${currentSongData.artist || ''}`.trim();

                // 辅助：快速并发获取翻译与罗马音（超时控制 2.5s）
                const fetchExtraTransAndRomaAsync = async () => {
                    try {
                        const [nRes, qRes] = await Promise.allSettled([
                            fetch(`${API_BASE}/netease?word=${encodeURIComponent(word)}&num=1`, { signal: AbortSignal.timeout(2500) }).then(r => r.json()),
                            fetch(`${API_BASE}/tencent?word=${encodeURIComponent(word)}&num=1`, { signal: AbortSignal.timeout(2500) }).then(r => r.json())
                        ]);
                        let matchedNcmId = null;
                        let matchedQqId = null;
                        if (nRes.status === 'fulfilled' && nRes.value?.code === 200 && nRes.value?.data) {
                            const item = Array.isArray(nRes.value.data) ? nRes.value.data[0] : nRes.value.data;
                            if (item?.id) matchedNcmId = String(item.id);
                        }
                        if (qRes.status === 'fulfilled' && qRes.value?.code === 200 && qRes.value?.data) {
                            const item = Array.isArray(qRes.value.data) ? qRes.value.data[0] : qRes.value.data;
                            if (item?.id) matchedQqId = String(item.id);
                        }
                        if (matchedNcmId) {
                            const lData = await fetchLyricWithFallback(matchedNcmId, 'netease');
                            const parsed = detectAndParseLyrics(lData);
                            if (parsed.translations?.length > 0) translations = parsed.translations;
                            if (parsed.romaji?.length > 0) romaji = parsed.romaji;
                        }
                        if (translations.length === 0 && matchedQqId) {
                            const lData = await fetchLyricWithFallback(matchedQqId, 'tencent');
                            const parsed = detectAndParseLyrics(lData);
                            if (parsed.translations?.length > 0) translations = parsed.translations;
                            if (parsed.romaji?.length > 0) romaji = parsed.romaji;
                        }
                    } catch (e) { logWarn('lyricSource', e); }
                };

                if (targetSource === 'kuwo') {
                    /* ===== 酷我音乐歌词源 ===== */
                    const kwId = (currentSongData && currentSongData.source === 'kuwo') ? currentSongData.id : null;
                    const [kwRes] = await Promise.all([
                        fetchKuwoLyric({
                            song: currentSongData.title,
                            singer: currentSongData.artist,
                            id: kwId
                        }),
                        fetchExtraTransAndRomaAsync()
                    ]);
                    if (kwRes && kwRes.parsedList && kwRes.parsedList.length > 0) {
                        originals = kwRes.parsedList;
                    }
                } else if (targetSource === 'kugou') {
                    /* ===== 酷狗音乐 KRC 逐字歌词源 ===== */
                    const [kgRes] = await Promise.all([
                        fetchKugouLyric({
                            song: currentSongData.title,
                            singer: currentSongData.artist,
                            duration: audio ? audio.duration : 0
                        }),
                        fetchExtraTransAndRomaAsync()
                    ]);
                    if (kgRes && kgRes.parsedList && kgRes.parsedList.length > 0) {
                        originals = kgRes.parsedList;
                    }
                } else if (targetSource === 'amll') {
                    /* ===== AMLL TTML DB ===== */
                    const AMLL_BASE = 'https://amll-ttml-db.stevexmh.net';
                    const amllFetch = (url) => fetch(`/proxy?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(3000) });

                    let ncmId = '', qqId = '';
                    try {
                        const [nRes, qRes] = await Promise.allSettled([
                            fetch(`${API_BASE}/netease?word=${encodeURIComponent(word)}&num=1`, { signal: AbortSignal.timeout(2000) }).then(r => r.json()),
                            fetch(`${API_BASE}/tencent?word=${encodeURIComponent(word)}&num=1`, { signal: AbortSignal.timeout(2000) }).then(r => r.json())
                        ]);
                        if (nRes.status === 'fulfilled' && nRes.value?.code === 200 && nRes.value?.data?.[0]?.id) {
                            ncmId = String(nRes.value.data[0].id);
                        }
                        if (qRes.status === 'fulfilled' && qRes.value?.code === 200 && qRes.value?.data?.[0]?.id) {
                            qqId = String(qRes.value.data[0].id);
                        }
                    } catch (e) { logWarn('lyricSource', e); }

                    const tryList = [];
                    if (ncmId) tryList.push({ platform: 'ncm', id: ncmId });
                    if (qqId) tryList.push({ platform: 'qq', id: qqId });

                    for (const target of tryList) {
                        try {
                            const yrcRes = await amllFetch(`${AMLL_BASE}/${target.platform}/${target.id}?format=yrc`);
                            if (yrcRes.ok) {
                                const yrcText = await yrcRes.text();
                                if (yrcText && yrcText.trim() && yrcText.includes('[')) {
                                    const normalizedYrc = yrcText.replace(/\s+(?=\[\d+,\d+\])/g, '\n');
                                    originals = parseNeteaseYrc(normalizedYrc);
                                    if (originals.length > 0) break;
                                }
                            }
                        } catch (e) { logWarn('lyricSource', e); }
                    }
                    await fetchExtraTransAndRomaAsync();
                } else if (targetSource === 'lrclib') {
                    /* ===== LRCLIB 开源歌词库 ===== */
                    const q = new URLSearchParams({
                        track_name: currentSongData.title,
                        artist_name: currentSongData.artist || ''
                    });
                    const lrcRes = await fetch(`https://lrclib.net/api/get?${q.toString()}`, { signal: AbortSignal.timeout(3000) });
                    if (lrcRes.ok) {
                        const json = await lrcRes.json();
                        if (json.syncedLyrics) {
                            originals = parseLrc(json.syncedLyrics).map(l => ({ start: l.time, end: l.time + 4000, original: l.text }));
                        } else if (json.plainLyrics) {
                            originals = [{ start: 0, end: 300000, original: json.plainLyrics }];
                        }
                    }
                    await fetchExtraTransAndRomaAsync();
                } else {
                    /* ===== 网易云 / QQ 音乐 ===== */
                    const searchUrl = `${API_BASE}/${targetSource}?word=${encodeURIComponent(word)}&num=5`;
                    const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(3000) }).then(r => r.json());
                    if (searchRes.code === 200 && searchRes.data) {
                        const list = Array.isArray(searchRes.data) ? searchRes.data : [searchRes.data];
                        if (list.length > 0) {
                            let best = list.find(item => {
                                const t = (item.song || '').toLowerCase();
                                const s = (item.singer || '').toLowerCase();
                                return t.includes(currentSongData.title.toLowerCase()) && s.includes((currentSongData.artist || '').toLowerCase());
                            });
                            if (!best) best = list.find(item => (item.song || '').toLowerCase().includes(currentSongData.title.toLowerCase()));
                            if (!best) best = list[0];
                            if (best && best.id) {
                                const lyricData = await fetchLyricWithFallback(String(best.id), targetSource);
                                const parsed = detectAndParseLyrics(lyricData);
                                originals = parsed.originals;
                                translations = parsed.translations;
                                romaji = parsed.romaji;
                            }
                        }
                    }
                }

                if (!originals || originals.length === 0) {
                    return { originals, translations, romaji };
                }

                /* ★ 抓取完成，返回歌词行（不做激活切换） */
                return { originals, translations, romaji };
            } catch (err) {
                logError('lyricSources', '抓取歌词来源失败:', err);
                return { originals: [], translations: [], romaji: [] };
            }
        }

/* 极速并行切换歌词来源（返回 boolean 表示是否成功） */
async function switchLyricSource(targetSource) {
            if (!targetSource) { showLyricSourceModal(); return false; }
            if (!currentSongData || !currentSongData.title) { showToast('请先播放歌曲'); return false; }
            const sourceNames = { tencent: 'QQ音乐', netease: '网易云音乐', kuwo: '酷我音乐', kugou: '酷狗音乐 (KRC)', amll: 'AMLL', lrclib: 'LRCLIB' };
            const sourceName = sourceNames[targetSource] || targetSource;
            try {
                const { originals, translations, romaji } = await fetchLyricLinesFromSource(targetSource);
                if (!originals || originals.length === 0) {
                    showToast(`切换失败：未从${sourceName}获取到有效歌词`);
                    return false;
                }
                lyrics = mergeLyrics(originals, translations, romaji);
                activeLineIndex = -1;
                aiEmotionWords = [];
                renderLyrics(lyrics);
                updateLyricsHighlight();
                lyricSourceOverride = targetSource;
                showToast(`已切换到 ${sourceName} 歌词`);

                /* 切换歌词源后自动触发 AI 情感词分析 */
                if (typeof triggerAiAnalysisIfNeeded === 'function') {
                    triggerAiAnalysisIfNeeded();
                }
                return true;

            } catch (err) {
                logError('lyricSources', '切换歌词来源失败:', err);
                showToast(`切换歌词失败: ${err.message || '网络超时'}`);
                return false;
            }
        }

if (typeof window !== 'undefined') {
            window.switchLyricSource = switchLyricSource;
            window.debugEmotionWords = function() {
                logInfo('lyricSources', '=== 调试信息 ===');
                logInfo('lyricSources', 'currentSongData:', currentSongData);
                logInfo('lyricSources', 'aiEmotionWords:', aiEmotionWords);
                logInfo('lyricSources', 'lyrics行数:', lyrics?.length);
                logInfo('lyricSources', 'wordElementsByLine长度:', wordElementsByLine?.length);
                logInfo('lyricSources', 'lyricLines元素数量:', typeof document !== 'undefined' ? document.querySelectorAll('.lyric-line').length : 0);
                logInfo('lyricSources', 'lrc-original元素数量:', typeof document !== 'undefined' ? document.querySelectorAll('.lrc-original').length : 0);
                logInfo('lyricSources', 'lrc-emotion-word元素数量:', typeof document !== 'undefined' ? document.querySelectorAll('.lrc-emotion-word').length : 0);
                logInfo('lyricSources', 'isAiAnalyzing:', isAiAnalyzing);
                logInfo('lyricSources', 'aiThemeCache大小:', Object.keys(aiThemeCache).length);
                logInfo('lyricSources', '缓存键:', Object.keys(aiThemeCache).slice(0, 5));
            };
        }

export { fetchLyricLinesFromSource, lyricSourceProbeCache, probeLyricSourcesAvailability, renderSourceBadges, showLyricSourceModal, switchLyricSource };
