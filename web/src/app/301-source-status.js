/* ============================================================
 * 301-source-status.js — 设置页「音源状态」面板（需求 1）
 *
 * 向 vendor 的各个音源接口发**一次轻量请求**，列出成功/失败与延迟，带刷新按钮。
 *
 * 分层：探测逻辑全在 `core/sourceProbe.js`（纯逻辑 + 单测，含 no-cors 的取舍说明），
 * 本分片只负责「找 DOM → 调探测 → 渲染 + 加载态」。骨架（#sourceStatusList /
 * #btnSourceProbe）在 index.html，属自挂载分片（与 289/290/295 同模式）。
 *
 * ★ 不自动探测：进设置页就发 6 个请求没必要（其中公网那条在离线时会白等）。
 *   首次打开面板渲染一行「点『测试』开始」，用户点了才发。
 * ============================================================ */
import { probeAll, SOURCE_PROBES } from '../core/sourceProbe.js';
import { translatePhrase } from '../core/i18n.js';
import { esc } from '../utils/formatters.js';
import { logCatch } from '../services/log.js';

const tx = translatePhrase;
const TAG = 'sourceStatus';
let _busy = false;

function hint(text) {
    try { if (typeof Aria !== 'undefined' && Aria.showHint) Aria.showHint(text); } catch (e) { logCatch(TAG, e); }
}

function listEl() {
    return (typeof document !== 'undefined') ? document.getElementById('sourceStatusList') : null;
}

/** 结果行。成功给毫秒，失败区分「超时」与「不可达」（排查方向完全不同）。 */
function rowHtml(r) {
    const tone = r.ok ? 'ok' : 'bad';
    let right;
    if (r.ok) right = `${r.ms} ms`;
    else right = (r.info === 'timeout') ? tx('超时') : tx('不可达');
    const sub = (r.ok && r.info && r.info !== 'opaque-ok')
        ? `<span class="source-status-info">${esc(r.info)}</span>` : '';
    return `<div class="source-status-row">`
        + `<span class="source-status-dot ${tone}"></span>`
        + `<span class="source-status-name">${esc(tx(r.label))}</span>`
        + sub
        + `<span class="source-status-ms ${tone}">${esc(right)}</span>`
        + `</div>`;
}

function renderIdle() {
    const el = listEl();
    if (!el) return;
    el.innerHTML = `<div class="source-status-row source-status-empty">${esc(tx('点「测试」向各音源发一次轻量请求'))}</div>`;
}

function renderBusy() {
    const el = listEl();
    if (!el) return;
    /* 先铺占位行（数量与目标一致），避免"点了没反应"的观感 */
    el.innerHTML = SOURCE_PROBES.map(p =>
        `<div class="source-status-row"><span class="source-status-dot pending"></span>`
        + `<span class="source-status-name">${esc(tx(p.label))}</span>`
        + `<span class="source-status-ms pending">…</span></div>`).join('');
}

/** 跑一轮探测并渲染。重复点击会被 _busy 挡下。 */
export async function refreshSourceStatus() {
    if (_busy) return;
    _busy = true;
    const btn = (typeof document !== 'undefined') ? document.getElementById('btnSourceProbe') : null;
    const oldLabel = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = tx('测试中…'); }
    renderBusy();
    try {
        const rows = await probeAll();
        const el = listEl();
        if (el) el.innerHTML = rows.map(rowHtml).join('');
        const bad = rows.filter(r => !r.ok).length;
        if (bad) hint(`${bad} ${tx('个音源不可用')}`);
    } catch (e) {
        logCatch(TAG, e);
        const el = listEl();
        if (el) el.innerHTML = `<div class="source-status-row source-status-empty">${esc(tx('探测失败'))}</div>`;
    } finally {
        _busy = false;
        if (btn) { btn.disabled = false; btn.textContent = oldLabel || tx('测试'); }
    }
}

if (typeof document !== 'undefined') {
    renderIdle();
    const btn = document.getElementById('btnSourceProbe');
    if (btn) {
        btn.textContent = tx('测试');
        btn.addEventListener('click', () => { void refreshSourceStatus(); });
    }
}
