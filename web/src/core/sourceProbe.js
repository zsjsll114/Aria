/* ============================================================
 * core/sourceProbe.js — 音源连通性探测（设置页「音源状态」面板的后端）
 *
 * 需求：向各音源接口发**轻量**请求，显示成功/失败与延迟。
 *
 * 为什么用 `mode: 'no-cors'`：
 *   各 vendor（QQ:3200 / 酷狗:3100 / 网易:3201 / 汽水:3300）都是**独立端口**，
 *   对页面（127.0.0.1:8001）而言是跨源。要么改 server.py 加统一探测端点
 *   （要重打包 exe，记忆里的规矩是"能不动就不动"），要么让浏览器发 no-cors 请求。
 *   后端是我们自己的本机进程、只发 GET 根路径，no-cors 完全够用：
 *     · 端口没监听 → fetch **reject**（连接被拒），判失败；
 *     · 端口在监听 → fetch **resolve**（哪怕响应是 opaque），判成功并拿到真实 RTT。
 *   我们本来也只需要「进程活着吗 + 响应快不快」这两件事。
 *
 * ★ 主服务（:8001）走**同源**请求，能读到 `/api/selfhost/status` 的 JSON，
 *   顺带给出「副进程在线 / 登录态」，这一项的 info 最丰富。
 * ★ 公网兜底（api.vkeys.cn）在离线环境必然失败，这是**预期行为**，UI 上要注明，
 *   别让用户以为是软件坏了。
 * ============================================================ */

/** 默认探测目标。id 与 selfhost 的平台键保持一致的地方就复用（qq/kugou/netease/qishui）。 */
export const SOURCE_PROBES = [
    { id: 'server', label: '本机主服务', url: '/api/selfhost/status', sameOrigin: true, timeoutMs: 8000 },
    { id: 'qq', label: 'QQ 音乐', url: 'http://127.0.0.1:3200/' },
    { id: 'kugou', label: '酷狗音乐', url: 'http://127.0.0.1:3100/' },
    { id: 'netease', label: '网易云音乐', url: 'http://127.0.0.1:3201/' },
    { id: 'qishui', label: '汽水音乐', url: 'http://127.0.0.1:3300/' },
    { id: 'public', label: '公网兜底（vkeys）', url: 'https://api.vkeys.cn/', publicNet: true, timeoutMs: 5000 },
];

/** 单次探测的默认超时（毫秒） */
export const DEFAULT_TIMEOUT_MS = 3000;

/**
 * 探测一个目标。
 * @param {object} item 探测项（见 SOURCE_PROBES）
 * @param {number} [timeoutMs]
 * @returns {Promise<{id:string,label:string,ok:boolean,ms:number|null,status:number|null,info:string}>}
 */
export async function probeOne(item, timeoutMs) {
    const t = (Number.isFinite(item && item.timeoutMs) ? item.timeoutMs : timeoutMs);
    const limit = Number.isFinite(t) ? t : DEFAULT_TIMEOUT_MS;
    const out = { id: item.id, label: item.label, ok: false, ms: null, status: null, info: '' };
    if (typeof fetch !== 'function') { out.info = 'no-fetch'; return out; }

    const ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    let timer = null;
    if (ctrl) timer = setTimeout(() => { try { ctrl.abort(); } catch { /* 忽略 */ } }, limit);

    const t0 = nowMs();
    try {
        const res = await fetch(item.url, {
            method: 'GET',
            mode: item.sameOrigin ? 'cors' : 'no-cors',
            cache: 'no-store',
            signal: ctrl ? ctrl.signal : undefined,
        });
        out.ms = Math.round(nowMs() - t0);
        out.ok = true;
        /* no-cors 下 res 是 opaque（status 恒 0、读不到 body），只有同源才有真实值 */
        out.status = res.type === 'opaque' ? null : res.status;
        if (item.sameOrigin) {
            try {
                const data = await res.json();
                out.info = summarizeSelfHost(data);
            } catch { /* 非 JSON 也不影响连通判定 */ }
        } else if (res.type === 'opaque') {
            out.info = 'opaque-ok';
        }
    } catch (e) {
        out.ms = Math.round(nowMs() - t0);
        out.ok = false;
        const name = (e && e.name) || '';
        out.info = name === 'AbortError' ? 'timeout' : 'unreachable';
    } finally {
        if (timer) clearTimeout(timer);
    }
    return out;
}

/**
 * 并发探测全部目标（快的那几个不会等慢的）。
 * @param {Array} [items]
 * @param {number} [timeoutMs]
 * @returns {Promise<Array>}
 */
export async function probeAll(items, timeoutMs) {
    const list = Array.isArray(items) && items.length ? items : SOURCE_PROBES;
    return Promise.all(list.map((it) => probeOne(it, timeoutMs)));
}

/** 把 `/api/selfhost/status` 的 JSON 压成一句人话（不读到的字段不编）。 */
function summarizeSelfHost(data) {
    if (!data || typeof data !== 'object') return '';
    const keys = ['qq', 'kugou', 'netease', 'qishui'];
    const bits = [];
    for (const k of keys) {
        const s = data[k];
        if (!s) continue;
        if (s.alive === false) { bits.push(`${k}:off`); continue; }
        bits.push(`${k}:${s.loggedIn ? 'login' : 'ok'}`);
    }
    return bits.join(' ');
}

function nowMs() {
    try {
        if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
            return performance.now();
        }
    } catch { /* 忽略 */ }
    return Date.now();
}
