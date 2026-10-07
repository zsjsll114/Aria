/* ============================================================
 * jizuraBridge.js — 「字面 · Jizura」引擎与 Aria 之间的适配层
 *
 * 职责（四件，全是"翻译"而不是渲染）：
 *   ① 引擎单例：JIZURA 的加载期副作用（CORE_ORDER 快照 / 11q_sets 的集合标记 /
 *      08b 的 mood tags）**只能跑一次**，重复实例化会让抽签结果漂移 → 这里做进程内单例。
 *   ② 歌词与时间：Aria 的 `lines[]`（**带真实时间戳**）→ 上游 `project`
 *      的 `lyrics` 文本 + `timing.lineTimes`。★ 上游 lineTimes 是**按行索引的秒数**、
 *      手填值优先于 LRC 标签（08_planner.js:214），所以索引必须与解析出的行一一对应
 *      ——见 cleanJizuraLines 的空行过滤（不同步就是全篇错位）。
 *   ③ 性能档：Aria 的 perf-* / 软件渲染 → 引擎的 `fast`（关 ctx.filter 与 ghost 色差）。
 *   ④ MV 背景：Aria 的 `body.mv-bg-on` → 引擎的 `opt.transparent`（不铺自己的底），
 *      让 MV 从文字后面透出来。
 *
 * ⚠ 引擎本体在 `web/src/vendor/jizura/engine/`（第三方移植源码，MIT © 2026 hakoniwa，
 *   见 THIRD_PARTY_NOTICES.md）。那里**一行都不改**：搬运脚本 scripts/port-jizura.mjs
 *   会用"逐字节比对"守住这条线。本文件是唯一允许写适配逻辑的地方。
 * ============================================================ */
import { logCatch, logInfo } from '../../../services/log.js';

export const JIZURA_TAG = 'jizura';

/** 上游默认风格（J.STYLE_ORDER[0]，27 套里的第一套） */
export const JIZURA_DEFAULT_STYLE = 'noir';

let _enginePromise = null;

/**
 * 取引擎单例（首次调用才加载 vendor 里的 39 个文件）。
 * ★ 单例不是省事，是**正确性要求**：`11q_sets.js` 与 `08b_omakase.js` 在加载期给
 *   部件表打标记，二次实例化会重复追加。
 * @returns {Promise<object|null>} J（失败返回 null，不抛 —— 调用方按"本帧不画"处理）
 */
export function getJizuraEngine() {
    if (!_enginePromise) {
        _enginePromise = import('../../../vendor/jizura/engine/bootstrap.js')
            .then((m) => {
                const J = m.createJizuraEngine();
                const total = (J.GROUP_KEYS || []).reduce((n, g) => n + (J.order(g) || []).length, 0);
                logInfo(JIZURA_TAG, `引擎就绪 v${m.JIZURA_ENGINE_VERSION}：风格 ${(J.STYLE_ORDER || []).length} 套 / 部件 ${total}`);
                return J;
            })
            .catch((e) => {
                logCatch(JIZURA_TAG, e);
                _enginePromise = null;   /* 允许下次重试（例如首次加载时代码还没就绪） */
                return null;
            });
    }
    return _enginePromise;
}

/**
 * 过滤出"有内容"的行。
 * ★ 为什么必须过滤：上游会**自己再解析一遍**我们给的 `lyrics` 文本，而
 *   `timing.lineTimes[i]` 是按**行索引**取值的。空行被上游解析器丢掉、
 *   而我们的时间数组没丢 → 从那一行起**整篇错位**。
 *   所以文本与时间必须由**同一个过滤后的数组**生成（下面的两个函数都走这里）。
 */
export function cleanJizuraLines(lines) {
    return (Array.isArray(lines) ? lines : []).filter((l) => {
        if (!l) return false;
        const text = String(l.original !== undefined && l.original !== null ? l.original : (l.text || ''));
        return text.trim().length > 0;
    });
}

/** 行文本（优先原文，其次译文占位；保持行序） */
export function lyricsTextFromLines(lines) {
    return cleanJizuraLines(lines)
        .map((l) => String(l.original !== undefined && l.original !== null ? l.original : (l.text || '')).trim())
        .join('\n');
}

/**
 * 行起始时间（**秒**，按行索引）。
 * @returns {number[]} 与 cleanJizuraLines 同序同长
 */
export function lineTimesFromLines(lines) {
    return cleanJizuraLines(lines).map((l) => {
        const ms = l.start !== undefined && l.start !== null ? l.start
            : (l.time !== undefined && l.time !== null ? l.time : 0);
        const sec = Number(ms) / 1000;
        return Number.isFinite(sec) && sec > 0 ? sec : 0;
    });
}

/**
 * 行尾时间（**秒**，按行索引；拿不到的行给 null）。
 * ★ 为什么必须给：上游只认行首（`timing.lineTimes`），行尾是推出来的 —— 非末行取
 *   下一行起点，**末行按字数估**（`clamp(0.8 + n*0.17, 1.5, 5.2)`，10 字 → 2.5s）。
 *   实测后果：一行 `1.0 → 5.0s` 的歌，引擎认为它 3.5s 就结束，逐字切点被它压成
 *   0.22s 的等距网格（同步全废）。这条通道由 port-jizura.mjs 的第 2 条补丁开出。
 */
export function lineEndsFromLines(lines) {
    const clean = cleanJizuraLines(lines);
    const starts = lineTimesFromLines(lines);
    return clean.map((l, i) => {
        const raw = Number(l && l.end);
        if (!Number.isFinite(raw) || raw <= 0) return null;
        let sec = raw / 1000;
        /* 防御：行尾不该越过下一行的起点（元数据写错时会把尾块的切点摊到下一行上） */
        const next = starts[i + 1];
        if (Number.isFinite(next) && next > 0 && sec > next) sec = next;
        return sec > (starts[i] || 0) ? sec : null;
    });
}

/**
 * 用 Aria 的歌词与设置造一份上游 `plan`（分镜/卡点/部件抽签的结果）。
 * @param {object} J 引擎
 * @param {Array} lines Aria 歌词行（带 start/end）
 * @param {{style?:string, mood?:string|null, aspect?:string, res?:number, fps?:number,
 *          title?:string, artist?:string, fx?:object, analyses?:object|null}} [opts]
 * @returns {object} plan（失败抛错，由调用方 catch）
 */
/**
 * 由文本派生确定性 32 位种子（djb2 + xor）。
 * 用途见 buildJizuraPlan 的 'auto' 分支。
 */
export function textSeed(text) {
    const s = String(text || '');
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = (((h * 33) ^ s.charCodeAt(i)) >>> 0);
    return h >>> 0;
}

/**
 * mulberry32：小巧的确定性 PRNG，喂给上游 `J.omakase(project, rnd, themeId)` 的 rnd。
 * @param {number} seed
 * @returns {() => number} 0~1
 */
export function seededRandom(seed) {
    let a = ((seed >>> 0) || 1) >>> 0;
    return function next() {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * 归一化 BPM。引擎只在 `timing.bpm > 0` 时启用**匀速卡点网格**（08_planner.js:215
 * `beat = T.bpm > 0 ? 60 / T.bpm : 0`），所以不合理值必须回 0 = 交给引擎自己估，
 * 而不是把 999 这种值喂进去让分镜乱跳。
 * 30~300 覆盖了从慢板到 Drum'n'Bass 的常识区间。
 */
export function normalizeBpm(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 30 || n > 300) return 0;
    return n;
}

export function buildJizuraPlan(J, lines, opts = {}) {
    const base = J.defaultProject();
    const clean = cleanJizuraLines(lines);
    if (clean.length === 0) return null;
    const project = Object.assign({}, base, {
        title: opts.title || '',
        artist: opts.artist || '',
        lyrics: lyricsTextFromLines(lines),
        /* style 是上游挑版式的键；mood 走おまかせ（P2 再接 J.omakase 的主题），
           P1 先只吃显式 style —— 未给就用上游默认 'noir'。 */
        style: opts.style || base.style || JIZURA_DEFAULT_STYLE,
        mood: opts.mood || null,
        aspect: opts.aspect || base.aspect,
        /* ★ 刻意不转发 opts.res：引擎从不读 project.res（画幅由 aspect 决定，
           见 08_planner.js:283 → J.designSize(aspect)，按 aspect 返回硬编码尺寸）。
           留着它只会让人以为"改分辨率有用" —— 已经因此撤掉过一个面板项（2026-10-07）。 */
        fps: opts.fps || base.fps,
        timing: Object.assign({}, base.timing, {
            lineTimes: lineTimesFromLines(lines),
            /* ★ 行尾通道只在"按字切分镜"开着时才给：默认 off 时让引擎完全走它自己的推导，
               与打这两条补丁之前**行为一致**。用户要的"改回去"必须连这条一起还原 ——
               否则只是把切分镜关了，行的可见时长仍被我们改过。 */
            lineEnds: (opts.wordSync && opts.wordSync !== 'off') ? lineEndsFromLines(lines) : undefined,
            /* ★ 真实 BPM（若已缓存）：引擎的匀速卡点网格建在它上面。
               没有就保持 0，引擎按歌词行距自估 —— 不编数据。 */
            bpm: normalizeBpm(opts.bpm),
        }),
    });
    if (opts.fx) project.fx = Object.assign({}, base.fx, opts.fx);
    /* 逐字跟唱的注入点：per-line 覆盖（cuts 块数 + cutTime 切点，见上面 computeWordSyncOverrides） */
    if (opts.overrides && Object.keys(opts.overrides).length) {
        project.overrides = Object.assign({}, base.overrides, opts.overrides);
    }
    /* 'auto' = 上游おまかせ：按歌词长度/情绪从 27 套里抽一套版式（并顺带挑主题与部件开关）。
       一律走 J.omakase 而不是自己抽签 —— 它的抽取要考虑"哪些部件属于同一套语言"，
       自己随机出来的组合会在观感上互相打架（例如活字版式配霓虹描边）。 */
    if (opts.style === 'auto' && typeof J.omakase === 'function') {
        /* ★ 种子取自「歌名|歌手|歌词」而不是 Math.random（上游默认）：
           实测这条链上每次 plan 重建（改任何设置、切画幅、重载歌词）都会重抽一次，
           用随机数就会"改个字号整首曲子的版式全换"——那不是抽签，是抽风。
           同歌同种子 ⇒ 同一个观感，且换歌自然换风格。 */
        const seed = textSeed(`${project.title}|${project.artist}|${project.lyrics}`.slice(0, 4096));
        const picked = J.omakase(project, seededRandom(seed), opts.theme || null);
        return J.plan(picked || project, opts.analyses || null);
    }
    return J.plan(project, opts.analyses || null);
}

/**
 * plan 的"需要重建"指纹。
 * ★ 不用 `JSON.stringify(lines)`：歌词几百行时每帧做一次是纯浪费。
 *   用"行数 + 首末时间 + 影响分镜的设置"，切歌/改设置时会变，同一首歌内恒定。
 */
export function jizuraPlanKey(lines, opts = {}) {
    const clean = cleanJizuraLines(lines);
    if (clean.length === 0) return 'empty';
    const times = lineTimesFromLines(lines);
    return [
        clean.length,
        times[0],
        times[times.length - 1],
        opts.style || '',
        opts.mood || '',
        opts.aspect || '',
        opts.res || '',
        opts.fps || '',
        /* BPM 参与指纹：分析结果晚到时（缓存命中）必须重建，否则卡点网格还停在自估那套 */
        normalizeBpm(opts.bpm),
        /* 逐字同步开关 + 真实逐字的行数：对齐结果晚到时（异步回填）必须重建 */
        opts.wordSync || 'off',
        opts.beat || 'every',
        realWordLineCount(lines),
        lyricsTextFromLines(lines).length,
    ].join('|');
}

/**
 * 性能档 → 渲染选项（**纯函数**，便于单测）。
 * `fast` 会关掉引擎里最贵的两样：`ctx.filter` 滤镜链（09_render.js:70）与
 * ghost 色差通道（:131）——低配/软件渲染下这两项决定能不能守住帧率。
 * `transparent` 让引擎不铺自己的底色，交给 MV 背景透出来。
 * @param {{softwareRenderer?:boolean, minimal?:boolean, low?:boolean, mvOn?:boolean}} flags
 * @returns {{fast:boolean, transparent:boolean}}
 */
export function perfOptionsFor(flags = {}) {
    const minimal = !!flags.minimal || !!flags.softwareRenderer;
    const fast = minimal || !!flags.low;
    return { fast, transparent: !!flags.mvOn };
}

/* ============================================================
 * 逐字跟唱：把 Aria 的真实字时间折算成引擎的分镜切点
 * ============================================================
 * ★ 先认清上游能做到哪一步（2026-10-06 取证，别高估）：
 *   · 引擎**没有**任何"逐字时间"字段，逐字出现是 `i/(n-1)` 均分
 *     （05_anim.js:74-82 的打字机、11p_enter.js:20-22 的错开函数）；
 *   · 唯一能在**不改上游源码**的前提下注入时间的是 `project.overrides[li]`：
 *       - `ov.cuts = k` 把该行强制切成 k 块（08_planner.js:364，上限 12 块）；
 *       - `ov.cutTime[j]` = 第 j 块**相对行首的秒**（08_planner.js:387-391），
 *         引擎会 clamp 进 [前一块+0.22, …] 保序。
 *   ⇒ 所以我们的"逐字跟唱"是**块级**：每块的**开始时刻**对齐真实唱到的音节，
 *     块内若干字仍是均分。一行 5 个字 → 5 块 = 实际就是逐字；一行 20 个字 → 12 块。
 *     这就是"零改动 + 真实同步"的边界，写成注释免得以后有人以为还能更细。
 * ============================================================ */

/** 块级模式的上限（上游原本就是 12 块，分镜不会被切碎，但一行最多对齐 12 个音节） */
export const WORD_SYNC_MAX_CUTS = 12;
/**
 * 逐字模式的上限。★ 与上游补丁一致（`scripts/port-jizura.mjs` 的 PATCHES 把
 * 08_planner.js:364 的 12 放宽到 64）——两边不同步会让"每字一块"在上游被悄悄夹回 12。
 */
export const WORD_SYNC_MAX_CUTS_CHARS = 64;
/** 上游的块间最小间隔（08_planner.js:390 的保序 0.22s） */
export const WORD_SYNC_MIN_GAP = 0.22;

/**
 * 该行有没有**真实**逐字时间。
 * ★ 合成值（`wordTiming === 'synthesized'`，见 parsers/wordTiming.js）是按行时长
 *   加权均分出来的**近似值**——引擎本来就在做同类均分，喂进去等于没喂，
 *   所以这里必须把它挡掉，否则会让人误以为"接了逐字却没效果"。
 */
export function hasRealWords(line) {
    if (!line || !Array.isArray(line.words) || line.words.length < 2) return false;
    if (line.wordTiming === 'synthesized') return false;
    for (const w of line.words) {
        if (!w || !Number.isFinite(Number(w && w.start))) return false;
    }
    return true;
}

/** 有多少行带真实逐字（进 plan 指纹用：对齐结果晚到时必须重建） */
export function realWordLineCount(lines) {
    return cleanJizuraLines(lines).reduce((n, l) => n + (hasRealWords(l) ? 1 : 0), 0);
}

/**
 * 为每行算 `project.overrides[li]`（只有带真实逐字的行才有）。
 * @param {Array} lines Aria 歌词行（可含 words:[{text,start,end}]，ms）
 * @param {{mode?:'cuts'|'chars', maxCuts?:number, minGap?:number}} [opts]
 *        mode='cuts'（默认）一行最多 12 块、分镜不会被切碎；'chars' 一行可到 64 块，
 *        短行下**每字一块**，此时块内只有一个字 → 引擎自己的均分 reveal 就是精确的逐字。
 * @returns {Object<number,{cuts:number,cutTime:number[]}>} 行索引 → 覆盖项
 */
export function computeWordSyncOverrides(lines, opts = {}) {
    const mode = opts.mode === 'chars' ? 'chars' : 'cuts';
    const hardCap = mode === 'chars' ? WORD_SYNC_MAX_CUTS_CHARS : WORD_SYNC_MAX_CUTS;
    const maxCuts = Math.max(2, Math.min(WORD_SYNC_MAX_CUTS_CHARS, opts.maxCuts || hardCap));
    const minGap = Number.isFinite(opts.minGap) && opts.minGap > 0 ? opts.minGap : WORD_SYNC_MIN_GAP;
    const clean = cleanJizuraLines(lines);
    const starts = lineTimesFromLines(lines);      /* 秒，与 clean 同序同长 */
    const planLines = opts.plan && Array.isArray(opts.plan.lines) ? opts.plan.lines : null;
    const stats = opts.stats && typeof opts.stats === 'object' ? opts.stats : null;
    const out = {};
    clean.forEach((ln, i) => {
        if (!hasRealWords(ln)) return;
        const words = ln.words.map((w) => Number(w.start) / 1000);
        const n = words.length;
        const base = starts[i] || 0;
        /* 可见窗口的终点：**优先用 plan 里那一行的 visEnd**（引擎真正拿来做切分的那一个），
           没有 plan 时回落到行自身的 end。 */
        let end = Number(ln.end) / 1000;
        if (planLines) {
            const L = planLineAt({ lines: planLines }, base);
            const v = L ? Number(L.visEnd != null ? L.visEnd : L.end) : NaN;
            if (Number.isFinite(v) && v > base) end = v;
        }
        if (!Number.isFinite(end) || end <= base) return;
        const budget = end - base;
        const rel = words.map((t) => t - base);
        /**
         * 块 j 的切点 = **第一个**同时满足三条的真实字时间：
         *   ① 不早于引擎的下界 `0.22j`；② 不早于前一块 + 0.22（引擎的保序 clamp）；
         *   ③ 不晚于引擎的上界 `budget - 0.22(k-j)`（末块要留出 0.22s）。
         * 三条缺一不可 —— 越界或过密的切点会被引擎**静默夹走**，夹完就不再是真实字时间，
         * 那样得到的"同步"是假的（宁可少切几块）。
         * ★ 硬边界：最小块距 0.22s ≈ 4.5 字/秒，更快的唱法在本引擎里做不出精确逐字，
         *   此时贪心会把块数降下来，而不是把切点挪到假位置。
         */
        const pick = (kk) => {
            const times = [];                      /* 索引 0 不用：bounds[0] 恒为行首 */
            let prev = 0;
            for (let j = 1; j < kk; j++) {
                const lo = Math.max(minGap * j, prev + minGap);
                const hi = budget - minGap * (kk - j);
                let wi = -1;
                for (let x = 0; x < n; x++) { if (rel[x] >= lo - 1e-9) { wi = x; break; } }
                if (wi < 0 || rel[wi] > hi + 1e-9) return null;
                times[j] = Math.round(rel[wi] * 1000) / 1000;
                prev = rel[wi];
            }
            return times;
        };
        for (let k = Math.min(maxCuts, n, Math.floor(budget / minGap)); k >= 2; k--) {
            const cutTime = pick(k);
            if (!cutTime) continue;
            out[i] = { cuts: k, cutTime };
            if (stats) { stats.synced++; if (k < Math.min(maxCuts, n)) stats.reduced++; }
            return;
        }
        if (stats) stats.skipped++;
    });
    return out;
}

/* ============================================================
 * 画面细节（引擎 fx 的六个数值 + 两个开关）
 * ============================================================ */

/** 默认值与上游 `J.defaultProject().fx` 对齐（改这里必须同步 defaults.js / 190 兜底表） */
export const JIZURA_FX_DEFAULTS = {
    motion: 0.7, glitch: 0.55, chroma: 0.7, decor: 0.5,
    density: 0.55, texture: 0.6, flash: true, hud: 'auto',
};

/** 面板上那六根滑杆的键（0~1） */
export const JIZURA_FX_SLIDERS = ['motion', 'glitch', 'chroma', 'decor', 'density', 'texture'];
/** HUD 的三个档（引擎只认这三个值） */
export const JIZURA_HUD_VALUES = ['auto', 'on', 'off'];

/**
 * 把面板下发的**一堆单键**收敛成引擎要的那个 `fx` 对象（纯函数，可单测）。
 *
 * ★ 为什么不让面板直接写一个 `fx` 对象：设置面板与配方（`vfxRecipe`）的机制是
 *   "一个 `data-var` → 一个键"，塞对象进去要另开一条路（而且配方校验也认不了对象）。
 *   所以面板写单键、这里收敛 —— 引擎侧仍然只看到 `fx`。
 * ★ 越界值夹到 0~1 而不是丢弃：滑杆值来自本地，夹一下比"静默不生效"好排查。
 * @param {object} prev 上一次的 fx
 * @param {object} settings 面板下发的设置（可能只带少数字段）
 * @returns {{fx:object, dirty:boolean}} dirty = 与上一次不同，需要重建 plan
 */
export function collectJizuraFx(prev, settings) {
    const fx = Object.assign({}, JIZURA_FX_DEFAULTS, prev || {});
    const s = settings || {};
    let dirty = false;
    for (const k of JIZURA_FX_SLIDERS) {
        if (s[k] === undefined || s[k] === null || s[k] === '') continue;
        const v = Number(s[k]);
        if (!Number.isFinite(v)) continue;
        const c = Math.max(0, Math.min(1, v));
        if (fx[k] !== c) { fx[k] = c; dirty = true; }
    }
    if (s.flash !== undefined) {
        const v = (typeof s.flash === 'string') ? s.flash !== 'false' : !!s.flash;
        if (fx.flash !== v) { fx.flash = v; dirty = true; }
    }
    if (s.hud !== undefined && JIZURA_HUD_VALUES.indexOf(String(s.hud)) >= 0) {
        const v = String(s.hud);
        if (fx.hud !== v) { fx.hud = v; dirty = true; }
    }
    return { fx, dirty };
}

/** 通用 CSS 字体关键字（不是可导入的家族，见 jizuraFamilyNames 的注释） */
const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong']);

/**
 * 引擎字体目录里用到的**家族名**（去引号、去重）。
 * 字体包的匹配表就取自这里 —— 不硬编 18 个名字：上游加了字族我们自动跟上，
 * 也不会因为拼错一个名字导致"导入了但引擎用不上"。
 * @param {object} J
 * @returns {string[]}
 */
export function jizuraFamilyNames(J) {
    const out = new Set();
    const fonts = (J && J.FONTS) || {};
    for (const k of Object.keys(fonts)) {
        const fam = fonts[k] && fonts[k].family;
        if (!fam) continue;
        for (const part of String(fam).split(',')) {
            const name = part.trim().replace(/^["']|["']$/g, '').trim();
            /* 通用关键字不是"可导入的字体家族"：上游目前只写单个带引号的名字，
               但将来若写成 `"X", sans-serif` 这种带兜底的列表，不该把关键字收进匹配表
               （否则文件名叫 `sans.ttf` 会被误配成家族 `sans-serif`）。 */
            if (name && !GENERIC_FAMILIES.has(name.toLowerCase())) out.add(name);
        }
    }
    return [...out];
}

/** 家族名归一化：只留字母数字（`Noto Sans JP` / `NotoSansJP` / `noto-sans-jp` 视为同一个） */
function normFamily(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * 给一个字体文件挑家族名（字体包用）。
 * 优先落在引擎自己的家族上，并允许**前缀**匹配 —— 这样 `NotoSansJP-Black.ttf`
 * 会归到 `Noto Sans JP`（字重后缀不会让它匹配失败）；都不命中就用文件名本身
 * （仍然是个可用的家族名，只是本模式用不上）。
 * @param {string[]} canonicals 引擎家族名（jizuraFamilyNames 的结果）
 * @param {string} baseName 文件名（去扩展名）
 * @returns {string|null}
 */
export function pickJizuraFamily(canonicals, baseName) {
    const n = normFamily(baseName);
    if (!n) return null;
    let best = null;
    for (const c of canonicals || []) {
        const cn = normFamily(c);
        if (!cn) continue;
        if (cn === n) return c;
        if (n.startsWith(cn) && (!best || cn.length > normFamily(best).length)) best = c;
    }
    return best || String(baseName).trim();
}

/** 只清字形/度量缓存（导入字体后必须清：两者都是按"css font 串 + 字符"烘出来的） */
export function clearJizuraFontCaches(J) {
    let cleared = false;
    try {
        if (J && J.glyphs && typeof J.glyphs.clear === 'function') { J.glyphs.clear(); cleared = true; }
        if (J && J.metrics && typeof J.metrics.clear === 'function') { J.metrics.clear(); cleared = true; }
    } catch (e) { logCatch(JIZURA_TAG, e); }
    return cleared;
}

/**
 * 在计划里按**行首时间**找对应那一行。
 * ★ 不能按下标硬对：引擎会为间奏等情形插入自己的行（`interlude: true`），
 *   一旦下标错位，后续所有"行 → 字时间"的映射都会串行（海报补帧同理）。
 * @param {object} plan
 * @param {number} startSec 行首（秒）
 */
export function planLineAt(plan, startSec) {
    const lines = plan && Array.isArray(plan.lines) ? plan.lines : null;
    const s = Number(startSec);
    if (!lines || !Number.isFinite(s)) return null;
    for (const L of lines) {
        if (!L || L.interlude) continue;
        if (Math.abs(Number(L.start) - s) < 0.02) return L;
    }
    return null;
}

/* ============================================================
 * 字体切换：把 Aria 的字体设置接到引擎的字形链上
 * ============================================================ */

/**
 * 用 Aria 的字体栈覆写引擎的每个字形角色。
 *
 * 钩子选 `J.faceOf(key)`（02b_lang.js:134）而不是去改 `J.FONTS`：
 *   · 它是**全部**字形取面的唯一入口 —— `J.fontCSS()`（02_fonts.js:79）、
 *     `J.ensureFonts()`（:121）、各布局的 `c.font` 解析（11p_layoutsB.js:1551）、
 *     导出用的字体表（11_export.js:326）都走它，覆写一处即可全局生效；
 *   · 它在装载期**只赋一次值**（不在每帧重设），所以覆写不会被冲掉。
 * 保留原函数并**委托**给它、只换 family：这样 02b_lang 的"按语言选面"逻辑
 * （简体/繁体/韩文各自的 Noto 面）仍在，我们只是在最外层换个字；
 * 同时**保留 weight**，风格的粗细层级不会因为换字体而塌掉。
 *
 * ★ 必须清 `J.glyphs` / `J.metrics`：字形是按"css font 串 + 字符"烘出来的缓存
 *   （02_fonts.js:145 `_mc.font = J.fontCSS(...)`），不清就会继续用旧字体的字形与
 *   度量 —— 上游 `addUserFont` / `restoreUserFonts` 也正是这么做的（:43、:70）。
 *
 * @param {object} J 引擎
 * @param {string} stack Aria 解析后的 CSS 字体栈；空 / inherit / default → 还原成上游字体
 * @returns {boolean} 是否处于"已覆写"状态
 */
export function applyJizuraFontOverride(J, stack) {
    if (!J || !J.FONTS) return false;
    if (!Object.prototype.hasOwnProperty.call(J, '__ariaFaceOfBase')) {
        J.__ariaFaceOfBase = typeof J.faceOf === 'function' ? J.faceOf : null;
    }
    const base = J.__ariaFaceOfBase;
    const clean = String(stack === undefined || stack === null ? '' : stack).trim();
    const off = !clean || clean === 'inherit' || clean === 'default' || clean === 'system';
    const current = J.__ariaFontStack || '';
    if (off) {
        if (!current) return false;
        if (base) J.faceOf = base; else delete J.faceOf;
        J.__ariaFontStack = '';
    } else {
        if (current === clean) return true;      /* 幂等：别把包装器一层层套上去 */
        J.faceOf = (key) => {
            const f = base ? (base(key) || J.FONTS[key]) : J.FONTS[key];
            if (!f) return f;
            /* gf 丢掉：那是"去 Google Fonts 拉日文字面"的规格，我们已经不用那张面了，
               留着只会在（将来若接上 ensureFonts 时）发一次无用的网络请求 + 5 秒超时兜底。 */
            return Object.assign({}, f, { family: clean, gf: null });
        };
        J.__ariaFontStack = clean;
    }
    try { if (J.glyphs && typeof J.glyphs.clear === 'function') J.glyphs.clear(); } catch (e) { logCatch(JIZURA_TAG, e); }
    try { if (J.metrics && typeof J.metrics.clear === 'function') J.metrics.clear(); } catch (e) { logCatch(JIZURA_TAG, e); }
    return !off;
}

/* ============================================================
 * 真实 BPM：当前曲目 → 已缓存的分析结果（**只读缓存，不做新分析**）
 * ============================================================ */

/** 当前播放曲目（`playlist` / `currentTrackIndex` 是 10-config-state.js 注册的全局） */
export function currentTrackEntry() {
    try {
        const pl = globalThis.playlist;
        const idx = globalThis.currentTrackIndex;
        if (!Array.isArray(pl) || typeof idx !== 'number' || idx < 0 || idx >= pl.length) return null;
        return pl[idx] || null;
    } catch {
        return null;
    }
}

/** 曲目指纹（用于"同一首歌只查一次缓存"） */
export function trackFingerprint(track) {
    if (!track) return '';
    return [track.id, track.title, track.artist, track.url, track.path]
        .map((v) => (v === undefined || v === null ? '' : String(v)))
        .join('|');
}

/**
 * 取当前曲目**已缓存**的 BPM。
 *
 * ★ 为什么刻意不调 `analyzeTrack`：那要解码整首歌（旧机器上以秒计，还得占用主线程），
 *   而这里只想要一个卡点网格。用户没开 automix 就说明他没要这份分析 ——
 *   替他跑一遍是"用几百毫秒的卡顿换一个装饰性参数"，不划算。
 *   缓存里有就用（需求 22 的分析缓存层正是为此），没有就交给引擎自估。
 * ★ 动态 import：静态引会把 automix 分析器拖进首屏包，毁掉本模式的懒加载。
 */
export async function currentTrackBpm(entry) {
    const track = entry || currentTrackEntry();
    if (!track) return 0;
    try {
        const [{ automixCacheGet }, { automixCacheKey }] = await Promise.all([
            import('../../../services/aiCache.js'),
            import('../../automix/analyzer.js'),
        ]);
        const cached = await automixCacheGet(automixCacheKey(track));
        return cached ? normalizeBpm(cached.bpm) : 0;
    } catch (e) {
        logCatch(JIZURA_TAG, e);
        return 0;
    }
}
