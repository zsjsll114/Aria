/**
 * services/musicApi.js — 音乐搜索 & 播放链接获取
 * 封装 vkeys / ygking / moeyao / byfuns / oiapi / kugou 多源 API
 */
import { API_BASE, OIAPI_LYRIC_BASE } from '../config/constants.js';
import { decryptKrc, parseKrc } from './krcParser.js';
import { parseLrc } from '../parsers/lrcParser.js';
import { logWarn, logInfo, logError } from './log.js';
/**
 * 浏览器端 JSONP 跨域请求
 * 绕过一切浏览器 CORS 限制与 Mixed Content 限制（纯原生 <script> 注入）
 */
function jsonp(url, paramName = 'callback', timeout = 8000) {
    return new Promise((resolve, reject) => {
        if (typeof document === 'undefined') {
            return reject(new Error('JSONP 仅在浏览器环境下可用'));
        }
        const cbName = '__kg_cb_' + Date.now() + '_' + Math.floor(Math.random() * 1000000);
        const script = document.createElement('script');
        let timer = null;

        const cleanup = () => {
            if (timer) { clearTimeout(timer); timer = null; }
            if (script.parentNode) script.parentNode.removeChild(script);
            try { delete window[cbName]; } catch (e) { window[cbName] = undefined; }
        };

        timer = setTimeout(() => {
            cleanup();
            reject(new Error('JSONP 请求超时'));
        }, timeout);

        window[cbName] = (data) => {
            cleanup();
            resolve(data);
        };

        script.onerror = (e) => {
            cleanup();
            reject(new Error('JSONP 脚本加载失败'));
        };

        const sep = url.includes('?') ? '&' : '?';
        script.src = `${url}${sep}${paramName}=${cbName}`;
        document.head.appendChild(script);
    });
}

/**
 * 智能多端点代理请求
 * 依次尝试：
 * 1. 同源相对路径 /proxy?url= (server.py / app.py 本地服务器)
 * 2. 本地端口代理 http://127.0.0.1:8001/proxy?url= 或 http://127.0.0.1:18089/proxy?url=
 * 3. 直连 fetch (若目标支持跨域)
 */
export async function proxyFetch(targetUrl, options = {}) {
    const timeoutMs = options.timeout || 8000;
    const endpoints = [];

    if (typeof window !== 'undefined' && window.location && window.location.protocol.startsWith('http')) {
        endpoints.push(`/proxy?url=${encodeURIComponent(targetUrl)}`);
    }
    endpoints.push(`http://127.0.0.1:8001/proxy?url=${encodeURIComponent(targetUrl)}`);
    endpoints.push(`http://127.0.0.1:18089/proxy?url=${encodeURIComponent(targetUrl)}`);
    endpoints.push(targetUrl);

    for (const ep of endpoints) {
        try {
            const controller = new AbortController();
            const tid = setTimeout(() => controller.abort(), timeoutMs);
            const res = await fetch(ep, {
                headers: options.headers || {},
                signal: controller.signal
            });
            clearTimeout(tid);
            if (res.ok) {
                return res;
            }
        } catch (e) {
            // 继续尝试下一个候选端点
        }
    }
    throw new Error(`无法获取请求: ${targetUrl}`);
}

/**
 * 搜索酷狗音乐
 * 优先采用官方 songsearch JSONP 接口，100% 免 CORS 免代理运行于浏览器
 */
export async function searchKugouSongs(keyword, page = 1, pagesize = 40) {
    if (!keyword) return { success: false, message: '请输入关键词' };
    const cleanWord = keyword.trim();

    // 1. 优先使用 JSONP 搜索
    try {
        const jsonpUrl = `https://songsearch.kugou.com/song_search_v2?keyword=${encodeURIComponent(cleanWord)}&page=${page}&pagesize=${pagesize}&platform=WebFilter`;
        const data = await jsonp(jsonpUrl, 'callback', 6000);
        const lists = (data && data.data && data.data.lists) || [];
        if (lists.length > 0) {
            const list = lists.map(item => {
                const song = (item.SongName || '').replace(/<\/?em>/g, '') || item.FileName || '未知歌曲';
                const singer = (item.SingerName || '').replace(/<\/?em>/g, '') || '未知歌手';
                const hash = item.FileHash || item.HQFileHash || item.SQFileHash || item.ResFileHash || '';
                const album = (item.AlbumName || '').replace(/<\/?em>/g, '') || '';
                const cover = (item.Image || (item.trans_param && item.trans_param.union_cover) || '').replace('{size}', '400');
                return {
                    id: hash,
                    mid: hash,
                    hash: hash,
                    song: song,
                    singer: singer,
                    album: album,
                    duration: item.Duration || item.HQDuration || 0,
                    cover: cover,
                    source: 'kugou'
                };
            }).filter(item => item.hash);
            if (list.length > 0) {
                return { success: true, list };
            }
        }
    } catch (jsonpErr) {
        logWarn('musicApi', '[KuGou Search] JSONP 搜索异常，尝试代理回退:', jsonpErr.message);
    }

    // 2. 代理回退方案
    try {
        const mobileUrl = `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(cleanWord)}&page=${page}&pagesize=${pagesize}`;
        const res = await proxyFetch(mobileUrl, { timeout: 6000 });
        const json = await res.json();
        const info = (json && json.data && json.data.info) || [];
        const list = info.map(item => {
            const songName = item.songname || item.filename || '未知歌曲';
            const singerName = item.singername || '未知歌手';
            const hash = item.hash || item['320hash'] || item.sqhash || '';
            const cover = (item.album_img || item.img || '').replace('{size}', '400') || '';
            return {
                id: hash,
                mid: hash,
                hash: hash,
                song: songName,
                singer: singerName,
                album: item.album_name || '',
                duration: item.duration || 0,
                cover: cover,
                source: 'kugou'
            };
        }).filter(item => item.hash);
        return { success: true, list };
    } catch (err) {
        logError('musicApi', '[KuGou Search] 搜索全部失败:', err);
        return { success: false, message: '搜索失败，请检查网络或本地服务器状态' };
    }
}

/**
 * 时长归一化：vkeys 的 interval 为中文格式（"4分29秒"），酷狗等为秒数
 */
export function intervalToSec(s) {
    if (typeof s === 'number') return s > 0 ? s : 0;
    const str = String(s || '');
    if (!str) return 0;
    const h = str.match(/(\d+)\s*(?:小时|时|h)/);
    const m = str.match(/(\d+)\s*(?:分钟|分|m)/);
    const sec = str.match(/(\d+)\s*(?:秒|s|sec)/);
    if (!h && !m && !sec) {
        const n = parseInt(str, 10);
        return isNaN(n) ? 0 : n;
    }
    return (h ? +h[1] * 3600 : 0) + (m ? +m[1] * 60 : 0) + (sec ? +sec[1] : 0);
}

/**
 * 本地解析池优先的 QQ 取链（服务端多API竞速 + VIP母带 + 防试听校验 + 15min缓存）
 * 本地服务器不在线或全源失败时返回 null，调用方落回前端原链
 * @returns {Promise<string|null>}
 */
export async function qqResolveUrl(mid, dur, quality) {
    if (!mid) return null;
    try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 45000);
        const params = new URLSearchParams({ mid });
        if (dur && dur > 30) params.set('dur', String(Math.round(dur)));
        if (quality) params.set('q', String(quality));
        let data;
        try {
            data = await fetch(`/api/qq/resolve?${params.toString()}`, { signal: ctl.signal }).then(r => r.json());
        } finally { clearTimeout(timer); }
        if (data && data.ok && data.url && data.url.startsWith('http')) {
            logInfo('musicApi', `[QQResolve] ${data.provider} 命中 (${data.quality}/${data.ext}${data.cached ? ', 缓存' : ''})`);
            return data.url;
        }
        logWarn('musicApi', '[QQResolve] 解析池未命中，落回前端原链:', data && data.err);
    } catch (e) {
        logWarn('musicApi', '[QQResolve] 本地解析池不可用，落回前端原链:', e.message);
    }
    return null;
}

/**
 * 聚合跨源兜底（服务端 gdstudio 多源：酷我→网易），仅在前三源全失败时被调用
 * @returns {Promise<{url:string}|null>}
 */
export async function fetchAggSameSongUrl(songTitle, singer = '') {
    if (!songTitle) return null;
    try {
        const params = new URLSearchParams({ title: songTitle });
        if (singer) params.set('artist', singer);
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 45000);
        let data;
        try {
            data = await fetch(`/api/agg/resolve?${params.toString()}`, { signal: ctl.signal }).then(r => r.json());
        } finally { clearTimeout(timer); }
        if (data && data.ok && data.url && data.url.startsWith('http')) {
            logInfo('musicApi', `[AggResolve] ${data.provider} 命中 (${data.quality}): ${data.song || ''}${data.artist_mismatch ? ' [歌手不符]' : ''}`);
            return { url: data.url, cover: '' };
        }
        logWarn('musicApi', '[AggResolve] 聚合兜底未命中:', data && data.err);
    } catch (e) {
        logWarn('musicApi', '[AggResolve] 聚合兜底不可用:', e.message);
    }
    return null;
}

/* ---------- 酷我独立源（搜索界面第四源，走本地服务端 gdstudio 代理） ---------- */

/* 酷我搜索：返回与 vkeys 条目同构的列表 [{song,singer,id,source:'kuwo',interval,cover}]
   page 为真实后端翻页（gdstudio pages），单页上限实测 99 */
export async function fetchKuwoSearch(word, num = 99, page = 1) {
    if (!word) return [];
    try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 15000);
        let data;
        try {
            data = await fetch(`/api/kuwo/search?word=${encodeURIComponent(word)}&num=${num}&page=${page}`, { signal: ctl.signal })
                .then(r => r.json());
        } finally { clearTimeout(timer); }
        if (data && data.ok && Array.isArray(data.list)) return data.list;
        logWarn('musicApi', '[Kuwo] 搜索失败:', data && data.err);
    } catch (e) {
        logWarn('musicApi', '[Kuwo] 搜索不可用:', e.message);
    }
    return [];
}

/* 酷我取链：按用户播放音质走服务端阶梯校验与 bugpk 接口。成功返回直链字符串，失败 null */
export async function fetchKuwoUrl(songId, quality) {
    if (!songId) return null;
    // 1. 优先尝试本地后端 /api/kuwo/url（内置 bugpk 与 gdstudio 校验兜底）
    try {
        const params = new URLSearchParams({ id: String(songId) });
        if (quality) params.set('q', String(quality));
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 15000);
        let data;
        try {
            data = await fetch(`/api/kuwo/url?${params.toString()}`, { signal: ctl.signal }).then(r => r.json());
        } finally { clearTimeout(timer); }
        if (data && data.ok && data.url && data.url.startsWith('http')) {
            logInfo('musicApi', `[Kuwo] 取链命中 br=${data.quality}${data.cached ? ' (缓存)' : ''}`);
            return data.url;
        }
    } catch (e) {
        logWarn('musicApi', '[Kuwo] 本地取链接口异常，尝试前端直连备用:', e.message);
    }

    // 2. 备用：前端直接/代理请求 bugpk 酷我接口
    try {
        const bpUrl = `https://api.bugpk.com/api/kuwo?url=https://www.kuwo.cn/play_detail/${encodeURIComponent(String(songId))}`;
        const res = await proxyFetch(bpUrl, { timeout: 8000 });
        const json = await res.json();
        const mUrl = (json && json.data && json.data.music_url) || '';
        if (mUrl && mUrl.startsWith('http')) {
            logInfo('musicApi', '[Kuwo] bugpk 直链获取成功');
            return mUrl;
        }
    } catch (e) { logWarn('musicApi', e); }

    return null;
}

/**
 * 酷我音乐一站式获取：单次调用同时获取播放直链、高清封面、官方歌词
 * 若酷我因 VIP/付费版权返回限制（如周杰伦等），自动平滑回退到 QQ音乐/酷狗 原唱直链与逐字歌词
 */
export async function getKuwoPlayInfo(songId, songTitle = '', singer = '') {
    const sid = songId ? String(songId).trim() : '';
    const cleanTitle = (songTitle || '').replace(/<\/?em>/g, '').trim();
    const cleanSinger = (singer || '').replace(/<\/?em>/g, '').trim();

    // 1. 优先尝试本地后端 /api/kuwo/detail (内置 bugpk 接口与 15min 缓存)
    if (sid) {
        try {
            const data = await fetch(`/api/kuwo/detail?id=${encodeURIComponent(sid)}`).then(r => r.json());
            if (data && data.ok && data.url) {
                let parsedList = [];
                if (data.lrc && data.lrc.includes('[')) {
                    parsedList = parseLrc(data.lrc).map((item, index, arr) => ({
                        start: item.time,
                        end: index < arr.length - 1 ? arr[index + 1].time : item.time + 5000,
                        original: item.text,
                        words: []
                    }));
                }
                logInfo('musicApi', `[Kuwo] 官方直链获取成功: ${cleanTitle || sid}`);
                return {
                    url: data.url,
                    cover: data.cover || '',
                    lrc: data.lrc || '',
                    parsedList: parsedList,
                    title: data.title || cleanTitle,
                    artist: data.artist || cleanSinger
                };
            }
        } catch (e) { logWarn('musicApi', e); }

        // 2. 备用：直连/代理请求 bugpk 酷我接口
        try {
            const bpUrl = `https://api.bugpk.com/api/kuwo?url=https://www.kuwo.cn/play_detail/${encodeURIComponent(sid)}`;
            const res = await proxyFetch(bpUrl, { timeout: 8000 });
            const json = await res.json();
            if (json && json.data && json.data.music_url) {
                const d = json.data;
                let parsedList = [];
                if (d.lyrics_url && d.lyrics_url.includes('[')) {
                    parsedList = parseLrc(d.lyrics_url).map((item, index, arr) => ({
                        start: item.time,
                        end: index < arr.length - 1 ? arr[index + 1].time : item.time + 5000,
                        original: item.text,
                        words: []
                    }));
                }
                logInfo('musicApi', `[Kuwo] bugpk 直链获取成功: ${cleanTitle || sid}`);
                return {
                    url: d.music_url,
                    cover: d.pic || d.albumpic || d.pic120 || '',
                    lrc: d.lyrics_url || '',
                    parsedList: parsedList,
                    title: d.title || cleanTitle,
                    artist: d.artist || cleanSinger
                };
            }
        } catch (e) { logWarn('musicApi', e); }
    }

    // 3. 酷我 VIP / 付费限制歌曲平滑跨源回退（周杰伦等巨星原唱版权主要在 QQ 音乐）
    const searchWord = `${cleanTitle} ${cleanSinger}`.trim();
    if (searchWord) {
        logWarn('musicApi', `[Kuwo] 该歌曲在酷我为VIP付费歌曲，自动平滑启用原唱高音质解析: ${searchWord}`);
        try {
            const qqCtl = new AbortController();
            const qqTimer = setTimeout(() => qqCtl.abort(), 8000);
            const qqRes = await fetch(`${API_BASE}/tencent?word=${encodeURIComponent(searchWord)}&num=5`, { signal: qqCtl.signal }).then(r => r.json()).catch(() => ({}));
            clearTimeout(qqTimer);
            if (qqRes.code === 200 && qqRes.data && qqRes.data.length > 0) {
                const candidates = Array.isArray(qqRes.data) ? qqRes.data : [qqRes.data];
                const bestSong = candidates.find(c => {
                    const cSinger = (c.singer || '').trim();
                    return cleanSinger && (cSinger.includes(cleanSinger) || cleanSinger.includes(cSinger));
                }) || candidates[0];

                if (bestSong && bestSong.mid) {
                    const userQ = (globalThis.appSettings && globalThis.appSettings.quality && globalThis.appSettings.quality.qqPlayback) || '320';
                    let playUrl = await qqResolveUrl(bestSong.mid, bestSong.duration, userQ);

                    if (!playUrl) {
                        const YGK_QUALITIES = ['320', 'flac', '128', 'master'];
                        for (const quality of YGK_QUALITIES) {
                            try {
                                const controller = new AbortController();
                                const timeout = setTimeout(() => controller.abort(), 6000);
                                const resp = await fetch(`https://api.ygking.top/api/song/url?mid=${bestSong.mid}&quality=${quality}`, { signal: controller.signal });
                                clearTimeout(timeout);
                                const ygkJson = await resp.json();
                                if (ygkJson.code === 0 && ygkJson.data && ygkJson.data[bestSong.mid]) {
                                    const url = ygkJson.data[bestSong.mid];
                                    if (url && url.startsWith('http')) {
                                        playUrl = url;
                                        break;
                                    }
                                }
                            } catch (e) { logWarn('musicApi', e); }
                        }
                    }

                    if (!playUrl && bestSong.id) {
                        try {
                            const vkeysRes = await fetch(`${API_BASE}/tencent?id=${bestSong.id}`).then(r => r.json()).catch(() => ({}));
                            if (vkeysRes.code === 200 && vkeysRes.data && vkeysRes.data.url) {
                                playUrl = vkeysRes.data.url;
                            }
                        } catch (e) { logWarn('musicApi', e); }
                    }

                    if (playUrl) {
                        // 同步获取原唱逐字/官方歌词
                        let lyricObj = {};
                        try {
                            lyricObj = await fetchLyricWithFallback(String(bestSong.id), 'tencent') || {};
                        } catch (e) { logWarn('musicApi', e); }
                        return {
                            url: playUrl,
                            cover: bestSong.cover || '',
                            lrc: lyricObj.yrc || lyricObj.lrc || '',
                            parsedList: lyricObj.parsedList || [],
                            lyricObj: lyricObj,  /* 透传完整歌词对象（含 yrc/lrc/trans/roma） */
                            title: bestSong.song || cleanTitle,
                            artist: bestSong.singer || cleanSinger
                        };
                    }
                }
            }
        } catch (e) {
            logWarn('musicApi', '[Kuwo Fallback] QQ原唱回退异常:', e.message);
        }
    }

    return null;
}

/* 酷我封面：优先从本地 /api/kuwo/pic 或 bugpk 获取 500x500 高清封面。失败返回 '' */
export async function fetchKuwoPic(songId) {
    if (!songId) return '';
    try {
        const data = await fetch(`/api/kuwo/pic?id=${encodeURIComponent(String(songId))}`).then(r => r.json());
        if (data && data.ok && data.url) return data.url;
    } catch (e) { /* 静默 */ }
    try {
        const bpUrl = `https://api.bugpk.com/api/kuwo?url=https://www.kuwo.cn/play_detail/${encodeURIComponent(String(songId))}`;
        const res = await proxyFetch(bpUrl, { timeout: 6000 });
        const json = await res.json();
        const pic = (json && json.data && (json.data.pic || json.data.albumpic || json.data.pic120)) || '';
        if (pic && pic.startsWith('http')) return pic;
    } catch (e) { logWarn('musicApi', e); }
    return '';
}

/**
 * 酷我歌词获取：通过本地 /api/kuwo/lyric 或 bugpk 获取官方 LRC 歌词，失败回退全网原唱歌词
 */
export async function fetchKuwoLyric(songInfo) {
    let songId = typeof songInfo === 'object' ? songInfo.id : songInfo;
    const title = typeof songInfo === 'object' ? (songInfo.song || songInfo.name || songInfo.title || '') : '';
    const singer = typeof songInfo === 'object' ? (songInfo.singer || songInfo.artist || '') : '';

    // 1. 如果没有有效 ID（例如从其他源切到酷我歌词），先通过酷我搜索匹配歌曲获取 ID
    if (!songId && title) {
        try {
            const list = await fetchKuwoSearch(`${title} ${singer}`.trim(), 5, 1);
            if (list && list.length > 0) {
                songId = list[0].id;
            }
        } catch (e) { logWarn('musicApi', e); }
    }

    // 2. 尝试本地后端 /api/kuwo/lyric（带超时，防挂起导致歌词永久空）
    if (songId) {
        try {
            const data = await fetchJsonWithTimeout(`/api/kuwo/lyric?id=${encodeURIComponent(String(songId))}`, 8000);
            if (data && data.ok && data.lrc && data.lrc.includes('[')) {
                const parsedList = parseLrc(data.lrc).map((item, index, arr) => ({
                    start: item.time,
                    end: index < arr.length - 1 ? arr[index + 1].time : item.time + 5000,
                    original: item.text,
                    words: []
                }));
                if (parsedList.length > 0) {
                    logInfo('musicApi', `[Kuwo Lyric] 本地接口获取成功 (${parsedList.length} 行)`);
                    return { parsedList, lrc: data.lrc, source: 'kuwo' };
                }
            }
        } catch (e) { logWarn('musicApi', e); }

        // 3. 备用：直接/代理调用 bugpk 接口
        try {
            const bpUrl = `https://api.bugpk.com/api/kuwo?url=https://www.kuwo.cn/play_detail/${encodeURIComponent(String(songId))}`;
            const res = await proxyFetch(bpUrl, { timeout: 8000 });
            const json = await res.json();
            const lrcText = (json && json.data && json.data.lyrics_url) || '';
            if (lrcText && lrcText.includes('[')) {
                const parsedList = parseLrc(lrcText).map((item, index, arr) => ({
                    start: item.time,
                    end: index < arr.length - 1 ? arr[index + 1].time : item.time + 5000,
                    original: item.text,
                    words: []
                }));
                if (parsedList.length > 0) {
                    logInfo('musicApi', `[Kuwo Lyric] bugpk 获取成功 (${parsedList.length} 行)`);
                    return { parsedList, lrc: lrcText, source: 'kuwo' };
                }
            }
        } catch (e) { logWarn('musicApi', e); }
    }

    // 4. 酷我因 VIP/版权未返回歌词时：从 QQ音乐 / 备用源 检索同名原唱歌词
    const searchWord = `${title} ${singer}`.trim();
    if (searchWord) {
        try {
            const qRes = await fetch(`${API_BASE}/tencent?word=${encodeURIComponent(searchWord)}&num=3`).then(r => r.json()).catch(() => ({}));
            if (qRes.code === 200 && qRes.data && qRes.data.length > 0) {
                const best = Array.isArray(qRes.data) ? qRes.data[0] : qRes.data;
                if (best && best.id) {
                    const lyricData = await fetchLyricWithFallback(String(best.id), 'tencent');
                    if (lyricData && (lyricData.yrc || lyricData.lrc)) {
                        return lyricData;
                    }
                }
            }
        } catch (e) { logWarn('musicApi', e); }
    }

    return {};
}

/**
 * 获取酷狗音乐播放链接与歌曲大图
 * 若酷狗官方因版权/VIP返回空，优先通过 QQ音乐(ygking) 检索原唱高音质音频流
 */
export async function getKugouPlayInfo(hash, songTitle = '', singer = '', quality = '320') {
    // 1. 尝试酷狗官方 playInfo
    if (hash) {
        try {
            const qParam = quality ? `&quality=${encodeURIComponent(quality)}` : '';
            const url = `https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${hash}${qParam}`;
            const res = await proxyFetch(url, { timeout: 5000 });
            const json = await res.json();
            let playUrl = json.url || json.backup_url;
            if (Array.isArray(playUrl)) playUrl = playUrl[0];
            const img = (json.imgUrl || json.album_img || '').replace('{size}', '500');
            if (typeof playUrl === 'string' && playUrl.startsWith('http')) {
                return { url: playUrl, cover: img || '' };
            }
        } catch (e) {
            logWarn('musicApi', '[KuGou Play] playInfo 获取失败:', e.message);
        }
    }

    // 2. 跨源原唱音频流回退（优先 QQ 音乐，版权最全且均为原唱音源）
    const cleanTitle = (songTitle || '').replace(/<\/?em>/g, '').trim();
    const cleanSinger = (singer || '').replace(/<\/?em>/g, '').trim();
    const searchWord = `${cleanTitle} ${cleanSinger}`.trim();

    if (searchWord) {
        // ① 优先检索 QQ 音乐（周杰伦等巨星原唱版权主要在 QQ 音乐）
        try {
            const qqCtl = new AbortController();
            const qqTimer = setTimeout(() => qqCtl.abort(), 8000);
            const qqRes = await fetch(`${API_BASE}/tencent?word=${encodeURIComponent(searchWord)}&num=5`, { signal: qqCtl.signal }).then(r => r.json()).catch(() => ({}));
            clearTimeout(qqTimer);
            if (qqRes.code === 200 && qqRes.data && qqRes.data.length > 0) {
                const candidates = Array.isArray(qqRes.data) ? qqRes.data : [qqRes.data];
                // 优先选择歌手名匹配度最高的原唱版本，排除 live/翻唱杂音
                const bestSong = candidates.find(c => {
                    const cSinger = (c.singer || '').trim();
                    return cleanSinger && (cSinger.includes(cleanSinger) || cleanSinger.includes(cSinger));
                }) || candidates[0];

                if (bestSong && bestSong.mid) {
                    // 优先走本地解析池（多源竞速 + 防试听校验），按用户播放音质裁剪阶梯
                    const userQ = (globalThis.appSettings && globalThis.appSettings.quality && globalThis.appSettings.quality.qqPlayback) || '320';
                    const resolved = await qqResolveUrl(bestSong.mid, bestSong.duration, userQ);
                    if (resolved) {
                        return { url: resolved, cover: bestSong.cover || '' };
                    }
                    const YGK_QUALITIES = ['320', 'flac', '128', 'master'];
                    for (const quality of YGK_QUALITIES) {
                        try {
                            const controller = new AbortController();
                            const timeout = setTimeout(() => controller.abort(), 6000);
                            const resp = await fetch(`https://api.ygking.top/api/song/url?mid=${bestSong.mid}&quality=${quality}`, { signal: controller.signal });
                            clearTimeout(timeout);
                            const ygkJson = await resp.json();
                            if (ygkJson.code === 0 && ygkJson.data && ygkJson.data[bestSong.mid]) {
                                const url = ygkJson.data[bestSong.mid];
                                if (url && url.startsWith('http')) {
                                    logInfo('musicApi', `[KuGou Play] 成功调度 QQ 原唱音频流 (${bestSong.song} - ${bestSong.singer}, 音质: ${quality})`);
                                    return { url, cover: bestSong.cover || '' };
                                }
                            }
                        } catch (e) { /* 尝试下一个音质 */ }
                    }
                }

                // 若 ygking 失败，尝试 vkeys QQ 音频
                if (bestSong && bestSong.id) {
                    try {
                        const vkCtl = new AbortController();
                        const vkTimer = setTimeout(() => vkCtl.abort(), 8000);
                        const vkeysUrl = await fetch(`${API_BASE}/tencent?id=${bestSong.id}`, { signal: vkCtl.signal }).then(r => r.json()).catch(() => ({}));
                        clearTimeout(vkTimer);
                        if (vkeysUrl.code === 200 && vkeysUrl.data && vkeysUrl.data.url) {
                            return { url: vkeysUrl.data.url, cover: bestSong.cover || '' };
                        }
                    } catch (e) { logWarn('musicApi', e); }
                }
            }
        } catch (e) {
            logWarn('musicApi', '[KuGou Play] QQ 音乐音频流调度异常:', e.message);
        }

        // ② 次选检索网易云音乐（严格过滤歌手名，防止匹配到翻唱/非原唱版本）
        try {
            const ncmCtl = new AbortController();
            const ncmTimer = setTimeout(() => ncmCtl.abort(), 8000);
            const ncmRes = await fetch(`${API_BASE}/netease?word=${encodeURIComponent(searchWord)}&num=5`, { signal: ncmCtl.signal }).then(r => r.json()).catch(() => ({}));
            clearTimeout(ncmTimer);
            if (ncmRes.code === 200 && ncmRes.data && ncmRes.data.length > 0) {
                const candidates = Array.isArray(ncmRes.data) ? ncmRes.data : [ncmRes.data];
                // 必须严格匹配歌手名，杜绝非原唱/翻唱账号
                const validSong = candidates.find(c => {
                    const cSinger = (c.singer || '').trim();
                    if (!cleanSinger) return true;
                    return cSinger === cleanSinger || (cSinger.includes(cleanSinger) && !cSinger.includes('-') && !cSinger.includes('/'));
                });

                if (validSong) {
                    // 多音质依次尝试 byfuns（单档偶发 504/超时），全部失败才回退网易外链（外链对版权歌曲经常失效）
                    const LEVELS = ['exhigh', 'lossless', 'higher', 'standard', 'hires'];
                    for (const level of LEVELS) {
                        try {
                            const controller = new AbortController();
                            const timeout = setTimeout(() => controller.abort(), 8000);
                            const resp = await fetch(`https://api.byfuns.top/1/?id=${validSong.id}&level=${level}`, { signal: controller.signal });
                            clearTimeout(timeout);
                            const text = await resp.text();
                            if (text && text.startsWith('http')) {
                                return { url: text.trim(), cover: validSong.cover || '' };
                            }
                        } catch (e) { /* 尝试下一音质 */ }
                    }
                    return { url: `https://music.163.com/song/media/outer/url?id=${validSong.id}`, cover: validSong.cover || '' };
                }
            }
        } catch (e) { /* 忽略网易云回退异常 */ }
    }

    return null;
}

/**
 * 搜索歌曲
 * @param {string} source - 'tencent' | 'netease' | 'kugou'
 * @param {string} keyword - 搜索关键词
 * @returns {Promise<{success: boolean, list?: Array, message?: string}>}
 */
export async function apiSearchSongs(source, keyword) {
    if (!keyword) return { success: false, message: '请输入关键词' };
    if (source === 'kugou') {
        return await searchKugouSongs(keyword);
    }
    try {
        const url = `${API_BASE}/${source}?word=${encodeURIComponent(keyword)}&num=60`;
        /* ★ 走本地代理（proxyFetch 依次 /proxy?url= → 127.0.0.1:8001/proxy → 直连），
           避免浏览器直连 api.vkeys.cn 因跨域(CORS)被拦而返回空、被上层误判回退酷我 */
        const res = await proxyFetch(url);
        const json = await res.json().catch(() => ({}));
        if (json.code !== 200 || !json.data) {
            return { success: false, message: json.message || '搜索失败' };
        }
        const list = Array.isArray(json.data) ? json.data : [json.data];
        return { success: true, list };
    } catch (err) {
        logError('musicApi', '搜索出错:', err);
        return { success: false, message: '搜索失败，请检查网络' };
    }
}

/**
 * 酷狗官方 playInfo 直链（免费歌有效；VIP/付费歌返回空 url，status=0）
 * 独立于 getKugouPlayInfo：不绕行 QQ 中间链，避免拿到失效试听地址
 */
export async function getKugouDirectUrl(hash) {
    if (!hash) return null;
    const url = `https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${hash}`;
    const res = await proxyFetch(url, { timeout: 5000 });
    const json = await res.json();
    let playUrl = json.url;
    if (!playUrl && json.backup_url) {
        playUrl = Array.isArray(json.backup_url) ? json.backup_url[0] : json.backup_url;
    }
    if (typeof playUrl === 'string' && playUrl.startsWith('http')) return playUrl;
    /* ★ 留痕：付费/VIP 曲目在这里固定是 status=0 + error='需要付费'（实测连 128k 都拒）。
       以前直接 return null，现象是「酷狗源取不到，但不知道为什么」。
       酷狗自建链路目前也**未接线**（vendor `/song/url` 可以取到链接，但会被风控挑战
       `ssa-code`，需先过一次第三方授权验证，见 selfhost-runtime.js 顶部说明），
       所以付费曲只能靠跨源（网易云/酷我）兜底。 */
    logWarn('musicApi', `[酷狗] 公网接口未给直链（status=${json.status} error=${json.error || ''}），需跨源兜底`);
    return null;
}

const JUNK_SONG_PATTERN = /[\(（\[【](?:DJ版|剪辑版|片段|抖音版|翻唱|Cover|伴奏|Instrumental|短版|Short|减速版|加速版|Live)[\)）\]】]|(?:DJ版|剪辑版|片段|伴奏|伴唱)/i;

/* 清洗跨源搜索关键词：去 emoji/特殊符号/控制符、压缩多余空白。
   历史缺陷：本函数定义曾在拆分中丢失（git 初始提交已缺），导致
   fetchSameSongUrlFrom 一旦被调用即 ReferenceError，被上层 catch
   静默吞掉，跨源同名歌回退整条链路形同虚设。现补回原语义。 */
function stripEm(s) {
    return String(s == null ? '' : s)
        .replace(/[\p{So}\p{Cf}\u200D]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function filterCleanSongCandidates(list, originalTitle) {
    if (!Array.isArray(list) || list.length === 0) return [];
    const origHasJunk = JUNK_SONG_PATTERN.test(originalTitle);
    if (origHasJunk) return list;
    const cleanList = list.filter(item => {
        const name = (item.song || item.name || item.title || '').trim();
        return !JUNK_SONG_PATTERN.test(name);
    });
    return cleanList.length > 0 ? cleanList : list;
}

export async function fetchSameSongUrlFrom(source, title, singer) {
    const cleanTitle = stripEm(title);
    const cleanSinger = stripEm(singer);
    const searchWord = `${cleanTitle} ${cleanSinger}`.trim();
    if (!cleanTitle) return null;

    if (source === 'kugou') {
        try {
            const kgRes = await searchKugouSongs(searchWord);
            if (kgRes && kgRes.success && kgRes.list && kgRes.list.length > 0) {
                const candidates = filterCleanSongCandidates(kgRes.list, cleanTitle);
                const kw = cleanTitle.toLowerCase();
                const ks = cleanSinger.toLowerCase();
                /* 优先双匹配 > 仅歌名 > 第一条优质原版 */
                const best = candidates.find(item =>
                    (item.song || '').toLowerCase().includes(kw) &&
                    ks && (item.singer || '').toLowerCase().includes(ks))
                    || candidates.find(item => (item.song || '').toLowerCase().includes(kw))
                    || candidates[0];
                if (best && best.hash) {
                    try {
                        const url = await getKugouDirectUrl(best.hash);
                        if (url) {
                            logInfo('musicApi', `[跨源] 酷狗同名歌成功: ${best.song} - ${best.singer}`);
                            return { url, cover: best.cover || '' };
                        }
                        logWarn('musicApi', `[跨源] 酷狗 playInfo 无直链(疑似VIP): ${best.song}`);
                    } catch (e) { /* 试下一候选 */ }
                }
            }
        } catch (e) {
            logWarn('musicApi', '[跨源] 酷狗同名歌检索异常:', e.message);
        }
        return null;
    }

    if (source === 'netease') {
        try {
            const ctl = new AbortController();
            const timer = setTimeout(() => ctl.abort(), 8000);
            let res;
            try {
                res = await fetch(`${API_BASE}/netease?word=${encodeURIComponent(searchWord)}&num=5`, { signal: ctl.signal }).then(r => r.json());
            } finally { clearTimeout(timer); }
            if (!(res.code === 200 && res.data)) return null;
            const rawCandidates = Array.isArray(res.data) ? res.data : [res.data];
            const candidates = filterCleanSongCandidates(rawCandidates, cleanTitle);
            /* 优先精确歌手匹配，防翻唱/伴奏 */
            const valid = candidates.find(c => {
                const cs = (c.singer || '').trim();
                return !cleanSinger || cs === cleanSinger || cs.includes(cleanSinger);
            }) || candidates[0];
            if (!valid || !valid.id) return null;
            const LEVELS = ['exhigh', 'lossless', 'higher', 'standard'];
            for (const level of LEVELS) {
                try {
                    const c2 = new AbortController();
                    const t2 = setTimeout(() => c2.abort(), 8000);
                    const resp = await fetch(`https://api.byfuns.top/1/?id=${valid.id}&level=${level}`, { signal: c2.signal });
                    clearTimeout(t2);
                    const text = (await resp.text()).trim();
                    if (text.startsWith('http')) {
                        logInfo('musicApi', `[跨源] 网易云同名歌成功: ${valid.song} - ${valid.singer} (音质:${level})`);
                        return { url: text, cover: valid.cover || '', id: String(valid.id) };
                    }
                } catch (e) { /* 试下一音质 */ }
            }
            /* byfuns 全败：网易外链兜底（版权受限歌可能404，交给音频错误处理链接管） */
            return { url: `https://music.163.com/song/media/outer/url?id=${valid.id}`, cover: valid.cover || '', id: String(valid.id) };
        } catch (e) {
            logWarn('musicApi', '[跨源] 网易云同名歌检索异常:', e.message);
        }
        return null;
    }

    return null;
}

/**
 * 在线音频播放性校验：服务端读目标URL首2KB即断（本地已有完整缓存时秒回 ok）
 * 解决"取链成功≠可播"缺口：试听链/失效链/防盗链在提交给 <audio> 前即被拦截
 * @returns {Promise<boolean>} true=可播
 */
export async function checkAudioUrlPlayable(url, songId, referer, expectedSec) {
    if (!url || !url.startsWith('http')) return false;
    try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 12000);
        const params = new URLSearchParams({ url });
        if (songId) params.set('songId', String(songId));
        /* 与流代理回源条件保持一致：QQ系CDN需 y.qq.com Referer，否则探测误判 */
        if (referer) params.set('referer', referer);
        /* 期望整曲时长（秒）：服务端按探测到的总字节粗判是否"试听预览"，预览视为不可播 */
        if (expectedSec && expectedSec > 0) params.set('expectedSec', String(Math.round(expectedSec)));
        let data;
        try {
            data = await fetch(`/api/audio/check?${params.toString()}`, { signal: ctl.signal }).then(r => r.json());
        } finally { clearTimeout(timer); }
        return !!(data && data.ok);
    } catch (e) {
        logWarn('musicApi', '[AudioCheck] 校验异常(按不可播处理):', e.message);
        return false;
    }
}

/**
 * 咪咕同名歌取链（官方 H5 接口，后端已内置探测校验与免登录兜底）
 * 链路: /api/migu/search 搜索 → 歌名/歌手双匹配选歌 → /api/migu/url 取HQ直链
 * @returns {Promise<{url:string, id?:string}|null>}
 */
export async function fetchMiguSameSongUrl(title, singer) {
    const cleanTitle = stripEm(title);
    const cleanSinger = stripEm(singer);
    const searchWord = `${cleanTitle} ${cleanSinger}`.trim();
    if (!cleanTitle) return null;
    try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 15000);
        let res;
        try {
            res = await fetch(`/api/migu/search?keyword=${encodeURIComponent(searchWord)}`, { signal: ctl.signal }).then(r => r.json());
        } finally { clearTimeout(timer); }
        if (!(res && res.ok && Array.isArray(res.songs) && res.songs.length)) return null;
        const kw = cleanTitle.toLowerCase();
        const ks = cleanSinger.toLowerCase();
        /* 双匹配 > 仅歌名（与酷狗/网易云同名歌策略一致） */
        const best = res.songs.find(s =>
            (s.name || '').toLowerCase().includes(kw) &&
            ks && (s.singer || '').toLowerCase().includes(ks))
            || res.songs.find(s => (s.name || '').toLowerCase().includes(kw));
        if (!best) return null;
        const q = new URLSearchParams({ contentId: best.contentId, copyrightId: best.copyrightId });
        const d2 = await fetch(`/api/migu/url?${q.toString()}`).then(r => r.json());
        if (d2 && d2.ok && d2.url) {
            logInfo('musicApi', `[跨源] 咪咕同名歌成功: ${best.name} - ${best.singer} (音质:${d2.quality})`);
            return { url: d2.url, id: `migu_${best.contentId}` };
        }
        return null;
    } catch (e) {
        logWarn('musicApi', '[跨源] 咪咕同名歌检索异常:', e.message);
        return null;
    }
}

/**
 * 获取播放链接
 */
export async function getPlayUrl(songInfo, source) {
    if (songInfo.url) return songInfo.url;
    const songId = songInfo.id;
    const songMid = songInfo.mid;

    if (source === 'kugou' || songInfo.source === 'kugou') {
        const hash = songInfo.hash || songMid || songId;
        const kgInfo = await getKugouPlayInfo(hash, songInfo.song || songInfo.name, songInfo.singer || songInfo.artist);
        if (kgInfo && kgInfo.url) {
            if (kgInfo.cover && !songInfo.cover) songInfo.cover = kgInfo.cover;
            return kgInfo.url;
        }
    } else if (source === 'tencent') {
        // 0. 优先走本地解析池：多API竞速 + 分层降级 + 防试听校验（按用户播放音质裁剪阶梯）
        const userQ = (globalThis.appSettings && globalThis.appSettings.quality && globalThis.appSettings.quality.qqPlayback) || '320';
        const resolved = await qqResolveUrl(songMid || songId, intervalToSec(songInfo.interval) || songInfo.duration, userQ);
        if (resolved) return resolved;

        // 1. 回退原链：ygking 五档音质循环
        const YGK_QUALITIES = ['master', 'atmos', 'flac', '320', '128'];
        if (songMid) {
            for (const quality of YGK_QUALITIES) {
                try {
                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 8000);
                    const resp = await fetch(`https://api.ygking.top/api/song/url?mid=${songMid}&quality=${quality}`, { signal: controller.signal });
                    clearTimeout(timeout);
                    const ygkJson = await resp.json();
                    if (ygkJson.code === 0 && ygkJson.data && ygkJson.data[songMid]) {
                        const url = ygkJson.data[songMid];
                        if (url && url.startsWith('http')) {
                            logInfo('musicApi', `ygking.top 获取成功 (音质: ${quality}): ${songInfo.song}`);
                            return url;
                        }
                    }
                } catch (e) {
                    logWarn('musicApi', `ygking.top ${quality} 获取失败:`, e.message);
                }
            }
        }

        if (songMid) {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 8000);
                const resp = await fetch(`https://api.moeyao.cn/meting/?server=tencent&type=url&id=${songMid}`, { signal: controller.signal });
                clearTimeout(timeout);
                const text = await resp.text();
                if (text && text.startsWith('http')) {
                    logInfo('musicApi', `moeyao meting 获取成功: ${songInfo.song}`);
                    return text.trim();
                }
            } catch (e) {
                logWarn('musicApi', 'moeyao meting 获取失败:', e.message);
            }
        }

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            const urlJson = await fetch(`${API_BASE}/tencent?id=${songId}`, { signal: controller.signal }).then(r => r.json());
            clearTimeout(timeout);
            if (urlJson.code === 200 && urlJson.data && urlJson.data.url) {
                logInfo('musicApi', `vkeys 获取成功: ${songInfo.song}`);
                return urlJson.data.url;
            }
        } catch (e) {
            logWarn('musicApi', 'QQ音乐 vkeys 请求失败:', e);
        }

    } else if (source === 'netease') {
        const QUALITY_LEVELS = ['hires', 'lossless', 'exhigh', 'higher', 'standard'];
        for (const level of QUALITY_LEVELS) {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 8000);
                const resp = await fetch(`https://api.byfuns.top/1/?id=${songId}&level=${level}`, { signal: controller.signal });
                clearTimeout(timeout);
                const text = await resp.text();
                if (text && text.startsWith('http')) {
                    logInfo('musicApi', `byfuns API 获取成功 (音质: ${level}): ${songInfo.song}`);
                    return text.trim();
                }
            } catch (e) {
                logWarn('musicApi', `byfuns API ${level} 获取失败:`, e.message);
            }
        }

        logWarn('musicApi', 'byfuns API 全部音质失败，回退到网易云外链');
        return `https://music.163.com/song/media/outer/url?id=${songId}`;

    } else {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            const urlJson = await fetch(`${API_BASE}/${source || 'tencent'}?id=${songId}`, { signal: controller.signal }).then(r => r.json());
            clearTimeout(timeout);
            if (urlJson.code === 200 && urlJson.data && urlJson.data.url) {
                return urlJson.data.url;
            }
        } catch (e) {
            logWarn('musicApi', 'vkeys 请求失败:', e);
        }
    }

    return null;
}

/**
 * oiapi.net 备用歌词获取（仅用于 QQ 音乐歌曲，返回 {yrc} 或 {lrc}）
 */
export async function fetchLyricFromOiapi(songId) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const resp = await fetch(`${OIAPI_LYRIC_BASE}?id=${songId}&format=qrc`, { signal: controller.signal });
        clearTimeout(timeout);
        const json = await resp.json();
        if (json.code === 1 && json.data && json.data.content) {
            logInfo('musicApi', 'oiapi.net QRC 歌词获取成功');
            return { yrc: json.data.content };
        }
    } catch (e) {
        logWarn('musicApi', 'oiapi.net QRC 歌词获取失败:', e.message);
    }
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const resp = await fetch(`${OIAPI_LYRIC_BASE}?id=${songId}&format=lrc`, { signal: controller.signal });
        clearTimeout(timeout);
        const json = await resp.json();
        if (json.code === 1 && json.data && json.data.content) {
            logInfo('musicApi', 'oiapi.net LRC 歌词获取成功');
            return { lrc: json.data.content };
        }
    } catch (e) {
        logWarn('musicApi', 'oiapi.net LRC 歌词获取失败:', e.message);
    }
    return {};
}

/**
 * 获取酷狗 KRC 逐字歌词
 * 支持 2 步智能检索：当无 hash 时自动先搜索同名歌曲获取最优 hash 与 KRC
 */
export async function fetchKugouLyric(songInfo) {
    const title = songInfo.song || songInfo.title || songInfo.name || '';
    const singer = songInfo.singer || songInfo.artist || '';
    let hash = songInfo.hash || (songInfo.source === 'kugou' && songInfo.id ? songInfo.id : '') || '';
    let durMs = (songInfo.duration || 0) * 1000;

    // 1. 如果没有有效 32 字符 hash（例如跨源切换歌词时），先搜索酷狗获取匹配度最高的歌曲 hash
    if (!hash || hash.length < 16) {
        try {
            const sRes = await searchKugouSongs(`${title} ${singer}`);
            if (sRes.success && sRes.list && sRes.list.length > 0) {
                /* ★★ 不能盲取 list[0]。跨源取词时（典型：给 QQ 的英文歌找中文词），
                   酷狗搜出来的第一条可能是**另一首歌**（同名翻唱/翻填/其它语种版本），
                   取错就整支歌词都不是这首歌的。
                   ★ 这一步曾经绕过 fetchSameNameLyric 里的 _pickBest 校验，所以必须在这里
                   也做名称校验：去括号后比较，要求存在包含关系，否则放弃酷狗这条路
                   （交给网易云/腾讯，宁可暂时没词也不显示别的歌的词）。 */
                const norm = (t) => String(t || '').toLowerCase()
                    .replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim();
                const want = norm(title);
                const best = sRes.list.find((it) => {
                    const got = norm(it.song);
                    return !!(got && want && (got === want || got.includes(want) || want.includes(got)));
                });
                if (!best) {
                    logWarn('musicApi', `[KuGou Lyric] 搜索无同名结果，放弃酷狗取词: ${title}`);
                    return {};
                }
                hash = best.hash;
                if (!durMs && best.duration) durMs = best.duration * 1000;
            }
        } catch (e) {
            logWarn('musicApi', '[KuGou Lyric] 搜索匹配歌曲异常:', e);
        }
    }

    if (!hash && !title) return {};

    // 2. 检索 KRC 候选列表并下载（依次尝试 lyrics.kugou.com 和 krcs.kugou.com）
    const searchEndpoints = [
        `http://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${encodeURIComponent(title)}&duration=${durMs}&hash=${hash}`,
        `http://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=${encodeURIComponent(title)}&duration=${durMs}&hash=${hash}`
    ];

    for (const searchUrl of searchEndpoints) {
        try {
            const res = await proxyFetch(searchUrl, { timeout: 6000 });
            const json = await res.json();
            const candidates = json.candidates || [];

            if (candidates.length > 0) {
                const best = candidates[0];
                const downloadUrl = `http://lyrics.kugou.com/download?ver=1&client=pc&id=${best.id}&accesskey=${best.accesskey}&fmt=krc&charset=utf8`;
                const dlRes = await proxyFetch(downloadUrl, { timeout: 6000 });
                const krcJson = await dlRes.json();

                if (krcJson && krcJson.content) {
                    const decryptedText = await decryptKrc(krcJson.content);
                    const parsedLyrics = parseKrc(decryptedText);
                    if (parsedLyrics.length > 0) {
                        logInfo('musicApi', `[KuGou Lyric] KRC 逐字歌词解析成功: ${parsedLyrics.length} 行`);
                        return {
                            parsedList: parsedLyrics,
                            krcText: decryptedText,
                            source: 'kugou'
                        };
                    }
                }
            }
        } catch (e) {
            logWarn('musicApi', '[KuGou Lyric] KRC 候选接口异常:', e.message);
        }
    }

    // 3. LRC 回退方案（使用 Meting API 获取酷狗 LRC）
    if (hash) {
        const metingUrls = [
            `https://api.moeyao.cn/meting/?server=kugou&type=lrc&id=${hash}`,
            `https://api.injahow.cn/meting/?server=kugou&type=lrc&id=${hash}`
        ];
        for (const metingUrl of metingUrls) {
            try {
                const res = await fetch(metingUrl);
                const lrcText = await res.text();
                if (lrcText && lrcText.trim() && lrcText.includes('[')) {
                    const parsedLrc = parseLrc(lrcText).map((item, index, arr) => ({
                        start: item.time,
                        end: index < arr.length - 1 ? arr[index + 1].time : item.time + 5000,
                        original: item.text,
                        words: []
                    }));
                    if (parsedLrc.length > 0) {
                        return {
                            parsedList: parsedLrc,
                            lrc: lrcText,
                            source: 'kugou'
                        };
                    }
                }
            } catch (e) { /* 尝试下一个 meting 源 */ }
        }
    }

    return {};
}

/* 带超时的 JSON fetch：兜底链路的每一环都必须 bounded，
   否则某个外部接口挂起会让 lyricPromise 永不落地 → 歌词永久为空（切歌场景已复现） */
async function fetchJsonWithTimeout(url, timeoutMs = 8000) {
    const ctl = new AbortController();
    const tid = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ctl.signal });
        return await res.json();
    } catch (e) {
        return {};
    } finally {
        clearTimeout(tid);
    }
}

/* ============================================================
 * ★ 自建 vendor 歌词（2026-09-22）：「vendor 优先、公网兜底」全链路原则。
 *   vkeys.cn 公网失联时 QQ/网易歌词全挂（有音无词）；本机 vendor 毫秒级回包：
 *   - QQ     /getLyric?songmid=  → {response:{lyric:"[ti:...]"}}
 *   - 网易   /lyric?id=          → {lrc:{lyric}, tlyric:{lyric}}（自带翻译行）
 *   统一规范化为 {lrc, trans}（与 vkeys 形状一致，lyricMerger 直接消费）。
 *   失败/未在线返回 null，由调用方回落公网 vkeys。
 * ============================================================ */
export async function fetchVendorLyric(source, songId) {
    try {
        if (!songId) return null;
        let path;
        if (source === 'tencent') path = `/getLyric?songmid=${encodeURIComponent(String(songId))}`;
        else if (source === 'netease') path = `/lyric?id=${encodeURIComponent(String(songId))}`;
        else return null;
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 4000);
        const res = await fetch(`/api/selfhost/${source}/proxy?path=${encodeURIComponent(path)}`, { signal: ctl.signal });
        clearTimeout(timer);
        if (!res.ok) return null;
        const j = await res.json();
        if (source === 'tencent') {
            const lrc = ((j.response || {}).lyric) || '';
            return (lrc && lrc.includes('[')) ? { lrc } : null;
        }
        const lrc = ((j.lrc || {}).lyric) || '';
        const trans = ((j.tlyric || {}).lyric) || '';
        if (lrc && lrc.includes('[')) return trans ? { lrc, trans } : { lrc };
        return null;
    } catch (e) {
        return null;  /* vendor 未在线/超时 → 静默回退公网 */
    }
}

/**
 * 带多源备用的歌词获取：先 vkeys（失败自动重试一次），再 oiapi / 酷狗同名 / 网易云同名 / 腾讯同名，
 * 保证冷启动开头几首歌也能稳定拿到歌词（外网接口慢/超时不再直接空窗）
 */
export async function fetchLyricWithFallback(songInfo, source) {
    const songId = typeof songInfo === 'object' ? songInfo.id : songInfo;
    const effSource = (typeof songInfo === 'object' && songInfo.source) || source;
    const songName = typeof songInfo === 'object' ? (songInfo.song || songInfo.name || songInfo.title || '') : '';
    const hasContent = (d) => !!d && (d.yrc || d.lrc || d.krc || d.parsedList || d.lrcList || d.lrclist);

    /* ★ vendor 优先（2026-09-22）：本机自建服务毫秒级回包，命中即跳过整个
       vkeys 重试循环（公网失联时原链要白等 7s×2 次重试才进兜底）。 */
    if (effSource === 'tencent' || effSource === 'netease') {
        const vendorLyric = await fetchVendorLyric(effSource, songId);
        if (hasContent(vendorLyric)) {
            logInfo('musicApi', `[Lyric] ${effSource} 歌词走自建服务命中`);
            return vendorLyric;
        }
    }

    /* ★ 同名歌兜底：官方源全部失败时，按"歌名+歌手"相似度匹配候选再取词，
       依次尝试 酷狗(KRC高精度) → 网易云(自带双语 trans) → 腾讯QQ ，
       ★ 必须做名称/歌手契合度校验：防止拿酷我/酷狗的 id 去别的源查到完全不同的歌
       （实测发生过取到《Voyage 滨崎步》之类的错误歌词，最终渲染 0 行）。 */
    const _pickBest = (list, word, singer) => {
        if (!Array.isArray(list) || list.length === 0) return null;
        const w = String(word || '').toLowerCase().trim();
        const s = String(singer || '').toLowerCase().trim();
        const cap = (t) => String(t || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, '').trim();
        let hit = null;
        for (const it of list) {
            const t = it.song || it.name || it.title || '';
            const a = it.singer || it.artist || '';
            // 优先：歌名完全相等（可含空格差异）+ 歌手包含
            if (cap(t) === w && s && cap(a).includes(s)) { hit = it; break; }
        }
        if (!hit) {
            // 其次：歌名相等即可（单侧匹配）
            hit = list.find(it => cap(it.song || it.name || it.title || '') === w);
        }
        if (!hit) {
            /* ★ 不再盲目取第一条。原先 `hit = list[0]` 在「歌名完全不匹配」时会把
               搜索里的**另一首歌**当成结果 → 表现为「歌词对不上 / 有时候不准」。
               现在只在歌名存在包含关系时才接受第一条，否则放弃（交上层继续兜底，
               宁可暂时没词，也不显示另一首歌的词）。 */
            const first = list[0];
            const ft = cap(first.song || first.name || first.title || '');
            if (ft && w && (ft.includes(w) || w.includes(ft))) hit = first;
        }
        return hit;
    };

    const fetchSameNameLyric = async () => {
        const word = `${songName} ${typeof songInfo === 'object' ? (songInfo.singer || songInfo.artist || '') : ''}`.trim();
        const singer = typeof songInfo === 'object' ? (songInfo.singer || songInfo.artist || '') : '';
        if (!songName || !word) return {};
        /* ★★ 三段兜底并行竞速（Promise.any 先到先用）：
           酷狗 → 网易云 → 腾讯QQ 同时发起，谁先拿到有内容的歌词就赢，
           避免串行 30s+ 的漫长等待（此前实测切歌后歌词要 ~30s 才填充）。 */
        const kugouP = (async () => {
            try {
                const kg = await fetchKugouLyric(typeof songInfo === 'object' ? songInfo : { song: songName });
                return (kg && hasContent(kg)) ? kg : null;
            } catch (e) { return null; }
        })();
        const neteaseP = (async () => {
            try {
                const nRes = await fetchJsonWithTimeout(`${API_BASE}/netease?word=${encodeURIComponent(word)}&num=10`);
                const nList = (nRes.code === 200 && Array.isArray(nRes.data)) ? nRes.data : null;
                const nItem = nList ? _pickBest(nList, songName, singer) : null;
                if (nItem && nItem.id) {
                    const lyr = await fetchJsonWithTimeout(`${API_BASE}/netease/lyric?id=${nItem.id}`);
                    if (lyr.code === 200 && lyr.data && (lyr.data.yrc || lyr.data.lrc)) return lyr.data;
                }
            } catch (e) { logWarn('musicApi', e); }
            return null;
        })();
        const tencentP = (async () => {
            try {
                const tRes = await fetchJsonWithTimeout(`${API_BASE}/tencent?word=${encodeURIComponent(word)}&num=10`);
                const tList = (tRes.code === 200 && Array.isArray(tRes.data)) ? tRes.data : null;
                const tItem = tList ? _pickBest(tList, songName, singer) : null;
                if (tItem && tItem.id) {
                    const lyr = await fetchJsonWithTimeout(`${API_BASE}/tencent/lyric?id=${tItem.id}`);
                    if (lyr.code === 200 && lyr.data && (lyr.data.yrc || lyr.data.lrc)) return lyr.data;
                }
            } catch (e) { logWarn('musicApi', e); }
            return null;
        })();
        /* 竞速取第一个"有内容"的结果；全部失败时返回 {}。总预算 20s 兜底。 */
        const budget = new Promise(resolve => setTimeout(() => resolve(null), 20000));
        const winner = await Promise.race([
            Promise.any([kugouP, neteaseP, tencentP]).catch(() => null),
            budget
        ]);
        return winner || {};
    };

    if (effSource === 'kugou') {
        const kgRes = await fetchKugouLyric(typeof songInfo === 'object' ? songInfo : { song: songName });
        if (hasContent(kgRes)) return kgRes;
        logWarn('musicApi', '酷狗官方歌词无结果，尝试同名歌曲兜底');
        return fetchSameNameLyric();
    }

    if (effSource === 'kuwo') {
        const kwRes = await fetchKuwoLyric(typeof songInfo === 'object' ? songInfo : { song: songName });
        if (hasContent(kwRes)) return kwRes;
        logWarn('musicApi', '酷我官方歌词无结果，尝试同名歌曲兜底');
        return fetchSameNameLyric();
    }

    // ★ 歌词主链路必须带超时：loadOnlineSong 会先 await 歌词再开始播放，
    //   若此请求挂起会同时卡住"歌词显示 + 歌曲播放"，只有刷新才能恢复。
    //   冷启动/网络抖动时首次易超时：失败后自动重试一次，再走备用源。
    let lyricData = {};
    for (let attempt = 0; attempt < 2; attempt++) {
        const lyController = new AbortController();
        const lyTimer = setTimeout(() => lyController.abort(), 7000);
        let lyricRes = {};
        try {
            lyricRes = await fetch(`${API_BASE}/${effSource}/lyric?id=${songId}`, { signal: lyController.signal })
                .then(r => r.json());
        } catch (e) { /* 超时/网络错误，进入重试或备用源 */ }
        clearTimeout(lyTimer);
        if (lyricRes.code === 200 && lyricRes.data && (lyricRes.data.yrc || lyricRes.data.lrc)) {
            lyricData = lyricRes.data;
            break;
        }
        if (attempt === 0) {
            logWarn('musicApi', `[Lyric] vkeys ${effSource} 歌词为空，稍候重试一次`);
            await new Promise(r => setTimeout(r, 900));
        }
    }
    if (hasContent(lyricData)) return lyricData;
    logWarn('musicApi', 'vkeys 歌词获取失败或为空，尝试备用歌词源');
    if (effSource === 'tencent') {
        const oi = await fetchLyricFromOiapi(songId);
        if (hasContent(oi)) return oi;
    }
    /* 最终兜底：同名歌搜索（酷狗→网易云），网易云顺带提供双语翻译 */
    const same = await fetchSameNameLyric();
    if (hasContent(same)) return same;
    return {};
}

/**
 * 获取随机歌曲
 */
export async function fetchRandomSong(source = 'tencent') {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(`${API_BASE}/random?source=${source}`, { signal: controller.signal });
        clearTimeout(timeout);
        const json = await res.json();
        if (json.code === 200 && json.data) {
            return json.data;
        }
    } catch (e) {
        logWarn('musicApi', '随机歌曲获取失败:', e);
    }
    return null;
}

export { apiSearchSongs as searchSongs };
