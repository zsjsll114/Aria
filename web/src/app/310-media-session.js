/* ============================================================
 * 310-media-session.js — 系统媒体控制（Media Session API）与动态页面标题
 *
 * 打通 Windows SMTC / 硬件媒体键 / 浏览器媒体控件与标签页标题同步：
 *   - 展示当前曲名、歌手、专辑与封面（跟随在线/本地/接管切歌实时刷新）
 *   - 响应播放、暂停、上一曲、下一曲、进度跳转与快进/快退按键
 *   - 节流同步播放进度状态（PositionState）与播放状态（playing / paused）
 *   - 浏览器标签页实时展示正在播放的曲目，多标签场景一目了然
 * ============================================================ */
import { state } from '../infrastructure/state.js';
import { getCoverLayers } from '../infrastructure/dom.js';
import { onRoleSwap, registerAudioListener } from '../core/dualDeck.js';
import {
    buildMediaMetadataInit,
    clampPositionState,
    formatDocumentTitle,
} from '../core/mediaSession.js';
import { getDuration } from './56-playback-misc.js';
import { togglePlayPause, updatePlaybackPosition } from './65-playback-position.js';
import { nextTrack, prevTrack } from './95-track-loading.js';
import { audio } from './20-lyrics-render.js';
import { songArtistEl, songTitleEl } from './30-dom-refs.js';
import { logCatch } from '../services/log.js';

const TAG = 'mediaSession';
const DEFAULT_DOC_TITLE = (typeof document !== 'undefined' && document.title) ? document.title : 'Aria - 歌词播放器';
const POSITION_SYNC_MIN_MS = 1000;

let _lastMetaKey = '';
let _lastPosSyncAt = 0;

function isNowPlayingTakeover() {
    return Boolean(typeof window !== 'undefined' && window.Aria && window.Aria.__npActive && window.Aria.__npActive());
}

function activeCoverSrc() {
    try {
        const layers = getCoverLayers();
        for (const img of layers) {
            if (img && img.src && img.style && img.style.opacity !== '0') return img.src;
        }
        for (const img of layers) {
            if (img && img.src) return img.src;
        }
    } catch (e) {
        logCatch(TAG, e);
    }
    return '';
}

function currentTrackSnapshot() {
    const domTitle = songTitleEl ? songTitleEl.textContent : '';
    const domArtist = songArtistEl ? songArtistEl.textContent : '';
    const coverUrl = activeCoverSrc();
    if (isNowPlayingTakeover()) {
        return {
            track: { title: domTitle, artist: domArtist, cover: coverUrl },
            domTitle,
            domArtist,
            coverUrl,
        };
    }
    return {
        track: state.currentSongData || null,
        domTitle,
        domArtist,
        coverUrl,
    };
}

function syncDocumentTitle() {
    if (typeof document === 'undefined') return;
    const { track, domTitle, domArtist } = currentTrackSnapshot();
    const title = (track && (track.title || track.song || track.name)) || domTitle;
    const artist = (track && (track.artist || track.singer)) || domArtist;
    const playing = Boolean(audio && !audio.paused && !audio.ended);
    const nextDocTitle = formatDocumentTitle(title, artist, playing, DEFAULT_DOC_TITLE);
    if (document.title !== nextDocTitle) {
        document.title = nextDocTitle;
    }
}

function syncMediaMetadata() {
    if (typeof navigator === 'undefined' || !navigator.mediaSession) return;
    const { track, domTitle, domArtist, coverUrl } = currentTrackSnapshot();
    const origin = (typeof location !== 'undefined' && location.origin) ? location.origin : '';
    const init = buildMediaMetadataInit(track, { domTitle, domArtist, coverUrl, origin });
    if (!init) return;
    const key = `${init.title}\0${init.artist}\0${init.album}\0${(init.artwork[0] && init.artwork[0].src) || ''}`;
    if (key === _lastMetaKey) return;
    _lastMetaKey = key;
    try {
        if (typeof MediaMetadata !== 'undefined') {
            navigator.mediaSession.metadata = new MediaMetadata(init);
        }
    } catch (e) {
        logCatch(TAG, e);
    }
}

function syncPlaybackAndPosition(force = false) {
    syncDocumentTitle();
    if (typeof navigator === 'undefined' || !navigator.mediaSession) return;
    const hasSrc = Boolean(audio && (audio.currentSrc || audio.src));
    try {
        navigator.mediaSession.playbackState = !hasSrc
            ? 'none'
            : (audio.paused ? 'paused' : 'playing');
    } catch (e) {
        logCatch(TAG, e);
    }
    if (!hasSrc || typeof navigator.mediaSession.setPositionState !== 'function') return;
    const now = Date.now();
    if (!force && (now - _lastPosSyncAt) < POSITION_SYNC_MIN_MS) return;
    const durFromAudio = (audio && Number.isFinite(audio.duration) && audio.duration > 0)
        ? audio.duration
        : (getDuration() / 1000);
    const posState = clampPositionState(audio ? audio.currentTime : 0, durFromAudio, audio ? audio.playbackRate : 1);
    if (!posState) return;
    _lastPosSyncAt = now;
    try {
        navigator.mediaSession.setPositionState(posState);
    } catch (e) {
        logCatch(TAG, e);
    }
}

function syncAll(forcePos = false) {
    syncMediaMetadata();
    syncPlaybackAndPosition(forcePos);
}

function seekByOffset(offsetSec) {
    if (!audio || isNowPlayingTakeover()) return;
    const dur = (Number.isFinite(audio.duration) && audio.duration > 0)
        ? audio.duration
        : (getDuration() / 1000);
    if (!Number.isFinite(dur) || dur <= 0) return;
    audio.currentTime = Math.max(0, Math.min(dur, (audio.currentTime || 0) + offsetSec));
    state.currentTime = audio.currentTime * 1000;
    updatePlaybackPosition();
    syncPlaybackAndPosition(true);
}

function initMediaSessionHandlers() {
    if (typeof navigator === 'undefined' || !navigator.mediaSession) return;
    const ms = navigator.mediaSession;
    const stepDefault = () => Math.max(1, Number(state.appSettings && state.appSettings.playback && state.appSettings.playback.seekStep) || 5);
    const register = (action, fn) => {
        try {
            ms.setActionHandler(action, fn);
        } catch (e) {
            logCatch(TAG, e);
        }
    };
    register('play', () => {
        if (isNowPlayingTakeover()) return;
        if (audio && audio.paused) togglePlayPause();
    });
    register('pause', () => {
        if (isNowPlayingTakeover()) return;
        if (audio && !audio.paused) togglePlayPause();
    });
    register('previoustrack', () => {
        if (isNowPlayingTakeover()) return;
        prevTrack();
    });
    register('nexttrack', () => {
        if (isNowPlayingTakeover()) return;
        nextTrack();
    });
    register('seekto', (details) => {
        if (!audio || isNowPlayingTakeover()) return;
        if (!details || !Number.isFinite(details.seekTime)) return;
        const dur = (Number.isFinite(audio.duration) && audio.duration > 0)
            ? audio.duration
            : (getDuration() / 1000);
        if (!Number.isFinite(dur) || dur <= 0) return;
        audio.currentTime = Math.max(0, Math.min(dur, details.seekTime));
        state.currentTime = audio.currentTime * 1000;
        updatePlaybackPosition();
        syncPlaybackAndPosition(true);
    });
    register('seekbackward', (details) => {
        const offset = (details && Number.isFinite(details.seekOffset) && details.seekOffset > 0)
            ? details.seekOffset
            : stepDefault();
        seekByOffset(-offset);
    });
    register('seekforward', (details) => {
        const offset = (details && Number.isFinite(details.seekOffset) && details.seekOffset > 0)
            ? details.seekOffset
            : stepDefault();
        seekByOffset(offset);
    });
}

if (typeof document !== 'undefined') {
    initMediaSessionHandlers();
    registerAudioListener('play', () => syncAll(true));
    registerAudioListener('pause', () => syncAll(true));
    registerAudioListener('loadedmetadata', () => syncAll(true));
    registerAudioListener('durationchange', () => syncAll(true));
    registerAudioListener('ratechange', () => syncAll(true));
    registerAudioListener('seeked', () => syncAll(true));
    registerAudioListener('ended', () => syncAll(true));
    registerAudioListener('timeupdate', () => syncPlaybackAndPosition(false));
    onRoleSwap(() => syncAll(true));

    /* 歌名/歌手/封面通常先于音频就绪写入 DOM，用轻观察器及时刷新系统媒体卡与标签标题 */
    const onDomMetaChange = () => syncAll(false);
    if (typeof MutationObserver !== 'undefined') {
        const metaObs = new MutationObserver(onDomMetaChange);
        if (songTitleEl) metaObs.observe(songTitleEl, { childList: true, characterData: true, subtree: true });
        if (songArtistEl) metaObs.observe(songArtistEl, { childList: true, characterData: true, subtree: true });
        for (const img of getCoverLayers()) {
            if (img) metaObs.observe(img, { attributes: true, attributeFilter: ['src', 'style'] });
        }
    }
    syncAll(true);
}

export { syncAll, syncDocumentTitle, syncMediaMetadata, syncPlaybackAndPosition };
