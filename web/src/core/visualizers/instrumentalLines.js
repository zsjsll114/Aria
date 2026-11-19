/**
 * instrumentalLines.js — 「纯音乐（无歌词）」的共享判定与虚拟 ♪ 行
 *
 * 上游出处：
 *   - 判定：`scratch/folia-fresh/src/components/visualizer/songHandover.ts` 的
 *     `decideSongCommit` + `useVisualizerSongCommit({ readyGraceMs: 3000 })`
 *   - 消费：`VisualizerSonnet.tsx:89-107`（id 前缀 `virtual-staff-`）与
 *     `VisualizerTempera.tsx:87-101`（id 前缀 `virtual-block-`）——两者除前缀外**逐字相同**。
 *
 * 语义（上游注释原话：空歌词在"还在加载"与"纯音乐"之间**只能靠播放区分**）：
 *   空歌词 + 播放已推进 ≥ 3s ⇒ 纯音乐 ⇒ **不喂歌词、喂 60 条虚拟 `♪` 行**
 *   （每 8s 一条、长 6s），于是整首都是谱面/方块分镜。本仓此前两个模式都是
 *   `setLyrics([])` / 空 program → **全黑空白**。
 *
 * ⚠ 上游那个坑（别踩）：父级在"加载中/无歌词"时**每次渲染都给一个新的 `[]`**，
 *   所以判定**绝不能**按"歌词数组引用变化"重置观察窗，否则永远等不到确认
 *   （上游为此专门写了 `getLyricsSignature`）。这里按**歌**（audio.currentSrc）重置。
 *
 * 本模块是纯逻辑（除 `instrumentalSongKey` 只读 DOM），无 Pixi 依赖，可直接单测。
 */

/** 上游 `readyGraceMs: 3000` */
export const INSTRUMENTAL_GRACE_SEC = 3;

/**
 * 上游两个 visualizer 逐字同参：60 条 / 每 8s 一条 / 长 6s。
 * 时间用**毫秒**（Aria 歌词行契约：parseLrc `min*60000+sec*1000+ms`）；
 * sonnet 侧 `sonnetProgram.normalizeTimeUnit`、tempera 侧 `normalizeTemperaLines`
 * 都会按「任一行 start ≥1000 ⇒ 整体 ÷1000」的启发式归一为秒。
 *
 * @param {string} idPrefix 上游 sonnet 用 `virtual-staff-`、tempera 用 `virtual-block-`
 */
export function buildVirtualInstrumentalLines(idPrefix, count = 60, stepSec = 8, holdSec = 6) {
    const lines = [];
    for (let i = 0; i < count; i++) {
        lines.push({
            id: `${idPrefix}${i}`,
            start: i * stepSec * 1000,
            end: (i * stepSec + holdSec) * 1000,
            original: '♪',   // sonnet 的谱面分支判定条件就是 segment.text === '♪'
            words: [],
            isChorus: false,
        });
    }
    return lines;
}

/**
 * 纯函数（无 DOM，可单测）：纯音乐判定的状态推进。
 * @param {{instrumental:boolean, watch:{songKey:string,sinceSec:number}|null}} state
 * @returns {{instrumental:boolean, watch:{songKey:string,sinceSec:number}|null}}
 */
export function advanceInstrumental(state, { hasWords, timeSec, songKey, graceSec = INSTRUMENTAL_GRACE_SEC }) {
    if (hasWords) return { instrumental: false, watch: null };
    const watch = state && state.watch && state.watch.songKey === songKey
        ? state.watch
        : { songKey, sinceSec: timeSec };
    return { instrumental: timeSec - watch.sinceSec >= graceSec, watch };
}

/**
 * `♪` 谱面分镜的判定。
 *
 * 上游在两处写死 `segment.text === '♪'`（`sonnetTextViewBuilder.ts:198` 建视图、
 * `sonnetSceneBuilder.ts:236` 每镜去重）。**默认行为与上游逐字一致**。
 *
 * ★ 2026-10-11 Aria 扩展（默认关，用户显式打开才生效）：把常见**间奏标记**也当谱面行。
 *   触发场景很常见：很多音源把间奏标成 `MUSIC` / `MUSIC-`，纯点号行（`…` / `...` / `···`）
 *   也常被用来表示"这里没人唱"。上游只认 `♪` ⇒ 这些行会被当普通歌词渲染成巨字分镜
 *   （用户 2026-10-11 的报障原话就是这个：截图里那行竖排 `MUSIC-`）。
 *   标记集合写死在代码里（没有"用户可编辑列表"）：选项只有一个开关，语义清晰、可单测。
 */
const INTERLUDE_WORDS = new Set(['MUSIC', 'INSTRUMENTAL', 'INTERLUDE', 'OFFVOCAL', '間奏', '间奏']);
/** 纯「点/音符/连接符」行：`…`、`...`、`···`、`♪♪`、`—` 这一类 */
const MARKER_ONLY_RE = /^[\s♪·・….⋯\-—–_~＊*]+$/u;
const MARKER_CHARS_RE = /[\s♪·・….\-—–_~＊*]/gu;

export function isSonnetStaffSegment(text, interludeMarkers = false) {
    const raw = typeof text === 'string' ? text : '';
    if (raw === '♪') return true;                // 上游默认：永远生效
    if (interludeMarkers !== true) return false; // 扩展默认关 ⇒ 与上游逐字一致
    if (MARKER_ONLY_RE.test(raw)) return true;   // 纯点号/纯音符行
    /* 去掉两侧装饰后按词判定：`MUSIC-`、`♪ MUSIC ♪` → MUSIC */
    const squashed = raw.trim().toUpperCase().replace(MARKER_CHARS_RE, '');
    return squashed.length > 0 && INTERLUDE_WORDS.has(squashed);
}

/** 当前歌曲身份（观察窗按它重置）：换歌时 audio.currentSrc 必变。 */
export function instrumentalSongKey() {
    try {
        const audio = document.getElementById('audioPlayer');
        return (audio && (audio.currentSrc || audio.src)) || '';
    } catch { return ''; }
}
