/* ============================================================
 * 175-track-index-online.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 7454-8207 行 | 单元数: 9
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { API_BASE } from '../config/constants.js';
import { playerConfig } from '../config/defaults.js';
import { getCoverLayers } from '../infrastructure/dom.js';
import { detectAndParseLyrics, mergeLyrics } from '../parsers/lyricMerger.js';
import { checkAudioUrlPlayable, fetchKugouLyric, fetchKuwoPic, fetchKuwoSearch, fetchKuwoUrl, fetchLyricWithFallback, fetchSameSongUrlFrom, getKugouPlayInfo, getKuwoPlayInfo, intervalToSec, qqResolveUrl } from '../services/musicApi.js';
import { selfhostQQPlayUrl, selfhostNeteasePlayUrl } from './selfhost-runtime.js';
import { volumePercentToGain } from '../utils/volumeCurve.js';
import { audio, renderLyrics } from './20-lyrics-render.js';
import { currentTimeEl, progressEl, searchResultsEl, songArtistEl, songTitleEl, totalTimeEl, volumeBar } from './30-dom-refs.js';
import { getLyricOffset, initLyricOffsetControl, updateLineTimes, updateLyricOffsetUI } from './40-playback-state.js';
import { handleAudioPlayError } from './70-audio-engine.js';
import { applyPreservesPitch } from './85-rate-download.js';
import { resetMobileLyricPreview, updateMobileLyricPreview } from './60-mobile-dual-page.js';
import { cleanupEqAudioGraph } from './90-eq.js';
import { initLyricsInteractions, setBlurBackground, setCoverImage } from './100-cover-background.js';
import { getFavorites, makeSongKey, setHint, updateFavoriteBtn } from './120-search-results.js';
import { getPlaylists } from './130-playlists.js';
import { applyVolumeOnSongChange, fadeOutVolume, handlePlayFailure } from './135-crossfade.js';
import { getStreamCachedAudioUrl } from './180-boot-config.js';
import { chorusCacheGet } from '../services/aiCache.js'; // 高潮检测缓存读取（预加载链：无依赖环，175→services 单向）
import { logWarn, logInfo, logError } from '../services/log.js';
/* { key, url, lyricData, chorusSegments, aiTheme, trackIndex } */
globalThis.preloadAbortFlag = { aborted: false };

/* 传给 loadOnlineSong 的预加载歌词 */
/* 计算下一首播放索引（不实际切歌） */
function getNextTrackIndex() {
            if (playlist.length === 0) return -1;
            if (playMode === 'loop') return currentTrackIndex;
            if (playMode === 'random') {
                if (playlist.length === 1) return currentTrackIndex;
                let idx;
                do {
                    idx = Math.floor(Math.random() * playlist.length);
                } while (idx === currentTrackIndex);
                return idx;
            }
            return (currentTrackIndex + 1) % playlist.length;
        }

/* ★ 判断歌词对象是否包含实际歌词内容（用于首曲歌词自愈：空对象则重试） */
function _hasLyricContent(d) {
    if (!d) return false;
    if (Array.isArray(d.parsedList) && d.parsedList.length > 0) return true;
    if (Array.isArray(d.lrcList) && d.lrcList.length > 0) return true;
    return !!(d.lrc || d.lrclist || d.krc || d.yrc || d.originalList || d.originalLyrics);
}

/* 为预加载获取播放URL（复用 loadOnlineSong 的URL获取逻辑，但不触碰 audio 元素）
   ★ durSec 传入真实时长让解析池防试听校验生效，避免预加载到 30~60s 试听片段 */

/* ============ 跨源回退链共享工具 ============
   历史缺陷：fetchPlayUrlForPreload 与 loadOnlineSong 各自复制了一份「QQ→酷狗→网易→酷我」
   回退链（ygking 音质阶梯 / byfuns 音质阶梯 / 同名跨源 / 酷我搜索兜底），
   修 bug 只改一处即造成两链路不一致（例如 ygking 空数据重试只存在于主链）。
   现统一收敛到此，两处调用仅保留各自差异：verbose(主链打日志) / retryEmpty(ygking 空数据重试)。
   行为逐字等价：非标记差异一律按「主链行为」为准。
   probe 参数用于单测注入（默认走 checkAudioUrlPlayable 探测），生产调用不传。 */

/* QQ：取 mid 与预取链接（/tencent?id= 服务端接口） */
async function _fetchQQMeta(songId, { verbose = false } = {}) {
    try {
        const urlJson = await fetch(`${API_BASE}/tencent?id=${songId}`).then(r => r.json());
        return {
            mid: (urlJson.code === 200 && urlJson.data && urlJson.data.mid) ? urlJson.data.mid : null,
            url: (urlJson.code === 200 && urlJson.data && urlJson.data.url) ? urlJson.data.url : null
        };
    } catch (e) {
        if (verbose) logWarn('trackIndexOnline', '获取 QQ 音乐 mid 失败:', e);
        return { mid: null, url: null };
    }
}

/* ygking 音质阶梯：依次取链 + 探测，命中即返回 {url, quality}；
   retryEmpty=true 时对「code=0 但 data 空」重试一次（load 主链行为） */
async function _tryYgkingQualities(mid, orderedQualities, {
    songId, songName = '', referer = 'https://y.qq.com/',
    retryEmpty = false, verbose = false,
    fetchImpl = fetch, probe = null
} = {}) {
    const ping = probe || ((url, sid, ref) => checkAudioUrlPlayable(url, sid, ref));
    for (const quality of orderedQualities) {
        let retried = false;
        for (;;) {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 8000);
                const resp = await fetchImpl(`https://api.ygking.top/api/song/url?mid=${mid}&quality=${quality}`, { signal: controller.signal });
                clearTimeout(timeout);
                const json = await resp.json();
                /* ygking 返回格式: {code:0, data: {mid: "url"}, quality:"320"} */
                if (json.code === 0 && json.data && json.data[mid]) {
                    const url = json.data[mid];
                    if (url && url.startsWith('http')) {
                        /* 播放性校验：取链成功≠可播，坏链换下一音质 */
                        if (await ping(url, songId, referer)) {
                            return { url, quality };
                        }
                        if (verbose) logWarn('trackIndexOnline', `ygking.top ${quality} 链接探测不可播，尝试下一音质`);
                    }
                }
                /* code=0 且 data 为空：主链可重试一次，仍空则放弃剩下音质 */
                if (json.code === 0 && (!json.data || Object.keys(json.data).length === 0)) {
                    if (!retryEmpty || retried) {
                        if (verbose) logWarn('trackIndexOnline', 'ygking.top 返回空数据(API作者cookie疑似过期/限流)，跳过剩余音质');
                        break;
                    }
                    retried = true;
                    if (verbose) logWarn('trackIndexOnline', 'ygking.top 空数据，0.5s 后重试一次...');
                    await new Promise(r => setTimeout(r, 500));
                    continue;
                }
                break;
            } catch (e) {
                if (verbose) logWarn('trackIndexOnline', `ygking.top ${quality} 获取失败:`, e.message);
                break;
            }
        }
    }
    return null;
}

/* byfuns 音质阶梯：网易云公网兜底，串行试错，返回 {url, level} 或 null */
async function _tryByfunsLevels(id, orderedLevels, {
    songId, songName = '', expSec = 0, verbose = false,
    fetchImpl = fetch, probe = null
} = {}) {
    const ping = probe || ((url, sid, _ref, sec) => checkAudioUrlPlayable(url, sid, _ref, sec));
    for (const level of orderedLevels) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            const resp = await fetchImpl(`https://api.byfuns.top/1/?id=${id}&level=${level}`, { signal: controller.signal });
            clearTimeout(timeout);
            const text = await resp.text();
            /* byfuns API 返回纯文本直链（非 JSON），需校验是有效URL */
            if (text && text.startsWith('http')) {
                const u = text.trim();
                /* VIP 歌 byfuns 常给 30s 试听链，探测整曲时长后不合格则换下一音质/跨源 */
                if (await ping(u, songId, '', expSec)) {
                    return { url: u, level };
                }
                if (verbose) logWarn('trackIndexOnline', `byfuns API ${level} 为试听/不可播，换下一音质`);
            }
        } catch (e) {
            if (verbose) logWarn('trackIndexOnline', `byfuns API ${level} 获取失败:`, e.message);
        }
    }
    return null;
}

/* 网易云：自建 /song/url/v1 直链优先（本机秒回），失败返回 null */
async function _tryNeteaseSelfhost(id, level, { songName = '', songId = '' } = {}) {
    const ctl = new AbortController();
    const tid = setTimeout(() => ctl.abort(), 8000);
    try {
        const url = await selfhostNeteasePlayUrl(id, level, ctl.signal);
        if (url) logInfo('trackIndexOnline', '[Netease] 自建 song/url/v1 直链命中:', songName || songId || id);
        return url;
    } catch (e) {
        return null;
    } finally {
        clearTimeout(tid);
    }
}

/* 跨源同名歌：酷狗 / 网易云 → 返回 {url, cover} 或 null */
async function _resolveSameSong(platform, songName, singer, { songId, expSec = 0, verbose = false } = {}) {
    try {
        const same = await fetchSameSongUrlFrom(platform, songName, singer || '');
        if (same && same.url) {
            if (await checkAudioUrlPlayable(same.url, songId, '', expSec)) {
                return { url: same.url, cover: same.cover || '' };
            }
            if (verbose) logWarn('trackIndexOnline', `[跨源] ${platform} 同名歌链接探测不可播，继续下一源`);
        }
    } catch (e) { /* 静默，继续下一源 */ }
    return null;
}

/* 兜底尾部：酷我同名歌（搜索 → 官方取链，带探测）→ 返回 {url, cover} 或 null */
async function _resolveKuwoByName(songName, singer, { songId, expSec = 0, verbose = false } = {}) {
    try {
        const query = [songName, singer].filter(Boolean).join(' ').trim();
        const kwList = await fetchKuwoSearch(query, 5, 1);
        const kwBest = (Array.isArray(kwList) && kwList.length > 0)
            ? (kwList.find(it => (it.song || '').toLowerCase() === String(songName || '').toLowerCase()) || kwList[0])
            : null;
        if (kwBest && kwBest.id) {
            const kwInfo = await getKuwoPlayInfo(String(kwBest.id), songName, singer || '');
            if (kwInfo && kwInfo.url && await checkAudioUrlPlayable(kwInfo.url, songId, '', expSec)) {
                return { url: kwInfo.url, cover: kwInfo.cover || '' };
            }
        }
    } catch (e) { /* 酷我兜底失败，放弃 */ }
    return null;
}

async function fetchPlayUrlForPreload(songId, songMid, source, songName, durSec) {
            let playUrl = null;
            /* 酷我源：一站式获取直链、封面与歌词 */
            if (source === 'kuwo' && songId) {
                const kwInfo = await getKuwoPlayInfo(songId, songName, '');
                if (kwInfo && kwInfo.url) {
                    playUrl = kwInfo.url;
                    if (kwInfo.parsedList && kwInfo.parsedList.length > 0) {
                        /* ★ key 必填：消费方（loadOnlineSong）要校验这首歌是不是它，
                           否则会把别人的歌词渲染上来。约定与本文件其它预加载一致。 */
                        _preloadedLyricData = { key: `kuwo:${songId}`, parsedList: kwInfo.parsedList, lrc: kwInfo.lrc, source: 'kuwo' };
                    }
                }
            }
            if (source === 'tencent') {
                let effectiveMid = songMid;
                let vkeysUrl = null;
                if (!effectiveMid && songId) {
                    const meta = await _fetchQQMeta(songId, {});
                    if (meta.mid) effectiveMid = meta.mid;
                    if (meta.url) vkeysUrl = meta.url;
                }

                /* 步骤0: 优先走本地解析池（与 loadOnlineSong 主链一致，服务端已校验）
                       ★ 传入用户播放音质：解析池按音质裁剪阶梯，不再强推母带FLAC（手机带宽根因）
                       ★ durSec 为预加载曲目的真实时长，让防试听校验生效（缺省回落 0=跳过校验） */
                const userQuality = (appSettings.quality && appSettings.quality.qqPlayback) || '320';
                /* ★ 与网易云分支（下方 _tryNeteaseSelfhost）对齐：本机自建 QQ 取链优先。
                   历史缺口：这一步原先只加在 loadOnlineSong 主链上，而「预加载下一首」与
                   「排行榜直接播放」（258-rankings.js 也调本函数）走的是这条链，没有它 →
                   表现为「QQ 已扫码登录，却仍走 ygking/vkeys 外链，且明显更慢」。
                   注意顺序与主链一致：自建 → 本地解析池 → ygking → vkeys → 跨源。 */
                const expSec = durSec || 0;
                if (effectiveMid && !playUrl) {
                    try {
                        const shUrl = await selfhostQQPlayUrl(effectiveMid, userQuality);
                        if (shUrl && await checkAudioUrlPlayable(shUrl, songId, 'https://y.qq.com/', expSec)) {
                            playUrl = shUrl;
                            logInfo('trackIndexOnline', `[SelfHost] QQ 自建服务命中(预加载): ${songName}`);
                        } else if (shUrl) {
                            logWarn('trackIndexOnline', '[SelfHost] QQ 自建链接探测不可播，落回原链(预加载)');
                        }
                    } catch { /* 未启用/未登录/失败：静默落回原链 */ }
                }
                if (effectiveMid && !playUrl) {
                    const resolved = await qqResolveUrl(effectiveMid, durSec || 0, userQuality);
                    if (resolved) playUrl = resolved;
                }

                const YGK_QUALITIES = ['master', 'atmos', 'flac', '320', '128'];
                const orderedQualities = [userQuality, ...YGK_QUALITIES.filter(q => q !== userQuality)];
                /* 解析池已命中时跳过ygking循环，防止低音质覆盖母带结果（预加载静默、不重试空数据） */
                if (effectiveMid && !playUrl) {
                    const hit = await _tryYgkingQualities(effectiveMid, orderedQualities, { songId, songName });
                    if (hit) playUrl = hit.url;
                }
                if (!playUrl) {
                    if (vkeysUrl && await checkAudioUrlPlayable(vkeysUrl, songId, 'https://y.qq.com/')) {
                        playUrl = vkeysUrl;
                    } else if (!vkeysUrl) {
                        const meta2 = await _fetchQQMeta(songId, {});
                        if (meta2.url && await checkAudioUrlPlayable(meta2.url, songId, 'https://y.qq.com/')) playUrl = meta2.url;
                    }
                }
                /* 跨源同名歌兜底（与 loadOnlineSong 主链一致）：酷狗 → 网易云 → 酷我（用户规定的退回链尾部） */
                if (!playUrl && songName) {
                    const hit = await _resolveSameSong('kugou', songName, '', { songId });
                    if (hit) playUrl = hit.url;
                }
                if (!playUrl && songName) {
                    const hit = await _resolveSameSong('netease', songName, '', { songId });
                    if (hit) playUrl = hit.url;
                }
                /* 兜底尾部：酷我同名歌（搜索 → 官方取链，带探测） */
                if (!playUrl && songName) {
                    const hit = await _resolveKuwoByName(songName, '', { songId });
                    if (hit) playUrl = hit.url;
                }
            } else if (source === 'netease') {
                const userLevel = (appSettings.quality && appSettings.quality.neteasePlayback) || 'exhigh';
                const QUALITY_LEVELS = ['hires', 'lossless', 'exhigh', 'higher', 'standard'];
                const orderedLevels = [userLevel, ...QUALITY_LEVELS.filter(q => q !== userLevel)];
                const expSec = durSec || 0;
                /* ★ 上游参考项目 对齐：本机自建网易云 /song/url/v1 一次直链优先（本机+登录cookie 秒回），
                   自建离线才走公网 byfuns 串行音质试错 */
                if (!playUrl) {
                    playUrl = await _tryNeteaseSelfhost(songId, userLevel, { songName, songId });
                }
                if (!playUrl) {
                    const hit = await _tryByfunsLevels(songId, orderedLevels, { songId, songName, expSec });
                    if (hit) playUrl = hit.url;
                }
                /* 原实现此处先赋值 outer 外链、再判 !playUrl 做酷狗兜底——该分支恒假（死代码），
                   预加载语义就是「宁取外链保住备用地址」，跨源兜底交给播放时主链，此处保持不回退 */
                if (!playUrl) playUrl = `https://music.163.com/song/media/outer/url?id=${songId}`;
            } else {
                try {
                    const urlJson = await fetch(`${API_BASE}/${source}?id=${songId}`).then(r => r.json());
                    playUrl = (urlJson.code === 200 && urlJson.data && urlJson.data.url) ? urlJson.data.url : null;
                } catch (e) { /* 静默 */ }
            }
            return playUrl;
        }

/* 预加载下一首歌的所有资源 */
async function preloadNextSong() {
            const nextIdx = getNextTrackIndex();
            if (nextIdx < 0 || nextIdx >= playlist.length) return;
            const track = playlist[nextIdx];
            /* 仅预加载在线歌曲 */
            if (!track.source || !track.id) return;
            const effectiveSource = track.source || (track.mid ? 'tencent' : 'netease');
            const songKey = `${effectiveSource}:${track.id}`;
            /* 如果已经预加载了同一首歌，跳过 */
            if (nextSongPreload && nextSongPreload.key === songKey && nextSongPreload.trackIndex === nextIdx) return;
            /* 中止上一次预加载 */
            preloadAbortFlag.aborted = true;
            const myFlag = { aborted: false };
            preloadAbortFlag = myFlag;

            try {
                const preloadData = { key: songKey, trackIndex: nextIdx, url: null, lyricData: null, chorusSegments: null, aiTheme: null };
                logInfo('trackIndexOnline', '[Preload] 开始预加载下一首:', track.title);

                /* 并行获取 URL 和歌词（使用 oiapi.net 备用） */
                const urlPromise = fetchPlayUrlForPreload(String(track.id), track.mid || '', effectiveSource, track.title,
                    intervalToSec(track.interval) || track.duration || 0);
                const lyricPromise = fetchLyricWithFallback(String(track.id), effectiveSource)
                    .catch(() => null);

                /* ★ 预加载封面图（让切歌时封面/背景立即交叉淡入，不等网络下载） */
                if (track.cover) {
                    const coverImg = new Image();
                    coverImg.src = track.cover;
                }

                preloadData.url = await urlPromise;
                if (myFlag.aborted) return;
                preloadData.lyricData = await lyricPromise;
                if (myFlag.aborted) return;

                /* 预加载高潮检测（仅检查缓存，避免下载音频影响当前播放） */
                if (!myFlag.aborted) {
                    const chorusCacheKey = `${track.title} - ${track.artist || ''}`;
                    try {
                        const cached = await chorusCacheGet(chorusCacheKey);
                        if (cached) {
                            preloadData.chorusSegments = cached.chorusSegments;
                            logInfo('trackIndexOnline', '[Preload] 高潮检测命中缓存:', track.title);
                        }
                    } catch (e) { /* 静默 */ }
                }

                /* AI 分析预加载已移除：改为播放时实时分析，确保情感词正确渲染 */

                if (!myFlag.aborted) {
                    nextSongPreload = preloadData;
                    logInfo('trackIndexOnline', '[Preload] 预加载完成:', track.title, { hasUrl: !!preloadData.url, hasLyrics: !!preloadData.lyricData, hasChorus: !!preloadData.chorusSegments, hasAI: !!preloadData.aiTheme });
                }
            } catch (err) {
                if (!myFlag.aborted) {
                    logWarn('trackIndexOnline', '[Preload] 预加载失败:', err);
                }
            }
        }

/* 应用预加载的AI主题（虚拟流式输出） */
async function applyPreloadedAiTheme(themeObj) {
            if (!themeObj) return;
            const ai = appSettings.ai;
            if (!ai.apiKey || ai.apiKey.trim().length < 5) return;
            /* 快速虚拟流式显示 */
            if (typeof showAiPanel === 'function') {
                showAiPanel('AI 分析中...', `《${currentSongData?.title || ''}》- ${currentSongData?.artist || ''}`);
            }
            /* 短暂延迟模拟流式分析 */
            await new Promise(r => setTimeout(r, 600));
            if (typeof applyAITheme === 'function') {
                applyAITheme(themeObj);
            }
            if (typeof setAiPanelDone === 'function') {
                setAiPanelDone('AI 分析完成', `情绪：${themeObj.mood || '未知'} · ${themeObj.animation_style}`);
            }
            if (typeof hideAiPanel === 'function') {
                hideAiPanel(3000);
            }
            /* 更新设置面板状态 */
            const statusText = typeof document !== 'undefined' ? document.getElementById('aiStatusText') : null;
            const statusDetail = typeof document !== 'undefined' ? document.getElementById('aiStatusDetail') : null;
            if (statusText) statusText.textContent = '分析完成';
            if (statusDetail) statusDetail.textContent = `情绪：${themeObj.mood || '未知'} · 风格：${themeObj.animation_style}`;
        }

if (typeof window !== 'undefined') window.preloadNextSong = preloadNextSong;

async function loadOnlineSong(songInfo, skipPlaylistUpdate, _isRetry, preloadOnly) {
            /* ★ NPS 接管只读显示模式：阻断 Aria 内部任何自动切歌
               （开篇歌单自动播放/队列自动下一首/每日推荐续推）——接管期间
               除了「用户被禁的控件」，能触发 loadOnlineSong 的只剩自动流程，
               直接短路可避免换 src/换封面/换歌词干扰接管显示。 */
            if (typeof window !== 'undefined' && window.Aria && window.Aria.__npActive && window.Aria.__npActive()) {
                return Promise.resolve(false);
            }
            /* 代际计数器递增：使所有上一次的异步回调（canplay监听器、超时、fade回调）过期 */
            const gen = ++playbackGeneration;
            /* 如果上一次加载未完成，强制中止（而非直接 return 丢弃新请求） */
            isLoadingSong = true;
            const songId = songInfo.id;
            const songMid = songInfo.mid;   /* 仅QQ有 */
            if (!songId) { setHint('无法获取歌曲ID'); isLoadingSong = false; return; }

/* 立即暂停并重置 audio，取消上一次的加载 */
audio.pause();

/* 取消正在进行的 AI 分析（避免旧请求的 finally 误重设新请求的状态） */
if (typeof isAiAnalyzing !== 'undefined' && isAiAnalyzing && typeof currentAiAbortController !== 'undefined' && currentAiAbortController) {
    currentAiAbortController._manualCancel = true;
    currentAiAbortController.abort();
    currentAiAbortController = null;
    isAiAnalyzing = false;
}

/* ★ 即时 UI 响应：先更新标题、歌手、封面、背景，让用户立刻看到切换 */
            /* 封面/背景在预加载模式下也需要设置（否则初始歌曲无背景） */
            try {
                songTitleEl.textContent = songInfo.song || '未知歌曲';
                songArtistEl.textContent = songInfo.singer || '未知歌手';
                if (songInfo.cover) {
                    setCoverImage(songInfo.cover);
                    setBlurBackground(songInfo.cover);
                }
                if (!preloadOnly) {
                    /* 立即暂停上一首歌，防止新歌网络请求期间继续播放旧歌 */
                    try {
                        audio.pause();
                        audio.removeAttribute('src');
                    } catch (e) { logWarn('trackIndex', e); }
                    /* 清空歌词区域与状态 */
                    lyrics = [];
                    activeLineIndex = -1;
                    currentTime = 0;
                    aiEmotionWords = [];
                    lyricSourceOverride = null;  /* 切歌时重置歌词来源覆盖 */
                    totalTimeEl.textContent = '00:00';
                    if (currentTimeEl) currentTimeEl.textContent = '00:00';
                    /* 重置移动端预览歌词为加载中... */
                    resetMobileLyricPreview('加载中...');
                    /* 进度条非线性回退到 0 */
                    if (progressEl) {
                        progressEl.style.transition = 'width 0.6s cubic-bezier(0.4, 0, 0.2, 1)';
                        progressEl.style.width = '0%';
                        setTimeout(() => { if (progressEl) progressEl.style.transition = ''; }, 700);
                    }
                    /* 底部进度条也回退 */
                    const _bottomBar = typeof document !== 'undefined' ? document.getElementById('bottomProgressBar') : null;
                    if (_bottomBar) {
                        _bottomBar.style.transition = 'width 0.6s cubic-bezier(0.4, 0, 0.2, 1)';
                        _bottomBar.style.width = '0%';
                        setTimeout(() => { if (_bottomBar) _bottomBar.style.transition = ''; }, 700);
                    }
                    const _lrcScroll = typeof document !== 'undefined' ? document.getElementById('lyricsScroll') : null;
                    if (_lrcScroll) {
                        /* ★ 走骨架时序规范：切歌/加载歌词时不再直接写骨架（快响应会闪） */
                        if (Aria.skeleton) Aria.skeleton.load(_lrcScroll, 'lyrics', 7);
                        else _lrcScroll.innerHTML = '<div class="skeleton-lyrics">加载中...</div>';
                    }
                    /* 高潮标记渐隐消失 */
document.querySelectorAll('.chorus-marker').forEach(el => {
                        el.style.transition = 'opacity 0.4s ease';
                        el.style.opacity = '0';
                        setTimeout(() => el.remove(), 400);
                    });
                    /* ★ 当前歌曲高潮段落：currentChorusSegments 定义在 200-settings-panel，此处经 globalThis 访问（分片模块作用域隔离） */
                    globalThis.currentChorusSegments = [];
                    /* 显示加载提示 */
                    if (typeof setHint === 'function') setHint('加载中...');
                }
            } catch (uiErr) {
                logWarn('trackIndexOnline', '[UI] 即时更新出错（不影响加载）:', uiErr);
            }

            /* 淡出当前音量（与网络请求并行）——预加载模式下无需淡出 */
            if (appSettings.playback.fadeInOut && !_isRetry && !preloadOnly) {
                fadeOutVolume(appSettings.playback.fadeDuration);
            }

            /* 清除其他项的状态标签，标记当前项为"加载中..." */
            searchResultsEl.querySelectorAll('.result-item').forEach(el => {
                const statusEl = el.querySelector('.result-status');
                if (statusEl) statusEl.textContent = '';
            });
            const songIdx = searchResultsCache.indexOf(songInfo);
            const selectedEl = searchResultsEl.querySelector(`.result-item[data-idx="${songIdx}"]`);
            if (selectedEl) {
                const statusEl = selectedEl.querySelector('.result-status');
                if (statusEl) statusEl.textContent = '加载中...';
            }

            try {
                /* ★ 提前发起歌词请求（与播放链接获取并行，歌词获取很快）
                   使用 oiapi.net / kugou / kuwo 备用：失败时自动回退 */
                let lyricPromise;
                /* ★★ 消费预加载歌词前必须校验「它是不是这首歌的」。
                   该变量由 fetchPlayUrlForPreload 写入（预加载下一首 / 258-rankings 直接播放），
                   原先只要非空就直接采用 → 若消费方是**另一首歌**（快速切歌、预加载被中断、
                   从搜索或榜单点歌），就会把别人的歌词渲染上来。
                   实测症状：英文歌配中文歌词、「歌词不对应/有时候不准」。
                   key 约定与 nextSongPreload 一致：`${source}:${id}`。 */
                const _preLyricKey = `${songInfo.source || currentSource}:${songInfo.id}`;
                if (_preloadedLyricData && _preloadedLyricData.key === _preLyricKey) {
                    lyricPromise = Promise.resolve(_preloadedLyricData);
                } else if (currentSource === 'kugou' || songInfo.source === 'kugou') {
                    lyricPromise = fetchKugouLyric(songInfo);
                } else if (currentSource === 'kuwo' || songInfo.source === 'kuwo') {
                    lyricPromise = fetchLyricWithFallback(songInfo, 'kuwo');
                } else {
                    /* ★ 传 songInfo 对象而非 songId 字符串：让 fetchLyricWithFallback
                       优先用 songInfo.source 作为歌词接口音源，避免依赖模块级 currentSource
                       （预加载并发可能改写它）导致查错后端返回 {} 而「有音无词」。 */
                    lyricPromise = fetchLyricWithFallback(songInfo, currentSource)
                        .catch(lyricErr => {
                            logWarn('trackIndexOnline', '歌词获取失败，跳过歌词:', lyricErr);
                            return {};
                        });
                }
                _preloadedLyricData = null;  /* 清除预加载歌词，避免影响下一次 */

                /* 获取播放链接 */
                let playUrl;
                if (songInfo.url && (songInfo.source === 'local' || songInfo.isRandomApi || (!songInfo.url.includes('stream.qqmusic.qq.com') && !songInfo.url.includes('api.vkeys.cn')))) {
                    /* 已有直链（如本地音乐、自定义外链、随机 API 返回的 Music 字段） */
                    playUrl = songInfo.url;
                } else if (currentSource === 'kugou' || songInfo.source === 'kugou') {
                    /* 酷狗音乐：通过 hash 获取播放直链（含多源回退） */
                    const hash = songInfo.hash || songMid || songId;
                    const expSec = intervalToSec(songInfo.interval) || songInfo.duration || 0;
                    const kgInfo = await getKugouPlayInfo(hash, songInfo.song || songInfo.title || songInfo.name, songInfo.singer || songInfo.artist);
                    if (kgInfo && kgInfo.url) {
                        /* VIP 未开通时酷狗常给 30s 试听链，须探测整曲时长后决定是否回退跨源 */
                        if (await checkAudioUrlPlayable(kgInfo.url, songId, '', expSec)) {
                            playUrl = kgInfo.url;
                            if (kgInfo.cover && !songInfo.cover) {
                                songInfo.cover = kgInfo.cover;
                                /* ★ 酷狗封面同步应用：搜索项常无 img，封面在 playInfo 才返回；
                                   立即设置避免等后续钩子,否则整曲解析完成前一直没封面 */
                                setCoverImage(kgInfo.cover);
                                setBlurBackground(kgInfo.cover);
                            }
                            logInfo('trackIndexOnline', `酷狗音乐获取成功: ${songInfo.song}`);
                        } else {
                            logWarn('trackIndexOnline', `[KuGou] ${songInfo.song} 链接为试听/不可播，回退跨源`);
                        }
                    }
                    if (!playUrl && songInfo.song) {
                        const kgSame = await fetchSameSongUrlFrom('netease', songInfo.song, songInfo.singer || '').catch(() => null);
                        if (kgSame && kgSame.url && await checkAudioUrlPlayable(kgSame.url, songId, '', expSec)) playUrl = kgSame.url;
                    }
                    if (!playUrl && songInfo.song) {
                        try {
                            const kwList = await fetchKuwoSearch(`${songInfo.song} ${songInfo.singer || ''}`.trim(), 5, 1);
                            const kwBest = (Array.isArray(kwList) && kwList.length > 0)
                                ? (kwList.find(it => (it.song || '').toLowerCase() === (songInfo.song || '').toLowerCase()) || kwList[0])
                                : null;
                            if (kwBest && kwBest.id) {
                                const kwInfo = await getKuwoPlayInfo(String(kwBest.id), songInfo.song, songInfo.singer || '');
                                if (kwInfo && kwInfo.url && await checkAudioUrlPlayable(kwInfo.url, songId, '', expSec)) playUrl = kwInfo.url;
                            }
                        } catch (e) { /* 酷我兜底失败，放弃 */ }
                    }
                } else if (currentSource === 'kuwo' || songInfo.source === 'kuwo') {
                    /* 酷我音乐：一站式获取官方直链、500x500高清封面与原版LRC歌词 */
                    const kuwoId = songInfo.kuwoId || songId;
                    const songName = songInfo.song || songInfo.title || songInfo.name || '';
                    const singerName = songInfo.singer || songInfo.artist || '';
                    const kwInfo = await getKuwoPlayInfo(kuwoId, songName, singerName);
                    if (kwInfo && kwInfo.url) {
                        playUrl = kwInfo.url;
                        if (kwInfo.cover && (!songInfo.cover || songInfo.cover.includes('img4.kuwo.cn/star/albumcover/'))) {
                            songInfo.cover = kwInfo.cover;
                            setCoverImage(kwInfo.cover);
                            setBlurBackground(kwInfo.cover);
                        }
                        /* 歌词赋值：优先使用已解析的 parsedList，否则透传完整歌词对象给 detectAndParseLyrics */
                        if (kwInfo.parsedList && kwInfo.parsedList.length > 0) {
                            lyricPromise = Promise.resolve({
                                parsedList: kwInfo.parsedList,
                                lrc: kwInfo.lrc,
                                source: 'kuwo'
                            });
                        } else if (kwInfo.lyricObj && (kwInfo.lyricObj.yrc || kwInfo.lyricObj.lrc)) {
                            /* 跨源回退返回的完整歌词对象（含 yrc/lrc/trans/roma） */
                            lyricPromise = Promise.resolve(kwInfo.lyricObj);
                        } else if (kwInfo.lrc && kwInfo.lrc.includes('[')) {
                            /* 纯 LRC 文本字符串，包装为对象给 detectAndParseLyrics */
                            lyricPromise = Promise.resolve({ lrc: kwInfo.lrc });
                        }
                        logInfo('trackIndexOnline', `[Kuwo] 一站式解析成功: ${songName}`);
                    }
                } else if (currentSource === 'tencent') {
                    let effectiveMid = songMid;
                    let vkeysUrl = null;
                    if (!effectiveMid && songId) {
                        const meta = await _fetchQQMeta(songId, { verbose: true });
                        if (meta.mid) effectiveMid = meta.mid;
                        if (meta.url) vkeysUrl = meta.url;
                    }

                    /* 步骤0: 优先走本地解析池（多API竞速 + 防试听校验 + 15min缓存）
                       服务端已做 Range+魔数+时长 校验，此处无需重复探测
                       ★ 传入用户播放音质：解析池按音质裁剪阶梯，不再强推母带FLAC（手机带宽根因） */
                    const userQuality = (appSettings.quality && appSettings.quality.qqPlayback) || '320';
                    /* 步骤0: 自建QQ服务（设置已启用 + 已扫码登录）优先取高音质；
                       任何失败/未启用/未登录返回 null，安全落回下方原链
                       ★ 传期望整曲时长，无 VIP 账号拿到的 30s 试听链会被判不可播并回退 */
                    const shDurSec = intervalToSec(songInfo.interval) || songInfo.duration || 0;
                    if (effectiveMid && !playUrl) {
                        const shUrl = await selfhostQQPlayUrl(effectiveMid, userQuality);
                        if (shUrl && await checkAudioUrlPlayable(shUrl, songId, 'https://y.qq.com/', shDurSec)) {
                            playUrl = shUrl;
                            logInfo('trackIndexOnline', `[SelfHost] QQ 自建服务命中: ${songInfo.song}`);
                        } else if (shUrl) {
                            logWarn('trackIndexOnline', '[SelfHost] QQ 自建服务链接探测不可播/试听，落回原链');
                        }
                    }
                    if (effectiveMid && !playUrl) {
                        const durSec = intervalToSec(songInfo.interval) || songInfo.duration || 0;
                        const resolved = await qqResolveUrl(effectiveMid, durSec, userQuality);
                        if (resolved) {
                            playUrl = resolved;
                            logInfo('trackIndexOnline', `[QQResolve] 本地解析池命中: ${songInfo.song}`);
                        }
                    }

                    /* QQ音乐：优先 ygking.top，使用用户设置的播放音质，失败回退到其他音质 */
                    const YGK_QUALITIES = ['master', 'atmos', 'flac', '320', '128'];
                    /* 用户选择的音质排在最前，其余按高→低排列 */
                    const orderedQualities = [userQuality, ...YGK_QUALITIES.filter(q => q !== userQuality)];
                    /* 解析池已命中时跳过ygking循环，防止低音质覆盖母带结果 */
                    if (effectiveMid && !playUrl) {
                        const ygkHit = await _tryYgkingQualities(effectiveMid, orderedQualities, {
                            songId, songName: songInfo.song, retryEmpty: true, verbose: true
                        });
                        if (ygkHit) {
                            playUrl = ygkHit.url;
                            logInfo('trackIndexOnline', `ygking.top 获取成功 (音质: ${ygkHit.quality}): ${songInfo.song}`);
                        }
                    }
                    /* 步骤2: ygking 失败，回退到 vkeys.cn 接口 */
                    if (!playUrl) {
                        /* vkeys 试听链常对VIP歌不可播，须先探测再采用（用户策略核心闭环） */
                        if (vkeysUrl && await checkAudioUrlPlayable(vkeysUrl, songId, 'https://y.qq.com/')) {
                            playUrl = vkeysUrl;
                            logInfo('trackIndexOnline', `vkeys 预取链接可用: ${songInfo.song}`);
                        } else if (vkeysUrl) {
                            logWarn('trackIndexOnline', 'vkeys 预取链接探测不可播(疑似失效/试听链)，走跨源');
                        } else {
                            const fetchController = new AbortController();
                            const fetchTimeout = setTimeout(() => fetchController.abort(), 10000);
                            try {
                                const urlJson = await fetch(`${API_BASE}/tencent?id=${songId}`, { signal: fetchController.signal }).then(r => r.json());
                                const fetchedUrl = (urlJson.code === 200 && urlJson.data && urlJson.data.url) ? urlJson.data.url : null;
                                if (fetchedUrl && await checkAudioUrlPlayable(fetchedUrl, songId, 'https://y.qq.com/')) {
                                    playUrl = fetchedUrl;
                                    logInfo('trackIndexOnline', `vkeys 获取成功: ${songInfo.song}`);
                                } else if (fetchedUrl) {
                                    logWarn('trackIndexOnline', 'vkeys 返回链接探测不可播，走跨源');
                                }
                            } catch (fetchErr) {
                                logWarn('trackIndexOnline', 'QQ音乐 vkeys 请求失败:', fetchErr);
                            } finally {
                                clearTimeout(fetchTimeout);
                            }
                        }
                    }
                    /* 步骤3-5: QQ/vkeys 均取不到或不可播，走退回链：酷狗 → 网易云 → 酷我 */
                    if (!playUrl) {
                        logWarn('trackIndexOnline', 'QQ源全部失败，尝试酷狗同名歌...');
                        const kgHit = await _resolveSameSong('kugou', songInfo.song, songInfo.singer, { songId, verbose: true });
                        if (kgHit) { playUrl = kgHit.url; if (kgHit.cover && !songInfo.cover) songInfo.cover = kgHit.cover; }
                    }
                    if (!playUrl) {
                        logWarn('trackIndexOnline', '酷狗也未命中，尝试网易云同名歌...');
                        const ncmHit = await _resolveSameSong('netease', songInfo.song, songInfo.singer, { songId, verbose: true });
                        if (ncmHit) { playUrl = ncmHit.url; if (ncmHit.cover && !songInfo.cover) songInfo.cover = ncmHit.cover; }
                    }
                    if (!playUrl) {
                        logWarn('trackIndexOnline', '网易云也未命中，最后尝试酷我同名歌...');
                        const kwHit = await _resolveKuwoByName(songInfo.song, songInfo.singer, { songId, verbose: true });
                        if (kwHit) { playUrl = kwHit.url; if (kwHit.cover && !songInfo.cover) songInfo.cover = kwHit.cover; }
                    }
                } else if (currentSource === 'netease') {
                    /* 网易云：★ 上游参考项目 对齐先试本机自建 /song/url/v1 直链（秒回），失败再走公网 byfuns 音质阶梯 */
                    const userLevel = (appSettings.quality && appSettings.quality.neteasePlayback) || 'exhigh';
                    const QUALITY_LEVELS = ['hires', 'lossless', 'exhigh', 'higher', 'standard'];
                    const orderedLevels = [userLevel, ...QUALITY_LEVELS.filter(q => q !== userLevel)];
                    const nmExpSec = intervalToSec(songInfo.interval) || songInfo.duration || 0;
                    if (!playUrl) {
                        playUrl = await _tryNeteaseSelfhost(songId, userLevel, { songName: songInfo.song, songId });
                    }
                    if (!playUrl) {
                        const byfHit = await _tryByfunsLevels(songId, orderedLevels, {
                            songId, songName: songInfo.song, expSec: nmExpSec, verbose: true
                        });
                        if (byfHit) {
                            playUrl = byfHit.url;
                            logInfo('trackIndexOnline', `byfuns API 获取成功 (音质: ${byfHit.level}): ${songInfo.song}`);
                        }
                    }
                    /* byfuns 全部失败时，回退到网易云外链 */
                    if (!playUrl) {
                        logWarn('trackIndexOnline', 'byfuns API 全部音质失败，回退到网易云外链');
                        playUrl = `https://music.163.com/song/media/outer/url?id=${songId}`;
                    }
                    /* VIP 试听/外链不可播时跨源兜底：酷狗 → 酷我 */
                    if (!playUrl && songInfo.song) {
                        const kgHit = await _resolveSameSong('kugou', songInfo.song, songInfo.singer, { songId, expSec: nmExpSec });
                        if (kgHit) playUrl = kgHit.url;
                    }
                    if (!playUrl && songInfo.song) {
                        const kwHit = await _resolveKuwoByName(songInfo.song, songInfo.singer, { songId, expSec: nmExpSec });
                        if (kwHit) playUrl = kwHit.url;
                    }
                } else {
                    /* 未知音源走 vkeys 接口 */
                    const fetchController = new AbortController();
                    const fetchTimeout = setTimeout(() => fetchController.abort(), 10000);
                    try {
                        const urlJson = await fetch(`${API_BASE}/${currentSource}?id=${songId}`, { signal: fetchController.signal }).then(r => r.json());
                        playUrl = (urlJson.code === 200 && urlJson.data && urlJson.data.url) ? urlJson.data.url : null;
                    } catch (fetchErr) {
                        logWarn('trackIndexOnline', '获取播放链接请求失败:', fetchErr);
                    } finally {
                        clearTimeout(fetchTimeout);
                    }
                }
                if (!playUrl) {
                    if (selectedEl) {
                        const statusEl = selectedEl.querySelector('.result-status');
                        if (statusEl) statusEl.textContent = '获取失败';
                    }
                    /* 获取播放链接失败也尝试重试 */
                    if (handlePlayFailure(songInfo, skipPlaylistUpdate)) return;
                    isLoadingSong = false;
                    return;
                }

                /* ★ 移除 URL HEAD 预检（no-cors 预检不可靠且增加 5 秒延迟）
                   直接开始音频加载，URL 失效时由 audio error 事件触发重试 */

                /* 歌词请求（已提前并行发起，此处 await 获取结果） */
                let lyricJson = await lyricPromise;

                /* ★ 首曲歌词自愈：冷启动时外网歌词接口往往慢/超时（无预加载、无服务器热缓存），
                   首杯请求常返回空对象导致「第一首歌没有歌词」。此处若为空则等待后重试（最多 2 次，
                   指数退避 1.2s/3s），并在重试时带上缓存绕过参数，最大限度消除启动初期歌词空窗。 */
                if (lyricJson && !_hasLyricContent(lyricJson)) {
                    const retryDelays = [1200, 3000];
                    for (const delay of retryDelays) {
                        logWarn('trackIndexOnline', `[Lyric] 首曲歌词为空，${delay}ms 后重试...`);
                        await new Promise(r => setTimeout(r, delay));
                        if (gen !== playbackGeneration) return;
                        try {
                            const retryRes = await fetchLyricWithFallback(
                                songInfo,
                                lyricSourceOverride || (songInfo && songInfo.source) || currentSource
                            ).catch(() => ({}));
                            if (retryRes && _hasLyricContent(retryRes)) {
                                lyricJson = retryRes;
                                logWarn('trackIndexOnline', '[Lyric] 首曲歌词重试成功。');
                                break;
                            }
                        } catch (e) { /* 继续下一轮退避重试 */ }
                    }
                }

                /* 代际检查：网络请求期间用户可能已切歌，放弃本次加载 */
                if (gen !== playbackGeneration) return;

                /* 设置音频并播放（不覆盖已有播放队列） */
                if (!skipPlaylistUpdate) {
                    playlist = [{
                        url: playUrl,
                        title: songInfo.song,
                        artist: songInfo.singer,
                        cover: songInfo.cover || '',
                        source: currentSource,
                        id: songInfo.id,
                        mid: songMid || ''
                    }];
                    currentTrackIndex = 0;
                }

                /* 关键修复：先暂停并重置 audio，避免上一首歌的 readyState 干扰 */
                audio.pause();
                audio.removeAttribute('src');

                /* 清理旧的 Web Audio 图，防止内存泄漏 */
                cleanupEqAudioGraph();
                eqInitFailed = false; /* 重置失败标志，新歌曲可以重新尝试 */

                /* 关键修复：在 audio.load() 之前就挂载 canplay 监听器，消除竞态条件 */
                const playPromise = new Promise((resolve, reject) => {
                    let settled = false;
                    let timeoutId = null;
                    const cleanup = () => {
                        if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
                        audio.removeEventListener('canplay', onReady);
                        audio.removeEventListener('loadeddata', onReady);
                        audio.removeEventListener('error', onErr);
                    };
                    const onReady = () => {
                        if (settled) return;
                        settled = true;
                        cleanup();
                        resolve();
                    };
                    const onErr = () => {
                        if (settled) return;
                        settled = true;
                        cleanup();
                        reject(new Error('audio_load_error'));
                    };
                    audio?.addEventListener('canplay', onReady, { once: true });
                    audio?.addEventListener('loadeddata', onReady, { once: true });
                    audio?.addEventListener('error', onErr, { once: true });
                    /* 超时保护：8秒后检查就绪状态再决定是否播放 */
                    timeoutId = setTimeout(() => {
                        if (!settled) {
                            settled = true;
                            cleanup();
                            if (audio.readyState >= 2 && !audio.error) {
                                resolve();
                            } else {
                                reject(new Error('audio_load_timeout'));
                            }
                        }
                    }, 8000);
                });

                /* 现在设置 src 并加载——监听器已就位，canplay 不会被错过 */
                audio.src = getStreamCachedAudioUrl(playUrl, songMid || songInfo.id || songInfo.song);
                audio.load();
                audio.playbackRate = currentPlaybackRate;
                applyPreservesPitch(preservesPitch);
                songTitleEl.textContent = songInfo.song;
                songArtistEl.textContent = songInfo.singer;

                /* 更新当前歌曲信息与收藏按钮状态 */
                currentSongData = {
                    title: songInfo.song,
                    artist: songInfo.singer,
                    cover: songInfo.cover || '',
                    source: currentSource,
                    id: songInfo.id,
                    mid: songMid || '',
                    interval: songInfo.interval || ''
                };
                /* ★ 最近播放：加载即记录（不依赖 play 成功，避免自动播放策略挂起导致漏记） */
                if (typeof window.recordRecentPlay === 'function') {
                    window.recordRecentPlay(currentSongData);
                }
                currentSongKey = makeSongKey(currentSongData);
                lyricOffset = getLyricOffset(currentSongKey); updateLyricOffsetUI();
                updateLineTimes();
                updateFavoriteBtn();

                /* 更新搜索结果状态标签 */
                if (selectedEl) {
                    const statusEl = selectedEl.querySelector('.result-status');
                    if (statusEl) statusEl.textContent = '正在播放';
                }

                /* 封面与背景已在上方"即时 UI 响应"块中设置，此处不再重复调用
                   （重复调用会导致交叉淡入被撤销，背景不切换） */

                /* 解析歌词并渲染 */
                const lyricData = lyricJson || {};
                let { originals, translations, romaji } = detectAndParseLyrics(lyricData);
                /* ★ 解析后空行兜底：接口返回了内容但仍解析出 0 行（空壳歌词/格式异常/纯占位），
                   再走一次跨源歌词（fetchLyricWithFallback 内部自带 酷狗→网易 同名兜底），
                   最大化消除"歌词是空的"场景 */
                if ((!originals || originals.length === 0) && gen === playbackGeneration) {
                    logWarn('trackIndexOnline', '[Lyric] 歌词解析后为空行，尝试跨源重取一次...');
                    try {
                        const reFetch = await fetchLyricWithFallback(
                            songInfo,
                            lyricSourceOverride || (songInfo && songInfo.source) || currentSource
                        ).catch(() => ({}));
                        const reparsed = detectAndParseLyrics(reFetch);
                        if (reparsed.originals && reparsed.originals.length > 0) {
                            originals = reparsed.originals;
                            translations = reparsed.translations;
                            romaji = reparsed.romaji;
                            logWarn('trackIndexOnline', '[Lyric] 跨源重取解析成功。');
                        }
                    } catch (e) { /* 保留原空结果，不阻塞播放 */ }
                }
                lyrics = mergeLyrics(originals, translations, romaji);
                activeLineIndex = -1;
                currentTime = 0;
                /* 切歌时清理上一首歌的 AI 情感词，避免跨歌泄漏 */
                aiEmotionWords = [];
                renderLyrics(lyrics);
                /* ★ 翻译补齐：当前歌词无翻译/翻译为空时，后台跨源补齐双语翻译并实时刷新。
   首选网易云官方双语接口（lrc + tlyric 一起返回、最稳定），经本地 /proxy 代理规避 CORS；
   失败则回退 vkeys 网易云歌词（也常带 trans）。补齐后重渲染，
   列表 / 飞入 / 蒙德里安翻译区都会显示；失败不影响播放（静默）。 */
                if (!lyrics.some(l => l.translation && l.translation.trim() && l.translation.trim() !== '//')) {
                    (async () => {
                        try {
                            const word = `${songInfo.song || ''} ${songInfo.singer || ''}`.trim();
                            if (!word) return;
                            const nRes = await fetch(`${API_BASE}/netease?word=${encodeURIComponent(word)}&num=1`)
                                .then(r => r.json()).catch(() => ({}));
                            const sItem = (nRes.code === 200 && nRes.data) ? (Array.isArray(nRes.data) ? nRes.data[0] : nRes.data) : null;
                            if (!(sItem && sItem.id)) return;

                            /* 首选：网易云官方 /api/song/lyric（tlyric.lyric = 翻译，与 lrc 同源对齐） */
                            let parsedN = null;
                            try {
                                const nApiUrl = `https://music.163.com/api/song/lyric?id=${encodeURIComponent(String(sItem.id))}&lv=1&kv=1&tv=1`;
                                const nJson = await fetch(`/proxy?url=${encodeURIComponent(nApiUrl)}`)
                                    .then(r => r.json()).catch(() => ({}));
                                if (nJson && nJson.tlyric && nJson.tlyric.lyric && nJson.tlyric.lyric.trim() &&
                                    nJson.lrc && nJson.lrc.lyric && nJson.lrc.lyric.trim()) {
                                    parsedN = detectAndParseLyrics({ lrc: nJson.lrc.lyric, trans: nJson.tlyric.lyric });
                                }
                            } catch (e) { parsedN = null; }

                            /* 备选：vkeys 网易云歌词（trans 字段） */
                            if (!parsedN || !parsedN.translations || parsedN.translations.length === 0) {
                                try {
                                    const lData = await fetchLyricWithFallback(String(sItem.id), 'netease');
                                    parsedN = detectAndParseLyrics(lData);
                                } catch (e) { parsedN = null; }
                            }

                            if (parsedN && parsedN.translations && parsedN.translations.length > 0 && gen === playbackGeneration) {
                                lyrics = mergeLyrics(lyrics, parsedN.translations, parsedN.romaji);
                                renderLyrics(lyrics);
                                logInfo('trackIndexOnline', `[Lyric] 翻译补齐成功 (${parsedN.translations.length} 行)`);
                            }
                        } catch (e) { logWarn('trackIndex', e); }
                    })();
                }
                /* 立即同步手机版歌词预览（展示首行歌词） */
                updateMobileLyricPreview();
                totalTimeEl.textContent = '00:00';

                await playPromise;

                /* 代际检查：如果在等待 canplay 期间用户又切了歌，放弃本次播放 */
                if (gen !== playbackGeneration) return;

                /* 音频加载出错时直接走重试逻辑，不再调用 play() */
                if (audio.error) {
                    logError('trackIndexOnline', '音频加载错误:', audio.error);
                    if (selectedEl) {
                        const statusEl = selectedEl.querySelector('.result-status');
                        if (statusEl) statusEl.textContent = '加载失败';
                    }
                    if (preloadOnly) { preloadedSongReady = null; return; }
                    if (handlePlayFailure(songInfo, skipPlaylistUpdate)) return;
                    isLoadingSong = false;
                    return;
                }

                /* 预加载模式：不调用 play()（浏览器自动播放策略），标记就绪并预先加载 AI 情感词分析 */
                if (preloadOnly) {
                    preloadedSongReady = true;
                    if (typeof triggerAiAnalysisIfNeeded === 'function') {
                        triggerAiAnalysisIfNeeded();
                    }
                    if (pendingPlayAfterPreload) {
                        pendingPlayAfterPreload = false;
                        audio.play().then(() => {
                            if (gen !== playbackGeneration) return;
                            retryCount = 0;
                            applyVolumeOnSongChange();
                            /* 队尾续推 + AI 智能分析 + 高潮检测（立即触发，代际校验；见 triggerPostLoadTasks） */
                            if (typeof triggerPostLoadTasks === 'function') triggerPostLoadTasks({ gen: gen });
                        }).catch(err => {
                            if (gen !== playbackGeneration) return;
                            handleAudioPlayError();
                            logError('trackIndexOnline', '预加载后播放失败:', err);
                        });
                    }
                    return;
                }

                audio.play().then(() => {
                    if (gen !== playbackGeneration) return;  /* 已过期，不处理 */
                    retryCount = 0;
                    applyVolumeOnSongChange();
                    /* 队尾续推检查（245 开关开启时队列将尽自动追加日推） */
                    if (typeof Aria.__maybeQueueRefill === 'function') Aria.__maybeQueueRefill();
                    /* ★ 记录最近播放历史（258-rankings.js） */
                    if (typeof window.recordRecentPlay === 'function') {
                        window.recordRecentPlay(currentSongData || songInfo);
                    }
                    /* 检查预加载数据是否匹配当前歌曲 */
                    const _preload = nextSongPreload;
                    const _songKey = `${currentSource}:${songInfo.id}`;
                    const _usedPreload = _preload && _preload.key === _songKey;
                    /* AI 智能分析：始终走实时分析路径（不再使用预加载的AI主题，确保情感词正确渲染） */
                    if (typeof triggerAiAnalysisIfNeeded === 'function') {
                        triggerAiAnalysisIfNeeded();
                    }
                    /* 高潮检测：优先使用预加载的高潮段落 */
                    if (_usedPreload && _preload.chorusSegments) {
                        globalThis.currentChorusSegments = _preload.chorusSegments;
                        if (typeof renderChorusMarkers === 'function') renderChorusMarkers();
                    } else {
                        if (typeof detectChorus === 'function') {
                            detectChorus(audio.src);
                        }
                    }
                    /* 清除预加载缓存 */
                    nextSongPreload = null;
                    /* 延迟触发下一首歌的预加载 */
                    if (typeof preloadNextSong === 'function') {
                        setTimeout(() => preloadNextSong(), 2000);
                    }
                }).catch(err => {
                    if (gen !== playbackGeneration) return;  /* 已过期，不处理 */
                    handleAudioPlayError();
                    logError('trackIndexOnline', '播放失败:', err);
                    if (handlePlayFailure(songInfo, skipPlaylistUpdate)) return;
                    if (selectedEl) {
                        const statusEl = selectedEl.querySelector('.result-status');
                        if (statusEl) statusEl.textContent = '播放失败';
                    }
                });
            } catch (err) {
                /* 代际检查：如果是过期请求的错误，不处理，避免干扰新歌 */
                if (gen !== playbackGeneration) return;
                logError('trackIndexOnline', '加载歌曲出错:', err);
                /* 预加载模式下直接标记失败，不重试 */
                if (preloadOnly) { preloadedSongReady = null; return; }
                /* 恢复音量：淡出可能导致 volume=0，加载失败后需恢复 */
                if (audio.volume === 0 && volume > 0) {
                    audio.volume = volumePercentToGain(volume);
                }
                if (selectedEl) {
                    const statusEl = selectedEl.querySelector('.result-status');
                    if (statusEl) statusEl.textContent = '加载失败';
                }
                /* 所有类型的错误（音频加载失败、网络请求失败等）都尝试重试 */
                if (handlePlayFailure(songInfo, skipPlaylistUpdate)) return;
            } finally {
                /* 只有最新代际才能重置 isLoadingSong，避免旧请求的 finally 干扰新请求 */
                if (gen === playbackGeneration) {
                    isLoadingSong = false;
                }
            }
        }

/* ========== 初始化 ========== */
function initPlayer() {
            /* 使用当前音量变量设置音量和音量条（对数曲线） */
            volumeBar.style.width = `${volume}%`;
            audio.volume = volumePercentToGain(volume);
            /* 确保音量不为0，如果为0则恢复到默认音量 */
            if (audio.volume === 0) {
                volume = playerConfig.initialVolume;
                audio.volume = volumePercentToGain(volume);
                volumeBar.style.width = `${volume}%`;
            }

            totalTimeEl.textContent = '00:00';

            /* 加载中状态，等待真实歌曲 */
            songTitleEl.textContent = '加载中...';
            songArtistEl.textContent = '';
            getCoverLayers().forEach(l => {
                l.removeAttribute('src');
                l.style.opacity = '0';
            });

            currentSongData = null;
            currentSongKey = '';
            updateFavoriteBtn();

            initLyricsInteractions();
            initLyricOffsetControl();
        }

/* 获取初始首曲：优先从收藏列表随机挑一首；若无收藏则从其他非空歌单随机挑一首；最后 fallback 到默认曲目 */
function pickInitialTrackSelection() {
            /* 1. 收藏列表随机 */
            const favs = getFavorites();
            if (favs && favs.length > 0) {
                const randIdx = Math.floor(Math.random() * favs.length);
                const pl = favs.map(s => ({
                    url: null, title: s.title, artist: s.artist,
                    cover: s.cover || '', source: s.source || '',
                    id: s.id, mid: s.mid || '', key: s.key
                }));
                return { playlist: pl, trackIndex: randIdx, isDefault: false };
            }

            /* 2. 自定义歌单随机 */
            try {
                const customLists = (getPlaylists() || []).filter(p => Array.isArray(p.songs) && p.songs.length > 0);
                if (customLists.length > 0) {
                    const chosenList = customLists[Math.floor(Math.random() * customLists.length)];
                    const randIdx = Math.floor(Math.random() * chosenList.songs.length);
                    const pl = chosenList.songs.map(s => ({
                        url: null, title: s.title, artist: s.artist,
                        cover: s.cover || '', source: s.source || '',
                        id: s.id, mid: s.mid || '', key: s.key
                    }));
                    return { playlist: pl, trackIndex: randIdx, isDefault: false };
                }
            } catch (e) { logWarn('trackIndex', e); }

            /* 3. 默认硬编码歌曲 fallback */
            return { playlist: [], trackIndex: 0, isDefault: true };
        }

export { applyPreloadedAiTheme, fetchPlayUrlForPreload, getNextTrackIndex, initPlayer, loadOnlineSong, pickInitialTrackSelection, preloadNextSong };
