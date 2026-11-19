/* ============================================================
 * 70-audio-engine.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 1519-1770 行 | 单元数: 29
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { getBlurBgLayers } from '../infrastructure/dom.js';
import { formatTime } from '../utils/formatters.js';
import { volumePercentToDb, volumePercentToGain } from '../utils/volumeCurve.js';
import { writeSavedVolume } from './10-config-state.js';
import { audio } from './20-lyrics-render.js';
import { saveSettings } from './180-boot-config.js';
import { currentTimeEl, playIcon, progressEl, progressTrack, totalTimeEl, volumeBar, volumeIcon, volumeTrack } from './30-dom-refs.js';
import { flyinAutoScaleFont, getDuration } from './56-playback-misc.js';
import { clearStaleActiveLines, updateLyricsHighlight } from './57-wordcloud-camera.js';
import { PAUSE_ICON_PATH, PLAY_ICON_PATH, updatePlaybackPosition } from './65-playback-position.js';
import { nextTrack } from './95-track-loading.js';
import { computeNextQueueDecision } from '../core/playlistQueue.js';
import { fadeInVolume } from '../core/fadeController.js';
import { logCatch, logError } from '../services/log.js';
import { initStallDetector, startStallCheck, stopStallCheck, setBuffering } from '../core/stallDetector.js';
/* ★ 帧时埋点（todos #21）：逐字高亮 rAF 是播放期间每帧都要跑的循环，
   滚动卡顿时它与 57 的弹簧循环谁是瓶颈，只能靠设备自己回传帧时区分。 */
import { frame as probeFrame, registerLoop } from '../core/frameProbe.js';
import { registerAudioListener, onRoleSwap } from '../core/dualDeck.js';
import { crossfaderPhase, abortCrossfade, automixSwapJustCompleted } from '../core/automix/crossfader.js';
import { bindProgressHoverTip, calcProgressPercent, hideProgressTimeTip, showProgressTimeTip } from '../core/progressPreview.js';
import { isBackgroundThrottled } from '../core/backgroundThrottle.js';

/* ★ 播放态 UI 同步（Automix 角色顶替专用入口）。
   为什么需要它：Automix 交接时 dualDeck.swapRoles() 会把常驻监听搬到新活跃
   元素，但新元素的 play 事件早在交叉开始时（它还是影子 deck、身上没有任何
   监听）就派发过了——不会再触发。若不主动同步一次，图标会永久停在旧状态：
   用户看到「明明在播却显示暂停图标，点一下方向反、点两下才对」。 */
function applyPlayingState() {
            if (!audio) return;
            if (audio.paused) {
                isPlaying = false;
                if (playIcon) playIcon.innerHTML = PLAY_ICON_PATH;
                getBlurBgLayers().forEach(l => l.classList.add('paused'));
                stopStallCheck();
            } else {
                isPlaying = true;
                if (playIcon) playIcon.innerHTML = PAUSE_ICON_PATH;
                getBlurBgLayers().forEach(l => l.classList.remove('paused'));
                /* 启动卡死检测 */
                startStallCheck();
            }
        }

/* 角色顶替后立刻对齐一次（新 A 已在播放，见上方注释） */
onRoleSwap(() => applyPlayingState());

registerAudioListener('play', () => {
            applyPlayingState();
            /* 音量保护：如果音量被淡出到0但未恢复，播放时立即恢复 */
            if (audio.volume === 0 && volume > 0) {
                if (appSettings.playback.fadeInOut) {
                    fadeInVolume(volumePercentToGain(volume), appSettings.playback.fadeDuration);
                } else {
                    audio.volume = volumePercentToGain(volume);
                }
            }
        });

registerAudioListener('pause', () => {
            applyPlayingState();
        });

/* 卡死检测本体已迁入 core/stallDetector.js（core 层接管第 1 个模块，2026-09-25）。
   检测循环与 stalled / waiting / playing 三个监听由该模块装配；本分片只在 play / pause
   上启停，并把「判定失败后怎么办」的策略留在下面的 handleAudioPlayError 里。
   四个状态键（stallTimer / isBuffering / stallLastTime / stallCheckGeneration）改由
   infrastructure/state.js 持有，经 globalBridge 与 globalThis 同名键双向打通，
   所以 app/250-desktop-lyrics.js 等按裸标识符读 isBuffering 的地方无需改动。 */
initStallDetector(audio, handleAudioPlayError);

/* 播放失败时暂停 audio 元素本身，确保 rAF 循环停止推进歌词/进度 */
function handleAudioPlayError() {
            /* 关键：必须真正暂停 audio，否则 rAF 循环的 !audio.paused 判断仍为 true */
            audio.pause();
            isPlaying = false;
            setBuffering(false);
            playIcon.innerHTML = PLAY_ICON_PATH;
            getBlurBgLayers().forEach(l => l.classList.add('paused'));
            stopStallCheck();
            /* 恢复音量：淡出可能导致 volume=0 */
            if (audio.volume === 0 && volume > 0) {
                audio.volume = volumePercentToGain(volume);
            }
        }

/* 音频加载/播放错误（403/404/网络错误/CORS/解码错误） */
registerAudioListener('error', () => {
            if (audio.src && audio.error) {
                logError('audioEngine', '音频错误:', audio.error.code, audio.error.message);
                /* 即使 isPlaying 为 false 也处理，因为浏览器可能在后台暂停了音频 */
                handleAudioPlayError();
            }
        });

/* 网络停滞 / 缓冲 / 恢复播放三个监听：见 core/stallDetector.js 的 initStallDetector */

/* ★ 页面后台/前台切换自适应：统一经由 syncForegroundLyricsNow() 对齐（与 287 协同去重），
   避免两条 visibilitychange 链路竞态导致旧 .line.active 残留、飞入模式字号异常缩小。 */
let _lastFgSyncAt = 0;
if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden && !isBackgroundThrottled()) {
                    syncForegroundLyricsNow();
                }
            });
        }

registerAudioListener('timeupdate', () => {
            currentTime = audio.currentTime * 1000;
            if (isBackgroundThrottled()) {
                syncBgActiveLineIndex(currentTime);
                return;
            }
            /* ★ 性能（2026-11-19）：60fps 主 rAF 循环正在驱动时，禁止 timeupdate（~4Hz 异相回调）
               重复调用视觉引擎 update()，消除周期性双更新与帧间隔抖动。 */
            if (isLyricsLoopRunning) return;
            if (pvEngineInstance && currentViewMode === 'pv') {
                pvEngineInstance.update((currentTime + lyricOffset) / 1000);
            }
            if (tunnelEngineInstance && currentViewMode === 'tunnel') {
                tunnelEngineInstance.update((currentTime + lyricOffset) / 1000);
            }
            if (mainVisManager && mainVisManager.has(currentViewMode)) {
                mainVisManager.update((currentTime + lyricOffset) / 1000);
            }
        });

/* 用 requestAnimationFrame 独立驱动逐字高亮与进度，避免 timeupdate 低频率/抖动导致的卡顿 */
/* 歌词动画循环控制 */
globalThis.lyricsRafId = null;

globalThis.isLyricsLoopRunning = false;

/* ★ 帧时埋点源名：诊断页「帧时（实时采样）」段。源名 'lyricsLoop' 取自
   core/frameProbe 文档示例；标签用 core/i18n 词表已登记的原文。 */
const HL_PROBE_SOURCE = 'lyricsLoop';
registerLoop(HL_PROBE_SOURCE, '歌词逐字高亮循环');

let _lyricsBgTimer = 0;

function syncBgActiveLineIndex(tMs) {
    const lyr = globalThis.lyrics;
    if (!Array.isArray(lyr) || !lyr.length) return;
    const t = tMs + (globalThis.lyricOffset || 0);
    let idx = -1;
    for (let i = 0; i < lyr.length; i++) {
        const st = lyr[i] && (lyr[i].start !== undefined ? lyr[i].start : lyr[i].time);
        if (typeof st === 'number' && st <= t) idx = i;
        else if (typeof st === 'number' && st > t) break;
    }
    if (idx >= 0 && idx !== globalThis.activeLineIndex) {
        globalThis.activeLineIndex = idx;
    }
}

function lyricsAnimationLoop(ts) {
            if (!isLyricsLoopRunning) return;
            /* 后台节流且桌面歌词开着时降频到 ~10Hz 轻量时间同步：
               只推进 currentTime 与 activeLineIndex 供桌面歌词窗口，跳过主窗 DOM 与全部视觉引擎 */
            if (isBackgroundThrottled()) {
                let dtkOn = false;
                try { dtkOn = typeof localStorage !== 'undefined' && localStorage.getItem('aria_dtk_enabled') === '1'; } catch { /* ignore */ }
                if (dtkOn && audio.src && !audio.paused && isPlaying) {
                    currentTime = audio.currentTime * 1000;
                    syncBgActiveLineIndex(currentTime);
                    _lyricsBgTimer = setTimeout(() => {
                        _lyricsBgTimer = 0;
                        lyricsAnimationLoop(performance.now());
                    }, 100);
                } else {
                    isLyricsLoopRunning = false;
                    lyricsRafId = null;
                }
                return;
            }
            probeFrame(HL_PROBE_SOURCE, ts);

            /* ★ 接管只读显示模式：NPS 虚拟时钟驱动歌词高亮/进度（audio 未加载歌曲） */
            const np = (typeof window !== 'undefined' && window.Aria) ? window.Aria.get('__npDisplay') : null;
            if (np && np.active && typeof window.Aria.__npClock === 'function') {
                currentTime = Math.max(0, window.Aria.__npClock()) * 1000;
                updateLyricsHighlight();
                updatePlaybackPosition();
                if (pvEngineInstance && currentViewMode === 'pv') {
                    pvEngineInstance.update((currentTime + lyricOffset) / 1000);
                }
                if (tunnelEngineInstance && currentViewMode === 'tunnel') {
                    tunnelEngineInstance.update((currentTime + lyricOffset) / 1000);
                }
                if (mainVisManager && mainVisManager.has(currentViewMode)) {
                    mainVisManager.update((currentTime + lyricOffset) / 1000);
                }
                lyricsRafId = requestAnimationFrame(lyricsAnimationLoop);
                return;
            }

            if (audio.src && !audio.paused && isPlaying) {
                currentTime = audio.currentTime * 1000;
                updateLyricsHighlight();
                updatePlaybackPosition();
                if (pvEngineInstance && currentViewMode === 'pv') {
                    pvEngineInstance.update((currentTime + lyricOffset) / 1000);
                }
                if (tunnelEngineInstance && currentViewMode === 'tunnel') {
                    tunnelEngineInstance.update((currentTime + lyricOffset) / 1000);
                }
                if (mainVisManager && mainVisManager.has(currentViewMode)) {
                    mainVisManager.update((currentTime + lyricOffset) / 1000);
                }
                lyricsRafId = requestAnimationFrame(lyricsAnimationLoop);
            } else {
                /* 音频暂停或停止时，停止循环以节省 CPU（接管态由 232 持续 startLyricsLoop） */
                isLyricsLoopRunning = false;
                lyricsRafId = null;
            }
        }

function startLyricsLoop() {
            if (!isLyricsLoopRunning) {
                isLyricsLoopRunning = true;
                lyricsAnimationLoop();
            }
        }

function stopLyricsLoop() {
            isLyricsLoopRunning = false;
            if (lyricsRafId) {
                cancelAnimationFrame(lyricsRafId);
                lyricsRafId = null;
            }
            if (_lyricsBgTimer) {
                clearTimeout(_lyricsBgTimer);
                _lyricsBgTimer = 0;
            }
        }

/* 音频播放时启动歌词循环 */
registerAudioListener('play', startLyricsLoop);

/* 音频暂停时停止歌词循环（但保留当前高亮） */
registerAudioListener('pause', stopLyricsLoop);

registerAudioListener('loadedmetadata', () => {
            totalTimeEl.textContent = formatTime(getDuration());
            /* duration 就绪后渲染高潮标记 */
            if (typeof renderChorusMarkers === 'function') renderChorusMarkers();
        });

registerAudioListener('ended', () => {
            /* ★ Automix：CROSSING 期 A 的自然 ended 由 crossfader 接管——
               此刻 B 正在淡入，原生 nextTrack 会把 B 的起播逻辑再跑一遍，直接打架。
               交叉完成后 swapRoles 才是正统切歌路径。
               ARMED 期 A 就到头了 = B 没赶上就绪，放弃本轮 automix 归位 IDLE，
               **继续走下面的原生切歌**（否则既不交叉也不切歌，播放直接卡死）。 */
            if (crossfaderPhase() === 'CROSSING') return;
            if (crossfaderPhase() === 'ARMED') abortCrossfade('a-ended-before-crossing');
            /* swap 刚完成时 A 的 ended 事件晚到（与曲线完成毫秒级竞态）：
               此刻 automix 已交接下一首，再走 autoPlayNext 会把它整个重载 */
            if (automixSwapJustCompleted()) return;
            if (playMode === 'loop' && playlist.length > 0) {
                /* 单曲循环：直接重播，无需重新加载 */
                audio.currentTime = 0;
                audio.play().catch(() => handleAudioPlayError());
            } else if (appSettings.playback.autoPlayNext) {
                const decision = computeNextQueueDecision({
                    playlist,
                    currentIndex: currentTrackIndex,
                    playMode,
                    delta: 1,
                    reason: 'auto',
                    autoPlayNext: true,
                });
                if (decision.kind === 'stop') {
                    applyPlayingState();
                } else {
                    nextTrack();
                }
            } else {
                applyPlayingState();
            }
        });

/* ★ 修复：统一的 seeked 事件处理，确保所有跳转方式（键盘、进度条拖拽、程序跳转）
           都能正确重置滚动状态、更新虚拟渲染、滚动到正确位置 */
registerAudioListener('seeked', () => {
            currentTime = audio.currentTime * 1000;
            isUserScrolling = false;
            if (scrollTimeout) { clearTimeout(scrollTimeout); }
            updateLyricsHighlight();
            updatePlaybackPosition();
            if (mainVisManager && mainVisManager.has(currentViewMode)) {
                mainVisManager.update((currentTime + lyricOffset) / 1000);
            }
        });

/* 进度条点击与拖拽定位 + 悬停时间预览 */
let _isDraggingMainProgress = false;
let _suppressMainProgressClick = false;
function _seekMainProgressFromPointer(e) {
            if ((typeof window !== 'undefined' && window.Aria && window.Aria.__npActive && window.Aria.__npActive())) return; /* 接管只读：不可拖 */
            const duration = getDuration();
            if (!progressTrack || duration <= 0) return;
            const rect = progressTrack.getBoundingClientRect();
            const percent = calcProgressPercent(e.clientX, rect);
            const targetSec = percent * (duration / 1000);
            audio.currentTime = targetSec;
            currentTime = targetSec * 1000;
            if (progressEl) progressEl.style.width = `${percent * 100}%`;
            if (currentTimeEl) currentTimeEl.textContent = formatTime(currentTime);
            showProgressTimeTip(progressTrack, e.clientX, duration);
            isUserScrolling = false;
            if (scrollTimeout) { clearTimeout(scrollTimeout); }
            updateLyricsHighlight();
            updatePlaybackPosition();
        }
bindProgressHoverTip(progressTrack, getDuration, () => (
            _isDraggingVolume
            || (typeof window !== 'undefined' && window.Aria && window.Aria.__npActive && window.Aria.__npActive())
        ));
progressTrack?.addEventListener('mousedown', (e) => {
            if (e.button !== 0 && e.button !== undefined) return;
            if ((typeof window !== 'undefined' && window.Aria && window.Aria.__npActive && window.Aria.__npActive())) return;
            if (getDuration() <= 0) return;
            _isDraggingMainProgress = true;
            _seekMainProgressFromPointer(e);
            e.preventDefault();
        });
if (typeof document !== 'undefined') {
            document.addEventListener('mousemove', (e) => {
                if (_isDraggingMainProgress) _seekMainProgressFromPointer(e);
            });
            document.addEventListener('mouseup', () => {
                if (!_isDraggingMainProgress) return;
                _isDraggingMainProgress = false;
                _suppressMainProgressClick = true;
                hideProgressTimeTip();
                requestAnimationFrame(() => { _suppressMainProgressClick = false; });
            });
        }
progressTrack?.addEventListener('click', (e) => {
            if (_suppressMainProgressClick) {
                _suppressMainProgressClick = false;
                return;
            }
            _seekMainProgressFromPointer(e);
        });

/* 音量控制（对数曲线：手柄位置 → dB 均匀步进 → 声压，见 utils/volumeCurve.js） */
/* ★ 音量持久化：播放中调音量（键盘/滑杆/接管）立即写入 localStorage，并防抖同步后端配置 */
let _volSaveTimer = null;
function persistVolume(v) {
            try {
                globalThis.__ariaVolumeTouched = true;
                const rounded = Math.max(0, Math.min(100, Math.round(v)));
                if (typeof writeSavedVolume === 'function') {
                    writeSavedVolume(rounded);
                }
                if (typeof appSettings !== 'undefined' && appSettings.playback) {
                    appSettings.playback.lastVolume = rounded;
                    delete appSettings.playback.initialVolume;
                }
                if (_volSaveTimer) clearTimeout(_volSaveTimer);
                _volSaveTimer = setTimeout(() => { saveSettings(); }, 400);
            } catch (e) { logCatch('audioEngine', e); }
        }

function updateVolume(newVolume) {
            if ((typeof window !== 'undefined' && window.Aria && window.Aria.__npActive && window.Aria.__npActive())) return; /* 接管只读：音量不可调 */
            volume = Math.max(0, Math.min(100, newVolume));
            audio.volume = volumePercentToGain(volume);
            if (volumeBar) volumeBar.style.width = `${volume}%`;
            persistVolume(volume);
        }
globalThis.updateVolume = updateVolume;

/* ---- 音量条 tooltip（跟随鼠标 X 坐标显示当前音量） ---- */
let _volumeTip = null;
function _ensureVolumeTip() {
            if (_volumeTip) return _volumeTip;
            _volumeTip = document.createElement('div');
            _volumeTip.id = 'volumeTip';
            _volumeTip.setAttribute('role', 'status');
            _volumeTip.style.cssText = [
                'position:fixed;z-index:2147483646;pointer-events:none;white-space:nowrap;',
                'background:rgba(0,0,0,0.86);color:#fff;font-size:11px;font-weight:600;line-height:1;',
                'font-family:"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;',
                'padding:6px 10px;border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,0.35);',
                'border:1px solid rgba(255,255,255,0.10);opacity:0;visibility:hidden;',
                'transition:opacity 0.15s ease,visibility 0.15s ease;transform:translate(-50%,-100%);'
            ].join('');
            document.body.appendChild(_volumeTip);
            return _volumeTip;
        }
function _showVolumeTip(clientX, pct) {
            const tip = _ensureVolumeTip();
            const db = volumePercentToDb(pct);
            tip.textContent = pct <= 0 ? '静音' : `${Math.round(pct)}% · ${db.toFixed(1)}dB`;
            const r = volumeTrack ? volumeTrack.getBoundingClientRect() : { top: 0 };
            tip.style.left = `${clientX}px`;
            tip.style.top = `${r.top - 12}px`;
            tip.style.opacity = '1';
            tip.style.visibility = 'visible';
        }
function _hideVolumeTip() {
            if (_volumeTip) {
                _volumeTip.style.opacity = '0';
                _volumeTip.style.visibility = 'hidden';
            }
        }
function _setVolumeFromPointer(e) {
            const rect = volumeTrack.getBoundingClientRect();
            const percent = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
            updateVolume(percent);
            _showVolumeTip(e.clientX, percent);
        }

/* 按住拖动调音量（含点击），tooltip 跟随鼠标 X 显示当前音量与分贝 */
let _isDraggingVolume = false;
volumeTrack?.addEventListener('mousedown', (e) => {
            _isDraggingVolume = true;
            _setVolumeFromPointer(e);
            e.preventDefault();
        });
document.addEventListener('mousemove', (e) => {
            if (_isDraggingVolume) _setVolumeFromPointer(e);
        });
document.addEventListener('mouseup', () => {
            if (_isDraggingVolume) {
                _isDraggingVolume = false;
                _hideVolumeTip();
            }
        });
/* 触屏兼容：触摸拖动也走同一逻辑 */
volumeTrack?.addEventListener('touchstart', (e) => {
            _isDraggingVolume = true;
            _setVolumeFromPointer(e.touches[0]);
            e.preventDefault();
        }, { passive: false });
volumeTrack?.addEventListener('touchmove', (e) => {
            if (_isDraggingVolume) {
                _setVolumeFromPointer(e.touches[0]);
                e.preventDefault();
            }
        }, { passive: false });
document.addEventListener('touchend', () => {
            if (_isDraggingVolume) {
                _isDraggingVolume = false;
                _hideVolumeTip();
            }
        });

volumeIcon?.addEventListener('click', () => {
            if (volume > 0) {
                updateVolume(0);
            } else {
                updateVolume(80);
            }
        });

function syncForegroundLyricsNow() {
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (now - _lastFgSyncAt < 60) return;
    _lastFgSyncAt = now;
    stopLyricsLoop();
    const tSec = (audio && Number.isFinite(audio.currentTime)) ? audio.currentTime : (currentTime / 1000 || 0);
    currentTime = Math.max(0, tSec * 1000);
    /* ★ 切回前台时先清掉全部残留 .line.active，再重置 activeLineIndex 强制重刷，
       彻底防止后台同步改过索引后旧句残留叠加、飞入模式后续句变小。 */
    clearStaleActiveLines(-1);
    activeLineIndex = -1;
    updateLyricsHighlight();
    updatePlaybackPosition();
    if (typeof document !== 'undefined') {
        const pc = document.querySelector('.player-container');
        if (pc && pc.classList.contains('view-flyin')) {
            requestAnimationFrame(() => {
                flyinAutoScaleFont(Array.isArray(lineElements) && activeLineIndex >= 0 ? lineElements[activeLineIndex] : null);
            });
        }
    }
    const effSec = (currentTime + (lyricOffset || 0)) / 1000;
    if (mainVisManager && mainVisManager.has(currentViewMode)) {
        const inst = mainVisManager.activeInstance;
        if (inst && typeof inst.handleResize === 'function') {
            try { inst.handleResize(); } catch { /* 视口重建安全降级 */ }
        }
        mainVisManager.update(effSec);
    }
    if (pvEngineInstance && currentViewMode === 'pv') {
        pvEngineInstance.update(effSec);
    }
    if (tunnelEngineInstance && currentViewMode === 'tunnel') {
        tunnelEngineInstance.update(effSec);
    }
    if (audio && audio.src && !audio.paused && isPlaying) {
        startLyricsLoop();
    }
}

export { handleAudioPlayError, lyricsAnimationLoop, startLyricsLoop, startStallCheck, stopLyricsLoop, stopStallCheck, syncForegroundLyricsNow, updateVolume };
