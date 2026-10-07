/* ============================================================
 * services/searchSuggest.js — 搜索热词 / 联想词（2026-10-04 用户需求）
 *
 * 用户原话：「想在搜索页加热词和联想词，跟历史搜索放一起。逻辑是输入框空着
 *   显示热词和历史，输入内容就切成联想词，清空再切回热词。vendor 里有接口
 *   你直接调。」
 *
 * 三家 vendor 的现成接口（本机实测，非文档推断）：
 *   QQ     /getHotkey                /getSmartbox?key=
 *          → response.data.hotkey[]        → response.data.{song,singer,album,mv}.itemlist[]
 *  网易    /search/hot              /search/suggest?keywords=
 *          → result.hots[].first           → result.{songs,artists,albums,playlists,mvs}[].name
 *  酷狗    /search/hot              /search/suggest?keywords=
 *          → data.list[].keywords[].keyword → data[].RecordDatas[].HintInfo
 *  汽水    无（零 suggest/hot 方法）→ 回退网易：宁可给一份通用建议，也不要空着
 *  酷我    2026-10-03 已从搜索页移除（无入口），这里不再登记
 *
 * 本模块只做「请求 + 解析」：解析函数全是纯函数并导出，便于单测；
 * 防抖 / 竞态 / 渲染留在 157-search-history.js。
 * ============================================================ */
import { selfhostKeyOf } from './playSource.js';
import { logCatch } from './log.js';

const SH_TIMEOUT = 6000;

/** 面板里最多显示多少条（热词 / 联想词各自） */
export const MAX_HOT = 12;
export const MAX_SUGGEST = 10;

/* 没有该能力的源 → 借用谁。'' 表示不借（面板就只显示本地历史）。 */
const HOT_FALLBACK = { qishui: 'netease' };
const SUGGEST_FALLBACK = { qishui: 'netease' };

const HOT_PATHS = {
    tencent: '/getHotkey',
    netease: '/search/hot',
    kugou: '/search/hot',
};

const SUGGEST_PATHS = {
    tencent: kw => `/getSmartbox?key=${encodeURIComponent(kw)}`,
    netease: kw => `/search/suggest?keywords=${encodeURIComponent(kw)}`,
    kugou: kw => `/search/suggest?keywords=${encodeURIComponent(kw)}`,
};

/** 该源（或其回退源）能不能出热词 */
export function hotSupported(source) {
    return Boolean(HOT_PATHS[source] || HOT_FALLBACK[source]);
}
/** 该源（或其回退源）能不能出联想词 */
export function suggestSupported(source) {
    return Boolean(SUGGEST_PATHS[source] || SUGGEST_FALLBACK[source]);
}

/** 实际用于请求的源（回退后） */
export function effectiveSource(source, fallback) {
    return fallback[source] ? fallback[source] : source;
}

/* ---------- 纯解析 ---------- */

function cleanText(s) {
    /* 上游爱在关键词尾部塞空格（QQ 的 hotkey.k 实测带尾空格），也可能带
       <em> 高亮标记（酷狗搜索的 SongName 就是），一并剥掉。 */
    return String(s == null ? '' : s)
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function uniqWords(list, max) {
    const out = [];
    const seen = new Set();
    for (const raw of list) {
        const w = cleanText(raw);
        if (!w) continue;
        const k = w.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(w);
        if (out.length >= max) break;
    }
    return out;
}

/**
 * 热词解析。返回字符串数组（已去重、去空白、限长）。
 * @param {'tencent'|'netease'|'kugou'} source 实际请求的源
 * @param {object} json 上游原始 JSON
 */
export function parseHotWords(source, json) {
    if (!json) return [];
    if (source === 'tencent') {
        const arr = (((json.response || {}).data || {}).hotkey) || [];
        return uniqWords(arr.map(x => x && x.k), MAX_HOT);
    }
    if (source === 'netease') {
        const arr = (((json.result || {}).hots) || []);
        return uniqWords(arr.map(x => x && (x.first || x.keyword)), MAX_HOT);
    }
    if (source === 'kugou') {
        const groups = (((json.data || {}).list) || []);
        const flat = [];
        groups.forEach(g => {
            ((g && g.keywords) || []).forEach(k => flat.push(k && k.keyword));
        });
        return uniqWords(flat, MAX_HOT);
    }
    return [];
}

/**
 * 联想词解析。返回字符串数组（已去重、去空白、限长）。
 * @param {'tencent'|'netease'|'kugou'} source 实际请求的源
 * @param {object} json 上游原始 JSON
 */
export function parseSuggestions(source, json) {
    if (!json) return [];
    if (source === 'tencent') {
        const d = (json.response || {}).data || {};
        const flat = [];
        /* 歌曲优先：用户点联想词基本都是想搜歌，歌手/专辑/MV 放后面补位 */
        ['song', 'singer', 'album', 'mv'].forEach(k => {
            const it = d[k];
            ((it && it.itemlist) || []).forEach(x => flat.push(x && x.name));
        });
        return uniqWords(flat, MAX_SUGGEST);
    }
    if (source === 'netease') {
        const r = (json.result || {});
        const flat = [];
        ['songs', 'artists', 'albums', 'playlists', 'mvs'].forEach(k => {
            (r[k] || []).forEach(x => flat.push(x && x.name));
        });
        return uniqWords(flat, MAX_SUGGEST);
    }
    if (source === 'kugou') {
        const d = json.data;
        const groups = Array.isArray(d) ? d : (d ? [d] : []);
        const flat = [];
        groups.forEach(g => {
            ((g && g.RecordDatas) || []).forEach(x => flat.push(x && x.HintInfo));
        });
        return uniqWords(flat, MAX_SUGGEST);
    }
    return [];
}

/* ---------- 请求 ---------- */

async function shGet(source, path) {
    const key = selfhostKeyOf(source);
    if (!key) return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SH_TIMEOUT);
    try {
        const res = await fetch(`/api/selfhost/${key}/proxy?path=${encodeURIComponent(path)}`,
            { signal: ctl.signal });
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        logCatch('searchSuggest', e);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** 拿该源的热词（不可用/失败一律回 []，调用方只管渲染）。 */
export async function fetchHotWords(source) {
    if (!hotSupported(source)) return [];
    const eff = effectiveSource(source, HOT_FALLBACK);
    const j = await shGet(eff, HOT_PATHS[eff]);
    return parseHotWords(eff, j);
}

/** 拿该源的联想词。keyword 为空直接回 []（不发请求）。 */
export async function fetchSuggestions(source, keyword) {
    const kw = String(keyword || '').trim();
    if (!kw) return [];
    if (!suggestSupported(source)) return [];
    const eff = effectiveSource(source, SUGGEST_FALLBACK);
    const j = await shGet(eff, SUGGEST_PATHS[eff](kw));
    return parseSuggestions(eff, j);
}
