/* ============================================================
 * 305-smart-playlist.js — 智能播放列表（需求 7）
 *
 * 一句话流程：用户输入自然语言 → **AI 只解析成结构化规则** → 弹出来给用户确认/微调
 * → 用规则在**本地曲库**里筛歌、建歌单。规则连同歌单一起落盘，
 * 之后打开歌单直接读本地歌曲列表，**不再调用 AI**（需求原文）。
 *
 * ★ 为什么"确认"这一步不能省：AI 解析出的规则是**猜的**。直接建歌单的话，
 *   用户看到的是一个来源不明的列表，错了只能删掉重来；把规则摊开给他改一行 JSON，
 *   代价极低而可控性天差地别。规则的清洗与容错全在 core/smartPlaylist.js（有单测）。
 *
 * ★ 为什么本地曲库是"收藏 + 所有歌单 + 最近播放 + 本地文件"这四路：
 *   本项目没有一份统一的"曲库表"。这四路覆盖了用户手上全部**已确认想要**的歌，
 *   也正是"我收藏了 500 首"的真实语义。不入库的歌（只搜索过没收藏）不参与匹配，
 *   因为对它们没有稳定元数据（尤其 BPM/情绪）。
 *
 * ★ 分析数据（BPM / 情绪）是**可选增强**：本机缓存里有就用，没有就把那首歌
 *   记成"缺少 BPM 分析数据"而不是静默丢弃——否则用户看到"只匹配到 3 首"
 *   完全无法判断是规则太窄还是数据没算过（core 层的 REJECT_REASONS 就是为此）。
 *   BPM 来自 core/automix/analyzer.js 的 automixCache，情绪来自 aiCache(aiThemeCache)。
 * ============================================================ */
import {
    generatePlaylistId, getPlaylists, renderPlaylistsView, savePlaylists,
} from './130-playlists.js';
import { getFavorites, makeSongKey, setHint } from './120-search-results.js';
import { getRecentHistory } from './258-rankings.js';
import { localMusicManager } from './10-config-state.js';
import { geminiGenerateContent, GEMINI_DEFAULT_BASE, GEMINI_DEFAULT_MODEL } from '../services/aiClient.js';
import { aiCacheGet, automixCacheGet } from '../services/aiCache.js';
import { automixCacheKey } from '../core/automix/analyzer.js';
import {
    buildSmartPrompt, isEmptySmartRule, normalizeSmartRule, parseSmartRuleReply,
    queryLibrary, ruleNeedsAnalysis, ruleToJSON,
} from '../core/smartPlaylist.js';
import { translatePhrase } from '../core/i18n.js';
import { logCatch, logInfo } from '../services/log.js';

const tx = translatePhrase;
const TAG = 'smartPlaylist';

/** 最近播放条目 → 歌曲对象的字段名与收藏/歌单不完全一致，这里统一 */
function normSong(s, fallbackKey) {
    if (!s || (!s.title && !s.url)) return null;
    return {
        key: s.key || fallbackKey || makeSongKey(s),
        title: s.title || '',
        artist: s.artist || '',
        album: s.album || '',
        cover: s.cover || s.coverUrl || '',
        source: s.source || '',
        id: (s.id !== undefined && s.id !== null) ? s.id : '',
        mid: s.mid || '',
        url: s.url || '',
    };
}

/** 收集本地曲库（去重，键优先用 song.key） */
async function buildLibrary() {
    const map = new Map();
    const add = (s) => {
        const song = normSong(s);
        if (!song) return;
        if (!song.key) song.key = `${song.source}:${song.id}:${song.title}`;
        if (map.has(song.key)) return;
        map.set(song.key, song);
    };
    try { for (const s of (getFavorites() || [])) add(s); } catch (e) { logCatch(TAG, e); }
    try {
        for (const pl of (getPlaylists() || [])) for (const s of (pl.songs || [])) add(s);
    } catch (e) { logCatch(TAG, e); }
    try { for (const s of (getRecentHistory() || [])) add(s); } catch (e) { logCatch(TAG, e); }
    try {
        const local = await localMusicManager.getLocalSongs();
        for (const s of (local || [])) add({ ...s, source: s.source || 'local' });
    } catch (e) { logCatch(TAG, e); }
    return [...map.values()];
}

/** 可选增强：把本地缓存里的 BPM 与情绪贴到曲库条目上（只取缓存，不做新分析） */
async function enrichWithAnalysis(entries) {
    const out = [];
    for (const entry of entries) {
        let bpm = null;
        let mood = null;
        try {
            const am = await automixCacheGet(automixCacheKey(entry));
            if (am && Number.isFinite(Number(am.bpm))) bpm = Number(am.bpm);
        } catch (e) { logCatch(TAG, e); }
        try {
            const theme = await aiCacheGet(`${entry.title} - ${entry.artist}`);
            if (theme) {
                if (Array.isArray(theme.emotion_words) && theme.emotion_words.length) mood = theme.emotion_words;
                else if (theme.mood) mood = theme.mood;
            }
        } catch (e) { logCatch(TAG, e); }
        out.push({ ...entry, bpm, mood });
    }
    return out;
}

/** 用规则建一个歌单（落盘规则本身，便于将来复用/重生成） */
function createSmartPlaylist(rule, matched, rejects) {
    const name = rule.name || tx('智能歌单');
    const playlists = getPlaylists();
    let finalName = name;
    let n = 2;
    while (playlists.some((p) => p.name === finalName)) finalName = `${name} ${n++}`;
    const songs = matched.map((e) => ({
        key: e.key, title: e.title || tx('未知歌曲'), artist: e.artist || '',
        cover: e.cover || '', source: e.source || '', id: e.id || '', mid: e.mid || '', url: e.url || '',
    }));
    playlists.unshift({
        id: generatePlaylistId(),
        name: finalName,
        cover: (songs[0] && songs[0].cover) || '',
        songs,
        createdAt: Date.now(),
        /* ★ 规则必须随歌单落盘：需求要求"之后打开歌单直接用本地查库、不调 AI"，
           而规则是唯一能"重新生成"的依据；丢了这个字段，歌单就退化成普通快照。 */
        smartRule: rule,
        smartCreatedAt: Date.now(),
        smartRejects: rejects.slice(0, 200).map((r) => ({ title: r.entry.title, artist: r.entry.artist, reason: r.reason })),
    });
    savePlaylists(playlists);
    renderPlaylistsView();
    return finalName;
}

/** 主流程：描述 → AI 规则 → 用户确认 → 本地生成 */
async function openSmartPlaylist() {
    try {
        if (typeof window === 'undefined' || typeof window.showGlassPrompt !== 'function') return;
        const desc = await window.showGlassPrompt({
            title: tx('智能歌单'),
            desc: tx('用一句话描述你想听什么。AI 只把它翻译成规则，之后在本地曲库里筛歌，不再调用 AI。'),
            placeholder: tx('例如：深夜适合听的慢歌，BPM 80 以下，别要现场版'),
            multiline: true,
            rows: 4,
            okText: tx('解析'),
        });
        if (desc == null) return;
        if (!String(desc).trim()) { setHint(tx('请先描述你想要什么样的歌单')); return; }

        const ai = (globalThis.appSettings && globalThis.appSettings.ai) || {};
        const apiKey = String(ai.apiKey || '').trim();
        if (apiKey.length < 10) {
            setHint(tx('请先在 设置 → AI 分析 里配置 API Key'));
            return;
        }

        setHint(tx('AI 正在解析你的描述…'));
        const { system, user } = buildSmartPrompt(desc, {});
        const res = await geminiGenerateContent({
            prompt: user,
            systemInstruction: system,
            apiKey,
            apiBase: ai.apiBase || GEMINI_DEFAULT_BASE,
            model: ai.model || GEMINI_DEFAULT_MODEL,
            timeoutMs: 30000,
        });
        if (!res || !res.ok) {
            setHint(`${tx('AI 解析失败')}：${(res && res.error) || ''}`);
            return;
        }
        const parsed = parseSmartRuleReply(res.text);
        if (!parsed) { setHint(tx('没能从 AI 回复里读出规则，请再试一次')); return; }

        const edited = await window.showGlassPrompt({
            title: tx('确认规则'),
            desc: tx('可以直接改这份 JSON，改完点"生成歌单"。'),
            multiline: true,
            rows: 10,
            value: ruleToJSON(parsed),
            okText: tx('生成歌单'),
        });
        if (edited == null) return;
        let rule;
        try {
            rule = normalizeSmartRule(JSON.parse(String(edited)));
        } catch (e) {
            logCatch(TAG, e);
            setHint(tx('规则 JSON 格式有误，已取消'));
            return;
        }
        if (isEmptySmartRule(rule)) { setHint(tx('这份规则没有任何筛选条件，已取消')); return; }

        setHint(tx('正在本地曲库里筛歌…'));
        let library = await buildLibrary();
        if (!library.length) { setHint(tx('本地曲库是空的，先去收藏或歌单里攒点歌吧')); return; }
        if (ruleNeedsAnalysis(rule)) library = await enrichWithAnalysis(library);

        const { matched, rejected, overLimit } = queryLibrary(rule, library);
        if (!matched.length) {
            setHint(`${tx('没有匹配到歌曲')}（${library.length} ${tx('首已检查')}）`);
            return;
        }
        const name = createSmartPlaylist(rule, matched, rejected);
        logInfo(TAG, `生成「${name}」：${matched.length} 首，未匹配 ${rejected.length} 首，超上限 ${overLimit} 首`);
        let msg = `${tx('已生成')}「${name}」：${matched.length} ${tx('首')}`;
        if (rejected.length) msg += ` · ${rejected.length} ${tx('首不匹配')}`;
        if (overLimit) msg += ` · ${overLimit} ${tx('首超出上限未收录')}`;
        setHint(msg);
    } catch (e) {
        logCatch(TAG, e);
        setHint(tx('智能歌单生成失败，请看日志'));
    }
}

/* 入口按钮：自建自挂到歌单面板标题栏（与"从链接导入"并排）。
   刻意不改 index.html：本仓库既有的自建自挂模式（285/283 等）就是为了避免
   为一个按钮去动主文档、并让分片可以独立回滚。 */
function mountEntryButton() {
    try {
        if (typeof document === 'undefined') return;
        if (document.getElementById('smartPlaylistBtn')) return;
        const anchor = document.getElementById('playlistImportToggleBtn');
        if (!anchor || !anchor.parentNode) return;
        const btn = document.createElement('button');
        btn.id = 'smartPlaylistBtn';
        btn.className = 'playlist-add-btn';
        btn.title = '智能歌单';
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">'
            + '<path d="M12 3l1.7 4.6L18 9.3l-4.3 1.7L12 15.6l-1.7-4.6L6 9.3l4.3-1.7z"></path>'
            + '<path d="M18.5 15.5l.8 2.1 2.2.8-2.2.8-.8 2.1-.8-2.1-2.2-.8 2.2-.8z"></path></svg>';
        btn.onclick = (e) => { e.stopPropagation(); openSmartPlaylist(); };
        anchor.parentNode.insertBefore(btn, anchor);
    } catch (e) {
        logCatch(TAG, e);
    }
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mountEntryButton, { once: true });
    } else {
        mountEntryButton();
    }
    /* 歌单面板是常驻 DOM，但若被别的分片重建过标题栏，兜住一次 */
    document.addEventListener('aria:playlists-opened', mountEntryButton);
}

export { openSmartPlaylist };
