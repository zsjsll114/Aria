/*
 * shazam-server.mjs — node-shazam 本地 HTTP 侧车服务 (Tauri sidecar, 阶段2)
 *
 * 端口: 18089 (与 scripts/sidecar-bindings.js 约定一致)
 * 路由:
 *   GET  /health            -> { ok:true, service, port, up:{shazamioCore,ffmpeg} }
 *   GET  /proxy?url=<目标>   -> 通用 CORS 代理 (供 musicApi proxyFetch 用)
 *   POST /recognize         -> body { audioBase64, filename }  -> Shazam 声学指纹识曲
 *
 * 依赖: shazamio-core (纯本地 WASM 指纹), @ffmpeg-installer/ffmpeg
 */
import { createRequire } from 'module';
import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';

const require = createRequire(import.meta.url);
const core = require('shazamio-core');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');

const PORT = 18089;
const HOST = '127.0.0.1';
const ffmpegPath = ffmpegInstaller.path;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
  res.end(body);
}

function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  }).toUpperCase();
}

/** 截取指定片段为 16kHz 单声道标准 WAV (流式到内存) */
function extractWavSnippet(inputPath, startSec = 0, durationSec = 10) {
  return new Promise((resolve, reject) => {
    const args = [
      '-ss', String(startSec), '-i', inputPath,
      '-t', String(durationSec),
      '-f', 'wav', '-ar', '16000', '-ac', '1', 'pipe:1'
    ];
    const proc = spawn(ffmpegPath, args);
    const chunks = [];
    proc.stdout.on('data', c => chunks.push(c));
    proc.stderr.on('data', () => {});
    proc.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exit ${code}`)));
    proc.on('error', reject);
  });
}

/** 查询 Apple Shazam 官方识别服务器 */
async function queryShazam(sig) {
  const endpoint = `https://amp.shazam.com/discovery/v5/zh/CN/web/-/tag/${uuidv4()}/${uuidv4()}?sync=true&webv3=true&sampling=true&shazamapiversion=v3`;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      body: JSON.stringify({
        timezone: 'Asia/Shanghai',
        signature: { uri: sig.uri, samplems: sig.samplems },
        timestamp: Date.now(),
        context: {},
        geolocation: {}
      })
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text)?.track || null; } catch { return null; }
  } catch { return null; }
}

/** 对本地音频文件做 Shazam 声学指纹多重扫描识曲 */
async function recognizeFile(filePath) {
  const offsets = [0, 20, 45, 75, 100];
  for (const offset of offsets) {
    try {
      const wavBuffer = await extractWavSnippet(filePath, offset, 10);
      if (!wavBuffer || wavBuffer.length === 0) continue;

      const decodedSig = core.recognizeBytes(new Uint8Array(wavBuffer));
      const sig = Array.isArray(decodedSig) ? decodedSig[0] : decodedSig;
      if (!sig || !sig.uri) continue;

      const track = await queryShazam(sig);
      if (track && track.title) {
        let coverUrl = track.images?.coverarthq || track.images?.coverart || '';
        if (coverUrl && coverUrl.includes('400x400')) coverUrl = coverUrl.replace('400x400', '800x800');
        return {
          success: true,
          method: 'shazam-node',
          title: track.title,
          artist: track.subtitle || '未知歌手',
          album: track.sections?.[0]?.metadata?.find(m => m.title === 'Album')?.text || '',
          year: track.sections?.[0]?.metadata?.find(m => m.title === 'Released')?.text || '',
          genre: track.genres?.primary || '',
          label: track.sections?.[0]?.metadata?.find(m => m.title === 'Label')?.text || '',
          coverUrl,
          isrc: track.isrc || '',
          offset
        };
      }
    } catch { /* 尝试下一 offset */ }
  }
  return { success: false, method: 'shazam-node', error: 'Shazam 未收录此音频指纹' };
}

/** 解码 base64(data URL 或裸 base64) 并按文件名/类型写临时文件 */
function decodeBase64Audio(audioBase64, filename) {
  if (!audioBase64) return null;
  let b64 = audioBase64;
  let ext = '.webm';
  const mimeMatch = /^data:([^;]+);base64,/.exec(b64);
  if (mimeMatch) {
    const mime = mimeMatch[1];
    ext = mime.includes('webm') ? '.webm' : mime.includes('ogg') ? '.ogg' : mime.includes('mpeg') || mime.includes('mp3') ? '.mp3' : mime.includes('m4a') ? '.m4a' : '.webm';
    b64 = b64.slice(mimeMatch[0].length);
  }
  if (filename) {
    const fext = path.extname(filename).toLowerCase();
    if (['.webm', '.ogg', '.wav', '.mp3', '.mp4', '.m4a', '.flac', '.aac'].includes(fext)) ext = fext;
  }
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0) return null;
  const tmpDir = path.join(os.tmpdir(), 'lyrics-shazam-node');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `rec_${Date.now()}${ext}`);
  fs.writeFileSync(tmpPath, buf);
  return tmpPath;
}

/** 通用 CORS 代理: 取目标 URL 并透传 */
async function handleProxy(url, res, req) {
  const target = url.searchParams.get('url');
  if (!target) return sendJSON(res, 400, { error: 'url param missing' });
  // ★ 开放代理最小加固：仅 http/https，且仅本机页面可调用（公网页面无法借用本机代理做 SSRF）
  try {
    const u = new URL(target);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return sendJSON(res, 400, { error: 'scheme rejected' });
    }
    const origin = req.headers.origin || '';
    if (origin && !origin.startsWith('http://localhost') && !origin.startsWith('http://127.0.0.1')) {
      return sendJSON(res, 403, { error: 'origin rejected' });
    }
  } catch {
    return sendJSON(res, 400, { error: 'url invalid' });
  }
  try {
    const upstream = await fetch(target, { signal: AbortSignal.timeout(15000) });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'Content-Length': buf.length,
      ...CORS
    });
    res.end(buf);
  } catch (e) {
    sendJSON(res, 502, { error: 'PROXY_FAIL', message: e.message });
  }
}

/** 读取 JSON body (上限 32MB) */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 32 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('invalid json: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

async function handleRecognize(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return sendJSON(res, 400, { success: false, error: e.message }); }

  const tmpPath = decodeBase64Audio(body?.audioBase64, body?.filename);
  if (!tmpPath) return sendJSON(res, 400, { success: false, error: 'no audioBase64 provided or empty' });

  try {
    const result = await recognizeFile(tmpPath);
    sendJSON(res, 200, result);
  } catch (e) {
    sendJSON(res, 500, { success: false, error: e.message });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* 清理临时音频失败可忽略 */ }
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  let pathname, url;
  try { url = new URL(req.url, `http://${HOST}:${PORT}`); pathname = url.pathname; }
  catch { return sendJSON(res, 400, { error: 'bad url' }); }

  if (req.method === 'GET' && pathname === '/health') {
    let up = { shazamioCore: typeof core?.recognizeBytes === 'function' };
    try { up.ffmpeg = fs.existsSync(ffmpegPath); } catch { up.ffmpeg = false; }
    return sendJSON(res, 200, { ok: true, service: 'shazam-node', port: PORT, up });
  }
  if (pathname === '/proxy') return handleProxy(url, res, req);
  if (req.method === 'POST' && pathname === '/recognize') return handleRecognize(req, res);

  return sendJSON(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[shazam-server] listening on http://${HOST}:${PORT}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));