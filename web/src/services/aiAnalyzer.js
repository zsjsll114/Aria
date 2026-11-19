/* ============================================================
 * services/aiAnalyzer.js — AI 情绪分析、流式情感词着色、高潮检测与歌单批量分析运行时
 *
 * 从 app/201-settings-ai.js 拆出的纯运行时业务服务层：
 * - 不直接 import app/* 分片（通过 setAiRuntimeHooks 解耦 UI/播放器访问）
 * - 通过 state.js 访问全局共享状态（不写 globalThis.*）
 * - 设置界面交互与表单绑定留在 app/201-settings-ai.js
 * ============================================================ */
import { AI_PROVIDERS } from '../config/constants.js';
import { getBlurBgLayers } from '../infrastructure/dom.js';
import { state } from '../infrastructure/state.js';
import { formatTime, esc } from '../utils/formatters.js';
import { normalizeEmotionColor } from '../utils/colorUtils.js';
import ChorusDetector from '../core/chorusDetector.js';
import { GEMINI_DEFAULT_MODEL, cleanApiBase, extractGeminiText, formatGeminiError, testGeminiConnection as testGeminiClient } from './aiClient.js';
import { aiCacheCount, aiCacheGet, aiCacheSet, chorusCacheGet, chorusCacheSet } from './aiCache.js';
import { buildEmotionSystemPrompt, buildAIRequest } from '../core/aiAnalyzer.js';
import { generateLineAnalyses } from '../core/proceduralLayout.js';
import { registerAudioListener } from '../core/dualDeck.js';
import { t } from '../core/i18n.js';
import { logInfo, logWarn, logError, logCatch } from './log.js';

let _currentChorusSegments = [];
let _fullChorusSegments = [];
let _audioRhythm = null;

const _hooks = {
    getAudio: () => (typeof document !== 'undefined' ? document.getElementById('audioPlayer') : null),
    getFavorites: () => [],
    getPlaylists: () => [],
    getPlaylistsHintEl: () => null,
    applyLyricBlurLevel: () => {},
    applyThemeColor: () => {},
    showSettingsHint: () => {},
    getChorusState: null,
    setChorusState: null,
    getSelfPlatState: () => (typeof globalThis !== 'undefined' ? globalThis.selfPlatState : null),
};

export function setAiRuntimeHooks(hooks = {}) {
    Object.assign(_hooks, hooks);
}

function _getCurrentChorus() {
    if (typeof _hooks.getChorusState === 'function') {
        const s = _hooks.getChorusState();
        if (s && Array.isArray(s.current)) return s.current;
    }
    return _currentChorusSegments;
}

function _getFullChorus() {
    if (typeof _hooks.getChorusState === 'function') {
        const s = _hooks.getChorusState();
        if (s && Array.isArray(s.full)) return s.full;
    }
    return _fullChorusSegments;
}

function _getAudioRhythm() {
    if (typeof _hooks.getChorusState === 'function') {
        const s = _hooks.getChorusState();
        if (s && s.rhythm !== undefined) return s.rhythm;
    }
    return _audioRhythm;
}

function _setChorusState(cur, full, rhythm) {
    _currentChorusSegments = Array.isArray(cur) ? cur : [];
    _fullChorusSegments = Array.isArray(full) ? full : [];
    _audioRhythm = rhythm || null;
    if (typeof _hooks.setChorusState === 'function') {
        _hooks.setChorusState(_currentChorusSegments, _fullChorusSegments, _audioRhythm);
    }
}

function _setPlaylistsHint(text) {
    const el = _hooks.getPlaylistsHintEl();
    if (el) el.textContent = text;
}

            function getLyricsTextForAI() {
                if (!state.lyrics || lyrics.length === 0) return '';

                /* 获取高潮区间列表（优先使用完整高潮 _getFullChorus()，回退 _getCurrentChorus()） */
                const chorusList = (_getFullChorus() && _getFullChorus().length > 0)
                    ? _getFullChorus()
                    : ((_getCurrentChorus() && _getCurrentChorus().length > 0) ? _getCurrentChorus() : []);

                const isLineInChorus = (lineStartSec, lineEndSec) => {
                    if (!chorusList || chorusList.length === 0) return false;
                    return chorusList.some(seg => {
                        const s = seg.start;
                        const e = seg.end;
                        return (lineStartSec >= s && lineStartSec <= e) || (lineEndSec >= s && lineEndSec <= e) || (lineStartSec <= s && lineEndSec >= e);
                    });
                };

                /* 检测是否有逐字歌词（words 数组非空） */
                const hasWordByWord = lyrics.some(l => l.words && l.words.length > 0);

                if (hasWordByWord) {
                    /* 逐字歌词：构建带行号和时长/高潮权重的格式
                       格式：L{行号} [时长ms]★ 歌词文本 （行号对应 state.lyrics 数组索引，供 AI 精确定位情感词） */
                    const lines = [];
                    for (let i = 0; i < lyrics.length; i++) {
                        const l = state.lyrics[i];
                        let text = '';
                        let duration = 0;
                        let lineStart = 0;
                        let lineEnd = 0;
                        if (l.words && l.words.length > 0) {
                            text = '';
                            for (let j = 0; j < l.words.length; j++) {
                                const w = l.words[j];
                                const isLatin = !/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff]/u.test(w.text) && /^[\p{L}\p{M}\p{N}\s\p{P}\p{S}]+$/u.test(w.text) && /[\p{L}]/u.test(w.text);
                                if (isLatin && j > 0) text += ' ';
                                text += w.text;
                            }
                            lineStart = l.words[0].start;
                            lineEnd = l.words[l.words.length - 1].end;
                            duration = lineEnd - lineStart;
                        } else if (l.original) {
                            text = l.original;
                            lineStart = (l.start || 0) * (l.start > 1000 ? 1 : 1000);
                            lineEnd = (l.end || 0) * (l.end > 1000 ? 1 : 1000);
                            duration = lineEnd - lineStart;
                        } else {
                            text = l.text || '';
                            lineStart = (l.start || 0) * (l.start > 1000 ? 1 : 1000);
                            lineEnd = (l.end || 0) * (l.end > 1000 ? 1 : 1000);
                            duration = lineEnd - lineStart;
                        }
                        if (!text.trim()) continue;

                        const inChorus = isLineInChorus(lineStart / 1000, lineEnd / 1000);
                        /* 高潮区间内或单句时长 > 3秒标记为 ★，中等时长标记为 ◆ */
                        const weight = inChorus ? '★[CHORUS]' : (duration > 3000 ? '★' : duration > 1500 ? '◆' : '');
                        lines.push(`L${i} ${weight ? `[${duration}ms]${weight} ${text}` : `[${duration}ms] ${text}`}`);
                    }
                    return lines.join('\n').substring(0, 6000);
                } else {
                    /* 纯文本歌词：带行号与高潮标记拼接 */
                    const lines = [];
                    for (let i = 0; i < lyrics.length; i++) {
                        const l = state.lyrics[i];
                        const text = l.original || l.text || '';
                        if (!text.trim()) continue;
                        const lineStartSec = (l.start || 0) > 1000 ? l.start / 1000 : (l.start || 0);
                        const lineEndSec = (l.end || 0) > 1000 ? l.end / 1000 : (l.end || 0);
                        const inChorus = isLineInChorus(lineStartSec, lineEndSec);
                        const tag = inChorus ? '★[CHORUS] ' : '';
                        lines.push(`L${i} ${tag}${text}`);
                    }
                    return lines.join('\n').substring(0, 6000);
                }
            }

            /* buildAIRequest 已上移到 ../core/aiAnalyzer.js 唯一实现（含 modelMaxOutput 与 useProxy 处理）；
               本文件所有调用点直接复用该导出，避免两份「URL/headers/body 构造」分叉走样（清单 32 去重）。 */

            /* 从 SSE 流式 chunk 中提取文本内容，返回 { text, finishReason } */
            function extractAIStreamChunk(provider, chunk) {
                if (provider === 'gemini') {
                    const candidate = chunk.candidates && chunk.candidates[0];
                    if (candidate) {
                        let text = '';
                        if (candidate.content && candidate.content.parts) {
                            for (const part of candidate.content.parts) {
                                if (part.text) text += part.text;
                            }
                        }
                        const finishReason = candidate.finishReason || null;
                        return { text, finishReason };
                    }
                    return { text: '', finishReason: null };
                } else {
                    /* OpenAI 兼容格式 */
                    const choice = chunk.choices && chunk.choices[0];
                    if (choice) {
                        const delta = choice.delta || {};
                        let text = '';
                        if (delta.content) text += delta.content;
                        if (delta.reasoning_content) text += delta.reasoning_content;
                        if (delta.text) text += delta.text;
                        return { text, finishReason: choice.finish_reason || null };
                    }
                    return { text: '', finishReason: null };
                }
            }

            /* 从非流式响应中提取文本内容 */
            function extractAIResponseText(provider, data) {
                if (provider === 'gemini') {
                    return extractGeminiText(data);
                } else {
                    /* OpenAI 兼容格式 */
                    if (data.choices && data.choices[0]) {
                        const c = data.choices[0];
                        return (c.message && c.message.content) || c.text ||
                               (c.message && c.message.reasoning_content) || '';
                    }
                    return data.content || data.output || data.result || '';
                }
            }

            /* ★ 流式读取一轮响应的全部文本。
               返回 { content, streamError }，streamError='length' 表示因输出长度限制被截断。
               （供截断续传复用：同一段 SSE 读取逻辑不再在 analyzeSongWithAI 里重复写） */
            async function streamCollectOnce(reqObj, provider, timeoutMs, ui) {
                const ctl = new AbortController();
                const t = setTimeout(() => ctl.abort(), timeoutMs || 90000);
                let content = '';
                let streamError = null;
                try {
                    const resp = await fetch(reqObj.url, {
                        method: 'POST',
                        headers: reqObj.headers,
                        body: reqObj.body,
                        signal: ctl.signal
                    });
                    clearTimeout(t);
                    if (!resp.ok) {
                        const txt = await resp.text();
                        return { content: '', streamError: `HTTP ${resp.status} ${txt.substring(0, 200)}` };
                    }
                    const reader = resp.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';
                    let chunkCount = 0;
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || '';
                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) continue;
                            const dataStr = trimmed.slice(5).trim();
                            if (dataStr === '[DONE]') continue;
                            try {
                                const chunk = JSON.parse(dataStr);
                                chunkCount++;
                                const { text, finishReason } = extractAIStreamChunk(provider, chunk);
                                if (text) {
                                    content += text;
                                    if (ui && ui.setOutput) ui.setOutput(content);
                                }
                                if (ui && ui.setProgress) {
                                    const max = (ui.isReasoning ? 200 : 80);
                                    ui.setProgress(Math.min(90, (chunkCount / max) * 100));
                                }
                                if (finishReason) {
                                    const fr = String(finishReason).toLowerCase();
                                    if (fr === 'length' || fr === 'max_tokens') streamError = 'length';
                                }
                                if (chunk.error) streamError = chunk.error.message || JSON.stringify(chunk.error);
                            } catch (e) { /* 单块解析失败跳过 */ }
                        }
                    }
                    return { content, streamError };
                } catch (err) {
                    clearTimeout(t);
                    return { content, streamError: (err && err.name === 'AbortError') ? 'abort' : String(err && err.message || err) };
                }
            }

            /* ★ 从拼接文本中尽力提取合法 JSON 对象 */
            function tryParseJsonObject(str) {
                const s = (str || '').trim();
                if (!s) return null;
                try { return JSON.parse(s); } catch (e) { logCatch('settingsPanel', e); }
                const m = s.match(/\{[\s\S]*\}/);
                if (m) { try { return JSON.parse(m[0]); } catch (e) { logCatch('settingsPanel', e); } }
                return null;
            }

            /* ★ 截断续传 + 拼接：
               当一轮输出因 max_tokens/length 被截断、且 JSON 尚未完整时，
               把已生成的部分喂回给模型，让它紧接断点继续补全并再次流式读取，
               逐轮拼接直到拿到完整可解析的 JSON（或达到最大轮次）。 */
            async function completeTruncatedContent(base, originContent, provider, isReasoningModel) {
                const MAX_ROUNDS = 5;
                const ui = {
                    setOutput: null,           /* 续传阶段不再刷新浮动面板原文，避免刷屏 */
                    setProgress: null,
                    isReasoning: isReasoningModel
                };
                let joined = originContent;
                for (let round = 1; round <= MAX_ROUNDS; round++) {
                    const parsed = tryParseJsonObject(joined);
                    if (parsed) return { content: joined, parsed };

                    if (!joined || !joined.trim()) return { content: joined, parsed: null };

                    /* 构造续传用户输入：给出已生成部分（断点），要求只补全剩余 JSON */
                    const contPrompt = base.userPrompt +
                        `\n\n（你上一轮的输出因长度限制被截断了。下面是已经生成的部分，它在 JSON 中断在中间。\n` +
                        `请从这条中断处【接着继续补全】这一整份 JSON：保持所有字段名、结构与格式与之前完全一致，` +
                        `每个字段都不能少。\n` +
                        `只输出补全后的 JSON 内容本身，不要重复上面任何已生成的内容，不要加任何解释或代码块标记。）\n\n` +
                        `已生成(截断部分):\n${joined}`;

                    const contReq = buildAIRequest(base.provider, base.apiKey, base.apiBase, base.model,
                        base.systemPrompt, contPrompt, true, isReasoningModel,
                        (base.provider === 'gemini' && appSettings.ai && appSettings.ai.useProxy !== false));

                    const collected = await streamCollectOnce(contReq, provider, 90000, ui);
                    const more = collected.content || '';
                    if (!more) break;

                    /* 拼接：先按"断点续写"追加，再尝试解析整个拼接结果 */
                    const candidate = joined + more;
                    const parsed2 = tryParseJsonObject(candidate);
                    if (parsed2) return { content: candidate || joined, parsed: parsed2 };

                    /* 若模型没接着续写而是重新输出了完整对象，直接用续写片段 */
                    const standalone = tryParseJsonObject(more);
                    if (standalone) return { content: more, parsed: standalone };

                    joined = candidate;

                    if (collected.streamError !== 'length') {
                        /* 本轮正常结束，再用最终拼接尝试一次 */
                        const parsed3 = tryParseJsonObject(joined);
                        if (parsed3) return { content: joined, parsed: parsed3 };
                        break; /* 未截断却没拼出合法 JSON，停止 */
                    }
                }
                return { content: joined, parsed: tryParseJsonObject(joined) };
            }

            /* ★ 蒙德里安排版已改程序化本地生成（proceduralLayout.js），
               原「第二路 LLM 排版请求」requestLayoutAnalyses 及其截断续传逻辑整体移除。 */

            /* 测试 AI 连通性：发送一条简短消息，返回 { ok, message } */
            async function testAIConnection() {
                const ai = appSettings.ai;
                if (!ai.apiKey || ai.apiKey.trim().length < 5) {
                    return { ok: false, message: '请先输入有效的 API 密钥' };
                }
                const provider = ai.provider || 'gemini';
                if (provider === 'gemini') {
                    const useProxy = (ai.useProxy !== false);
                    return await testGeminiClient({
                        apiKey: ai.apiKey,
                        apiBase: cleanApiBase(ai.apiBase, useProxy),
                        model: ai.model || GEMINI_DEFAULT_MODEL,
                        proxyToken: ai.proxyToken,
                        useProxy
                    });
                }
                const providerCfg = AI_PROVIDERS[provider] || AI_PROVIDERS.openai;
                const apiBase = (ai.apiBase || providerCfg.defaultBase).replace(/\/+$/, '');
                const model = ai.model || providerCfg.defaultModel;
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 30000); /* 30s 超时 */
                try {
                    const req = buildAIRequest(
                        provider, ai.apiKey, ai.apiBase, ai.model,
                        'You are a test assistant. Reply with exactly: OK',
                        'Reply with exactly one word: OK',
                        false, false, false
                    );
                    const resp = await fetch(req.url, {
                        method: 'POST',
                        headers: req.headers,
                        body: req.body,
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);
                    let data = null;
                    try { data = await resp.json(); } catch { data = null; }
                    if (!resp.ok) {
                        const errMsg = formatGeminiError(null, resp.status, data);
                        return { ok: false, message: errMsg };
                    }
                    const text = extractAIResponseText(provider, data);
                    if (text && text.trim()) {
                        return { ok: true, message: `连接成功！模型回复: "${text.trim().substring(0, 50)}"` };
                    }
                    return { ok: true, message: '连接成功（返回内容为空，但接口可用）' };
                } catch (err) {
                    clearTimeout(timeoutId);
                    const errMsg = formatGeminiError(err, 0, null);
                    return { ok: false, message: `连接失败: ${errMsg}` };
                }
            }

            // --- AI Analysis Function ---
            /* 调用 AI API 分析歌曲情绪，返回标准化的视觉参数 JSON */
            async function analyzeSongWithAI(songTitle, artist, lyricsText, forceRefresh) {
                const ai = appSettings.ai;
                if (!songTitle) return null;

                const cacheKey = `${songTitle} - ${artist}`;
                /* 检查内存缓存（手动触发时跳过缓存） */
                if (!forceRefresh && state.aiThemeCache[cacheKey]) {
                    const cached = state.aiThemeCache[cacheKey];
                    if (cached && (cached.mood || cached.animation_style || cached.primary_color || Array.isArray(cached.emotion_words))) {
                        logInfo('settingsPanel', 'AI 分析命中内存缓存:', cacheKey);
                        return cached;
                    }
                }
                /* 检查 IndexedDB 持久化缓存 */
                if (!forceRefresh) {
                    const dbCached = await aiCacheGet(cacheKey);
                    if (dbCached && (dbCached.mood || dbCached.animation_style || dbCached.primary_color || Array.isArray(dbCached.emotion_words))) {
                        state.aiThemeCache[cacheKey] = dbCached;
                        logInfo('settingsPanel', 'AI 分析命中 IndexedDB 缓存:', cacheKey);
                        return dbCached;
                    }
                }

                /* 缓存未命中，需要真正调用 AI：此时才检查前置条件 Key 是否存在 */
                if (!ai.apiKey || ai.apiKey.trim().length < 5) {
                    _hooks.showSettingsHint('请先在设置中输入有效的 API 密钥');
                    return null;
                }

                /* 如果有正在进行的分析，先取消它（手动触发时强制取消） */
                if (state.isAiAnalyzing) {
                    if (!forceRefresh) {
                        logWarn('settingsPanel', 'AI 分析正在进行中，跳过重复请求');
                        return null;
                    }
                    /* 手动触发：取消正在进行的请求 */
                    if (state.currentAiAbortController) {
                        logInfo('settingsPanel', '取消正在进行的 AI 分析，启动新请求');
                        /* 标记为手动取消，避免旧请求的重试逻辑 */
                        currentAiAbortController._manualCancel = true;
                        currentAiAbortController.abort();
                        state.currentAiAbortController = null;
                    }
                    state.isAiAnalyzing = false;
                }
                state.isAiAnalyzing = true;

                /* 更新 UI 状态 */
                const statusText = typeof document !== 'undefined' ? document.getElementById('aiStatusText') : null;
                const statusDetail = typeof document !== 'undefined' ? document.getElementById('aiStatusDetail') : null;
                if (statusText) statusText.textContent = t('ai.statusAnalyzing', '正在分析...');
                if (statusDetail) statusDetail.textContent = `《${songTitle}》- ${artist}`;

                /* 构建 Prompt：系统指令 + 用户输入 */
                /* 使用完整高潮数据（未限制覆盖率），让 AI 有更多情感词选取空间 */
                const chorusInfo = (_getFullChorus().length > 0)
                    ? `\n\n【高潮时间轴】检测到以下高潮/高能量段落：${_getFullChorus().map(s => `${formatTime(s.start * 1000)}-${formatTime(s.end * 1000)}`).join(', ')}。请优先在这些时间范围内的歌词行选取情感词，并适当增加情感词数量。`
                    : ((_getCurrentChorus().length > 0)
                        ? `\n\n【高潮时间轴】检测到以下高潮段落：${_getCurrentChorus().map(s => `${formatTime(s.start * 1000)}-${formatTime(s.end * 1000)}`).join(', ')}。请优先在这些时间范围内的歌词行选取情感词。`
                        : '');
                const systemPrompt = buildEmotionSystemPrompt({ chorusInfo }); // ★ 第一路：仅情绪分析（排版分页已改程序化本地生成 proceduralLayout）
                const lyricSnippet = lyricsText || '(无歌词)';
                const userPrompt = `请分析这首歌：《${songTitle}》- ${artist}。歌词片段：\n${lyricSnippet}`;

                const provider = ai.provider || 'openai';
                const providerCfg = AI_PROVIDERS[provider] || AI_PROVIDERS.openai;
                const apiBase = (ai.apiBase || providerCfg.defaultBase).replace(/\/+$/, '');
                const model = ai.model || providerCfg.defaultModel;

                /* 带超时的 fetch：使用 AbortController 控制请求时限 */
                const AI_REQUEST_TIMEOUT = 90000; /* 90 秒超时 */
                const AI_MAX_RETRIES = 2;         /* 最多重试 2 次（共 3 次请求） */

                /* 推理模型检测：nemotron/o1/deepseek-r1 等需要更多 token 做思考 */
                const isReasoningModel = /nemotron|o1|o3|deepseek-r1|reasoning|think|gemini-.*2\.5|gemini-.*3\.|gemini-.*flash-thinking/i.test(model);

                /* 使用 buildAIRequest 构建 URL、headers、body（支持 OpenAI 和 Gemini 两种格式） */
                const aiReq = buildAIRequest(provider, ai.apiKey, ai.apiBase, ai.model,
                    systemPrompt, userPrompt, true, isReasoningModel,
                    (provider === 'gemini' && appSettings.ai && appSettings.ai.useProxy !== false));

                /* --- 浮动状态面板控制 --- */
                const aiPanel = typeof document !== 'undefined' ? document.getElementById('aiStatusPanel') : null;
                const aiPanelTitle = typeof document !== 'undefined' ? document.getElementById('aiStatusPanelTitle') : null;
                const aiPanelDetail = typeof document !== 'undefined' ? document.getElementById('aiStatusPanelDetail') : null;
                const aiPanelOutput = typeof document !== 'undefined' ? document.getElementById('aiStatusOutput') : null;
                const aiSpinner = typeof document !== 'undefined' ? document.getElementById('aiStatusSpinner') : null;
                const aiProgressFill = typeof document !== 'undefined' ? document.getElementById('aiStatusProgressFill') : null;

                function showAiPanel(title, detail) {
                    if (!aiPanel) return;
                    aiPanelTitle.textContent = title;
                    aiPanelDetail.textContent = detail || '';
                    aiPanelOutput.textContent = '';
                    aiProgressFill.style.width = '0%';
                    aiSpinner.className = 'ai-status-spinner';
                    aiPanel.classList.add('visible');
                }
                function hideAiPanel(delay) {
                    if (!aiPanel) return;
                    setTimeout(() => aiPanel.classList.remove('visible'), delay || 0);
                }
                function setAiPanelOutput(text) {
                    if (!aiPanelOutput) return;
                    aiPanelOutput.textContent = text;
                    /* 自动滚动到底部 */
                    aiPanelOutput.scrollTop = aiPanelOutput.scrollHeight;
                }
                function setAiPanelProgress(pct) {
                    if (aiProgressFill) aiProgressFill.style.width = Math.min(100, pct) + '%';
                }
                function setAiPanelDone(title, detail) {
                    if (aiPanelTitle) aiPanelTitle.textContent = title;
                    if (aiPanelDetail) aiPanelDetail.textContent = detail || '';
                    if (aiSpinner) aiSpinner.className = 'ai-status-spinner done';
                    setAiPanelProgress(100);
                }
                function setAiPanelError(title, detail) {
                    if (aiPanelTitle) aiPanelTitle.textContent = title;
                    if (aiPanelDetail) aiPanelDetail.textContent = detail || '';
                    if (aiSpinner) aiSpinner.className = 'ai-status-spinner error';
                }

                /* 启动时显示浮动面板 */
                showAiPanel(t('ai.analyzing', 'AI 正在分析...'), `《${songTitle}》- ${artist}`);

                let response = null;
                let lastError = null;
                /* ★ 修复：预先声明 timeoutId 和 controller，避免 finally 块中引用未定义变量 */
                let timeoutId = null;
                let controller = null;

                try {
                    logInfo('settingsPanel', `AI 分析开始: ${cacheKey} (服务商: ${provider}, 模型: ${model}, 接口: ${apiBase})`);

                    /* 重试循环：网络超时/连接失败时自动重试，HTTP 错误码不重试 */
                    for (let attempt = 0; attempt <= AI_MAX_RETRIES; attempt++) {
                        if (attempt > 0) {
                            const delay = 2000 * Math.pow(2, attempt - 1); /* 2s, 4s */
                            logInfo('settingsPanel', `AI 分析第 ${attempt + 1} 次尝试（等待 ${delay}ms 后重试）...`);
                            if (statusDetail) statusDetail.textContent = `正在重试 (${attempt + 1}/${AI_MAX_RETRIES + 1})...`;
                            showAiPanel(`AI 重试中 (${attempt + 1}/${AI_MAX_RETRIES + 1})`, `《${songTitle}》- ${artist}`);
                            await new Promise(r => setTimeout(r, delay));
                        }

                        controller = new AbortController();
                        state.currentAiAbortController = controller;
                        /* 标记：是否由我们的超时触发的 abort（区分浏览器外部 abort） */
                        let isTimeoutAbort = false;
                        timeoutId = setTimeout(() => {
                            isTimeoutAbort = true;
                            controller.abort();
                        }, AI_REQUEST_TIMEOUT);

                        try {
                            response = await fetch(aiReq.url, {
                                method: 'POST',
                                headers: aiReq.headers,
                                body: aiReq.body,
                                signal: controller.signal
                            });
                            clearTimeout(timeoutId);
                            /* ★ 不在此处清除 state.currentAiAbortController，交给 finally 统一处理
                               避免 finally 中 state.currentAiAbortController === controller 判断失败导致 state.isAiAnalyzing 卡死 */
                            break; /* 请求成功（不管 HTTP 状态码），跳出重试循环 */
                        } catch (fetchErr) {
                            clearTimeout(timeoutId);
                            /* ★ 同理：不在此处清除 state.currentAiAbortController */
                            lastError = fetchErr;
                            /* 手动取消（被新请求取代）：不重试，直接静默退出 */
                            if (controller._manualCancel) {
                                logInfo('settingsPanel', 'AI 请求被手动取消（被新请求取代）');
                                return null;
                            }
                            /* AbortError 分两种情况：
                               1. isTimeoutAbort=true → 我们的超时，可以重试
                               2. isTimeoutAbort=false → 浏览器外部 abort（CORS/跟踪防护），不可重试 */
                            if (fetchErr.name === 'AbortError' && !isTimeoutAbort) {
                                logError('settingsPanel', 'AI 请求被浏览器中止（可能被跟踪防护/CORS拦截）:', fetchErr);
                                /* 直接抛出，不重试 */
                                const corsError = new Error('请求被浏览器拦截（可能是跨域限制或隐私保护）。请更换 API 地址，或改用支持跨域的代理');
                                corsError.name = 'AbortError';
                                corsError._externalAbort = true;
                                throw corsError;
                            }
                            /* 判断是否值得重试：超时可重试，连接失败可重试 */
                            const isRetryable = (fetchErr.name === 'AbortError' && isTimeoutAbort) ||
                                (fetchErr.name === 'TypeError' && fetchErr.message.includes('Failed to fetch'));
                            if (!isRetryable || attempt === AI_MAX_RETRIES) {
                                throw fetchErr; /* 不可重试或已用完重试次数，直接抛出 */
                            }
                            logWarn('settingsPanel', `AI 请求失败（第 ${attempt + 1} 次），将重试:`, fetchErr.message);
                        }
                    }

                    if (!response) throw lastError || new Error('请求失败');

                    if (!response.ok) {
                        const errText = await response.text();
                        logError('settingsPanel', 'AI API 返回错误:', response.status, errText);
                        let errMsg = t('ai.analysisFailed', 'AI 分析失败');
                        if (response.status === 401) errMsg = t('ai.err401', 'API 密钥无效，请检查设置');
                        else if (response.status === 429) errMsg = t('ai.err429', 'API 调用频率超限，请稍后再试');
                        else if (response.status === 500) errMsg = t('ai.err500', 'AI 服务器内部错误');
                        else if (response.status === 404) errMsg = `${t('ai.err404', 'API 地址或模型不存在')}（${apiBase}）`;
                        /* ★ 附上 err code 与原始报错片段：只有友好文案无法定位问题 */
                        try {
                            const snippet = (errText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
                            errMsg += `（HTTP ${response.status}${snippet ? '：' + snippet : ''}）`;
                        } catch (_e) { logCatch('settingsPanel', _e); }
                        _hooks.showSettingsHint(errMsg);
                        setAiPanelError(t('ai.statusFailed', '分析失败'), errMsg);
                        if (statusText) statusText.textContent = t('ai.statusFailed', '分析失败');
                        if (statusDetail) statusDetail.textContent = errMsg;
                        hideAiPanel(3000);
                        return null;
                    }

                    /* ===== 流式读取 SSE 响应 ===== */
                    /* 逐行读取 data: {...} 格式的 SSE 事件，实时更新浮动面板 */
                    let content = '';
                    let streamError = null;
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';
                    let chunkCount = 0;
                    /* ★ 情感词流式提前上色：开第一路门控 */
                    _emotionStreamGate = true;

                    try {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;

                            buffer += decoder.decode(value, { stream: true });
                            const lines = buffer.split('\n');
                            /* 最后一行可能不完整，保留在 buffer */
                            buffer = lines.pop() || '';

                            for (const line of lines) {
                                const trimmed = line.trim();
                                if (!trimmed || trimmed.startsWith(':')) continue; /* 空行或注释 */
                                if (!trimmed.startsWith('data:')) continue;

                                const dataStr = trimmed.slice(5).trim();
                                if (dataStr === '[DONE]') {
                                    /* 流结束 */
                                    continue;
                                }

                                try {
                                    const chunk = JSON.parse(dataStr);
                                    chunkCount++;

                                    /* 使用 extractAIStreamChunk 提取文本（兼容 OpenAI 和 Gemini 格式） */
                                    const { text: chunkText, finishReason } = extractAIStreamChunk(provider, chunk);
                                    if (chunkText) {
                                        content += chunkText;
                                        /* 实时更新浮动面板：显示已接收的文本 */
                                        setAiPanelOutput(content);
                                        /* ★ 情感词流式提前上色（防抖 partial JSON 解析） */
                                        _scheduleStreamEmotion(content);
                                    }

                                    /* 更新进度条（基于已接收的 chunk 数估算） */
                                    const maxChunks = isReasoningModel ? 200 : 80;
                                    setAiPanelProgress(Math.min(90, (chunkCount / maxChunks) * 100));

                                    /* 检测 finish_reason */
                                    if (finishReason) {
                                        /* OpenAI: 'stop' / 'length'; Gemini: 'STOP' / 'MAX_TOKENS' */
                                        const fr = finishReason.toLowerCase();
                                        if (fr === 'stop') {
                                            setAiPanelProgress(95);
                                        } else if (fr === 'length' || fr === 'max_tokens') {
                                            streamError = 'length';
                                        }
                                    }

                                    /* 检测错误 */
                                    if (chunk.error) {
                                        streamError = chunk.error.message || JSON.stringify(chunk.error);
                                    }
                                } catch (e) {
                                    /* 单行 JSON 解析失败，跳过 */
                                }
                            }
                        }
                    } catch (streamErr) {
                        logWarn('settingsPanel', '流式读取异常，尝试回退到非流式解析:', streamErr);
                        /* 如果已经接收了部分内容，继续使用；否则回退 */
                        if (!content) {
                            /* 流式完全失败，回退到非流式 */
                            response = null; /* 标记需要重新请求 */
                            throw streamErr;
                        }
                    }

                    logInfo('settingsPanel', `AI 流式接收完成: ${chunkCount} chunks, ${content.length} chars`);

                    /* ★ 第一路流式结束：关闭增量上色门（完整结果由既有路径应用，覆盖增量值） */
                    _emotionStreamGate = false;
                    if (_emotionStreamTimer) { clearTimeout(_emotionStreamTimer); _emotionStreamTimer = null; }

                    /* 如果流式没拿到内容，尝试回退到非流式重新请求 */
                    if (!content.trim() && !streamError) {
                        logWarn('settingsPanel', '流式返回内容为空，回退到非流式请求');
                        /* 使用 buildAIRequest 构建非流式请求（兼容 OpenAI 和 Gemini） */
                        const fallbackReq = buildAIRequest(provider, ai.apiKey, ai.apiBase, ai.model,
                            systemPrompt, userPrompt, false, isReasoningModel,
                            (provider === 'gemini' && appSettings.ai && appSettings.ai.useProxy !== false));
                        const fallbackController = new AbortController();
                        const fallbackTimeout = setTimeout(() => fallbackController.abort(), AI_REQUEST_TIMEOUT);
                        try {
                            const fallbackResp = await fetch(fallbackReq.url, {
                                method: 'POST',
                                headers: fallbackReq.headers,
                                body: fallbackReq.body,
                                signal: fallbackController.signal
                            });
                            clearTimeout(fallbackTimeout);
                            if (fallbackResp.ok) {
                                const fallbackData = await fallbackResp.json();
                                logInfo('settingsPanel', '非流式返回:', JSON.stringify(fallbackData).substring(0, 2000));
                                /* 使用 extractAIResponseText 提取内容（兼容两种格式） */
                                content = extractAIResponseText(provider, fallbackData);
                            }
                        } catch (fbErr) {
                            clearTimeout(fallbackTimeout);
                            logError('settingsPanel', '非流式回退也失败:', fbErr);
                        }
                    }

                    /* 调试日志 */
                    logInfo('settingsPanel', 'AI 最终内容:', content.substring(0, 500));

                    /* ★ 截断续传 + 拼接：模型因输出长度限制（max_tokens/length）被截断时，
                       把已生成的部分喂回给模型紧接断点继续补全，逐轮拼接直到拿到完整 JSON。
                       这样无论模型输出上限是多少（1.5-flash=8192 / 推理模型更少），都能完整生成。 */
                    if (streamError === 'length' && content && content.trim()) {
                        logWarn('settingsPanel', 'AI 输出因长度限制被截断，启动续传拼接...');
                        const base = {
                            provider, apiKey: ai.apiKey, apiBase: ai.apiBase, model: ai.model, systemPrompt, userPrompt
                        };
                        const stitched = await completeTruncatedContent(base, content, provider, isReasoningModel);
                        if (stitched && stitched.parsed) {
                            content = stitched.content;
                            streamError = null; /* 已拿到完整 JSON */
                            setAiPanelProgress(100);
                            logInfo('settingsPanel', '续传拼接成功，得到完整分析结果。');
                        } else {
                            logWarn('settingsPanel', '续传未得到完整 JSON，退回首次输出');
                        }
                    }

                    if (!content || !content.trim()) {
                        logError('settingsPanel', 'AI 返回内容为空, streamError:', streamError);
                        let errMsg = 'AI 返回内容为空';
                        if (streamError === 'length') {
                            errMsg = 'AI 返回被截断（max_tokens 太小），请尝试减小歌词片段';
                        } else if (streamError) {
                            errMsg = `AI 服务报错: ${streamError}`;
                        }
                        _hooks.showSettingsHint(errMsg);
                        setAiPanelError('分析失败', errMsg);
                        if (statusText) statusText.textContent = '分析失败';
                        if (statusDetail) statusDetail.textContent = errMsg;
                        hideAiPanel(3000);
                        return null;
                    }

                    /* 从返回内容中提取 JSON（兼容 AI 可能包裹 ```json 的情况） */
                    let jsonStr = content.trim();
                    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
                    if (jsonMatch) jsonStr = jsonMatch[0];

                    let themeObj;
                    try {
                        themeObj = JSON.parse(jsonStr);
                    } catch (parseErr) {
                        /* ★ 截断兜底：只要 JSON 解析失败且已收到部分内容就启动「续传拼接」，
                           处理所有截断形式（max_tokens / 中途断流 / 网络抖动 / 服务端静默停止），
                           而不只限于 finish_reason='length'（该情况已在上面尝试过一轮） */
                        if (streamError !== 'length' && content && content.trim()) {
                            logWarn('settingsPanel', 'AI 首轮 JSON 解析失败（streamError=' + streamError + '），尝试续传拼接完整结果...');
                            const base = {
                                provider, apiKey: ai.apiKey, apiBase: ai.apiBase, model: ai.model, systemPrompt, userPrompt
                            };
                            const stitched = await completeTruncatedContent(base, content, provider, isReasoningModel);
                            if (stitched && stitched.parsed) {
                                content = stitched.content;
                                jsonStr = content.trim();
                                const m2 = jsonStr.match(/\{[\s\S]*\}/);
                                if (m2) jsonStr = m2[0];
                                try {
                                    themeObj = JSON.parse(jsonStr);
                                    setAiPanelProgress(100);
                                    logInfo('settingsPanel', '续传拼接成功，得到完整分析结果。');
                                } catch (e2) {
                                    themeObj = null;
                                }
                            }
                        }
                        if (!themeObj) {
                            logError('settingsPanel', 'AI 返回 JSON 解析失败:', parseErr, '\n原始内容:', content);
                            _hooks.showSettingsHint('返回格式异常，无法解析');
                            setAiPanelError('分析失败', 'AI 返回格式异常，无法解析');
                            if (statusText) statusText.textContent = '分析失败';
                            if (statusDetail) statusDetail.textContent = '返回格式异常';
                            hideAiPanel(3000);
                            return null;
                        }
                    }

                    /* 校验必要字段 */
                    if (!themeObj.primary_color || !themeObj.animation_style) {
                        logError('settingsPanel', 'AI 返回 JSON 缺少必要字段:', themeObj);
                        _hooks.showSettingsHint('返回数据不完整');
                        setAiPanelError('分析失败', 'AI 返回数据不完整');
                        if (statusText) statusText.textContent = '分析失败';
                        if (statusDetail) statusDetail.textContent = '返回数据不完整';
                        hideAiPanel(3000);
                        return null;
                    }

                    /* ★ 新增：对 emotion_words 进行数据清洗
                       即使 prompt 要求了严格规则，AI 仍可能返回带空格/标点的脏数据
                       在这里做最终保障：去标点、去空格、过滤无效条目 */
                    if (Array.isArray(themeObj.emotion_words)) {
                        const cleanedWords = [];
                        const seenWords = new Set(); /* 去重 */
                        for (const ew of themeObj.emotion_words) {
                            if (!ew || !ew.word || !ew.color) continue;
                            let word = String(ew.word).trim();
                            /* 去除所有标点、擞号、连字符（保留字母、数字、中文字符） */
                            word = word.replace(/[\s\p{P}\p{S}'']/gu, '');
                            if (!word) continue;
                            /* 去重：相同 word（不区分大小写）只保留第一个，因为情感词会在全文所有行渲染着色 */
                            const dedupeKey = word.toLowerCase();
                            if (seenWords.has(dedupeKey)) continue;
                            seenWords.add(dedupeKey);
                            cleanedWords.push({
                                word: word,
                                /* 机制兜底：LLM 即使输出荧光色也压回高级感（S≤0.75 + 亮度可读带） */
                                color: normalizeEmotionColor(ew.color),
                                emotion: ew.emotion || '',
                                line: typeof ew.line === 'number' ? ew.line : null
                            });
                        }
                        themeObj.emotion_words = cleanedWords;
                        logInfo('settingsPanel', '[AI清洗] emotion_words 清洗后:', cleanedWords.length, '条（原' + (themeObj.emotion_words?.length || 0) + '条）');
                    }

/* ★ 情感词「流式提前上色」：第一路请求还在流式传输时，用「补全 JSON 括号」的容错解析
   从增量文本中提前提取 emotion_words 并立即上色（尤其 PV 模式不等蒙德里安/不等完整 JSON）。
   防抖 300ms 防过度消耗；门控 _emotionStreamGate 只在第一路流式期间为真，
   完整结果就绪后由 L1802 的既有路径覆盖增量值。
   ★ 门控三态必须用 var（提升即初始化 undefined，无 TDZ）：曾报
   "Cannot access '_emotionStreamGate' before initialization" —— 分片环/重载时序下
   流式回调可能在 let 声明执行前写入，var + 惰性时序逻辑天然免疫。 */
var _emotionStreamGate = false;
var _emotionStreamTimer = null;
var _emotionStreamSig = '';
function _tryParseStreamEmotionWords(raw) {
    if (!raw || typeof raw !== 'string' || !raw.trim()) return null;
    /* 逐级补全括号：JSON 被截断在任意位置时，依次闭合 }/]/引号直到可解析 */
    const candidates = [raw, raw + '}', raw + '}}', raw + ']', raw + '"}', raw + '"}]', raw + '"]}', raw + ']"}'];
    for (let n = 0; n < candidates.length; n++) {
        let obj = null;
        try { obj = JSON.parse(candidates[n]); } catch (_e) { continue; }
        if (!obj || typeof obj !== 'object') continue;
        const w = (obj.emotion_words)
            || (obj.theme && obj.theme.emotion_words)
            || (obj.payload && obj.payload.emotion_words)
            || (obj.data && obj.data.emotion_words);
        if (Array.isArray(w) && w.length) return w;
    }
    return null;
}
function _scheduleStreamEmotion(content) {
    if (!_emotionStreamGate || _emotionStreamTimer || !content || !content.trim()) return;
    _emotionStreamTimer = setTimeout(() => {
        _emotionStreamTimer = null;
        if (!_emotionStreamGate) return;
        try {
            const words = _tryParseStreamEmotionWords(content.trim());
            if (!words || !words.length) return;
            const norm = words
                .map(w => (typeof w === 'string' ? { word: w, color: normalizeEmotionColor('#ff2a6d') } : { word: w && w.word, color: normalizeEmotionColor((w && w.color) || '#ff2a6d') }))
                .filter(w => w.word && String(w.word).trim());
            if (!norm.length) return;
            const sig = `${norm.length}:${norm[0].word}`;
            if (sig === _emotionStreamSig) return;
            _emotionStreamSig = sig;
            state.aiEmotionWords = norm;
            if (typeof ensureEmotionWordStyle === 'function') ensureEmotionWordStyle();
            if (typeof applyEmotionWordColors === 'function') applyEmotionWordColors();
            
            logInfo('settingsPanel', `[AI流式] 情感词提前上色 ${norm.length} 词（防抖 partial JSON）`);
        } catch (_e) { /* 流式增量解析纯增益，任何异常忽略 */ }
    }, 300);
}

/* ★ 情感词即时显示：第一路情绪结果已就绪，立即把情感词着色渲染到歌词，
   不等第二路「蒙德里安排版」生成完（避免观众等待期间界面无任何响应） */
if (themeObj && Array.isArray(themeObj.emotion_words) && themeObj.emotion_words.length > 0) {
    try {
        state.aiEmotionWords = themeObj.emotion_words;
        state.currentAiTheme = { ...(state.currentAiTheme || {}), ...themeObj };
        /* ★ 先注入情感词 CSS 规则（.word-emotion 着色样式由 applyAITheme 里的
           #ai-emotion-word-style 提供；不先注入则 class 无样式，情感词要等蒙德里安
           完成才可见——已抽为 ensureEmotionWordStyle 提前调用） */
        if (typeof ensureEmotionWordStyle === 'function') ensureEmotionWordStyle();
        if (typeof applyEmotionWordColors === 'function') applyEmotionWordColors();
        
        logInfo('settingsPanel', '[AI] 情感词已即时着色', themeObj.emotion_words.length, '条');
    } catch (e) { logWarn('settingsPanel', '[AI] 即时情感词着色失败:', e); }
}

/* ★ 程序化排版（folia 作者方案）：排版本是「文字分词测量 + 二维搜索」的确定性计算，
   不需要 LLM——分页/换行/对齐/情绪能量全部本地即时生成，零网络、零成本、零截断、零等待。
   依赖：emotion_words（第一路结果，锚定分词）、副歌区间与 BPM（chorusDetector，调制能量）。
   输出与旧 AI line_analyses 完全同构，隧道/蒙德里安引擎零改动。 */
if (themeObj && !Array.isArray(themeObj.line_analyses)) {
    try {
        const layoutRes = generateLineAnalyses(state.lyrics || [], {
            emotionWords: themeObj.emotion_words || [],
            chorusSegments: (_getFullChorus() && _getFullChorus().length > 0)
                ? _getFullChorus()
                : (_getCurrentChorus() || []),
            bpm: (_getAudioRhythm() && typeof _getAudioRhythm().bpm === 'number') ? _getAudioRhythm().bpm : null
        });
        themeObj.line_analyses = layoutRes.line_analyses;
        if (_getAudioRhythm()) themeObj.rhythm = _getAudioRhythm();
        logInfo('settingsPanel', '程序化排版 line_analyses 已生成:', themeObj.line_analyses.length, '项',
            'BPM:', themeObj.rhythm ? themeObj.rhythm.bpm : 'n/a');
    } catch (layoutErr) {
        /* 程序化排版是纯本地计算，异常只可能是脏数据——降级为无 line_analyses
           （隧道引擎有自己的规则分页兜底），不影响已生成的情绪分析结果 */
        logWarn('settingsPanel', '程序化排版生成异常（情绪分析结果已保留）:', layoutErr && layoutErr.message);
    }
}

/* 缓存结果：同时写入内存和 IndexedDB */
state.aiThemeCache[cacheKey] = themeObj;
aiCacheSet(cacheKey, themeObj); /* 异步写入，不阻塞 */
/* 更新缓存数量显示 */
aiCacheCount().then(cnt => {
const cacheInfoEl = typeof document !== 'undefined' ? document.getElementById('aiCacheInfo') : null;
if (cacheInfoEl) cacheInfoEl.textContent = `已缓存 ${cnt} 首歌曲的分析结果`;
});
logInfo('settingsPanel', 'AI 分析成功:', cacheKey, 'emotion_words:', themeObj.emotion_words?.length, 'mood:', themeObj.mood, '完整结果:', JSON.stringify(themeObj).substring(0, 300));

/* 更新 UI 状态 */
if (statusText) statusText.textContent = t('ai.statusDone', '分析完成');
if (statusDetail) statusDetail.textContent = themeObj.description || `${t('ai.moodLabel', '情绪：')}${themeObj.mood || t('common.unknown', '未知')} · ${t('ai.styleLabel', '风格：')}${themeObj.animation_style}`;

                    /* 更新设置面板与浮动面板的主题预览 */
                    updateAiSettingsPreview(themeObj, t('ai.statusDone', '分析完成'), themeObj.description || `${t('ai.moodLabel', '情绪：')}${themeObj.mood || t('common.unknown', '未知')} · ${t('ai.styleLabel', '风格：')}${themeObj.animation_style}`);
                    setAiPanelDone(t('ai.doneTitle', 'AI 分析完成'), themeObj.description || `${t('ai.moodLabel', '情绪：')}${themeObj.mood || t('common.unknown', '未知')} · ${themeObj.animation_style}`);
                    hideAiPanel(5000);  /* 5 秒后自动收起 */

                    return themeObj;
                } catch (err) {
                    logError('settingsPanel', 'AI 分析请求失败:', err);
                    let errMsg = t('ai.analysisFailed', 'AI 分析失败');
                    if (err._externalAbort) {
                        errMsg = err.message;
                    } else if (err.name === 'AbortError') {
                        errMsg = `请求超时（${AI_REQUEST_TIMEOUT / 1000} 秒），请检查网络或更换 API 地址`;
                    } else if (err.name === 'TypeError' && err.message.includes('Failed to fetch')) {
                        errMsg = `无法连接到 ${apiBase}，请检查 API 地址是否正确`;
                    }
                    _hooks.showSettingsHint(errMsg);
                    setAiPanelError('分析失败', errMsg);
                    if (statusText) statusText.textContent = '分析失败';
                    if (statusDetail) statusDetail.textContent = errMsg;
                    hideAiPanel(3000);
                    return null;
                } finally {
                    clearTimeout(timeoutId);
                    /* 只在当前请求仍是活跃请求时重置状态，避免取消旧请求后 finally 误重新设新请求的状态 */
                    if (state.currentAiAbortController === controller) {
                        state.isAiAnalyzing = false;
                        state.currentAiAbortController = null;
                    }
                }
            }

            /* ★ 情感词 CSS 规则（.word-emotion / .lrc-emotion-word 着色样式）的创建/刷新函数。
   提取自 applyAITheme：即时上色块（第一路情绪结果就绪时）必须先调用它，
   否则 applyEmotionWordColors 只加 class 没有对应 CSS，情感词要等第二路蒙德里安
   applyAITheme 执行后才可见（原 bug：情感词延迟到蒙德里安完成后才上色）。 */
function ensureEmotionWordStyle() {
    if (typeof document === 'undefined') return;
    let emotionStyle = document.getElementById('ai-emotion-word-style');
    if (!emotionStyle) {
        emotionStyle = document.createElement('style');
        emotionStyle.id = 'ai-emotion-word-style';
        document.head.appendChild(emotionStyle);
    }
    emotionStyle.textContent = `
/* ★ 发光永不截断：激活行/发光词不携带 filter（blur 会裁切发光）、丢弃 paint 包含、溢出不裁切 */
.lyrics-area-wrapper, .lyrics-container { overflow: clip !important; overflow-clip-margin: 96px !important; }
.view-wordcloud .lyrics-area-wrapper, .view-wordcloud .lyrics-container { overflow: clip !important; overflow-clip-margin: 96px !important; }
.line { overflow: visible !important; contain: none !important; }
.line.blur-d0, .line.active, .line.active:hover { filter: none !important; }
.lrc-original, .words-container, .lrc-translation, .lrc-romaji { overflow: visible !important; contain: none !important; }
.word, .word.word-emotion, .word.word-emotion > span:last-child { overflow: visible !important; contain: none !important; }
.width-wrap { overflow: visible !important; }

/* 逐字歌词：情感词仅在【当前高亮行、且被逐字高亮扫到的词】上显示情感色，非高亮行完全隐藏 */
.word.word-emotion > span:last-child { color: inherit; opacity: 1; text-shadow: none; transition: color 0.3s ease, opacity 0.3s ease, text-shadow 0.3s ease; }
.word.word-emotion .word-highlight { color: var(--highlight-color, #fff) !important; transition: color 0.3s ease; }
.word.word-emotion { overflow: visible !important; }
.word.word-emotion .word-highlight { contain: none !important; }

/* 仅高亮行中已被扫到的情感词亮起（★ 性能优化：精简为双层紧凑发光，杜绝多层高斯模糊掉帧。
   注意：will-change/translateZ 合成层提升只保留在词云模式——该模式整页 3D zoom 补间
   需要独立栅格层才不会每帧重绘模糊；其余模式每次切行都创建/销毁合成层（层 churn）
   反而引入微卡顿，纯 text-shadow 即可） */
.line.active .word.word-emotion.active > span:last-child {
    color: var(--emotion-color) !important;
    opacity: 1 !important;
    text-shadow: 0 0 var(--emotion-glow, 8px) var(--emotion-color),
                 0 0 calc(var(--emotion-glow, 8px) * 1.6) var(--emotion-color) !important;
}
.line.active .word.word-emotion.active .word-highlight {
    color: var(--emotion-color) !important;
    text-shadow: none !important;
    contain: none !important;
}

/* ★ 词云模式特化性能保障：词云画布整屏逐帧进行 3D 摄像机与 zoom 补间，
   发光收敛为轻量单层 + 独立合成层（translateZ），避免 Skia 每帧对模糊文本重栅格 */
.view-wordcloud .line.active .word.word-emotion.active > span:last-child {
    text-shadow: 0 0 8px var(--emotion-color) !important;
    will-change: transform, opacity;
    transform: translateZ(0);
}

/* 纯文本歌词：情感词仅在当前高亮行显示，离开高亮行即恢复普通色 */
.lrc-emotion-word { color: inherit; opacity: 1; text-shadow: none; transition: opacity 0.3s ease, text-shadow 0.3s ease, color 0.3s ease; font-weight: inherit; overflow: visible !important; }
.line.active .lrc-emotion-word {
    color: var(--emotion-color) !important;
    opacity: 1 !important;
    text-shadow: 0 0 var(--emotion-glow, 8px) var(--emotion-color),
                 0 0 calc(var(--emotion-glow, 8px) * 1.6) var(--emotion-color) !important;
}
.view-wordcloud .line.active .lrc-emotion-word {
    text-shadow: 0 0 8px var(--emotion-color) !important;
    will-change: transform, opacity;
    transform: translateZ(0);
}
`;
}

// --- Emotion Word Coloring ---
            /* 将 AI 返回的情感关键词颜色应用到歌词 DOM 元素上
               按行号精确定位：只在 AI 指定的行内着色，避免同一词在全文重复着色 */
            function applyEmotionWordColors() {
                /* ★ 节流：该函数会全量扫描+重建所有歌词行的情感词（遍历 DOM 建字符映射），
                   歌词滚动/每行渲染都会触发，高频执行是「情感词上色卡顿」根因。
                   这里用时间闸把两次调用最小间隔限制到 100ms（切歌/换源会重置后正常执行）。 */
                const now = Date.now();
                if (typeof applyEmotionWordColors.__t === 'number' && now - applyEmotionWordColors.__t < 100) return;
                applyEmotionWordColors.__t = now;
                /* ★ 零开销守卫（2026-09-22 性能）：从未应用过情感词（无 AI 数据）时，
                   直接返回——原先即使 state.aiEmotionWords 为空也要先做三段全量 DOM 清理
                   （querySelectorAll×3 + replaceChild + normalize），每次歌词重渲
                   白扫数千节点大 DOM。 */
                if (!(state.aiEmotionWords && aiEmotionWords.length > 0) && !applyEmotionWordColors.__hasApplied) return;
                logInfo('settingsPanel', '[EmotionWord] 开始应用情感词，state.aiEmotionWords数量:', aiEmotionWords?.length, 'lyrics行数:', state.lyrics?.length);
                const mainScroll = typeof document !== 'undefined' ? document.getElementById('lyricsScroll') : null;
                if (!mainScroll) return;
                /* 先清除旧的情感词标记 */
                mainScroll.querySelectorAll('.word-emotion').forEach(el => {
                    el.classList.remove('word-emotion');
                    el.style.removeProperty('--emotion-color');
                });
                mainScroll.querySelectorAll('.lrc-emotion-word').forEach(el => {
                    const parent = el.parentNode;
                    if (parent) {
                        parent.replaceChild(document.createTextNode(el.textContent), el);
                        parent.normalize(); /* 合并相邻文本节点 */
                    }
                });
                /* 清除 emotionProcessed 标记，使下次可重新处理 */
                mainScroll.querySelectorAll('.lrc-original[data-emotion-processed]').forEach(el => {
                    delete el.dataset.emotionProcessed;
                });

                if (!state.aiEmotionWords || aiEmotionWords.length === 0) {
                    logInfo('settingsPanel', '[EmotionWord] state.aiEmotionWords为空，跳过应用');
                    return;
                }
                applyEmotionWordColors.__hasApplied = true;

                /* 情感词组计数器，用于标记同一情感词的多个 word 元素（整组同时激活） */
                let emotionGroupCounter = 0;

                /* 构建查找表：word → color，按词长度降序排列（优先匹配长词） */
                const emotionEntries = state.aiEmotionWords
                    .filter(ew => ew.word && ew.color)
                    .map(ew => ({ word: ew.word, color: ew.color, line: typeof ew.line === 'number' ? ew.line : null }))
                    .sort((a, b) => b.word.length - a.word.length);
                if (emotionEntries.length === 0) {
                    logInfo('settingsPanel', '[EmotionWord] emotionEntries为空（过滤后无有效条目），跳过应用');
                    return;
                }
                logInfo('settingsPanel', '[EmotionWord] 有效情感词条目数:', emotionEntries, '逐字歌词行数:', wordElementsByLine.length);

                /* ★★ 兜底注入情感词样式表（用户报「情感词不显示」的根因之一）。
                   `#ai-emotion-word-style` 原先**只在 `applyAITheme` 里创建**：
                   而"第一路情绪结果先到"的即时上色路径会直接调本函数 ——
                   此时规则还不存在，class 加上了、颜色/发光规则却没有 ⇒ 视觉上等于没有情感词。
                   （某些模式偶尔正常，只是因为切模式顺带跑过一次 applyAITheme。）
                   样式表本身是幂等的，重复调用只改写 textContent。 */
                if (typeof ensureEmotionWordStyle === 'function') ensureEmotionWordStyle();

                /* 辅助函数：检查空格分词语言的词边界（避免 love 匹配到 Glover 中的 love）
                   中文/日文/韩文不需要词边界检查，因为字符本身就是独立的字 */
                const isLatinWord = (w) => /[\p{L}]/u.test(w) && !/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/u.test(w);
                const hasWordBoundary = (text, matchIdx, wordLen) => {
                    /* 检查匹配位置前一个字符是否为字母 */
                    if (matchIdx > 0 && /[\p{L}]/u.test(text[matchIdx - 1])) return false;
                    /* 检查匹配位置后一个字符是否为字母 */
                    if (matchIdx + wordLen < text.length && /[\p{L}]/u.test(text[matchIdx + wordLen])) return false;
                    return true;
                };

                /* 1. 逐字歌词：支持跨 word 元素的连续匹配（中文逐字每个 word 通常是单字）
                   同一情感词在全文所有出现位置都着色，每行仅首次出现着色
                   ★ 修复：从 .words-container 的 textContent 获取完整行文本（包含空格），
                     并建立字符位置到 .word 元素索引的精确映射 */
                for (let lineIdx = 0; lineIdx < wordElementsByLine.length; lineIdx++) {
                    const words = state.wordElementsByLine[lineIdx] || [];
                    if (words.length === 0) continue;

                    /* 找到 .words-container，通过遍历 DOM 构建完整行文本和字符→word元素映射
                       ★ 关键：.word 元素内有两个子 span（highlight + text），
                         只取 span:last-child（textEl）的文本，避免字符重复 */
                    const firstWord = words[0];
                    const wordsContainer = firstWord && firstWord.closest('.words-container');
                    if (!wordsContainer) continue;

                    let fullText = '';
                    const charToWordIdx = [];
                    {
                        const walk = (node) => {
                            if (node.nodeType === Node.TEXT_NODE) {
                                /* 非词内文本节点（如空格 span 的文本） */
                                const text = node.textContent;
                                fullText += text;
                                for (let i = 0; i < text.length; i++) charToWordIdx.push(null);
                            } else if (node.nodeType === Node.ELEMENT_NODE) {
                                if (node.classList && node.classList.contains('word')) {
                                    /* .word 元素：只取 span:last-child（textEl）的文本，跳过 highlightEl */
                                    const textEl = node.querySelector('span:last-child');
                                    const text = textEl ? textEl.textContent : '';
                                    fullText += text;
                                    const wordIdx = words.indexOf(node);
                                    for (let i = 0; i < text.length; i++) charToWordIdx.push(wordIdx >= 0 ? wordIdx : null);
                                } else {
                                    /* 其他元素（wordWrap、spaceEl 等）：递归子节点 */
                                    for (const child of node.childNodes) walk(child);
                                }
                            }
                        };
                        for (const child of wordsContainer.childNodes) walk(child);
                    }
                    if (!fullText) continue;

                    for (const { word, color } of emotionEntries) {
                        if (!word) continue;

                        /* 在当前行内查找匹配位置（带词边界检查，大小写不敏感匹配） */
                        const isLatin = isLatinWord(word);
                        let matchIdx = -1;
                        const lowerFullText = fullText.toLowerCase();
                        const lowerWord = word.toLowerCase();

                        if (isLatin) {
                            /* Latin 词：遍历所有匹配位置，找到第一个满足词边界的 */
                            let searchFrom = 0;
                            while (searchFrom <= lowerFullText.length - lowerWord.length) {
                                const idx = lowerFullText.indexOf(lowerWord, searchFrom);
                                if (idx === -1) break;
                                if (hasWordBoundary(fullText, idx, lowerWord.length)) {
                                    matchIdx = idx;
                                    break;
                                }
                                searchFrom = idx + 1;
                            }
                        } else {
                            /* 中文/日文/韩文词：大小写不敏感子串匹配 */
                            matchIdx = lowerFullText.indexOf(lowerWord);
                        }
                        if (matchIdx === -1) continue;

                        /* 通过映射表找到匹配范围对应的 .word 元素索引 */
                        const startWordIdx = charToWordIdx[matchIdx];
                        const endWordIdx = charToWordIdx[matchIdx + word.length - 1];

                        /* ★ 安全检查：匹配范围跨越的 word 元素数量不应超过情感词字符数
                           每个 word 至少包含 1 个字符，所以 N 字符的情感词最多匹配 N 个 word
                           超过此范围说明 charToWordIdx 映射有误（如阿拉伯语整词场景），
                           跳过标记避免整行被错误标记为情感词 */
                        if (startWordIdx !== null && startWordIdx >= 0 && endWordIdx !== null && endWordIdx >= 0) {
                            const spanCount = endWordIdx - startWordIdx + 1;
                            if (spanCount > word.length) {
                                logWarn('settingsPanel', '[EmotionWord] 跳过可疑匹配: 情感词"', word, '"长度', word.length, '但跨越', spanCount, '个word元素');
                                continue;
                            }
                            /* ★ 二次验证：拼接被标记 word 的实际文本，确认情感词确实在其中（大小写不敏感） */
                            const markedText = words.slice(startWordIdx, endWordIdx + 1).map(w => {
                                const t = w.querySelector('span:last-child');
                                return t ? t.textContent : '';
                            }).join('');
                            const lowerMarked = markedText.toLowerCase();
                            if (!lowerMarked.includes(lowerWord) && !lowerWord.includes(lowerMarked)) {
                                logWarn('settingsPanel', '[EmotionWord] 文本不匹配: 情感词"', word, '"不在被标记文本"', markedText, '"中');
                                continue;
                            }
                            const groupIdx = emotionGroupCounter++;
                            for (let wi = startWordIdx; wi <= endWordIdx; wi++) {
                                const wordEl = words[wi];
                                if (wordEl && !wordEl.classList.contains('word-emotion')) {
                                    /* ★ RTL 整词模式（阿拉伯语默认模式）：每个 .word 是一个完整阿拉伯词
                                       仅当词文本包含空格（多个词=整行）或极长（>50字）时跳过，
                                       避免整行被误标记。单个阿拉伯词即使比情感词长也允许标记 */
                                    const highlightEl = wordEl.querySelector('.word-highlight');
                                    const isRTLWholeWord = highlightEl && highlightEl.classList.contains('rtl-highlight') && !wordEl.classList.contains('word-rtl-char');
                                    if (isRTLWholeWord) {
                                        const t = wordEl.querySelector('span:last-child');
                                        const wordText = t ? t.textContent : '';
                                        if (wordText.includes(' ') || wordText.length > 50) {
                                            logWarn('settingsPanel', '[EmotionWord] RTL整词含空格或过长跳过: "', wordText, '"');
                                            continue;
                                        }
                                    }
                                    wordEl.style.setProperty('--emotion-color', color);
                                    wordEl.classList.add('word-emotion');
                                    wordEl.dataset.emotionGroup = groupIdx;
                                }
                            }
                        }
                    }
                }

                /* 2. 纯文本歌词（无逐字数据）：在 .lrc-original 中查找并包裹情感词
                   同一情感词在所有行都着色，每行仅首次出现包裹 */
                const allOriginalEls = mainScroll ? mainScroll.querySelectorAll('.lrc-original') : [];
                allOriginalEls.forEach((origEl, elIdx) => {
                    /* 跳过有 words-container 的（逐字歌词已处理） */
                    if (origEl.querySelector('.words-container')) return;
                    /* 跳过已处理的（避免重复） */
                    if (origEl.dataset.emotionProcessed) return;
                    origEl.dataset.emotionProcessed = 'true';

                    let html = origEl.innerHTML;
                    /* 按词长度降序处理，优先匹配长词（避免短词破坏长词匹配） */
                    for (const { word, color } of emotionEntries) {
                        if (!word) continue;

                        const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        /* 使用空格分词的语言（拉丁/西里尔/希腊等）用 \b 词边界，避免 love 匹配到 Glover；中文直接匹配 */
                        const isLatin = /[\p{L}]/u.test(word) && !/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/u.test(word);
                        const pattern = isLatin ? `\\b${escaped}\\b` : escaped;
                        /* 仅替换不在 HTML 标签内的文本（避免破坏已有 span），大小写不敏感匹配，只替换首次出现 */
                        let replaced = false;
                        html = html.replace(new RegExp(pattern, 'gi'), (match, offset, full) => {
                            if (replaced) return match; /* 仅首次出现 */
                            const before = full.substring(0, offset);
                            const lastLt = before.lastIndexOf('<');
                            const lastGt = before.lastIndexOf('>');
                            if (lastLt > lastGt) return match; /* 在标签内，跳过 */
                            replaced = true;
                            return `<span class="lrc-emotion-word" style="--emotion-color: ${color};">${match}</span>`;
                        });
                    }
                    origEl.innerHTML = html;
                });
            }

            // --- Theme Application ---

            /* 将 AI 返回的视觉参数应用到歌词效果上（严格限制仅情感词着色与PV引擎，绝不篡改全局主题与默认视图） */
            function applyAITheme(themeObj) {
                if (!themeObj) return;

                /* 清理任何遗留的全局侵入式类名与DOM元素，确保默认模式纯净不受干扰 */
                document.body.classList.remove(
                    'ai-text-shadow-low', 'ai-text-shadow-medium', 'ai-text-shadow-high',
                    'ai-theme-breathing', 'ai-theme-floating', 'ai-theme-glitch', 'ai-theme-smooth', 'ai-theme-flyin'
                );
                const existingWireframes = typeof document !== 'undefined' ? document.getElementById('ai-flyin-wireframes') : null;
                if (existingWireframes) existingWireframes.remove();
                const existingBlur = typeof document !== 'undefined' ? document.getElementById('ai-lyric-blur-style') : null;
                if (existingBlur) existingBlur.remove();

                /* 仅提取情感关键词着色：将歌词中富有感情色彩的词语染上对应颜色 */
                state.aiEmotionWords = Array.isArray(themeObj.emotion_words) ? themeObj.emotion_words : [];
                state.currentAiTheme = themeObj;
                logInfo('settingsPanel', '[applyAITheme] 设置 aiEmotionWords:', aiEmotionWords.length, '情绪:', themeObj.mood);
                if (state.pvEngineInstance) {
                    pvEngineInstance.setLyrics(state.lyrics, themeObj);
                }
                if (typeof state.tunnelEngineInstance !== 'undefined' && state.tunnelEngineInstance) {
                    tunnelEngineInstance.setLyrics(state.lyrics, themeObj);
                }
                if (state.mainVisManager) {
                    mainVisManager.setLyrics(state.lyrics, themeObj);
                }
                let emotionStyle = ensureEmotionWordStyle();
                applyEmotionWordColors();

                /* 记录当前 AI 主题并同步刷新设置界面中的主题色块与语句 */
                state.currentAiTheme = themeObj;
                updateAiSettingsPreview(themeObj, '分析完成', themeObj.description || `情绪：${themeObj.mood || '未知'} · 风格：${themeObj.animation_style}`);

                logInfo('settingsPanel', 'AI 歌词效果已应用:', themeObj.mood);
            }

            /* 同步刷新设置面板中的 AI 分析状态、语句描述与颜色色块 */
            function updateAiSettingsPreview(themeObj, statusTitle = '', statusDesc = '') {
                if (!themeObj) return;
                const finalTitle = statusTitle || t('ai.statusDone', '分析完成');
                const statusText = typeof document !== 'undefined' ? document.getElementById('aiStatusText') : null;
                const statusDetail = typeof document !== 'undefined' ? document.getElementById('aiStatusDetail') : null;
                const previewEl = typeof document !== 'undefined' ? document.getElementById('aiThemePreview') : null;
                const infoEl = typeof document !== 'undefined' ? document.getElementById('aiThemeInfo') : null;
                const colorEl = typeof document !== 'undefined' ? document.getElementById('aiColorPreview') : null;

                if (statusText) statusText.textContent = finalTitle;
                if (statusDetail) statusDetail.textContent = statusDesc || themeObj.description || `${t('ai.moodLabel', '情绪：')}${themeObj.mood || t('common.unknown', '未知')} · ${t('ai.styleLabel', '风格：')}${themeObj.animation_style}`;
                if (previewEl) previewEl.style.display = 'flex';
                if (infoEl) {
                    const ewCount = Array.isArray(themeObj.emotion_words) ? themeObj.emotion_words.length : 0;
                    infoEl.textContent = `${themeObj.mood || t('common.unknown', '未知')} | ${themeObj.animation_style || t('common.default', '默认')} | ${t('ai.speedLabel', '速度')}${themeObj.animation_speed || 1.0}${ewCount ? ` | ${t('ai.emotionWordsCount', '情感词×')}${ewCount}` : ''}`;
                }
                if (colorEl) {
                    colorEl.innerHTML = '';
                    const c1 = document.createElement('div');
                    c1.className = 'ai-color-block';
                    c1.style.background = themeObj.primary_color;
                    c1.title = `主色: ${themeObj.primary_color}`;
                    
                    const c2 = document.createElement('div');
                    c2.className = 'ai-color-block';
                    c2.style.background = themeObj.secondary_color;
                    c2.title = `副色: ${themeObj.secondary_color}`;
                    
                    colorEl.appendChild(c1);
                    colorEl.appendChild(c2);
                    
                    /* 追加情感词颜色色块（带网格换行与截断防溢出） */
                    if (Array.isArray(themeObj.emotion_words)) {
                        const maxShow = 18;
                        const total = themeObj.emotion_words.length;
                        const toShow = themeObj.emotion_words.slice(0, maxShow);
                        
                        for (const ew of toShow) {
                            if (!ew.color) continue;
                            const ewColor = document.createElement('div');
                            ewColor.className = 'ai-color-block';
                            ewColor.style.width = '18px';
                            ewColor.style.height = '18px';
                            ewColor.style.background = ew.color;
                            ewColor.title = ew.word + (ew.emotion ? ` (${ew.emotion})` : '');
                            colorEl.appendChild(ewColor);
                        }
                        
                        if (total > maxShow) {
                            const moreBadge = document.createElement('div');
                            moreBadge.className = 'ai-color-more-badge';
                            moreBadge.textContent = `+${total - maxShow}`;
                            moreBadge.title = `共 ${total} 个情感词颜色`;
                            colorEl.appendChild(moreBadge);
                        }
                    }
                }
            }

            /* 恢复到手动设置的主题（清除 AI 主题） */
            function resetAITheme() {
                const root = document.documentElement;
                document.body.classList.add('ai-theme-transition');

                /* 移除所有 AI 主题相关 class */
                document.body.classList.remove(
                    'ai-theme-breathing', 'ai-theme-floating', 'ai-theme-glitch', 'ai-theme-smooth', 'ai-theme-flyin',
                    'ai-text-shadow-low', 'ai-text-shadow-medium', 'ai-text-shadow-high'
                );

                /* 移除动画速度 CSS 变量 */
                document.documentElement.style.removeProperty('--ai-anim-duration');

                /* 移除飞入风格几何线框背景层 */
                const wireframesEl = typeof document !== 'undefined' ? document.getElementById('ai-flyin-wireframes') : null;
                if (wireframesEl) wireframesEl.remove();

                /* 移除 AI 歌词模糊 style */
                const styleEl = typeof document !== 'undefined' ? document.getElementById('ai-lyric-blur-style') : null;
                if (styleEl) styleEl.remove();

                /* 清除情感词着色 */
                state.aiEmotionWords = [];
                const emotionStyleEl = typeof document !== 'undefined' ? document.getElementById('ai-emotion-word-style') : null;
                if (emotionStyleEl) emotionStyleEl.remove();
                applyEmotionWordColors(); /* 清除已应用的情感词标记 */
                if (typeof state.mainVisManager !== 'undefined' && state.mainVisManager) mainVisManager.setLyrics(state.lyrics, {});

                /* 恢复手动设置的主题色 */
                _hooks.applyThemeColor(appSettings.interface.themeColor);

                /* 恢复背景模糊设置 */
                const bgLayers = getBlurBgLayers();
                bgLayers.forEach(layer => {
                    layer.style.filter = '';
                });

                /* 恢复歌词模糊 */
                _hooks.applyLyricBlurLevel(appSettings.lyrics.blurLevel);

                state.currentAiTheme = null;

                /* 更新 UI 状态 */
                const statusText = typeof document !== 'undefined' ? document.getElementById('aiStatusText') : null;
                const statusDetail = typeof document !== 'undefined' ? document.getElementById('aiStatusDetail') : null;
                const previewEl = typeof document !== 'undefined' ? document.getElementById('aiThemePreview') : null;
                if (statusText) statusText.textContent = t('ai.statusNotAnalyzed', '未分析');
                if (statusDetail) statusDetail.textContent = t('ai.statusRestoredManual', '已恢复手动主题');
                if (previewEl) previewEl.style.display = 'none';

                setTimeout(() => {
                    document.body.classList.remove('ai-theme-transition');
                }, 1000);

                logInfo('settingsPanel', 'AI 主题已清除，恢复手动设置');
            }

/* 页面是否已经有过用户手势（click / keydown / touchstart 这类「激活事件」；
   指针移动和滚轮不算）。重载后归 false，所以开机预加载阶段一定拿到 false。
   宿主不支持该 API 时退回「视为有手势」= 原行为，此时仍靠调用点的 silent 标志兜底。 */
function userActivated() {
    const ua = typeof navigator !== 'undefined' ? navigator.userActivation : null;
    return ua ? !!ua.hasBeenActive : true;
}

/* 自动触发：歌曲播放成功后调用 AI 分析
   opts.silent：声明「这条路径永远不该问」——175 的 preloadOnly 分支（开机 6~8s 后的
   预加载预热，见 180-boot-config）就是它，那次调用只是提前填缓存，不是用户要听的歌。
   ★ 隐私确认框 await 的是一次用户点击，而这两类路径**都没有手势**：弹窗会自己杵在屏幕
   中央拦住整页（2026-09-26 实测）。所以判据分两层——调用点自己声明 silent，
   外加一层「没有用户手势就不弹」的机制兜底，新增的自动触发路径（手机遥控 / 交叉淡入
   预载 / 以后的定时器）默认就是静默的，不必逐个补标志。
   跳过只丢这一次分析，不丢功能：用户点「进入」或点任何一首歌都会重新触发并正常弹一次。 */
async function triggerAiAnalysisIfNeeded(opts) {
    const ai = appSettings.ai;
    /* ★ 设置里关闭「启用智能分析」后禁止自动调用 AI（此前开关无效，播放仍会触发分析） */
    if (!ai || ai.enabled === false) return;
    const silent = !!(opts && opts.silent);
    /* ★ 隐私确认：Gemini 走第三方反代时，首次实际分析前明示 Key/歌词经其中转
       （localStorage 确认一次；缓存命中不会走到这里，改回官方接口后条件自动失效）。 */
    try {
        if (ai.provider === 'gemini'
            && (!ai.apiBase || ai.apiBase.indexOf('de5.net') >= 0)
            && !localStorage.getItem('aria_ai_proxy_notice')) {
            if (silent || !userActivated()) {
                logWarn('settingsPanel', silent
                    ? 'AI 反代隐私确认：预加载路径不弹窗，等用户主动播放时再确认'
                    : 'AI 反代隐私确认：页面还没有用户手势，本次跳过（不发送任何数据），等首次交互后再确认');
                return;
            }
            const okProceed = await (typeof window.showGlassConfirm === 'function'
                ? window.showGlassConfirm({
                    title: t('ai.proxyConfirmTitle', 'AI 分析经反代接口中转'),
                    desc: t('ai.proxyConfirmDesc', '当前走自建反代接口（zsjsll-cf.de5.net）。\n\nAPI 密钥与歌词内容会经其中转（自建服务不落盘存储，仅转发）。\n\n如不放心，可到「设置 → AI」改回官方接口 generativelanguage.googleapis.com（大陆网络需自备代理）。\n\n继续使用当前接口？')
                  })
                : Promise.resolve(true));
            if (!okProceed) return;
            try { localStorage.setItem('aria_ai_proxy_notice', '1'); } catch (e2) { logCatch('settingsPanel', e2); }
        }
    } catch (e1) { logCatch('settingsPanel', e1); }
    if (!state.currentSongData || (!currentSongData.title && !currentSongData.song)) return;

    const title = currentSongData.title || currentSongData.song || '';
    const artist = currentSongData.artist || currentSongData.singer || '未知歌手';
    const cacheKey = `${title} - ${artist}`;

    /* 1. 优先校验内存缓存 */
    if (state.aiThemeCache[cacheKey]) {
        const cached = state.aiThemeCache[cacheKey];
        if (cached && (cached.mood || cached.animation_style || cached.primary_color || Array.isArray(cached.emotion_words))) {
            logInfo('settingsPanel', '[Auto AI Check] 命中内存缓存:', cacheKey);
            state.currentAiTheme = cached;
            updateAiSettingsPreview(cached, t('ai.statusCached', '已分析（缓存）'), cached.description || `${t('ai.moodLabel', '情绪：')}${cached.mood || t('common.unknown', '未知')} · ${t('ai.styleLabel', '风格：')}${cached.animation_style}`);
            applyAITheme(cached);
            if (Array.isArray(cached.emotion_words) && cached.emotion_words.length > 0) {
                setTimeout(() => { if (typeof applyEmotionWordColors === 'function') applyEmotionWordColors(); }, 100);
                setTimeout(() => { if (typeof applyEmotionWordColors === 'function') applyEmotionWordColors(); }, 500);
            }
            return;
        }
    }

    /* 2. 检查 IndexedDB 缓存 */
    const dbCached = await aiCacheGet(cacheKey);
    if (dbCached && (dbCached.mood || dbCached.animation_style || dbCached.primary_color || Array.isArray(dbCached.emotion_words))) {
        logInfo('settingsPanel', '[Auto AI Check] 命中 IndexedDB 缓存:', cacheKey);
        state.aiThemeCache[cacheKey] = dbCached;
        state.currentAiTheme = dbCached;
        updateAiSettingsPreview(dbCached, '已分析（缓存）', dbCached.description || `情绪：${dbCached.mood || '未知'} · 风格：${dbCached.animation_style}`);
        applyAITheme(dbCached);
        if (Array.isArray(dbCached.emotion_words) && dbCached.emotion_words.length > 0) {
            setTimeout(() => { if (typeof applyEmotionWordColors === 'function') applyEmotionWordColors(); }, 100);
            setTimeout(() => { if (typeof applyEmotionWordColors === 'function') applyEmotionWordColors(); }, 500);
        }
        return;
    }

    /* 3. 未命中缓存，需要调用 AI：此时才校验 API Key 是否存在 */
    if (!ai.apiKey || ai.apiKey.trim().length < 5) {
        logInfo('settingsPanel', '[Auto AI Check] 无缓存且无 API 密钥，跳过 AI 分析');
        const statusText = typeof document !== 'undefined' ? document.getElementById('aiStatusText') : null;
        const statusDetail = typeof document !== 'undefined' ? document.getElementById('aiStatusDetail') : null;
        if (statusText) statusText.textContent = '未配置 Key';
        if (statusDetail) statusDetail.textContent = `《${title}》待分析，请先在设置中填入 API Key`;
        return;
    }
    try {
        const lyricsText = getLyricsTextForAI();
        const themeObj = await analyzeSongWithAI(title, artist, lyricsText, false);
        if (themeObj) {
            state.currentAiTheme = themeObj;
            updateAiSettingsPreview(themeObj, '已分析', themeObj.description || `情绪：${themeObj.mood || '未知'} · 风格：${themeObj.animation_style}`);
            applyAITheme(themeObj);
            if (Array.isArray(state.aiEmotionWords) && aiEmotionWords.length > 0) {
                setTimeout(() => { if (typeof applyEmotionWordColors === 'function') applyEmotionWordColors(); }, 100);
                setTimeout(() => { if (typeof applyEmotionWordColors === 'function') applyEmotionWordColors(); }, 500);
            }
        }
    } catch (err) {
        logError('settingsPanel', '[Auto AI Check] 分析过程出错:', err);
    }
}

/* 暴露到全局作用域，供外部调用 */
/* ========== 高潮检测（纯 JS，无后端依赖）========== */
let chorusDetectionAbort = null;  /* 中止上一次检测 */
/* 获取低音质音频 URL（高潮检测不需要高音质，128kbps 足够，大幅减少下载量） */
async function getLowQualityAudioUrl() {
    if (!state.currentSongData) return null;
    const { source, id, mid } = state.currentSongData;
    if (!id) return null;

    if ((source === 'tencent' || source === 'kugou') && mid) {
        /* ★ 2026-09-29：原走 ygking.top 128kbps 取链，上游已死（整体 Failed to fetch）。
           高潮检测只需一段可分析音频——当前播放 URL 就是最可靠的可播源（audio 正在播它），
           直接复用；没有播放地址才放弃（返回 null 由调用方走降级）。 */
        const audioEl = _hooks.getAudio() || (typeof document !== 'undefined' ? document.getElementById('audioPlayer') : null);
        const src = audioEl && audioEl.src && audioEl.src.startsWith('http') ? audioEl.src : null;
        if (src) return src;
        /* 网易云外链兜底保留（该公网外链仍活） */
    }
    if (source === 'netease' && id) {
        /* 网易云：使用外链（标准音质） */
        return `https://music.163.com/song/media/outer/url?id=${id}`;
    }
    return null;
}

async function detectChorus(audioUrl) {
    logInfo('settingsPanel', '[Chorus] detectChorus 被调用, audioUrl:', audioUrl ? audioUrl.substring(0, 60) + '...' : 'null');
    if (!audioUrl) { logInfo('settingsPanel', '[Chorus] 跳过：无 audioUrl'); return; }
    if (!window.ChorusDetector) { logInfo('settingsPanel', '[Chorus] 跳过：ChorusDetector 模块未加载'); return; }
    /* 中止上一次检测 */
    if (chorusDetectionAbort) chorusDetectionAbort.aborted = true;
    const myAbort = { aborted: false };
    chorusDetectionAbort = myAbort;

    /* 清除旧标记 */
    _setChorusState([], [], null);
    renderChorusMarkers();

    /* 使用歌曲信息作为缓存 key（audio URL 可能变化） */
    const songTitle = state.currentSongData?.title || '';
    const songArtist = state.currentSongData?.artist || '';
    const cacheKey = songTitle ? `${songTitle} - ${songArtist}` : audioUrl;

    /* 先查缓存 */
    try {
        const cached = await chorusCacheGet(cacheKey);
        if (cached && cached.chorusSegments) {
            if (myAbort.aborted) return;
            _setChorusState(cached.chorusSegments, cached._getFullChorus() || [], cached.rhythm || null);
            renderChorusMarkers();
            logInfo('settingsPanel', '[Chorus] 命中缓存，跳过检测:', _getCurrentChorus().length, '个高潮段落',
                _getAudioRhythm() ? `BPM=${_getAudioRhythm().bpm}` : '（无 BPM 数据，旧缓存）');
            return;
        }
    } catch (e) { /* 缓存读取失败，继续正常检测 */ }

    /* 尝试获取低音质 URL 进行分析（大幅减少下载量） */
    let analysisUrl = audioUrl;
    try {
        const lowQUrl = await getLowQualityAudioUrl();
        if (lowQUrl) {
            logInfo('settingsPanel', '[Chorus] 使用低音质 URL 进行分析');
            analysisUrl = lowQUrl;
        }
    } catch (e) { /* 获取低音质失败，回退到播放 URL */ }

    try {
        const result = await ChorusDetector.detect(analysisUrl, (msg) => {
            if (!myAbort.aborted) logInfo('settingsPanel', '[Chorus]', msg);
        });
        if (myAbort.aborted) return;  /* 已过期 */

        _setChorusState(
            result.chorusSegments || [],
            /* 存储完整高潮数据（所有中高能量段，未限制覆盖率，用于 AI 分析） */
        (result.allSegments || []).filter(s => s.label >= 1),
            /* ★ BPM/节拍特征（folia 方案：FFT 节奏信息），供程序化排版调制能量 */
        result.rhythm || null
        );
        renderChorusMarkers();

        /* 写入缓存（含 BPM，下次命中免检测） */
        if (_getCurrentChorus().length > 0 || _getAudioRhythm()) {
            chorusCacheSet(cacheKey, { chorusSegments: _getCurrentChorus(), fullChorusSegments: _getFullChorus(), duration: result.duration, rhythm: _getAudioRhythm() });
            logInfo('settingsPanel', '[Chorus] 已缓存高潮数据:', cacheKey);
        }

        if (_getAudioRhythm() && _getAudioRhythm().bpm) {
            logInfo('settingsPanel', `[Chorus] BPM=${_getAudioRhythm().bpm} (置信度 ${_getAudioRhythm().confidence})`);
        }

        if (_getCurrentChorus().length > 0) {
            logInfo('settingsPanel', '[Chorus] 高潮段落:', _getCurrentChorus().map(s =>
                `${formatTime(s.start * 1000)}-${formatTime(s.end * 1000)}`).join(', '));
        }
    } catch (e) {
        if (!myAbort.aborted) {
            logInfo('settingsPanel', '[Chorus] 检测跳过:', e.message);
        }
    }
}

/* 在进度条上渲染高潮标记 (具备异步重试与自愈能力) */
function renderChorusMarkers() {
    const trackIds = ['progressTrack', 'bottomProgressTrack'];
    /* 清除所有进度条上的旧标记 */
    for (const tid of trackIds) {
        const t = typeof document !== 'undefined' ? document.getElementById(tid) : null;
        if (t) t.querySelectorAll('.chorus-marker').forEach(el => el.remove());
    }
    
    if (!_getCurrentChorus() || _getCurrentChorus().length === 0) return;

    let duration = (_hooks.getAudio() && _hooks.getAudio().duration && !isNaN(_hooks.getAudio().duration) && _hooks.getAudio().duration > 0)
        ? _hooks.getAudio().duration
        : (state.currentSongData?.duration ? currentSongData.duration / 1000 : 0);

    /* 若 duration 尚未就绪，延迟重试 */
    if (duration <= 0) {
        setTimeout(() => {
            if (_getCurrentChorus() && _getCurrentChorus().length > 0) {
                renderChorusMarkers();
            }
        }, 300);
        return;
    }

    for (const seg of _getCurrentChorus()) {
        const left = Math.max(0, Math.min(100, (seg.start / duration) * 100));
        const width = Math.max(0.8, Math.min(100 - left, ((seg.end - seg.start) / duration) * 100));
        const title = `高潮 ${formatTime(seg.start * 1000)} - ${formatTime(seg.end * 1000)}`;

        for (const tid of trackIds) {
            const t = typeof document !== 'undefined' ? document.getElementById(tid) : null;
            if (!t) continue;
            const marker = document.createElement('div');
            marker.className = 'chorus-marker';
            marker.style.cssText = `
                position: absolute !important;
                top: 0 !important;
                left: ${left.toFixed(2)}% !important;
                width: ${width.toFixed(2)}% !important;
                height: 100% !important;
                background: rgba(255, 204, 51, 0.88) !important;
                box-shadow: 0 0 10px rgba(255, 204, 51, 0.7) !important;
                border-radius: 999px !important;
                pointer-events: none !important;
                z-index: 10 !important;
                opacity: 1 !important;
                display: block !important;
            `;
            marker.title = title;
            t.appendChild(marker);
        }
    }
    logInfo('settingsPanel', '[Chorus] 已渲染', _getCurrentChorus().length, '个高潮标记, duration:', duration.toFixed(1) + 's');
}

/* 监听音频元数据加载，确保高潮标记在时长就绪后第一时间绘制 */
if (_hooks.getAudio()) {
    registerAudioListener('loadedmetadata', () => {
        if (_getCurrentChorus() && _getCurrentChorus().length > 0) {
            renderChorusMarkers();
        }
    });
    registerAudioListener('durationchange', () => {
        if (_getCurrentChorus() && _getCurrentChorus().length > 0) {
            renderChorusMarkers();
        }
    });
    registerAudioListener('play', () => {
        if (_getCurrentChorus() && _getCurrentChorus().length > 0) {
            renderChorusMarkers();
        }
    });
}

/* 暴露到全局 */
/* ========== 歌单一键 AI 分析 ========== */
let isAnalyzingPlaylist = false;
async function batchAnalyzePlaylist() {
if (isAnalyzingPlaylist) return;
const ai = appSettings.ai;
if (!ai.apiKey || ai.apiKey.trim().length < 5) {
_setPlaylistsHint( '请先在设置中配置 API 密钥');
return;
}

let songsToAnalyze = [];

/* 根据当前视图确定要分析的歌曲 */
if (state.playlistViewMode === 'list') {
/* 列表视图：当前播放队列 */
songsToAnalyze = [...state.playlist];
} else if (state.playlistViewMode === 'selfplat-songs') {
/* 来自自建服务（vendor）平台的歌单详情 */
const _selfPlat = _hooks.getSelfPlatState();
if (_selfPlat && Array.isArray(_selfPlat.songs)) {
    songsToAnalyze = _selfPlat.songs.map(s => ({
        title: s.name || s.song || s.title || '',
        artist: s.singer || s.author || '',
        url: s.url || '',
        id: s.id,
        mid: s.mid,
        source: s.source || s.src || _selfPlat.src
    }));
}
} else if (state.playlistViewMode === 'detail') {
if (state.currentPlaylistId === '__favorites__') {
/* 收藏夹 */
const fav = _hooks.getFavorites();
songsToAnalyze = fav.map(f => ({ title: f.title, artist: f.artist, url: f.url }));
} else if (state.currentPlaylistId === '__now_playing__') {
/* 当前播放 */
songsToAnalyze = [...state.playlist];
} else {
/* 保存的歌单 */
const pl = _hooks.getPlaylists().find(p => p.id === state.currentPlaylistId);
if (pl) songsToAnalyze = pl.songs;
}
}

if (!songsToAnalyze || songsToAnalyze.length === 0) {
_setPlaylistsHint( '当前列表没有歌曲');
return;
}

isAnalyzingPlaylist = true;
const progressEl = typeof document !== 'undefined' ? document.getElementById('playlistAiProgress') : null;
const fillEl = typeof document !== 'undefined' ? document.getElementById('playlistAiProgressFill') : null;
const textEl = typeof document !== 'undefined' ? document.getElementById('playlistAiProgressText') : null;
progressEl.style.display = 'block';
textEl.textContent = '正在准备...';

let analyzed = 0;
let skipped = 0;
let failed = 0;
const total = songsToAnalyze.length;

/* 保存当前正在分析的歌曲索引，以便逐字歌词可以使用正确的歌词数据 */
const savedCurrentSongData = state.currentSongData;

for (const song of songsToAnalyze) {
if (!song || !song.title) continue;
                const cacheKey = `${song.title} - ${song.artist || '未知歌手'}`;
/* 检查缓存 */
if (state.aiThemeCache[cacheKey]) {
skipped++;
} else {
                textEl.textContent = `正在分析: ${song.title} - ${song.artist || '未知歌手'} (${analyzed + 1}/${total})`;
fillEl.style.width = `${((analyzed + skipped) / total) * 100}%`;
try {
/* 注意：批量分析时暂时无法获取每首歌的逐字歌词，只能传递空歌词
   AI 会返回一个基础主题（没有 emotion_words） */
                const result = await analyzeSongWithAI(song.title, song.artist || '未知歌手', '(无歌词，仅分析歌曲信息)', false);
if (result) analyzed++; else failed++;
} catch {
failed++;
}
}
fillEl.style.width = `${((analyzed + skipped) / total) * 100}%`;
/* 避免请求过快，间隔 200ms */
await new Promise(r => setTimeout(r, 200));
}

/* 恢复当前歌曲数据 */
state.currentSongData = savedCurrentSongData;

isAnalyzingPlaylist = false;
progressEl.style.display = 'none';
_setPlaylistsHint( `分析完成：成功 ${analyzed}，跳过 ${skipped}，失败 ${failed}`);
logInfo('settingsPanel', `[Batch AI] 总计 ${total}，成功 ${analyzed}，跳过 ${skipped}，失败 ${failed}`);
}



export {
    getLyricsTextForAI,
    testAIConnection,
    analyzeSongWithAI,
    applyEmotionWordColors,
    applyAITheme,
    updateAiSettingsPreview,
    resetAITheme,
    triggerAiAnalysisIfNeeded,
    detectChorus,
    renderChorusMarkers,
    batchAnalyzePlaylist,
};
