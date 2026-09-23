/* ============================================================
 * 135-crossfade.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 4695-5021 行 | 单元数: 9
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { API_BASE } from '../config/constants.js';
import { searchKugouSongs } from '../services/musicApi.js';
import { volumePercentToGain } from '../utils/volumeCurve.js';
import { audio } from './20-lyrics-render.js';
import { currentTimeEl, favoritesOverlay, progressEl, searchOverlay, songArtistEl, songTitleEl, sourceBtns, totalTimeEl, volumeBar } from './30-dom-refs.js';
import { getLyricOffset, updateLineTimes, updateLyricOffsetUI } from './40-playback-state.js';
import { waitForAudioReady } from './65-playback-position.js';
import { handleAudioPlayError } from './70-audio-engine.js';
import { applyPreservesPitch } from './85-rate-download.js';
import { setBlurBackground, setCoverImage } from './100-cover-background.js';
import { makeSongKey, setHint, updateFavoriteBtn } from './120-search-results.js';
import { dayRecommend } from './selfhost-runtime.js';
import { addToPlaylistOverlay, playlistsOverlay, renderAddToPlaylistList, renderPlaylistsView } from './130-playlists.js';
import { loadOnlineSong } from './175-track-index-online.js';
import { getStreamCachedAudioUrl } from './180-boot-config.js';
import { logInfo, logWarn, logError } from '../services/log.js';

globalThis.lastLoadedSongInfo = null;

function fadeOutVolume(duration, callback) {
            /* 取消之前的淡出动画 */
            if (fadeOutVolumeRafId) {
                cancelAnimationFrame(fadeOutVolumeRafId);
                fadeOutVolumeRafId = null;
            }
            /* 取消正在进行的淡入动画，避免两者竞争 */
            if (fadeInVolumeRafId) {
                cancelAnimationFrame(fadeInVolumeRafId);
                fadeInVolumeRafId = null;
            }
            if (fadeOutVolumeTimeoutId) { clearTimeout(fadeOutVolumeTimeoutId); fadeOutVolumeTimeoutId = null; }
            if (!appSettings.playback.fadeInOut) { if (callback) callback(); return; }
            const startVol = audio.volume;
            const startTime = performance.now();
            function step(now) {
                const t = Math.min(1, (now - startTime) / duration);
                audio.volume = Math.max(0, Math.min(1, startVol * (1 - t)));
                if (t < 1) {
                    fadeOutVolumeRafId = requestAnimationFrame(step);
                } else {
                    fadeOutVolumeRafId = null;
                    if (fadeOutVolumeTimeoutId) { clearTimeout(fadeOutVolumeTimeoutId); fadeOutVolumeTimeoutId = null; }
                    if (callback) callback();
                }
            }
            fadeOutVolumeRafId = requestAnimationFrame(step);
            /* setTimeout 兜底：确保即使 RAF 未触发，回调也能执行 */
            fadeOutVolumeTimeoutId = setTimeout(() => {
                fadeOutVolumeTimeoutId = null;
                if (fadeOutVolumeRafId) {
                    cancelAnimationFrame(fadeOutVolumeRafId);
                    fadeOutVolumeRafId = null;
                    audio.volume = 0;
                    if (callback) callback();
                }
            }, duration + 100);
        }

function fadeInVolume(targetVol, duration) {
            /* 取消之前的淡入动画 */
            if (fadeInVolumeRafId) {
                cancelAnimationFrame(fadeInVolumeRafId);
                fadeInVolumeRafId = null;
            }
            /* 取消正在进行的淡出动画，避免竞争导致音量卡在 0 */
            if (fadeOutVolumeRafId) {
                cancelAnimationFrame(fadeOutVolumeRafId);
                fadeOutVolumeRafId = null;
            }
            if (fadeOutVolumeTimeoutId) { clearTimeout(fadeOutVolumeTimeoutId); fadeOutVolumeTimeoutId = null; }
            if (fadeInVolumeTimeoutId) { clearTimeout(fadeInVolumeTimeoutId); fadeInVolumeTimeoutId = null; }
            if (!appSettings.playback.fadeInOut || !duration || duration <= 0) {
                audio.volume = Math.max(0, Math.min(1, targetVol));
                return;
            }
            /* 采用平滑正弦曲线并限制淡入上限，避免人耳对低音量的对数不敏感导致前1~3秒听不到声音 */
            const effectiveDuration = Math.min(duration, 1000);
            const startVol = Math.min(audio.volume, targetVol * 0.35);
            const startTime = performance.now();
            function step(now) {
                const linearT = Math.min(1, (now - startTime) / effectiveDuration);
                const easeT = Math.sin(linearT * Math.PI / 2);
                audio.volume = Math.max(0, Math.min(1, startVol + (targetVol - startVol) * easeT));
                if (linearT < 1) {
                    fadeInVolumeRafId = requestAnimationFrame(step);
                } else {
                    audio.volume = Math.max(0, Math.min(1, targetVol));
                    fadeInVolumeRafId = null;
                    if (fadeInVolumeTimeoutId) { clearTimeout(fadeInVolumeTimeoutId); fadeInVolumeTimeoutId = null; }
                }
            }
            fadeInVolumeRafId = requestAnimationFrame(step);
            /* setTimeout 兜底：确保即使 RAF 未触发（如标签页后台），音量也能恢复到目标值 */
            fadeInVolumeTimeoutId = setTimeout(() => {
                fadeInVolumeTimeoutId = null;
                if (fadeInVolumeRafId) {
                    cancelAnimationFrame(fadeInVolumeRafId);
                    fadeInVolumeRafId = null;
                    audio.volume = Math.max(0, Math.min(1, targetVol));
                }
            }, effectiveDuration + 50);
        }

/* 切歌时应用音量处理：音量标准化 + 淡入（淡入目标为对数曲线后的声压值） */
function applyVolumeOnSongChange() {
            let targetVol;
            if (appSettings.audio.volumeNorm) {
                /* 音量标准化：重置到默认音量 */
                targetVol = volumePercentToGain(appSettings.playback.initialVolume);
                volume = appSettings.playback.initialVolume;
                if (volumeBar) volumeBar.style.width = volume + '%';
            } else {
                targetVol = volumePercentToGain(volume);
            }
            fadeInVolume(targetVol, appSettings.playback.fadeDuration);
        }

/* 播放失败时自动重试（改进版：强制重新获取URL + 指数退避 + 备用源搜索切换） */
function handlePlayFailure(songInfo, isFromPlaylist) {
            if (!appSettings.playback.retryOnFail) return false;
            if (retryCount >= appSettings.playback.retryCount) {
                retryCount = 0;
                return false;
            }
            retryCount++;
            /* 指数退避：第1次1秒，第2次2秒，第3次4秒... */
            const delay = Math.min(1000 * Math.pow(2, retryCount - 1), 8000);
            /* 捕获当前代际，防止过期重试干扰新歌 */
            const retryGen = playbackGeneration;
            logInfo('crossfade', `播放失败，${delay}ms后重试 ${retryCount}/${appSettings.playback.retryCount}`);
            setTimeout(async () => {
                /* 代际检查：如果在退避等待期间用户切了歌，取消本次重试 */
                if (retryGen !== playbackGeneration) {
                    logInfo('crossfade', '重试已取消（用户已切歌）');
                    return;
                }
                /* 关键：清除缓存的直链URL，强制重新请求API获取新链接 */
                const retrySongInfo = { ...songInfo, url: '' };
                /* 第1次重试：保持原音源，仅重新获取链接
                   第2次重试起：按用户规定的统一退回链切换备用源——
                   【当前歌曲源 → QQ → 酷狗 → 网易云 → 酷我】，歌曲源与链尾重合时只保留靠前的 */
                if (retryCount >= 2 && songInfo.id) {
                    const originalSource = currentSource;
                    const FALLBACK_TAIL = ['tencent', 'kugou', 'netease', 'kuwo'];
                    const chain = FALLBACK_TAIL.includes(originalSource)
                        ? [originalSource, ...FALLBACK_TAIL.filter(s => s !== originalSource)]
                        : [originalSource, ...FALLBACK_TAIL];
                    const step = retryCount - 2;
                    const targetSource = chain[Math.min(step, chain.length - 1)];
                    if (targetSource && targetSource !== originalSource) {
                        const sourceNames = { tencent: 'QQ音乐', kuwo: '酷我音乐', kugou: '酷狗', netease: '网易云' };
                        const sourceName = sourceNames[targetSource] || targetSource;
                        logInfo('crossfade', `切换到${sourceName}备用源，搜索: ${songInfo.song} - ${songInfo.singer}`);
                        try {
                            if (targetSource === 'kuwo') {
                                /* 酷我：使用 fetchKuwoSearch 搜索同名歌曲 */
                                const { fetchKuwoSearch } = await import('../services/musicApi.js');
                                const kwList = await fetchKuwoSearch(`${songInfo.song || ''} ${songInfo.singer || ''}`.trim(), 5, 1);
                                if (kwList && kwList.length > 0) {
                                    const kw = (songInfo.song || '').toLowerCase();
                                    let best = kwList.find(item => (item.song || '').toLowerCase().includes(kw) && (item.singer || '').toLowerCase().includes((songInfo.singer || '').toLowerCase()));
                                    if (!best) best = kwList.find(item => (item.song || '').toLowerCase().includes(kw));
                                    if (!best) best = kwList[0];
                                    if (best && best.id) {
                                        retrySongInfo.id = String(best.id);
                                        retrySongInfo.mid = '';
                                        retrySongInfo.hash = '';
                                        retrySongInfo.source = 'kuwo';
                                        retrySongInfo.cover = best.cover || retrySongInfo.cover;
                                        currentSource = 'kuwo';
                                        sourceBtns.forEach(b => b.classList.toggle('active', b.dataset.source === currentSource));
                                        logInfo('crossfade', `酷我备用源搜索成功: ${best.song} - ${best.singer} (id=${retrySongInfo.id})`);
                                    }
                                }
                            } else if (targetSource === 'kugou') {
                                /* 酷狗：使用专用搜索接口（以 hash 为播放标识） */
                                const kgRes = await searchKugouSongs(`${songInfo.song || ''} ${songInfo.singer || ''}`.trim());
                                if (kgRes && kgRes.success && kgRes.list && kgRes.list.length > 0) {
                                    const kw = (songInfo.song || '').toLowerCase();
                                    let best = kgRes.list.find(item => (item.song || '').toLowerCase().includes(kw) && (item.singer || '').toLowerCase().includes((songInfo.singer || '').toLowerCase()));
                                    if (!best) best = kgRes.list.find(item => (item.song || '').toLowerCase().includes(kw));
                                    if (!best) best = kgRes.list[0];
                                    if (best && best.hash) {
                                        retrySongInfo.id = String(best.hash);
                                        retrySongInfo.mid = '';
                                        retrySongInfo.hash = String(best.hash);
                                        retrySongInfo.cover = best.cover || retrySongInfo.cover;
                                        retrySongInfo.source = 'kugou';
                                        currentSource = 'kugou';
                                        sourceBtns.forEach(b => b.classList.toggle('active', b.dataset.source === currentSource));
                                        logInfo('crossfade', `酷狗备用源搜索成功: ${best.song} - ${best.singer} (hash=${retrySongInfo.id})`);
                                    } else {
                                        logWarn('crossfade', '酷狗备用源搜索无结果');
                                    }
                                } else {
                                    logWarn('crossfade', '酷狗备用源搜索无结果');
                                }
                            } else {
                                const searchUrl = `${API_BASE}/${targetSource}?word=${encodeURIComponent(songInfo.song + ' ' + songInfo.singer)}&num=5`;
                                /* 8秒超时：vkeys 挂起时避免重试流程无限等待 */
                                const bsCtl = new AbortController();
                                const bsTimer = setTimeout(() => bsCtl.abort(), 8000);
                                const searchRes = await fetch(searchUrl, { signal: bsCtl.signal }).then(r => r.json()).catch(() => ({}));
                                clearTimeout(bsTimer);
                                if (searchRes.code === 200 && searchRes.data) {
                                    const list = Array.isArray(searchRes.data) ? searchRes.data : [searchRes.data];
                                    /* 精确匹配优先 */
                                    let best = list.find(item => {
                                        const t = (item.song || '').toLowerCase();
                                        const s = (item.singer || '').toLowerCase();
                                        return t.includes(songInfo.song.toLowerCase()) && s.includes(songInfo.singer.toLowerCase());
                                    });
                                    if (!best) best = list.find(item => (item.song || '').toLowerCase().includes(songInfo.song.toLowerCase()));
                                    if (!best) best = list[0];
                                    if (best) {
                                        retrySongInfo.id = String(best.id || '');
                                        retrySongInfo.mid = best.mid || '';
                                        /* 清除可能残留的酷狗 hash，并同步 source 字段
                                           （loadOnlineSong 依据 source===kugou 走酷狗分支，残留会导致错误路由） */
                                        retrySongInfo.hash = '';
                                        retrySongInfo.source = targetSource;
                                        retrySongInfo.cover = best.cover || retrySongInfo.cover;
                                        currentSource = targetSource;
                                        sourceBtns.forEach(b => b.classList.toggle('active', b.dataset.source === currentSource));
                                        logInfo('crossfade', `备用源搜索成功: ${best.song} - ${best.singer} (id=${retrySongInfo.id}, mid=${retrySongInfo.mid})`);
                                    } else {
                                        logWarn('crossfade', '备用源搜索无结果');
                                    }
                                }
                            }
                        } catch (searchErr) {
                            logWarn('crossfade', '备用源搜索失败:', searchErr);
                        }
                    }
                }
                loadOnlineSong(retrySongInfo, isFromPlaylist, true);
            }, delay);
            return true;
        }

/* 加载播放队列中的指定曲目 */
async function loadPlaylistTrack(index, preloadOnly) {
            if (index < 0 || index >= playlist.length) return;
            currentTrackIndex = index;
            retryCount = 0;  /* 切歌时重置重试计数器，避免上一首歌的重试状态影响新歌曲 */
            const track = playlist[index];
            if ((track.source || track.id) && (track.id || track.mid)) {
                /* source 为空时根据 mid 推断：有 mid 的是 QQ 音乐，没有的是网易云 */
                const effectiveSource = track.source || (track.mid ? 'tencent' : 'netease');
                const songInfo = { id: track.id, mid: track.mid || '', song: track.title || track.song || track.name, singer: track.artist || track.singer, cover: track.cover, url: track.url || '', source: effectiveSource };
                currentSource = effectiveSource;
                sourceBtns.forEach(b => b.classList.toggle('active', b.dataset.source === effectiveSource));
                /* ★ 预加载集成：如果预加载数据匹配当前歌曲，传递预加载的 URL 和歌词 */
                _preloadedLyricData = null;  /* 先清除，避免残留 */
                if (nextSongPreload && nextSongPreload.key === `${effectiveSource}:${track.id}`) {
                    if (nextSongPreload.url) {
                        songInfo.url = nextSongPreload.url;  /* 使用预加载的 URL，跳过网络请求 */
                        logInfo('crossfade', '[Preload] 命中预加载，使用缓存URL:', track.title);
                    }
                    if (nextSongPreload.lyricData) {
                        _preloadedLyricData = nextSongPreload.lyricData;  /* 传递预加载的歌词 */
                        logInfo('crossfade', '[Preload] 命中预加载，使用缓存歌词:', track.title);
                    }
                }
                await loadOnlineSong(songInfo, true, false, preloadOnly);
            } else if (track.url) {
                /* 代际计数器递增，使上一次的异步回调过期 */
                const gen = ++playbackGeneration;
                /* 立即暂停，取消上一次的加载 */
                audio.pause();

                /* ★ 即时 UI 响应：标题、歌手、封面、背景立即切换，不等淡出 */
                songTitleEl.textContent = track.title || track.song || track.name;
                songArtistEl.textContent = track.artist || track.singer || '未知歌手';
                currentSongData = { title: track.title || track.song || track.name, artist: track.artist || track.singer || '未知歌手', cover: track.cover || '', source: 'local', url: track.url };
                /* ★ 最近播放：本地直链歌曲也记录 */
                if (typeof window.recordRecentPlay === 'function') window.recordRecentPlay(currentSongData);
                currentSongKey = makeSongKey(currentSongData);
                lyricOffset = getLyricOffset(currentSongKey); updateLyricOffsetUI();
                updateLineTimes();
                updateFavoriteBtn();
                if (track.cover) { setCoverImage(track.cover); setBlurBackground(track.cover); }
                /* 清空歌词区域、重置进度条 */
                activeLineIndex = -1;
                currentTime = 0;
                aiEmotionWords = [];
                totalTimeEl.textContent = '00:00';
                if (currentTimeEl) currentTimeEl.textContent = '00:00';
                if (progressEl) {
                    progressEl.style.transition = 'width 0.6s cubic-bezier(0.4, 0, 0.2, 1)';
                    progressEl.style.width = '0%';
                    setTimeout(() => { if (progressEl) progressEl.style.transition = ''; }, 700);
                }

                /* 淡出音量（与音频加载并行，不阻塞 UI） */
                const fadeCallback = () => {
                    /* 代际检查：淡出期间用户又切了歌，放弃本次操作 */
                    if (gen !== playbackGeneration) return;
                    audio.pause();
                    audio.removeAttribute('src');
                    audio.src = getStreamCachedAudioUrl(track.url, track.mid || track.id || track.title);
                    audio.load();
                    audio.playbackRate = currentPlaybackRate;
                    applyPreservesPitch(preservesPitch);
                    /* ★ 播放收尾复用 95 的共享实现（waitForAudioReady→play→收尾任务），
                       失败时带 handlePlayFailure 兜底重试（本地直链专用） */
                    if (typeof window._playLocalTrackOnReady === 'function') {
                        window._playLocalTrackOnReady(gen, {
                            onPlayFail: () => {
                                if (!handlePlayFailure({ id: '', url: track.url, song: track.title, singer: track.artist, cover: track.cover }, false)) {
                                    audio.play().then(() => {
                                        if (gen !== playbackGeneration) return;
                                        applyVolumeOnSongChange();
                                    }).catch(() => handleAudioPlayError());
                                }
                            }
                        });
                    } else {
                        /* 兜底：共享函数未就绪时维持原内联实现（不应发生） */
                        const readyPromise = waitForAudioReady();
                        readyPromise.then(() => {
                            if (gen !== playbackGeneration) return;  /* 已过期 */
audio.play().then(() => {
if (gen !== playbackGeneration) return;
retryCount = 0;
applyVolumeOnSongChange();
if (typeof triggerPostLoadTasks === 'function') triggerPostLoadTasks({ gen: gen, stagger: true });
}).catch(() => {
if (gen !== playbackGeneration) return;
handleAudioPlayError();
                            if (!handlePlayFailure({ id: '', url: track.url, song: track.title, singer: track.artist, cover: track.cover }, false)) {
                                audio.play().then(() => {
                                    if (gen !== playbackGeneration) return;
                                    applyVolumeOnSongChange();
                                }).catch(() => handleAudioPlayError());
                            }
                        });
                        }).catch(() => {
                            if (gen !== playbackGeneration) return;
                            handleAudioPlayError();
                            logError('crossfade', '音频加载超时');
                        });
                    }
                };

                /* 如果启用了淡入淡出，先淡出再加载；否则直接加载 */
                if (appSettings.playback.fadeInOut) {
                    fadeOutVolume(appSettings.playback.fadeDuration, fadeCallback);
                } else {
                    fadeCallback();
                }
            }
        }

/* 打开/关闭歌单弹窗（与搜索弹窗一致的弹出动画） */
function openPlaylists() {
searchOverlay.classList.remove('visible');
favoritesOverlay.classList.remove('visible');
addToPlaylistOverlay.classList.remove('visible');
playlistsOverlay.classList.add('visible');
/* ★ 直接进入「我的歌单」列表（用户明确要求：不想先落到日推聚合、再点一次
   「我的歌单」才进去）。日推聚合视图并未移除，仍可从榜单弹窗的「每日推荐」
   按钮（#openDailyBtn）进入。 */
renderPlaylistsView();
}

function closePlaylists() {
            playlistsOverlay.classList.remove('visible');
        }

/* 打开/关闭添加到歌单弹窗（与搜索弹窗一致的弹出动画） */
function openAddToPlaylist() {
if (!currentSongData) return;
searchOverlay.classList.remove('visible');
favoritesOverlay.classList.remove('visible');
playlistsOverlay.classList.remove('visible');
addToPlaylistOverlay.classList.add('visible');
renderAddToPlaylistList();
}

/* ============================================================
 * 队尾自动续推：队列剩 ≤3 首（且 245 的「续推」开关开启）时，
 * 自动拉每日推荐追加到队尾——歌单/榜单播完不中断，类似 上游参考项目 队列近末续流。
 * 去重（source:id）+ 150s 防抖，纯静默失败。
 * ============================================================ */
let _refillDebounceAt = 0;
async function maybeQueueRefill() {
  try {
    if (!globalThis.__autoRefill) return;
    const pl = globalThis.playlist;
    if (!Array.isArray(pl) || pl.length <= 2) return;
    const idx = (typeof globalThis.currentTrackIndex === 'number' && globalThis.currentTrackIndex >= 0) ? globalThis.currentTrackIndex : 0;
    if (pl.length - idx > 3) return;                       /* 队列还够，不扰民 */
    const now = Date.now();
    if (_refillDebounceAt && now - _refillDebounceAt < 150000) return;
    _refillDebounceAt = now;
    const res = await dayRecommend();                      /* 按设置里的 dailySource */
    const list = (res && res.list) || [];
    if (!list.length) return;
    let added = 0;
    list.forEach(s => {
      const src = s.source || 'netease';
      const id = String(s.id != null ? s.id : '');
      if (!id) return;
      const en = {
        url: null, title: s.name || s.song || s.title || '', artist: s.singer || '',
        cover: s.cover || '', source: src, id
      };
      const k = `${src}:${id}`;
      if (!pl.some(p => `${(p.source || '')}:${(p.id || '')}` === k)) { pl.push(en); added++; }
    });
    if (added > 0 && typeof setHint === 'function') setHint(`已自动续推 ${added} 首（每日推荐）`);
  } catch (e) { /* 静默 */ }
}
Aria.__maybeQueueRefill = maybeQueueRefill;

export { applyVolumeOnSongChange, closePlaylists, fadeInVolume, fadeOutVolume, handlePlayFailure, loadPlaylistTrack, openAddToPlaylist, openPlaylists };
