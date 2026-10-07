/* ============================================================
 * tests/js/test_mv_sync.js — MV 音画偏移检测（services/mvSync.js）行为回归
 *
 * 背景（2026-10-04 用户需求）：自动匹配的 MV 常带几十秒前奏，于是
 * `video.currentTime = audio.currentTime` 这个前提本身就不成立 —— 用户报的
 * 「MV 音画不同步」。修法是拿 MV 音轨与歌曲音轨的能量包络做归一化互相关，
 * 算出一个恒定偏移去纠正画面。
 *
 * 这份测试盯住四件最容易悄悄坏掉的事：
 *   ① **lag 的符号**：d > 0 必须表示「MV 多了 d 秒前奏」（即播放时要
 *      video.currentTime = audio.currentTime + d）。弄反了画面会朝反方向错，
 *      比不修更糟，而且肉眼看不出是哪一步错的。
 *   ② **必须归一化**：不做归一化时「重叠越长分数越高」，短前奏的错配反而会赢。
 *   ③ **不可信就回 0**：峰不够强 / 平台期（多个几乎同分的 lag）/ 超出上限，
 *      都必须判成不可用 —— 用户明确允许「搞不定就放弃同步正常播放」。
 *   ④ **缓存往返**：偏移是按 (MV, 歌曲) 组合永久缓存的，键写错就等于每次
 *      重下 20MB+ 素材。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert';
import {
    HOP, HOP_FPS, envelopeOf, correlateAt, scanLags, refineLag,
    judgeOffset, detectOffsetFromPcm,
    readOffsetCache, writeOffsetCache,
} from '../../web/src/services/mvSync.js';

/* ---------- 合成素材 ---------- */

/** 确定性伪随机（不用 Math.random，失败可复现） */
function makeRnd(seed) {
    let s = seed || 12345;
    return () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return (s / 0x7fffffff) * 2 - 1;
    };
}

/** 用「逐帧振幅包络」造一段 8kHz PCM：包络 × (噪声 + 正弦) 做载波 */
function synthPcm(envFrames, seed) {
    const rnd = makeRnd(seed);
    const pcm = new Float32Array(envFrames.length * HOP);
    for (let i = 0; i < envFrames.length; i++) {
        const a = envFrames[i];
        for (let k = 0; k < HOP; k++) {
            const n = i * HOP + k;
            pcm[n] = a * (0.6 * rnd() + 0.4 * Math.sin(2 * Math.PI * 440 * n / 8000));
        }
    }
    return pcm;
}

/** 一段「有结构」的包络：慢变随机 + 两处静音（模拟间奏），便于相关性判别 */
function makeEnv(frames, seed) {
    const rnd = makeRnd(seed);
    const e = new Float32Array(frames);
    let v = 0.5;
    for (let i = 0; i < frames; i++) {
        v = Math.max(0.05, Math.min(1, v + rnd() * 0.08));
        e[i] = v;
    }
    for (let i = Math.round(frames * 0.3); i < Math.round(frames * 0.36); i++) e[i] = 0.02;
    for (let i = Math.round(frames * 0.7); i < Math.round(frames * 0.74); i++) e[i] = 0.02;
    return e;
}

/* ---------- 包络 ---------- */

test('envelopeOf：长度 = floor(n/hop)，恒定振幅 → 恒定包络', () => {
    const pcm = new Float32Array(HOP * 10).fill(0.5);
    const e = envelopeOf(pcm);
    assert.equal(e.length, 10);
    for (const v of e) assert.ok(Math.abs(v - 0.5) < 1e-6, `期望 0.5 得到 ${v}`);
});

test('envelopeOf：空输入 / 非法 hop 一律给空数组（不抛异常）', () => {
    assert.equal(envelopeOf(null).length, 0);
    assert.equal(envelopeOf(new Float32Array(0)).length, 0);
    assert.equal(envelopeOf(new Float32Array(100), 0).length, 0);
});

/* ---------- 互相关 ---------- */

test('correlateAt：同一段信号在 d=0 处 r=1，错开很远处 r 明显更低', () => {
    const env = makeEnv(600, 7);
    assert.ok(Math.abs(correlateAt(env, env, 0).r - 1) < 1e-6);
    assert.ok(correlateAt(env, env, 250).r < 0.9);
});

test('correlateAt：完全不重叠 → r=0、n=0（不是 NaN）', () => {
    const a = makeEnv(50, 1), b = makeEnv(50, 2);
    const c = correlateAt(a, b, 999);
    assert.equal(c.n, 0);
    assert.equal(c.r, 0);
});

test('correlateAt：常数包络（零方差）→ r=0，不产生 NaN', () => {
    const flat = new Float32Array(200).fill(0.3);
    const r = correlateAt(flat, flat, 0).r;
    assert.equal(r, 0);
    assert.ok(!Number.isNaN(r));
});

/* ---------- 扫描 / 细化 ---------- */

test('scanLags：按 r 降序，且粗扫能命中真实 lag 的 stride 附近', () => {
    const env = makeEnv(900, 3);
    const shifted = new Float32Array(env.length);
    const K = 137;                       /* 真实 lag（帧） */
    shifted.set(env.subarray(0, env.length - K), K);
    const ranked = scanLags(shifted, env);   /* envMv[i] ≈ envSong[i-K] */
    assert.ok(ranked.length > 0);
    assert.ok(Math.abs(ranked[0].d - K) <= 4, `粗扫峰值 ${ranked[0].d} 应落在 ${K}±4`);
    for (let i = 1; i < Math.min(ranked.length, 20); i++) {
        assert.ok(ranked[i].r <= ranked[i - 1].r, '必须降序');
    }
});

test('refineLag：把粗扫的量化误差收回到 1 帧（20ms）精度', () => {
    const env = makeEnv(900, 11);
    const K = 137;
    const shifted = new Float32Array(env.length);
    shifted.set(env.subarray(0, env.length - K), K);
    const fine = refineLag(shifted, env, K - 4 + 3, 4);
    assert.equal(fine.d, K);
});

/* ---------- 判据 ---------- */

test('judgeOffset：强峰且主次分明 → 采纳，符号与量纲都对', () => {
    const r = judgeOffset([{ d: Math.round(41.28 * HOP_FPS), r: 0.92 }, { d: 0, r: 0.4 }]);
    assert.equal(r.ok, true);
    assert.ok(Math.abs(r.offsetSec - 41.28) < 0.05, `得到 ${r.offsetSec}`);
});

test('judgeOffset：相关太弱 → 拒绝（回 0，不动画面）', () => {
    const r = judgeOffset([{ d: 500, r: 0.3 }, { d: 0, r: 0.28 }]);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'weak');
    assert.equal(r.offsetSec, 0);
});

test('judgeOffset：平台期（次峰几乎同分）→ 拒绝，避免"噪声当偏移"', () => {
    const r = judgeOffset([{ d: 500, r: 0.80 }, { d: 504, r: 0.79 }]);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'flat');
});

test('judgeOffset：超出上限的前奏 → 拒绝（多半是配错了 MV）', () => {
    const r = judgeOffset([{ d: 200 * HOP_FPS, r: 0.9 }, { d: 0, r: 0.1 }]);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'out-of-range');
});

test('judgeOffset：与运行时纠偏阈值同量级的小偏移 → 采纳但归零（不做无意义的 seek）', () => {
    const r = judgeOffset([{ d: 6, r: 0.9 }, { d: 900, r: 0.1 }]);   /* 6 帧 = 0.12s */
    assert.equal(r.ok, true);
    assert.equal(r.offsetSec, 0);
    assert.equal(r.reason, 'dead-zone');
});

test('judgeOffset：空候选 → 拒绝', () => {
    assert.equal(judgeOffset([]).ok, false);
    assert.equal(judgeOffset(null).ok, false);
});

/* ---------- 端到端（合成音频，符号正确性） ---------- */

test('detectOffsetFromPcm：MV 多 K 帧前奏 → 正偏移，数值 = K/50 秒', () => {
    const songEnv = makeEnv(1500, 21);
    const songPcm = synthPcm(songEnv, 21);
    const K = Math.round(25 * HOP_FPS);            /* 25 秒前奏 */
    const mvPcm = new Float32Array(K * HOP + songPcm.length);
    mvPcm.set(songPcm, K * HOP);                   /* 前面 K*HOP 个采样是静音 */
    const r = detectOffsetFromPcm(mvPcm, songPcm);
    assert.equal(r.ok, true);
    assert.ok(Math.abs(r.offsetSec - K / HOP_FPS) < 0.1,
        `期望 ≈${(K / HOP_FPS).toFixed(2)}s，得到 ${r.offsetSec}s`);
    assert.ok(r.r > 0.8, `相关系数应很高，得到 ${r.r}`);
});

test('detectOffsetFromPcm：两轨完全对齐 → 偏移 ~0（dead-zone 归零）', () => {
    const pcm = synthPcm(makeEnv(1200, 33), 33);
    const r = detectOffsetFromPcm(pcm, pcm);
    assert.equal(r.ok, true);
    assert.equal(r.offsetSec, 0);
});

test('detectOffsetFromPcm：素材太短 → 明确拒绝，不硬算', () => {
    const short = new Float32Array(HOP * 10).fill(0.1);
    const r = detectOffsetFromPcm(short, short);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'too-short');
});

/* ---------- 偏移缓存 ---------- */

test('偏移缓存：写入后能读回；未命中回 null；非法值不落盘', () => {
    const store = new Map();
    globalThis.localStorage = {
        getItem: k => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: k => { store.delete(k); },
    };
    const key = 'kugou:117613|qq:123:vid9';
    assert.equal(readOffsetCache(key), null);
    writeOffsetCache(key, 41.28);
    assert.equal(readOffsetCache(key), 41.28);
    /* 不同 key 互不串味 */
    assert.equal(readOffsetCache('other|key'), null);
    /* 非法值不写 */
    writeOffsetCache('bad', NaN);
    assert.equal(readOffsetCache('bad'), null);
    assert.equal(readOffsetCache(''), null);
    writeOffsetCache('', 5);
    assert.equal(readOffsetCache(''), null);
    delete globalThis.localStorage;
});

/* ============================================================
 * 2026-10-04 补：用户报「MV 播不了了」之后加的三道保险
 * 根因：应用偏移会把画面 seek 到**尚未缓冲**的位置；`timeupdate` 每 ~250ms
 * 又发一次 seek 把上一次打断 → seek 永远完不成、画面永远出不来。
 * 偏移为 0 时压根不发 seek，所以此前没暴露。三道保险各自独立兜底：
 *   ① 时长闸门：多数 MV 与歌曲同长（偏移必然 0）→ 连分析都不做；
 *   ② seek 预算：窗口内 seek 过多 = 这个偏移在这台机器上跑不动 → 回退 0；
 *   ③ 观察窗：应用偏移后确认画面真的出来了，否则回退 0 并拉黑这条缓存。
 * ============================================================ */
import { shouldAnalyzeOffset, makeSeekBudget, judgeAppliedOffset, ANALYZE_MAX_BYTES } from '../../web/src/services/mvSync.js';

test('shouldAnalyzeOffset：只有"时长几乎完全相同"才放过（阈值 0.35s，2026-10-04 从 2s 收到 0.35s）', () => {
    /* ★ 为什么收得这么狠：官方 MV 常常是**重新剪辑版** —— 前奏多几秒、尾奏剪几秒，
       总时长几乎相等而内容整体错位几秒。那正是用户报的「歌曲和 MV 的歌词总是差了
       一句左右的时间」，原阈值(2s)把它一刀切掉了、且日志里什么都没留下。
       ★ 敢放宽的前提是成本：分析只取文件头（ANALYZE_MAX_BYTES），不再整支下载。 */
    assert.equal(shouldAnalyzeOffset(328.4, 328.4).analyze, false);
    assert.equal(shouldAnalyzeOffset(328.4, 328.4).reason, 'same-length');
    assert.equal(shouldAnalyzeOffset(328.4, 328.7).analyze, false);   /* 差 0.3s，在死区内 */
    assert.equal(shouldAnalyzeOffset(328.4, 329.5).analyze, true);    /* 差 1.1s → 做（原来被跳过） */
    assert.equal(shouldAnalyzeOffset(328.4, 330.5).analyze, true);    /* 差 2.1s → 做 */
});

test('ANALYZE_MAX_BYTES：分析下载有硬上限（这是放宽时长闸门的成本前提）', () => {
    assert.ok(ANALYZE_MAX_BYTES > 0, '必须有上限，否则又变成整支下载');
    assert.ok(ANALYZE_MAX_BYTES <= 16 * 1024 * 1024, `上限过大：${ANALYZE_MAX_BYTES}`);
});

test('shouldAnalyzeOffset：真实样例（成都：MV 364.3s / 歌 328.4s，差 36s）要做', () => {
    const r = shouldAnalyzeOffset(364.27, 328.36);
    assert.equal(r.analyze, true);
});

test('shouldAnalyzeOffset：拿不到时长 / 超长视频 → 不做', () => {
    assert.equal(shouldAnalyzeOffset(0, 328).analyze, false);
    assert.equal(shouldAnalyzeOffset(328, 0).analyze, false);
    assert.equal(shouldAnalyzeOffset(NaN, 328).analyze, false);
    assert.equal(shouldAnalyzeOffset(3600, 328).reason, 'too-long');
});

test('makeSeekBudget：窗口内放行到上限就拒绝（防止 seek 风暴）', () => {
    const b = makeSeekBudget(3, 1000);
    assert.equal(b.allow(0), true);
    assert.equal(b.allow(10), true);
    assert.equal(b.allow(20), true);
    assert.equal(b.allow(30), false, '第 4 次必须被拒');
    /* 窗口滑走之后重新放行 */
    assert.equal(b.allow(1200), true);
    assert.equal(b.count(), 1);
    b.reset();
    assert.equal(b.count(), 0);
});

test('judgeAppliedOffset：4s 观察窗内一律算 pending（不急着判死）', () => {
    assert.equal(judgeAppliedOffset({ readyState: 0, seeking: true, advancedSec: 0, elapsedMs: 1000 }).pending, true);
});

test('judgeAppliedOffset：仍在 seeking / 没有帧 / 位置不动 → 三种失败都要认出来', () => {
    assert.equal(judgeAppliedOffset({ readyState: 4, seeking: true, advancedSec: 5, elapsedMs: 5000 }).reason, 'stuck-seeking');
    assert.equal(judgeAppliedOffset({ readyState: 1, seeking: false, advancedSec: 5, elapsedMs: 5000 }).reason, 'no-frame');
    assert.equal(judgeAppliedOffset({ readyState: 4, seeking: false, advancedSec: 0.1, elapsedMs: 5000 }).reason, 'frozen');
});

test('judgeAppliedOffset：画面正常（有帧 + 在走 + 不在 seek）→ 通过', () => {
    assert.equal(judgeAppliedOffset({ readyState: 4, seeking: false, advancedSec: 3.8, elapsedMs: 5000 }).ok, true);
});
