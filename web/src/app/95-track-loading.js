/* ============================================================
 * 95-track-loading.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 2478-2616 行 | 单元数: 6
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { audio } from './20-lyrics-render.js';
import { loadMusicBtn, musicFileInput, songArtistEl, songTitleEl } from './30-dom-refs.js';
import { getLyricOffset, updateLineTimes, updateLyricOffsetUI } from './40-playback-state.js';
import { waitForAudioReady } from './65-playback-position.js';
import { handleAudioPlayError } from './70-audio-engine.js';
import { applyPreservesPitch } from './85-rate-download.js';
import { makeSongKey, updateFavoriteBtn } from './120-search-results.js';
import { applyVolumeOnSongChange, loadPlaylistTrack } from './135-crossfade.js';
import { fetchAndPlayRandomSong } from './155-random-toast-match.js';
import { getStreamCachedAudioUrl } from './180-boot-config.js';
import { logInfo, logWarn, logError } from '../services/log.js';

/* ========== 歌曲开播后的统一收尾任务 ========== */
/* ★ 消除 95/135/130/125/180/175 六处重复的「AI 分析 + 高潮检测」触发块：
   队尾续推（可选）+ AI 智能分析 + 高潮检测。
   opts.gen      数字时，AI/高潮触发前校验 gen === playbackGeneration（防止切歌后迟到触发）
   opts.stagger  真时错峰 5s/6s 触发（在线资源防起步 1–2s 高开销窗口卡顿）
   opts.refill   假时跳过队尾续推（本地文件/收藏直播场景保持原行为：不自动追加日推） */
const _postLoadTasks = (opts) => {
    const o = opts || {};
    const isCurrent = () => (o.gen === null || o.gen === undefined || o.gen === playbackGeneration);
    if (o.refill !== false && typeof Aria.__maybeQueueRefill === 'function') Aria.__maybeQueueRefill();
    if (o.stagger) {
        if (typeof triggerAiAnalysisIfNeeded === 'function') {
            setTimeout(() => { if (isCurrent()) triggerAiAnalysisIfNeeded(); }, 5000);
        }
        if (typeof detectChorus === 'function') {
            const chorusSrc = audio.src;  /* 提前取快照，避免 6s 后 src 已切换 */
            setTimeout(() => { if (isCurrent()) detectChorus(chorusSrc); }, 6000);
        }
    } else {
        if (typeof triggerAiAnalysisIfNeeded === 'function') triggerAiAnalysisIfNeeded();
        if (typeof detectChorus === 'function') detectChorus(audio.src);
    }
};
globalThis.triggerPostLoadTasks = _postLoadTasks;

/* ========== 本地直链歌曲播放收尾（loadTrack 与 loadPlaylistTrack 本地分支共用）==========
   ★ 合并两处镜像分支：waitForAudioReady → play → 成功收尾（retryCount 复位 / 音量 /
   triggerPostLoadTasks 错峰任务）；失败走 handleAudioPlayError + 可选 opts.onPlayFail 重试。
   track 仅用于失败重试场景的歌曲信息，成功路径不使用（各调用方负责 UI/封面/data 更新）。*/
function _playLocalTrackOnReady(gen, opts) {
    const readyPromise = waitForAudioReady();
    readyPromise.then(() => {
        if (gen !== playbackGeneration) return;  /* 已过期 */
audio.play().then(() => {
if (gen !== playbackGeneration) return;
retryCount = 0;
applyVolumeOnSongChange();
/* 队尾续推 + AI 智能分析 + 高潮检测（默认错峰；opts.refill=false 不续推，opts.stagger=false 立即触发） */
if (typeof triggerPostLoadTasks === 'function') {
triggerPostLoadTasks({
gen: gen,
refill: (opts && opts.refill === false) ? false : undefined,
stagger: (opts && opts.stagger === false) ? false : true
});
}
}).catch((e) => {
if (gen !== playbackGeneration) return;
if (e != null) logError('trackLoading', '播放失败:', e);
handleAudioPlayError();
if (opts && typeof opts.onPlayFail === 'function') opts.onPlayFail();
});
            }).catch(() => {
                if (gen !== playbackGeneration) return;
                handleAudioPlayError();
                logError('trackLoading', '音频加载超时');
                if (opts && typeof opts.onTimeout === 'function') opts.onTimeout();
            });
        }
/* ★ 供 135-crossfade 的 loadPlaylistTrack 本地分支复用（不新增模块依赖边，
   与 triggerPostLoadTasks 相同的裸全局暴露模式） */
globalThis._playLocalTrackOnReady = _playLocalTrackOnReady;

function loadTrack(index) {
            if (playlist.length === 0) return;
            currentTrackIndex = ((index % playlist.length) + playlist.length) % playlist.length;
            retryCount = 0;  /* 切歌时重置重试计数器 */
            const track = playlist[currentTrackIndex];
            /* 代际计数器递增，使上一次的异步回调过期 */
            const gen = ++playbackGeneration;
            /* 先暂停并重置 audio，避免上一首歌的 readyState 干扰 */
            audio.pause();
            audio.removeAttribute('src');
            audio.src = getStreamCachedAudioUrl(track.url, track.mid || track.id || track.title);
            audio.load();
            audio.playbackRate = currentPlaybackRate;
            applyPreservesPitch(preservesPitch);
            songTitleEl.textContent = track.title || track.song || track.name;
            songArtistEl.textContent = track.artist || track.singer || '未知歌手';
            /* 更新当前歌曲信息与收藏按钮状态（本地文件） */
            currentSongData = {
                title: track.title || track.song || track.name,
                artist: track.artist || track.singer || '未知歌手',
                cover: '',
                source: 'local',
                id: '',
                url: track.url
            };
            currentSongKey = makeSongKey(currentSongData);
            lyricOffset = getLyricOffset(currentSongKey); updateLyricOffsetUI();
            updateLineTimes();  /* ★ 切歌后更新时间标签 */
            updateFavoriteBtn();
            /* 等待音频就绪后再播放（本地文件保持原行为：不做失败重试） */
            _playLocalTrackOnReady(gen, {});
        }

/* ========== 上一曲 / 下一曲（合并镜像分支）==========
   nextTrack / prevTrack 唯一差异是步进方向，合并为 _stepTrack(delta)：
   `delta = +1`（下一曲）/ `-1`（上一曲）。播放模式语义完全保留。 */
function _stepTrack(delta) {
            if (playlist.length === 0) {
                /* 没有播放队列时，从随机API获取一首 */
                fetchAndPlayRandomSong();
                return;
            }
            /* 单曲循环：重新播放当前歌曲 */
            if (playMode === 'loop') {
                loadPlaylistTrack(currentTrackIndex);
                return;
            }
            /* 随机模式：下一首/上一首都随机抽一首不同的 */
            if (playMode === 'random') {
                if (playlist.length === 1) {
                    /* 只有一首，保持不变 */
                } else {
                    const oldIdx = currentTrackIndex;
                    do {
                        currentTrackIndex = Math.floor(Math.random() * playlist.length);
                    } while (currentTrackIndex === oldIdx);
                }
            } else {
                currentTrackIndex = (currentTrackIndex + delta + playlist.length) % playlist.length;
            }
            const track = playlist[currentTrackIndex];
            if (track.source && track.id) {
                loadPlaylistTrack(currentTrackIndex);
            } else {
                loadTrack(currentTrackIndex);
            }
        }

function nextTrack() {
            _stepTrack(1);
        }

function prevTrack() {
            _stepTrack(-1);
        }

/* ========== 文件加载 ========== */
loadMusicBtn?.addEventListener('click', () => {
            musicFileInput.click();
        });

/* 存储已创建的 blob URL 以便释放 */
const blobUrls = new Set();

musicFileInput?.addEventListener('change', (e) => {
            const files = Array.from(e.target.files);
            if (files.length === 0) return;
            /* 释放旧的 blob URL */
            blobUrls.forEach(url => URL.revokeObjectURL(url));
            blobUrls.clear();
            /* 创建新的 blob URL */
            playlist = files.map(f => {
                const url = URL.createObjectURL(f);
                blobUrls.add(url);
                return {
                    url: url,
                    title: f.name.replace(/\.[^/.]+$/, ''),
                    artist: '本地文件'
                };
            });
            loadTrack(0);
        });

export { blobUrls, loadTrack, nextTrack, prevTrack, _playLocalTrackOnReady };
