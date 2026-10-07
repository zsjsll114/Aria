/* ============================================================
 * core/automix/analyzer.js — Automix 轨道分析入口（浏览器侧）
 *
 * Phase 0（Automix-技术方案.md §3.1）。职责：取音频数据 → 解码成单声道
 * 低采样率 → 调 envelope.js 纯函数 → IndexedDB 缓存。播放调度（Phase 2 的
 * scheduler）只认本文件的 analyzeTrack，不感知信号处理细节。
 *
 * 模型钩子（方案 §6）：analyzeTrack 本身就是 provider 接口——将来接
 * ONNX Runtime Web 跑 segmentation 模型时，替换本文件的实现即可，
 * 返回结构保持 { introPointMs, outroPointMs, outroSparsePointMs, bpm,
 * bpmConfidence, ... }，低置信时调度层自动降级。
 *
 * 失败语义：任何一步失败都 logCatch 留痕并返回 null，**永不抛出**——
 * 分析只是观感优化，不允许阻塞播放主链（方案 §3.1 边界情况）。
 *
 * 缓存属主：store 由 services/aiCache.js 幂等建库（★ 勿在本模块另开
 * indexedDB.open，历史上双 getAiDb 竞争漏建 store 即由此而来）。
 * ============================================================ */
import { analyzeEnvelope, AUTOMIX_ANALYSIS_RATE } from './envelope.js';
import { automixCacheGet, automixCacheSet } from '../../services/aiCache.js';
import { logInfo, logCatch } from '../../services/log.js';

/** 时长低于此值（毫秒）不分析——太短的歌没有交叉价值，直接走原生切歌 */
const MIN_DURATION_MS = 15000;

/**
 * 缓存键：trackId 优先（本地音乐=路径指纹，在线源=平台歌曲 id），
 * 缺 id 退化为 URL hash（djb2）。URL 键意味着在线解析链接变化会重分析——
 * 可接受：在线 URL 本来就时效短，正式接入 Phase 2 时 scheduler 会传稳定 id。
 * @param {{ id?: string|number, url?: string }} track
 */
export function automixCacheKey(track) {
    const id = track && (track.id !== undefined && track.id !== null)
        ? String(track.id)
        : `url:${djb2(String(track && track.url || ''))}`;
    return `automix:v1:${id}`;
}

function djb2(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) + h + str.charCodeAt(i)) & 0x7fffffff;
    }
    return h.toString(36);
}

/**
 * 解码任意容器音频为单声道 Float32 @ AUTOMIX_ANALYSIS_RATE。
 * OfflineAudioContext.decodeAudioData 会重采样到 context 采样率（规范行为，
 * Chromium/Firefox 一致），所以直接低采样率解码，省一次手动 resample。
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<{ samples: Float32Array, sampleRate: number, durationMs: number }>}
 */
export async function decodeToMono(arrayBuffer) {
    const OfflineCtx = (typeof window !== 'undefined')
        ? (window.OfflineAudioContext || window.webkitOfflineAudioContext)
        : null;
    if (!OfflineCtx) throw new Error('OfflineAudioContext unavailable');
    /* length=1 的占位 context 只为借用 decodeAudioData 的重采样 */
    const ctx = new OfflineCtx(1, 1, AUTOMIX_ANALYSIS_RATE);
    const audioBuf = await ctx.decodeAudioData(arrayBuffer);
    const chCount = audioBuf.numberOfChannels;
    const length = audioBuf.length;
    const samples = new Float32Array(length);
    for (let ch = 0; ch < chCount; ch++) {
        const data = audioBuf.getChannelData(ch);
        for (let i = 0; i < length; i++) samples[i] += data[i];
    }
    if (chCount > 1) {
        for (let i = 0; i < length; i++) samples[i] /= chCount;
    }
    return { samples, sampleRate: audioBuf.sampleRate, durationMs: length / audioBuf.sampleRate * 1000 };
}

/**
 * 分析一首歌。结果带 fromCache 标记；失败返回 null（不抛出）。
 * @param {{ id?: string|number, url?: string, title?: string }} track
 * @param {{ fetchImpl?: Function, decodeImpl?: Function }} [deps] 测试注入点：
 *   fetchImpl(url)=>Response-like、decodeImpl(arrayBuffer)=>decodeToMono 同签名
 * @returns {Promise<Object|null>}
 */
export async function analyzeTrack(track, deps = {}) {
    if (!track || !(track.url || track.id)) return null;
    const key = automixCacheKey(track);
    try {
        const cached = await automixCacheGet(key);
        if (cached) {
            logInfo('automix.analyzer', `命中分析缓存: ${track.title || key}`);
            return { ...cached, fromCache: true };
        }

        const fetchImpl = deps.fetchImpl || fetch;
        /* ★ 必须带超时：真机上流代理/后端偶发挂起会让 fetch 永不 settle，
           scheduler 的 _armAndGo await 在这里永久卡死、_arming 无法释放，
           automix 从此静默瘫痪。但 20s 对「在线曲整首回源下载」不够
           （/api/audio/stream 无论带不带 Range 都向上游拉全曲）——起播期的
           预分析（scheduler _prewarmNext）在后台跑，给它 60s 读完；ARM 期另有
           raceTimeout 独立限时，慢分析拖不垮本轮。 */
        const signal = (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
            ? AbortSignal.timeout(60000) : undefined;
        const resp = await fetchImpl(track.url, { signal });
        if (!resp || !resp.ok) throw new Error(`fetch failed: ${resp && resp.status}`);
        const arrayBuffer = await resp.arrayBuffer();

        const decodeImpl = deps.decodeImpl || decodeToMono;
        const { samples, sampleRate, durationMs } = await decodeImpl(arrayBuffer);
        if (durationMs < MIN_DURATION_MS) {
            logInfo('automix.analyzer', `时长 ${(durationMs / 1000).toFixed(1)}s 过短，跳过分析`);
            return null;
        }

        const result = analyzeEnvelope(samples, sampleRate);
        result.durationMs = durationMs; /* 以解码器口径为准（包络按帧取整过） */
        delete result.frameMs; /* 内部实现细节，不进缓存不外泄 */
        await automixCacheSet(key, result);
        logInfo('automix.analyzer', `分析完成: ${track.title || key} bpm=${result.bpm ? result.bpm.toFixed(1) : 'null'} outro=${(result.outroPointMs / 1000).toFixed(1)}s`);
        return result;
    } catch (e) {
        logCatch('automix.analyzer', e);
        return null;
    }
}
