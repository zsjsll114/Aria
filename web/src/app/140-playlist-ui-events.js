/* ============================================================
 * 140-playlist-ui-events.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 5022-5180 行 | 单元数: 21
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { openPlaylistsBtn } from './30-dom-refs.js';
import { addToPlaylistCloseBtn, addToPlaylistHintEl, addToPlaylistOverlay, createPlaylist, importConfirmBtn, importHintEl, importPlaylistCloseBtn, importPlaylistOverlay, importProgressWrap, importUrlInput, playlistBackBtn, playlistCreateToggleBtn, playlistImportToggleBtn, playlistSaveQueueBtn, playlistsCloseBtn, playlistsHintEl, playlistsOverlay, renderPlaylistsView, saveQueueAsPlaylist } from './130-playlists.js';
import { closePlaylists, openPlaylists } from './135-crossfade.js';
import { importPlaylistFromUrl } from './145-playlist-import.js';
import { logInfo, logWarn, logError } from '../services/log.js';

function closeAddToPlaylist() {
            addToPlaylistOverlay.classList.remove('visible');
            addToPlaylistHintEl.textContent = '';
        }

/* 事件绑定 */
openPlaylistsBtn?.addEventListener('click', openPlaylists);

playlistsCloseBtn?.addEventListener('click', closePlaylists);

addToPlaylistCloseBtn?.addEventListener('click', closeAddToPlaylist);

/* 点击遮罩关闭 */
playlistsOverlay?.addEventListener('click', (e) => { if (e.target === playlistsOverlay) closePlaylists(); });

addToPlaylistOverlay?.addEventListener('click', (e) => { if (e.target === addToPlaylistOverlay) closeAddToPlaylist(); });

/* 返回按钮（子视图优先走自定义返回钩子，如自建平台歌单） */
playlistBackBtn?.addEventListener('click', () => {
            if (typeof Aria.__playlistBackHook === 'function') { Aria.__playlistBackHook(); return; }
            renderPlaylistsView();
        });

/* 新建歌单 / 保存队列为新歌单弹窗（★ 对齐从链接导入歌单的模态 search-modal 样式） */
const createPlaylistModalOverlay = typeof document !== 'undefined' ? document.getElementById('createPlaylistModalOverlay') : null;
const createPlaylistModalTitle = typeof document !== 'undefined' ? document.getElementById('createPlaylistModalTitle') : null;
const createPlaylistModalCloseBtn = typeof document !== 'undefined' ? document.getElementById('createPlaylistModalCloseBtn') : null;
const createPlaylistModalInput = typeof document !== 'undefined' ? document.getElementById('createPlaylistModalInput') : null;
const createPlaylistModalConfirmBtn = typeof document !== 'undefined' ? document.getElementById('createPlaylistModalConfirmBtn') : null;
const createPlaylistModalHint = typeof document !== 'undefined' ? document.getElementById('createPlaylistModalHint') : null;

function openCreatePlaylistModal(isQueue = false) {
    saveQueueMode = isQueue;
    if (!createPlaylistModalOverlay) return;
    if (createPlaylistModalTitle) createPlaylistModalTitle.textContent = isQueue ? '保存当前队列为新歌单' : '新建歌单';
    if (createPlaylistModalInput) {
        createPlaylistModalInput.placeholder = isQueue ? '输入新歌单名称以保存当前队列...' : '输入歌单名称...';
        createPlaylistModalInput.value = '';
    }
    if (createPlaylistModalConfirmBtn) createPlaylistModalConfirmBtn.textContent = isQueue ? '保存' : '创建';
    if (createPlaylistModalHint) createPlaylistModalHint.textContent = '';
    createPlaylistModalOverlay.classList.add('visible');
    setTimeout(() => createPlaylistModalInput?.focus(), 60);
}

function closeCreatePlaylistModal() {
    if (createPlaylistModalOverlay) createPlaylistModalOverlay.classList.remove('visible');
}

createPlaylistModalCloseBtn?.addEventListener('click', closeCreatePlaylistModal);
createPlaylistModalOverlay?.addEventListener('click', (e) => {
    if (e.target === createPlaylistModalOverlay) closeCreatePlaylistModal();
});

function handleCreatePlaylistConfirm() {
    const val = (createPlaylistModalInput?.value || '').trim();
    if (!val) {
        if (createPlaylistModalHint) createPlaylistModalHint.textContent = '请输入歌单名称';
        return;
    }
    if (saveQueueMode) {
        if (saveQueueAsPlaylist(val)) closeCreatePlaylistModal();
    } else {
        if (createPlaylist(val)) closeCreatePlaylistModal();
    }
}

createPlaylistModalConfirmBtn?.addEventListener('click', handleCreatePlaylistConfirm);
createPlaylistModalInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { // ★ IME 守卫
        e.preventDefault();
        handleCreatePlaylistConfirm();
    }
});

/* 新建歌单切换 ★ 对齐导入歌单弹窗 */
playlistCreateToggleBtn?.addEventListener('click', () => {
    openCreatePlaylistModal(false);
});

/* 保存当前播放队列为新歌单 */
playlistSaveQueueBtn?.addEventListener('click', () => {
    if (playlist.length === 0) { playlistsHintEl.textContent = '播放队列为空'; return; }
    openCreatePlaylistModal(true);
});

/* URL 导入歌单 */
globalThis.isImportingPlaylist = false;

playlistImportToggleBtn?.addEventListener('click', () => {
importPlaylistOverlay.classList.add('visible');
importHintEl.textContent = '';
importProgressWrap.style.display = 'none';
importUrlInput.focus();
});

importPlaylistCloseBtn?.addEventListener('click', () => {
if (!isImportingPlaylist) importPlaylistOverlay.classList.remove('visible');
});

importPlaylistOverlay?.addEventListener('click', (e) => {
if (e.target === importPlaylistOverlay && !isImportingPlaylist) {
importPlaylistOverlay.classList.remove('visible');
}
});

importConfirmBtn?.addEventListener('click', () => {
importPlaylistFromUrl(importUrlInput.value.trim());
});

importUrlInput?.addEventListener('keydown', (e) => {
if (e.key === 'Enter' && !e.isComposing) { // ★ IME 守卫
e.preventDefault();
importPlaylistFromUrl(importUrlInput.value.trim());
}
});

/* 判断歌单来源（网易云 / QQ音乐） */
function getPlaylistSource(url) {
            if (/\.qq\./i.test(url) || /y\.qq\.com/i.test(url)) return 'tencent';
            if (/163cn\.tv|\.163\./i.test(url) || /music\.126\./i.test(url)) return 'netease';
            return 'netease';
        }

/* 从网易云链接中提取歌单ID */
function extractNeteaseId(url) {
            const idMatch = url.match(/[?&]id=(\d+)/);
            if (idMatch) return idMatch[1];
            const pathMatch = url.match(/playlist\/(\d+)/);
            if (pathMatch) return pathMatch[1];
            if (/^\d+$/.test(url.trim())) return url.trim();
            return null;
        }

/* 从QQ音乐链接中提取歌单ID */
function extractQQId(url) {
            const idMatch = url.match(/[?&]id=(\d+)/);
            if (idMatch) return idMatch[1];
            const disstidMatch = url.match(/[?&]disstid=(\d+)/);
            if (disstidMatch) return disstidMatch[1];
            const pathMatch = url.match(/playlist\/(\d+)/);
            if (pathMatch) return pathMatch[1];
            if (/^\d+$/.test(url.trim())) return url.trim();
            return null;
        }

/* 解析短链接，返回重定向后的完整URL（通过CORS代理跟随重定向） */
async function resolveShortLink(shortUrl) {
            /* 尝试多个代理，任一成功即返回 */
            const proxies = [
                u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u),
                u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u)
            ];
            for (const mkProxy of proxies) {
                try {
                    const proxyUrl = mkProxy(shortUrl);
                    const res = await fetch(proxyUrl);
                    if (!res.ok) continue;
                    const html = await res.text();
                    /* 1. 从HTML中查找 id= 参数（网易云/QQ通用） */
                    const idMatch = html.match(/[?&]id=(\d+)/);
                    if (idMatch) return idMatch[1];
                    /* 2. 从HTML中查找 disstid= 参数（QQ音乐） */
                    const disstidMatch = html.match(/[?&]disstid=(\d+)/);
                    if (disstidMatch) return disstidMatch[1];
                    /* 3. 从HTML中查找 playlist/ 路径中的ID */
                    const pathMatch = html.match(/playlist\/(\d+)/);
                    if (pathMatch) return pathMatch[1];
                    /* 4. 从 meta refresh 或 JS 跳转中提取URL */
                    const refreshMatch = html.match(/url=([^"'\s>]+)/i);
                    if (refreshMatch) {
                        const redirectUrl = decodeURIComponent(refreshMatch[1]);
                        const redirectId = redirectUrl.match(/[?&]id=(\d+)/);
                        if (redirectId) return redirectId[1];
                    }
                } catch(e) {
                    logWarn('playlistUiEvents', '短链接解析代理失败:', e);
                }
            }
            return null;
        }

export { closeAddToPlaylist, extractNeteaseId, extractQQId, getPlaylistSource, resolveShortLink };
