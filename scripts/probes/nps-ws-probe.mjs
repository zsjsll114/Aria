#!/usr/bin/env node
/**
 * NPS/now-playing WebSocket 探针
 *
 * 用途：连上本机 NPS（kthri/now-playing）的 WS，把每个 event 的**帧结构**打出来；
 *       遇到歌词帧则额外打印长字符串字段的原文片段。用于排查
 *       「歌词是 LRC 还是 QRC 逐字」「进度字段精度是秒还是毫秒」这类问题。
 *
 * 用法：
 *   node scripts/probes/nps-ws-probe.mjs                       # 默认 12 秒、见 6 种 event 即退
 *   node scripts/probes/nps-ws-probe.mjs --seconds 30
 *   node scripts/probes/nps-ws-probe.mjs --url ws://127.0.0.1:9863/api/ws/lyric
 *   node scripts/probes/nps-ws-probe.mjs --events 20           # 收集更多种 event 再退
 *
 * 退出码：0 正常（含超时），1 建连失败。
 */
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const URL_ = arg('url', 'ws://127.0.0.1:9863/api/ws/lyric');
const SECONDS = Number(arg('seconds', '12'));
const MAX_EVENTS = Number(arg('events', '6'));
const MAX_FRAMES = Number(arg('frames', '60'));

const seen = new Map();
let frames = 0;

const brief = (s, n = 220) =>
  typeof s !== 'string' ? s : (s.length > n ? `${s.slice(0, n)}…(共${s.length}字符)` : s);

/** 把一个 JSON 对象压成 "path: type = value" 的扁平行，便于一眼看清帧结构 */
function shape(o, p = '', depth = 0) {
  const out = [];
  if (depth > 3 || !o || typeof o !== 'object') return out;
  for (const k of Object.keys(o)) {
    const v = o[k];
    const t = Array.isArray(v) ? `array(${v.length})` : typeof v;
    if (v && typeof v === 'object') {
      out.push(`${p}${k}: ${t}`);
      out.push(...shape(v, p + '  ', depth + 1));
    } else {
      out.push(`${p}${k}: ${t} = ${JSON.stringify(brief(v))}`);
    }
  }
  return out;
}

let ws;
try {
  ws = new WebSocket(URL_);
} catch (e) {
  console.log('建连失败:', e.message);
  process.exit(1);
}

ws.onopen = () => console.log(`[open] ${URL_}`);

ws.onmessage = (ev) => {
  frames++;
  const txt = typeof ev.data === 'string' ? ev.data : '[binary]';
  let data = null;
  try {
    data = JSON.parse(txt);
  } catch {
    /* 非 JSON 帧：原样提示 */
  }

  const evt = data && data.event ? data.event : '(无 event)';
  if (!seen.has(evt)) {
    seen.set(evt, true);
    console.log(`\n===== 帧 #${frames}  event=${evt} =====`);
    console.log(shape(data).slice(0, 40).join('\n'));

    /* 歌词帧：正文通常藏在某个超长字符串字段里，把原文打出来才看得出格式 */
    if (/lyric/i.test(evt) || /lyric/i.test(txt)) {
      const d = (data && data.data) || data || {};
      for (const k of Object.keys(d)) {
        if (typeof d[k] === 'string' && d[k].length > 60) {
          console.log(`\n>>> 字段 ${k} 原文前 600 字符:\n${d[k].slice(0, 600)}`);
        }
      }
    }
  }

  if (seen.size >= MAX_EVENTS || frames > MAX_FRAMES) {
    console.log(`\n[收到 ${frames} 帧，已见 event: ${[...seen.keys()].join(', ')}]`);
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  }
};

ws.onerror = (e) => console.log('[error]', e.message || e.type);
ws.onclose = () => {
  console.log('[closed]');
  process.exit(0);
};

setTimeout(() => {
  console.log(`\n[超时退出] 共 ${frames} 帧，event: ${[...seen.keys()].join(', ') || '(无)'}`);
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
}, SECONDS * 1000);
