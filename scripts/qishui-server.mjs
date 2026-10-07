#!/usr/bin/env node
/**
 * scripts/qishui-server.mjs — 汽水音乐（抖音 Soda / Luna PC）自建服务
 * ====================================================================
 * 与 _eval/ 下另外三个 vendor（KuGouMusicApi / qq-music-api-node /
 * NeteaseCloudMusicApi）同构：独立 Node HTTP 副进程，由 server.py 的
 * selfhost_service.py 统一拉起与代理，前端不直连、不感知端口。
 *
 * ★ 为什么本文件在 scripts/ 而不是 _eval/qishui-music-api/：
 *   .gitignore 第 19 行把 `_eval/` 整目录排除（它是第三方音源镜像的运行时依赖）。
 *   另外三个 vendor 的文件**全是上游 clone 来的**，丢了能重跑 setup-vendors.bat；
 *   而本文件是我们自己写的适配层（HTTP 面 + 会话落盘 + 音频吐流），必须入库。
 *   所以拆成两半：代码在 scripts/（入库），第三方库在
 *   _eval/qishui-music-api/vendor/node_modules/ly-music-source（由
 *   scripts/setup-vendors.bat 用 npm install 拉取）。
 *
 * 与原三源的两个结构性差异（决定了为什么必须由我们写这一层）：
 *
 *   1. 汽水的播放音频是**加密**的。ly-music-source 的 resolve() 给的不是直链，
 *      而是解密后的字节（ResolveResult.data / filePath）。所以上游三源那种
 *      「把 CDN 直链丢给前端」的模式在这里不成立 —— 必须由本进程自己吐流。
 *      → 于是有 GET /stream，并且必须支持 Range（否则时间轴拖拽全废）。
 *
 *   2. 上游是**库**不是服务，没有 HTTP 面。会话也只存内存
 *      （README「Session persistence is your job」）。所以本文件同时承担
 *      「HTTP 适配层」与「会话落盘」两件事，落盘到 _eval/qishui-music-api/.session.json，
 *      副进程重启后不必重新扫码。
 *
 * 暴露面（前端经 server.py 的 /api/selfhost/qishui/* 与 /api/audio/stream 访问）：
 *   GET  /                     健康检查（selfhost_service._probe_alive 探这个）
 *   GET  /status               登录态 + 账号信息
 *   GET  /search?keyword=&limit=   关键词搜索
 *   GET  /suggest?keyword=     搜索联想
 *   GET  /lyric?id=            歌词（逐字为主，type=word）
 *   GET  /stream?id=&quality=  解密后的音频字节（支持 Range）
 *   GET  /feed                 首页推荐流
 *   POST /login/qr             取扫码二维码
 *   POST /login/qr/check       轮询扫码结果（body: {token}）
 *   POST /logout               退出登录（清内存 + 删会话文件）
 *
 * 合规：ly-music-source 是 GPL-3.0-only，Aria 是 MIT。这里只以**独立副进程**
 * 的方式调用它（进程边界，不做代码链接/静态合并），与另外三个 vendor 同性质。
 * 音频仅本机播放用，不落公开分发。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3300);
/* 运行时数据（第三方库 + 扫码会话）都在 _eval 下：绿色版与开发树里
   scripts/ 与 _eval/ 是同级目录，所以 '..' 在两种布局下都成立。 */
const DATA_DIR = process.env.ARIA_QISHUI_DATA_DIR
    || path.join(__dirname, '..', '_eval', 'qishui-music-api');
const SESSION_FILE = path.join(DATA_DIR, '.session.json');
const VENDOR_ENTRY = path.join(DATA_DIR, 'vendor', 'node_modules', 'ly-music-source', 'dist', 'index.js');
const DEBUG = !!process.env.ARIA_QISHUI_DEBUG;

/* ==================== 扫码诊断留痕 ====================
 * 「扫码后没反应」只能靠真机（用户手机）复现，而副进程的 stdout/stderr 被 Python
 * 侧接到 DEVNULL（进程边界，避免管道写满把子进程堵死）—— 桌面版里这个问题不留
 * 任何痕迹，只能靠猜。这里做两件事：
 *   1) 打开库自带的 QISHUI_QR_DEBUG：它会把上游 check_qrconnect 的原始
 *      status / error_code / description / bodyHead 打到 console.error；
 *   2) 把 console.error 分流一份到 data 目录的 .qr-log.jsonl 落盘。
 * 该文件与 .session.json 同级（同属 _eval/，已被 .gitignore 排除）。
 * ★ 只记状态与 cookie **名**，不记 cookie 值；诊断自身出错绝不影响登录主流程。
 */
const QR_LOG = path.join(DATA_DIR, '.qr-log.jsonl');
const QR_LOG_MAX = 256 * 1024;
process.env.QISHUI_QR_DEBUG = '1';
const _origConsoleError = console.error.bind(console);
console.error = (...args) => {
    try {
        const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        if (line.startsWith('[qishui qr poll]')) {
            try {
                if (fs.statSync(QR_LOG).size > QR_LOG_MAX) fs.writeFileSync(QR_LOG, '');
            } catch (e) { /* 首次写盘时文件还不存在，正常 */ }
            fs.appendFileSync(QR_LOG, `${new Date().toISOString()} ${line.slice(0, 800)}\n`);
        }
    } catch (e) { /* 诊断失败不影响登录 */ }
    _origConsoleError(...args);
};

/* ==================== 库加载（失败也起服务，便于上游报「为什么不可用」） ==================== */
let createMusicSource = null;
let isMusicSourceError = () => false;
let libErr = '';
try {
    const mod = await import(new URL(`file://${VENDOR_ENTRY.replace(/\\/g, '/')}`).href);
    createMusicSource = mod.createMusicSource;
    isMusicSourceError = mod.isMusicSourceError || (() => false);
} catch (e) {
    libErr = `${e && e.name}: ${e && e.message}`;
}

function dbg(...a) {
    if (DEBUG) process.stderr.write(`[qishui] ${a.join(' ')}\n`);
}

/* ==================== 会话（库只存内存，这里负责落盘） ==================== */
function loadSessionInto(c) {
    try {
        const raw = fs.readFileSync(SESSION_FILE, 'utf8');
        const bundle = JSON.parse(raw);
        if (bundle && bundle.version === 1) {
            c.importSession(bundle);
            dbg('session restored from', SESSION_FILE);
            return true;
        }
    } catch (e) { /* 不存在/损坏都当未登录，不阻塞启动 */ }
    return false;
}

function persistSession(c, on) {
    try {
        if (!on) {
            try { fs.rmSync(SESSION_FILE, { force: true }); } catch (e) { /* ignore */ }
            return;
        }
        fs.writeFileSync(SESSION_FILE, JSON.stringify(c.exportSession()), 'utf8');
        dbg('session persisted');
    } catch (e) {
        dbg('persist session failed:', e && e.message);
    }
}

/* ==================== 客户端单例 ==================== */
let _client = null;
function client() {
    if (!createMusicSource) throw new Error(`汽水 vendor 库未就绪（${libErr || VENDOR_ENTRY}）`);
    if (!_client) {
        _client = createMusicSource({ defaultQuality: 'higher', timeoutMs: 20000 });
        loadSessionInto(_client);
    }
    return _client;
}

/* ==================== 账号信息缓存（/status 被前端轮询，别每次都打上游） ====================
 * ★ /status 必须**永不阻塞**：它被前端 2~5s 轮询一次，而 getProfile 要打上游
 *   /luna/pc/me，冷启动或弱网下可能几秒才回。若同步 await，整条状态轮询会被拖住
 *   （设置页转圈、Python 的 status_all 也跟着慢）。所以这里改成：
 *   命中有缓存就回，没有就先回 authenticated（来自内存态，零网络）并在后台补取。
 *   代价是扫码成功后的第一次 /status 可能没有 uid —— 下一次轮询就补上了。
 */
const PROFILE_TTL = 30000;
let _profile = { at: 0, uid: '', nickname: '', vipLevel: '' };
let _profileFetch = null;

function kickProfileFetch(c) {
    if (_profileFetch) return;
    _profileFetch = (async () => {
        try {
            const p = await c.getProfile();
            _profile = {
                at: Date.now(),
                uid: String(p.id || ''),
                nickname: p.nickname || '',
                vipLevel: p.vipLevel || '',
            };
        } catch (e) {
            /* 拿不到资料不算掉线：登录态由 getAuthState 定，资料只是展示用。
               负缓存一个短 TTL，避免每个轮询都重试一次慢请求。 */
            dbg('getProfile failed:', e && e.message);
            _profile = { ..._profile, at: Date.now() - PROFILE_TTL + 5000 };
        } finally {
            _profileFetch = null;
        }
    })();
}

function authSnapshot() {
    const c = client();
    const st = c.getAuthState();
    if (!st || !st.authenticated) {
        _profile = { at: Date.now(), uid: '', nickname: '', vipLevel: '' };
        return { authenticated: false, uid: '', nickname: '', vipLevel: '' };
    }
    if (Date.now() - _profile.at > PROFILE_TTL) kickProfileFetch(c);
    return { authenticated: true, uid: _profile.uid, nickname: _profile.nickname, vipLevel: _profile.vipLevel };
}

/* ==================== 音频流：内存 LRU + Range ==================== */
const STREAM_CACHE_MAX = 6;          // 一首 5 分钟 m4a ≈ 5MB，6 首封顶约 30MB
const streamCache = new Map();       // id -> { buf, mime, ext }
const inflight = new Map();          // id -> Promise，防同一首歌并发重复解密

const MIME_BY_EXT = {
    m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/mp4',
    mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg',
    opus: 'audio/ogg', wav: 'audio/wav',
};

function cachePut(id, val) {
    streamCache.delete(id);
    streamCache.set(id, val);
    while (streamCache.size > STREAM_CACHE_MAX) {
        streamCache.delete(streamCache.keys().next().value);
    }
}

function pickMime(ext, upstreamMime) {
    const e = String(ext || '').toLowerCase().replace(/^\./, '');
    if (MIME_BY_EXT[e]) return MIME_BY_EXT[e];
    const m = String(upstreamMime || '').toLowerCase();
    if (m.startsWith('audio/')) return m;
    /* 兜底必须给合法 audio/*：server.py 的 _sanitize_audio_ctype 会按本串判容器，
       给 application/octet-stream 会被它按 URL 扩展名兜底 —— 而我们的 URL 没有扩展名。 */
    return 'audio/mpeg';
}

async function resolveAudio(id, quality) {
    if (streamCache.has(id)) return streamCache.get(id);
    if (inflight.has(id)) return inflight.get(id);
    const task = (async () => {
        const c = client();
        const r = await c.resolve({ ids: { qishui: String(id) }, quality });
        let buf = Buffer.isBuffer(r.data) ? r.data : null;
        if (!buf && r.filePath) {
            try { buf = fs.readFileSync(r.filePath); } catch (e) { buf = null; }
        }
        if (!buf && r.url) {
            const res = await fetch(r.url);
            if (res.ok) buf = Buffer.from(await res.arrayBuffer());
        }
        if (!buf || !buf.length) {
            const err = new Error('汽水未返回可播放音频（可能为试听或需登录）');
            err.code = r.isPreview ? 'PREVIEW_ONLY' : 'NO_URL';
            throw err;
        }
        const ext = String(r.ext || '').toLowerCase().replace(/^\./, '');
        const val = { buf, mime: pickMime(ext, r.mimeType), ext: ext || 'm4a' };
        cachePut(id, val);
        return val;
    })();
    inflight.set(id, task);
    try {
        return await task;
    } finally {
        inflight.delete(id);
    }
}

/** 解析单段 Range（只取起始段，与 server.py 既有实现对上游的要求一致） */
function parseRange(header, total) {
    if (!header || !/^bytes=/.test(header)) return null;
    const spec = header.slice(6).split(',')[0].trim();
    const m = /^(\d*)-(\d*)$/.exec(spec);
    if (!m) return null;
    let start, end;
    if (m[1] === '') {
        const n = Number(m[2]);            // bytes=-N 末尾 N 字节
        if (!Number.isFinite(n) || n <= 0) return null;
        start = Math.max(0, total - n);
        end = total - 1;
    } else {
        start = Number(m[1]);
        end = m[2] === '' ? total - 1 : Number(m[2]);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start > end || start >= total) return { unsatisfiable: true };
    return { start, end: Math.min(end, total - 1) };
}

/* ==================== 工具 ==================== */
function sendJson(res, code, obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(body.length),
    });
    res.end(body);
}

function fail(res, e, fallbackCode = 'PLATFORM') {
    const code = (e && e.code) || fallbackCode;
    const msg = (e && e.message) || String(e);
    dbg('fail', code, msg);
    /* ★ 业务错误一律 200 + {ok:false}：server.py 的 _proxy_raw 把非 2xx 转成
       HTTPError 并把响应体塞进去，前端 150/175 的 res.ok 判定会直接判失败 —— 
       我们要的是「能读到失败原因」，不是「看起来像网络挂了」。 */
    sendJson(res, 200, { ok: false, code, err: msg });
}

async function readBody(req) {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return {}; }
}

/* ==================== 路由 ==================== */
const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const p = u.pathname.replace(/\/+$/, '') || '/';
    const q = u.searchParams;

    try {
        if (p === '/' ) {
            return sendJson(res, 200, {
                ok: true, name: 'qishui-music-api', version: '1.0.0',
                hasLibrary: !!createMusicSource, libErr: libErr || undefined,
            });
        }

        if (p === '/status') {
            if (!createMusicSource) {
                return sendJson(res, 200, { ok: false, hasLibrary: false, authenticated: false, err: libErr });
            }
            const snap = authSnapshot();
            return sendJson(res, 200, { ok: true, hasLibrary: true, ...snap });
        }

        if (p === '/search') {
            const kw = (q.get('keyword') || q.get('word') || '').trim();
            if (!kw) return sendJson(res, 200, { ok: false, err: '缺少 keyword' });
            const limit = Math.max(1, Math.min(100, Number(q.get('limit')) || 30));
            const songs = await client().searchSongs(kw, { limit });
            return sendJson(res, 200, { ok: true, songs: songs || [] });
        }

        if (p === '/suggest') {
            const kw = (q.get('keyword') || '').trim();
            if (!kw) return sendJson(res, 200, { ok: true, items: [] });
            const items = await client().searchSuggestions(kw, { limit: 10 });
            return sendJson(res, 200, { ok: true, items: items || [] });
        }

        if (p === '/lyric') {
            const id = (q.get('id') || '').trim();
            if (!id) return sendJson(res, 200, { ok: false, err: '缺少 id' });
            const l = await client().getLyric(id, { platform: 'qishui' });
            return sendJson(res, 200, {
                ok: true, type: l.type, lines: l.lines || [], raw: l.raw || '',
            });
        }

        if (p === '/feed') {
            const r = await client().getSongFeed({});
            return sendJson(res, 200, { ok: true, songs: (r && r.items) || [] });
        }

        /* ★ 「我的歌单」——需登录：库内部 ctx.requireCookie()，未登录抛
           MusicSourceError('UNAUTHENTICATED')，经 fail() 转成 200 +
           {ok:false,code:'UNAUTHENTICATED'}。前端据此提示「未登录」并引导去
           设置页扫码，而不是把它当成网络故障（两者对用户的下一步动作完全不同）。 */
        if (p === '/playlists') {
            const limit = Math.max(1, Math.min(100, Number(q.get('limit')) || 50));
            const list = await client().listUserPlaylists({ limit });
            return sendJson(res, 200, {
                ok: true,
                playlists: (list || []).map(pl => ({
                    id: String(pl.id),
                    name: pl.name || '歌单',
                    cover: pl.coverUrl || '',
                    count: pl.trackCount || 0,
                    kind: pl.kind || '',
                    creator: pl.creator || '',
                })),
            });
        }

        /* 歌单详情——**匿名即可**（库实现里没有 requireCookie）：给「歌单卡片 →
           歌曲列表」用。汽水歌单详情是游标翻页，库内部已循环拉满，这里只做限幅。 */
        if (p === '/playlist') {
            const id = (q.get('id') || '').trim();
            if (!id) return sendJson(res, 200, { ok: false, err: '缺少 id' });
            const limit = Math.max(1, Math.min(1000, Number(q.get('limit')) || 500));
            const r = await client().getPlaylist(id, { limit });
            return sendJson(res, 200, {
                ok: true,
                name: (r && r.playlist && r.playlist.name) || '',
                cover: (r && r.playlist && r.playlist.coverUrl) || '',
                songs: (r && r.songs) || [],
            });
        }

        if (p === '/stream') {
            const id = (q.get('id') || '').trim();
            if (!id) return sendJson(res, 404, { ok: false, err: '缺少 id' });
            const quality = (q.get('quality') || 'higher').toLowerCase();
            const qq = ['standard', 'higher', 'lossless'].includes(quality) ? quality : 'higher';
            let got;
            try {
                got = await resolveAudio(id, qq);
            } catch (e) {
                return sendJson(res, 502, { ok: false, code: (e && e.code) || 'NO_URL', err: (e && e.message) || String(e) });
            }
            const total = got.buf.length;
            const head = {
                'Content-Type': got.mime,
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-store',
            };
            const rng = parseRange(req.headers.range, total);
            if (rng && rng.unsatisfiable) {
                res.writeHead(416, { ...head, 'Content-Range': `bytes */${total}` });
                return res.end();
            }
            if (rng) {
                const part = got.buf.subarray(rng.start, rng.end + 1);
                res.writeHead(206, {
                    ...head,
                    'Content-Range': `bytes ${rng.start}-${rng.end}/${total}`,
                    'Content-Length': String(part.length),
                });
                return res.end(part);
            }
            res.writeHead(200, { ...head, 'Content-Length': String(total) });
            return res.end(got.buf);
        }

        if (p === '/login/qr') {
            const s = await client().createQrLogin('qishui');
            return sendJson(res, 200, {
                ok: true, platform: 'qishui',
                token: s.token, qrcode: s.qrcode || '',
                qrcodeIndexUrl: s.qrcodeIndexUrl || '',
                expireTime: s.expireTime || 0,
            });
        }

        if (p === '/login/qr/check') {
            const body = await readBody(req);
            const token = String(body.token || q.get('token') || '');
            if (!token) return sendJson(res, 200, { ok: false, loggedIn: false, err: '缺少 token' });
            const r = await client().pollQrLogin('qishui', token);
            if (r && r.status === 'confirmed' && r.session) {
                /* 库把会话写进内存，落盘由我们负责（README 明说 persistence is your job） */
                persistSession(client(), true);
                _profile = { at: 0, uid: '', nickname: '', vipLevel: '' };
                const snap0 = authSnapshot();
                /* 登录成功这一刻值得多等一次 profile：设置页要显示账号，
                   而且 Python 侧 isReady() 要求 uid 非空才放行收藏/歌单。 */
                kickProfileFetch(client());
                if (_profileFetch) { try { await _profileFetch; } catch (e) { /* ignore */ } }
                const snap = { ...snap0, ...authSnapshot() };
                return sendJson(res, 200, { ok: true, loggedIn: true, status: 'confirmed', uid: snap.uid, nickname: snap.nickname });
            }
            /* waiting / scanned / expired / failed 原样透传，前端按 status 提示 */
            return sendJson(res, 200, {
                ok: true, loggedIn: false,
                status: (r && r.status) || 'waiting',
                message: (r && r.message) || '',
            });
        }

        if (p === '/logout') {
            client().logout('qishui');
            persistSession(client(), false);
            _profile = { at: 0, uid: '', nickname: '', vipLevel: '' };
            return sendJson(res, 200, { ok: true, loggedIn: false });
        }

        return sendJson(res, 404, { ok: false, err: `unknown path ${p}` });
    } catch (e) {
        if (isMusicSourceError(e)) return fail(res, e);
        return fail(res, e, 'PLATFORM');
    }
});

server.listen(PORT, () => {
    process.stdout.write(`qishui-music-api listening on ${PORT} (library=${!!createMusicSource})\n`);
});

/* 副进程被 taskkill /T 清理；这里只保证 Ctrl+C / SIGTERM 时体面退出 */
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { try { server.close(); } catch (e) { /* ignore */ } process.exit(0); });
}
