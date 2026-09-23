/**
 * cf-gemini-auth-worker.js — Gemini 反代 Worker（在原裸转发基础上加鉴权 + 防滥用）
 *
 * 部署方式：
 *   1. Cloudflare Dashboard → Workers → 创建 Worker → 粘贴本文件 → 部署
 *   2. 「设置 → 变量与机密」中新增机密（选「加密」类型）：
 *        PROXY_TOKEN   你的访问令牌（建议 16+ 位随机串，如 `openssl rand -hex 16`）
 *        可选：PROXY_TOKENS     逗号分隔的多个令牌（多个终端/设备各一把）
 *        可选：ALLOWED_ORIGINS  逗号分隔的页面来源，如
 *                              `http://localhost:8001,http://127.0.0.1:8001`
 *                              ⚠ 一旦配置了它，白名单就是硬门槛：页面用哪个 host 打开，
 *                                浏览器就发哪个 Origin，没列进去的**一律 403
 *                                "Forbidden: origin not allowed"**。所以：
 *                                · Tauri 桌面壳 / 浏览器开发都请用 `http://localhost:8001`
 *                                  （src-tauri 的窗口 URL 与 tauri.conf.json 都固定为 localhost，
 *                                   正是因为线上白名单只放行了 localhost）；
 *                                · 若要用 127.0.0.1 打开，必须把 `http://127.0.0.1:8001` 也加进来；
 *                                · 手机/局域网访问（`python server.py --lan`）的 Origin 是
 *                                  `http://<局域网IP>:8001`，同样要显式加进白名单，否则 AI 会 403。
 *        可选：RATE_MAX / RATE_WINDOW_SEC  限流阈值（默认 60 次 / 60 秒每 IP）
 *   3.（可选，推荐）绑定一个 KV 命名空间（变量名 RL），使限流在多实例间生效；
 *      不绑也能用——退化为单实例内存计数（对家用单 Worker 已足够）。
 *
 * 前端调用方约定（已在本项目 aiClient/aiAnalyzer 实现）：
 *   请求头携带  x-proxy-token: <PROXY_TOKEN>  （等价写法：Authorization: Bearer <token>）
 *   原 Gemini Key 仍走 x-goog-api-key 头透传，两层鉴权互不干扰。
 *
 * 安全说明：
 *   - 未配置 PROXY_TOKEN 时保持「开放转发」原行为（仅限流），便于先跑通再收紧；
 *   - 令牌只用常量时间比较，不放入 URL 查询串（避免进访问日志）；
 *   - 对外只保留跨域头，Google 需要的 Host 与内部头均在本脚本内重置。
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const METHOD_BODY_ALLOWED = request.method !== 'GET' && request.method !== 'HEAD';

    // ---------- 0. 跨域预检最先处理（预检不带令牌，必须在鉴权/限流之前放行，否则浏览器请求全被 CORS 拦截） ----------
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // ---------- 0.5 鉴权（令牌校验，未配置令牌则跳过） ----------
    const tokens = (env.PROXY_TOKENS || env.PROXY_TOKEN || '').split(',').map(s => s.trim()).filter(Boolean);
    if (tokens.length > 0) {
      // 常量时间比较，避免时序侧信道
      const sent = (request.headers.get('x-proxy-token') || '')
        .replace(/^Bearer\s+/i, '')
        .trim();
      if (!sent || !tokens.some(t => tokenEq(t, sent))) {
        return corsResponse(request, JSON.stringify({ error: 'Unauthorized: missing or invalid x-proxy-token' }), 401);
      }
    }

    // ---------- 1. 页面来源白名单（可选，ALLOWED_ORIGINS 未配置则放行所有来源） ----------
    const allowOrigins = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (allowOrigins.length > 0) {
      const origin = request.headers.get('Origin') || request.headers.get('Referer') || '';
      if (origin) {
        const ok = allowOrigins.some(o => origin === o || origin.startsWith(o + '/') || origin.startsWith(o + ':'));
        if (!ok) {
          return corsResponse(request, JSON.stringify({ error: 'Forbidden: origin not allowed' }), 403);
        }
      }
    }

    // ---------- 2. 限流（内存滑动窗口；绑定 KV 命名空间 RL 时走全局计数） ----------
    const RATE_MAX = parseInt(env.RATE_MAX, 10) || 60;
    const RATE_WINDOW_MS = (parseInt(env.RATE_WINDOW_SEC, 10) || 60) * 1000;
    const limited = env.RL
      ? await kvRateLimit(env.RL, `rl:${ip}`, RATE_MAX, RATE_WINDOW_MS)
      : memRateLimit(ip, RATE_MAX, RATE_WINDOW_MS);
    if (limited) {
      return corsResponse(request, JSON.stringify({ error: 'Too Many Requests: rate limit exceeded' }), 429);
    }

    // ---------- 3. 目标重定向至 Google Gemini 官方服务器 ----------
    url.hostname = 'generativelanguage.googleapis.com';
    url.port = '';
    url.protocol = 'https:';

    // 安全过滤请求头（必须重置 Host，删除 CF 内部特有头，避免 Google 400）
    const newHeaders = new Headers(request.headers);
    newHeaders.set('Host', 'generativelanguage.googleapis.com');
    newHeaders.delete('cf-connecting-ip');
    newHeaders.delete('cf-ray');
    newHeaders.delete('cf-visitor');
    newHeaders.delete('x-forwarded-proto');
    newHeaders.delete('x-proxy-token'); // 令牌只到代理为止，不转发给 Google

    // 构建转发请求（非 GET/HEAD 才允许传 body）
    const requestInit = {
      method: request.method,
      headers: newHeaders,
      redirect: 'follow',
    };
    if (METHOD_BODY_ALLOWED) requestInit.body = request.body;

    try {
      const response = await fetch(url.toString(), requestInit);

      // 注入跨域允许头并透传流式输出（SSE stream）
      const responseHeaders = new Headers(response.headers);
      Object.entries(corsHeaders(request)).forEach(([k, v]) => responseHeaders.set(k, v));

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
      });
    }
  },
};

/* ================= 工具函数 ================= */

/* 常量时间字符串比较 */
function tokenEq(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* 跨域响应头（按请求 Origin 回显，兜底 *） */
function corsHeaders(request) {
  const origin = request && request.headers ? request.headers.get('Origin') : null;
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'x-proxy-token, x-goog-api-key, Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function corsResponse(request, body, status) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}

/* 内存滑动窗口限流（当前 isolate 内有效；无 KV 时的兜底） */
const _mem = new Map();
function memRateLimit(key, max, windowMs) {
  const now = Date.now();
  const rec = _mem.get(key) || { ts: [], count: 0 };
  // 剪掉窗口外的记录
  rec.ts = rec.ts.filter(t => now - t < windowMs);
  if (rec.ts.length >= max) {
    _mem.set(key, rec);
    return true;
  }
  rec.ts.push(now);
  _mem.set(key, rec);
  return false;
}

/* KV 限流（全局生效；需在 Worker 绑定名为 RL 的 KV 命名空间）。
   简单实现：窗口倒计时键 + 计数键，非事务，误差可接受。 */
async function kvRateLimit(kv, key, max, windowMs) {
  const now = Date.now();
  const winKey = key + ':win';
  let win = parseInt(await kv.get(winKey), 10) || 0;
  if (now - win > windowMs) {
    await kv.put(winKey, String(now), { expirationTtl: Math.ceil(windowMs / 1000) + 10 });
    win = now;
  }
  const ctrKey = key + ':ctr:' + Math.floor(win / (windowMs + 1));
  const count = (parseInt((await kv.get(ctrKey)) || '0', 10) || 0) + 1;
  if (count > max) return true;
  await kv.put(ctrKey, String(count), { expirationTtl: Math.ceil(windowMs / 1000) + 10 });
  return false;
}