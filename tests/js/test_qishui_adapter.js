/* ============================================================
 * tests/js/test_qishui_adapter.js — 汽水适配层(scripts/qishui-server.mjs)HTTP 契约单测
 * 运行方式：node --test tests/js/test_qishui_adapter.js
 *
 * 为什么要这份：_eval/ 整个目录被 .gitignore 排除，CI 上**永远没有真 vendor**
 * （setup-vendors.bat 不跑）。于是适配层的新端点如果只被 e2e 打桩覆盖，
 * 就等于没有任何 CI 保护 —— 端点名字打错、字段名改了，主干照样绿。
 * 这里用「临时目录 + 假库」把真实适配层进程拉起来，钉住四条契约：
 *   ① /feed、/playlist 的路由与出参形状；
 *   ② /playlists 未登录 → 200 + {ok:false,code:'UNAUTHENTICATED'}
 *      （**不是** HTTP 401：前端只看 res.ok 就会把业务失败当网络故障）；
 *   ③ 歌单对象的 vendor 字段(coverUrl/trackCount)必须映射成卡片字段(cover/count)；
 *   ④ 未知 path 回 404，业务失败回 200 —— 两者语义不能混。
 *
 * 假库放在 $DATA_DIR/vendor/node_modules/ly-music-source/dist/index.js，
 * 与真库同路径（适配层按 npm 惯例寻址），靠 ARIA_QISHUI_DATA_DIR 重定向。
 * 登录态用 $DATA_DIR/.stub-auth 文件开关，这样测试进程能实时翻转它。
 * ============================================================ */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ADAPTER = path.join(ROOT, 'scripts', 'qishui-server.mjs');

/* 假库：只实现适配层真正会调的成员。登录态读 $DATA_DIR/.stub-auth，
   于是测试进程写/删这个文件就能翻转「已登录 / 未登录」。 */
const STUB_LIB = `
import fs from 'node:fs';
import path from 'node:path';
export class MusicSourceError extends Error {
    constructor(code, message) { super(message); this.name = 'MusicSourceError'; this.code = code; }
}
export function isMusicSourceError(e) { return !!(e && e.name === 'MusicSourceError'); }
function authed() {
    try { return fs.existsSync(path.join(process.env.ARIA_QISHUI_DATA_DIR || '.', '.stub-auth')); }
    catch (e) { return false; }
}
function song(id, title) {
    return { platform: 'qishui', id, title, artists: [{ name: '歌手' + id }],
        album: '专辑' + id, coverUrl: 'http://stub/' + id + '.jpg', durationMs: 1234 };
}
export function createMusicSource() {
    return {
        getAuthState() { return { authenticated: authed() }; },
        getProfile() {
            return Promise.resolve({ platform: 'qishui', id: 'uid-stub', nickname: '桩',
                avatarUrl: '', isVip: false, vipLevel: 'none' });
        },
        getSongFeed() { return Promise.resolve({ items: [song('feed1', '推荐流曲一')], hasMore: false }); },
        listUserPlaylists() {
            if (!authed()) throw new MusicSourceError('UNAUTHENTICATED', 'Qishui session required');
            return Promise.resolve([
                { platform: 'qishui', id: 'pl1', name: '我的歌单一',
                    coverUrl: 'http://stub/pl1.jpg', trackCount: 7, kind: 'created', creator: '我' },
            ]);
        },
        getPlaylist(id) {
            if (!id) throw new MusicSourceError('INVALID_ARGUMENT', 'playlistId required');
            return Promise.resolve({
                playlist: { platform: 'qishui', id, name: '公开歌单', coverUrl: 'http://stub/p.jpg' },
                songs: [song('pls1', '歌单曲一')],
            });
        },
        importSession() { return true; },
        exportSession() { return { version: 1 }; },
        logout() {},
    };
}
`;

let proc = null;
let port = 0;
let dataDir = '';

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const p = srv.address().port;
            srv.close(() => resolve(p));
        });
    });
}

async function httpGet(p) {
    const res = await fetch(`http://127.0.0.1:${port}${p}`);
    let body;
    try { body = await res.json(); } catch (e) { body = null; }
    return { status: res.status, body };
}

async function waitListen(timeoutMs = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            const r = await httpGet('/');
            if (r.status === 200 && r.body && r.body.ok) return true;
        } catch (e) { /* 还没起来 */ }
        await new Promise(r => setTimeout(r, 150));
    }
    return false;
}

before(async () => {
    port = await freePort();
    dataDir = mkdtempSync(path.join(tmpdir(), 'aria-qishui-stub-'));
    const libDir = path.join(dataDir, 'vendor', 'node_modules', 'ly-music-source', 'dist');
    mkdirSync(libDir, { recursive: true });
    writeFileSync(path.join(libDir, 'index.js'), STUB_LIB, 'utf8');

    proc = spawn(process.execPath, [ADAPTER], {
        env: { ...process.env, PORT: String(port), ARIA_QISHUI_DATA_DIR: dataDir },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.resume();
    proc.stderr.resume();
    const up = await waitListen();
    assert.equal(up, true, `适配层未能在 ${timeoutMs()} ms 内监听 :${port}`);
});

after(() => {
    try { proc && proc.kill(); } catch (e) { /* ignore */ }
    try { if (dataDir && existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

function auth(on) {
    const f = path.join(dataDir, '.stub-auth');
    if (on) writeFileSync(f, '1', 'utf8');
    else { try { rmSync(f, { force: true }); } catch (e) { /* ignore */ } }
}

test('启动即健康：库加载成功', async () => {
    const r = await httpGet('/');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.hasLibrary, true);
});

test('/feed：匿名推荐流出参形状', async () => {
    const r = await httpGet('/feed');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(Array.isArray(r.body.songs), true);
    assert.equal(r.body.songs.length, 1);
    assert.equal(r.body.songs[0].title, '推荐流曲一');
    assert.equal(r.body.songs[0].artists[0].name, '歌手feed1');
});

test('/playlists 未登录：200 + ok:false + UNAUTHENTICATED（不是 HTTP 错误）', async () => {
    auth(false);
    const r = await httpGet('/playlists');
    assert.equal(r.status, 200, '业务失败必须是 200，否则前端 res.ok 判定会把它当网络故障');
    assert.equal(r.body.ok, false);
    assert.equal(r.body.code, 'UNAUTHENTICATED');
});

test('/playlists 已登录：vendor 字段映射成卡片字段(cover/count)', async () => {
    auth(true);
    const r = await httpGet('/playlists');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.playlists.length, 1);
    const c = r.body.playlists[0];
    assert.equal(c.id, 'pl1');
    assert.equal(c.name, '我的歌单一');
    assert.equal(c.cover, 'http://stub/pl1.jpg', 'coverUrl → cover');
    assert.equal(c.count, 7, 'trackCount → count');
});

test('/playlist?id=：返回歌单名与曲目', async () => {
    const r = await httpGet('/playlist?id=pl1&limit=30');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.name, '公开歌单');
    assert.equal(r.body.cover, 'http://stub/p.jpg');
    assert.equal(r.body.songs.length, 1);
    assert.equal(r.body.songs[0].id, 'pls1');
});

test('/playlist 缺 id：明确报错且仍是 200', async () => {
    const r = await httpGet('/playlist');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.match(String(r.body.err), /缺少 id/);
});

test('未知 path：404 + unknown path（与业务失败的 200 语义区分开）', async () => {
    const r = await httpGet('/nope-not-a-route');
    assert.equal(r.status, 404);
    assert.equal(r.body.ok, false);
    assert.match(String(r.body.err), /unknown path/);
});

test('/status：未登录时 authenticated=false 且不阻塞', async () => {
    auth(false);
    const t0 = Date.now();
    const r = await httpGet('/status');
    const ms = Date.now() - t0;
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.authenticated, false);
    assert.ok(ms < 3000, `/status 不得阻塞（实测 ${ms}ms）`);
});

function timeoutMs() { return 20000; }
