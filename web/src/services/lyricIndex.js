/* ============================================================
 * services/lyricIndex.js — 歌词全文索引（IndexedDB 属主，纯数据层，不碰 DOM）
 *
 * 范围（todos #2）：当前歌 + 收藏 + 自建歌单 + 最近播放。索引单元 = 一首歌的
 * 全部歌词行；命中单元 = 一句歌词（带时间戳），跳过去由调用方（288 分片）负责。
 *
 * 为什么单独一个库：user_config.json（收藏/歌单/设置同库）已经 161KB，歌词全文
 * 塞进去会让每次配置保存都串行化几 MB。IndexedDB 侧本库是唯一属主（与
 * aiCache.js 之于 LyricsPlayerDB、fontService.js 之于 lyrics_player_fonts 同一约定），
 * 别处不要 indexedDB.open('aria_lyric_index')。
 *
 * 匹配口径：中文按「子串」匹配，不做分词——规范化时丢掉空白与标点
 * （\p{P}\p{S}\p{M}）并把 NFKC + 小写归一，于是「天青色等烟雨，而我在等你」
 * 能被「天青色 等烟雨」这种带空格/漏标点的输入命中。多词按 AND：
 * 每个词都得出现在同一行里。高亮位置用 normParts 带回的映射换算回原文下标。
 * ============================================================ */

const DB_NAME = 'aria_lyric_index';
const DB_VERSION = 1;
const DOC_STORE = 'docs';

/* 来源权重：越靠近「用户主动攒下的」越高，最近播放最低（它只是个足迹） */
export const SCOPE_WEIGHT = { current: 1, favorite: 0.86, playlist: 0.62, recent: 0.5 };
export const SCOPE_ORDER = ['current', 'favorite', 'playlist', 'recent'];

/** 索引容量上限：取词是网络请求，无上限会把自建服务打爆 */
export const MAX_DOCS = 800;
/** 取词失败/无歌词的歌在这个窗口内不再重试（冷却），过期后自动补试 */
export const EMPTY_RETRY_MS = 6 * 3600 * 1000;
/** 每首歌最多进结果列表的行数（命中次数仍按全曲统计） */
export const DEFAULT_PER_SONG_LIMIT = 3;
export const DEFAULT_LIMIT = 60;

const DROP_RE = /[\s\u3000\p{P}\p{S}\p{M}]/u;

/* ---------- 规范化与匹配 ---------- */

/**
 * 丢空白/标点的归一化，同时保留「归一字符 → 原文下标 + 原文宽度」的映射，
 * 供高亮把命中区间换算回原串。
 * @returns {{n: string, at: number[], wid: number[]}}
 */
export function normParts(text) {
    const s = String(text == null ? '' : text);
    const kept = [];
    const at = [];
    const wid = [];
    let i = 0;
    for (const ch of s) {
        const w = ch.length;
        /* normalize 只对非法 form 抛错，对孤立代理项是安全的，这里不需要 try */
        const norm = ch.normalize('NFKC').toLowerCase();
        for (let k = 0; k < norm.length; k++) {
            const c = norm[k];
            if (DROP_RE.test(c)) continue;
            kept.push(c);
            at.push(i);
            wid.push(w);
        }
        i += w;
    }
    return { n: kept.join(''), at, wid };
}

/** 归一化文本（只留可匹配字符，小写、NFKC） */
export function normText(text) {
    return normParts(text).n;
}

/** 查询串 → 词元数组（空白分词 + 归一，丢空串） */
export function normalizeTerms(query) {
    return String(query == null ? '' : query)
        .split(/\s+/)
        .map(normText)
        .filter(Boolean);
}

function allRangesOf(n, term) {
    const spans = [];
    if (!term || !n) return spans;
    let from = 0;
    for (;;) {
        const p = n.indexOf(term, from);
        if (p < 0) break;
        spans.push([p, p + term.length]);
        from = p + term.length;
        if (from > n.length) break;
    }
    return spans;
}

/** 归一坐标区间 → 原文坐标区间（相邻/重叠的合并，避免输出 <mark></mark> 碎片） */
function toSourceRanges(at, wid, spans) {
    if (!spans.length) return null;
    const raw = [];
    for (const [s, e] of spans) {
        const start = at[s];
        const end = at[e - 1] + (wid[e - 1] || 1);
        if (start === undefined || end === undefined) continue;
        const last = raw[raw.length - 1];
        if (last && start <= last[1]) last[1] = Math.max(last[1], end);
        else raw.push([start, end]);
    }
    return raw.length ? raw : null;
}

/** 词元在归一串上的全部出现位置；任一词元缺席即 null（多词 AND） */
function spansOfTerms(n, terms) {
    let spans = [];
    for (const t of terms) {
        const hit = allRangesOf(n, t);
        if (!hit.length) return null;
        spans = spans.concat(hit);
    }
    return spans.length ? spans : null;
}

/**
 * 一行是否命中：所有词元都在同一行（原文轨或译文轨）内出现。
 * 归一形优先用调用方给的（文档里已存 q），只有命中的那一行才回算原文下标映射。
 * @param {string} text 展示用原文
 * @param {string} [norm] text 的归一形（缺省时现算）
 * @param {string[]} terms 归一后的词元
 * @param {Object} [alt] 备用轨 { text }（如译文）
 * @returns {{track:string, ranges:number[][]}|null}
 */
export function matchLine(text, norm, terms, alt) {
    if (!terms.length) return null;
    const n = (typeof norm === 'string') ? norm : normText(text);
    const spans = spansOfTerms(n, terms);
    if (spans) {
        const p = normParts(text);
        const ranges = toSourceRanges(p.at, p.wid, spans);
        if (ranges) return { track: 'x', ranges };
    }
    if (alt && alt.text) {
        const aSpans = spansOfTerms(alt.n || normText(alt.text), terms);
        if (aSpans) {
            const p = normParts(alt.text);
            const ranges = toSourceRanges(p.at, p.wid, aSpans);
            if (ranges) return { track: 'y', ranges };
        }
    }
    return null;
}

/* ---------- 文档结构 ---------- */

/** 与 120-search-results 的 makeSongKey 同一套口径（额外兼容 mid/hash），保证跨来源同歌同键 */
export function songKeyOf(song) {
    if (!song) return '';
    const src = song.source || '';
    const id = song.id != null ? String(song.id) : '';
    const mid = song.mid != null ? String(song.mid) : '';
    const hash = song.hash != null ? String(song.hash) : '';
    if (src && (id || mid || hash)) return `${src}:${id || mid || hash}`;
    if (mid) return `tencent:${mid}`;
    if (hash) return `kugou:${hash}`;
    if (id) return `id:${id}`;
    return 'local:' + (song.url || song.file || song.path || song.title || '');
}

export function titleOf(song) {
    return String((song && (song.title || song.song || song.name)) || '').trim();
}

export function artistOf(song) {
    const a = song && (song.artist || song.singer || song.artists);
    if (Array.isArray(a)) return a.map(x => (x && (x.name || x.title)) || x).join(' / ');
    return String(a || '').trim();
}

/** 歌词行 → 展示文本：优先整行文本，逐字行退化为拼接词元 */
export function lineTextOf(line) {
    if (!line) return '';
    const direct = line.original || line.text || line.lyric || '';
    if (String(direct).trim()) return String(direct).trim();
    if (Array.isArray(line.words) && line.words.length) {
        return line.words.map(w => (w && (w.text != null ? w.text : w.word)) || '').join('').trim();
    }
    return '';
}

function hash32(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
}

/** 歌词内容签名：行数 + 全文摘要（同一首歌换歌词源/重取到更完整版时用于判定变更） */
export function sigOf(lines) {
    const list = Array.isArray(lines) ? lines : [];
    let acc = '';
    for (let i = 0; i < list.length; i++) acc += String(list[i].x || '') + String(list[i].y || '');
    return `${list.length}:${hash32(acc)}`;
}

/** 合并后的歌词行（renderLyrics 的产物）或 parse 结果数组 → 索引行 */
export function toIndexLines(lyricLines) {
    const list = Array.isArray(lyricLines) ? lyricLines : [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const line = list[i];
        const x = lineTextOf(line);
        if (!x) continue;
        let y = (typeof line.translation === 'string') ? line.translation.trim() : '';
        if (y === '//') y = '';
        if (y && y === x) y = '';
        const t = Number(line.start != null ? line.start : (line.time || 0));
        out.push({ t: Number.isFinite(t) ? Math.max(0, Math.round(t)) : 0, x, q: normText(x), y, yq: y ? normText(y) : '' });
    }
    return out;
}

export function sortScopes(scopes) {
    const seen = new Set();
    const list = [];
    for (const s of (scopes || [])) {
        if (!s || !SCOPE_WEIGHT[s] || seen.has(s)) continue;
        seen.add(s);
        list.push(s);
    }
    list.sort((a, b) => SCOPE_ORDER.indexOf(a) - SCOPE_ORDER.indexOf(b));
    return list;
}

export function weightOf(scopes) {
    let w = 0;
    for (const s of (scopes || [])) {
        const v = SCOPE_WEIGHT[s];
        if (v && v > w) w = v;
    }
    return w;
}

/**
 * 建一篇文档。lines 为「歌词行对象数组」（mergeLyrics 产物形状），内部自行归一。
 * @returns {Object|null} 无有效歌词行时返回 null（调用方决定是否记 empty）
 */
export function buildDoc(song, lines, scopes, extra = {}) {
    const idxLines = toIndexLines(lines);
    if (!idxLines.length) return null;
    const key = extra.key || songKeyOf(song);
    if (!key) return null;
    return {
        key,
        title: titleOf(song) || '未知歌曲',
        artist: artistOf(song),
        source: (song && song.source) || '',
        id: (song && song.id != null) ? String(song.id) : '',
        mid: (song && song.mid) || '',
        hash: (song && song.hash) || '',
        url: (song && song.url) || '',
        cover: (song && song.cover) || '',
        scopes: sortScopes(scopes),
        n: idxLines.length,
        sig: sigOf(idxLines),
        empty: false,
        at: extra.at || Date.now(),
        lines: idxLines,
    };
}

/** 取词失败/确实没歌词也记一条，避免每轮都重新发请求 */
export function buildEmptyDoc(song, scopes, reason) {
    const key = songKeyOf(song);
    if (!key) return null;
    return {
        key,
        title: titleOf(song) || '未知歌曲',
        artist: artistOf(song),
        source: (song && song.source) || '',
        id: (song && song.id != null) ? String(song.id) : '',
        mid: (song && song.mid) || '',
        hash: (song && song.hash) || '',
        url: (song && song.url) || '',
        cover: (song && song.cover) || '',
        scopes: sortScopes(scopes),
        n: 0,
        sig: '',
        empty: true,
        reason: String(reason || '').slice(0, 80),
        at: Date.now(),
        lines: [],
    };
}

/* ---------- 纯函数：多来源合并去重 + 增量计划 ---------- */

/**
 * 四路来源 → 去重后的期望集合（同一首歌在多来源只留一条，scopes 合并）。
 * @param {{scope:string, items:Object[]}[]} lists
 * @returns {{key:string, song:Object, scopes:string[], weight:number}[]} 按权重降序
 */
export function mergeDesired(lists) {
    const map = new Map();
    for (const grp of (lists || [])) {
        if (!grp || !grp.scope || !Array.isArray(grp.items)) continue;
        for (const song of grp.items) {
            if (!song) continue;
            const key = songKeyOf(song);
            if (!key) continue;
            const prev = map.get(key);
            if (prev) {
                prev.scopes = sortScopes(prev.scopes.concat(grp.scope));
                prev.weight = weightOf(prev.scopes);
                if (!prev.lines && Array.isArray(grp.lines)) prev.lines = grp.lines;
                if (!prev.song || !titleOf(prev.song)) prev.song = song;
                continue;
            }
            const scopes = sortScopes([grp.scope]);
            map.set(key, { key, song, scopes, weight: weightOf(scopes), lines: Array.isArray(grp.lines) ? grp.lines : null });
        }
    }
    const out = [];
    map.forEach(v => out.push(v));
    out.sort((a, b) => b.weight - a.weight || String(a.key).localeCompare(String(b.key)));
    return out;
}

/**
 * 期望集合 vs 现有文档 → 增量动作。
 * put   : 歌词已在手上（当前歌），直接落库
 * fetch : 需要取词（收藏/歌单/最近），调用方按空闲批次消费
 * prune : 已从所有来源消失
 * @param {{forceRefetch?:boolean, now?:number, maxDocs?:number, haveCount?:number, emptyRetryMs?:number} = {}} opts
 */
export function planSync(desired, have, opts = {}) {
    const now = opts.now || Date.now();
    const maxDocs = opts.maxDocs || MAX_DOCS;
    const emptyRetryMs = opts.emptyRetryMs != null ? opts.emptyRetryMs : EMPTY_RETRY_MS;
    const haveMap = new Map();
    for (const d of (have || [])) { if (d && d.key) haveMap.set(d.key, d); }
    const want = new Set();
    const put = [];
    const fetch = [];
    const cooling = [];
    let skipped = 0;
    let budget = maxDocs - (opts.haveCount != null ? opts.haveCount : haveMap.size);

    for (const entry of (desired || [])) {
        if (!entry || !entry.key) continue;
        want.add(entry.key);
        const doc = haveMap.get(entry.key);
        const scopesChanged = doc && doc.scopes.join(',') !== entry.scopes.join(',');
        if (doc && !doc.empty) {
            if (entry.lines) {
                const next = buildDoc(entry.song, entry.lines, entry.scopes, { key: entry.key, at: now });
                if (next && (next.sig !== doc.sig || scopesChanged)) put.push(next);
                else skipped++;
            } else if (scopesChanged) {
                put.push(Object.assign({}, doc, { scopes: sortScopes(entry.scopes), at: doc.at }));
            } else skipped++;
            continue;
        }
        if (doc && doc.empty) {
            if (scopesChanged) put.push(Object.assign({}, doc, { scopes: sortScopes(entry.scopes) }));
            if (opts.forceRefetch || (now - (doc.at || 0)) >= emptyRetryMs) {
                if (entry.lines) {
                    const next = buildDoc(entry.song, entry.lines, entry.scopes, { key: entry.key, at: now });
                    if (next) put.push(next);
                } else fetch.push(entry);
            } else cooling.push(entry.key);
            continue;
        }
        if (entry.lines) {
            const next = buildDoc(entry.song, entry.lines, entry.scopes, { key: entry.key, at: now });
            if (next) put.push(next);
            continue;
        }
        if (budget <= 0) { skipped++; continue; }
        budget--;
        fetch.push(entry);
    }

    const prune = [];
    haveMap.forEach((doc, key) => { if (!want.has(key)) prune.push(key); });
    return { put, fetch, prune, cooling, skipped };
}

/* ---------- 纯函数：查询与排序 ---------- */

/**
 * @param {string} query 用户输入的一句歌词
 * @param {Object[]} docs 文档数组
 * @param {{limit?:number, perSong?:number, keys?:string[]|null}} [opts]
 * @returns {{rows:Object[], total:number, songs:number, scanned:number}}
 */
export function searchLyric(query, docs, opts = {}) {
    const terms = normalizeTerms(query);
    const res = { rows: [], total: 0, songs: 0, scanned: 0 };
    if (!terms.length || !Array.isArray(docs)) return res;
    const limit = opts.limit || DEFAULT_LIMIT;
    const perSong = opts.perSong || DEFAULT_PER_SONG_LIMIT;
    const only = Array.isArray(opts.keys) && opts.keys.length ? new Set(opts.keys) : null;
    const flat = [];

    for (const doc of docs) {
        if (!doc || doc.empty || !Array.isArray(doc.lines) || !doc.lines.length) continue;
        if (only && !only.has(doc.key)) continue;
        res.scanned++;
        const rows = [];
        for (let i = 0; i < doc.lines.length; i++) {
            const line = doc.lines[i] || {};
            const m = matchLine(line.x, line.q, terms, line.y ? { text: line.y, n: line.yq } : null);
            if (!m) continue;
            rows.push({
                key: doc.key,
                title: doc.title,
                artist: doc.artist,
                source: doc.source,
                cover: doc.cover,
                id: doc.id,
                mid: doc.mid,
                hash: doc.hash,
                url: doc.url,
                scopes: doc.scopes,
                scope: (doc.scopes && doc.scopes[0]) || '',
                lineIndex: i,
                time: line.t || 0,
                text: m.track === 'y' ? line.y : line.x,
                original: line.x,
                ranges: m.ranges,
                track: m.track,
                prev: i > 0 ? (doc.lines[i - 1] || {}).x || '' : '',
                next: i < doc.lines.length - 1 ? (doc.lines[i + 1] || {}).x || '' : '',
                songHits: 0,
                weight: weightOf(doc.scopes),
                indexedAt: doc.at || 0,
                score: 0,
            });
        }
        if (!rows.length) continue;
        res.songs++;
        res.total += rows.length;
        const weight = weightOf(doc.scopes);
        const score = rows.length * 10 + weight * 5;
        rows.forEach(r => { r.songHits = rows.length; r.weight = weight; r.score = score; });
        rows.sort((a, b) => a.lineIndex - b.lineIndex);
        flat.push(...rows.slice(0, perSong));
    }

    flat.sort((a, b) => b.score - a.score || b.indexedAt - a.indexedAt
        || a.key.localeCompare(b.key) || a.lineIndex - b.lineIndex);
    res.rows = flat.slice(0, limit);
    return res;
}

/* ---------- 存储 ---------- */

function reqDone(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function createIdbAdapter() {
    let dbPromise = null;
    const open = async () => {
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                const idb = (typeof indexedDB !== 'undefined') ? indexedDB : null;
                if (!idb) { reject(new Error('IndexedDB 不可用')); return; }
                const rq = idb.open(DB_NAME, DB_VERSION);
                rq.onupgradeneeded = () => {
                    const db = rq.result;
                    if (!db.objectStoreNames.contains(DOC_STORE)) db.createObjectStore(DOC_STORE, { keyPath: 'key' });
                };
                rq.onsuccess = () => resolve(rq.result);
                rq.onerror = () => reject(rq.error);
                rq.onblocked = () => reject(new Error('IndexedDB 被旧连接阻塞'));
            });
        }
        return dbPromise;
    };
    const tx = async (mode, fn) => {
        const db = await open();
        const t = db.transaction(DOC_STORE, mode);
        const out = fn(t.objectStore(DOC_STORE));
        return new Promise((resolve, reject) => {
            t.oncomplete = () => resolve(out ? out : undefined);
            t.onerror = () => reject(t.error);
            t.onabort = () => reject(t.error);
        });
    };
    return {
        async ping() { await open(); return true; },
        async all() { const db = await open(); return (await reqDone(db.transaction(DOC_STORE, 'readonly').objectStore(DOC_STORE).getAll())) || []; },
        async putMany(docs) { await tx('readwrite', s => { for (const d of docs) s.put(d); }); },
        async delMany(keys) { await tx('readwrite', s => { for (const k of keys) s.delete(k); }); },
        async clear() { await tx('readwrite', s => { s.clear(); }); },
    };
}

let _store = null;
let _cache = new Map();
let _loaded = false;
let _loadError = '';

function activeStore() {
    if (!_store) _store = createIdbAdapter();
    return _store;
}

/** 注入存储实现（测试用内存 store；浏览器侧不要调用） */
export function useStore(store) {
    _store = store || null;
    _cache = new Map();
    _loaded = false;
    _loadError = '';
}

export function isLoaded() { return _loaded; }
export function loadError() { return _loadError; }

/** 存储是否可用（IDB 被隐私模式禁用时给出明确状态而不是假装空库） */
export async function probeStore() {
    try { await activeStore().ping(); return true; } catch (e) { _loadError = (e && e.message) || 'unavailable'; return false; }
}

/** 全量载入内存缓存：查询是同步热路径，不能每敲一个字开一次事务 */
export async function loadIndex() {
    try {
        const docs = await activeStore().all();
        _cache = new Map();
        for (const d of docs) { if (d && d.key) _cache.set(d.key, d); }
        _loaded = true;
        _loadError = '';
        return _cache.size;
    } catch (e) {
        _loaded = false;
        _loadError = (e && e.message) || 'unavailable';
        return 0;
    }
}

export function getCachedDocs() {
    const out = [];
    _cache.forEach(d => out.push(d));
    return out;
}

export function getDoc(key) {
    return _cache.get(key) || null;
}

export function cachedCount() { return _cache.size; }

export async function putDocs(docs) {
    const list = (docs || []).filter(Boolean);
    if (!list.length) return 0;
    for (const d of list) _cache.set(d.key, d);
    await activeStore().putMany(list);
    return list.length;
}

export async function removeDocs(keys) {
    const list = (keys || []).filter(Boolean);
    if (!list.length) return 0;
    for (const k of list) _cache.delete(k);
    await activeStore().delMany(list);
    return list.length;
}

export async function clearIndex() {
    _cache = new Map();
    await activeStore().clear();
    return true;
}

/** 同步查询（走内存缓存），返回 searchLyric 的形状 */
export function search(query, opts = {}) {
    return searchLyric(query, getCachedDocs(), opts);
}

/** 索引体检数据（面板页脚/诊断用） */
export function indexStats() {
    const byScope = { current: 0, favorite: 0, playlist: 0, recent: 0 };
    let lines = 0;
    let empty = 0;
    let newest = 0;
    _cache.forEach(d => {
        if (!d) return;
        if (d.empty) empty++;
        lines += (d.n || 0);
        if ((d.at || 0) > newest) newest = d.at;
        for (const s of (d.scopes || [])) if (byScope[s] !== undefined) byScope[s]++;
    });
    return { docs: _cache.size, lines, empty, byScope, newest, loaded: _loaded, error: _loadError };
}
