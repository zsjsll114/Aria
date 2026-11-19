/* ============================================================
 * tests/js/test_ai_gemini_proxy_only.js — Gemini 专属反向代理边界单测
 *
 * 验证：
 * 1) 仅 provider === 'gemini' 且 useProxy !== false 时走反代与 x-proxy-token；
 * 2) 关闭反代 (useProxy=false) 或非 Gemini 服务商 (deepseek/openai/openrouter/z-ai)
 *    不注入反代地址、也不发送 x-proxy-token；
 * 3) UI 控制文件 (201-settings-ai.js / 220-shortcuts-viewmode.js) 对非 Gemini 服务商隐藏并屏蔽反代读写。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanApiBase, GEMINI_PROXY_BASE, GEMINI_OFFICIAL_BASE, testGeminiConnection } from '../../web/src/services/aiClient.js';
import { buildAIRequest } from '../../web/src/core/aiAnalyzer.js';

const REPO = path.resolve(import.meta.dirname, '../..');
const SETTINGS_AI_JS = fs.readFileSync(path.join(REPO, 'web/src/app/201-settings-ai.js'), 'utf8');
const SHORTCUTS_VM_JS = fs.readFileSync(path.join(REPO, 'web/src/app/220-shortcuts-viewmode.js'), 'utf8');

test('cleanApiBase 仅在 useProxy=true 时回落 Gemini 反代地址', () => {
    assert.equal(cleanApiBase('', true), GEMINI_PROXY_BASE);
    assert.equal(cleanApiBase('', false), GEMINI_OFFICIAL_BASE);
    assert.equal(cleanApiBase('https://custom.example.com/v1beta/', false), 'https://custom.example.com');
});

test('buildAIRequest：仅 Gemini 启用反代时携带 x-proxy-token，其余服务商不携带且不走反代', () => {
    const prevSettings = globalThis.appSettings;
    try {
        globalThis.appSettings = { ai: { proxyToken: 'secret-proxy-token' } };

        const geminiProxied = buildAIRequest('gemini', 'AIza-key', '', 'gemini-2.5-flash', 'sys', 'user', false, false, true);
        assert.ok(geminiProxied.url.startsWith(`${GEMINI_PROXY_BASE}/v1beta/models/gemini-2.5-flash:`));
        assert.equal(geminiProxied.headers['x-proxy-token'], 'secret-proxy-token');
        assert.equal(geminiProxied.headers['x-goog-api-key'], 'AIza-key');

        const geminiDirect = buildAIRequest('gemini', 'AIza-key', '', 'gemini-2.5-flash', 'sys', 'user', false, false, false);
        assert.ok(geminiDirect.url.startsWith(`${GEMINI_OFFICIAL_BASE}/v1beta/models/gemini-2.5-flash:`));
        assert.equal(geminiDirect.headers['x-proxy-token'], undefined);

        for (const prov of ['deepseek', 'openai', 'openrouter', 'z-ai']) {
            const req = buildAIRequest(prov, 'sk-test-123', '', '', 'sys', 'user', false, false, true);
            assert.ok(!req.url.includes(GEMINI_PROXY_BASE), `${prov} 不得走 Gemini 反代 URL`);
            assert.equal(req.headers['x-proxy-token'], undefined, `${prov} 不得携带 x-proxy-token`);
            assert.equal(req.headers.Authorization, 'Bearer sk-test-123');
        }
    } finally {
        if (prevSettings === undefined) {
            delete globalThis.appSettings;
        } else {
            globalThis.appSettings = prevSettings;
        }
    }
});

test('testGeminiConnection 在 useProxy=false 或官方接口直连时不附带 x-proxy-token', async (t) => {
    const prevFetch = globalThis.fetch;
    const prevSettings = globalThis.appSettings;
    const seen = [];
    t.after(() => {
        globalThis.fetch = prevFetch;
        if (prevSettings === undefined) {
            delete globalThis.appSettings;
        } else {
            globalThis.appSettings = prevSettings;
        }
    });

    globalThis.appSettings = { ai: { proxyToken: 'secret-proxy-token' } };
    globalThis.fetch = async (url, init = {}) => {
        seen.push({ url, headers: init.headers || {} });
        return new Response(JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'OK' }] } }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const directRes = await testGeminiConnection({
        apiKey: 'AIza-direct',
        apiBase: GEMINI_OFFICIAL_BASE,
        model: 'gemini-2.5-flash',
        useProxy: false,
    });
    assert.equal(directRes.ok, true);
    assert.equal(seen[0].headers['x-proxy-token'], undefined);

    const proxiedRes = await testGeminiConnection({
        apiKey: 'AIza-proxied',
        apiBase: GEMINI_PROXY_BASE,
        model: 'gemini-2.5-flash',
        useProxy: true,
    });
    assert.equal(proxiedRes.ok, true);
    assert.equal(seen[1].headers['x-proxy-token'], 'secret-proxy-token');
});

test('UI 设置接线对非 Gemini 服务商隐藏反代开关和令牌行且拒绝读写', () => {
    assert.match(SETTINGS_AI_JS, /proxyRow\.style\.display\s*=\s*isGemini\s*\?\s*''\s*:\s*'none'/);
    assert.match(SETTINGS_AI_JS, /tokenRow\.style\.display\s*=\s*isGemini\s*\?\s*''\s*:\s*'none'/);
    assert.match(SETTINGS_AI_JS, /aiUseProxyToggle\.addEventListener\('click',\s*\(\)\s*=>\s*\{\s*const p =[^;]+;\s*if\s*\(p !== 'gemini'\)\s*return;/);
    assert.match(SETTINGS_AI_JS, /saveProxyToken = \(\) => \{\s*const p =[^;]+;\s*if\s*\(p !== 'gemini'\)\s*return;/);
    assert.match(SETTINGS_AI_JS, /if\s*\(_ptInput\s*&&\s*_saveProv\s*===\s*'gemini'\)\s*appSettings\.ai\.proxyToken/);
    assert.match(SETTINGS_AI_JS, /useProxy\s*&&\s*proxyToken\s*\?\s*\{\s*'x-proxy-token':\s*proxyToken\s*\}\s*:\s*\{\}/);
    assert.match(SHORTCUTS_VM_JS, /const isGeminiProv =[^;]+;[\s\S]*?if\s*\(proxyRow\)\s*proxyRow\.style\.display\s*=\s*isGeminiProv\s*\?\s*''\s*:\s*'none'/);
    assert.match(SHORTCUTS_VM_JS, /if\s*\(tokenRow\)\s*tokenRow\.style\.display\s*=\s*isGeminiProv\s*\?\s*''\s*:\s*'none'/);
});
