/**
 * src/services/aiClient.js — Gemini AI 客户端与自定义代理统一拦截器
 */

export const GEMINI_OFFICIAL_BASE = 'https://generativelanguage.googleapis.com';
export const GEMINI_PROXY_BASE = 'https://zsjsll-cf.de5.net';
export const GEMINI_DEFAULT_BASE = 'https://zsjsll-cf.de5.net';
/* ★ 默认模型需与 config/defaults.js、config/constants.js 的 gemini 默认一致（此前三处不一致：
   1.5-flash / 3.5-flash-lite / 1.5-flash 混用，切模型时 UI 与请求层各执一词）。统一 3.5-flash-lite。 */
export const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash-lite';

/**
 * 标准化 API Base 地址：自适应去除末尾斜杠与多余的 /v1beta
 * @param {string} apiBase 
 * @param {boolean} [useProxy=true] 
 * @returns {string} 标准化后的根地址（不带末尾 / 与 /v1beta）
 */
export function cleanApiBase(apiBase, useProxy = true) {
    let base = (apiBase || '').trim();
    if (!base) {
        base = useProxy ? GEMINI_PROXY_BASE : GEMINI_OFFICIAL_BASE;
    }
    base = base.replace(/\/+$/, '');
    if (/\/v1beta$/i.test(base)) {
        base = base.replace(/\/v1beta$/i, '');
    }
    return base.replace(/\/+$/, '') || (useProxy ? GEMINI_PROXY_BASE : GEMINI_OFFICIAL_BASE);
}

/**
 * 动态拼接 Gemini 请求 URL
 * @param {Object} options
 * @param {string} options.apiBase 接口基础地址
 * @param {string} options.model 模型名称
 * @param {string} options.apiKey API Key
 * @param {string} [options.action='generateContent'] 动作 (generateContent | streamGenerateContent)
 * @param {boolean} [options.stream=false] 是否启用 SSE 流式
 * @returns {string} 完整的请求 URL
 */
export function buildGeminiUrl({ apiBase, model, apiKey, action = 'generateContent', stream = false }) {
    const base = cleanApiBase(apiBase);
    const mdl = (model || GEMINI_DEFAULT_MODEL).trim();
    /* ★ Key 不再拼进 URL query（避免落在前置 CDN / 访问日志里被记录），
       改由调用方在请求头 `x-goog-api-key` 传递（官方与反代接口均支持该 Header 鉴权）。
       apiKey 参数保留仅为兼容旧调用签名，已不参与 URL 拼接。 */
    let url = `${base}/v1beta/models/${mdl}:${action}`;
    if (stream) {
        url += '?alt=sse';
    }
    return url;
}

/**
 * 统一错误拦截与格式化解析
 * @param {Error|any} err 捕获的异常或 response
 * @param {number} [status=0] HTTP 状态码
 * @param {any} [rawData=null] 响应 body 解析出的数据
 * @returns {string} 人类友好的错误提示字符串
 */
export function formatGeminiError(err, status = 0, rawData = null) {
    let serverMsg = '';
    if (rawData) {
        if (typeof rawData === 'object') {
            serverMsg = rawData.error?.message || rawData.message || rawData.error || '';
        } else if (typeof rawData === 'string') {
            serverMsg = rawData.substring(0, 300);
        }
    }

    if (status === 400) {
        return `请求参数错误 (400)${serverMsg ? `: ${serverMsg}` : '，请检查模型名称或请求内容'}`;
    }
    /* ★ 403 + origin 关键词 = 反代 Worker 的「页面来源白名单」拒绝
       （docs/cf-gemini-auth-worker.js 的 ALLOWED_ORIGINS），与 API Key 无关。
       最容易踩的：用 http://127.0.0.1:8001 打开页面（白名单只放行了 localhost），
       或从局域网/手机访问。若落进下面那条通用 401/403 文案，会被误判成"Key 无效"。 */
    if (status === 403 && /origin/i.test(String(serverMsg))) {
        return '页面来源被反代白名单拒绝 (HTTP 403)：请改用 http://localhost:8001 打开本应用；'
            + '若要用 127.0.0.1 或局域网 IP，需把该来源加入反代 Worker 的 ALLOWED_ORIGINS'
            + `${serverMsg ? ` (${serverMsg})` : ''}`;
    }
    if (status === 401 || status === 403) {
        return `认证失败 (HTTP ${status}): API Key 无效、已过期或无访问权限${serverMsg ? ` (${serverMsg})` : ''}`;
    }
    if (status === 404) {
        return `接口或模型不存在 (HTTP 404): 请检查 API 代理地址与模型名称是否正确${serverMsg ? ` (${serverMsg})` : ''}`;
    }
    if (status === 429) {
        return `请求频率超限或配额耗尽 (HTTP 429)${serverMsg ? `: ${serverMsg}` : '，请稍后再试'}`;
    }
    if (status >= 500) {
        return `代理服务器或上游异常 (HTTP ${status})${serverMsg ? `: ${serverMsg}` : '，请检查反代服务是否可用'}`;
    }

    if (err) {
        if (err.name === 'AbortError') {
            return '请求超时，代理地址响应过慢，请检查网络';
        }
        if (err.message && (err.message.includes('Failed to fetch') || err.message.includes('NetworkError') || err.message.includes('CORS'))) {
            return '无法连接到 API 代理，可能是网络中断、CORS 跨域限制或代理地址无效';
        }
        return err.message || String(err);
    }

    return serverMsg || `未知错误 (HTTP ${status})`;
}

/**
 * 提取 Gemini 响应文本
 * @param {Object} data 响应 JSON
 * @returns {string}
 */
export function extractGeminiText(data) {
    if (!data) return '';
    const candidate = data.candidates && data.candidates[0];
    if (candidate && candidate.content && candidate.content.parts) {
        let text = '';
        for (const part of candidate.content.parts) {
            if (part.text) text += part.text;
        }
        return text;
    }
    return '';
}

/**
 * ★ 按模型返回原生最大输出 token 数（不同模型不同上限）。
 * 不匹配时返回空对象（由 provider 使用其默认最大输出），避免写死限死长歌词分析。
 */
export function geminiMaxOutput(model) {
    const mdl = String(model || '').toLowerCase();
    if (/(3\.5[-_]?|flash[-_]?lite)/.test(mdl)) return 65536;   // Gemini 3.x / Flash-Lite 原生 64K 输出
    if (/(1\.5[-_]?(pro|flash))|gemini-2/.test(mdl)) return 8192;
    return 8192;
}

/**
 * 发送 Gemini 文本/多模态生成请求
 * @param {Object} params
 * @param {string} params.prompt 用户 Prompt
 * @param {string} [params.systemInstruction] 系统指令
 * @param {string} [params.apiKey] API Key
 * @param {string} [params.apiBase] 反代或官方 Base
 * @param {string} [params.model] 模型名
 * @param {boolean} [params.stream=false] 是否流式
 * @param {boolean} [params.isReasoningModel=false] 是否为推理/思考模型
 * @param {AbortSignal} [params.signal] AbortSignal
 * @param {number} [params.timeoutMs=60000] 超时时间
 * @returns {Promise<{ ok: boolean, text?: string, data?: any, error?: string, status?: number }>}
 */
export async function geminiGenerateContent({
    prompt,
    systemInstruction = '',
    apiKey = '',
    apiBase = GEMINI_DEFAULT_BASE,
    model = GEMINI_DEFAULT_MODEL,
    stream = false,
    isReasoningModel = false,
    signal = null,
    timeoutMs = 60000,
    proxyToken = ''
}) {
    const key = (apiKey || '').trim();
    if (!key || key.length < 5) {
        return { ok: false, error: '请先配置有效的 Gemini API Key' };
    }
    const token = (proxyToken || (globalThis.appSettings && globalThis.appSettings.ai && globalThis.appSettings.ai.proxyToken) || '').trim();

    const action = stream ? 'streamGenerateContent' : 'generateContent';
    const url = buildGeminiUrl({ apiBase, model, apiKey: key, action, stream });

    const genConfig = {
        // ★ 默认按模型原生最大输出（不同模型不同上限），不再写死 8192，避免长歌词排版被截断
        maxOutputTokens: geminiMaxOutput(model)
    };
    if (isReasoningModel) {
        genConfig.thinkingConfig = { thinkingBudget: -1 };
    } else {
        genConfig.temperature = 0.7;
    }

    const bodyObj = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: genConfig
    };
    if (systemInstruction && systemInstruction.trim()) {
        bodyObj.systemInstruction = { parts: [{ text: systemInstruction.trim() }] };
    }

    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);

    // 组合外部信号与内部超时信号
    const onParentAbort = () => controller.abort();
    if (signal) {
        signal.addEventListener('abort', onParentAbort);
    }

    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key, ...(token ? { 'x-proxy-token': token } : {}) },
            body: JSON.stringify(bodyObj),
            signal: controller.signal
        });
        clearTimeout(timeoutTimer);
        if (signal) signal.removeEventListener('abort', onParentAbort);

        let data = null;
        try {
            data = await resp.json();
        } catch {
            data = null;
        }

        if (!resp.ok) {
            const errorMsg = formatGeminiError(null, resp.status, data);
            return { ok: false, status: resp.status, error: errorMsg, data };
        }

        const text = extractGeminiText(data);
        return { ok: true, status: resp.status, text, data };
    } catch (err) {
        clearTimeout(timeoutTimer);
        if (signal) signal.removeEventListener('abort', onParentAbort);
        let errorMsg = formatGeminiError(err, 0, null);
        /* ★ 按目标地址区分网络层失败文案：formatGeminiError 统一报"API 代理"，
           直连官方（useProxy=false）失败时误导排查方向（2026-09-21 实测踩坑） */
        const isAbort = err && err.name === 'AbortError';
        const isNetErr = err && err.message && (err.message.includes('Failed to fetch') || err.message.includes('NetworkError') || err.message.includes('CORS'));
        if (isAbort || isNetErr) {
            if (/de5\.net/i.test(url)) {
                errorMsg = isAbort
                    ? '反代响应超时：zsjsll-cf.de5.net 过慢或不可达，请检查网络/代理节点后重试'
                    : '无法连接反代服务（zsjsll-cf.de5.net）：请检查网络是否中断、代理节点是否可用';
            } else if (/googleapis\.com/i.test(url)) {
                errorMsg = isAbort
                    ? '直连官方接口超时：generativelanguage.googleapis.com 不可达'
                    : '无法直连 Gemini 官方接口（generativelanguage.googleapis.com）：大陆网络被墙，请开启反向代理，或确认系统代理（v2rayN 等）正在运行且浏览器流量已走代理';
            }
        }
        return { ok: false, status: 0, error: errorMsg };
    }
}

/**
 * 极简连通性测试：向代理发送轻量 Prompt 并计算往返延迟
 * @param {Object} params
 * @param {string} params.apiKey
 * @param {string} params.apiBase
 * @param {string} [params.model]
 * @param {number} [params.timeoutMs=15000]
 * @returns {Promise<{ ok: boolean, latency?: number, message: string, reply?: string }>}
 */
export async function testGeminiConnection({
    apiKey,
    apiBase = GEMINI_DEFAULT_BASE,
    model = GEMINI_DEFAULT_MODEL,
    timeoutMs = 15000
}) {
    const key = (apiKey || '').trim();
    if (!key || key.length < 5) {
        return { ok: false, message: '请先输入有效的 API Key' };
    }

    const startTime = Date.now();
    const res = await geminiGenerateContent({
        prompt: 'Hello! Reply with exactly: OK',
        systemInstruction: 'You are a connection tester. Output only: OK',
        apiKey: key,
        apiBase,
        model,
        stream: false,
        timeoutMs
    });

    const latency = Date.now() - startTime;
    if (res.ok) {
        const replyText = (res.text || '').trim();
        return {
            ok: true,
            latency,
            reply: replyText,
            message: `连接成功 (${latency}ms)${replyText ? ` [回复: ${replyText.substring(0, 30)}]` : ''}`
        };
    } else {
        return {
            ok: false,
            latency,
            message: `连接失败: ${res.error || '未知原因'}`
        };
    }
}

// 挂载到 window 供全局脚本直接调用
if (typeof window !== 'undefined') {
    window.aiClient = {
        GEMINI_DEFAULT_BASE,
        GEMINI_DEFAULT_MODEL,
        cleanApiBase,
        buildGeminiUrl,
        formatGeminiError,
        extractGeminiText,
        geminiGenerateContent,
        testGeminiConnection
    };
}
