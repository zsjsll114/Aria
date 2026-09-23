/* ============================================================
 * 145-playlist-import.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 5183-5784 行 | 单元数: 9
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { API_BASE } from '../config/constants.js';
import { localMusicManager } from './10-config-state.js';
import { showCtxConfirm } from './80-context-menu.js';
import { makeSongKey, setHint } from './120-search-results.js';
import { addToPlaylist, addToPlaylistListEl, deletePlaylist, generatePlaylistId, getPlaylists, importConfirmBtn, importHintEl, importPlaylistOverlay, importProgressFill, importProgressText, importProgressWrap, importUrlInput, playEntirePlaylist, playLocalMusicSong, playlistsListEl, removeFromPlaylist, renderAddToPlaylistList, renderLocalMusicDetail, renderNowPlayingDetail, renderPlaylistDetail, renderPlaylistsView, savePlaylists, togglePlaylistSongFav } from './130-playlists.js';
import { closePlaylists, loadPlaylistTrack, openAddToPlaylist } from './135-crossfade.js';
import { extractNeteaseId, extractQQId, getPlaylistSource, resolveShortLink } from './140-playlist-ui-events.js';
import { logInfo, logWarn, logError } from '../services/log.js';

/* 网易云歌单分页获取的 token：本仓库不含凭证，请到 https://apicx.asia 免费注册后在下方自填 */
const NETEASE_API_TOKEN = '';

/* 通过 apicx.asia API 分页获取网易云歌单（每次最多100条，随机延迟防封IP）
           使用重试逻辑和连续空页计数，避免因API偶发限流导致提前停止
           返回 { name, tracks: [{title, artist, id, mid, cover, source}] } 或 null */
async function fetchNeteasePlaylist(id) {
            const baseUrl = 'https://apicx.asia/api/netease.music.playlist';
            const allTracks = [];
            const seenIds = new Set();  /* 去重，防止API分页异常导致重复 */
            let playlistName = '';
            let playlistCover = '';
            let page = 1;
            const limit = 100;
            const maxPages = 100;  /* 安全上限 */
            let consecutiveEmpty = 0;  /* 连续空/重复页计数 */

            while (page <= maxPages) {
                const apiUrl = `${baseUrl}?token=${NETEASE_API_TOKEN}&id=${id}&page=${page}&limit=${limit}`;

                /* 重试逻辑：网络错误或非200最多重试3次 */
                let json = null;
                for (let retry = 0; retry < 3; retry++) {
                    try {
                        const res = await fetch(apiUrl);
                        json = await res.json();
                        if (json.code === 200 && json.data) break;
                        json = null;
                    } catch(e) {
                        /* 网络错误，重试 */
                    }
                    if (retry < 2) await new Promise(r => setTimeout(r, 1000 * (retry + 1)));
                }

                /* 所有重试均失败，返回已获取的部分结果 */
                if (!json) break;

                /* 第一页提取歌单信息 */
                if (page === 1) {
                    const info = json.data['歌单基础信息'] || {};
                    playlistName = info['歌单名称'] || '';
                    playlistCover = info['歌单封面'] || '';
                }

                const songs = json.data['当前页歌曲列表'] || [];

                /* 空列表：可能是API限流，尝试下一页 */
                if (songs.length === 0) {
                    consecutiveEmpty++;
                    if (consecutiveEmpty >= 3) break;
                    page++;
                    if (importHintEl) {
                        importHintEl.textContent = `正在获取歌单 (第${page}页，已获取${allTracks.length}首)...`;
                    }
                    await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
                    continue;
                }

                let newCount = 0;  /* 本页新增的不重复歌曲数 */
                for (const s of songs) {
                    const sid = String(s['歌曲ID'] || '');
                    if (!sid) continue;
                    if (seenIds.has(sid)) continue;
                    seenIds.add(sid);
                    newCount++;
                    allTracks.push({
                        title: s['歌曲名称'] || '',
                        artist: s['歌手'] || '',
                        id: sid,
                        mid: '',
                        cover: (s['专辑封面'] || '').replace(/^http:/, 'https:'),
                        source: 'netease'
                    });
                }

                /* 更新提示 */
                if (importHintEl) {
                    importHintEl.textContent = `正在获取歌单 (第${page}页，已获取${allTracks.length}首)...`;
                }

                /* 本页全部重复：可能API分页异常，尝试下一页 */
                if (newCount === 0) {
                    consecutiveEmpty++;
                    if (consecutiveEmpty >= 3) break;
                } else {
                    consecutiveEmpty = 0;
                }

                /* 不足100条说明已到最后一页 */
                if (songs.length < limit) break;

                page++;
                /* 随机延迟 1~2s 防封IP */
                await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
            }

            if (allTracks.length === 0) return null;
            /* 用歌单封面作为歌单cover，若无则用第一首歌的封面 */
            const cover = playlistCover || (allTracks[0] && allTracks[0].cover) || '';
            return { name: playlistName, tracks: allTracks, cover };
        }

/* 兜底方案：通过 unmeta.cn 获取歌单曲目名（仅返回歌名+歌手，无ID）
           返回 { name, tracks: [{title, artist}] } 或 null */
async function fetchPlaylistTracksFallback(url) {
            const formData = new FormData();
            formData.append('url', url);
            const res = await fetch('https://music.unmeta.cn/songlist', {
                method: 'POST',
                body: formData
            });
            const json = await res.json();
            if (json.code !== 'success' || !json.data) return null;
            const songs = json.data.songs || [];
            const tracks = songs.map(s => {
                const parts = s.split(' - ');
                return {
                    title: parts[0] ? parts[0].trim() : s,
                    artist: parts[1] ? parts[1].trim() : ''
                };
            }).filter(t => t.title);
            return { name: json.data.name || '', tracks };
        }

/* 通过QQ音乐API分页获取歌单曲目列表（每次最多60条，分页获取全部）
           使用 songnum 判断总数，遇到空页/重复页时重试而非直接停止
           返回 { name, tracks: [{title, artist, id, mid, cover, source}], cover } 或 null */
async function fetchQQPlaylist(id) {
            const allTracks = [];
            const seenIds = new Set();  /* 去重，防止API分页异常导致重复 */
            let playlistName = '';
            let playlistCover = '';
            let songnum = 0;  /* 歌单总数，从API获取 */
            let page = 1;
            const num = 60;  /* vkeys API限制 num 最大60 */
            const maxPages = 100;  /* 安全上限 */
            let consecutiveEmpty = 0;  /* 连续空/重复页计数 */

            while (page <= maxPages) {
                /* vkeys API用page参数分页（start/offset参数无效，会被忽略） */
                const apiUrl = `${API_BASE}/tencent/dissinfo?id=${id}&page=${page}&num=${num}`;

                /* 重试逻辑：网络错误或非200最多重试3次 */
                let json = null;
                for (let retry = 0; retry < 3; retry++) {
                    try {
                        const res = await fetch(apiUrl);
                        json = await res.json();
                        if (json.code === 200 && json.data) break;
                        json = null;
                    } catch(e) {
                        /* 网络错误，重试 */
                    }
                    if (retry < 2) await new Promise(r => setTimeout(r, 1000 * (retry + 1)));
                }

                /* 所有重试均失败，返回已获取的部分结果（优于直接返回null） */
                if (!json) break;

                /* 第一页提取歌单信息（含总数） */
                if (page === 1) {
                    const info = json.data.info || {};
                    playlistName = info.title || '';
                    playlistCover = info.picurl || '';
                    songnum = info.songnum || 0;
                }

                const songs = json.data.list || [];

                /* 空列表：可能是API限流，尝试下一页 */
                if (songs.length === 0) {
                    consecutiveEmpty++;
                    if (consecutiveEmpty >= 3) break;
                    page++;
                    if (importHintEl) {
                        importHintEl.textContent = `正在获取歌单 (第${page}页，已获取${allTracks.length}${songnum ? '/' + songnum : ''}首)...`;
                    }
                    await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
                    continue;
                }

                let newCount = 0;  /* 本页新增的不重复歌曲数 */
                for (const t of songs) {
                    const sid = String(t.id || '');
                    if (!sid) continue;
                    if (seenIds.has(sid)) continue;
                    seenIds.add(sid);
                    newCount++;
                    allTracks.push({
                        title: t.song || '',
                        artist: t.singer || '',
                        id: sid,
                        mid: t.mid || '',
                        cover: t.cover || '',
                        source: 'tencent'
                    });
                }

                /* 更新提示 */
                if (importHintEl) {
                    const total = songnum || '?';
                    importHintEl.textContent = `正在获取歌单 (第${page}页，已获取${allTracks.length}/${total}首)...`;
                }

                /* 已获取到全部歌曲，停止 */
                if (songnum > 0 && allTracks.length >= songnum) break;

                /* 本页全部重复：可能API分页异常，尝试下一页 */
                if (newCount === 0) {
                    consecutiveEmpty++;
                    if (consecutiveEmpty >= 3) break;
                } else {
                    consecutiveEmpty = 0;
                }

                /* 不足 num 条且已获取足够数量，停止 */
                if (songs.length < num && songnum > 0 && allTracks.length >= songnum) break;
                /* 不足 num 条但未获取够，继续下一页（API可能分页大小不一致） */

                page++;
                /* 随机延迟 1~2s 防封IP */
                await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
            }

            if (allTracks.length === 0) return null;
            const cover = playlistCover || (allTracks[0] && allTracks[0].cover) || '';
            return { name: playlistName, tracks: allTracks, cover };
        }

/* 通过链接获取歌单曲目列表（自动判断来源，支持短链接解析）
           返回 { name, tracks: [{title, artist, id, mid, cover, source}], cover } 或 null */
async function fetchPlaylistTracks(url) {
            const source = getPlaylistSource(url);
            let id = source === 'tencent' ? extractQQId(url) : extractNeteaseId(url);

            /* 无法直接提取ID时，通过代理访问链接获取重定向后的ID */
            if (!id) {
                if (importHintEl) importHintEl.textContent = '正在解析链接...';
                id = await resolveShortLink(url);
            }

            if (!id) return null;

            if (source === 'tencent') {
                return await fetchQQPlaylist(id);
            } else {
                return await fetchNeteasePlaylist(id);
            }
        }

/* 搜索单首歌并返回匹配结果 */
async function searchSingleTrack(title, artist, preferredSource) {
            const word = `${title} ${artist}`.trim();
            /* 优先用来源对应的曲库搜索 */
            const searchSource = preferredSource;
            const url = `${API_BASE}/${searchSource}?word=${encodeURIComponent(word)}&num=5`;
            const res = await fetch(url);
            const json = await res.json();
            if (json.code !== 200 || !json.data) return null;
            const list = Array.isArray(json.data) ? json.data : [json.data];
            if (list.length === 0) return null;
            /* 精确匹配：标题和歌手都包含 */
            let best = list.find(item => {
                const t = (item.song || '').toLowerCase();
                const s = (item.singer || '').toLowerCase();
                return t.includes(title.toLowerCase()) && s.includes(artist.toLowerCase());
            });
            /* 模糊匹配：标题包含 */
            if (!best) {
                best = list.find(item => (item.song || '').toLowerCase().includes(title.toLowerCase()));
            }
            /* 取第一个 */
            if (!best) best = list[0];
            return {
                title: best.song || title,
                artist: best.singer || artist,
                cover: best.cover || '',
                source: searchSource,
                id: best.id || '',
                mid: best.mid || '',
                key: `${searchSource}:${best.id}`
            };
        }

/* 主导入函数 */
async function importPlaylistFromUrl(url) {
            if (isImportingPlaylist) return;
            if (!url) { importHintEl.textContent = '请输入歌单链接'; return; }
            isImportingPlaylist = true;
            importConfirmBtn.disabled = true;
            importProgressWrap.style.display = 'none';

            try {
                importHintEl.textContent = '正在获取歌单信息...';
                const preferredSource = getPlaylistSource(url);
                let result = await fetchPlaylistTracks(url);

                /* 网易云API通过代理失败时，回退到 unmeta.cn 获取歌名列表 */
                if (!result && preferredSource === 'netease') {
                    importHintEl.textContent = '直连API失败，尝试备用方式...';
                    result = await fetchPlaylistTracksFallback(url);
                }

                if (!result) {
                    importHintEl.textContent = '无法从链接中提取歌单ID，请检查链接是否正确';
                    return;
                }
                if (result.tracks.length === 0) {
                    importHintEl.textContent = '未获取到歌单曲目，可能歌单不存在或链接无效';
                    return;
                }
                const tracks = result.tracks;

                /* 创建歌单 */
                const playlistName = result.name ? `${result.name}(${tracks.length}首)` : `导入歌单(${tracks.length}首)`;
                const playlists = getPlaylists();
                const newPlaylist = {
                    id: generatePlaylistId(),
                    name: playlistName,
                    cover: result.cover || '',
                    songs: [],
                    createdAt: Date.now()
                };

                /* 检查是否已有歌曲ID（网易云/QQ API直接返回） */
                const hasIds = tracks.every(t => t.id);

                if (hasIds) {
                    /* 直接使用API返回的歌曲数据（含ID），无需逐首搜索 */
                    for (const t of tracks) {
                        newPlaylist.songs.push({
                            title: t.title,
                            artist: t.artist,
                            cover: t.cover || '',
                            source: t.source,
                            id: t.id,
                            mid: t.mid || '',
                            key: `${t.source}:${t.id}`
                        });
                        if (!newPlaylist.cover && t.cover) newPlaylist.cover = t.cover;
                    }
                } else {
                    /* 兜底：逐首搜索匹配（通过 vkeys API），带进度条 */
                    importProgressWrap.style.display = 'flex';
                    importProgressFill.style.width = '0%';
                    importProgressText.textContent = '';
                    let successCount = 0;
                    const startTime = Date.now();
                    for (let i = 0; i < tracks.length; i++) {
                        const t = tracks[i];
                        const progress = (i / tracks.length) * 100;
                        importProgressFill.style.width = `${progress}%`;
                        if (i > 0) {
                            const elapsed = (Date.now() - startTime) / 1000;
                            const avgPerSong = elapsed / i;
                            const remaining = Math.ceil(avgPerSong * (tracks.length - i));
                            const remainText = remaining >= 60 ? `${Math.floor(remaining / 60)}分${remaining % 60}秒` : `${remaining}秒`;
                            importProgressText.textContent = `预计剩余 ${remainText}`;
                        } else {
                            importProgressText.textContent = '正在计算剩余时间...';
                        }
                        importHintEl.textContent = `正在搜索匹配 (${i + 1}/${tracks.length})：${t.title} - ${t.artist}`;
                        try {
                            const matched = await searchSingleTrack(t.title, t.artist, preferredSource);
                            if (matched) {
                                newPlaylist.songs.push(matched);
                                if (!newPlaylist.cover && matched.cover) newPlaylist.cover = matched.cover;
                                successCount++;
                            }
                        } catch (e) {
                            logError('playlistImport', `搜索失败: ${t.title}`, e);
                        }
                        if (i < tracks.length - 1) {
                            await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
                        }
                    }
                    importProgressFill.style.width = '100%';
                    importProgressText.textContent = '';
                    setTimeout(() => { importProgressWrap.style.display = 'none'; }, 1500);
                }

                /* 保存歌单 */
                if (newPlaylist.songs.length > 0) {
                    playlists.unshift(newPlaylist);
                    savePlaylists(playlists);
                    importHintEl.textContent = `导入完成：成功 ${newPlaylist.songs.length}/${tracks.length} 首`;
                    importPlaylistOverlay.classList.remove('visible');
                    importUrlInput.value = '';
                    renderPlaylistsView();
                } else {
                    importHintEl.textContent = `导入失败：${tracks.length} 首歌曲均未匹配到`;
                }
            } catch (err) {
                logError('playlistImport', '导入歌单失败:', err);
                importHintEl.textContent = '导入失败：' + (err.message || '网络错误');
                importProgressWrap.style.display = 'none';
            } finally {
                isImportingPlaylist = false;
                importConfirmBtn.disabled = false;
            }
        }

/* 歌单列表/详情交互（事件委托） */
playlistsListEl?.addEventListener('click', async (e) => {
            const delPl = e.target.closest('[data-del-pl]');
            if (delPl) {
                e.stopPropagation();
                const pid = delPl.dataset.delPl;
                const pl = getPlaylists().find(p => p.id === pid);
                const plName = pl ? pl.name : '此歌单';
                showCtxConfirm('删除歌单', `确定要删除歌单「${plName}」吗？此操作无法撤销。`, () => deletePlaylist(pid));
                return;
            }
            const delSong = e.target.closest('[data-del-song]');
            if (delSong) {
                e.stopPropagation();
                if (currentPlaylistId) removeFromPlaylist(currentPlaylistId, parseInt(delSong.dataset.delSong));
                return;
            }
            /* 加入当前播放 */
            const addNowPlBtn = e.target.closest('[data-action="addnow-pl"]');
            if (addNowPlBtn) {
                e.stopPropagation();
                const sidx = parseInt(addNowPlBtn.dataset.sidx);
                const playlists = getPlaylists();
                const pl = playlists.find(p => p.id === currentPlaylistId);
                if (pl && pl.songs[sidx]) {
                    const s = pl.songs[sidx];
                    playlist.push({
                        url: null, title: s.title, artist: s.artist,
                        cover: s.cover || '', source: s.source, id: s.id, mid: s.mid || ''
                    });
                }
                return;
            }
            /* 歌单详情中的收藏按钮 */
            const favPlBtn = e.target.closest('[data-action="fav-pl"]');
            if (favPlBtn) {
                e.stopPropagation();
                const sidx = parseInt(favPlBtn.dataset.sidx);
                togglePlaylistSongFav(sidx);
                return;
            }
            /* 当前播放队列：从队列移除 */
            const delNpBtn = e.target.closest('[data-del-np]');
            if (delNpBtn) {
                e.stopPropagation();
                const sidx = parseInt(delNpBtn.dataset.delNp);
                if (sidx >= 0 && sidx < playlist.length) {
                    const wasCurrent = (sidx === currentTrackIndex);
                    playlist.splice(sidx, 1);
                    if (playlist.length === 0) {
                        currentTrackIndex = 0;
                    } else if (sidx < currentTrackIndex) {
                        currentTrackIndex--;
                    } else if (wasCurrent) {
                        currentTrackIndex = Math.min(currentTrackIndex, playlist.length - 1);
                        loadPlaylistTrack(currentTrackIndex);
                    }
                    renderNowPlayingDetail();
                }
                return;
            }
            /* 当前播放队列：添加到歌单 */
            const addPlNpBtn = e.target.closest('[data-action="addpl-np"]');
            if (addPlNpBtn) {
                e.stopPropagation();
                const sidx = parseInt(addPlNpBtn.dataset.sidx);
                if (sidx >= 0 && sidx < playlist.length) {
                    const track = playlist[sidx];
                    currentSongData = {
                        title: track.title || '未知歌曲',
                        artist: track.artist || '未知歌手',
                        cover: track.cover || '',
                        source: track.source || '',
                        id: track.id || '',
                        mid: track.mid || ''
                    };
                    currentSongKey = track.key || makeSongKey(currentSongData);
                    openAddToPlaylist();
                }
                return;
            }
            const playAll = e.target.closest('#playAllBtn');
            if (playAll) {
                if (playAll.dataset.pid === '__now_playing__') {
                    if (playlist.length > 0) {
                        currentTrackIndex = 0;
                        await loadPlaylistTrack(0);
                    }
                } else {
                    await playEntirePlaylist(playAll.dataset.pid);
                }
                return;
            }
            const playlistItem = e.target.closest('.playlist-item[data-pid]');
            if (playlistItem && playlistViewMode === 'list') {
                if (playlistItem.dataset.pid === '__now_playing__') {
                    renderNowPlayingDetail();
                } else if (playlistItem.dataset.pid === '__local_music__') {
                    renderLocalMusicDetail();
                } else if (playlistItem.dataset.pid === '__recent__') {
                    /* ★ 历史播放：进入歌单页二级页（见 130-playlists.js） */
                    if (typeof Aria.__openRecentDetail === 'function') Aria.__openRecentDetail();
                    else if (typeof window.openRecent === 'function') window.openRecent();
                } else {
                    renderPlaylistDetail(playlistItem.dataset.pid);
                }
                return;
            }

            /* 本地音乐：播放整单 */
            const playAllLocal = e.target.closest('#playAllLocalBtn');
            if (playAllLocal) {
                if (localSongsCache.length > 0) {
                    playlist = localSongsCache.map(s => ({
                        url: s.audioUrl,
                        title: s.title,
                        artist: s.artist,
                        cover: s.coverUrl,
                        source: 'local',
                        key: `local:${s.folder}`
                    }));
                    currentTrackIndex = 0;
                    await playLocalMusicSong(localSongsCache[0]);
                }
                return;
            }

            /* 本地音乐：上传/替换自定义歌词 */
            const uploadLrcBtn = e.target.closest('[data-action="upload-custom-lrc"]');
            if (uploadLrcBtn) {
                e.stopPropagation();
                const folder = uploadLrcBtn.dataset.folder;
                const fileInput = document.createElement('input');
                fileInput.type = 'file';
                fileInput.accept = '.lrc,.elrc,.txt';
                fileInput.onchange = async () => {
                    if (fileInput.files && fileInput.files[0]) {
                        const lrcText = await fileInput.files[0].text();
                        const isElrc = lrcText.includes('<') && lrcText.includes('>');
                        await localMusicManager.uploadCustomLrc(folder, lrcText, isElrc);
                        if (typeof setHint === 'function') setHint('✅ 自定义歌词已成功保存！');
                        renderLocalMusicDetail();
                    }
                };
                fileInput.click();
                return;
            }

            /* 本地音乐：在线重新匹配歌词（候选列表勾选采用，见 130-playlists.js） */
            const matchLrcBtn = e.target.closest('[data-action="match-lyric-online"]');
            if (matchLrcBtn) {
                e.stopPropagation();
                const idx = Number(matchLrcBtn.dataset.idx);
                if (typeof Aria.__openLocalLyricMatch === 'function') Aria.__openLocalLyricMatch(idx, matchLrcBtn.dataset.folder);
                return;
            }

            /* 本地音乐：删除单曲 */
            const delLocalBtn = e.target.closest('[data-action="del-local-song"]');
            if (delLocalBtn) {
                e.stopPropagation();
                const folder = delLocalBtn.dataset.folder;
                showCtxConfirm('删除本地歌曲', `确定要从本地音乐库中删除「${folder}」吗？文件将被永久移除。`, async () => {
                    const ok = await localMusicManager.deleteLocalSong(folder);
                    const hint = ok ? '已删除本地歌曲' : '删除失败：目录可能被占用或不存在';
                    if (typeof setHint === 'function') setHint(hint);
                    renderLocalMusicDetail();
                });
                return;
            }

            /* 本地音乐：单曲点击播放 */
            const localSongItem = e.target.closest('.result-item[data-local-idx]');
            if (localSongItem && playlistViewMode === 'detail' && currentPlaylistId === '__local_music__') {
                const idx = parseInt(localSongItem.dataset.localIdx);
                const song = localSongsCache[idx];
                logInfo('playlistImport', '[LocalMusic] 点击播放本地歌曲:', idx, song ? song.title : 'null');
                if (song) {
                    await playLocalMusicSong(song);
                }
                return;
            }

            const songItem = e.target.closest('.result-item[data-sidx]');
            if (songItem && playlistViewMode === 'detail') {
                /* ★ 编辑（多选）模式下点击歌曲卡片只切换勾选，不切歌 */
                if (globalThis.plMultiEdit === true) {
                    const cb = songItem.querySelector('.pl-multi-cb');
                    if (cb) {
                        cb.checked = !cb.checked;
                        cb.dispatchEvent(new Event('change'));
                    }
                    return;
                }
                const idx = parseInt(songItem.dataset.sidx);
                if (currentPlaylistId === '__now_playing__') {
                    /* 从当前播放队列选歌 */
                    currentTrackIndex = idx;
                    await loadPlaylistTrack(idx);
                    closePlaylists();
                } else if (currentPlaylistId) {
                    const playlists = getPlaylists();
                    const pl = playlists.find(p => p.id === currentPlaylistId);
                    if (pl) {
                        /* 设置播放队列为当前歌单 */
                        playlist = pl.songs.map(s => ({
                            url: null, title: s.title || s.song || s.name, artist: s.artist,
                            cover: s.cover, source: s.source, id: s.id, mid: s.mid, key: s.key
                        }));
                        currentTrackIndex = idx;
                        await loadPlaylistTrack(idx);
                        closePlaylists();
                    }
                }
                return;
            }
        });

/* 添加到歌单列表交互 */
addToPlaylistListEl?.addEventListener('click', (e) => {
            const item = e.target.closest('.add-to-playlist-item');
            if (!item || item.classList.contains('disabled')) return;
            addToPlaylist(item.dataset.pid);
            renderAddToPlaylistList();
        });

export { NETEASE_API_TOKEN, fetchNeteasePlaylist, fetchPlaylistTracks, fetchPlaylistTracksFallback, fetchQQPlaylist, importPlaylistFromUrl, searchSingleTrack };
