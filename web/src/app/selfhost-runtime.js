/* ============================================================
 * selfhost-runtime.js — 自建服务播放/日推运行时（供在线加载与日推入口使用）
 * - selfhostStatus: 缓存 5s 的 /api/selfhost/status
 * - selfhostQQPlayUrl: QQ 登录态下优先取高音质（未启用/未登录/失败→null 走原回退链）
 * - dayRecommend: 按设置里的 dailySource 拉取每日推荐
 * 依赖 server.py /api/selfhost/* 与自建副进程。任何异常都安全返回 null/false。
 * ============================================================ */
import { API_BASE } from '../config/constants.js';
import { logCatch, logInfo, logWarn, logError } from '../services/log.js';
import { registerSelfhostPlayHooks } from '../services/selfhostPlayHooks.js';

const SH_KEY = 'selfhost_prefs';
let _statusCache = null;
let _statusAt = 0;
const _STATUS_TTL = 5000;
const _STATUS_STARTING_TTL = 400;

function _hasStartingVendor(cache) {
  if (!cache || typeof cache !== 'object') return false;
  return Object.values(cache).some(v => v && typeof v === 'object' && !v.alive && v.starting === true);
}

export function invalidateSelfhostCaches() {
  _statusCache = null;
  _statusAt = 0;
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try { window.dispatchEvent(new CustomEvent('selfhost-auth-changed')); } catch (e) { logCatch('selfhost', e); }
  }
}

export async function startSelfhostService(platform, restart = false) {
  if (!platform) return { ok: false, err: '缺少平台标识' };
  try {
    const res = await fetch(`/api/selfhost/${encodeURIComponent(platform)}/${restart ? 'restart' : 'start'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const data = await res.json();
    invalidateSelfhostCaches();
    updateSelfHostBadge();
    return data && typeof data === 'object' ? data : { ok: false, err: '响应异常' };
  } catch (e) {
    logWarn('selfhost', '[startSelfhostService] 请求失败:', (e && e.message) || e);
    return { ok: false, err: (e && e.message) || '启动失败' };
  }
}

const DEFAULT_SELFHOST_OPTIONS = {
  qq: {
    playQuality: 'auto',      // auto | flac | 320 | 128 | m4a
    qualityFallback: true,    // 遇到无版权高音质时自动降级
    dailyMode: 'pool',        // pool | personal
    lyricFormat: true,        // isFormat 参数
    searchLimit: 60,          // 10 | 20 | 30 | 60
  },
  kugou: {
    dailyPlatform: 'ios',     // ios | android
    freePart: false,          // free_part=1 允许试听片段
  },
  netease: {
    playLevel: 'auto',        // auto | standard | higher | exhigh | lossless | hires | jyeffect | sky | jymaster
    levelFallback: true,      // 遇 freeTrialInfo/受限 自动沿阶梯降级
    encodeType: 'flac',       // flac | aac | mp3
    playlistLimit: 500,       // 歌单单次拉取条数上限
    realIP: '',               // 可选：透传 realIP 参数
    proxy: '',                // 可选：透传 proxy 参数
  },
};

function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(SH_KEY));
    if (raw && typeof raw === 'object') return raw;
  } catch (e) { /* 读本地配置失败走默认值 */ }
  return { enabled: { kugou: false, qq: false, netease: false }, dailySource: 'netease', options: {} };
}

export function getSelfhostOptions(platform) {
  const defs = DEFAULT_SELFHOST_OPTIONS[platform] || {};
  const prefs = loadPrefs();
  const saved = (prefs.options && prefs.options[platform]) || {};
  return { ...defs, ...(typeof saved === 'object' ? saved : {}) };
}

export function saveSelfhostOption(platform, patch) {
  if (!platform || !patch || typeof patch !== 'object') return;
  const prefs = loadPrefs();
  if (!prefs.options || typeof prefs.options !== 'object') prefs.options = {};
  prefs.options[platform] = { ...(prefs.options[platform] || {}), ...patch };
  try { localStorage.setItem(SH_KEY, JSON.stringify(prefs)); } catch (e) { logCatch('selfhost', e); }
}

function _appendNeteaseOpts(path) {
  const opts = getSelfhostOptions('netease');
  const params = [];
  if (opts.realIP && String(opts.realIP).trim()) {
    params.push('realIP=' + encodeURIComponent(String(opts.realIP).trim()));
  }
  if (opts.proxy && String(opts.proxy).trim()) {
    params.push('proxy=' + encodeURIComponent(String(opts.proxy).trim()));
  }
  if (!params.length) return path;
  const sep = path.includes('?') ? '&' : '?';
  return path + sep + params.join('&');
}

/* ★ 状态请求的两条纪律（2026-10-07，缺一条都会出真事故）：
   1) **并发合并**：日推/歌单一打开就并行问 4 个平台，每个 dayRecommend 都先
      fetchStatus()。不去重会同时打出 4 个 /status —— 而第 2 条会让"不是最新的"
      那几个响应被丢弃、调用方拿到 null，结果**日推一行都不渲染**（实测踩到）。
   2) **乱序守卫**：/api/selfhost/status 在没有 vendor 的机器上很慢（要逐个探测/
      尝试拉起副进程，实测可到十几秒），先发的慢响应后回来会把刚刷出的新状态
      覆盖成旧值 —— 表现是「刚刷新/刚扫码成功，界面又变回离线」。用序号丢弃过期响应。
   两条合起来的正确形状：同一时刻只允许一个在飞，其余调用共享同一个 promise。 */
let _statusSeq = 0;
let _statusInflight = null;

async function fetchStatus(force = false) {
  const now = Date.now();
  const ttl = _hasStartingVendor(_statusCache) ? _STATUS_STARTING_TTL : _STATUS_TTL;
  if (!force && _statusCache && now - _statusAt < ttl) return _statusCache;
  if (_statusInflight) return _statusInflight;     /* 合并：别再打第二个请求 */
  const seq = ++_statusSeq;
  _statusInflight = (async () => {
    try {
      const res = await fetch('/api/selfhost/status');
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      if (seq === _statusSeq) { _statusCache = data; _statusAt = Date.now(); }
    } catch (err) {
      logWarn('selfhost', '[status] 查询失败:', (err && err.message) || err);
      if (seq === _statusSeq) { _statusCache = null; _statusAt = Date.now(); }
    } finally {
      _statusInflight = null;
    }
    return _statusCache;
  })();
  return _statusInflight;
}

async function _waitSelfhostReady(platform, maxWaitMs = 1500, signal = null) {
  let st = await fetchStatus();
  let s = st && st[platform];
  if (!s || s.alive || s.starting !== true || s.error) return s || null;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (signal && signal.aborted) break;
    const step = Math.min(250, Math.max(20, deadline - Date.now()));
    await new Promise((resolve) => setTimeout(resolve, step));
    if (signal && signal.aborted) break;
    st = await fetchStatus(true);
    s = st && st[platform];
    if (!s || s.alive || s.starting !== true || s.error) break;
  }
  return s || null;
}

async function _fetchSelfhostWithTimeout(url, externalSignal = null, timeoutMs = 6500) {
  if (externalSignal && externalSignal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  if (!ctl) {
    return fetch(url, externalSignal ? { signal: externalSignal } : undefined);
  }
  let onAbort = null;
  if (externalSignal && typeof externalSignal.addEventListener === 'function') {
    onAbort = () => ctl.abort();
    externalSignal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctl.signal });
  } finally {
    clearTimeout(timer);
    if (externalSignal && onAbort && typeof externalSignal.removeEventListener === 'function') {
      externalSignal.removeEventListener('abort', onAbort);
    }
  }
}

export function selfhostEnabled(platform) {
  return !!(loadPrefs().enabled && loadPrefs().enabled[platform]);
}

/**
 * QQ 登录态下取高音质播放链接。失败/未启用/未登录返回 null（调用方回落原链）。
 * @param {string} songmid QQ 歌曲 mid
 * @param {string} quality 目标音质（128/320/flac/master）
 */
/** ★ 网易云音质阶梯（2026-10-07 补，与 QQ 的 QQ_QUALITY_LADDER 同理）。
    用户报障「都登录了、都是 VIP，网易云却只有 30 秒试听」的根因就在这里：
    旧实现只看「有没有 http url」——而 /song/url/v1 对**无该音质权益**的曲目会回
    `{url: 30秒试听链, freeTrialInfo:{...}}`，于是试听链被当成正常直链一路用到播放器。
    现在按 freeTrialInfo 识别并逐级下探，全档都是试听才交棒公网兜底。 */
const NETEASE_LEVEL_LADDER = {
  jymaster: ['jymaster', 'sky', 'jyeffect', 'hires', 'lossless', 'exhigh', 'higher', 'standard'],
  sky: ['sky', 'jyeffect', 'hires', 'lossless', 'exhigh', 'higher', 'standard'],
  jyeffect: ['jyeffect', 'hires', 'lossless', 'exhigh', 'higher', 'standard'],
  hires: ['hires', 'lossless', 'exhigh', 'higher', 'standard'],
  lossless: ['lossless', 'exhigh', 'higher', 'standard'],
  exhigh: ['exhigh', 'higher', 'standard'],
  higher: ['higher', 'standard'],
  standard: ['standard'],
};

export async function selfhostNeteasePlayUrl(id, level = 'exhigh', signal = null, opts = {}) {
  /* ★ 上游参考项目 对齐：本机常驻 NeteaseCloudMusicApi 直接 /song/url/v1 一次取直链。
     不要求「自建服务开关/登录」——副进程在线即可（匿名拿标准音质，登录/启用拿官方级音质），
     本机毫秒级回包，替代公网 byfuns 串行 5 档 + 逐次存活探测的等待。离线返回 null 走原有兜底。 */
  if (!id) return null;
  const expSec = Number((opts && opts.expSec) || 0);
  try {
    const s = await _waitSelfhostReady('netease', 1500, signal);
    if (!s || !s.alive) {
      logInfo('selfhost', `[网易云] 副进程不在线（alive=${!!(s && s.alive)}），走公网阶梯`);
      return null;
    }
    const shOpts = getSelfhostOptions('netease');
    const want = String((shOpts.playLevel && shOpts.playLevel !== 'auto') ? shOpts.playLevel : (level || 'exhigh'));
    const fullLadder = NETEASE_LEVEL_LADDER[want] || [want, 'standard'];
    const ladder = shOpts.levelFallback === false ? [want] : fullLadder;
    const encParam = shOpts.encodeType && shOpts.encodeType !== 'flac'
      ? `&encodeType=${encodeURIComponent(String(shOpts.encodeType))}`
      : '';
    let lastNote = '';
    for (const lv of ladder) {
      let res;
      try {
        const apiPath = _appendNeteaseOpts(`/song/url/v1?id=${encodeURIComponent(String(id))}&level=${encodeURIComponent(lv)}${encParam}`);
        res = await _fetchSelfhostWithTimeout(`/api/selfhost/netease/proxy?path=${encodeURIComponent(apiPath)}`, signal, 6500);
      } catch (fetchErr) {
        lastNote = (fetchErr && fetchErr.name === 'AbortError')
          ? '请求超时'
          : `网络异常(${(fetchErr && fetchErr.message) || fetchErr})`;
        break;
      }
      if (!res || (!res.ok && res.status !== 200)) {
        /* 代理失败（副进程没起来等）继续下探没意义，交给公网阶梯 */
        lastNote = `HTTP ${res ? res.status : 'no-response'}`;
        break;
      }
      const j = await res.json().catch(() => null);
      /* /song/url/v1 返回 {data:[{id,url,freeTrialInfo?,time?}]}（数组）；兼容 {data:{url}} 与双层包裹 */
      const d0 = (j && j.data) || {};
      const first = Array.isArray(d0) ? d0[0] : d0;
      const url = (first && first.url) || (d0 && d0.url) || (j && maybeNeteaseUrl(j));
      const trial = !!(first && first.freeTrialInfo) || !!(d0 && d0.freeTrialInfo);
      const timeMs = Number((first && first.time) || (d0 && d0.time) || 0);
      if (!url || !String(url).startsWith('http')) {
        lastNote = `${lv} 无直链（疑 VIP/版权受限）`;
        continue;
      }
      if (trial) {
        /* ★ 试听链（约 30 秒）绝不能当作整曲直链用 —— 这正是"VIP 却只有 30 秒"的来源 */
        lastNote = `${lv} 只给到试听链`;
        continue;
      }
      if (expSec >= 60 && timeMs > 0 && timeMs < expSec * 450) {
        /* ★ JSON 时长（毫秒）明显短于整曲期望时长（<45%），判作变相试听，无需额外发 Range 探测 */
        lastNote = `${lv} 返回时长仅 ${Math.round(timeMs / 1000)}s (< 期望 ${Math.round(expSec)}s)`;
        continue;
      }
      if (lv !== ladder[0]) logInfo('selfhost', `[网易云] 目标音质 ${ladder[0]} 不可用，已降到 ${lv} 取到整曲直链`);
      return url;
    }
    logWarn('selfhost', `[网易云] 自建未取到整曲直链（${lastNote || '未知'}），走公网阶梯`);
    return null;
  } catch (e) {
    logWarn('selfhost', '[网易云] 自建取链接异常:', e && e.message);
    return null;
  }
}
function maybeNeteaseUrl(j) {
  /* /song/url/v1 偶见外层 {data:{data:{url}}} 双层包裹，兜底多点取值 */
  const d = j && j.data && j.data.data;
  const u = d && d.url;
  return (u && u.startsWith('http')) ? u : null;
}

/* ============================================================
 * 酷狗自建取链接：为什么暂不提供 selfhostKugouPlayUrl（2026-09-15 二次更正）
 *
 * ★ 本块已修正两次。前两版结论（「被风控挡死做不出来」/「缺第三方授权验证」）
 *   **都错**，勿沿用。以下是 issue #206 原文 + 本地实测的合并结论。
 *
 * 1. 取链接口：`_eval/KuGouMusicApi/module/song_url.js` → 路由 **`/song/url`**
 *    （server.js:119 的 parseRoute 把文件名下划线转斜杠，不是 /song_url；
 *      `/audio` 只返回各音质 hash 与体积，没有直链）。
 *    参数：hash + quality(128/320/flac/high) + album_id + album_audio_id。
 *
 * 2. 现状：/song/url 返回 `{"errcode":20028,"status":0,"error":"本次请求需要验证"}`，
 *    响应头带 `ssa-code`，体内附带 vendor 已模拟好的 edt/sid
 *    （util/generate_simulate.js，不依赖 wasm，即上游 commit 8e5b07ff）。
 *    也就是说 vendor 侧**已按设计工作**，不是接线缺失。
 *
 * 3. `v_type=38` 的真实含义（issue #206 维护者澄清）：
 *    **服务端要求「登录确认身份」，不是验证码**。kg-login 走 App 原生登录，
 *    全程**不经过 verify_user_info**，也没有可提交的 verifycode；
 *    `partnerid_map{qq,wx,phone}` 只用于第三方**绑定**，与 v_type 判断无关。
 *    其他 v_type：23=腾讯滑块、32=手机验证码（首帖已支持）；
 *    36=需绑定手机号、51=账号被风控需申诉（#206 评论区实测）。
 *
 * 4. 本地实测（均已复现，勿重复踩）：
 *    - 挑战是**会话级**：多首歌拿到同一个 ssa-code；
 *    - **免费曲同样被拦**（公网 status:1 有真链的曲子，自建仍 20028）
 *      → 与 VIP 权益**无关**，不是权限问题，加音质/换歌都不解决；
 *    - **登录态是有效的**：/user/detail 返回真实昵称，token 没问题；
 *    - **回传 vendor 设备 cookie 无效**：把 KUGOU_API_MID/GUID/DEV/WEBGL
 *      回传后 errcode 依旧 20028（已证伪，别再试）；
 *    - **刷新 token 无变化**：/login/token 返回 status=1 但 token 原样。
 *
 * 5. issue #206 里两条未闭环线索：
 *    - 有人**账号密码登录后就能请求了**（评论 #51）→ 疑似需要一次"强登录"；
 *    - 有人怀疑**请求过频会触发「异常事件验证」**（error_code 36010，评论 #43）
 *      → 探测时注意别把风控自己打出来。
 *    截至 2026-09（评论 #73）该 issue 仍未关闭，v_type=38 无确定解法。
 *
 * 7. ★ 2026-10-07 复测（用**手机号短信验证码**重新登录后再试，即上面第 5 条那条备选路）：
 *    仍然全部 20028。复现：/api/selfhost/kugou/proxy?path=/song/url?hash=..&quality=320
 *    对 4 首不同的歌（含非 VIP 翻唱）各试 320 与 flac —— 返回体一致为
 *    `{"errcode":20028,"status":0,"error":"本次请求需要验证","edt":"…"}`；
 *    `edt` 有值 ⇒ **vendor 侧正常**（它按设计模拟好了设备身份），是服务端要身份确认。
 *    ⇒ 结论：手机登录 ≠ 解锁；**不要再朝这个方向试**（既无用又会把账号打进风控）。
 *      设置页文案已如实写明"酷狗无自建取播放链接"，用户不会误解成自己没配好。
 *      酷狗 VIP 曲目前只能靠「跨源同名歌」兜底（见 175 的步骤3-5）。
 *    复现脚本：scratch/_selfhost_kugou_chain.py（纯 Python，直打本机 server）。
 *
 * 8. ★ 2026-10-07 按**上游文档**（kugou_api doc，issue #206 的"20028 解决方案"）把验证流程
 *    走到头，得到两条硬结论：
 *    (a) 挑战 id 确实在**响应头**里：直连 vendor(3100) 时可见
 *        `ssa-code: bj_tx_event_5cc198944830f560638d2a1a31dcad2d`
 *        （命名族与文档说的 `gz_tx_event_xxx` 一致）。**我们的 8001 代理不转发响应头**，
 *        所以应用侧永远看不到它 —— 旧注释里"没有可提交的 verifycode"就是这么误判出来的。
 *        ⇒ 若将来要接 23/32 那两类验证，**先修代理转发响应头**（前置条件）。
 *    (b) 拿 ssa-code 调 `/get/verify/info?eventid=…` 后，服务端自己回答：
 *        `v_type=38, business=4029, v_type_list=[38], partnerid_map={'qq':1,'phone':-1,'wx':36}`。
 *        **38 不在文档的类型表里**（文档已实现 23 腾讯滑块 / 32 手机验证码；其余未做），
 *        且 #206 的定性是"要求登录确认身份、不走 verify_user_info" ⇒ 对 38 做验证码 UI 是错方向。
 *        ⇒ 本项目的账号抽到的是 38，**没有文档化动作可做**。
 *    复现：`python scripts/probes/kugou-verify-probe.py --direct --hash <hash> --album-id .. --album-audio-id ..`
 *    （该探针会读到响应头；注意它会顺带重建 vendor 的设备 cookie，且**别在循环里跑**）。
 *
 * 9. ★ 2026-10-07 查上游源码得到的**可实施清单**（将来真抽到 23/32 时按此做，不必重新调研）：
 *    · 取挑战信息：`GET /get/verify/info?eventid=<ssa-code>` → `{v_type, url, sid, edt, txappid…}`
 *    · 提交验证：  `GET /verify/user/info?eventid=..&v_type=..&verifycode=..&sid=..&edt=..`
 *    · vendor 实现只认两类：`_eval/KuGouMusicApi/module/verify_user_info.js` 里
 *      `if (v_type === 23)` 腾讯图形验证码 / `if (v_type === 32)` 手机短信验证码；
 *      官方示例：`public/login_captcha.html`、`login_captcha_simulate.html`、`verifySlide.html`
 *      （verifycode 形状见文档：23 → `KGCodeTX|{ticket,randstr,txappid}`；32 → 6 位数字）。
 *    · 前置修复：**代理转发响应头**（`ssa-code`）—— 见第 8(a) 条，`server.py:1558` 的 proxy
 *      与 `selfhost_service.proxy_drop_in` 都只回 (status, parsed, raw)，不带 headers。
 *    · **38 不在其中**：它是酷狗 **App 原生登录**流程（H5 里
 *      `LightMobileCall.mobileCall(102, {topicName:'通用验证'})` → App 内完成登录 →
 *      `KgWebMobileCall.pageStatusNew` status=3 → `pushVerifyResultToClient` 回推结果），
 *      **全程不走 verify_user_info**，且只有内嵌在酷狗 App 的 webview 里才有这套桥。
 *      ⇒ 桌面端/网页端**没有该能力**，做 UI 无用。可试的替代只有两条（均属投机）：
 *        (i) 导入酷狗 **App 侧**的会话（设置页已有 cookie 入口，`token=..;userid=..`）；
 *        (ii) 让该账号在**官方 App 登录过一次**（正是 38 流程第 3 步"用户在 App 里完成登录"），
 *             再回来试自建取链 —— 38 可能正是"账号从未在官方 App 端登录过"的风控档位。
 *
 * 6. 公网那条路对**付费曲**是死的：免费曲 `status:1` 给真链，付费曲
 *    `status:0 + error="需要付费"`（连 128k 都拒）。这点结论不变。
 *
 * 结论：**不要照「做第三方授权 UI」的思路做** —— 38 不是授权类验证，做了也是错的。
 * 合理方向是「引导重新登录酷狗 + 把 v_type 翻译成人话给用户」，属功能开发。
 * 复现脚本：scripts/probes/kugou-verify-probe.py
 * 上游背景：https://github.com/MakcRe/KuGouMusicApi/issues/206
 * ============================================================ */

/* ★ QQ 音质降级阶梯（2026-10-03 实测）。
   症状（用户报「有的歌放不出来，vkeys 却能取」）：把「播放音质」设成无损后，
   遇到没有 FLAC 版权的歌（搜索结果里 `sizeflac=0`）时，vendor 的
   `/getMusicPlay?quality=flac` 返回 **空 url + 一句误导性的「Cookie 已失效或 uin
   缺失」**（同一首歌 quality=320/128 都正常回链，cookie 是好的）——于是整条自建
   路径失效，被迫落到更慢也更脆的公网兜底。
   自建能给到的最高音质总比公网兜底强，所以在自建内部先把阶梯走完，再决定交棒。 */
const QQ_QUALITY_LADDER = {
  master: ['flac', '320', '128'],
  atmos: ['flac', '320', '128'],
  hires: ['flac', '320', '128'],
  flac: ['flac', '320', '128'],
  ape: ['ape', '320', '128'],
  '320': ['320', '128'],
  '128': ['128'],
  m4a: ['m4a', '128'],
};

export async function selfhostQQPlayUrl(songmid, quality = '320') {
  /* ★ 显式关闭（prefs.enabled.qq === false）一律跳过；若本地 prefs 尚未初始化（raw 为空），
     服务端已登录（cache/selfhost_login.json）时也允许放行，避免「换端口/清缓存后已登录却被开关挡住」。 */
  if (!songmid) return null;
  let qqExplicitOff = false;
  let hasSavedPrefs = false;
  try {
    const rawStr = typeof localStorage !== 'undefined' ? localStorage.getItem(SH_KEY) : null;
    if (rawStr) {
      const raw = JSON.parse(rawStr);
      if (raw && raw.enabled && typeof raw.enabled.qq === 'boolean') {
        hasSavedPrefs = true;
        if (raw.enabled.qq === false) qqExplicitOff = true;
      }
    }
  } catch (e) { /* ignore */ }
  if (qqExplicitOff) {
    logWarn('selfhost', '[QQ] 自建取链被跳过：平台开关已关闭（设置 → 自建服务 → QQ）；已改用在线源池');
    return null;
  }
  try {
    const s = await _waitSelfhostReady('qq', 1500);
    if (!s || !s.alive || !s.loggedIn) {
      logWarn('selfhost', `[QQ] 自建不可用（alive=${!!(s && s.alive)} loggedIn=${!!(s && s.loggedIn)}），走在线源池`);
      return null;
    }
    if (hasSavedPrefs && !selfhostEnabled('qq')) {
      logWarn('selfhost', '[QQ] 自建取链被跳过：平台开关未启用');
      return null;
    }
    const mid = encodeURIComponent(songmid);
    const qqOpts = getSelfhostOptions('qq');
    const want = String((qqOpts.playQuality && qqOpts.playQuality !== 'auto') ? qqOpts.playQuality : (quality || '320')).toLowerCase();
    const fullLadder = QQ_QUALITY_LADDER[want] || [want, '320', '128'];
    const ladder = qqOpts.qualityFallback === false ? [want] : fullLadder;
    let lastErr = '';
    for (const q of ladder) {
      let res;
      try {
        res = await _fetchSelfhostWithTimeout(`/api/selfhost/qq/proxy?path=${encodeURIComponent(`/getMusicPlay?songmid=${mid}&quality=${encodeURIComponent(q)}`)}`, null, 6500);
      } catch (fetchErr) {
        lastErr = (fetchErr && fetchErr.name === 'AbortError')
          ? '请求超时'
          : `网络异常(${(fetchErr && fetchErr.message) || fetchErr})`;
        break;
      }
      if (!res.ok) {
        /* 带上响应体：代理失败时会回 {'error': '...'}，只报状态码没法定位。
           ★ 走到这一步说明不是「音质不对」而是链路本身坏了，继续下探没有意义，直接交棒。 */
        let detail = '';
        try { const j = await res.json(); detail = (j && (j.error || j.err)) || ''; } catch (e) { /* 非 JSON */ }
        lastErr = `HTTP ${res.status}${detail ? '：' + detail : ''}`;
        break;
      }
      const url = findFirstHttpUrl(await res.json());
      if (url) {
        if (q !== ladder[0]) logInfo('selfhost', `[QQ] 目标音质 ${ladder[0]} 该曲不可用，已降到 ${q} 取到链接`);
        return url;
      }
      lastErr = `quality=${q} 无可用链接`;
    }
    logWarn('selfhost', `[QQ] 自建取链接失败（${lastErr}），走在线源池`);
    return null;
  } catch (e) {
    logWarn('selfhost', '[QQ] 自建取链接异常:', e && e.message);
    return null;
  }
}

/**
 * 按设置的日推来源拉取每日推荐，返回 { ok, title, list }。list 元素含 song/name, singer, id, source 等。
 * @param {'qq'|'kugou'|'netease'} source 覆盖默认来源
 */
export async function dayRecommend(source = null) {
  const prefs = loadPrefs();
  const from = source;  // 显式指定（每日推荐三栏化后不再用 prefs.dailySource）
  if (!from) return { ok: false, err: '未指定日推来源' };
  if (!selfhostEnabled(from)) return { ok: false, err: '该平台未启用自建服务' };
  try {
    const st = await fetchStatus();
    const s = st && st[from];
    /* 日推接口通常无需登录（网易云/酷狗实测可匿名拉取）；仅需副进程在线。QQ 需登录时自然返回空/错误 */
    if (!s || !s.alive) return { ok: false, err: '服务离线' };
  } catch (e) {
    return { ok: false, err: '状态查询失败' };
  }
  try {
    if (from === 'netease') {
      const res = await fetch('/api/selfhost/netease/proxy?path=' + encodeURIComponent(_appendNeteaseOpts('/recommend/songs')));
      if (!res.ok) return { ok: false, err: `HTTP ${res.status}` };
      const d = await res.json();
      return normNetease(d);
    }
    if (from === 'kugou') {
      const kgOpts = getSelfhostOptions('kugou');
      const platParam = kgOpts.dailyPlatform === 'android' ? '?platform=android' : '';
      const res = await fetch('/api/selfhost/kugou/proxy?path=' + encodeURIComponent('/everyday/recommend' + platParam));
      if (!res.ok) return { ok: false, err: `HTTP ${res.status}` };
      const d = await res.json();
      return normKugou(d);
    }
    if (from === 'qq') {
      const qqOpts = getSelfhostOptions('qq');
      /* ★ QQ 个性化日推(srf)对微信联邦账号返回 500003 不可用；
         改用「热门推荐歌单」聚合：热门歌单里下架/空单很多，逐单尝试跳过、取 2-3 个有效单合并 */
      const qqDailyPool = async () => {
        const res = await fetch('/api/selfhost/qq/proxy?path=' + encodeURIComponent('/getSongLists?categoryId=10000000&sortId=5&sin=0&ein=19'));
        if (!res.ok) return null;
        const d = await res.json();
        const root = (d && (d.response || d)) || {};
        const lists = (root.data && Array.isArray(root.data.list)) ? root.data.list : [];
        const merged = [];
        const seen = new Set();
        for (const it of lists) {
          if (!it || !it.dissid) continue;
          if (merged.length >= 40) break;
          try {
            const sd = await fetch('/api/selfhost/qq/proxy?path=' + encodeURIComponent(`/getSongListDetail?disstid=${encodeURIComponent(it.dissid)}`));
            if (!sd.ok) continue;
            const got = normQQTracks(await sd.json());
            for (const s of got) {
              if (s && s.id && !seen.has(s.id)) { seen.add(s.id); merged.push(s); }
            }
            if (merged.length >= 40) break;
          } catch (e) { /* 该单失败继续下一个 */ }
        }
        return merged.slice(0, 60);
      };
      if (qqOpts.dailyMode !== 'personal') {
        try {
          const got = await qqDailyPool();
          if (got && got.length) return { ok: true, title: '每日推荐 · QQ音乐', list: got };
        } catch (e) { /* 聚合失败继续走日推原接口 */ }
      }
      const res = await fetch('/api/selfhost/qq/proxy?path=' + encodeURIComponent('/getDailyRecommend'));
      if (!res.ok) return { ok: false, err: `HTTP ${res.status}` };
      const d = await res.json();
      const parsed = normQQ(d);
      if ((!parsed.list || !parsed.list.length) && qqOpts.dailyMode === 'personal') {
        try {
          const got = await qqDailyPool();
          if (got && got.length) return { ok: true, title: '每日推荐 · QQ音乐', list: got };
        } catch (e) { /* 兜底池亦失败则返回原解析结果 */ }
      }
      return parsed;
    }
    return { ok: false, err: '未知来源' };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

/**
 * 酷狗每日签到领 VIP：应用启动时自动触发（幽灵/后台静默执行）。
 * 触发条件：酷狗自建已启用 + 已登录 + 今日未签到。启动后端后台线程（无 DOM 依赖）。
 * 用 localStorage「kugou_checkin_date」去重，设置页按钮与启动调用共享，避免重复签到。
 */
const KG_CI_STORAGE = 'kugou_checkin_date';
export function kugouTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function updateSelfHostBadge() {
  /* 右上角「自建服务」红点：统计已启用但未登录的平台数 */
  const badge = typeof document !== 'undefined' ? document.getElementById('selfHostBadge') : null;
  if (!badge) return;
  const prefs = loadPrefs();
  const en = prefs.enabled || {};
  const names = ['kugou', 'qq', 'netease'].filter(n => en[n]);
  if (!names.length) { badge.style.display = 'none'; return; }
  fetchStatus(true).then(st => {
    const needLogin = names.filter(n => !(st && st[n] && st[n].loggedIn)).length;
    if (needLogin > 0) {
      badge.textContent = String(needLogin);
      badge.style.display = 'block';
    } else {
      badge.style.display = 'none';
    }
    /* ★ 反向缺口（2026-10-07 用户报障「都登录了、都是 VIP，却总走外链」）：
       徽章此前只统计「已启用但未登录」，而**已登录却没打开平台开关**这种状态
       完全不可见 —— 表现就是取链静默走在线源池，用户只会觉得"自建没用"。
       QQ 的取链开关与「扫码登录」是两套状态（见 selfhostQQPlayUrl），所以必须点出来。 */
    const loggedInButOff = ['qq', 'kugou', 'netease'].filter(n => !en[n] && st && st[n] && st[n].alive && st[n].loggedIn);
    if (loggedInButOff.length) {
      logWarn('selfhost', `[SelfHost] 已登录但**平台开关未开启**：${loggedInButOff.join('、')}`
        + ' —— 取链会走在线源池（设置 → 自建服务）');
    }
  }).catch(() => { badge.style.display = 'none'; });
}

export function autoKugouCheckinOnce() {
  try {
    if (localStorage.getItem(KG_CI_STORAGE) === kugouTodayStr()) return;
  } catch (e) { /* ignore */ }
  if (!selfhostEnabled('kugou')) return;
  /* 受设置页「酷狗自动签到」开关控制；默认开启 */
  try {
    const p = JSON.parse(localStorage.getItem(SH_KEY) || '{}');
    if (p.kugouAutoCheckin === false) return;
  } catch (e) { /* ignore */ }
  /* 启动签到（后台线程）+ 仅做日志记录，不打扰用户 */
  (async () => {
    try {
      const st = await fetchStatus(true);
      if (!st || !st.kugou || !st.kugou.alive || !st.kugou.loggedIn) return;
      const res = await fetch('/api/selfhost/kugou/checkin', { method: 'POST' });
      if (res.ok) {
        const d = await res.json().catch(() => ({}));
        if (d && d.ok) document.dispatchEvent(new CustomEvent('kugou-checkin-started'));
      }
    } catch (e) { logWarn('selfhostRuntime', '[SelfHost] 启动自动签到失败:', e.message); }
  })();
}

/* ==================== 归一化 ==================== */
function normNetease(d) {
  /* ★ /recommend/songs 实际形状 {code:200, data:{fromCache, dailySongs:[...]}}：
     dailySongs 藏在 data 里（曾有 bug：只查顶层 d.data=d0 是对象 → Array.isArray 失败 → 日推恒空） */
  const d0 = (d && d.data) || {};
  const arr = (d && d.dailySongs) || d0.dailySongs || d0.recommend
    || (Array.isArray(d0) ? d0 : null) || (d && d.playlist) || [];
  const list = Array.isArray(arr) ? arr.map(s => ({
    id: s.id, name: s.name, singer: (s.ar || []).map(a => a.name).join(' / '),
    album: s.al && s.al.name, source: 'netease',
    cover: s.al && s.al.picUrl,
  })) : [];
  return { ok: true, title: '每日推荐 · 网易云', list };
}

function normKugou(d) {
  const list = [];
  const _cov = (u) => (u ? String(u).replace('{size}', '500') : '');
  const push = it => {
    if (!it || !it.hash) return;
    /* ★ 封面：sizable_cover（含 {size} 占位需替换）；作者：singerinfo/author_name/singername */
    let singer = '';
    const si = (it.singerinfo && Array.isArray(it.singerinfo)) ? it.singerinfo
      : (Array.isArray(it.author) ? it.author : null);
    if (Array.isArray(si)) singer = si.map(a => (typeof a === 'string' ? a : (a.name || a.author_name || ''))).filter(Boolean).join(' / ');
    if (!singer) singer = (it.singername || it.author_name || it.author || '').replace(/<[^>]+>/g, '');
    list.push({
      id: it.hash, hash: it.hash, name: it.songname || it.filename || it.name, singer,
      album: it.album_name || it.albumname, source: 'kugou',
      cover: _cov(it.sizable_cover) || _cov(it.img) || _cov(it.cover),
    });
  };
  const d0 = (d && d.data) || {};
  /* 兼容多种形态：data 数组 / data.song_list(每日推荐) / data['找歌曲'] / data.songs */
  if (Array.isArray(d0)) { d0.forEach(push); }
  else if (Array.isArray(d0.song_list)) { d0.song_list.forEach(push); }
  else if (Array.isArray(d0['找歌曲'])) { d0['找歌曲'].forEach(push); }
  else if (Array.isArray(d0.songs)) { d0.songs.forEach(push); }
  return { ok: true, title: '每日推荐 · 酷狗', list };
}

function normQQ(d) {
  const list = [];
  /* ★ 适配多种形状：平铺 {data[]} / {response:{...}} / {response:{recommend:{data:{list:[]}}}} */
  let root = d;
  if (root && root.response) root = root.response;
  if (root && root.recommend && (root.recommend.data || root.recommend.list || root.recommend.songList)) root = root.recommend;
  const arr = (root && (root.data || root.list || root.songList || root.recommendList)) || [];
  const arrList = Array.isArray(arr) ? arr : (arr.song || arr.songs || []);
  (Array.isArray(arrList) ? arrList : []) .forEach(it => {
    const song = it.song || it;
    const mid = song.mid || song.songmid || song.songMid || (song.strMediaMid || '');
    if (!mid) return;
    let singer = '';
    const sg = song.singer || song.singers || (Array.isArray(song.singerName) ? song.singerName : null);
    if (Array.isArray(sg)) singer = sg.map(x => (typeof x === 'string' ? x : (x.name || x.title || ''))).filter(Boolean).join(' / ');
    else singer = song.singerName || song.singername || '';
    list.push({
      /* ★ mid 必须单独给：QQ 取链的原生主键是 mid，只塞进 id 会让下游
         （258 日推 → loadOnlineSong）拿 mid 当数字 id 去反查元数据，多一次网络往返。 */
      id: mid, mid, name: song.title || song.name || song.songname,
      singer, album: song.album && (song.album.name || song.album.mid || ''), source: 'qq',
      cover: (song.album && (song.album.pmid || song.album.mid)) ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${song.album.pmid || song.album.mid}.jpg` : (song.cover || null),
    });
  });
  /* 严格模式：一个都没解析出且有 response 包裹时视为不适用（如未登录） */
  return { ok: true, title: '每日推荐 · QQ音乐', list };
}

const _qqLikedIds = new Set();
const QQ_LIKED_STORAGE_KEY = 'selfhost_qq_liked_ids';
function _rememberQQLikedId(id) {
  if (!id) return;
  const k = String(id);
  _qqLikedIds.add(k);
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = JSON.parse(localStorage.getItem(QQ_LIKED_STORAGE_KEY) || '[]');
      const next = Array.isArray(saved) ? Array.from(new Set([...saved, k])).slice(-6) : [k];
      localStorage.setItem(QQ_LIKED_STORAGE_KEY, JSON.stringify(next));
    }
  } catch (e) { logCatch('selfhost', e); }
}
function _isRememberedQQLikedId(id) {
  if (!id) return false;
  const k = String(id);
  if (k === '__qq_liked__' || _qqLikedIds.has(k)) return true;
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = JSON.parse(localStorage.getItem(QQ_LIKED_STORAGE_KEY) || '[]');
      if (Array.isArray(saved) && saved.includes(k)) {
        _qqLikedIds.add(k);
        return true;
      }
    }
  } catch (e) { logCatch('selfhost', e); }
  return false;
}

/* getSongListDetail 响应 → 归一化歌曲列表。
 * vendor 返回 {response:{code:0,...,cdlist:[{songlist:[{mid,name,singer:[],album:{pmid}}...]}]}}
 */
export function normQQTracks(d) {
  const root = (d && (d.response || d)) || {};
  /* getSongListDetail 两种形态都兼容：{code,data:{cdlist}} 或 {code,cdlist} */
  const cdlist = (root.data && (root.data.cdlist || root.data.songlist)) || root.cdlist || [];
  const cd = Array.isArray(cdlist) ? cdlist[0] : null;
  const raw = (cd && Array.isArray(cd.songlist)) ? cd.songlist : ((root.data && Array.isArray(root.data.songs)) ? root.data.songs : []);
  const list = (Array.isArray(raw) ? raw : []).map(it => {
    const song = it && it.song && typeof it.song === 'object' ? it.song : it;
    const mid = song && (song.mid || song.songmid || song.songMid || song.strMediaMid || (song.id != null ? String(song.id) : ''));
    if (!song || !mid) return null;
    let singer = '';
    const sg = song.singer;
    if (Array.isArray(sg)) singer = sg.map(x => (x && typeof x === 'object' ? (x.name || x.title || '') : String(x))).filter(Boolean).join(' / ');
    else if (sg && typeof sg === 'object') singer = sg.name || sg.title || '';
    else if (typeof sg === 'string') singer = sg;
    const album = song.album && typeof song.album === 'object' ? song.album : null;
    const albumMid = (album && (album.pmid || album.mid)) || song.albummid || '';
    const cover = albumMid
      ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg`
      : null;
    return {
      id: mid, mid, name: song.title || song.name || song.songname || it.songname || '', singer,
      album: (album && album.name) || song.albumname || '', cover, source: 'qq',
    };
  }).filter(Boolean);
  return list;
}

/**
 * 统一拉取 QQ 歌单/我喜欢的歌明细，兼容空歌单（code===0 且 songnum===0 返回空数组而非报错）。
 */
async function fetchQQSongList(disstid, { isLiked = false, likedCountHint = null, errEmptyMsg = '获取歌单失败' } = {}) {
  const id = disstid != null && disstid !== '' && disstid !== '__qq_liked__' ? String(disstid) : '0';
  const dirQuery = isLiked ? '&dirid=201' : '';
  const queryPath = `/getSongListDetail?disstid=${encodeURIComponent(id)}${dirQuery}`;
  let sd = await shProxy('qq', queryPath);
  if ((sd.err || !sd.data) && isLiked && id !== '0') {
    sd = await shProxy('qq', '/getSongListDetail?disstid=0&dirid=201');
  }
  if (sd.err || !sd.data) {
    return { ok: false, err: sd.err || errEmptyMsg };
  }
  const parsePayload = (payload) => {
    const r = (payload && (payload.response || payload)) || {};
    const inn = (r.data && typeof r.data === 'object') ? r.data : r;
    const cdl = inn.cdlist || r.cdlist || [];
    const c = Array.isArray(cdl) ? cdl[0] : null;
    return { root: r, inner: inn, cd: c, list: normQQTracks(payload) };
  };
  let parsed = parsePayload(sd.data);
  if (parsed.list.length > 0) {
    return { ok: true, list: parsed.list, info: parsed.cd };
  }
  // ★ 若传特定 disstid 返回了空歌单但标题/dirid 实为"我喜欢"（或标记 isLiked 且 id!='0'），用 dirid=201&disstid=0 再取一次
  const looksLikedCd = Boolean(
    parsed.cd && (Number(parsed.cd.dirid) === 201 || (typeof parsed.cd.dissname === 'string' && parsed.cd.dissname.includes('喜欢'))),
  );
  if ((isLiked && id !== '0') || (!isLiked && looksLikedCd)) {
    const retry = await shProxy('qq', '/getSongListDetail?disstid=0&dirid=201');
    if (!retry.err && retry.data) {
      const rp = parsePayload(retry.data);
      if (rp.list.length > 0) {
        return { ok: true, list: rp.list, info: rp.cd };
      }
      parsed = rp;
    }
  }
  const { root, inner, cd } = parsed;
  const upstreamCode = root.code !== undefined ? Number(root.code) : (inner.code !== undefined ? Number(inner.code) : 0);
  const declared = Number((cd && cd.songnum) ?? inner.total_song_num ?? root.total_song_num ?? likedCountHint ?? 0);
  if (upstreamCode === 0 && cd && (!Number.isFinite(declared) || declared === 0)) {
    return { ok: true, list: [], info: cd };
  }
  return { ok: false, err: errEmptyMsg };
}

/* ============================================================
 * 收藏相关：我的收藏（我喜欢的歌） / 我的歌单 / 歌单内歌曲
 * 复用 /api/selfhost/{platform}/proxy?path= 走统一后端代理。
 * 归一化字段遵循 normNetease/normKugou/normQQ（{id,name,singer,cover,source}）。
 * 任何异常返回 { ok:false, err }，不阻塞播放层。
 * ============================================================ */

async function shProxy(source, path, opts) {
  try {
    const cfg = { method: 'GET', ...(opts || {}) };
    const q = '/api/selfhost/' + source + '/proxy?path=' + encodeURIComponent(path);
    const init = { method: cfg.method, signal: (cfg.signal || null) };
    if (cfg.method === 'POST') {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(cfg.body || {});
    }
    const res = await fetch(q, init);
    if (!res.ok) {
      /* ★ 带上响应体：后端代理失败会回 {'error': '…本地服务未运行'}，
         只报 "HTTP 502" 会让「为什么取不到」完全没法排查。 */
      let detail = '';
      try {
        const j = await res.json();
        detail = (j && (j.error || j.err)) || '';
      } catch (e) { /* 非 JSON 响应体：忽略 */ }
      throw new Error('HTTP ' + res.status + (detail ? '：' + detail : ''));
    }
    const data = await res.json();
    return { data };
  } catch (e) {
    return { err: e.message };
  }
}

/** 状态前置校验：给定平台是否已登录且附 uid。返回值：{ok} 或 {ok:false, err} */
function isReady(source, st) {
  const s = st && st[source];
  if (!s) return { ok: false, err: '状态查询失败' };
  if (!s.alive) return { ok: false, err: '服务离线' };
  if (!s.loggedIn) return { ok: false, err: '未登录' };
  if (!s.uid) return { ok: false, err: '缺少账号 uid' };
  return { ok: true };
}

/**
 * 获取「我喜欢的歌」。
 * @param {string} source 'netease'|'kugou'|'qq'
 * @returns {Promise<{ok:boolean, title?:string, list?:Array, unsupported?:boolean, err?:string}>}
 */
export async function selfhostFavorites(source) {
  const st = await fetchStatus();
  const chk = isReady(source, st);
  if (!chk.ok) return { ok: false, err: chk.err };
  const uid = st[source].uid;
  try {
    if (source === 'netease') {
      const plLimit = Math.max(50, Math.min(1000, Number(getSelfhostOptions('netease').playlistLimit) || 500));
      // /user/playlist 里找 specialType==5 的"我喜欢的音乐"歌单，再拉曲目
      const pl = await shProxy('netease', _appendNeteaseOpts(`/user/playlist?uid=${uid}&limit=200`));
      const arr = (pl.data && (pl.data.playlist || [])) || [];
      const liked = arr.find(p => String(p.specialType) === '5' || (p.name || '').includes('我喜欢'));
      if (!liked || !liked.id) return { ok: false, err: '未找到«我喜欢的音乐»歌单' };
      const tr = await shProxy('netease', _appendNeteaseOpts(`/playlist/track/all?id=${liked.id}&limit=${plLimit}&offset=0`));
      const list = normNeteaseTracks(tr.data, 'netease');
      return { ok: true, title: '我喜欢的歌 · 网易云', list };
    }
    if (source === 'kugou') {
      const pl = await shProxy('kugou', '/user/playlist?page=1&pagesize=100');
      const items = kugouListItems(pl.data);
      const liked = pickKugouDefaultCollection(items);
      if (!liked) return { ok: false, err: '未找到«默认收藏»歌单' };
      return await kugouSongs(liked, '默认收藏 · 酷狗');
    }
    if (source === 'qq') {
      // ★ getUserLikedSongs 返回"我喜欢"歌单 ID/统计；即使未返回 ID 也可按 dirid=201 走 CgiGetDiss 兜底。
      const lp = await shProxy('qq', `/user/getUserLikedSongs?uin=${encodeURIComponent(uid)}`);
      const lr = (lp.data && (lp.data.response || lp.data)) || {};
      const liked = (lr.data && (lr.data.info || (Array.isArray(lr.data.songs) && lr.data.songs[0]) || null)) || null;
      const likedId = (liked && liked.id) ? String(liked.id) : '0';
      if (liked && liked.id) _rememberQQLikedId(likedId);
      const countHint = liked ? (liked.songCount ?? liked.num0 ?? null) : null;
      const fetched = await fetchQQSongList(likedId, {
        isLiked: true,
        likedCountHint: countHint,
        errEmptyMsg: (likedId === '0' && !liked) ? '未找到«我喜欢的歌»歌单' : '«我喜欢的歌»拉取曲目失败',
      });
      if (!fetched.ok) return { ok: false, err: fetched.err };
      return {
        ok: true, title: '我喜欢的歌 · QQ音乐', list: fetched.list,
        info: {
          key: likedId,
          count: (liked && (liked.songCount ?? liked.num0)) ?? fetched.list.length,
          cover: (liked && (liked.cover || liked.picurl)) || '',
        },
      };
    }
    return { ok: false, err: '未知来源' };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

/**
 * 获取「我的歌单」卡片列表。
 * @returns {Promise<{ok:boolean, cards?:Array<{key,listId,name,cover,count,owned,kind}>, err?:string}>}
 */
export async function selfhostPlaylists(source) {
  const st = await fetchStatus();
  const chk = isReady(source, st);
  if (!chk.ok) return { ok: false, err: chk.err };
  const uid = st[source].uid;
  try {
    if (source === 'netease') {
      const pl = await shProxy('netease', _appendNeteaseOpts(`/user/playlist?uid=${uid}&limit=100`));
      const arr = (pl.data && (pl.data.playlist || [])) || [];
      const cards = arr
        .filter(p => p && p.id)
        .map(p => ({
          key: p.id,
          listId: String(p.id),
          name: p.name || '歌单',
          count: p.trackCount || 0,
          cover: p.coverImgUrl || p.coverImgId_str || '',
          owned: String((p.creator && p.creator.userId) || p.userId || '') === String(uid) && String(p.specialType) !== '5',
        }));
      return { ok: true, cards };
    }
    if (source === 'kugou') {
      const pl = await shProxy('kugou', '/user/playlist?page=1&pagesize=100');
      const items = kugouListItems(pl.data);
      const cards = items.map(it => {
        const rawName = String(it.listname || it.specialname || it.filename || it.name || '').trim();
        const isDef = kugouLiked(it);
        const displayName = (isDef && (!rawName || /^(default|默认|默认列表|默认收藏|我喜欢)$/i.test(rawName)))
          ? '默认收藏'
          : (rawName || '歌单');
        return {
          key: it.global_collection_id || it.listid || it.id || ('u' + (it.userid || '')),
          listId: String(it.listid || it.id || ''),
          name: displayName,
          /* ★ count 字段：酷狗列表项用 count / m_count（无 songcount） */
          count: it.count || it.m_count || it.songcount || it.songscount || 0,
          cover: it.imgurl || it.cover || it.img || it.pic || '',
          owned: !isDef && Boolean(it.listid),
          isDefaultFav: isDef,
        };
      });
      return { ok: true, cards };
    }
    if (source === 'qq') {
      /* ★ getUserPlaylists 响应带 response 包裹层（{response:{code:0,data:{playlists}}})，需先解包 */
      const gp = await shProxy('qq', `/user/getUserPlaylists?uin=${encodeURIComponent(uid)}&limit=60`);
      const gr = (gp.data && (gp.data.response || gp.data)) || {};
      const arr = (gr.data && (gr.data.playlists || gr.data.songLists || gr.data.list)) || (Array.isArray(gr) ? gr : []);
      const cards = (Array.isArray(arr) ? arr : []).map(it => ({
        key: it.disstid || it.tid || it.id || '',
        name: it.dirname || it.name || '歌单',
        count: it.songnum || it.songcnt || it.tracks || it.count || 0,
        cover: (it.picurl && (it.picurl.startsWith('http') ? it.picurl : `https://y.gtimg.cn/music/photo_new/T002R300x300M000${it.picurl.replace(/^T002R300x300M000/, '')}.jpg`)) || it.logo || it.coverUrl || '',
      }));
      /* ★ 我的歌单列表头部塞入「我喜欢的歌」虚拟卡片（点进即拉曲目） */
      try {
        const lp = await shProxy('qq', `/user/getUserLikedSongs?uin=${encodeURIComponent(uid)}`);
        const lr = (lp.data && (lp.data.response || lp.data)) || {};
        const liked = (lr.data && (lr.data.info || (Array.isArray(lr.data.songs) && lr.data.songs[0]) || null)) || null;
        if (liked && (liked.id || liked.title)) {
          const rawLikedId = liked.id ? String(liked.id) : '';
          const likedKey = (rawLikedId && rawLikedId !== '0') ? rawLikedId : '__qq_liked__';
          _rememberQQLikedId(likedKey);
          cards.unshift({
            key: likedKey, name: '我喜欢的歌', count: liked.songCount || liked.num0 || 0,
            cover: (liked.cover || liked.picurl || '').startsWith('http') ? (liked.cover || liked.picurl) : '',
            virtual: true,
            isLiked: true,
          });
        }
      } catch (e) { logCatch('selfhost', e); /* 取"我喜欢"失败不阻塞歌单列表 */ }
      return { ok: true, cards };
    }
    return { ok: false, err: '未知来源' };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

/**
 * 获取某个歌单内歌曲。key 为卡片 key（net ease/id、kugou global_collection_id、qq disstid/tid）。
 * @returns {Promise<{ok:boolean, title?:string, list?:Array, err?:string}>}
 */
export async function selfhostPlaylistSongs(source, key, cardMeta = null) {
  if (!key) return { ok: false, err: '缺少歌单标识' };
  try {
    if (source === 'netease') {
      const plLimit = Math.max(50, Math.min(1000, Number(getSelfhostOptions('netease').playlistLimit) || 500));
      const tr = await shProxy('netease', _appendNeteaseOpts(`/playlist/track/all?id=${encodeURIComponent(key)}&limit=${plLimit}&offset=0`));
      const list = normNeteaseTracks(tr.data, 'netease');
      return { ok: true, title: (cardMeta && cardMeta.name) ? `${cardMeta.name} · 网易云` : '歌单 · 网易云', list };
    }
    if (source === 'kugou') {
      const title = (cardMeta && (cardMeta.isDefaultFav || /默认收藏/.test(cardMeta.name || '')))
        ? '默认收藏 · 酷狗'
        : ((cardMeta && cardMeta.name) ? `${cardMeta.name} · 酷狗` : '歌单 · 酷狗');
      return await kugouSongs({ global_collection_id: key }, title);
    }
    if (source === 'qq') {
      const k = String(key);
      const isLiked = k === '__qq_liked__'
        || _isRememberedQQLikedId(k)
        || Boolean(cardMeta && (cardMeta.virtual || cardMeta.isLiked || /喜欢/.test(cardMeta.name || '')));
      const disstid = k === '__qq_liked__' ? '0' : k;
      const fetched = await fetchQQSongList(disstid, { isLiked, errEmptyMsg: '该歌单暂无曲目' });
      if (!fetched.ok) return { ok: false, err: fetched.err };
      return {
        ok: true,
        title: isLiked ? '我喜欢的歌 · QQ音乐' : ((cardMeta && cardMeta.name) ? `${cardMeta.name} · QQ音乐` : '歌单 · QQ音乐'),
        list: fetched.list,
      };
    }
    return { ok: false, err: '未知来源' };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

/* ---- 平台内辅助 ---- */
function normNeteaseTracks(d, source) {
  const arr = (d && (d.songs || d.tracks)) || [];
  return (Array.isArray(arr) ? arr : []).map(s => ({
    id: s.id, name: s.name, singer: (s.ar || []).map(a => a.name).join(' / '),
    album: s.al && s.al.name, cover: s.al && s.al.picUrl, source,
  }));
}
function kugouListItems(d) {
  const d0 = (d && d.data) || {};
  const info = (Array.isArray(d0) ? d0 : d0.info) || [];
  return Array.isArray(info) ? info : [];
}
function kugouLiked(it) {
  if (!it) return false;
  /* ★ 酷狗内置收藏列表（默认收藏 / 我喜欢）：is_def=2 / is_def=1 均属于默认收藏体系 */
  const st = String(it.specialtype || it.type || it.ptype || '');
  const nm = (it.specialname || it.listname || it.filename || it.name || '');
  return String(it.is_def) === '2' || String(it.is_def) === '1' || st === '1' || st === '5' || /默认收藏|喜欢|heart/i.test(nm);
}
function pickKugouDefaultCollection(items) {
  if (!Array.isArray(items) || !items.length) return null;
  const matched = items.filter(it => kugouLiked(it));
  if (!matched.length) return null;
  const nonEmpty = (it) => Number(it.count || it.m_count || it.songcount || it.songscount || 0) > 0;
  const namedDefault = matched.find(it => /默认收藏/.test(it.listname || it.specialname || it.name || '') && nonEmpty(it))
    || matched.find(it => /默认收藏/.test(it.listname || it.specialname || it.name || ''));
  return namedDefault || matched.find(nonEmpty) || matched[0];
}
async function kugouSongs(item, title) {
  // 调和 global_collection_id：卡片/收藏项可能未携带，用 playlist/detail 解析
  let gid = item.global_collection_id || item.id || item.key;
  if (!gid && item.id) {
    const dt = await shProxy('kugou', `/playlist/detail?ids=${encodeURIComponent(item.id)}`);
    const info = ((dt.data && dt.data.data) || dt.data || {}).info || (Array.isArray(dt.data) ? dt.data[0] : null);
    gid = (info && info.global_collection_id) || (info && info.collection_id);
  }
  if (!gid) return { ok: false, err: '无法解析歌单 ID' };
  /* ★ track/all 模块读取 params.id（不是 global_collection_id） */
  const tr = await shProxy('kugou', `/playlist/track/all?id=${encodeURIComponent(gid)}&page=1&pagesize=300`);
  const d0 = (tr.data && (tr.data.data || tr.data)) || {};
  const info = (Array.isArray(d0) ? d0 : (d0.songs || d0.info)) || [];
  const list = (Array.isArray(info) ? info : []).map(it => {
    /* ★ 歌名/作者：酷狗列表项常见形态 singerinfo=[{name}] + name="作者 - 歌名"
       （songname/singername 多为空），需要从 singerinfo 取作者、从 name 拆出纯歌名 */
    let name = it.songname || it.songName || it.name || '';
    let singer = it.singername || it.singer_name || it.author || '';
    if (!singer && Array.isArray(it.singerinfo)) {
      singer = it.singerinfo.map(a => (a && (a.name || a.author_name))).filter(Boolean).join(' / ');
    }
    if (singer && name) {
      const m = String(name).match(/^(.*?)\s*-\s*(.+)$/);
      if (m) name = m[2].trim();
    } else if (!singer && !name && it.filename) {
      const m = String(it.filename).match(/^(.*?)\s*-\s*(.+)$/);
      if (m) { singer = m[1].trim(); name = m[2].trim(); }
      else name = String(it.filename).trim();
    }
    const _cov = (u) => (u ? String(u).replace('{size}', '300') : '');
    return {
      id: it.hash, hash: it.hash,
      fileid: it.fileid || it.FileId || '',
      albumId: it.album_id || (it.albuminfo && it.albuminfo.album_id) || '',
      mixSongId: it.mixsongid || it.MixSongID || '',
      name, singer,
      album: it.album_name || (it.albuminfo && it.albuminfo.album_name) || it.albumname,
      cover: _cov(it.cover) || _cov(it.img) || _cov(it.album_audio_cover)
          || _cov(it.album_img) || _cov(it.sizable_cover) || _cov(it.pic), source: 'kugou',
    };
  });
  return { ok: true, title, list };
}

/** 红心/取消红心同步到自建平台云端（支持 netease）。 */
export async function selfhostCloudLike(source, song, like = true) {
  const src = source === 'tencent' ? 'qq' : source;
  if (src !== 'netease') {
    return { ok: false, unsupported: true, err: '该平台暂不支持云端红心' };
  }
  const id = String((song && (song.id || song.mid)) || '').trim();
  if (!id) return { ok: false, err: '缺少歌曲 ID' };
  const st = await fetchStatus();
  const chk = isReady(src, st);
  if (!chk.ok) return { ok: false, err: chk.err };
  try {
    const r = await shProxy('netease', `/like?id=${encodeURIComponent(id)}&like=${like ? 'true' : 'false'}`);
    if (r.err) return { ok: false, err: r.err };
    const d = r.data || {};
    if (d.code && Number(d.code) !== 200) return { ok: false, err: d.message || d.msg || `操作失败(code=${d.code})` };
    return { ok: true, liked: like };
  } catch (e) {
    return { ok: false, err: (e && e.message) || '云端收藏失败' };
  }
}

/** 新建云端歌单（支持 netease / kugou）。 */
export async function selfhostCreatePlaylist(source, name, isPrivate = true) {
  const src = source === 'tencent' ? 'qq' : source;
  const title = String(name || '').trim();
  if (!title) return { ok: false, err: '歌单名称不能为空' };
  if (!['netease', 'kugou'].includes(src)) {
    return { ok: false, unsupported: true, err: '该平台暂不支持网页创建云端歌单' };
  }
  const st = await fetchStatus();
  const chk = isReady(src, st);
  if (!chk.ok) return { ok: false, err: chk.err };
  try {
    if (src === 'netease') {
      const r = await shProxy('netease', `/playlist/create?name=${encodeURIComponent(title)}&privacy=${isPrivate ? 10 : 0}`);
      if (r.err) return { ok: false, err: r.err };
      const d = r.data || {};
      if (d.code && Number(d.code) !== 200) return { ok: false, err: d.message || d.msg || `创建失败(code=${d.code})` };
      return { ok: true, id: String(d.id || (d.playlist && d.playlist.id) || '') };
    }
    const r = await shProxy('kugou', `/playlist/add?name=${encodeURIComponent(title)}&type=0&is_pri=${isPrivate ? 1 : 0}`);
    if (r.err) return { ok: false, err: r.err };
    const d = r.data || {};
    if (d.status != null && Number(d.status) !== 1) return { ok: false, err: d.error || d.msg || '酷狗创建歌单失败' };
    return { ok: true, id: String((d.data && (d.data.listid || d.data.global_collection_id)) || '') };
  } catch (e) {
    return { ok: false, err: (e && e.message) || '创建歌单失败' };
  }
}

/** 删除云端歌单（支持 netease / kugou）。 */
export async function selfhostDeletePlaylist(source, cardOrId) {
  const src = source === 'tencent' ? 'qq' : source;
  const listId = typeof cardOrId === 'object' && cardOrId ? String(cardOrId.listId || cardOrId.key || '') : String(cardOrId || '');
  if (!listId) return { ok: false, err: '缺少歌单 ID' };
  if (!['netease', 'kugou'].includes(src)) {
    return { ok: false, unsupported: true, err: '该平台暂不支持删除云端歌单' };
  }
  const st = await fetchStatus();
  const chk = isReady(src, st);
  if (!chk.ok) return { ok: false, err: chk.err };
  try {
    if (src === 'netease') {
      const r = await shProxy('netease', `/playlist/delete?id=${encodeURIComponent(listId)}`);
      if (r.err) return { ok: false, err: r.err };
      const d = r.data || {};
      if (d.code && Number(d.code) !== 200) return { ok: false, err: d.message || d.msg || `删除失败(code=${d.code})` };
      return { ok: true };
    }
    const r = await shProxy('kugou', `/playlist/del?listid=${encodeURIComponent(listId)}`);
    if (r.err) return { ok: false, err: r.err };
    const d = r.data || {};
    if (d.status != null && Number(d.status) !== 1) return { ok: false, err: d.error || d.msg || '酷狗删除歌单失败' };
    return { ok: true };
  } catch (e) {
    return { ok: false, err: (e && e.message) || '删除歌单失败' };
  }
}

/** 从云端歌单添加/移除歌曲（op: 'add' | 'del'）。 */
export async function selfhostPlaylistMutateTracks(source, cardOrId, songs, op = 'del') {
  const src = source === 'tencent' ? 'qq' : source;
  const arr = Array.isArray(songs) ? songs : [songs];
  const valid = arr.filter(Boolean);
  if (!valid.length) return { ok: false, err: '缺少歌曲' };
  const pid = typeof cardOrId === 'object' && cardOrId ? String(cardOrId.listId || cardOrId.key || '') : String(cardOrId || '');
  if (!pid) return { ok: false, err: '缺少歌单 ID' };
  if (!['netease', 'kugou'].includes(src)) {
    return { ok: false, unsupported: true, err: '该平台暂不支持编辑云端歌单曲目' };
  }
  const st = await fetchStatus();
  const chk = isReady(src, st);
  if (!chk.ok) return { ok: false, err: chk.err };
  try {
    if (src === 'netease') {
      const ids = valid.map(s => String(s.id || '')).filter(Boolean);
      const r = await shProxy('netease', `/playlist/tracks?op=${op === 'add' ? 'add' : 'del'}&pid=${encodeURIComponent(pid)}&tracks=${encodeURIComponent(ids.join(','))}`);
      if (r.err) return { ok: false, err: r.err };
      const d = r.data || {};
      const code = Number(d.code ?? (d.body && d.body.code) ?? 200);
      if (code !== 200) return { ok: false, err: d.message || (d.body && d.body.message) || `编辑失败(code=${code})` };
      return { ok: true };
    }
    if (op === 'add') {
      const items = valid.map(s => `${String(s.name || s.song || '').replace(/[,|]/g, ' ')}|${s.hash || s.id || ''}|${s.albumId || 0}|${s.mixSongId || 0}`);
      const r = await shProxy('kugou', `/playlist/tracks/add?listid=${encodeURIComponent(pid)}&data=${encodeURIComponent(items.join(','))}`);
      if (r.err) return { ok: false, err: r.err };
      const d = r.data || {};
      if (d.status != null && Number(d.status) !== 1) return { ok: false, err: d.error || '添加失败' };
      return { ok: true };
    }
    const fids = valid.map(s => s.fileid).filter(Boolean);
    if (!fids.length) return { ok: false, err: '酷狗曲目缺少 fileid，暂无法移除' };
    const r = await shProxy('kugou', `/playlist/tracks/del?listid=${encodeURIComponent(pid)}&fileids=${encodeURIComponent(fids.join(','))}`);
    if (r.err) return { ok: false, err: r.err };
    const d = r.data || {};
    if (d.status != null && Number(d.status) !== 1) return { ok: false, err: d.error || '移除失败' };
    return { ok: true };
  } catch (e) {
    return { ok: false, err: (e && e.message) || '编辑歌单曲目失败' };
  }
}

/* 递归找第一个 http(s) 音频直链 */
function findFirstHttpUrl(obj, depth = 0) {
  if (depth > 8 || obj == null) return null;
  if (typeof obj === 'string') {
    if (/^https?:\/\//.test(obj) && !/\.(png|jpe?g|svg|gif)/i.test(obj)) return obj;
    return null;
  }
  if (Array.isArray(obj)) {
    for (const it of obj) { const r = findFirstHttpUrl(it, depth + 1); if (r) return r; }
    return null;
  }
  if (typeof obj === 'object') {
    // 优先 url/purl 字段
    for (const k of ['purl', 'url', 'playUrl', 'src']) {
      if (typeof obj[k] === 'string' && /^https?:\/\//.test(obj[k])) return obj[k];
    }
    for (const k of Object.keys(obj)) { const r = findFirstHttpUrl(obj[k], depth + 1); if (r) return r; }
  }
  return null;
}

registerSelfhostPlayHooks({ qq: selfhostQQPlayUrl, netease: selfhostNeteasePlayUrl });

export { API_BASE, fetchStatus };