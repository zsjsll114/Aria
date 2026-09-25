/* ============================================================
 * 70-audio-engine.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 1519-1770 行 | 单元数: 29
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { getBlurBgLayers } from '../infrastructure/dom.js';
import { formatTime } from '../utils/formatters.js';
import { volumePercentToDb, volumePercentToGain } from '../utils/volumeCurve.js';
import { audio } from './20-lyrics-render.js';
import { saveSettings } from './180-boot-config.js';
import { playIcon, progressTrack, totalTimeEl, volumeBar, volumeIcon, volumeTrack } from './30-dom-refs.js';
import { getDuration } from './56-playback-misc.js';
import { updateLyricsHighlight } from './57-wordcloud-camera.js';
import { PAUSE_ICON_PATH, PLAY_ICON_PATH, updatePlaybackPosition } from './65-playback-position.js';
import { nextTrack } from './95-track-loading.js';
import { fadeInVolume } from '../core/fadeController.js';
import { logError } from '../services/log.js';
import { initStallDetector, startStallCheck, stopStallCheck, setBuffering } from '../core/stallDetector.js';

audio?.addEventListener('play', () => {
            isPlaying = true;
            playIcon.innerHTML = PAUSE_ICON_PATH;
            getBlurBgLayers().forEach(l => l.classList.remove('paused'));
            /* 音量保护：如果音量被淡出到0但未恢复，播放时立即恢复 */
            if (audio.volume === 0 && volume > 0) {
                if (appSettings.playback.fadeInOut) {
                    fadeInVolume(volumePercentToGain(volume), appSettings.playback.fadeDuration);
                } else {
                    audio.volume = volumePercentToGain(volume);
                }
            }
            /* 启动卡死检测 */
            startStallCheck();
        });

audio?.addEventListener('pause', () => {
            isPlaying = false;
            playIcon.innerHTML = PLAY_ICON_PATH;
            getBlurBgLayers().forEach(l => l.classList.add('paused'));
            stopStallCheck();
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
audio?.addEventListener('error', () => {
            if (audio.src && audio.error) {
                logError('audioEngine', '音频错误:', audio.error.code, audio.error.message);
                /* 即使 isPlaying 为 false 也处理，因为浏览器可能在后台暂停了音频 */
                handleAudioPlayError();
            }
        });

/* 网络停滞 / 缓冲 / 恢复播放三个监听：见 core/stallDetector.js 的 initStallDetector */

/* ★ 页面后台/前台切换自适应：防止后台音频卡顿，切回前台即刻同步画面 */
if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    /* 后台节流保护：保持音频平稳运行 */
                } else {
                    /* 切回前台：立即对齐歌词与进度条 */
                    if (audio && !audio.paused && isPlaying) {
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
                        if (!isLyricsLoopRunning) {
                            startLyricsLoop(); /* ★ lint 修复：方法名笔误 startLyricsAnimation → startLyricsLoop（从未定义会 ReferenceError） */
                        }
                    }
                }
            });
        }

audio?.addEventListener('timeupdate', () => {
            currentTime = audio.currentTime * 1000;
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

function lyricsAnimationLoop() {
            if (!isLyricsLoopRunning) return;

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
        }

/* 音频播放时启动歌词循环 */
audio?.addEventListener('play', startLyricsLoop);

/* 音频暂停时停止歌词循环（但保留当前高亮） */
audio?.addEventListener('pause', stopLyricsLoop);

audio?.addEventListener('loadedmetadata', () => {
            totalTimeEl.textContent = formatTime(getDuration());
            /* duration 就绪后渲染高潮标记 */
            if (typeof renderChorusMarkers === 'function') renderChorusMarkers();
        });

audio?.addEventListener('ended', () => {
            if (playMode === 'loop' && playlist.length > 0) {
                /* 单曲循环：直接重播，无需重新加载 */
                audio.currentTime = 0;
                audio.play().catch(() => handleAudioPlayError());
            } else if (appSettings.playback.autoPlayNext) {
                nextTrack();
            }
        });

/* ★ 修复：统一的 seeked 事件处理，确保所有跳转方式（键盘、进度条拖拽、程序跳转）
           都能正确重置滚动状态、更新虚拟渲染、滚动到正确位置 */
audio?.addEventListener('seeked', () => {
            currentTime = audio.currentTime * 1000;
            isUserScrolling = false;
            if (scrollTimeout) { clearTimeout(scrollTimeout); }
            updateLyricsHighlight();
            updatePlaybackPosition();
            if (mainVisManager && mainVisManager.has(currentViewMode)) {
                mainVisManager.update((currentTime + lyricOffset) / 1000);
            }
        });

/* 进度条点击跳转 */
progressTrack?.addEventListener('click', (e) => {
            if ((typeof window !== 'undefined' && window.Aria && window.Aria.__npActive && window.Aria.__npActive())) return; /* 接管只读：不可拖 */
            const duration = getDuration();
            if (duration <= 0) return;
            const rect = progressTrack.getBoundingClientRect();
            const percent = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
            audio.currentTime = percent * (duration / 1000);
            currentTime = audio.currentTime * 1000;
            isUserScrolling = false;
            if (scrollTimeout) { clearTimeout(scrollTimeout); }
            updateLyricsHighlight();
            updatePlaybackPosition();
        });

/* 音量控制（对数曲线：手柄位置 → dB 均匀步进 → 声压，见 utils/volumeCurve.js） */
/* ★ 音量持久化：播放中调音量（键盘/滑杆/接管）防抖写回
   appSettings.playback.initialVolume——否则重启回到旧初始音量（用户反馈） */
let _volSaveTimer = null;
function persistVolume(v) {
            try {
                if (typeof appSettings !== 'undefined' && appSettings.playback) {
                    appSettings.playback.initialVolume = v;
                }
                if (_volSaveTimer) clearTimeout(_volSaveTimer);
                _volSaveTimer = setTimeout(() => { saveSettings(); }, 600);
            } catch (e) { /* 忽略：持久化失败不影响播放 */ }
        }

function updateVolume(newVolume) {
            if ((typeof window !== 'undefined' && window.Aria && window.Aria.__npActive && window.Aria.__npActive())) return; /* 接管只读：音量不可调 */
            volume = Math.max(0, Math.min(100, newVolume));
            audio.volume = volumePercentToGain(volume);
            volumeBar.style.width = `${volume}%`;
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

export { handleAudioPlayError, lyricsAnimationLoop, startLyricsLoop, startStallCheck, stopLyricsLoop, stopStallCheck, updateVolume };
