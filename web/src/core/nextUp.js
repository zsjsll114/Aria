/* ============================================================
 * core/nextUp.js — 「下一首预告 + 一键否决」判定层（todos #5）
 *
 * 纯函数：无 DOM、无全局、无随机、无时钟。渲染与事件全在 app/289-next-up.js。
 *
 * ★ 为什么判定必须抽出来单独测：
 *   「接下来播哪首」的权威实现散在两处 —— `app/95-track-loading.js` 的
 *   `_stepTrack(+1)`（`ended` → `nextTrack()` 真正走的那条）与
 *   `app/175-track-index-online.js` 的 `getNextTrackIndex()`（预加载走的那条）。
 *   本文件逐条镜像它们的语义（loop=重播当前、random=重抽一首不同的、
 *   sequence=+1 取模），任何一条不一致都会变成「预告了 A、实际播了 B」。
 *   那两个分片的切歌语义若被改动，必须回来同步本文件 + tests/js/test_next_up.js。
 *
 * ★ 随机模式刻意不报具体歌名（kind='random'、index=-1、track=null）：
 *   `_stepTrack` 在 random 下是**当场**摇一次，我们预摇的那一首和真正播的那一首
 *   几乎必然不同 —— 宁可不报名，也不报错。用户点否决时给的是确定候选列表，
 *   选了就直接 `loadPlaylistTrack(index)`，那条路反而比自动切歌更准。
 *
 * ★ 候选列表是确定性轮转（从当前索引往后数），不用随机：
 *   「给出候选，不是随机」是需求原话，而且确定性才可能断言。
 * ============================================================ */

/** 用户偏好默认值（挂在 appSettings.interface.nextUp 下，见 AGENTS 约束 11） */
export const NEXTUP_DEFAULTS = { enabled: true, leadSeconds: 5 };
export const LEAD_MIN_SECONDS = 3;
export const LEAD_MAX_SECONDS = 15;
/** 候选最多列几首：再多面板就高出屏幕了（面板本身还会滚动兜底） */
export const MAX_CANDIDATES = 6;
/** 只剩这么点就不值得浮出：一闪而过的残影比不浮更糟。已浮出时不受此限（迟滞） */
export const MIN_REMAINING_SEC = 1.2;

export const PLAY_MODES = ['sequence', 'loop', 'random'];

/** 预告的三种语义。TRACK 才报歌名；REPLAY 报的是当前歌（因为播的就是它）；RANDOM 不报 */
export const KIND = { TRACK: 'track', REPLAY: 'replay', RANDOM: 'random' };

/** 不显示的原因（给日志/诊断用，不参与样式；避免「为什么没弹」变成玄学） */
export const REASON = {
    OFF: 'off',
    SUPPRESSED: 'suppressed',
    NOT_PLAYING: 'not-playing',
    EMPTY_QUEUE: 'empty-queue',
    NO_DURATION: 'no-duration',
    TOO_EARLY: 'too-early',
    TOO_LATE: 'too-late',
    ENDED: 'ended',
    NO_CHOICE: 'no-choice',
    SONG_CHANGED: 'song-changed',
};

/** 渲染层要做的动作 */
export const ACTION = {
    SHOW: 'show',       /* 首次浮出（播放入场动画） */
    REFRESH: 'refresh', /* 同一首歌但预测变了（改播放模式 / 动了队列）→ 原地改内容 */
    KEEP: 'keep',       /* 什么都不用做（只剩剩余秒数在变，由渲染层自己刷文本） */
    HIDE: 'hide',       /* 撤回预告 */
};

/* ---------- 小工具：把外部传进来的乱七八糟值收敛成可用值 ---------- */

function toFinite(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function positiveFinite(v) {
    const n = toFinite(v);
    return n !== null && n > 0 ? n : null;
}

function nonNegativeFinite(v) {
    const n = toFinite(v);
    return n !== null && n >= 0 ? n : null;
}

/** null / undefined / 空串 / 非数字 = 「没设过」，一律回退默认；越界的数字才夹紧 */
export function normalizeLeadSeconds(raw, fallback = NEXTUP_DEFAULTS.leadSeconds) {
    if (raw === null || raw === undefined || raw === '') return fallback;
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(LEAD_MIN_SECONDS, Math.min(LEAD_MAX_SECONDS, n));
}

/** 偏好归一：缺省=开（与 282 专注模式同一口径，不写进 defaults.js 也能生效） */
export function normalizeNextUpPrefs(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
        enabled: src.enabled !== false,
        leadSeconds: normalizeLeadSeconds(src.leadSeconds, NEXTUP_DEFAULTS.leadSeconds),
    };
}

/* ---------- 队列条目的字段名不统一（title/song/name、artist/singer） ---------- */

export function trackTitle(entry) {
    if (!entry || typeof entry !== 'object') return '';
    return String(entry.title || entry.song || entry.name || '');
}

export function trackArtist(entry) {
    if (!entry || typeof entry !== 'object') return '';
    return String(entry.artist || entry.singer || '');
}

export function trackCover(entry) {
    if (!entry || typeof entry !== 'object') return '';
    return String(entry.cover || entry.pic || '');
}

/** 能不能直接播：在线条目要有 source+id，本地条目要有 url（与 loadPlaylistTrack 的两个分支一致） */
export function isPlayableTrack(entry) {
    if (!entry || typeof entry !== 'object') return false;
    const hasOnline = !!(entry.source && (entry.id || entry.mid));
    return hasOnline || !!entry.url;
}

function describeEntry(playlist, index) {
    const entry = playlist[index];
    return {
        index,
        title: trackTitle(entry) || '未知歌曲',
        artist: trackArtist(entry),
        cover: trackCover(entry),
        entry,
    };
}

/* ---------- 下一首是谁（镜像 _stepTrack(+1) / getNextTrackIndex） ---------- */

/**
 * @param {{length:number, currentIndex:number, playMode:string}} ctx
 * @returns {{kind:string, index:number}} index=-1 表示「不可预知」（随机 / 空队列）
 */
export function pickNext(ctx = {}) {
    const len = Number(ctx.length) || 0;
    const currentIndex = Number(ctx.currentIndex);
    const playMode = PLAY_MODES.indexOf(ctx.playMode) >= 0 ? ctx.playMode : 'sequence';
    if (!len || !Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= len) {
        /* 空队列时 95 会去 fetchAndPlayRandomSong()：播的根本不是队列里的歌，不能报名 */
        return { kind: KIND.RANDOM, index: -1 };
    }
    if (playMode === 'loop') return { kind: KIND.REPLAY, index: currentIndex };
    if (playMode === 'random') {
        if (len === 1) return { kind: KIND.REPLAY, index: currentIndex };
        return { kind: KIND.RANDOM, index: -1 };
    }
    const idx = (currentIndex + 1) % len;
    /* 队列只有一首时 (0+1)%1 === 0：语义上就是「再播一遍这一首」 */
    if (idx === currentIndex) return { kind: KIND.REPLAY, index: currentIndex };
    return { kind: KIND.TRACK, index: idx };
}

/**
 * 否决候选：从当前索引往后确定性轮转，跳过「正在播的」与「默认要播的那首」
 * （那两首不需要出现在候选里：一个是自己，一个是「不点就会播的」）。
 * @returns {{index:number,title:string,artist:string,cover:string,entry:Object}[]}
 */
export function buildCandidates(opts = {}) {
    const playlist = Array.isArray(opts.playlist) ? opts.playlist : [];
    const len = playlist.length;
    if (!len) return [];
    const rawCur = Number(opts.currentIndex);
    const currentIndex = Number.isInteger(rawCur) && rawCur >= 0 && rawCur < len ? rawCur : -1;
    const predicted = Number(opts.predictedIndex);
    const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : MAX_CANDIDATES;
    const from = currentIndex >= 0 ? currentIndex : -1;
    const out = [];
    for (let step = 1; step <= len && out.length < limit; step++) {
        const idx = ((from + step) % len + len) % len;
        if (idx === currentIndex) continue;
        if (idx === predicted) continue;
        if (!isPlayableTrack(playlist[idx])) continue;
        out.push(describeEntry(playlist, idx));
    }
    return out;
}

/**
 * 同一首歌的身份证：代际 + 队列索引 + 音频源。
 * 三者任一变化都说明「已经不是刚才那首」，预告必须作废（AGENTS todos #5 要求 3）。
 * 带上 src 是防有人新增一条不递增 playbackGeneration 的切歌路径。
 */
export function songSignature(snapshot = {}) {
    const gen = toFinite(snapshot.generation);
    const idx = toFinite(snapshot.currentIndex);
    const src = typeof snapshot.src === 'string' ? snapshot.src : '';
    return `${gen === null ? -1 : gen}|${idx === null ? -1 : idx}|${src}`;
}

/* ---------- 主判定 ---------- */

function notShown(decision, reason) {
    decision.show = false;
    decision.reason = reason;
    return decision;
}

/**
 * 一帧的完整判定。
 * @param {Object} snapshot
 * @param {Array}  snapshot.playlist        当前播放队列（state.playlist）
 * @param {number} snapshot.currentIndex      当前索引（state.currentTrackIndex）
 * @param {string} snapshot.playMode         'sequence' | 'loop' | 'random'
 * @param {number} snapshot.durationSec      audio.duration
 * @param {number} snapshot.currentTimeSec   audio.currentTime
 * @param {boolean} snapshot.isPlaying       是否正在播（非暂停/非结束）
 * @param {boolean} snapshot.suppressed      专注模式 / 被系统接管 / 正在加载 / 有弹窗挡路
 * @param {Object} snapshot.prefs            { enabled, leadSeconds }
 * @param {boolean} snapshot.alreadyRevealed 预告条当前是否已浮出（迟滞判定用）
 * @param {number} snapshot.generation       playbackGeneration
 * @param {string} snapshot.src              audio.currentSrc
 */
export function resolveNextUp(snapshot = {}) {
    const playlist = Array.isArray(snapshot.playlist) ? snapshot.playlist : [];
    const len = playlist.length;
    const prefs = normalizeNextUpPrefs(snapshot.prefs);
    const rawIdx = Number(snapshot.currentIndex);
    const currentIndex = (Number.isInteger(rawIdx) && rawIdx >= 0 && rawIdx < len)
        ? rawIdx : (len > 0 ? 0 : -1);
    const playMode = PLAY_MODES.indexOf(snapshot.playMode) >= 0 ? snapshot.playMode : 'sequence';

    const durationSec = positiveFinite(snapshot.durationSec);
    const currentTimeSec = nonNegativeFinite(snapshot.currentTimeSec);
    const remainingSec = (durationSec !== null && currentTimeSec !== null)
        ? Math.max(0, durationSec - currentTimeSec) : null;

    const next = pickNext({ length: len, currentIndex, playMode });
    const track = next.index >= 0 && next.index < len ? playlist[next.index] : null;
    const wraps = next.kind === KIND.TRACK && len > 1 && next.index === 0 && currentIndex === len - 1;

    const decision = {
        show: false,
        reason: '',
        kind: next.kind,
        index: next.index,
        currentIndex,
        playMode,
        track: track || null,
        title: track ? (trackTitle(track) || '未知歌曲') : '',
        artist: track ? trackArtist(track) : '',
        cover: track ? trackCover(track) : '',
        wraps,
        remainingSec,
        durationSec,
        leadSeconds: prefs.leadSeconds,
        candidates: [],
        clickable: false,
        /* 只有 TRACK 才有「报出来的那一首」；REPLAY 报的是当前歌，RANDOM 什么都不报 */
        namesSong: next.kind === KIND.TRACK || next.kind === KIND.REPLAY,
        key: '',
        signature: songSignature(snapshot),
    };

    if (!prefs.enabled) return notShown(decision, REASON.OFF);
    if (snapshot.suppressed) return notShown(decision, REASON.SUPPRESSED);
    if (snapshot.isPlaying !== true) return notShown(decision, REASON.NOT_PLAYING);
    if (!len) return notShown(decision, REASON.EMPTY_QUEUE);
    if (remainingSec === null) return notShown(decision, REASON.NO_DURATION);
    if (remainingSec <= 0) return notShown(decision, REASON.ENDED);
    if (remainingSec > prefs.leadSeconds) return notShown(decision, REASON.TOO_EARLY);
    /* 迟滞：已经浮出的条一直留到切歌；还没浮出的、只剩 1 秒出头的就别闪一下了 */
    if (!snapshot.alreadyRevealed && remainingSec < MIN_REMAINING_SEC) return notShown(decision, REASON.TOO_LATE);

    decision.candidates = buildCandidates({
        playlist,
        currentIndex,
        predictedIndex: next.index,
        limit: MAX_CANDIDATES,
    });
    decision.clickable = decision.candidates.length > 0;

    /* 没有任何可换的对象时，「一键否决」这个承诺就落空了：
       TRACK 仍然值得显示（「接下来播 X」本身就是信息），其它两种不值得。 */
    if (!decision.clickable && decision.kind !== KIND.TRACK) return notShown(decision, REASON.NO_CHOICE);

    decision.show = true;
    decision.key = `${decision.kind}:${decision.index}:${decision.clickable ? 1 : 0}`;
    return decision;
}

/**
 * 渲染层唯一的入口：把「当前是否已浮出」并进快照，返回该做什么。
 * @param {Object} snapshot resolveNextUp 的入参 + `revealed: { key, signature } | null`
 */
export function evaluateNextUp(snapshot = {}) {
    const revealed = snapshot.revealed && typeof snapshot.revealed === 'object' ? snapshot.revealed : null;
    const decision = resolveNextUp({ ...snapshot, alreadyRevealed: !!revealed });
    if (!decision.show) return { action: ACTION.HIDE, decision, reason: decision.reason };
    if (!revealed) return { action: ACTION.SHOW, decision, reason: '' };
    /* 换歌了（代际/索引/音源任一变了）→ 必须先撤回旧预告，再按新歌重新判定 */
    if (revealed.signature && revealed.signature !== decision.signature) {
        return { action: ACTION.HIDE, decision, reason: REASON.SONG_CHANGED };
    }
    if (revealed.key !== decision.key) return { action: ACTION.REFRESH, decision, reason: '' };
    return { action: ACTION.KEEP, decision, reason: '' };
}

/** 给诊断/日志用的一行摘要（不含歌词正文，只有歌名与索引，可安全落日志）。
 *  ★ 刻意全 ASCII：core 层只出日志，不出 UI 文案，别让它进 i18n 复扫的账。 */
export function describeDecision(decision) {
    if (!decision) return 'null';
    if (!decision.show) return `hide(${decision.reason})`;
    const who = decision.kind === KIND.RANDOM ? 'random-pick' : `#${decision.index + 1} ${decision.title}`;
    return `show(${decision.kind} ${who} left:${Math.ceil(decision.remainingSec || 0)}s cands:${decision.candidates.length})`;
}

export default { evaluateNextUp, resolveNextUp, buildCandidates, pickNext, normalizeNextUpPrefs };
