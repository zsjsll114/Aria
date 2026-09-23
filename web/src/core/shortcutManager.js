/**
 * core/shortcutManager.js — 键盘快捷键管理
 * 统一处理播放/暂停、上一曲/下一曲、音量、收藏等快捷键
 */
import { state } from '../infrastructure/state.js';
import { dom } from '../infrastructure/dom.js';

/**
 * 初始化键盘快捷键
 * @param {Object} handlers - 快捷键处理函数集合
 * @param {Function} handlers.togglePlay - 播放/暂停
 * @param {Function} handlers.prevTrack - 上一曲
 * @param {Function} handlers.nextTrack - 下一曲
 * @param {Function} handlers.seek - 跳转（参数：毫秒，正数前进，负数后退）
 * @param {Function} handlers.changeVolume - 调整音量（参数：增量，-0.05~0.05）
 * @param {Function} handlers.toggleFavorite - 收藏/取消收藏
 * @param {Function} handlers.toggleLyrics - 切换歌词视图
 * @param {Function} handlers.openMore - 打开更多菜单
 */
export function initShortcutManager(handlers) {
    document.addEventListener('keydown', (e) => {
        /* 接管只读显示模式：本地快捷键全部让位 */
        if (typeof window !== 'undefined' && window.Aria && window.Aria.__npActive && window.Aria.__npActive()) return;
        /* 输入框聚焦时不拦截快捷键 */
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;

        const sc = state.appSettings?.shortcuts || {};
        const key = e.key;

        if (key === sc.playPause) {
            e.preventDefault();
            handlers.togglePlay?.();
        } else if (key === sc.prev) {
            e.preventDefault();
            handlers.prevTrack?.();
        } else if (key === sc.next) {
            e.preventDefault();
            handlers.nextTrack?.();
        } else if (key === sc.volumeUp) {
            e.preventDefault();
            handlers.changeVolume?.(0.05);
        } else if (key === sc.volumeDown) {
            e.preventDefault();
            handlers.changeVolume?.(-0.05);
        } else if (key === sc.favorite) {
            e.preventDefault();
            handlers.toggleFavorite?.();
        } else if (key === sc.toggleLyrics) {
            e.preventDefault();
            handlers.toggleLyrics?.();
        } else if (key === sc.more) {
            e.preventDefault();
            handlers.openMore?.();
        }
    });

    /* 底部控制栏的备用快捷键（不依赖设置，始终生效） */
    function seekRelative(ms) {
        const audio = dom.audio;
        if (audio.duration) {
            audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + ms / 1000));
        }
    }

    function changeVolume(delta) {
        const audio = dom.audio;
        audio.volume = Math.max(0, Math.min(1, audio.volume + delta));
    }

    document.addEventListener('keydown', (e) => {
        /* 接管只读显示模式：快捷键全部让位（空格/方向键） */
        if (typeof window !== 'undefined' && window.Aria && window.Aria.__npActive && window.Aria.__npActive()) return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        switch (e.key.toLowerCase()) {
            case ' ':
                e.preventDefault();
                handlers.togglePlay?.();
                break;
            case 'arrowleft':
                seekRelative(-5000);
                break;
            case 'arrowright':
                seekRelative(5000);
                break;
            case 'arrowup':
                e.preventDefault();
                changeVolume(0.05);
                break;
            case 'arrowdown':
                e.preventDefault();
                changeVolume(-0.05);
                break;
        }
    });
}
