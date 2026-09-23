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
  return !!(loadPrefs().enabled && loadPrefs().enabled[platform]);
}

/**
 * QQ 登录态下取高音质播放链接。失败/未启用/未登录返回 null（调用方回落原链）。
 * @param {string} songmid QQ 歌曲 mid
 * @param {string} quality 目标音质（128/320/flac/master）
 */
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
    const res = await fetch(`/api/selfhost/netease/proxy?path=${encodeURIComponent('/song/url/v1?id=' + encodeURIComponent(String(id)) + '&level=' + encodeURIComponent(level))}`, signal ? { signal } : undefined);
    if (!res || (!res.ok && res.status !== 200)) {
      logWarn('selfhost', `[网易云] 自建取链接失败 HTTP ${res ? res.status : 'no-response'}`);
      return null;
    }
    const j = await res.json().catch(() => null);
    /* /song/url/v1 返回 {data:[{id,url}]}（数组）；兼容 {data:{url}} 与双层包裹 */
    const d0 = (j && j.data) || {};
    const first = Array.isArray(d0) ? d0[0] : d0;
    const url = (first && first.url) || (d0 && d0.url) || (j && maybeNeteaseUrl(j));
    if (!url || !url.startsWith('http')) {
      /* 常见于 VIP 曲目未登录/等级不足：url 为 null —— 留痕便于区分「没取到」与「取到但不可播」 */
      logWarn('selfhost', `[网易云] 自建返回无直链（level=${level}，疑 VIP/版权受限），走公网阶梯`);
      return null;
    }
    return url;
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
 * 6. 公网那条路对**付费曲**是死的：免费曲 `status:1` 给真链，付费曲
 *    `status:0 + error="需要付费"`（连 128k 都拒）。这点结论不变。
 *
 * 结论：**不要照「做第三方授权 UI」的思路做** —— 38 不是授权类验证，做了也是错的。
 * 合理方向是「引导重新登录酷狗 + 把 v_type 翻译成人话给用户」，属功能开发。
 * 复现脚本：scripts/probes/kugou-verify-probe.py
 * 上游背景：https://github.com/MakcRe/KuGouMusicApi/issues/206
 * ============================================================ */

export async function selfhostQQPlayUrl(songmid, quality = '320') {
  /* ★ 这里要求 selfhostEnabled('qq')：与「登录态」是两码事。
     只在设置页扫了码（status 显示 loggedIn）并不会让取链接走自建 —— 还需要平台开关打开。
     开关关着时明确留痕，否则表现是「明明登录了却一直走在线源」，完全无从排查。 */
  if (!songmid) return null;
  if (!selfhostEnabled('qq')) {
    logInfo('selfhost', '[QQ] 平台开关未启用，跳过自建取链接（走在线源池）');
    return null;
  }
  try {
    const st = await fetchStatus();
    const s = st && st.qq;
    if (!s || !s.alive || !s.loggedIn) {
      logWarn('selfhost', `[QQ] 自建不可用（alive=${!!(s && s.alive)} loggedIn=${!!(s && s.loggedIn)}），走在线源池`);
      return null;
    }
    const q = encodeURIComponent(quality);
    const mid = encodeURIComponent(songmid);
    const res = await fetch(`/api/selfhost/qq/proxy?path=${encodeURIComponent(`/getMusicPlay?songmid=${mid}&quality=${q}`)}`);
    if (!res.ok) {
      /* 带上响应体：代理失败时会回 {'error': '...'}，只报状态码没法定位 */
      let detail = '';
      try { const j = await res.json(); detail = (j && (j.error || j.err)) || ''; } catch (e) { /* 非 JSON */ }
      logWarn('selfhost', `[QQ] 自建取链接 HTTP ${res.status}${detail ? '：' + detail : ''}`);
      return null;
    }
    const data = await res.json();
    const url = findFirstHttpUrl(data);
    if (!url) logWarn('selfhost', '[QQ] 自建响应中没有可用播放链接（可能返回试听/受限）');
    return url || null;
  } catch (e) {
    logWarn('selfhost', '[QQ] 自建取链接异常:', e && e.message);
    return null;
  }
}

/**
 * 按设置的日推来源拉取每日推荐，返回 { ok, title, list }。list 元素含 song/name, singer, id, source 等。
 * @param {'qql'|'kugou'|'netease'} source 覆盖默认来源
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
      id: it.hash, name: it.songname || it.filename || it.name, singer,
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
      id: mid, name: song.title || song.name || song.songname,
      singer, album: song.album && (song.album.name || song.album.mid || ''), source: 'qq',
      cover: (song.album && (song.album.pmid || song.album.mid)) ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${song.album.pmid || song.album.mid}.jpg` : (song.cover || null),
    });
  });
  /* 严格模式：一个都没解析出且有 response 包裹时视为不适用（如未登录） */
  return { ok: true, title: '每日推荐 · QQ音乐', list };
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
      id: song.mid, name: song.title || song.name || it.songname || '', singer,
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
      id: it.hash, name, singer,
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