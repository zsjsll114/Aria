/* ============================================================
 * 85-rate-download.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 2009-2133 行 | 单元数: 5
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { audio } from './20-lyrics-render.js';
import { songArtistEl, songTitleEl } from './30-dom-refs.js';
import { showSettingsHint } from './220-shortcuts-viewmode.js';
import { intervalToSec, qqResolveUrl, getKugouPlayInfo } from '../services/musicApi.js';
import { logInfo, logWarn, logError } from '../services/log.js';

const RATE_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function applyPlaybackRate(rate) {
            currentPlaybackRate = rate;
            if (audio) audio.playbackRate = rate;
        }

function applyPreservesPitch(val) {
            preservesPitch = val;
            if (audio) {
                if ('preservesPitch' in audio) audio.preservesPitch = val;
                if ('mozPreservesPitch' in audio) audio.mozPreservesPitch = val;
                if ('webkitPreservesPitch' in audio) audio.webkitPreservesPitch = val;
            }
        }

applyPreservesPitch(true);

/* 下载当前播放歌曲（使用下载音质设置，静默下载，不跳转页面） */
async function downloadCurrentSong() {
            if (!audio.src) {
                if (typeof showSettingsHint === 'function') showSettingsHint('当前没有正在播放的歌曲');
                return;
            }
            const songName = (songTitleEl.textContent || '歌曲').trim();
            const artistName = (songArtistEl.textContent || '').trim();
            const cleanTitle = artistName ? `${artistName} - ${songName}` : songName;
            
            if (typeof showSettingsHint === 'function') showSettingsHint(`正在准备下载: ${cleanTitle}...`);

            /* 尝试使用下载音质获取新URL */
            let downloadUrl = audio.src;
            let ext = 'mp3';
            try {
                if (currentSongData && currentSongData.id && currentSongData.source) {
                    const dlSongId = currentSongData.id;
                    const dlSongMid = currentSongData.mid;
                    const dlSource = currentSongData.source;

                    if (dlSource === 'tencent' && dlSongMid) {
                        /* 步骤0: 优先走本地解析池（防试听校验）——按下载音质裁剪阶梯
                           ★ 传当前歌曲真实时长，避免下载到 30~60s 试听片段（缺省回落 0=跳过校验） */
                        const userQuality = (appSettings.quality && appSettings.quality.qqDownload) || 'flac';
                        try {
                            const durSec = intervalToSec(currentSongData.interval) || currentSongData.duration || 0;
                            const resolved = await qqResolveUrl(dlSongMid, durSec, userQuality);
                            if (resolved) {
                                downloadUrl = resolved;
                                ext = resolved.includes('.flac') || resolved.includes('AI00') || resolved.includes('F000') ? 'flac' : 'mp3';
                            }
                        } catch (e) { /* 静默，走原链 */ }
                        const YGK_QUALITIES = ['master', 'atmos', 'flac', '320', '128'];
                        const orderedQualities = [userQuality, ...YGK_QUALITIES.filter(q => q !== userQuality)];
                        for (const quality of orderedQualities) {
                            /* 解析池已命中（拿到新链接）时跳过ygking下载循环，防止覆盖母带结果 */
                            if (downloadUrl && downloadUrl !== audio.src) break;
                            try {
                                const controller = new AbortController();
                                const timeout = setTimeout(() => controller.abort(), 3500);
                                const resp = await fetch(`https://api.ygking.top/api/song/url?mid=${dlSongMid}&quality=${quality}`, { signal: controller.signal });
                                clearTimeout(timeout);
                                const ygkJson = await resp.json();
                                if (ygkJson.code === 0 && ygkJson.data && ygkJson.data[dlSongMid]) {
                                    const url = ygkJson.data[dlSongMid];
                                    if (url && url.startsWith('http')) {
                                        downloadUrl = url;
                                        if (quality === 'flac' || quality === 'master') ext = 'flac';
                                        break;
                                    }
                                }
                            } catch (e) { /* 静默 */ }
                        }
                    } else if (dlSource === 'netease') {
                        const userLevel = (appSettings.quality && appSettings.quality.neteaseDownload) || 'lossless';
                        const QUALITY_LEVELS = ['hires', 'lossless', 'exhigh', 'higher', 'standard'];
                        const orderedLevels = [userLevel, ...QUALITY_LEVELS.filter(q => q !== userLevel)];
                        for (const level of orderedLevels) {
                            try {
                                const controller = new AbortController();
                                const timeout = setTimeout(() => controller.abort(), 3500);
                                const resp = await fetch(`https://api.byfuns.top/1/?id=${dlSongId}&level=${level}`, { signal: controller.signal });
                                clearTimeout(timeout);
                                const text = await resp.text();
                                if (text && text.startsWith('http')) {
                                    downloadUrl = text.trim();
                                    if (level === 'hires' || level === 'lossless') ext = 'flac';
                                    break;
                                }
                            } catch (e) { /* 静默 */ }
                        }
                    } else if (dlSource === 'kugou') {
                        const userQ = (appSettings.quality && appSettings.quality.kugouDownload) || 'flac';
                        const hash = currentSongData.hash || currentSongData.id;
                        if (hash) {
                            try {
                                const info = await getKugouPlayInfo(hash, currentSongData.song || currentSongData.title, currentSongData.singer || currentSongData.artist, userQ);
                                if (info && info.url) {
                                    downloadUrl = info.url;
                                    if (userQ === 'flac' || userQ === 'high' || downloadUrl.includes('.flac')) ext = 'flac';
                                }
                            } catch (e) { /* ignore */ }
                        }
                    }
                }
            } catch (e) {
                logWarn('rateDownload', '使用下载音质获取URL失败，降级到当前播放URL:', e);
            }

            const fileName = `${cleanTitle}.${ext}`;

            // 尝试通过 Fetch 获取 Blob (如果直接 Fetch 跨域失败，尝试代理)
            let blob = null;
            try {
                const res = await fetch(downloadUrl);
                if (res.ok) blob = await res.blob();
            } catch (e) {
                logWarn('rateDownload', '[Download] 直接下载遇到 CORS，尝试走代理:', e);
            }

            if (!blob) {
                try {
                    const proxyUrl = `/proxy?url=${encodeURIComponent(downloadUrl)}`;
                    const resProxy = await fetch(proxyUrl);
                    if (resProxy.ok) blob = await resProxy.blob();
                } catch (e) {
                    logWarn('rateDownload', '[Download] 代理下载也遇到问题:', e);
                }
            }

            if (blob) {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 2000);
                if (typeof showSettingsHint === 'function') showSettingsHint(`下载已开始: ${fileName}`);
            } else {
                // 最终降级
                const a = document.createElement('a');
                a.href = downloadUrl;
                a.target = '_blank';
                a.download = fileName;
                document.body.appendChild(a);
                a.click();
                a.remove();
                if (typeof showSettingsHint === 'function') showSettingsHint(`已在新窗口中打开音频: ${fileName}`);
            }
        }

export { RATE_OPTIONS, applyPlaybackRate, applyPreservesPitch, downloadCurrentSong };
