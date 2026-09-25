/**
 * core/aiAnalyzer.js — AI 智能情绪分析
 * 调用 GPT-4o / Gemini 提取歌词情绪，生成主题 JSON，流式 SSE 读取
 * ★ 排版分页（line_analyses）不走 LLM：由 proceduralLayout.js 程序化生成
 *   （folia 作者方案：文字测量 + 二维搜索 + 情绪词典，确定性输出）
 */
import { state } from '../infrastructure/state.js';
import { dom } from '../infrastructure/dom.js';
import { eventBus, EVENTS } from '../infrastructure/eventBus.js';
import { AI_PROVIDERS } from '../config/constants.js';
import { hasRealWordTiming, realWordsOf } from '../parsers/wordTiming.js'; // 逐字兜底后区分真实/合成节拍
import { aiCacheGet, aiCacheSet } from '../services/aiCache.js';
import { applyAITheme } from './themeEngine.js';
import { t } from './i18n.js';
import { cleanApiBase, buildGeminiUrl, extractGeminiText, GEMINI_DEFAULT_BASE, GEMINI_DEFAULT_MODEL } from '../services/aiClient.js';
import { logInfo, logWarn, logError } from '../services/log.js';

/** 获取歌词纯文本（从 state.lyrics 数组中提取）
 * 逐字歌词：附带每行时长与高潮区间加权信息，帮助 AI 精准识别高潮/副歌
 */
export function getLyricsTextForAI() {
    if (!state.lyrics || state.lyrics.length === 0) return '';
    
    const chorusList = (state.fullChorusSegments && state.fullChorusSegments.length > 0)
        ? state.fullChorusSegments
        : ((state.currentChorusSegments && state.currentChorusSegments.length > 0) ? state.currentChorusSegments : []);

    const isLineInChorus = (lineStartSec, lineEndSec) => {
        if (!chorusList || chorusList.length === 0) return false;
        return chorusList.some(seg => {
            const s = seg.start;
            const e = seg.end;
            return (lineStartSec >= s && lineStartSec <= e) || (lineEndSec >= s && lineEndSec <= e) || (lineStartSec <= s && lineEndSec >= e);
        });
    };

    /* 只认**真实**逐字：renderLyrics 会给行级歌词兜底合成 words，那是按行时长摊平
       的近似节拍、还被 maxLineMs 截断过。用它算 duration 再打 ★/◆ 权重喂给 LLM，
       等于让 AI 信一套编造的节奏（实测会把 20s 的行报成 10s 并标成重点行）。 */
    const hasWordByWord = hasRealWordTiming(state.lyrics);
    if (hasWordByWord) {
        const lines = [];
        for (let i = 0; i < state.lyrics.length; i++) {
            const l = state.lyrics[i];
            let text = '';
            let duration = 0;
            let lineStart = 0;
            let lineEnd = 0;
            const realWords = realWordsOf(l);
            if (realWords) {
                text = '';
                for (let j = 0; j < realWords.length; j++) {
                    const w = realWords[j];
                    const isLatin = !/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff]/u.test(w.text) && /^[\p{L}\p{M}\p{N}\s\p{P}\p{S}]+$/u.test(w.text) && /[\p{L}]/u.test(w.text);
                    if (isLatin && j > 0) text += ' ';
                    text += w.text;
                }
                lineStart = realWords[0].start;
                lineEnd = realWords[realWords.length - 1].end;
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
            const weight = inChorus ? '★[CHORUS]' : (duration > 3000 ? '★' : duration > 1500 ? '◆' : '');
            lines.push(`L${i} ${weight ? `[${duration}ms]${weight} ${text}` : `[${duration}ms] ${text}`}`);
        }
        return lines.join('\n').substring(0, 6000);
    } else {
        const lines = [];
        for (let i = 0; i < state.lyrics.length; i++) {
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

/** 根据 provider 构建 AI 请求的 URL、headers 和 body（唯一实现；
 *  200-settings-panel.js 曾有一份本地副本，已改为复用本导出） */
export function buildAIRequest(provider, apiKey, apiBase, model, systemPrompt, userPrompt, stream, isReasoningModel, useProxy = true) {
    /* ★ 模型原生最大输出 Token：按「provider + 模型名」回落模型上限，
       Gemini 3.5 Flash Lite / 3.5 Flash 放开到 65536，其余 8192。
       注意用「回退默认后的最终模型名」（mdl）判断，与调用方传空 model 时行为一致 */
    function modelMaxOutput(mdl) {
        return (provider === 'gemini' && /(3\.5[-_]?|flash[-_]?lite)/.test(mdl)) ? 65536 : 8192;
    }
    const providerCfg = AI_PROVIDERS[provider] || AI_PROVIDERS.openai;
    if (provider === 'gemini') {
        const base = cleanApiBase(apiBase || GEMINI_DEFAULT_BASE, useProxy);
        const mdl = (model || GEMINI_DEFAULT_MODEL).trim();
        const action = stream ? 'streamGenerateContent' : 'generateContent';
        const url = buildGeminiUrl({ apiBase: base, model: mdl, apiKey, action, stream });
        const genConfig = { maxOutputTokens: modelMaxOutput(mdl) };
        /* ★ Gemini 思考模型（2.5+）支持 thinkingConfig，且不设 temperature 避免报错 */
        if (isReasoningModel) {
            genConfig.thinkingConfig = { thinkingBudget: -1 };
        } else {
            genConfig.temperature = 0.7;
        }
        const body = {
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            generationConfig: genConfig
        };
        if (systemPrompt && systemPrompt.trim()) {
            body.systemInstruction = { parts: [{ text: systemPrompt }] };
        }
        /* ★ 自建反代令牌（可选）：appSettings.ai.proxyToken 经 x-proxy-token 头携带，
           供 Cloudflare 反代（docs/cf-gemini-auth-worker.js）做 Token 鉴权防滥用 */
        const proxyToken = (globalThis.appSettings && globalThis.appSettings.ai && globalThis.appSettings.ai.proxyToken || '').trim();
        const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };
        if (proxyToken) headers['x-proxy-token'] = proxyToken;
        return { url, headers, body: JSON.stringify(body) };
    } else {
        let base = (apiBase || providerCfg.defaultBase).replace(/\/+$/, '');
        const mdl = model || providerCfg.defaultModel;
        const url = `${base}/chat/completions`;
        const body = {
            model: mdl,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            stream: !!stream,
            max_tokens: modelMaxOutput(mdl)
        };
        if (!isReasoningModel) body.temperature = 0.7;
        return { url, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, body: JSON.stringify(body) };
    }
}

/** 从流式响应的 chunk 中提取文本 */
export function extractAIStreamChunk(provider, chunk) {
    if (provider === 'gemini') {
        if (chunk.candidates && chunk.candidates[0]) {
            const c = chunk.candidates[0];
            if (c.content && c.content.parts) {
                let text = '';
                for (const part of c.content.parts) { if (part.text) text += part.text; }
                return { text, finishReason: c.finishReason || null };
            }
        }
        return { text: '', finishReason: null };
    } else {
        if (chunk.choices && chunk.choices[0]) {
            const choice = chunk.choices[0];
            const text = (choice.delta && choice.delta.content) || '';
            return { text, finishReason: choice.finish_reason || null };
        }
        return { text: '', finishReason: null };
    }
}

/** 从非流式响应中提取文本 */
export function extractAIResponseText(provider, data) {
    if (provider === 'gemini') {
        const candidate = data.candidates && data.candidates[0];
        if (candidate && candidate.content && candidate.content.parts) {
            return candidate.content.parts.map(p => p.text || '').join('');
        }
        return '';
    } else {
        if (data.choices && data.choices[0]) {
            const c = data.choices[0];
            return (c.message && c.message.content) || c.text || (c.message && c.message.reasoning_content) || '';
        }
        return data.content || data.output || data.result || '';
    }
}

/**
 * 分析歌曲情绪并生成主题
 * @param {string} songTitle - 歌曲标题
 * @param {string} artist - 艺人名
 * @param {string} lyricsText - 歌词文本
 * @param {boolean} forceRefresh - 强制刷新（跳过缓存）
 * @returns {Promise<Object|null>} 主题对象
 */
export async function analyzeSongWithAI(songTitle, artist, lyricsText, forceRefresh) {
    const ai = state.appSettings.ai;
    if (!ai.apiKey || ai.apiKey.trim().length < 10) return null;
    if (!songTitle) return null;

    const cacheKey = `${songTitle} - ${artist}`;

    /* 检查内存缓存 */
    if (!forceRefresh && state.aiThemeCache[cacheKey]) {
        logInfo('aiAnalyzer', 'AI 分析命中内存缓存:', cacheKey);
        return state.aiThemeCache[cacheKey];
    }
    /* 检查 IndexedDB 缓存 */
    if (!forceRefresh) {
        const dbCached = await aiCacheGet(cacheKey);
        if (dbCached) {
            state.aiThemeCache[cacheKey] = dbCached;
            logInfo('aiAnalyzer', 'AI 分析命中 IndexedDB 缓存:', cacheKey);
            return dbCached;
        }
    }

    /* 取消正在进行的分析 */
    if (state.isAiAnalyzing) {
        if (!forceRefresh) { logWarn('aiAnalyzer', 'AI 分析进行中，跳过'); return null; }
        if (state.currentAiAbortController) {
            state.currentAiAbortController._manualCancel = true;
            state.currentAiAbortController.abort();
            state.currentAiAbortController = null;
        }
    }
    state.isAiAnalyzing = true;
    eventBus.emit(EVENTS.AI_ANALYSIS_START, { songKey: cacheKey });

    const systemPrompt = buildSystemPrompt();
    const userPrompt = `请分析这首歌：《${songTitle}》- ${artist}。歌词片段：\n${lyricsText || '(无歌词)'}`;

    const provider = ai.provider || 'openai';
    const providerCfg = AI_PROVIDERS[provider] || AI_PROVIDERS.openai;
    const model = ai.model || providerCfg.defaultModel;
    const isReasoningModel = /nemotron|o1|o3|deepseek-r1|reasoning|think/i.test(model);

    const aiReq = buildAIRequest(provider, ai.apiKey, ai.apiBase, ai.model, systemPrompt, userPrompt, true, isReasoningModel);

    const controller = new AbortController();
    state.currentAiAbortController = controller;
    const timeoutId = setTimeout(() => controller.abort(), 90000);

    try {
        const response = await fetch(aiReq.url, {
            method: 'POST',
            headers: aiReq.headers,
            body: aiReq.body,
            signal: controller.signal
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            throw new Error(`API 返回 ${response.status}: ${errText.substring(0, 200)}`);
        }

        /* ★ 首个字尽快反馈：把自动分析也接到浮动状态面板立即展示，边流边显示；
           推理模型思考阶段无文本块，先用「正在分析…」占位，避免长时间空白 */
        const aiPanel = (typeof document !== 'undefined') ? document.getElementById('aiStatusPanel') : null;
        const aiPanelTitle = (typeof document !== 'undefined') ? document.getElementById('aiStatusPanelTitle') : null;
        const aiPanelDetail = (typeof document !== 'undefined') ? document.getElementById('aiStatusPanelDetail') : null;
        const aiPanelOutput = (typeof document !== 'undefined') ? document.getElementById('aiStatusOutput') : null;
        const aiProgressFill = (typeof document !== 'undefined') ? document.getElementById('aiStatusProgressFill') : null;
        if (aiPanel) {
            if (aiPanelTitle) aiPanelTitle.textContent = t('ai.analyzing', 'AI 正在分析…');
            if (aiPanelDetail) aiPanelDetail.textContent = `《${songTitle}》- ${artist || t('common.unknownArtist', '未知')}`;
            if (aiPanelOutput) aiPanelOutput.textContent = t('ai.generating', '正在生成分析结果…');
            aiPanel.classList.add('visible');
        }
        const _feedProgress = () => {
            if (aiPanelOutput) {
                aiPanelOutput.textContent = content || t('ai.generating', '正在生成分析结果…');
                aiPanelOutput.scrollTop = aiPanelOutput.scrollHeight;
            }
            if (aiProgressFill) {
                const max = isReasoningModel ? 200 : 80;
                aiProgressFill.style.width = Math.min(90, (chunkCount / max) * 100) + '%';
            }
        };

        /* 流式读取 SSE */
        let content = '';
        const reader = response.body.getReader();
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
                    const { text: chunkText } = extractAIStreamChunk(provider, chunk);
                    if (chunkText) {
                        content += chunkText;
                        chunkCount++;
                        _feedProgress();
                    }
                } catch (e) { logWarn('aiAnalyzer', 'SSE chunk 解析失败:', e); }
            }
        }

        /* 分析完成后收起浮动面板（若已展示过） */
        if (aiPanel) aiPanel.classList.remove('visible');

        clearTimeout(timeoutId);
        state.currentAiAbortController = null;
        state.isAiAnalyzing = false;

        if (!content.trim()) {
            logWarn('aiAnalyzer', 'AI 返回空内容');
            return null;
        }

        /* 解析 JSON（去除 markdown 代码块标记） */
        let jsonStr = content.trim();
        jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
        const themeObj = JSON.parse(jsonStr);

        /* 缓存结果 */
        state.aiThemeCache[cacheKey] = themeObj;
        await aiCacheSet(cacheKey, themeObj);

        eventBus.emit(EVENTS.AI_ANALYSIS_DONE, { songKey: cacheKey, theme: themeObj });
        logInfo('aiAnalyzer', 'AI 分析成功:', cacheKey, themeObj);
        return themeObj;

    } catch (err) {
        clearTimeout(timeoutId);
        if (typeof document !== 'undefined') {
            const p = document.getElementById('aiStatusPanel');
            if (p) p.classList.remove('visible');
        }
        state.currentAiAbortController = null;
        state.isAiAnalyzing = false;
        if (err.name === 'AbortError') {
            logInfo('aiAnalyzer', 'AI 分析被取消');
        } else {
            logError('aiAnalyzer', 'AI 分析失败:', err.message);
            eventBus.emit(EVENTS.AI_ANALYSIS_ERROR, { songKey: cacheKey, error: err.message });
        }
        return null;
    }
}

/** 检查并触发 AI 分析（自动模式） */
export async function triggerAiAnalysisIfNeeded() {
    const ai = state.appSettings.ai;
    if (!ai.apiKey || ai.apiKey.trim().length < 5) return;
    if (!state.currentSongData || !state.currentSongData.title) return;

    const lyricsText = getLyricsTextForAI();
    const themeObj = await analyzeSongWithAI(
        state.currentSongData.title,
        state.currentSongData.artist || '未知',
        lyricsText,
        false
    );
    if (themeObj) {
        applyAITheme(themeObj);
    }
}

/**
 * ★ 统一的 AI 分析系统提示词（唯一权威版本）
 * 供 aiAnalyzer.analyzeSongWithAI（旧单请求路径）使用。
 * ★ 排版分页（line_analyses）已改为程序化本地生成（proceduralLayout.js，
 *   folia 作者方案：文字测量 + 二维搜索，效果与稳定性远好于让 LLM 猜），
 *   因此本提示词只要求情绪主题与情感词，输出量小、几乎不会截断。
 *
 * @param {Object} [opts]
 * @param {string} [opts.chorusInfo] 额外注入的高潮时间轴提示片段（构建方在外部拼好）
 */
export function buildSystemPrompt(opts = {}) {
    const chorusInfo = (opts && opts.chorusInfo) ? opts.chorusInfo : '';
    return `
你是一个专业的音乐情绪视觉设计师。请分析以下歌曲的标题、艺人名和歌词片段，提取其核心情绪氛围，生成一套适合Web播放器的视觉参数。

歌词格式说明（如有逐字歌词）：
- 每行前缀 L行号 [时长ms] 表示该行演唱时长（毫秒），时长越长越可能是高潮/副歌部分
- ★ 标记表示长时行（>3秒），通常是高潮/副歌，请重点关注这些行的情感
- ◆ 标记表示中等时长行（1.5-3秒），可能是过渡或情绪铺垫
- 无标记行时长较短，通常是引子或间奏${chorusInfo}

请直接返回一个JSON对象，不要包含任何其他文字、不要用markdown代码块包裹。JSON格式如下：
{
    "mood": "情绪关键词（如：梦幻、忧郁、热烈、赛博朋克）",
    "description": "主题描述（中文，15-30个字，第一人称听众视角的文学性意识流句子）",
    "primary_color": "主色调十六进制代码（如：#FF5733）",
    "secondary_color": "辅助色十六进制代码（如：#C70039）",
    "text_shadow": "文字阴影强度（low, medium, high）",
    "animation_speed": "动画速度系数（0.8-1.5，1.0为正常速度，<1.0为慢速，>1.0为快速）",
    "background_blur": "背景模糊半径（如：40px, 60px, 80px）",
    "lyrics_blur": "非高亮歌词的模糊程度（如：2px, 4px, 6px）",
    "animation_style": "推荐动画风格（breathing 呼吸, floating 上浮, glitch 故障, smooth 平滑, flyin 飞入与渐显）",
    "pv_theme": {
        "preset": "PV风格预设（dream, anime, cyber 或 minimal）",
        "geometry_style": "几何构图风格（boxes, connected_nodes, arcs_circles, diamond 或 doodles）",
        "focal_keywords": ["核心重点大字1", "核心重点大字2"]
    },
    "emotion_words": [
        {"word": "歌词中富有感情色彩的词语", "color": "#FF6B6B", "emotion": "情感类型", "line": 0}
    ]
}

▌ emotion_words 要求：
- 返回至少 20 个、至多 40 个（必须是歌词中出现的原文，去掉 L 行号前缀和时间标记，与歌词文字完全一致）
- 优先从 ★ 标记的高潮行与【高潮时间轴】范围内选取
- 同一个词只需出现一次（着色会覆盖全文匹配处），不要重复
- 每个词分配能反映其情感的十六进制颜色（悲伤→冷蓝，热情→暖红，希望→明亮黄绿），与主色调有区分度
- line 字段填该词首次出现的行号（仅作定位参考）
- 不要选虚词（the/a/an/to/me/and/of/in/on/的/了/是/在）
- 拉丁文：每个 word 必须是完整独立单词，不得含空格/标点/撇号/连字符；短语应拆成多个条目
- 中文：可以是单个字或 2-4 字词组，不得含标点
`;
}

/**
 * ★ 两阶段 AI 分析 —— 情绪路提示词（唯一保留的 LLM 请求）。
 * 排版路（原 buildLayoutSystemPrompt + 第二路请求）已由 proceduralLayout.js
 * 程序化生成取代：分页/对齐/换行走「文字测量 + 二维搜索」，情绪能量由
 * 词典投票 + 副歌区间/BPM 调制——无需 LLM，且 group_indices 与隧道引擎
 * 词块精确对齐（同一分词管线），效果远好于让模型猜索引。
 */
export function buildEmotionSystemPrompt(opts = {}) {
    const chorusInfo = (opts && opts.chorusInfo) ? opts.chorusInfo : '';
    return `
你是一个专业的音乐情绪视觉设计师。请分析以下歌曲的标题、艺人名和歌词片段，提取其核心情绪氛围，生成一套适合Web播放器的视觉参数和情感词着色。

歌词格式说明（如有逐字歌词）：
- 每行前缀 L行号 [时长ms] 表示该行演唱时长（毫秒），时长越长越可能是高潮/副歌部分
- ★ 标记表示长时行（>3秒），通常是高潮/副歌，请重点关注这些行的情感
- ◆ 标记表示中等时长行（1.5-3秒），可能是过渡或情绪铺垫
- 无标记行时长较短，通常是引子或间奏${chorusInfo}

请直接返回一个JSON对象，不要包含任何其他文字、不要用markdown代码块包裹。JSON格式如下：
{
    "mood": "情绪关键词（如：梦幻、忧郁、热烈、赛博朋克）",
    "description": "主题描述（中文，15-30个字，第一人称听众视角的文学性意识流句子）",
    "primary_color": "主色调十六进制代码（如：#FF5733）",
    "secondary_color": "辅助色十六进制代码（如：#C70039）",
    "text_shadow": "文字阴影强度（low, medium, high）",
    "animation_speed": "动画速度系数（0.8-1.5，1.0为正常速度，<1.0为慢速，>1.0为快速）",
    "background_blur": "背景模糊半径（如：40px, 60px, 80px）",
    "lyrics_blur": "非高亮歌词的模糊程度（如：2px, 4px, 6px）",
    "animation_style": "推荐动画风格（breathing 呼吸, floating 上浮, glitch 故障, smooth 平滑, flyin 飞入与渐显）",
    "pv_theme": {
        "preset": "PV风格预设（dream, anime, cyber 或 minimal）",
        "geometry_style": "几何构图风格（boxes, connected_nodes, arcs_circles, diamond 或 doodles）",
        "focal_keywords": ["核心重点大字1", "核心重点大字2"]
    },
    "emotion_words": [
        {"word": "歌词中富有感情色彩的词语", "color": "#FF6B6B", "emotion": "情感类型", "line": 0}
    ]
}

▌ emotion_words 要求：
- 返回至少 20 个、至多 40 个（必须是歌词中出现的原文，去掉 L 行号前缀和时间标记，与歌词文字完全一致）
- 优先从 ★ 标记的高潮行与【高潮时间轴】范围内选取
- 同一个词只需出现一次（着色会覆盖全文匹配处），不要重复
- 每个词分配能反映其情感的十六进制颜色（悲伤→冷蓝，热情→暖红，希望→明亮黄绿），与主色调有区分度
- line 字段填该词首次出现的行号（仅作定位参考）
- 不要选虚词（the/a/an/to/me/and/of/in/on/的/了/是/在）
- 拉丁文：每个 word 必须是完整独立单词，不得含空格/标点/撇号/连字符；短语应拆成多个条目
- 中文：可以是单个字或 2-4 字词组，不得含标点
`;
}

const AIAnalyzer = {
    getLyricsTextForAI,
    buildAIRequest,
    extractAIStreamChunk,
    extractAIResponseText,
    buildSystemPrompt,
    buildEmotionSystemPrompt
};

if (typeof window !== 'undefined') {
    window.AIAnalyzer = AIAnalyzer;
}

export default AIAnalyzer;