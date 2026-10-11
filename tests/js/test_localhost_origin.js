/* ============================================================
 * tests/js/test_localhost_origin.js — 页面 URL 必须 localhost 门禁本身必须会响
 *
 * 治的是「把窗口 URL『优化』成 127.0.0.1 → AI 反代 Worker 按 ALLOWED_ORIGINS 校验
 * Origin → 403 → AI 全废」。仓库真发生过这种"优化"倾向，故门禁化。
 * 重点：故意写成 127.0.0.1 时必须报，且不能误伤合法位置：
 *   ① 真实文件必须零违规（CI 里那条断言的本地版）；
 *   ② tauri.conf.json 的窗口 url 写成 127.0.0.1 → 报；
 *   ③ lib.rs 的 Url::parse(127.0.0.1) → 报；
 *   ④ localhost 形态 → 不报；
 *   ⑤ remote.urls 白名单里的 127.0.0.1 → 不报（它本就同时放行两者）。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scan } from '../../scripts/audits/localhost-origin.mjs';

const OK_CONF = JSON.stringify({
    app: {
        windows: [{ label: 'main', url: 'http://localhost:8001/index.html' }],
        security: { capabilities: [{ remote: { urls: ['http://localhost:8001', 'http://127.0.0.1:8001'] } }] },
    },
});

test('① 真实文件必须零违规（CI 里那条断言的本地版）', () => {
    const r = scan();
    assert.equal(r.error, undefined, r.error);
    assert.deepEqual(r.violations, [], r.violations.join('\n'));
});

test('② 窗口 url 写成 127.0.0.1 → 报（附窗口名）', () => {
    const conf = JSON.stringify({
        app: { windows: [{ label: 'main', url: 'http://127.0.0.1:8001/index.html' }] },
    });
    const r = scan({ tauriConf: conf, libRs: '' });
    assert.equal(r.violations.length, 1, r.violations.join('\n'));
    assert.ok(r.violations[0].includes('main'), r.violations[0]);
});

test('③ lib.rs 的 Url::parse(127.0.0.1) → 报', () => {
    const rs = 'if let Ok(u) = tauri::Url::parse("http://127.0.0.1:8001/lyrics.html") { }\n';
    const r = scan({ tauriConf: OK_CONF, libRs: rs });
    assert.equal(r.violations.length, 1, r.violations.join('\n'));
    assert.ok(r.violations[0].includes('lyrics.html'), r.violations[0]);
});

test('④ localhost 形态 → 不报', () => {
    const rs = 'if let Ok(u) = tauri::Url::parse("http://localhost:8001/index.html") { }\n';
    const r = scan({ tauriConf: OK_CONF, libRs: rs });
    assert.deepEqual(r.violations, []);
});

test('⑤ remote.urls 白名单里的 127.0.0.1 → 不报', () => {
    const r = scan({ tauriConf: OK_CONF, libRs: '' });
    assert.deepEqual(r.violations, []);
});

test('⑥ tauri.conf.json 非法 JSON → 报 error 而不是静默通过', () => {
    const r = scan({ tauriConf: '{ not json', libRs: '' });
    assert.equal(r.ok, false);
    assert.ok(r.error && r.error.includes('JSON'), r.error);
});
