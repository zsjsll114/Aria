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
import { offerReveal } from '../core/revealPath.js';
import { clampPracticeRate, practicePlanFor } from '../core/practiceRate.js';

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
                        /* ★ 2026-09-29：ygking.top 音质阶梯已移除（上游死亡）。
                           解析池未命中时落 vkeys 元数据链（server /tencent?id=）。 */
                        if (!downloadUrl || downloadUrl === audio.src) {
                            try {
                                const vkJson = await fetch(`/tencent?id=${encodeURIComponent(currentSongData.id || dlSongMid)}`)
                                    .then(r => r.json());
                                if (vkJson.code === 200 && vkJson.data && vkJson.data.url) {
                                    downloadUrl = vkJson.data.url;
                                    ext = downloadUrl.includes('.flac') || downloadUrl.includes('AI00') || downloadUrl.includes('F000') ? 'flac' : 'mp3';
                                }
                            } catch (e) { /* 静默，降级到当前播放 URL */ }
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
                /* ★ 「下载之后不能一键打开文件所在位置」——桌面壳里给入口。
                   ★ 延后 900ms：公告先出来，再弹「打开所在位置」，不然像是替用户做了决定；
                     也给浏览器一点时间把 blob 真正落盘（否则 reveal 找不到文件会退到目录）。 */
                setTimeout(() => { offerReveal(fileName, { title: '下载已开始' }).catch(() => {}); }, 900);
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

/* ============================ 练习模式变速（需求 15）============================ */

/* 纯逻辑（量程/取整/落点决策）全在 core/practiceRate.js，那半边能在 node 单测；
   这里只负责"把决策落到播放链 + 读写 appSettings"。 */

function practiceCfg() {
            return (typeof appSettings !== 'undefined' && appSettings && appSettings.playback) || null;
        }

function practiceRateOf() {
            const p = practiceCfg();
            return clampPracticeRate(p && p.practiceRate);
        }

function practiceOn() {
            const p = practiceCfg();
            return !!(p && p.practiceMode);
        }

/* 原生 WASAPI 独占是否在接管输出（判据与 296/200 一致：问 298 的后端） */
function _nativeOutputActive() {
            try {
                const A = (typeof globalThis !== 'undefined' && globalThis.Aria) || null;
                const b = A && A.__nativeOutputBackend;
                return !!(b && typeof b.active === 'function' && b.active());
            } catch { return false; }
        }

let _nativePitchWarned = false;

/** 独占路径变速会变调 → 只提示一次（需求 15 的已知边界，不能让用户以为功能坏了） */
function _warnNativePitchOnce() {
            if (_nativePitchWarned) return;
            _nativePitchWarned = true;
            try { showSettingsHint('独占输出下变速会改变音调（保音高需关闭独占输出）'); }
            catch (e) { logWarn('rate', e); }
        }

/** 把「练习模式」的当前状态落到播放链上。决策见 `practicePlanFor`。 */
function applyPracticeState() {
            const p = practiceCfg();
            const userPreserves = !(p && p.preservesPitch === false);
            const plan = practicePlanFor(
                !!(p && p.practiceMode),
                p && p.practiceRate,
                userPreserves
            );
            applyPlaybackRate(plan.rate);
            applyPreservesPitch(plan.preservesPitch);
            /* ★ 独占路径是 Rust 侧线性重采样，`preservesPitch` 对它无效（音频不过 WebAudio），
               所以那一路必然变调 —— 明确告诉用户，别让他以为"练习模式坏了"。 */
            if (plan.rate !== 1 && _nativeOutputActive()) _warnNativePitchOnce();
        }

/** 供设置页调用：改速度。只在练习模式开启时才真正作用到播放链。 */
function setPracticeRate(r) {
            const p = practiceCfg();
            const v = clampPracticeRate(r);
            if (p) p.practiceRate = v;
            if (practiceOn()) applyPracticeState();
            return v;
        }

/** 供设置页调用：开关练习模式。 */
function setPracticeMode(on) {
            const p = practiceCfg();
            if (p) p.practiceMode = !!on;
            applyPracticeState();
        }

/**
 * 从播放链回读当前速率 —— 给编辑同一份状态的其他入口用（「更多」菜单里的
 * 0.5/1.5× 预设会直接调 `applyPlaybackRate`）。若两边不一致，以播放链为准，
 * 顺手把练习模式的数值也拉过来，避免"菜单选了 1.5× 但设置页还写 0.8×"。
 */
function syncPracticeRateFromPlayer() {
            const r = clampPracticeRate(
                (typeof currentPlaybackRate === 'number') ? currentPlaybackRate : 1
            );
            const p = practiceCfg();
            if (p && practiceOn()) p.practiceRate = r;
            return r;
        }

export {
            RATE_OPTIONS, applyPlaybackRate, applyPreservesPitch, downloadCurrentSong,
            applyPracticeState, setPracticeRate, setPracticeMode, practiceRateOf, practiceOn,
            syncPracticeRateFromPlayer,
        };
