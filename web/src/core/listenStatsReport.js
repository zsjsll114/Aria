/* ============================================================
 * core/listenStatsReport.js — 听歌统计数据累加与情绪化报告计算
 *
 * 职责：
 *  1) 精确统计累计播放、单曲/歌手真实收听毫秒数与本地日历天/24小时时段分布
 *     （修复原 258-rankings 内置实现按 UTC 跨天切日、且 30s 阈值前漏记歌曲时长的缺陷）；
 *  2) 聚合 aria_play_stats + aria_recent_history + favorites + AI 情绪缓存，
 *     构建带时空叙事、昼夜音律弧、14 日节拍、情绪光谱与心头偏爱榜的完整报告。
 *  纯函数（无 DOM / 无 Storage IO），供 app/256-listen-stats.js 与 node 单测直接消费。
 * ============================================================ */

/**
 * @typedef {object} SongStatEntry
 * @property {string} title
 * @property {string} artist
 * @property {number} n
 * @property {number} ms
 * @property {string} cover
 * @property {string} source
 * @property {string} id
 * @property {string} mid
 * @property {string} hash
 * @property {number} firstAt
 * @property {number} lastAt
 */

/**
 * @typedef {object} ArtistStatEntry
 * @property {number} n
 * @property {number} ms
 * @property {string} cover
 * @property {string} source
 * @property {number} lastAt
 */

/**
 * @typedef {object} PlayStatsState
 * @property {number} totalPlays
 * @property {number} totalMs
 * @property {number} firstAt
 * @property {number} resetAt
 * @property {Record<string, SongStatEntry>} songs
 * @property {Record<string, ArtistStatEntry>} artists
 * @property {Record<string, number>} days
 * @property {number[]} hours
 */

/**
 * @typedef {object} TickTracker
 * @property {string} activeKey
 * @property {number} pendingMs
 * @property {string} countedKey
 */

/**
 * @typedef {object} MoodSwatch
 * @property {string} color
 * @property {string} mood
 * @property {string} title
 * @property {number} weight
 */

/**
 * @typedef {object} EmotionWordItem
 * @property {string} word
 * @property {string} color
 * @property {string} emotion
 * @property {number} score
 */

const DAY_MS = 86400000;
const PLAY_COUNT_THRESHOLD_MS = 30000;

/** @param {number} n @returns {string} */
function pad2(n) {
    return String(Math.floor(Math.max(0, n))).padStart(2, '0');
}

/**
 * 本地时区日历键 YYYY-MM-DD（避免 ISO UTC 在 00:00~08:00 算成前一天）。
 * @param {number} [ts]
 * @returns {string}
 */
export function localDayKey(ts = Date.now()) {
    const d = new Date(Number.isFinite(ts) ? ts : Date.now());
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * @param {string} dayKey
 * @returns {number|null}
 */
export function parseLocalDayKey(dayKey) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || '').trim());
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const da = Number(m[3]);
    const d = new Date(y, mo, da, 12, 0, 0, 0);
    if (d.getFullYear() !== y || d.getMonth() !== mo || d.getDate() !== da) return null;
    return d.getTime();
}

/**
 * @param {string} dayKey
 * @param {number} deltaDays
 * @returns {string}
 */
export function shiftLocalDayKey(dayKey, deltaDays) {
    const base = parseLocalDayKey(dayKey);
    const t = base != null ? base : Date.now();
    return localDayKey(t + deltaDays * DAY_MS);
}

/**
 * @param {number} startTs
 * @param {number} endTs
 * @returns {number}
 */
export function daysBetweenLocalKeys(startTs, endTs) {
    const a = parseLocalDayKey(localDayKey(startTs));
    const b = parseLocalDayKey(localDayKey(endTs));
    if (a == null || b == null || b <= a) return 0;
    return Math.round((b - a) / DAY_MS);
}

/**
 * 归一化单曲签名（用于跨源/历史/AI 缓存关联封面与情绪）。
 * @param {string} [title]
 * @param {string} [artist]
 * @returns {string}
 */
export function songSignature(title, artist) {
    const t = String(title || '').trim().toLowerCase();
    const a = String(artist || '').trim().toLowerCase();
    return t ? `${t}|${a}` : '';
}

/**
 * 校验并规范十六进制颜色（仅放行 #rgb / #rrggbb）。
 * @param {*} raw
 * @returns {string}
 */
export function sanitizeHexColor(raw) {
    if (typeof raw !== 'string') return '';
    const s = raw.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toUpperCase();
    const m3 = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(s);
    if (m3) {
        return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`.toUpperCase();
    }
    return '';
}

/**
 * 创建初始播放统计对象。
 * @param {number} [resetAt]
 * @returns {PlayStatsState}
 */
export function defaultPlayStats(resetAt = 0) {
    return {
        totalPlays: 0,
        totalMs: 0,
        firstAt: 0,
        resetAt: Math.max(0, Number(resetAt) || 0),
        songs: {},
        artists: {},
        days: {},
        hours: new Array(24).fill(0),
    };
}

/**
 * 归一化持久化统计对象（向后兼容旧版缺 hours / cover / lastAt 的存档）。
 * @param {*} raw
 * @returns {PlayStatsState}
 */
export function normalizeStatsData(raw) {
    const base = defaultPlayStats();
    if (!raw || typeof raw !== 'object') return base;
    base.totalPlays = Math.max(0, Number(raw.totalPlays) || 0);
    base.totalMs = Math.max(0, Number(raw.totalMs) || 0);
    base.firstAt = Math.max(0, Number(raw.firstAt) || 0);
    base.resetAt = Math.max(0, Number(raw.resetAt) || 0);

    if (raw.songs && typeof raw.songs === 'object') {
        for (const [k, v] of Object.entries(raw.songs)) {
            if (!v || typeof v !== 'object') continue;
            base.songs[k] = {
                title: String(v.title || '未知歌曲'),
                artist: String(v.artist || ''),
                n: Math.max(0, Number(v.n) || 0),
                ms: Math.max(0, Number(v.ms) || 0),
                cover: String(v.cover || ''),
                source: String(v.source || ''),
                id: String(v.id || ''),
                mid: String(v.mid || ''),
                hash: String(v.hash || ''),
                firstAt: Math.max(0, Number(v.firstAt) || 0),
                lastAt: Math.max(0, Number(v.lastAt) || 0),
            };
        }
    }

    if (raw.artists && typeof raw.artists === 'object') {
        for (const [k, v] of Object.entries(raw.artists)) {
            if (!v || typeof v !== 'object') continue;
            base.artists[k] = {
                n: Math.max(0, Number(v.n) || 0),
                ms: Math.max(0, Number(v.ms) || 0),
                cover: String(v.cover || ''),
                source: String(v.source || ''),
                lastAt: Math.max(0, Number(v.lastAt) || 0),
            };
        }
    }

    if (raw.days && typeof raw.days === 'object') {
        for (const [k, v] of Object.entries(raw.days)) {
            const ms = Math.max(0, Number(v) || 0);
            if (ms > 0) base.days[k] = ms;
        }
    }

    if (Array.isArray(raw.hours)) {
        for (let h = 0; h < 24; h++) {
            base.hours[h] = Math.max(0, Number(raw.hours[h]) || 0);
        }
    }

    return base;
}

/**
 * 构造空闲跟踪器。
 * @returns {TickTracker}
 */
export function createTickTracker() {
    return { activeKey: '', pendingMs: 0, countedKey: '' };
}

/**
 * @param {TickTracker} tracker
 * @returns {TickTracker}
 */
export function resetTickForTrack(tracker) {
    tracker.activeKey = '';
    tracker.pendingMs = 0;
    tracker.countedKey = '';
    return tracker;
}

/**
 * 累计一次播放心跳（sec 秒）：
 *  - 本地时区日历天 days[YYYY-MM-DD] 与 24 小时时段 hours[h] 实时累加；
 *  - 同一首歌连续听满 30s 时记 1 次完整播放（totalPlays +1 / song.n +1），并把本次积攒的
 *    全部 pendingMs 计入该歌曲与歌手（不再丢失前 25s），后续心跳直接实时追记到歌与歌手时长；
 *  - 同步补充 cover / source / id / mid / hash / lastAt 元数据。
 *
 * @param {*} statsRaw
 * @param {TickTracker} tracker
 * @param {number} sec
 * @param {*} songData
 * @param {number} [now]
 * @returns {{ stats: PlayStatsState, tracker: TickTracker, changed: boolean }}
 */
export function applyPlayTick(statsRaw, tracker, sec, songData, now = Date.now()) {
    const st = normalizeStatsData(statsRaw);
    if (!songData || typeof songData !== 'object') {
        return { stats: st, tracker, changed: false };
    }
    const rawSec = Number(sec);
    if (!Number.isFinite(rawSec) || rawSec <= 0 || rawSec >= 60) {
        return { stats: st, tracker, changed: false };
    }

    const ms = Math.round(rawSec * 1000);
    if (ms <= 0) return { stats: st, tracker, changed: false };

    const songKey = `${String(songData.source || '')}:${String(songData.id || songData.mid || songData.hash || songSignature(songData.title || songData.song, songData.artist || songData.singer))}`;
    const title = String(songData.title || songData.song || '未知歌曲');
    const artist = String(songData.artist || songData.singer || '');
    const cover = String(songData.cover || '');
    const source = String(songData.source || '');
    const id = String(songData.id || '');
    const mid = String(songData.mid || '');
    const hash = String(songData.hash || '');
    const artistKey = artist || '未知';

    const dt = new Date(now);
    const dayKey = localDayKey(now);
    const hour = Math.max(0, Math.min(23, dt.getHours()));

    st.totalMs += ms;
    st.days[dayKey] = (st.days[dayKey] ?? 0) + ms;
    st.hours[hour] = (st.hours[hour] ?? 0) + ms;
    if (!st.firstAt || now < st.firstAt) st.firstAt = now;

    if (tracker.activeKey !== songKey) {
        tracker.activeKey = songKey;
        tracker.pendingMs = 0;
        tracker.countedKey = '';
    }

    const ensureSong = () => {
        if (!st.songs[songKey]) {
            st.songs[songKey] = {
                title,
                artist,
                n: 0,
                ms: 0,
                cover,
                source,
                id,
                mid,
                hash,
                firstAt: now,
                lastAt: now,
            };
        }
        const entry = /** @type {SongStatEntry} */ (st.songs[songKey]);
        if (title) entry.title = title;
        if (artist) entry.artist = artist;
        if (cover) entry.cover = cover;
        if (source) entry.source = source;
        if (id) entry.id = id;
        if (mid) entry.mid = mid;
        if (hash) entry.hash = hash;
        if (!entry.firstAt) entry.firstAt = now;
        entry.lastAt = now;
        return entry;
    };

    const ensureArtist = () => {
        if (!st.artists[artistKey]) {
            st.artists[artistKey] = { n: 0, ms: 0, cover, source, lastAt: now };
        }
        const entry = /** @type {ArtistStatEntry} */ (st.artists[artistKey]);
        if (cover && !entry.cover) entry.cover = cover;
        if (source && !entry.source) entry.source = source;
        entry.lastAt = now;
        return entry;
    };

    if (tracker.countedKey === songKey) {
        const sEntry = ensureSong();
        const aEntry = ensureArtist();
        sEntry.ms += ms;
        aEntry.ms += ms;
    } else {
        tracker.pendingMs += ms;
        if (tracker.pendingMs >= PLAY_COUNT_THRESHOLD_MS) {
            tracker.countedKey = songKey;
            st.totalPlays += 1;
            const sEntry = ensureSong();
            const aEntry = ensureArtist();
            sEntry.n += 1;
            sEntry.ms += tracker.pendingMs;
            aEntry.n += 1;
            aEntry.ms += tracker.pendingMs;
            tracker.pendingMs = 0;
        }
    }

    return { stats: st, tracker, changed: true };
}

/**
 * 格式化时长（中文/英文通用可读结构；短名供数字展示）。
 * @param {number} ms
 * @param {(zh: string) => string} [tx]
 * @returns {string}
 */
export function formatStatsDuration(ms, tx = (s) => s) {
    const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    if (s < 60) return `${s}${tx('秒')}`;
    const mins = Math.floor(s / 60);
    if (mins < 60) {
        const remS = s % 60;
        return remS > 0 ? `${mins}${tx('分')}${remS}${tx('秒')}` : `${mins}${tx('分')}`;
    }
    const hrs = Math.floor(mins / 60);
    const remM = mins % 60;
    return remM > 0 ? `${hrs}${tx('小时')}${remM}${tx('分')}` : `${hrs}${tx('小时')}`;
}

/**
 * 简短时长（用于卡片列表和柱状图标签）。
 * @param {number} ms
 * @param {(zh: string) => string} [tx]
 * @returns {string}
 */
export function formatCompactDuration(ms, tx = (s) => s) {
    const totalMin = Math.floor((Number(ms) || 0) / 60000);
    if (totalMin < 1) {
        const sec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
        return `${sec}${tx('秒')}`;
    }
    if (totalMin < 60) return `${totalMin}${tx('分钟')}`;
    const hrs = Math.floor(totalMin / 60);
    const rem = totalMin % 60;
    return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}${tx('小时')}`;
}

const WEEKDAY_KEYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * @param {number} hour
 * @returns {'lateNight'|'dawn'|'daylight'|'dusk'}
 */
function zoneOfHour(hour) {
    if (hour >= 5 && hour <= 8) return 'dawn';
    if (hour >= 9 && hour <= 17) return 'daylight';
    if (hour >= 18 && hour <= 22) return 'dusk';
    return 'lateNight';
}

/**
 * @param {{ lateNight: number, dawn: number, daylight: number, dusk: number }} zoneSums
 * @param {number} totalWeight
 * @param {number} peakHour
 * @param {boolean} hasAnyData
 * @param {number} totalPlays
 * @param {number} uniqueSongs
 */
function resolvePersona(zoneSums, totalWeight, peakHour, hasAnyData, totalPlays, uniqueSongs) {
    if (!hasAnyData) {
        return {
            id: 'empty',
            title: '初遇频段',
            quote: '耳机尚未开启的此刻，第一首会是谁呢',
            peakWindowId: 'dusk',
            peakWindowLabel: '傍晚时刻',
            dominantSharePct: 0,
        };
    }

    if (totalWeight <= 0 || (totalPlays === 0 && uniqueSongs === 0)) {
        return {
            id: 'prologue',
            title: '初声漫游者',
            quote: '每一段漫长的偏爱，都从第一句副歌轻轻开始',
            peakWindowId: zoneOfHour(peakHour),
            peakWindowLabel: '此刻启程',
            dominantSharePct: 100,
        };
    }

    const latePct = Math.round((zoneSums.lateNight / totalWeight) * 100);
    const dawnPct = Math.round((zoneSums.dawn / totalWeight) * 100);
    const dayPct = Math.round((zoneSums.daylight / totalWeight) * 100);
    const duskPct = Math.round((zoneSums.dusk / totalWeight) * 100);
    const peakZone = zoneOfHour(peakHour);

    if (latePct >= 30 || (peakZone === 'lateNight' && latePct >= 22)) {
        return {
            id: 'lateNight',
            title: '零点守夜人',
            quote: '夜深人静时旋律格外清晰，歌单替你留着没睡的夜晚',
            peakWindowId: 'lateNight',
            peakWindowLabel: '深夜倾听',
            dominantSharePct: Math.max(latePct, 1),
        };
    }
    if (dawnPct >= 26 || (peakZone === 'dawn' && dawnPct >= 20)) {
        return {
            id: 'dawn',
            title: '晨光拾音者',
            quote: '习惯让第一首歌比太阳更早抵达，把清晨调成喜欢的频率',
            peakWindowId: 'dawn',
            peakWindowLabel: '清晨倾听',
            dominantSharePct: Math.max(dawnPct, 1),
        };
    }
    if (duskPct >= 34 || (peakZone === 'dusk' && duskPct >= 25)) {
        return {
            id: 'dusk',
            title: '暮色收藏家',
            quote: '日落到夜灯亮起的这段时光，被你安稳地交给了耳机与旋律',
            peakWindowId: 'dusk',
            peakWindowLabel: '暮色倾听',
            dominantSharePct: Math.max(duskPct, 1),
        };
    }
    if (dayPct >= 44 || peakZone === 'daylight') {
        return {
            id: 'daylight',
            title: '光影漫游者',
            quote: '耳机把忙碌的日常与空白午后，静静剪成流动的电影胶片',
            peakWindowId: 'daylight',
            peakWindowLabel: '白昼倾听',
            dominantSharePct: Math.max(dayPct, 1),
        };
    }
    return {
        id: 'balanced',
        title: '全天候听觉旅人',
        quote: '清晨、午后与深夜都有声音相伴，旋律是你最诚实的日记',
        peakWindowId: peakZone,
        peakWindowLabel: '全天相伴',
        dominantSharePct: Math.max(latePct, dawnPct, dayPct, duskPct),
    };
}

/**
 * 构建完整的声音档案与情绪报告。
 * @param {object} [input]
 * @param {*} [input.stats]
 * @param {Array<any>} [input.recentHistory]
 * @param {Array<any>} [input.favorites]
 * @param {Record<string, any>} [input.aiThemes]
 * @param {any} [input.currentAiTheme]
 * @param {number} [input.now]
 */
export function buildStatsReport(input = {}) {
    const opts = input || {};
    const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
    const st = normalizeStatsData(opts.stats);
    const rawRecent = Array.isArray(opts.recentHistory) ? opts.recentHistory : [];
    const recent = st.resetAt > 0
        ? rawRecent.filter((r) => r && Number(r.at) >= st.resetAt)
        : rawRecent;
    const favorites = Array.isArray(opts.favorites) ? opts.favorites : [];
    const aiThemes = (opts.aiThemes && typeof opts.aiThemes === 'object') ? opts.aiThemes : {};

    /* 1. 建立收藏 / 历史签名索引，自动为旧统计数据补齐封面与收藏态 */
    /** @type {Set<string>} */
    const favKeys = new Set();
    /** @type {Set<string>} */
    const favSigs = new Set();
    /** @type {Map<string, any>} */
    const metaByKey = new Map();
    /** @type {Map<string, any>} */
    const metaBySig = new Map();

    /**
     * @param {Map<string, { cover: string, source: string, id: string, mid: string, hash: string, at: number }>} map
     * @param {string} key
     * @param {any} item
     */
    const absorbMeta = (map, key, item) => {
        if (!key || !item || typeof item !== 'object') return;
        const cur = map.get(key) || { cover: '', source: '', id: '', mid: '', hash: '', at: 0 };
        if (!cur.cover && item.cover) cur.cover = String(item.cover);
        if (!cur.source && item.source) cur.source = String(item.source);
        if (!cur.id && item.id) cur.id = String(item.id);
        if (!cur.mid && item.mid) cur.mid = String(item.mid);
        if (!cur.hash && item.hash) cur.hash = String(item.hash);
        if (!cur.at && item.at) cur.at = Number(item.at) || 0;
        map.set(key, cur);
    };

    for (const f of favorites) {
        if (!f || typeof f !== 'object') continue;
        const t = String(f.title || f.song || '');
        const a = String(f.artist || f.singer || '');
        const sig = songSignature(t, a);
        const k = String(f.key || (f.source && (f.id || f.mid || f.hash) ? `${f.source}:${f.id || f.mid || f.hash}` : ''));
        if (k) { favKeys.add(k); absorbMeta(metaByKey, k, f); }
        if (sig) { favSigs.add(sig); absorbMeta(metaBySig, sig, f); }
    }

    let earliestRecentAt = 0;
    for (const r of recent) {
        if (!r || typeof r !== 'object') continue;
        const at = Number(r.at) || 0;
        if (at > 0 && (!earliestRecentAt || at < earliestRecentAt)) earliestRecentAt = at;
        const t = String(r.title || r.song || '');
        const a = String(r.artist || r.singer || '');
        const sig = songSignature(t, a);
        const k = String(r.key || (r.source && (r.id || r.mid || r.hash) ? `${r.source}:${r.id || r.mid || r.hash}` : ''));
        if (k) absorbMeta(metaByKey, k, r);
        if (sig) absorbMeta(metaBySig, sig, r);
    }

    /* 2. 日历最早时间与连续天数统计 */
    const dayKeys = Object.keys(st.days).filter((k) => (st.days[k] ?? 0) > 0).sort();
    let earliestTs = st.firstAt || 0;
    if (dayKeys.length > 0) {
        const dkTs = parseLocalDayKey(/** @type {string} */ (dayKeys[0]));
        if (dkTs != null && (!earliestTs || dkTs < earliestTs)) earliestTs = dkTs;
    }
    if (earliestRecentAt > 0 && (!earliestTs || earliestRecentAt < earliestTs)) {
        earliestTs = earliestRecentAt;
    }

    const todayKey = localDayKey(now);
    const yesterdayKey = shiftLocalDayKey(todayKey, -1);
    const activeDaySet = new Set(dayKeys);
    let streakDays = 0;
    let cursor = activeDaySet.has(todayKey) ? todayKey : (activeDaySet.has(yesterdayKey) ? yesterdayKey : '');
    while (cursor && activeDaySet.has(cursor) && streakDays < 3650) {
        streakDays++;
        cursor = shiftLocalDayKey(cursor, -1);
    }

    const todayMs = st.days[todayKey] ?? 0;

    /* 3. 近 14 日节拍 + 近 7 日汇总 */
    const rhythmDays = [];
    let maxDay14Ms = 0;
    let weekMs = 0;
    let prevWeekMs = 0;
    let activeDays14 = 0;
    for (let offset = -13; offset <= 0; offset++) {
        const dk = shiftLocalDayKey(todayKey, offset);
        const ms = st.days[dk] ?? 0;
        if (ms > maxDay14Ms) maxDay14Ms = ms;
        if (ms > 0) activeDays14++;
        if (offset >= -6) weekMs += ms;
        else prevWeekMs += ms;
        const ts = parseLocalDayKey(dk) || now;
        const wd = WEEKDAY_KEYS[new Date(ts).getDay()] || '周日';
        rhythmDays.push({
            dayKey: dk,
            shortDate: dk.slice(5),
            weekdayKey: wd,
            ms,
            pct: 0,
            isToday: dk === todayKey,
            isPeak: false,
        });
    }
    for (const d of rhythmDays) {
        d.pct = maxDay14Ms > 0 ? Math.round((d.ms / maxDay14Ms) * 100) : 0;
        d.isPeak = maxDay14Ms > 0 && d.ms === maxDay14Ms;
    }

    /** @type {{ dayKey: string, shortDate: string, ms: number } | null} */
    let bestDay = null;
    for (const [dk, ms] of Object.entries(st.days)) {
        if (ms > 0 && (!bestDay || ms > bestDay.ms)) {
            bestDay = { dayKey: dk, shortDate: dk.slice(5), ms };
        }
    }

    /* 4. 24 小时听觉生物钟（优先真实分时 ms，无历史分时则由近期播放时间戳优雅估算） */
    const liveHourSum = st.hours.reduce((a, b) => a + b, 0);
    /** @type {'live'|'recent'|'none'} */
    let hourSource = 'none';
    const rawHours = new Array(24).fill(0);
    if (liveHourSum > 0) {
        hourSource = 'live';
        for (let h = 0; h < 24; h++) rawHours[h] = st.hours[h] ?? 0;
    } else if (recent.length > 0) {
        hourSource = 'recent';
        for (const r of recent) {
            const at = Number(r && r.at) || 0;
            if (at > 0) {
                const h = new Date(at).getHours();
                rawHours[h] = (rawHours[h] ?? 0) + 1;
            }
        }
    }

    let maxHourVal = 0;
    let peakHour = 21;
    let totalHourWeight = 0;
    const zoneSums = { dawn: 0, daylight: 0, dusk: 0, lateNight: 0 };
    for (let h = 0; h < 24; h++) {
        const val = rawHours[h] ?? 0;
        totalHourWeight += val;
        zoneSums[zoneOfHour(h)] += val;
        if (val > maxHourVal) {
            maxHourVal = val;
            peakHour = h;
        }
    }

    const circadianHours = rawHours.map((val, h) => ({
        hour: h,
        label: `${pad2(h)}:00`,
        ms: hourSource === 'live' ? val : 0,
        weight: val,
        pct: maxHourVal > 0 ? Math.round((val / maxHourVal) * 100) : 0,
        zone: zoneOfHour(h),
    }));

    const circadianZones = [
        { id: 'dawn', label: '清晨', range: '05–08', sharePct: totalHourWeight > 0 ? Math.round((zoneSums.dawn / totalHourWeight) * 100) : 0 },
        { id: 'daylight', label: '白昼', range: '09–17', sharePct: totalHourWeight > 0 ? Math.round((zoneSums.daylight / totalHourWeight) * 100) : 0 },
        { id: 'dusk', label: '暮色', range: '18–22', sharePct: totalHourWeight > 0 ? Math.round((zoneSums.dusk / totalHourWeight) * 100) : 0 },
        { id: 'lateNight', label: '深夜', range: '23–04', sharePct: totalHourWeight > 0 ? Math.round((zoneSums.lateNight / totalHourWeight) * 100) : 0 },
    ];

    /* 5. 歌曲与歌手排行榜 + 封面/收藏补全 */
    const rawSongs = Object.entries(st.songs)
        .map(([k, v]) => {
            const sig = songSignature(v.title, v.artist);
            const fallback = metaByKey.get(k) || (sig ? metaBySig.get(sig) : null);
            const colonIdx = k.indexOf(':');
            const keySrc = colonIdx > 0 ? k.slice(0, colonIdx) : '';
            const keyRawId = colonIdx > 0 ? k.slice(colonIdx + 1) : '';
            const cover = v.cover || (fallback && fallback.cover) || '';
            const source = v.source || (fallback && fallback.source) || (/^[a-z]+$/i.test(keySrc) ? keySrc : '');
            const rawId = v.id || (fallback && String(fallback.id || '')) || keyRawId;
            const mid = v.mid || (fallback && String(fallback.mid || '')) || (source === 'tencent' && keyRawId && !/^\d+$/.test(keyRawId) ? keyRawId : '');
            const hash = v.hash || (fallback && String(fallback.hash || '')) || (source === 'kugou' && keyRawId.length >= 24 ? keyRawId : '');
            const isFav = favKeys.has(k) || (sig ? favSigs.has(sig) : false);
            return {
                key: k,
                title: v.title || '未知歌曲',
                artist: v.artist || '未知歌手',
                cover: String(cover),
                source: String(source),
                id: rawId,
                mid,
                hash,
                n: v.n,
                ms: v.ms,
                lastAt: v.lastAt || (fallback && Number(fallback.at)) || 0,
                isFav,
                sig,
            };
        })
        .sort((a, b) => (b.n - a.n) || (b.ms - a.ms));

    const maxSongScore = rawSongs.length > 0
        ? Math.max(1, rawSongs[0]?.n || 0, Math.round((rawSongs[0]?.ms || 0) / 1000))
        : 1;
    const topSongs = rawSongs.slice(0, 8).map((s, idx) => {
        const usePlays = (rawSongs[0]?.n || 0) > 0;
        const num = usePlays ? s.n : Math.round(s.ms / 1000);
        return {
            ...s,
            rank: idx + 1,
            pctOfTop: Math.max(8, Math.round((num / maxSongScore) * 100)),
        };
    });

    /* 按歌曲索引每首歌对应的歌手头像与歌曲数 */
    /** @type {Map<string, { cover: string, source: string, count: number }>} */
    const artistExtra = new Map();
    for (const s of rawSongs) {
        const ak = s.artist || '未知歌手';
        const prev = artistExtra.get(ak) || { cover: '', source: '', count: 0 };
        prev.count += 1;
        if (!prev.cover && s.cover) prev.cover = s.cover;
        if (!prev.source && s.source) prev.source = s.source;
        artistExtra.set(ak, prev);
    }
    for (const r of recent) {
        const ak = String((r && (r.artist || r.singer)) || '');
        if (!ak) continue;
        const cur = artistExtra.get(ak);
        if (cur && !cur.cover && r.cover) cur.cover = String(r.cover);
        if (cur && !cur.source && r.source) cur.source = String(r.source);
    }

    const rawArtists = Object.entries(st.artists)
        .map(([name, v]) => {
            const extra = artistExtra.get(name);
            const cover = v.cover || (extra && extra.cover) || '';
            const source = v.source || (extra && extra.source) || '';
            return {
                name,
                n: v.n,
                ms: v.ms,
                cover: String(cover),
                source: String(source),
                songCount: (extra && extra.count) || Math.max(1, v.n > 0 ? 1 : 0),
                initial: name.trim().slice(0, 1).toUpperCase() || '♪',
            };
        })
        .sort((a, b) => (b.n - a.n) || (b.ms - a.ms));

    const maxArtistScore = rawArtists.length > 0
        ? Math.max(1, rawArtists[0]?.n || 0, Math.round((rawArtists[0]?.ms || 0) / 1000))
        : 1;
    const topArtists = rawArtists.slice(0, 6).map((a, idx) => {
        const usePlays = (rawArtists[0]?.n || 0) > 0;
        const num = usePlays ? a.n : Math.round(a.ms / 1000);
        return {
            ...a,
            rank: idx + 1,
            pctOfTop: Math.max(10, Math.round((num / maxArtistScore) * 100)),
        };
    });

    /* 6. 心头白月光 Spotlight：优先 #1 播放歌曲，次选最近播放第一首 */
    let spotlight = null;
    if (topSongs.length > 0 && topSongs[0]) {
        const s = topSongs[0];
        const sharePct = st.totalPlays > 0 && s.n > 0
            ? Math.min(100, Math.round((s.n / st.totalPlays) * 100))
            : 0;
        spotlight = {
            ...s,
            sharePct,
            fromRecent: false,
        };
    } else if (recent.length > 0 && recent[0]) {
        const r = recent[0];
        const sig = songSignature(r.title || r.song, r.artist || r.singer);
        spotlight = {
            key: String(r.key || ''),
            title: String(r.title || r.song || '未知歌曲'),
            artist: String(r.artist || r.singer || '未知歌手'),
            cover: String(r.cover || ''),
            source: String(r.source || ''),
            id: String(r.id || ''),
            mid: String(r.mid || ''),
            hash: String(r.hash || ''),
            n: 0,
            ms: st.totalMs,
            lastAt: Number(r.at) || 0,
            isFav: favKeys.has(String(r.key || '')) || (sig ? favSigs.has(sig) : false),
            sharePct: 0,
            fromRecent: true,
        };
    }

    /* 7. AI 情绪光谱与情感关键词汇聚 */
    /** @type {Map<string, number>} */
    const songWeightBySig = new Map();
    for (const s of rawSongs) {
        if (s.sig) songWeightBySig.set(s.sig, Math.max(2, s.n * 2 + 1));
    }
    for (const r of recent) {
        const sig = songSignature(r && (r.title || r.song), r && (r.artist || r.singer));
        if (sig && !songWeightBySig.has(sig)) songWeightBySig.set(sig, 1);
    }

    /** @type {Map<string, MoodSwatch>} */
    const swatchMap = new Map();
    /** @type {Map<string, EmotionWordItem>} */
    const wordMap = new Map();
    /** @type {Map<string, number>} */
    const moodCounts = new Map();
    let analyzedCount = 0;

    /** @param {string} cacheKey @param {any} theme */
    const absorbTheme = (cacheKey, theme) => {
        if (!theme || typeof theme !== 'object') return;
        analyzedCount++;
        const keySig = String(cacheKey || '').trim().toLowerCase();
        const w = songWeightBySig.get(keySig) || 1;
        const mood = String(theme.mood || theme.mood_summary || theme.vibe || '').trim();
        if (mood) moodCounts.set(mood, (moodCounts.get(mood) ?? 0) + w);

        const col = sanitizeHexColor(theme.primary_color || theme.accent_color || theme.color || '');
        if (col) {
            const songTitlePart = String(cacheKey || '').split('|')[0] || '';
            const cur = swatchMap.get(col) || { color: col, mood: mood || '情绪余韵', title: songTitlePart, weight: 0 };
            cur.weight += w;
            if (mood && cur.mood === '情绪余韵') cur.mood = mood;
            if (songTitlePart && !cur.title) cur.title = songTitlePart;
            swatchMap.set(col, cur);
        }

        const eWords = Array.isArray(theme.emotion_words) ? theme.emotion_words : [];
        for (const ew of eWords) {
            const word = typeof ew === 'string' ? ew.trim() : String((ew && ew.word) || '').trim();
            if (!word || word.length > 10) continue;
            const eCol = sanitizeHexColor((ew && typeof ew === 'object' ? ew.color : '') || col);
            const emotion = ew && typeof ew === 'object' ? String(ew.emotion || '') : '';
            const cur = wordMap.get(word) || { word, color: eCol || col, emotion, score: 0 };
            cur.score += w;
            if (!cur.color && (eCol || col)) cur.color = eCol || col;
            wordMap.set(word, cur);
        }
    };

    for (const [k, theme] of Object.entries(aiThemes)) {
        absorbTheme(k, theme);
    }
    if (analyzedCount === 0 && opts.currentAiTheme) {
        absorbTheme((spotlight && spotlight.sig) || 'current', opts.currentAiTheme);
    }

    const swatches = Array.from(swatchMap.values()).sort((a, b) => b.weight - a.weight).slice(0, 6);
    const words = Array.from(wordMap.values()).sort((a, b) => b.score - a.score).slice(0, 12);
    const topMoods = Array.from(moodCounts.entries()).sort((a, b) => b[1] - a[1]).map(([m]) => m).slice(0, 4);

    /* 8. 总览与时段人格 */
    const hasAnyData = st.totalMs > 0 || st.totalPlays > 0 || rawSongs.length > 0 || recent.length > 0;
    const companionDays = hasAnyData ? (earliestTs > 0 ? Math.max(1, daysBetweenLocalKeys(earliestTs, now) + 1) : 1) : 0;
    const firstDateLabel = earliestTs > 0
        ? (() => {
            const d = new Date(earliestTs);
            return `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
        })()
        : '';

    const personaCore = resolvePersona(
        zoneSums,
        totalHourWeight,
        peakHour,
        hasAnyData,
        st.totalPlays,
        rawSongs.length
    );

    const uniqueSongsCount = rawSongs.length || recent.length;
    const uniqueArtistsCount = rawArtists.length;
    const albumEquiv = st.totalMs >= 2400000 ? Math.floor(st.totalMs / 2400000) : 0;

    return {
        overview: {
            hasAnyData,
            companionDays,
            firstDateLabel,
            totalPlays: st.totalPlays,
            totalMs: st.totalMs,
            uniqueSongs: uniqueSongsCount,
            uniqueArtists: uniqueArtistsCount,
            favoriteCount: favorites.length,
            albumEquiv,
            streakDays,
            activeDays: activeDaySet.size,
            todayMs,
            weekMs,
            prevWeekMs,
        },
        persona: {
            ...personaCore,
            peakHour,
            peakRangeLabel: `${pad2(peakHour)}:00`,
            hourSource,
        },
        spotlight,
        circadian: {
            hours: circadianHours,
            zones: circadianZones,
            maxHourVal,
            peakHour,
            hourSource,
        },
        moodSpectrum: {
            analyzedCount,
            dominantColor: swatches[0] ? swatches[0].color : '',
            secondaryColor: swatches[1] ? swatches[1].color : (swatches[0] ? swatches[0].color : ''),
            dominantMood: topMoods[0] || '',
            topMoods,
            swatches,
            words,
        },
        rhythm14: {
            days: rhythmDays,
            maxDayMs: maxDay14Ms,
            bestDay,
            streakDays,
            weekMs,
            activeDays14,
        },
        topSongs,
        topArtists,
    };
}
