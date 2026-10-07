/* ============================================================
 * selfhost-runtime.js — 自建服务播放/日推运行时（供在线加载与日推入口使用）
 * - selfhostStatus: 缓存 5s 的 /api/selfhost/status
 * - selfhostQQPlayUrl: QQ 登录态下优先取高音质（未启用/未登录/失败→null 走原回退链）
 * - dayRecommend: 按设置里的 dailySource 拉取每日推荐
 * 依赖 server.py /api/selfhost/* 与自建副进程。任何异常都安全返回 null/false。
 * ============================================================ */
import { API_BASE } from '../config/constants.js';
import { logInfo, logWarn, logError } from '../services/log.js';

const SH_KEY = 'selfhost_prefs';
let _statusCache = null;
let _statusAt = 0;
const _STATUS_TTL = 5000;

function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(SH_KEY));
    if (raw && typeof raw === 'object') return raw;
  } catch (e) { /* ignore */ }
  return { enabled: { kugou: false, qq: false, netease: false }, dailySource: 'netease' };
}

async function fetchStatus(force = false) {
  const now = Date.now();
  if (!force && _statusCache && now - _statusAt < _STATUS_TTL) return _statusCache;
  try {
    const res = await fetch('/api/selfhost/status');
    if (!res.ok) throw new Error(String(res.status));
    _statusCache = await res.json();
    _statusAt = Date.now();
  } catch (e) {
    _statusCache = null;
    _statusAt = Date.now();
  }
  return _statusCache;
}

export function selfhostEnabled(platform) {
  /* ★ 汽水**没有平台开关**（设置页刻意不渲染）：它的搜索/推荐流匿名就能用，
     播放与「我的歌单」只取决于是否登录 —— 用一个开关去门禁它只会制造
     「明明登录了却没有内容」的困惑。所以这里恒为 true。
     ⚠ 别删这条：日推聚合(dailySrcOrder)、榜单排序(orderedRankSources)、
       歌单页自建入口都经本函数过滤，返回 false 会让整条汽水链路被静默跳过。 */
  if (platform === 'qishui') return true;
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
  hires: ['hires', 'lossless', 'exhigh', 'higher', 'standard'],
  lossless: ['lossless', 'exhigh', 'higher', 'standard'],
  exhigh: ['exhigh', 'higher', 'standard'],
  higher: ['higher', 'standard'],
  standard: ['standard'],
};

export async function selfhostNeteasePlayUrl(id, level = 'exhigh', signal = null) {
  /* ★ 上游参考项目 对齐：本机常驻 NeteaseCloudMusicApi 直接 /song/url/v1 一次取直链。
     不要求「自建服务开关/登录」——副进程在线即可（匿名拿标准音质，登录/启用拿官方级音质），
     本机毫秒级回包，替代公网 byfuns 串行 5 档 + 逐次存活探测的等待。离线返回 null 走原有兜底。 */
  if (!id) return null;
  try {
    const st = await fetchStatus();
    const s = st && st.netease;
    if (!s || !s.alive) {
      logInfo('selfhost', `[网易云] 副进程不在线（alive=${!!(s && s.alive)}），走公网阶梯`);
      return null;
    }
    const want = String(level || 'exhigh');
    const ladder = NETEASE_LEVEL_LADDER[want] || [want, 'standard'];
    let lastNote = '';
    for (const lv of ladder) {
      const res = await fetch(`/api/selfhost/netease/proxy?path=${encodeURIComponent('/song/url/v1?id=' + encodeURIComponent(String(id)) + '&level=' + encodeURIComponent(lv))}`, signal ? { signal } : undefined);
      if (!res || (!res.ok && res.status !== 200)) {
        /* 代理失败（副进程没起来等）继续下探没意义，交给公网阶梯 */
        lastNote = `HTTP ${res ? res.status : 'no-response'}`;
        break;
      }
      const j = await res.json().catch(() => null);
      /* /song/url/v1 返回 {data:[{id,url,freeTrialInfo?}]}（数组）；兼容 {data:{url}} 与双层包裹 */
      const d0 = (j && j.data) || {};
      const first = Array.isArray(d0) ? d0[0] : d0;
      const url = (first && first.url) || (d0 && d0.url) || (j && maybeNeteaseUrl(j));
      const trial = !!(first && first.freeTrialInfo) || !!(d0 && d0.freeTrialInfo);
      if (!url || !String(url).startsWith('http')) {
        lastNote = `${lv} 无直链（疑 VIP/版权受限）`;
        continue;
      }
      if (trial) {
        /* ★ 试听链（约 30 秒）绝不能当作整曲直链用 —— 这正是"VIP 却只有 30 秒"的来源 */
        lastNote = `${lv} 只给到试听链`;
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
/**
 * 汽水自建取链。★ 返回的是**本机 vendor 的 /stream 地址**，不是 CDN 直链。
 *
 * 为什么与其它源形状不同（但下游一行都不用改）：汽水的音频是加密的，解密发生
 * 在 vendor 进程内，它只能给字节流、给不出可直接播的 URL（详见 selfhost_service.py
 * 顶部注释）。所以这里把「vendor 的流地址」当作 playUrl 交给 175 —— 它同样是一个
 * http URL，下面 getStreamCachedAudioUrl → /api/audio/stream（带 Range 与磁盘缓存）
 * → 浏览器这条既有链路原样复用。
 *
 * 不要求「平台启用开关」：汽水的搜索源本身就是它，播放没有第二条路可走，
 * 卡开关只会让「能搜到却放不了」。要求「已登录」是因为未登录拿不到整曲。
 */
export async function selfhostQishuiPlayUrl(id, quality = 'higher') {
  if (!id) return null;
  try {
    const st = await fetchStatus();
    const s = st && st.qishui;
    if (!s || !s.alive) {
      logInfo('selfhost', `[汽水] 副进程不在线（alive=${!!(s && s.alive)}），走跨源兜底`);
      return null;
    }
    if (!s.loggedIn) {
      logWarn('selfhost', '[汽水] 未登录（搜索/歌词匿名可用，播放需登录），走跨源兜底');
      return null;
    }
    const q = /^(standard|higher|lossless)$/.test(String(quality)) ? String(quality) : 'higher';
    return `http://127.0.0.1:3300/stream?id=${encodeURIComponent(String(id))}&quality=${q}`;
  } catch (e) {
    logWarn('selfhost', '[汽水] 取链接异常:', e && e.message);
    return null;
  }
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
  flac: ['flac', '320', '128'],
  ape: ['ape', '320', '128'],
  '320': ['320', '128'],
  '128': ['128'],
  m4a: ['m4a', '128'],
};

export async function selfhostQQPlayUrl(songmid, quality = '320') {
  /* ★ 这里要求 selfhostEnabled('qq')：与「登录态」是两码事。
     只在设置页扫了码（status 显示 loggedIn）并不会让取链接走自建 —— 还需要平台开关打开。
     开关关着时明确留痕，否则表现是「明明登录了却一直走在线源」，完全无从排查。 */
  if (!songmid) return null;
  if (!selfhostEnabled('qq')) {
    /* ★ 升为 WARN 并说清"开关 ≠ 登录"（2026-10-07 用户报障「都登录了却总走外链」）：
       info 级在取链详情面板里不够显眼，而这一步是 QQ 自建**唯一**的无日志静默点。 */
    logWarn('selfhost', '[QQ] 自建取链被跳过：平台开关未启用（设置 → 自建服务 → QQ），与"扫码登录"是两套状态；已改用在线源池');
    return null;
  }
  try {
    const st = await fetchStatus();
    const s = st && st.qq;
    if (!s || !s.alive || !s.loggedIn) {
      logWarn('selfhost', `[QQ] 自建不可用（alive=${!!(s && s.alive)} loggedIn=${!!(s && s.loggedIn)}），走在线源池`);
      return null;
    }
    const mid = encodeURIComponent(songmid);
    const want = String(quality || '320').toLowerCase();
    const ladder = QQ_QUALITY_LADDER[want] || [want, '320', '128'];
    let lastErr = '';
    for (const q of ladder) {
      const res = await fetch(`/api/selfhost/qq/proxy?path=${encodeURIComponent(`/getMusicPlay?songmid=${mid}&quality=${encodeURIComponent(q)}`)}`);
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
 * @param {'qq'|'kugou'|'netease'|'qishui'} source 覆盖默认来源
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
      const res = await fetch('/api/selfhost/netease/proxy?path=' + encodeURIComponent('/recommend/songs'));
      if (!res.ok) return { ok: false, err: `HTTP ${res.status}` };
      const d = await res.json();
      return normNetease(d);
    }
    if (from === 'kugou') {
      const res = await fetch('/api/selfhost/kugou/proxy?path=' + encodeURIComponent('/everyday/recommend'));
      if (!res.ok) return { ok: false, err: `HTTP ${res.status}` };
      const d = await res.json();
      return normKugou(d);
    }
    if (from === 'qq') {
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
      try {
        const got = await qqDailyPool();
        if (got && got.length) return { ok: true, title: '每日推荐 · QQ音乐', list: got };
      } catch (e) { /* 聚合失败继续走日推原接口 */ }
      const res = await fetch('/api/selfhost/qq/proxy?path=' + encodeURIComponent('/getDailyRecommend'));
      if (!res.ok) return { ok: false, err: `HTTP ${res.status}` };
      const d = await res.json();
      return normQQ(d);
    }
    if (from === 'qishui') {
      /* 汽水的「日推」 = 字节推荐流 /luna/pc/feed/song-tab（首页漫游，走抖音推荐）。
         ★ 匿名即可用（实测 820ms 回 6 首真实曲目），**不要**加登录前置判断 ——
           与 QQ 的 srf 日推（微信联邦账号恒 500003）不同，汽水这条是免费的。
         每首歌自带 isVip 标记，VIP 曲在未登录时取链会失败，属播放层既有的
         「取链失败→跨源兜底」路径，这里不做过滤（否则未登录时列表会莫名变短）。 */
      const r = await shProxy('qishui', '/feed');
      if (r.err) return { ok: false, err: r.err };
      const d = r.data || {};
      if (d.ok === false) return { ok: false, err: d.err || '推荐流不可用' };
      const list = normQishui(d.songs);
      if (!list.length) return { ok: false, err: '推荐流为空' };
      return { ok: true, title: '每日推荐 · 汽水音乐', list };
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

/* 汽水 Song → 统一列表项。
 * vendor(ly-music-source) 的 Song 形状：
 *   {platform,id,title,artists:[{name}],album,coverUrl,durationMs,isVip}
 * ★ 与 normNetease/normKugou/normQQ 对齐成 {id,name,singer,album,source,cover}，
 *   否则下游（258 日推聚合 / 歌单曲目列表 / 播放层）认不出字段名，表现是
 *   「有数据但列表全是未知歌曲」。isVip 不在统一形状里，刻意丢弃 ——
 *   汽水未登录时 VIP 曲也拿不到音频流，播放层已按「取链失败」统一处理。 */
function normQishui(songs) {
  return (Array.isArray(songs) ? songs : []).map(s => {
    if (!s || s.id == null || s.id === '') return null;
    const singer = (Array.isArray(s.artists) ? s.artists : [])
      .map(a => (typeof a === 'string' ? a : ((a && a.name) || '')))
      .filter(Boolean).join(' / ');
    return {
      id: String(s.id),
      name: s.title || s.name || String(s.id),
      singer,
      album: s.album || '',
      source: 'qishui',
      cover: s.coverUrl || s.cover || '',
    };
  }).filter(Boolean);
}

/* getSongListDetail 响应 → 归一化歌曲列表。
 * vendor 返回 {response:{code:0,...,cdlist:[{songlist:[{mid,name,singer:[],album:{pmid}}...]}]}}
 */
function normQQTracks(d) {
  const root = (d && (d.response || d)) || {};
  /* getSongListDetail 两种形态都兼容：{code,data:{cdlist}} 或 {code,cdlist} */
  const cdlist = (root.data && (root.data.cdlist || root.data.songlist)) || root.cdlist || [];
  const cd = Array.isArray(cdlist) ? cdlist[0] : null;
  const raw = (cd && Array.isArray(cd.songlist)) ? cd.songlist : ((root.data && Array.isArray(root.data.songs)) ? root.data.songs : []);
  const list = (Array.isArray(raw) ? raw : []).map(it => {
    const song = it && it.song && typeof it.song === 'object' ? it.song : it;
    if (!song || !song.mid) return null;
    let singer = '';
    const sg = song.singer;
    if (Array.isArray(sg)) singer = sg.map(x => (x && typeof x === 'object' ? (x.name || x.title || '') : String(x))).filter(Boolean).join(' / ');
    else if (sg && typeof sg === 'object') singer = sg.name || sg.title || '';
    else if (typeof sg === 'string') singer = sg;
    const album = song.album && typeof song.album === 'object' ? song.album : null;
    const cover = (album && (album.pmid || album.mid))
      ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${album.pmid || album.mid}.jpg`
      : null;
    return {
      id: song.mid, mid: song.mid, name: song.title || song.name || it.songname || '', singer,
      album: album ? (album.name || '') : '', cover, source: 'qq',
    };
  }).filter(Boolean);
  return list;
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
      /* ★ 带上响应体：后端代理失败会回 {'error': '…副进程未运行'}，
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
      // /user/playlist 里找 specialType==5 的"我喜欢的音乐"歌单，再拉曲目
      const pl = await shProxy('netease', `/user/playlist?uid=${uid}&limit=200`);
      const arr = (pl.data && (pl.data.playlist || []) ) || [];
      const liked = arr.find(p => String(p.specialType) === '5' || (p.name || '').includes('我喜欢'));
      if (!liked || !liked.id) return { ok: false, err: '未找到«我喜欢的音乐»歌单' };
      const tr = await shProxy('netease', `/playlist/track/all?id=${liked.id}&limit=500&offset=0`);
      const list = normNeteaseTracks(tr.data, 'netease');
      return { ok: true, title: '我喜欢的歌 · 网易云', list };
    }
    if (source === 'kugou') {
      const pl = await shProxy('kugou', '/user/playlist?page=1&pagesize=100');
      const items = kugouListItems(pl.data);
      const liked = items.find(it => kugouLiked(it));
      if (!liked) return { ok: false, err: '未找到«我喜欢的歌»歌单' };
      return await kugouSongs(liked, '我喜欢的歌 · 酷狗');
    }
    if (source === 'qq') {
      // ★ getUserLikedSongs 返回"我喜欢"歌单 ID/统计，再经 getSongListDetail?disstid= 拉完整曲目。
      //   注意解包 vendor 的 response 包裹层（{response:{code,data:{...}}}）。
      const lp = await shProxy('qq', `/user/getUserLikedSongs?uin=${encodeURIComponent(uid)}`);
      const lr = (lp.data && (lp.data.response || lp.data)) || {};
      const liked = (lr.data && (lr.data.info || (Array.isArray(lr.data.songs) && lr.data.songs[0]) || null)) || null;
      if (!liked || !liked.id) return { ok: false, err: '未找到«我喜欢的歌»歌单' };
      const sd = await shProxy('qq', `/getSongListDetail?disstid=${encodeURIComponent(liked.id)}`);
      const list = normQQTracks(sd.data);
      if (!list.length) return { ok: false, err: '«我喜欢的歌»拉取曲目失败' };
      return {
        ok: true, title: '我喜欢的歌 · QQ音乐', list,
        info: { key: liked.id, count: liked.songCount || liked.num0 || list.length, cover: liked.cover || liked.picurl },
      };
    }
    return { ok: false, err: '未知来源' };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

/**
 * 获取「我的歌单」卡片列表。
 * @returns {Promise<{ok:boolean, cards?:Array<{key,name,cover,count}>, err?:string}>}
 */
export async function selfhostPlaylists(source) {
  const st = await fetchStatus();
  const chk = isReady(source, st);
  if (!chk.ok) return { ok: false, err: chk.err };
  const uid = st[source].uid;
  try {
    if (source === 'netease') {
      const pl = await shProxy('netease', `/user/playlist?uid=${uid}&limit=100`);
      const arr = (pl.data && (pl.data.playlist || [])) || [];
      const cards = arr
        .filter(p => p && p.id)
        .map(p => ({
          key: p.id, name: p.name || '歌单', count: p.trackCount || 0, cover: p.coverImgUrl || p.coverImgId_str || '',
        }));
      return { ok: true, cards };
    }
    if (source === 'kugou') {
      const pl = await shProxy('kugou', '/user/playlist?page=1&pagesize=100');
      const items = kugouListItems(pl.data);
      const cards = items.map(it => ({
        key: it.global_collection_id || it.listid || it.id || ('u' + (it.userid || '')),
        name: it.listname || it.specialname || it.filename || it.name || '歌单',
        /* ★ count 字段：酷狗列表项用 count / m_count（无 songcount） */
        count: it.count || it.m_count || it.songcount || it.songscount || 0,
        cover: it.imgurl || it.cover || it.img || it.pic || '',
      }));
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
        if (liked && liked.id) {
          cards.unshift({
            key: liked.id, name: '我喜欢的歌', count: liked.songCount || liked.num0 || 0,
            cover: (liked.cover || liked.picurl || '').startsWith('http') ? (liked.cover || liked.picurl) : '',
            virtual: true,
          });
        }
      } catch (e) { /* 取"我喜欢"失败不阻塞歌单列表 */ }
      return { ok: true, cards };
    }
    if (source === 'qishui') {
      /* ★ 需登录（vendor 侧 ctx.requireCookie()）。这里必须**显式**识别业务失败：
         shProxy 只在 HTTP 非 2xx 时抛错，而后端把业务失败包成 200 +
         {ok:false,code:'UNAUTHENTICATED'} 返回 —— 不判 ok 就会渲染成
         「该账号暂无歌单」，用户以为账号是空的，根本不会想到去登录。
         （会话可能在 isReady 与本次请求之间过期，所以这层兜底不是多余的。） */
      const pl = await shProxy('qishui', '/playlists?limit=100');
      if (pl.err) return { ok: false, err: pl.err };
      const d = pl.data || {};
      if (d.ok === false) {
        return { ok: false, err: d.code === 'UNAUTHENTICATED' ? '未登录' : (d.err || '获取歌单失败') };
      }
      const cards = (Array.isArray(d.playlists) ? d.playlists : [])
        .map(p => ({
          key: String(p.id || ''),
          name: p.name || '歌单',
          count: p.count || 0,
          cover: p.cover || '',
        }))
        .filter(c => c.key);
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
export async function selfhostPlaylistSongs(source, key) {
  if (!key) return { ok: false, err: '缺少歌单标识' };
  try {
    if (source === 'netease') {
      const tr = await shProxy('netease', `/playlist/track/all?id=${encodeURIComponent(key)}&limit=500&offset=0`);
      const list = normNeteaseTracks(tr.data, 'netease');
      return { ok: true, title: '歌单 · 网易云', list };
    }
    if (source === 'kugou') {
      return await kugouSongs({ global_collection_id: key }, '歌单 · 酷狗');
    }
    if (source === 'qq') {
      const sd = await shProxy('qq', `/getSongListDetail?disstid=${encodeURIComponent(key)}`);
      const list = normQQTracks(sd.data);
      if (!list.length) return { ok: false, err: '该歌单暂无曲目' };
      return { ok: true, title: '歌单 · QQ音乐', list };
    }
    if (source === 'qishui') {
      /* 歌单详情**匿名可用**（库实现里没有 requireCookie），所以这里不查登录态：
         未登录也能打开别人的公开歌单，这正好给「日推听爽了想听整单」留了路。
         vendor 侧是游标翻页，库内部已循环拉满，limit 只做限幅。 */
      const r = await shProxy('qishui', `/playlist?id=${encodeURIComponent(key)}&limit=500`);
      if (r.err) return { ok: false, err: r.err };
      const d = r.data || {};
      if (d.ok === false) return { ok: false, err: d.err || '歌单拉取失败' };
      const list = normQishui(d.songs);
      if (!list.length) return { ok: false, err: '该歌单暂无曲目' };
      /* 标题口径与另外三家对齐（'歌单 · 网易云' / '歌单 · QQ音乐'），
         不再前置拼平台歌单名 —— 拼出来会多一个只能机翻的「歌单 · 」碎片。 */
      return { ok: true, title: '歌单 · 汽水音乐', list };
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
  /* ★ 酷狗「喜欢」判定：is_def=2 优先级最高；其次是 specialtype/type；
     名字判定只认「喜欢」，不要误吞「默认收藏」（is_def=1 才是默认收藏/喜欢落点） */
  const st = String(it.specialtype || it.type || it.ptype || '');
  const nm = (it.specialname || it.listname || it.filename || it.name || '');
  return String(it.is_def) === '2' || st === '1' || st === '5' || /喜欢|heart/i.test(nm) || String(it.is_def) === '1';
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
      id: it.hash, hash: it.hash, name, singer,
      album: it.album_name || (it.albuminfo && it.albuminfo.album_name) || it.albumname,
      cover: _cov(it.cover) || _cov(it.img) || _cov(it.album_audio_cover)
          || _cov(it.album_img) || _cov(it.sizable_cover) || _cov(it.pic), source: 'kugou',
    };
  });
  return { ok: true, title, list };
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

export { API_BASE, fetchStatus };