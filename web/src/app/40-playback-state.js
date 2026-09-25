/* ============================================================
 * 40-playback-state.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 619-753 行 | 单元数: 14
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { formatTime } from '../utils/formatters.js';
import { logCatch } from '../services/log.js';

const playerContainer = typeof document !== 'undefined' ? document.querySelector('.player-container') : null;

/* ========== AI 智能情绪分析模块（全局变量） ========== */
/* AI 分析结果缓存：以 "songTitle - artist" 为键 */
const aiThemeCache = {};

globalThis.isPlaying = false;

globalThis.scrollTimeout = null;

/* 当前歌曲的歌词偏移（ms） */
const LYRIC_OFFSET_STORAGE_KEY = 'lyrics_player_offsets';

/* 获取某首歌的歌词偏移 */
function getLyricOffset(songKey) {
            if (!songKey) return 0;
            try {
                const data = JSON.parse(localStorage.getItem(LYRIC_OFFSET_STORAGE_KEY) || '{}');
                return data[songKey] || 0;
            } catch { return 0; }
        }

/* 保存某首歌的歌词偏移 */
function saveLyricOffset(songKey, offsetMs) {
            if (!songKey) return;
            try {
                const data = JSON.parse(localStorage.getItem(LYRIC_OFFSET_STORAGE_KEY) || '{}');
                if (offsetMs === 0) {
                    delete data[songKey];
                } else {
                    data[songKey] = offsetMs;
                }
                localStorage.setItem(LYRIC_OFFSET_STORAGE_KEY, JSON.stringify(data));
            } catch (e) { logCatch('playbackState', e); }
        }

/* 更新偏移 UI 显示 */
function updateLyricOffsetUI() {
            const input = typeof document !== 'undefined' ? document.getElementById('lyricOffsetInput') : null;
            if (input) input.value = (lyricOffset / 1000).toFixed(1);
        }

/* 设置歌词偏移（秒） */
function setLyricOffset(seconds) {
            const clamped = Math.max(-10, Math.min(10, seconds));
            lyricOffset = Math.round(clamped * 1000);  /* 转为毫秒 */
            saveLyricOffset(currentSongKey, lyricOffset);
            updateLyricOffsetUI();
            updateLineTimes();  /* ★ 更新所有行时间标签 */
        }

/* ★ 更新所有歌词行的时间标签，应用 lyricOffset 偏移，时间不低于 00:00 */
function updateLineTimes() {
            const mainScroll = typeof document !== 'undefined' ? document.getElementById('lyricsScroll') : null;
            const timeEls = mainScroll ? mainScroll.querySelectorAll('.line-time') : [];
            timeEls.forEach((el, i) => {
                if (lyrics[i]) {
                    const adjusted = Math.max(0, lyrics[i].start - lyricOffset);
                    el.textContent = formatTime(adjusted);
                }
            });
        }

/* 初始化歌词偏移控件 */
function initLyricOffsetControl() {
            const upBtn = typeof document !== 'undefined' ? document.getElementById('lyricOffsetUp') : null;
            const downBtn = typeof document !== 'undefined' ? document.getElementById('lyricOffsetDown') : null;
            const input = typeof document !== 'undefined' ? document.getElementById('lyricOffsetInput') : null;
            if (!upBtn || !downBtn || !input) return;

            /* 上箭头 = 提前（减少延迟/增加提前量） */
            upBtn?.addEventListener('click', () => {
                setLyricOffset((lyricOffset / 1000) - 0.1);
            });
            /* 下箭头 = 延迟（增加延迟量） */
            downBtn?.addEventListener('click', () => {
                setLyricOffset((lyricOffset / 1000) + 0.1);
            });
            /* 直接输入 */
            input?.addEventListener('change', () => {
                const val = parseFloat(input.value);
                if (!isNaN(val)) {
                    setLyricOffset(val);
                } else {
                    updateLyricOffsetUI();
                }
            });
            input?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    input.blur();
                }
            });
            /* 滚轮调节 */
            input?.addEventListener('wheel', (e) => {
                e.preventDefault();
                const delta = e.deltaY < 0 ? -0.1 : 0.1;
                setLyricOffset((lyricOffset / 1000) + delta);
            }, { passive: false });
        }

/* 画布当前平移 Y（Lerp 插值中） */
globalThis.wordcloudCanvasW = 0;

/* 虚拟画布宽度 */
globalThis.wordcloudCanvasH = 0;

/* 画布当前缩放（Lerp 插值中） */
/* 变焦目标字号：根据窗口宽度动态计算（窄屏小，宽屏大） */
function getWordcloudTargetFontRem() {
            const w = window.innerWidth;
            if (w < 500) return 3.0;
            if (w < 800) return 3.5;
            if (w < 1200) return 4.0;
            if (w < 1600) return 5.0;
            return 6.0;
        }

export { LYRIC_OFFSET_STORAGE_KEY, aiThemeCache, getLyricOffset, getWordcloudTargetFontRem, initLyricOffsetControl, playerContainer, saveLyricOffset, setLyricOffset, updateLineTimes, updateLyricOffsetUI };
