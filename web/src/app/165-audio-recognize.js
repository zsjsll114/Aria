/* ============================================================
 * 165-audio-recognize.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 6314-6914 行 | 单元数: 57
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { API_BASE } from '../config/constants.js';
import { getBlurBgLayers } from '../infrastructure/dom.js';
import { searchKugouSongs } from '../services/musicApi.js';
import { audio } from './20-lyrics-render.js';
import { playIcon, sourceBtns } from './30-dom-refs.js';
import { PLAY_ICON_PATH } from './65-playback-position.js';
import { closeSearch } from './120-search-results.js';
import { fadeOutVolume } from '../core/fadeController.js';
import { calculateSongMatchScore, showToast } from './155-random-toast-match.js';
import { detectScript, getIsrcCache, loadIsrcCacheFromBackend, localizeRecognizedName, rememberIsrcCache } from './160-text-normalize.js';
import { loadOnlineSong } from './175-track-index-online.js';
import { logInfo, logWarn, logError } from '../services/log.js';
import { esc } from '../utils/formatters.js';

loadIsrcCacheFromBackend();

/* ===== 本地化辅助结束 ===== */
const audioRecognizeOverlay = typeof document !== 'undefined' ? document.getElementById('audioRecognizeOverlay') : null;

const openAudioRecognizeBtn = typeof document !== 'undefined' ? document.getElementById('openAudioRecognizeBtn') : null;

const audioRecognizeCloseBtn = typeof document !== 'undefined' ? document.getElementById('audioRecognizeCloseBtn') : null;

const recTabMic = typeof document !== 'undefined' ? document.getElementById('recTabMic') : null;

const recTabFile = typeof document !== 'undefined' ? document.getElementById('recTabFile') : null;

const recMicSection = typeof document !== 'undefined' ? document.getElementById('recMicSection') : null;

const recFileSection = typeof document !== 'undefined' ? document.getElementById('recFileSection') : null;

const recToggleBtn = typeof document !== 'undefined' ? document.getElementById('recToggleBtn') : null;

const recMicIcon = typeof document !== 'undefined' ? document.getElementById('recMicIcon') : null;

const recStopIcon = typeof document !== 'undefined' ? document.getElementById('recStopIcon') : null;

const recTimerText = typeof document !== 'undefined' ? document.getElementById('recTimerText') : null;

const recInstructionText = typeof document !== 'undefined' ? document.getElementById('recInstructionText') : null;

const recSpectrumCanvas = typeof document !== 'undefined' ? document.getElementById('recSpectrumCanvas') : null;

const recDropZone = typeof document !== 'undefined' ? document.getElementById('recDropZone') : null;

const recFileInput = typeof document !== 'undefined' ? document.getElementById('recFileInput') : null;

const recStatusBanner = typeof document !== 'undefined' ? document.getElementById('recStatusBanner') : null;

const recStatusMsg = typeof document !== 'undefined' ? document.getElementById('recStatusMsg') : null;

const recResultsSection = typeof document !== 'undefined' ? document.getElementById('recResultsSection') : null;

const recHeroCard = typeof document !== 'undefined' ? document.getElementById('recHeroCard') : null;

const recHeroCover = typeof document !== 'undefined' ? document.getElementById('recHeroCover') : null;

const recHeroTitle = typeof document !== 'undefined' ? document.getElementById('recHeroTitle') : null;

const recHeroArtist = typeof document !== 'undefined' ? document.getElementById('recHeroArtist') : null;

const recHeroBadge = typeof document !== 'undefined' ? document.getElementById('recHeroBadge') : null;

const recSourcesList = typeof document !== 'undefined' ? document.getElementById('recSourcesList') : null;

globalThis.recMediaRecorder = null;

globalThis.recAudioChunks = [];

globalThis.recAudioContext = null;

globalThis.recAnalyser = null;

globalThis.recMediaStream = null;

globalThis.recAnimFrameId = null;

globalThis.isRecordingAudio = false;

globalThis.recStartTime = 0;

globalThis.recTimerInterval = null;

function openAudioRecognizeModal() {
            if (audioRecognizeOverlay) {
                audioRecognizeOverlay.classList.add('visible');
                switchRecTab('mic');
                resetRecUI();
            }
        }

function closeAudioRecognizeModal() {
            if (isRecordingAudio) {
                stopAudioRecording(false);
            }
            if (audioRecognizeOverlay) {
                audioRecognizeOverlay.classList.remove('visible');
            }
        }

function switchRecTab(tab) {
            if (tab === 'mic') {
                recTabMic?.classList.add('active');
                recTabFile?.classList.remove('active');
                if (recMicSection) recMicSection.style.display = 'flex';
                if (recFileSection) recFileSection.style.display = 'none';
            } else {
                recTabFile?.classList.add('active');
                recTabMic?.classList.remove('active');
                if (recMicSection) recMicSection.style.display = 'none';
                if (recFileSection) recFileSection.style.display = 'flex';
            }
        }

function resetRecUI() {
            if (recTimerText) recTimerText.textContent = '00:00';
            if (recInstructionText) recInstructionText.textContent = '点击按钮开始录音，再次点击停止并开始识别';
            if (recStatusBanner) recStatusBanner.style.display = 'none';
            if (recResultsSection) recResultsSection.style.display = 'none';
            if (recToggleBtn) {
                recToggleBtn.classList.remove('recording');
                if (recMicIcon) recMicIcon.style.display = 'block';
                if (recStopIcon) recStopIcon.style.display = 'none';
            }
            drawEmptySpectrum();
        }

function drawEmptySpectrum() {
            if (!recSpectrumCanvas) return;
            const ctx = recSpectrumCanvas.getContext('2d');
            if (!ctx) return;
            const w = recSpectrumCanvas.width;
            const h = recSpectrumCanvas.height;
            ctx.clearRect(0, 0, w, h);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
            const barCount = 32;
            const barWidth = (w / barCount) - 4;
            for (let i = 0; i < barCount; i++) {
                const x = i * (barWidth + 4) + 2;
                const barH = 4 + Math.sin(i * 0.3) * 2;
                const y = (h - barH) / 2;
                ctx.fillRect(x, y, barWidth, barH);
            }
        }

async function toggleAudioRecording() {
            if (isRecordingAudio) {
                await stopAudioRecording(true);
            } else {
                await startAudioRecording();
            }
        }

async function startAudioRecording() {
            try {
                // 识曲前先淡出暂停正在播放的音乐，避免麦克风录入扬声器声音
                if (!audio.paused || isPlaying) {
                    await new Promise(resolve => {
                        const dur = Math.min(appSettings.playback.fadeDuration || 400, 500);
                        fadeOutVolume(dur, () => {
                            audio.pause();
                            isPlaying = false;
                            playIcon.innerHTML = PLAY_ICON_PATH;
                            getBlurBgLayers().forEach(l => l.classList.add('paused'));
                            resolve();
                        });
                    });
                }

                if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
                    recMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                } else {
                    showToast('浏览器不支持或未开启麦克风权限');
                    return;
                }

                recAudioChunks = [];
                recMediaRecorder = new MediaRecorder(recMediaStream);
                recMediaRecorder.ondataavailable = (e) => {
                    if (e.data && e.data.size > 0) {
                        recAudioChunks.push(e.data);
                    }
                };

                const AudioCtx = window.AudioContext || window.webkitAudioContext;
                recAudioContext = new AudioCtx();
                const source = recAudioContext.createMediaStreamSource(recMediaStream);
                recAnalyser = recAudioContext.createAnalyser();
                recAnalyser.fftSize = 64;
                source.connect(recAnalyser);

                recMediaRecorder.start(200);
                isRecordingAudio = true;
                recStartTime = Date.now();

                if (recToggleBtn) {
                    recToggleBtn.classList.add('recording');
                    if (recMicIcon) recMicIcon.style.display = 'none';
                    if (recStopIcon) recStopIcon.style.display = 'block';
                }
                if (recInstructionText) recInstructionText.textContent = '正在录音中... 点击停止并分析';
                if (recStatusBanner) recStatusBanner.style.display = 'none';
                if (recResultsSection) recResultsSection.style.display = 'none';

                recTimerInterval = setInterval(() => {
                    const elapsed = Math.floor((Date.now() - recStartTime) / 1000);
                    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
                    const ss = String(elapsed % 60).padStart(2, '0');
                    if (recTimerText) recTimerText.textContent = `${mm}:${ss}`;
                }, 500);

                startSpectrumVisualization();

            } catch (err) {
                logError('audioRecognize', '启动麦克风录音失败:', err);
                showToast('无法访问麦克风: ' + (err.message || '权限被拒绝'));
            }
        }

function startSpectrumVisualization() {
            if (!recSpectrumCanvas || !recAnalyser) return;
            const ctx = recSpectrumCanvas.getContext('2d');
            const dataArray = new Uint8Array(recAnalyser.frequencyBinCount);

            const render = () => {
                if (!isRecordingAudio) return;
                recAnimFrameId = requestAnimationFrame(render);
                recAnalyser.getByteFrequencyData(dataArray);

                const w = recSpectrumCanvas.width;
                const h = recSpectrumCanvas.height;
                ctx.clearRect(0, 0, w, h);

                const barCount = dataArray.length;
                const barWidth = (w / barCount) - 3;
                const themeColor = (appSettings && appSettings.interface && appSettings.interface.themeColor) || '#ffcc33';

                for (let i = 0; i < barCount; i++) {
                    const val = dataArray[i];
                    const percent = val / 255;
                    const barH = Math.max(4, percent * (h - 16));
                    const x = i * (barWidth + 3) + 2;
                    const y = (h - barH) / 2;

                    ctx.fillStyle = themeColor;
                    if (ctx.roundRect) {
                        ctx.beginPath();
                        ctx.roundRect(x, y, barWidth, barH, 3);
                        ctx.fill();
                    } else {
                        ctx.fillRect(x, y, barWidth, barH);
                    }
                }
            };
            render();
        }

async function stopAudioRecording(triggerAnalyze = true) {
            isRecordingAudio = false;
            if (recAnimFrameId) {
                cancelAnimationFrame(recAnimFrameId);
                recAnimFrameId = null;
            }
            if (recTimerInterval) {
                clearInterval(recTimerInterval);
                recTimerInterval = null;
            }

            if (recToggleBtn) {
                recToggleBtn.classList.remove('recording');
                if (recMicIcon) recMicIcon.style.display = 'block';
                if (recStopIcon) recStopIcon.style.display = 'none';
            }
            if (recInstructionText) recInstructionText.textContent = '点击按钮开始录音，再次点击停止并开始识别';

            drawEmptySpectrum();

            if (recMediaRecorder && recMediaRecorder.state !== 'inactive') {
                const stopPromise = new Promise(resolve => {
                    recMediaRecorder.onstop = resolve;
                });
                recMediaRecorder.stop();
                await stopPromise;
            }

            if (recMediaStream) {
                recMediaStream.getTracks().forEach(t => t.stop());
                recMediaStream = null;
            }
            if (recAudioContext) {
                recAudioContext.close().catch(() => { /* 预期拒绝：上下文可能已经关闭（AbortError），不是故障 */ });
                recAudioContext = null;
            }

            if (triggerAnalyze && recAudioChunks.length > 0) {
                const mimeType = recMediaRecorder?.mimeType || 'audio/webm';
                const audioBlob = new Blob(recAudioChunks, { type: mimeType });
                await sendAudioToRecognize(audioBlob, 'recorded_sample.webm');
            }
        }

async function sendAudioToRecognize(audioBlob, filename) {
            // 识曲前若正在播放音乐，先淡出暂停
            if (!audio.paused || isPlaying) {
                const dur = Math.min(appSettings.playback.fadeDuration || 400, 500);
                fadeOutVolume(dur, () => {
                    audio.pause();
                    isPlaying = false;
                    playIcon.innerHTML = PLAY_ICON_PATH;
                    getBlurBgLayers().forEach(l => l.classList.add('paused'));
                });
            }

            if (recStatusBanner) {
                recStatusBanner.style.display = 'flex';
                if (recStatusMsg) recStatusMsg.textContent = '1/3 正在提取声学指纹并在 Shazam 比对...';
            }
            if (recResultsSection) recResultsSection.style.display = 'none';

            try {
                const reader = new FileReader();
                const base64Data = await new Promise((resolve, reject) => {
                    reader.onloadend = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(audioBlob);
                });

                let resultData = null;
                // 0. 优先尝试 Tauri node sidecar 的 Shazam 识曲服务 (http://127.0.0.1:18089/recognize)
                if (!resultData) {
                    try {
                        const nodeResp = await fetch('http://127.0.0.1:18089/recognize', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ audioBase64: base64Data, filename: filename || 'sample.webm' })
                        });
                        if (nodeResp.ok) {
                            const nodeJson = await nodeResp.json();
                            if (nodeJson && nodeJson.success && (nodeJson.title || nodeJson.song)) {
                                resultData = nodeJson;
                            }
                        }
                    } catch (e) {
                        logWarn('audioRecognize', 'node sidecar /recognize 请求异常，回退 python:', e);
                    }
                }
                // 1. 尝试 /api/audio/recognize 接口
                try {
                    const resp = await fetch('/api/audio/recognize', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ audioBase64: base64Data, filename: filename || 'sample.webm' })
                    });
                    if (resp.ok) {
                        const json = await resp.json();
                        if (json && (json.data || json.title || json.song)) {
                            resultData = json.data || json;
                        }
                    }
                } catch (e) {
                    logWarn('audioRecognize', '/api/audio/recognize 请求异常，尝试回退:', e);
                }

                // 2. 若首选接口未命中或未重启服务器，使用 /api/local-music/upload 兼容回退
                if (!resultData) {
                    try {
                        const fallbackResp = await fetch('/api/local-music/upload', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ dataBase64: base64Data, filename: filename || 'sample.webm' })
                        });
                        if (fallbackResp.ok) {
                            const fallbackJson = await fallbackResp.json();
                            if (fallbackJson && fallbackJson.shazam) {
                                resultData = fallbackJson.shazam;
                            }
                        }
                    } catch (e2) {
                        logWarn('audioRecognize', '/api/local-music/upload 请求异常:', e2);
                    }
                }

                if (resultData && (resultData.title || resultData.song) && !isJunkRecognizedTitle(resultData.title || resultData.song)) {
                    const title = resultData.title || resultData.song || '未知歌曲';
                    const artist = resultData.artist || resultData.singer || '未知歌手';
                    const method = resultData.method || (resultData.shazam ? 'shazam' : 'speech-to-text');
                    const cover = resultData.cover || resultData.coverUrl || resultData.artwork || '';

                    if (recStatusMsg) recStatusMsg.textContent = `2/3 识别到《${title}》- ${artist}，正在并发检索各大曲库...`;

                    await matchSongAcross3Sources(title, artist, method, cover, {
                        isrc: resultData.isrc || '',
                        genre: resultData.genre || ''
                    });
                } else if (resultData && resultData.lyricSnippet && String(resultData.lyricSnippet).trim().length >= 4) {
                    /* ★ Shazam 未命中，但后台已用 Vosk 语音转写出了歌词片段 → 据此在线按词反查曲目 */
                    const lyricPart = String(resultData.lyricSnippet).trim();
                    if (recStatusMsg) recStatusMsg.textContent = '2/3 Shazam 未命中，正在用语音转写的歌词反查曲目…';
                    const lyricHit = await searchSongByLyricsOnline(lyricPart);
                    if (lyricHit && !isJunkRecognizedTitle(lyricHit.title)) {
                        await matchSongAcross3Sources(lyricHit.title, lyricHit.artist || '', 'vosk', lyricHit.cover || '', { isrc: '' });
                    } else {
                        if (recStatusMsg) {
                            const short = lyricPart.length > 30 ? lyricPart.slice(0, 30) + '…' : lyricPart;
                            recStatusMsg.textContent = `3/3 未能匹配到曲目（语音转写歌词：${short}），建议录制更清晰的人声片段重试`;
                        }
                    }
                } else {
                    if (recStatusBanner) {
                        if (recStatusMsg) recStatusMsg.textContent = '未能识别出曲目，建议录制更清晰或包含人声高潮的片段重试';
                    }
                }
            } catch (err) {
                logError('audioRecognize', '识曲请求失败:', err);
                if (recStatusBanner) {
                    if (recStatusMsg) recStatusMsg.textContent = '识曲失败: ' + (err.message || '网络或服务端异常');
                }
            }
        }

/* 识别结果标题是否为占位/无意义值（Shazam 偶尔返回 "song"、"unknown" 等） */
function isJunkRecognizedTitle(t) {
            const s = String(t || '').trim();
            if (!s) return true;
            if (s.length <= 1) return true;
            const low = s.toLowerCase();
            return low === 'song' || low === 'songs' || low === 'unknown' ||
                   low === 'untitled' || low === 'undefined' || low === 'null' ||
                   low === '未知' || low === '未知歌曲' || low === '未知歌手' ||
                   low === '无法识别' || low === '无';
        }

/* Shazam 未命中时，用语音转写出的歌词片段在线按词反查曲目（网易→QQ，取最像歌词前段的候选） */
async function searchSongByLyricsOnline(lyric) {
            const q = String(lyric || '').replace(/\s+/g, '').slice(0, 40);
            if (!q || q.length < 4) return null;
            const needles = [q.slice(0, 20), q.slice(0, 10)];
            const apiFeeds = [
                { url: `${API_BASE}/netease?word=${encodeURIComponent(q)}&num=6`, key: 'data' },
                { url: `${API_BASE}/tencent?word=${encodeURIComponent(q)}&num=6`, key: 'data' }
            ];
            for (const feed of apiFeeds) {
                try {
                    const r = await fetch(feed.url).then(res => res.json()).catch(() => null);
                    if (!r || r.code !== 200 || !r.data) continue;
                    const list = Array.isArray(r.data) ? r.data : [r.data];
                    if (!list.length) continue;
                    /* 候选：标题/歌手与歌词前段重叠越多越可信；无重叠也保留第一个作最坏兜底 */
                    let best = list[0], bestScore = -1;
                    for (const it of list) {
                        const titleStr = String(it.song || '') + String(it.singer || '');
                        let score = 0;
                        for (const needle of needles) {
                            if (needle && titleStr.indexOf(needle) !== -1) score += needle.length;
                        }
                        if (score > bestScore) { bestScore = score; best = it; }
                    }
                    return { title: best.song, artist: best.singer || '', cover: best.cover || '', score: bestScore };
                } catch (e) { /* 忽略单个源失败 */ }
            }
            return null;
        }

async function matchSongAcross3Sources(title, artist, method, recognizedCover, recMeta) {
            try {
                const isrc = (recMeta && recMeta.isrc) || '';
                let localHint = '';
                // ① 先查本地 isrc 缓存，命中即用本地化原名（全离线、秒出）
                const cacheHit = isrc && getIsrcCache()[isrc];
                if (cacheHit && cacheHit.title) {
                    title = cacheHit.title;
                    artist = cacheHit.artist || artist;
                    localHint = '本地缓存';
                } else {
                    // ② 未命中则用 Shazam 英文名去对应语言 storefront 查本地化原名（简体 cn 优先）
                    const loc = await localizeRecognizedName(title, artist, isrc);
                    if (loc && loc.name) {
                        if (loc.artistName) artist = loc.artistName;
                        title = loc.name;
                        const langLabel = ({ zh: '简体', jp: '日文', kr: '韩文' })[detectScript(loc.name)] || '译文';
                        localHint = '已本地化·' + langLabel;
                    }
                }
                const query = `${title} ${artist}`.trim();

                const [qqRes, neteaseRes, kugouRes] = await Promise.allSettled([
                    fetch(`${API_BASE}/tencent?word=${encodeURIComponent(query)}&num=3`).then(r => r.json()),
                    fetch(`${API_BASE}/netease?word=${encodeURIComponent(query)}&num=3`).then(r => r.json()),
                    searchKugouSongs(query).catch(() => null)
                ]);

                const matches = [];

                // 1. QQ 音乐结果
                if (qqRes.status === 'fulfilled' && qqRes.value?.code === 200 && qqRes.value?.data) {
                    const list = Array.isArray(qqRes.value.data) ? qqRes.value.data : [qqRes.value.data];
                    if (list.length > 0) {
                        const item = list[0];
                        const score = calculateSongMatchScore(title, artist, item.song, item.singer);
                        matches.push({
                            platform: 'tencent',
                            platformName: 'QQ音乐',
                            platformClass: 'rec-platform-tencent',
                            title: item.song,
                            artist: item.singer,
                            id: item.id,
                            mid: item.mid || '',
                            cover: item.cover || recognizedCover,
                            score: score
                        });
                    }
                }

                // 2. 网易云结果
                if (neteaseRes.status === 'fulfilled' && neteaseRes.value?.code === 200 && neteaseRes.value?.data) {
                    const list = Array.isArray(neteaseRes.value.data) ? neteaseRes.value.data : [neteaseRes.value.data];
                    if (list.length > 0) {
                        const item = list[0];
                        const score = calculateSongMatchScore(title, artist, item.song, item.singer);
                        matches.push({
                            platform: 'netease',
                            platformName: '网易云',
                            platformClass: 'rec-platform-netease',
                            title: item.song,
                            artist: item.singer,
                            id: item.id,
                            mid: '',
                            cover: item.cover || recognizedCover,
                            score: score
                        });
                    }
                }

                // 3. 酷狗结果
                if (kugouRes.status === 'fulfilled' && kugouRes.value?.success && kugouRes.value?.list?.length > 0) {
                    const kgItem = kugouRes.value.list[0];
                    const score = calculateSongMatchScore(title, artist, kgItem.song, kgItem.singer);
                    matches.push({
                        platform: 'kugou',
                        platformName: '酷狗音乐',
                        platformClass: 'rec-platform-kugou',
                        title: kgItem.song,
                        artist: kgItem.singer,
                        id: kgItem.id || kgItem.hash || '',
                        hash: kgItem.hash || '',
                        cover: kgItem.cover || recognizedCover,
                        score: score
                    });
                }

                if (recHeroTitle) recHeroTitle.textContent = title;
                if (recHeroArtist) recHeroArtist.textContent = artist;
                if (recHeroBadge) {
                    const methodLabel = (method === 'shazam' || method === 'shazam-node') ? 'Shazam 声学指纹' : (method === 'vosk' ? 'Vosk 歌词反查' : 'ID3 元数据识别');
                    recHeroBadge.textContent = localHint ? `${methodLabel} · ${localHint}` : methodLabel;
                }
                if (recHeroCover) {
                    const firstCover = recognizedCover || (matches[0] && matches[0].cover) || '';
                    if (firstCover) {
                        recHeroCover.src = firstCover;
                        recHeroCover.style.display = 'block';
                    } else {
                        recHeroCover.style.display = 'none';
                    }
                }

                if (recSourcesList) {
                    if (matches.length === 0) {
                        recSourcesList.innerHTML = '<div style="text-align:center;padding:12px;color:rgba(255,255,255,0.5);font-size:12px;">已识别歌曲，但三大曲库暂时未匹配到可播放直链</div>';
                    } else {
                        recSourcesList.innerHTML = matches.map((m, idx) => `
                            <div class="rec-source-card">
                                <div class="rec-src-left">
                                    <span class="rec-src-platform ${m.platformClass}">${esc(m.platformName)}</span>
                                    <div class="rec-src-meta">
                                        <div class="rec-src-title" title="${esc(m.title)}">${esc(m.title)}</div>
                                        <div class="rec-src-sub">
                                            <span>${esc(m.artist)}</span>
                                            <span class="rec-match-score">${m.score}% 匹配</span>
                                        </div>
                                    </div>
                                </div>
                                <button class="rec-play-btn" data-rec-idx="${idx}">
                                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                                    <span>播放</span>
                                </button>
                            </div>
                        `).join('');

                        recSourcesList.querySelectorAll('.rec-play-btn').forEach(btn => {
                            btn.addEventListener('click', (e) => {
                                const idx = parseInt(btn.dataset.recIdx);
                                const matchItem = matches[idx];
                                if (!matchItem) return;
                                closeAudioRecognizeModal();
                                closeSearch();
                                currentSource = matchItem.platform;
                                sourceBtns.forEach(b => b.classList.toggle('active', b.dataset.source === currentSource));
                                const songInfo = {
                                    id: String(matchItem.id || ''),
                                    mid: matchItem.mid || '',
                                    hash: matchItem.hash || '',
                                    song: matchItem.title,
                                    singer: matchItem.artist,
                                    cover: matchItem.cover || '',
                                    url: matchItem.url || ''
                                };
                                if (isrc) rememberIsrcCache(isrc, {
                                    title: matchItem.title,
                                    artist: matchItem.artist,
                                    platform: matchItem.platform,
                                    id: matchItem.id,
                                    mid: matchItem.mid || '',
                                    hash: matchItem.hash || '',
                                    cover: matchItem.cover || '',
                                    confirmed: true
                                });
                                loadOnlineSong(songInfo);
                            });
                        });
                    }
                }

                if (recStatusBanner) recStatusBanner.style.display = 'none';
                if (recResultsSection) recResultsSection.style.display = 'flex';
            } catch (err) {
                logError('audioRecognize', '三大音源匹配失败:', err);
                if (recStatusBanner) {
                    recStatusBanner.style.display = 'flex';
                    if (recStatusMsg) recStatusMsg.textContent = '曲库比对失败: ' + (err.message || '网络异常');
                }
            }
        }

// 绑定听歌识曲界面事件
openAudioRecognizeBtn?.addEventListener('click', openAudioRecognizeModal);

audioRecognizeCloseBtn?.addEventListener('click', closeAudioRecognizeModal);

recTabMic?.addEventListener('click', () => switchRecTab('mic'));

recTabFile?.addEventListener('click', () => switchRecTab('file'));

recToggleBtn?.addEventListener('click', toggleAudioRecording);

recDropZone?.addEventListener('click', () => recFileInput?.click());

recFileInput?.addEventListener('change', async (e) => {
            if (e.target.files && e.target.files[0]) {
                const file = e.target.files[0];
                await sendAudioToRecognize(file, file.name);
            }
        });

recDropZone?.addEventListener('dragover', (e) => {
            e.preventDefault();
            recDropZone.classList.add('dragover');
        });

recDropZone?.addEventListener('dragleave', () => {
            recDropZone.classList.remove('dragover');
        });

recDropZone?.addEventListener('drop', async (e) => {
            e.preventDefault();
            recDropZone.classList.remove('dragover');
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
                const file = e.dataTransfer.files[0];
                await sendAudioToRecognize(file, file.name);
            }
        });

export { audioRecognizeCloseBtn, audioRecognizeOverlay, closeAudioRecognizeModal, drawEmptySpectrum, isJunkRecognizedTitle, matchSongAcross3Sources, openAudioRecognizeBtn, openAudioRecognizeModal, recDropZone, recFileInput, recFileSection, recHeroArtist, recHeroBadge, recHeroCard, recHeroCover, recHeroTitle, recInstructionText, recMicIcon, recMicSection, recResultsSection, recSourcesList, recSpectrumCanvas, recStatusBanner, recStatusMsg, recStopIcon, recTabFile, recTabMic, recTimerText, recToggleBtn, resetRecUI, searchSongByLyricsOnline, sendAudioToRecognize, startAudioRecording, startSpectrumVisualization, stopAudioRecording, switchRecTab, toggleAudioRecording };
