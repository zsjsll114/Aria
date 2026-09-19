/* ============================================================
 * 65-playback-position.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 1442-1517 行 | 单元数: 6
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { formatTime } from '../utils/formatters.js';
import { volumePercentToGain } from '../utils/volumeCurve.js';
import { audio } from './20-lyrics-render.js';
import { currentTimeEl, playBtn, progressEl } from './30-dom-refs.js';
import { getDuration } from './56-playback-misc.js';
import { handleAudioPlayError } from './70-audio-engine.js';
import { setHint } from './120-search-results.js';
import { logInfo, logWarn, logError } from '../services/log.js';

function updatePlaybackPosition() {
            /* ★ 接管只读显示模式：进度/时长来自 NPS 虚拟时钟（audio 未加载歌曲） */
            const np = (typeof window !== 'undefined' && window.Aria && window.Aria.__npActive && window.Aria.__npActive()) ? window.Aria.get('__npDisplay') : null;
            const t = np ? Math.max(0, window.Aria.__npClock()) * 1000 : (typeof currentTime === 'number' ? currentTime : 0);
            const duration = np && np.duration > 0 ? np.duration * 1000 : getDuration();
            const percent = duration > 0 ? (t / duration) * 100 : 0;
            const formattedTime = formatTime(t);
            if (Math.abs(percent - lastPercent) > 0.1) {
                progressEl.style.width = `${percent}%`;
                lastPercent = percent;
            }
            if (formattedTime !== lastFormattedTime) {
                currentTimeEl.textContent = formattedTime;
                lastFormattedTime = formattedTime;
            }
        }

/* 等待音频就绪后再播放（避免 AbortError / NotAllowedError） */
async function waitForAudioReady(timeoutMs = 8000) {
            return new Promise((resolve, reject) => {
                let settled = false;
                let timer = null;
                const cleanup = () => {
                    audio.removeEventListener('canplay', onReady);
                    audio.removeEventListener('loadeddata', onReady);
                    audio.removeEventListener('error', onErr);
                    if (timer) { clearTimeout(timer); timer = null; }
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
                timer = setTimeout(() => {
                    if (!settled) {
                        settled = true;
                        cleanup();
                        if (audio.readyState >= 2 && !audio.error) {
                            resolve();
                        } else {
                            reject(new Error('audio_load_timeout'));
                        }
                    }
                }, timeoutMs);
            });
        }

/* ========== 音频播放控制 ========== */
function togglePlayPause() {
            /* ★ 接管只读显示模式：本地播放/暂停无反应（Aria 只显示外部播放器状态） */
            if (typeof window !== 'undefined' && window.Aria && window.Aria.__npActive && window.Aria.__npActive()) return;
            if (!audio.src) {
                setHint('请先搜索或加载音乐');
                return;
            }
            if (audio.paused) {
                /* 音量保护：如果音量被淡出到0但未恢复，手动播放时恢复 */
                if (audio.volume === 0 && volume > 0) {
                    audio.volume = volumePercentToGain(volume);
                }
                audio.play().catch(e => { logError('playbackPosition', '播放失败:', e); handleAudioPlayError(); });
                /* ★ 续播即时对齐进度条：不等首个 timeupdate（暂停越久越明显），
                   避免续播瞬间进度条仍停在暂停前位置的"卡一下"观感；
                   注意 updatePlaybackPosition 读的是全局 currentTime（仅被 timeupdate/rAF
                   每 ~250ms 刷新），若不同步就直接用暂停时的旧值 → 进度条/时间文本
                   会冻结到首个 timeupdate 才动，仍会"卡"。因此先对齐 audio.currentTime。
                   歌词由 play 事件启动的 rAF 循环首帧即读 audio.currentTime，无需此处同步 */
                currentTime = audio.currentTime * 1000;
                updatePlaybackPosition();
            } else {
                audio.pause();
            }
        }

playBtn?.addEventListener('click', togglePlayPause);

/* 播放/暂停图标路径 */
const PLAY_ICON_PATH = '<path d="M10.345 23.287c.415 0 .763-.15 1.22-.407l12.742-7.404c.838-.481 1.178-.855 1.178-1.46 0-.599-.34-.972-1.178-1.462L11.565 5.158c-.457-.265-.805-.407-1.22-.407-.789 0-1.345.606-1.345 1.57V21.71c0 .971.556 1.577 1.345 1.577z" fill-rule="nonzero"></path>';

const PAUSE_ICON_PATH = '<path d="M13.293 22.772c.955 0 1.436-.481 1.436-1.436V6.677c0-.98-.481-1.427-1.436-1.427h-2.457c-.954 0-1.436.473-1.436 1.427v14.66c-.008.954.473 1.435 1.436 1.435h2.457zm7.87 0c.954 0 1.427-.481 1.427-1.436V6.677c0-.98-.473-1.427-1.428-1.427h-2.465c-.955 0-1.428.473-1.428 1.427v14.66c0 .954.473 1.435 1.428 1.435h2.465z" fill-rule="nonzero"></path>';

export { PAUSE_ICON_PATH, PLAY_ICON_PATH, togglePlayPause, updatePlaybackPosition, waitForAudioReady };
