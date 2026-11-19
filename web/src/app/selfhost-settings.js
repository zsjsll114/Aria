/* ============================================================
 * selfhost-settings.js — 设置页「自建服务」区块
 * - 三平台（酷狗 / QQ / 网易云）卡片：启用开关 + 存活/登录状态 + 扫码登录/登出
 * - 扫码登录弹窗（毛玻璃，复用 lyric-source 弹窗样式）
 *   · QQ 两种扫码方式可切换：QQ App / 微信
 *   · 网易云三种登录方式：扫码 / 手机号 / 邮箱
 *   · 酷狗两种登录方式：扫码 / 手机号（短信验证码；扫码不足以解锁风控时可走这条）
 * - 「每日推荐来源」下拉
 * - 偏好持久化到 localStorage：selfhost_prefs
 * 依赖 server.py 的 /api/selfhost/* 路由 + 各平台 vendor 副进程。
 * ============================================================ */
const PLATFORMS = ['kugou', 'qq', 'netease'];
import { getSelfhostOptions, invalidateSelfhostCaches, kugouTodayStr, saveSelfhostOption, startSelfhostService, updateSelfHostBadge } from './selfhost-runtime.js';
import { mountDropdown } from '../ui/settingsPrimitives.js';
import { esc } from '../utils/formatters.js';
import { logCatch } from '../services/log.js';
const PLATFORM_LABEL = { kugou: '酷狗音乐', qq: 'QQ音乐', netease: '网易云音乐' };
const PLATFORM_PORTS = { kugou: 3100, qq: 3200, netease: 3201 };
const PLATFORM_CAPS = {
  kugou: '搜索兜底 · KRC 逐字歌词 · 日推 · 云端歌单(可建删/移除) · 签到领 VIP（播放走公网）',
  qq: '搜索 · 逐字歌词 · 日推 · 歌单/收藏(只读) · 高音质播放 · 歌手页',
  netease: '搜索 · 逐字歌词 · 日推 · 云端歌单(可建删/编辑) · 红心收藏 · 高音质播放 · 歌手页',
};
/* 官方平台图标（用户放入 src/img，已同步到 web/src/img） */
const PLATFORM_ICON_SRC = { kugou: 'src/img/KugouMusicIcon.svg', qq: 'src/img/QQMusicIcon.svg', netease: 'src/img/NeteaseMusicIcon.svg', kuwo: 'src/img/KuwoMusicIcon.svg' };
function platformIconImg(name, size = 18) {
  const src = PLATFORM_ICON_SRC[name];
  return src ? `<img src="${esc(src)}" style="width:${size}px;height:${size}px;display:inline-block;vertical-align:middle;border-radius:3px;" alt="">` : '';
}
const PLATFORM_ICONS = {
  kugou: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1 7.5h2v5h-2v-5zm4 .5h1v4h-1zm-8 .5h1v4H7z"/></svg>',
  qq: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-.5 6.5c1.1 0 2 1 2 2.2 0 .8-.4 1.5-1 1.9l.2 1.9h-2.4l.2-1.9c-.6-.4-1-1.1-1-1.9 0-1.2.9-2.2 2-2.2z"/></svg>',
  netease: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.5 6l7.5 1.5-.5 1-6.5-1.3.3 7.8c0 .7-.6 1.3-1.3 1.3-.7 0-1.3-.6-1.3-1.3l-1-4c2-.8 3-3 2-5.5-.5-1.2-1.5-2-2.5-1.9z"/></svg>',
};
const SH_KEY = 'selfhost_prefs';
const QR_TYPE_LABEL = { 2: 'QQ App', 3: '微信' };
const QR_TYPE_ORDER = [2, 3];

let qrTimer = null;
let kgCdTimer = null;             // 酷狗「获取验证码」倒计时（切 tab / 关闭弹窗时必须清）
let qrPolling = false;            // 防止上一轮 poll 未完成时叠加请求（微信长轮询尤其重要）
let qrState = { platform: null, qrType: 2, keyObj: null };

function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(SH_KEY));
    if (raw && typeof raw === 'object') return raw;
  } catch (e) { /* ignore */ }
  return { enabled: { kugou: false, qq: false, netease: false }, dailySource: 'netease' };
}

function savePrefs(p) {
  try { localStorage.setItem(SH_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ }
}

/* ★ 登录成功自动启用该平台（2026-09-25 用户反馈「日推没了？我明明登录了」）：
   登录态（服务端 cookie）与启用开关（selfhost_prefs.enabled）是两套独立状态，
   此前登录成功从不写开关 → 日推/高音质取链在 dayRecommend 的 selfhostEnabled()
   守卫处全军覆没，用户视角「登录了却不给用」。登录本身就是使用意图，直接点亮。 */
function enablePlatform(platform) {
  if (!platform) return;
  try {
    const p = loadPrefs();
    p.enabled = p.enabled || {};
    if (!p.enabled[platform]) { p.enabled[platform] = true; savePrefs(p); }
  } catch (e) { /* ignore */ }
}

async function shFetch(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getStatus() {
  try { return await shFetch('/api/selfhost/status'); }
  catch (e) { return null; }
}

/* ★ 竞态防护：多次快速调用 initSelfhostSection 时，只有最新版本的回调才允许渲染 */
let _selfhostRenderId = 0;

export function initSelfhostSection() {
  const host = document.getElementById('selfhostContainer');
  if (!host) return;
  host.innerHTML = '';
  const prefs = loadPrefs();
  const myId = ++_selfhostRenderId;

  // 顶部标题与快捷操作条
  const topBar = document.createElement('div');
  topBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;';
  const tip = document.createElement('div');
  tip.className = 'settings-group-title';
  tip.style.margin = '0';
  tip.textContent = '自建服务（需 Node.js）';
  topBar.appendChild(tip);

  const topRight = document.createElement('div');
  topRight.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;';
  const summaryBadge = document.createElement('span');
  summaryBadge.className = 'setting-desc';
  summaryBadge.style.cssText = 'margin:0;font-size:11px;opacity:.75;';
  summaryBadge.textContent = '状态检测中…';
  topRight.appendChild(summaryBadge);

  const openFavBtn = document.createElement('button');
  openFavBtn.className = 'setting-btn';
  openFavBtn.style.cssText = 'padding:4px 10px;font-size:11px;';
  openFavBtn.textContent = '自建收藏';
  openFavBtn.addEventListener('click', () => {
    if (typeof window.openSelfFavorites === 'function') window.openSelfFavorites(state.active);
  });
  topRight.appendChild(openFavBtn);

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'setting-btn';
  refreshBtn.style.cssText = 'padding:4px 10px;font-size:11px;';
  refreshBtn.textContent = '刷新状态';
  refreshBtn.addEventListener('click', () => {
    invalidateSelfhostCaches();
    initSelfhostSection();
  });
  topRight.appendChild(refreshBtn);
  topBar.appendChild(topRight);
  host.appendChild(topBar);

  const tipDesc = document.createElement('div');
  tipDesc.className = 'setting-desc';
  tipDesc.style.cssText = 'margin:2px 0 12px;padding-left:4px;';
  tipDesc.textContent = '登录后日推/收藏/高音质走自建接口；无 VIP 试听链自动回退免费源池。扫码一次长期有效（登录态自动保存）。'
    + '各平台启用开关决定对应功能是否优先自建：QQ 覆盖日推/收藏/歌单与取播放链接；酷狗覆盖日推/歌单/签到/KRC歌词兜底（播放链接仍走公网）；'
    + '网易云覆盖日推/红心/云端歌单与高音质播放。';
  host.appendChild(tipDesc);

  /* 四平台分栏：Tab 头 + 内容区 */
  const tabBar = document.createElement('div');
  tabBar.className = 'setting-btn-group';
  tabBar.style.cssText = 'justify-content:flex-start;margin-bottom:10px;flex-wrap:wrap;';
  const bodyWrap = document.createElement('div');
  const state = { active: selfTabActive || 'netease' };
  const showTab = (name, status) => {
    if (myId !== _selfhostRenderId) return; // 过期版本，跳过
    state.active = name;
    selfTabActive = name;
    tabBar.querySelectorAll('.setting-btn').forEach(b => b.classList.toggle('active', b.dataset.sname === name));
    renderTabBody(bodyWrap, name, status);
  };
  const tabBtn = (name, st) => {
    const b = document.createElement('button');
    b.className = 'setting-btn' + (state.active === name ? ' active' : '');
    b.dataset.sname = name;
    const dot = st && st.loggedIn ? ' · 已登录' : '';
    b.textContent = PLATFORM_LABEL[name] + dot;
    b.addEventListener('click', () => showTab(name));
    return b;
  };
  /* ★ 首帧立即渲染：不等待 /api/selfhost/status 网络往返，控件立即可交互 */
  PLATFORMS.forEach(name => tabBar.appendChild(tabBtn(name, null)));
  host.appendChild(tabBar);
  host.appendChild(bodyWrap);
  showTab(state.active, null);
  getStatus().then(status => {
    if (myId !== _selfhostRenderId) return; // 过期版本，丢弃
    if (status) {
      const aliveCnt = PLATFORMS.filter(n => status[n] && status[n].alive).length;
      const loginCnt = PLATFORMS.filter(n => status[n] && status[n].loggedIn).length;
      summaryBadge.textContent = `在线 ${aliveCnt}/${PLATFORMS.length} · 已登录 ${loginCnt}/${PLATFORMS.length}`;
    } else {
      summaryBadge.textContent = '后端未连接';
    }
    /* 更新平台「已登录」徽标，并重建当前激活面板的实时状态区 */
    PLATFORMS.forEach(name => {
      const b = tabBar.querySelector(`.setting-btn[data-sname="${name}"]`);
      if (b) {
        const st = status && status[name];
        b.textContent = PLATFORM_LABEL[name] + (st && st.loggedIn ? ' · 已登录' : '');
      }
    });
    if (status) showTab(state.active, status);
    else syncSelfhostI18n();
    try { updateSelfHostBadge(); } catch (e) { logCatch('selfhostSettings', e); }
    // ★ 若有副进程处于启动中（且无持久化启动失败 error），延迟重刷一次
    if (status) {
      const pending = PLATFORMS.some(n => status[n] && status[n].hasSource && !status[n].alive && (status[n].starting || !status[n].error));
      if (pending) setTimeout(() => { if (myId === _selfhostRenderId) initSelfhostSection(); }, 4000);
    }
  }).catch((e) => {
    logCatch('selfhostSettings', e);
    summaryBadge.textContent = '状态获取失败';
    syncSelfhostI18n();
  });
}

/* 当前激活的 Tab（模块级缓存，切换设置页后保留） */
let selfTabActive = 'netease';

function syncSelfhostI18n() {
  try {
    const api = globalThis.AriaI18n;
    if (api && typeof api.applyLanguageToUiRoots === 'function') {
      api.applyLanguageToUiRoots('#selfhostContainer');
    }
  } catch (e) { logCatch('selfhostSettings', e); }
}

function renderTabBody(bodyWrap, name, status) {
  bodyWrap.dataset.activePlat = name;
  bodyWrap.innerHTML = '';
  /* status === null → 首帧占位（外层已异步刷新）；status === undefined → 点击 tab 主动拉取；
     status 有值 → 直接用传入状态，不重复请求 */
  if (status === null) {
    bodyWrap.appendChild(buildPlatformPanel(name, null, loadPrefs()));
    syncSelfhostI18n();
    return;
  }
  if (status) {
    bodyWrap.appendChild(buildPlatformPanel(name, status[name] || null, loadPrefs()));
    syncSelfhostI18n();
  } else {
    getStatus().then(s => {
      if (bodyWrap.dataset.activePlat !== name) return;
      bodyWrap.innerHTML = '';
      bodyWrap.appendChild(buildPlatformPanel(name, s ? s[name] : null, loadPrefs()));
      syncSelfhostI18n();
    }).catch((e) => {
      logCatch('selfhostSettings', e);
      if (bodyWrap.dataset.activePlat !== name) return;
      bodyWrap.innerHTML = '';
      bodyWrap.appendChild(buildPlatformPanel(name, null, loadPrefs()));
      syncSelfhostI18n();
    });
  }
}

function buildPlatformPanel(name, st, prefs) {
  const g = document.createElement('div');
  g.className = 'settings-group';

  const enabled = !!(prefs.enabled && prefs.enabled[name]);
  const alive = !!(st && st.alive);
  const starting = !!(st && st.starting);
  const hasSource = !!(st && st.hasSource);
  const loggedIn = !!(st && st.loggedIn);
  const port = (st && st.port) || PLATFORM_PORTS[name] || '';

  // 标题行：图标 + 名称 + 端口 + 存活状态 + 启动/重启 + 启用开关
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap;';
  const icon = document.createElement('span');
  icon.innerHTML = platformIconImg(name, 18);
  icon.style.cssText = 'opacity:.95;flex:0 0 auto;display:inline-flex;';
  head.appendChild(icon);
  const nameEl = document.createElement('span');
  nameEl.className = 'setting-label';
  nameEl.style.cssText = 'font-weight:600;font-size:13px;margin:0;';
  nameEl.textContent = PLATFORM_LABEL[name];
  head.appendChild(nameEl);
  if (port) {
    const portEl = document.createElement('span');
    portEl.className = 'setting-desc';
    portEl.style.cssText = 'margin:0;font-size:10px;opacity:.55;font-family:monospace;';
    portEl.textContent = `:${port}`;
    head.appendChild(portEl);
  }
  const dot = document.createElement('span');
  dot.style.cssText = `width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:${
    hasSource ? (alive ? '#4cd964' : (starting ? '#ff9f0a' : '#ff3b30')) : '#9a9a9a'};`;
  dot.title = !hasSource ? '本地组件缺失' : (alive ? '本地服务运行中' : (starting ? '服务启动中' : '服务未启动'));
  head.appendChild(dot);
  const badge = document.createElement('span');
  badge.className = 'setting-desc';
  badge.style.cssText = 'margin:0;font-size:11px;';
  badge.textContent = !hasSource ? '未安装' : (alive ? '本地运行中' : (starting ? '启动中…' : '离线'));
  head.appendChild(badge);
  if (st && st.exposed) {
    const expBadge = document.createElement('span');
    expBadge.className = 'setting-desc';
    expBadge.style.cssText = 'margin:0;font-size:10px;padding:1px 6px;border-radius:999px;background:rgba(255,59,48,.18);color:#ff6961;border:1px solid rgba(255,59,48,.35);';
    expBadge.title = '检测到非回环端口暴露风险，建议重启服务以应用 127.0.0.1 监听隔离';
    expBadge.textContent = '端口暴露风险';
    head.appendChild(expBadge);
  }
  head.appendChild(Object.assign(document.createElement('div'), { style: 'flex:1;' }));

  if (hasSource) {
    const svcBtn = document.createElement('button');
    svcBtn.className = 'setting-btn';
    svcBtn.style.cssText = 'padding:3px 9px;font-size:11px;';
    svcBtn.textContent = starting ? '启动中…' : (alive ? '重启' : '启动服务');
    svcBtn.disabled = starting;
    svcBtn.addEventListener('click', async () => {
      svcBtn.disabled = true;
      svcBtn.textContent = alive ? '重启中…' : '启动中…';
      await startSelfhostService(name, alive);
      invalidateSelfhostCaches();
      initSelfhostSection();
    });
    head.appendChild(svcBtn);
  }

  const tog = document.createElement('button');
  tog.className = 'setting-toggle' + (enabled ? ' on' : '');
  tog.title = {
    qq: '启用 QQ 自建：日推/收藏 + 取播放链接都走本机（关掉则取链接退回在线源池）',
    netease: '启用网易云自建：日推/收藏/歌单走本机（取播放链接只要求本地服务在线，不受此开关影响）',
    kugou: '启用酷狗自建：日推/收藏/签到走本机（酷狗暂无自建取播放链接，播放仍走公网源）',
  }[name] || '启用该平台自建';
  tog.addEventListener('click', () => {
    const v = !tog.classList.contains('on');
    tog.classList.toggle('on', v);
    prefs.enabled = prefs.enabled || {}; prefs.enabled[name] = v; savePrefs(prefs);
    invalidateSelfhostCaches();
  });
  head.appendChild(tog);
  g.appendChild(head);

  if (PLATFORM_CAPS[name]) {
    const capsEl = document.createElement('div');
    capsEl.className = 'setting-desc';
    capsEl.style.cssText = 'margin:0 0 8px;font-size:11px;opacity:.7;';
    capsEl.textContent = `能力范围：${PLATFORM_CAPS[name]}`;
    g.appendChild(capsEl);
  }

  if (st && !alive && st.error) {
    const errBox = document.createElement('div');
    errBox.className = 'setting-desc';
    errBox.style.cssText = 'margin:0 0 8px;padding:6px 8px;border-radius:8px;background:rgba(255,59,48,.12);color:#ff8a80;font-size:11px;';
    errBox.textContent = `启动异常：${st.error}`;
    g.appendChild(errBox);
  }

  // 登录状态行
  const row = document.createElement('div');
  row.className = 'setting-row';
  const isOk = alive && loggedIn;
  const vipText = st && st.vip === true
    ? 'VIP'
    : (st && typeof st.vip === 'string' && st.vip
      ? st.vip
      : (st && typeof st.vip === 'number' && st.vip > 0 ? `VIP Lv.${st.vip}` : ''));
  const identity = (st && st.nickname)
    ? `${st.nickname} (uid ${(st && st.uid) || ''})`
    : `uid ${(st && st.uid) || ''}`;
  const stateLabel = loggedIn
    ? `已登录 · ${identity}${vipText ? ` · ${vipText}` : ''}`
    : (starting ? '服务启动中…' : (alive ? '未登录' : '服务未启动'));
  row.innerHTML = `<div><div class="setting-label">登录状态</div>
    <div class="setting-desc" style="color:${isOk ? 'var(--theme-color, #3b82f6)' : 'inherit'}">${esc(stateLabel)}</div></div>`;
  const ctrl = document.createElement('div');
  ctrl.className = 'setting-control';
  ctrl.style.cssText = 'gap:6px;flex-wrap:wrap;justify-content:flex-end;';

  if (loggedIn) {
    const favBtn = document.createElement('button');
    favBtn.className = 'setting-btn';
    favBtn.style.cssText = 'padding:6px 10px;';
    favBtn.textContent = '查看收藏';
    favBtn.addEventListener('click', () => {
      if (typeof window.openSelfFavorites === 'function') window.openSelfFavorites(name);
    });
    ctrl.appendChild(favBtn);
  }

  const btn = document.createElement('button');
  btn.className = 'setting-btn' + (loggedIn ? ' danger' : ' primary');
  btn.style.padding = '6px 12px';
  btn.textContent = loggedIn ? '退出登录' : '扫码登录';
  if (!alive) {
    btn.disabled = true;
    btn.style.opacity = '.45';
    btn.style.cursor = 'not-allowed';
    btn.title = hasSource ? '服务未启动，请先启动服务' : '本地组件未安装';
  }
  btn.addEventListener('click', () => {
    if (loggedIn) {
      shFetch(`/api/selfhost/${name}/logout`, { method: 'POST' })
        .then(() => { invalidateSelfhostCaches(); initSelfhostSection(); })
        .catch(() => { invalidateSelfhostCaches(); initSelfhostSection(); });
    } else {
      openLoginModal(name, 'qr');
    }
  });
  ctrl.appendChild(btn);

  row.appendChild(ctrl);
  g.appendChild(row);

  // 手动填写 Cookie（可选，跳过扫码）
  const ckRow = document.createElement('div');
  ckRow.className = 'setting-row';
  ckRow.style.cssText = 'min-height:40px;align-items:flex-start;';
  const ckLeft = document.createElement('div');
  ckLeft.style.cssText = 'flex:1;padding-right:10px;';
  ckLeft.innerHTML = `<div class="setting-label">手动填写 Cookie</div>
    <div class="setting-desc" style="margin:0;font-size:11px;">粘贴登录状态，保存后即登录（可选）</div>`;
  const ckRight = document.createElement('div');
  ckRight.className = 'setting-control';
  ckRight.style.cssText = 'flex-direction:row-reverse;gap:6px;';
  const ckInp = document.createElement('input');
  ckInp.type = 'text';
  ckInp.className = 'appearance-font-select';
  ckInp.placeholder = name === 'kugou' ? 'token=..;userid=..' : (name === 'qq' ? 'uin=..;p_skey=..' : 'MUSIC_U=..');
  ckInp.style.cssText = 'max-width:180px;max-width:none;min-width:160px;padding:5px 10px;font-size:11px;';
  const ckSave = document.createElement('button');
  ckSave.className = 'setting-btn primary';
  ckSave.style.padding = '4px 10px';
  ckSave.textContent = '保存';
  ckSave.addEventListener('click', async () => {
    const val = ckInp.value.trim();
    if (!val) { ckSave.textContent = '空'; setTimeout(() => ckSave.textContent = '保存', 1200); return; }
    ckSave.disabled = true;
    try {
      const r = await shFetch(`/api/selfhost/${name}/setcookie`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie: val }),
      });
      ckSave.disabled = false;
      ckSave.textContent = r && r.ok ? '已登录' : '失败';
      setTimeout(() => ckSave.textContent = '保存', 1500);
      if (r && r.ok) {
        enablePlatform(name);
        invalidateSelfhostCaches();
        initSelfhostSection();
      }
    } catch (e) { logCatch('selfhostSettings', e); ckSave.disabled = false; ckSave.textContent = '✗ 失败'; }
  });
  ckRight.appendChild(ckSave); ckRight.appendChild(ckInp);
  ckRow.appendChild(ckLeft); ckRow.appendChild(ckRight);
  g.appendChild(ckRow);

  // 酷狗：每日签到领 VIP（自动签到开关 + 立即签到）
  if (name === 'kugou') {
    const ciRow = document.createElement('div');
    ciRow.className = 'setting-row';
    ciRow.style.cssText = 'min-height:40px;';
    ciRow.innerHTML = `<div><div class="setting-label">每日签到领 VIP</div>
      <div class="setting-desc" style="margin:0;font-size:11px;" id="kgCheckinLog">每天可领 2 天概念版 VIP</div></div>`;
    const ciCtrl = document.createElement('div');
    ciCtrl.className = 'setting-control';
    const autoTog = document.createElement('button');
    const autoOn = prefs.kugouAutoCheckin !== false;
    autoTog.className = 'setting-toggle' + (autoOn ? ' on' : '');
    autoTog.title = '自动签到（打开应用时自动执行）';
    autoTog.addEventListener('click', () => {
      const v = !autoTog.classList.contains('on');
      autoTog.classList.toggle('on', v);
      prefs.kugouAutoCheckin = v; savePrefs(prefs);
    });
    ciCtrl.appendChild(autoTog);
    if (loggedIn) {
      const ciBtn = document.createElement('button');
      ciBtn.className = 'setting-btn primary';
      ciBtn.style.padding = '5px 12px';
      ciBtn.textContent = '立即签到';
      ciBtn.addEventListener('click', () => runKugouCheckin(ciBtn, ciRow));
      ciCtrl.appendChild(ciBtn);
      ciRow.appendChild(ciCtrl);
      g.appendChild(ciRow);
      autoKugouCheckin(ciBtn, ciRow);
    } else {
      ciCtrl.appendChild(document.createElement('span'));
      ciRow.appendChild(ciCtrl);
      g.appendChild(ciRow);
    }
  }

  // 上游 API 参数配置（依据各平台源码支持项生成）
  g.appendChild(buildUpstreamOptionsSection(name, st, hasSource));

  // 说明
  if (!hasSource) {
    const note = document.createElement('div');
    note.style.cssText = 'opacity:.55;font-size:11px;margin-top:-2px;';
    note.textContent = '本地组件缺失，无法启动服务';
    g.appendChild(note);
  }

  return g;
}

/* ==================== 酷狗每日签到领 VIP ==================== */
const KG_CI_KEY = 'kugou_checkin_date';
let kgCiTimer = null;

function autoKugouCheckin(btn, row) {
  try {
    if (localStorage.getItem(KG_CI_KEY) === kugouTodayStr()) return;
  } catch (e) { /* ignore */ }
  runKugouCheckin(btn, row, true);
}

async function runKugouCheckin(btn, row, auto = false) {
  const logEl = row.querySelector('#kgCheckinLog');
  const setLog = t => { if (logEl) logEl.textContent = t; };
  if (kgCiTimer) { clearInterval(kgCiTimer); kgCiTimer = null; }
  btn.disabled = true;
  btn.textContent = '签到中…';
  setLog('启动签到…');
  try {
    const r = await shFetch('/api/selfhost/kugou/checkin', { method: 'POST' });
    if (!r.ok) {
      setLog((r.err || '启动失败') + (auto ? '' : ''));
      btn.disabled = false; btn.textContent = '立即签到';
      return;
    }
  } catch (e) {
    setLog(`启动失败：${e.message}`);
    btn.disabled = false; btn.textContent = '立即签到';
    return;
  }
  /* 轮询进度（签到最多 8 次领取、每次间隔 30s） */
  const poll = async () => {
    let st = null;
    try { st = await shFetch('/api/selfhost/kugou/checkin/status'); } catch (e) { st = null; }
    if (!st) { kgCiTimer = setTimeout(poll, 3000); return; }
    if (st.log && st.log.length) setLog(st.log[st.log.length - 1]);
    if (st.done) {
      kgCiTimer = null;
      btn.disabled = false; btn.textContent = '再领一次';
      if (st.result && st.result.ok) {
        try { localStorage.setItem(KG_CI_KEY, kugouTodayStr()); } catch (e) { /* ignore */ }
        setLog(`今日领到 ${st.result.claimed} 天 VIP，到期 ${st.result.vipEnd || '未知'}`);
      } else if (st.err) {
        setLog(`✗ ${st.err}`);
      } else if (st.result && st.result.err) {
        setLog(`✗ ${st.result.err}`);
      }
      return;
    }
    kgCiTimer = setTimeout(poll, 2000);
  };
  poll();
}

/* ==================== 登录弹窗（扫码 / 手机 / 邮箱 / Cookie） ==================== */
async function openLoginModal(platform, initialMode = 'qr') {
  const overlay = document.getElementById('selfhostQrOverlay');
  const body = document.getElementById('selfhostQrBody');
  const title = document.getElementById('selfhostQrTitle');
  if (!overlay || !body) return;
  title.textContent = `${PLATFORM_LABEL[platform]} 登录`;
  qrState.platform = platform;
  qrState.qrType = 2;
  qrState.keyObj = null;
  stopPoll();
  clearKgCountdown();

  if (platform === 'netease') {
    renderNeteaseLoginTabs(body, platform);
  } else if (platform === 'kugou') {
    renderKugouLoginTabs(body, platform, initialMode);
  } else {
    await startQrCode(platform, qrState.qrType);
  }
  overlay.classList.add('visible');
  bindModalClose(overlay);
}

function renderNeteaseLoginTabs(body, platform) {
  const tabs = ['扫码', '手机号', '邮箱'];
  let mode = 'qr';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:10px;';
  body.innerHTML = '';
  body.appendChild(wrap);

  const tabBar = document.createElement('div');
  tabBar.className = 'setting-btn-group';
  tabBar.style.cssText = 'justify-content:center;';
  tabs.forEach((label, i) => {
    const b = document.createElement('button');
    b.className = 'setting-btn' + (i === 0 ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => {
      tabBar.querySelectorAll('.setting-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      mode = ['qr', 'phone', 'email'][i];
      /* 切 tab 时停止上一模式的扫码轮询，避免残留请求 */
      stopPoll();
      qrState.keyObj = null;
      renderNeteasePanel(wrap, mode, platform, () => openLoginModal(platform));
    });
    tabBar.appendChild(b);
  });
  wrap.appendChild(tabBar);
  renderNeteasePanel(wrap, 'qr', platform, () => openLoginModal(platform));
}

/* ---- 酷狗：扫码 / 手机号（短信验证码） ---- */
function renderKugouLoginTabs(body, platform, initialMode = 'qr') {
  const modes = ['qr', 'phone'];
  const tabs = ['扫码', '手机号'];
  const startMode = modes.includes(initialMode) ? initialMode : 'qr';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:10px;';
  body.innerHTML = '';
  body.appendChild(wrap);

  const tabBar = document.createElement('div');
  tabBar.className = 'setting-btn-group';
  tabBar.style.cssText = 'justify-content:center;';
  tabs.forEach((label, i) => {
    const m = modes[i];
    const b = document.createElement('button');
    b.className = 'setting-btn' + (m === startMode ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => {
      tabBar.querySelectorAll('.setting-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      stopPoll();
      clearKgCountdown();
      qrState.keyObj = null;
      renderKugouPanel(wrap, m, platform);
    });
    tabBar.appendChild(b);
  });
  wrap.appendChild(tabBar);
  renderKugouPanel(wrap, startMode, platform);
}

function clearKgCountdown() {
  if (kgCdTimer) { clearInterval(kgCdTimer); kgCdTimer = null; }
}

/** 生成一个「标签 + 输入框」字段块（与网易云面板同款样式） */
function buildLoginField(label, key, ph, type) {
  const field = document.createElement('div');
  field.style.cssText = 'width:100%;display:flex;flex-direction:column;gap:4px;text-align:left;box-sizing:border-box;';
  const lab = document.createElement('div');
  lab.className = 'setting-desc';
  lab.style.cssText = 'margin:0;font-size:11px;';
  lab.textContent = label;
  const inp = document.createElement('input');
  inp.type = type || 'text';
  inp.placeholder = ph;
  inp.className = 'appearance-font-select';
  /* 填满容器宽度并左右留间距（覆盖 appearance-font-select 默认 max-width） */
  inp.style.cssText = 'width:calc(100% - 12px);max-width:none;min-width:0;box-sizing:border-box;margin:0 6px;';
  inp.dataset.key = key;
  field.appendChild(lab);
  field.appendChild(inp);
  return field;
}

/** 手机验证码登录表单（酷狗） */
function renderSmsLoginForm(panel, platform, hintText) {
  const mobileField = buildLoginField('手机号', 'mobile', '11 位手机号（不带 +86）', 'text');
  panel.appendChild(mobileField);
  const codeField = buildLoginField('验证码', 'code', '6 位短信验证码', 'text');
  panel.appendChild(codeField);

  const sendBtn = document.createElement('button');
  sendBtn.className = 'setting-btn';
  sendBtn.style.cssText = 'align-self:flex-end;margin:0 6px;padding:4px 10px;font-size:12px;';
  sendBtn.textContent = '获取验证码';
  panel.appendChild(sendBtn);

  const hint = document.createElement('div');
  hint.className = 'setting-desc';
  hint.style.cssText = 'margin:0;font-size:11px;color:rgba(255,255,255,.45);text-align:center;';
  hint.textContent = hintText;
  panel.appendChild(hint);

  const errEl = document.createElement('div');
  errEl.style.cssText = 'font-size:12px;color:#ff5f57;min-height:16px;text-align:center;';
  panel.appendChild(errEl);

  const submit = document.createElement('button');
  submit.className = 'setting-btn primary';
  submit.style.padding = '8px 16px';
  submit.textContent = '登 录';
  panel.appendChild(submit);

  const val = (key) => (panel.querySelector(`input[data-key="${key}"]`) || {}).value || '';
  mobileField.querySelector('input').focus();

  sendBtn.addEventListener('click', async () => {
    const mobile = val('mobile').trim();
    if (!mobile) {
      errEl.style.color = '#ff5f57';
      errEl.textContent = '请先填手机号';
      return;
    }
    sendBtn.disabled = true;
    errEl.style.color = 'rgba(255,255,255,.6)';
    errEl.textContent = '发送中…';
    try {
      const r = await shFetch(`/api/selfhost/${platform}/captcha`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile }),
      });
      if (r && r.ok) {
        errEl.style.color = '#4cd964';
        errEl.textContent = '验证码已发送，请查收短信';
        let cd = 60;
        sendBtn.textContent = `${cd}s 后重发`;
        clearKgCountdown();
        kgCdTimer = setInterval(() => {
          cd -= 1;
          if (cd <= 0) {
            clearKgCountdown();
            sendBtn.disabled = false;
            sendBtn.textContent = '获取验证码';
          } else {
            sendBtn.textContent = `${cd}s 后重发`;
          }
        }, 1000);
      } else {
        errEl.style.color = '#ff5f57';
        errEl.textContent = (r && r.err) || '发送失败';
        sendBtn.disabled = false;
      }
    } catch (e) {
      errEl.style.color = '#ff5f57';
      errEl.textContent = e.message || '发送失败';
      sendBtn.disabled = false;
    }
  });

  submit.addEventListener('click', async () => {
    const mobile = val('mobile').trim();
    const code = val('code').trim();
    if (!mobile || !code) {
      errEl.style.color = '#ff5f57';
      errEl.textContent = '请填写手机号与验证码';
      return;
    }
    submit.disabled = true;
    submit.textContent = '登录中…';
    errEl.textContent = '';
    try {
      const r = await shFetch(`/api/selfhost/${platform}/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile, code }),
      });
      if (r && r.ok && r.loggedIn) {
        errEl.style.color = '#4cd964';
        errEl.textContent = '登录成功';
        enablePlatform(platform);
        invalidateSelfhostCaches();
        clearKgCountdown();
        setTimeout(() => { document.getElementById('selfhostQrOverlay').classList.remove('visible'); initSelfhostSection(); }, 600);
      } else {
        errEl.style.color = '#ff5f57';
        errEl.textContent = (r && r.err) || '登录失败';
      }
    } catch (e) {
      errEl.style.color = '#ff5f57';
      errEl.textContent = e.message || '登录失败';
    } finally {
      submit.disabled = false;
      submit.textContent = '登 录';
    }
  });
}

function renderKugouPanel(wrap, mode, platform) {
  const old = wrap.querySelector('[data-kg-panel]');
  if (old) old.remove();
  const panel = document.createElement('div');
  panel.dataset.kgPanel = '1';
  panel.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:10px;';
  wrap.appendChild(panel);

  if (mode === 'qr') {
    panel.innerHTML = '<div style="opacity:.6;text-align:center;padding:24px 0;">正在获取二维码…</div>';
    fetchQrThen(platform, 2, panel);
    return;
  }
  renderSmsLoginForm(panel, platform, '验证码由酷狗官方短信下发；登录态仅保存在本机');
}

/* ★ OOBE 复用口：全局暴露扫码登录弹窗（000-tooltip 首启引导直接拉起） */
window.openSelfHostLogin = openLoginModal;

function renderNeteasePanel(wrap, mode, platform, restart) {
  const old = wrap.querySelector('[data-nm-panel]');
  if (old) old.remove();
  const panel = document.createElement('div');
  panel.dataset.nmPanel = '1';
  panel.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:10px;';
  wrap.appendChild(panel);

  if (mode === 'qr') {
    panel.innerHTML = '<div style="opacity:.6;text-align:center;padding:24px 0;">正在获取二维码…</div>';
    fetchQrThen(platform, 2, panel);
    return;
  }

  // 手机号 / 邮箱表单
  const isPhone = mode === 'phone';
  const inputs = [
    { label: isPhone ? '手机号' : '邮箱', type: 'text', key: isPhone ? 'phone' : 'email', ph: isPhone ? '11 位手机号' : 'example@mail.com' },
    { label: '密码', type: 'password', key: 'password', ph: '网易云账号密码' },
  ];
  inputs.forEach((it, idx) => {
    const field = document.createElement('div');
    field.style.cssText = 'width:100%;display:flex;flex-direction:column;gap:4px;text-align:left;box-sizing:border-box;';
    const lab = document.createElement('div');
    lab.className = 'setting-desc';
    lab.style.cssText = 'margin:0;font-size:11px;';
    lab.textContent = it.label;
    const inp = document.createElement('input');
    inp.type = it.type;
    inp.placeholder = it.ph;
    inp.className = 'appearance-font-select';
    /* 填满容器宽度并左右留间距（覆盖 appearance-font-select 默认 max-width） */
    inp.style.cssText = 'width:calc(100% - 12px);max-width:none;min-width:0;box-sizing:border-box;margin:0 6px;';
    inp.dataset.key = it.key;
    field.appendChild(lab);
    field.appendChild(inp);
    panel.appendChild(field);
    if (idx === 0) inp.focus();
  });
  const hint = document.createElement('div');
  hint.className = 'setting-desc';
  hint.style.cssText = 'margin:0;font-size:11px;color:rgba(255,255,255,.45);text-align:center;';
  hint.textContent = '密码仅在本地校验，不会上传到本机以外';
  panel.appendChild(hint);
  const errEl = document.createElement('div');
  errEl.style.cssText = 'font-size:12px;color:#ff5f57;min-height:16px;';
  panel.appendChild(errEl);
  const submit = document.createElement('button');
  submit.className = 'setting-btn primary';
  submit.style.padding = '8px 16px';
  submit.textContent = '登 录';
  panel.appendChild(submit);
  submit.addEventListener('click', async () => {
    const payload = {};
    inputs.forEach(it => { payload[it.key] = panel.querySelector(`input[data-key="${it.key}"]`).value.trim(); });
    if (!payload[isPhone ? 'phone' : 'email'] || !payload.password) {
      errEl.textContent = '请填写完整';
      return;
    }
    submit.disabled = true;
    submit.textContent = '登录中…';
    errEl.textContent = '';
    try {
      const r = await shFetch(`/api/selfhost/${platform}/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: isPhone ? 'phone' : 'email', ...payload }),
      });
      if (r && r.ok && r.loggedIn) {
        errEl.style.color = '#4cd964';
        errEl.textContent = '登录成功';
        enablePlatform(platform);   /* ★ 登录即启用 */
        invalidateSelfhostCaches();
        setTimeout(() => { document.getElementById('selfhostQrOverlay').classList.remove('visible'); initSelfhostSection(); }, 600);
      } else {
        errEl.style.color = '#ff5f57';
        errEl.textContent = (r && r.err) || '登录失败';
      }
    } catch (e) {
      errEl.textContent = e.message || '登录失败';
    } finally {
      submit.disabled = false;
      submit.textContent = '登 录';
    }
  });
}

async function startQrCode(platform, qrType) {
  const body = document.getElementById('selfhostQrBody');
  const baseQrUrl = platform === 'qq'
    ? `/api/selfhost/${platform}/qr?qr_type=${qrType}`
    : `/api/selfhost/${platform}/qr`;
  try {
    const qr = await shFetch(baseQrUrl);
    if (!qr.ok) {
      body.innerHTML = `<div style="opacity:.7;text-align:center;padding:24px 0;">${esc(qr.err || '取码失败')}</div>`;
      return;
    }
    qrState.qrType = qrType;
    qrState.keyObj = buildKeyObj(platform, qr);
    renderQrBody(body, platform, qr);
    startPoll();
  } catch (e) {
    body.innerHTML = `<div style="opacity:.7;text-align:center;padding:24px 0;">取码失败：${esc(e.message)}</div>`;
  }
}

async function fetchQrThen(platform, qrType, panel) {
  try {
    const qr = await shFetch(`/api/selfhost/${platform}/qr`);
    if (!qr.ok) {
      panel.innerHTML = `<div style="opacity:.7;text-align:center;padding:24px 0;">${esc(qr.err || '取码失败')}</div>`;
      return;
    }
    qrState.qrType = qrType;
    qrState.keyObj = buildKeyObj(platform, qr);
    renderQrBody(panel, platform, qr);
    startPoll();
  } catch (e) {
    panel.innerHTML = `<div style="opacity:.7;text-align:center;padding:24px 0;">取码失败：${esc(e.message)}</div>`;
  }
}

function buildKeyObj(platform, qr) {
  if (platform === 'qq') {
    if (qr.uuid) return { uuid: qr.uuid, qrType: qr.qrType || 3 };
    return { ptqrtoken: qr.ptqrtoken, qrsig: qr.qrsig, qrType: qr.qrType || 2 };
  }
  if (platform === 'kugou') return { key: qr.key, qrcode: qr.key };
  if (platform === 'netease') return { key: qr.key };
  return {};
}

function renderQrBody(body, platform, qr) {
  const typeSwitch = platform === 'qq'
    ? `<div style="margin:0 0 4px;justify-content:center;display:flex;gap:8px;" class="setting-btn-group">
        ${QR_TYPE_ORDER.map(t => `<button class="setting-btn${qr.qrType === t ? ' active' : ''}" data-fqr="${t}">${QR_TYPE_LABEL[t]}</button>`).join('')}
      </div>`
    : '';
  const hintText = qr.hint
    ? (qr.hint === true ? '' : qr.hint)
    : (platform === 'netease' ? '请用网易云音乐 App 扫码授权（若扫码无效，请改用上方「手机号 / 邮箱」登录）'
    : platform === 'kugou' ? '请用酷狗音乐 App 扫码授权（若扫码不行，点上方「手机号」用短信验证码登录）'
    : '请用对应 App 扫码授权（QQ App 或 微信）');
  body.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;gap:8px;">
      ${typeSwitch}
      <img src="${esc(qr.img)}" title="点击刷新二维码" style="width:200px;height:200px;border-radius:10px;background:#fff;padding:6px;box-sizing:border-box;cursor:pointer;pointer-events:auto;"/>
      <div style="font-size:12px;opacity:.8;text-align:center;" id="selfhostQrHint">${esc(hintText)}</div>
      <button class="setting-btn primary" id="selfhostQrRefreshBtn" style="padding:5px 14px;display:inline-flex;align-items:center;gap:5px;"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>刷新二维码</button>
    </div>
  `;
  /* 刷新：重新取码并重新轮询（二维码点击 + 显式按钮都触发） */
  const doRefresh = () => {
    stopPoll();
    if (platform === 'netease') {
      fetchQrThen(platform, 2, body);
    } else {
      startQrCode(platform, qrState.qrType || 2);
    }
  };
  const imgEl = body.querySelector('img');
  if (imgEl) imgEl.addEventListener('click', doRefresh);
  const rfBtn = body.querySelector('#selfhostQrRefreshBtn');
  if (rfBtn) rfBtn.addEventListener('click', doRefresh);
  /* QQ 扫码方式切换：重新取码并重新轮询 */
  if (platform === 'qq') {
    body.querySelectorAll('button[data-fqr]').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = Number(btn.dataset.fqr);
        if (t === qrState.qrType) return;
        startQrCode(platform, t);
      });
    });
  }
}

/* 轮询：串行防叠加（微信长轮询单次可达十几秒，setInterval 会堆积请求） */
function startPoll() {
  stopPoll();
  const body = document.getElementById('selfhostQrBody') || document;
  const loop = async () => {
    if (!qrState.platform || !qrState.keyObj) return;
    qrPolling = true;
    let r = null;
    try {
      r = await shFetch(`/api/selfhost/${qrState.platform}/check`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: qrState.keyObj }),
      });
    } catch (e) {
      r = null;
    }
    qrPolling = false;
    if (!qrState.platform || !qrState.keyObj) return;  // 弹窗已关闭
    const hint = document.getElementById('selfhostQrHint');
    if (r && r.loggedIn) {
      stopPoll();
      if (hint) hint.textContent = '登录成功';
      enablePlatform(qrState.platform);   /* ★ 登录即启用 */
      invalidateSelfhostCaches();
      setTimeout(() => {
        document.getElementById('selfhostQrOverlay')?.classList.remove('visible');
        initSelfhostSection();
      }, 700);
      return;
    }
    if (r && r.refresh) {
      stopPoll();
      if (hint) hint.textContent = '二维码已失效，点击右上角关闭后重新扫码';
      return;
    }
    /* ★ 失败必须先于文案渲染判定。shFetch 只在 HTTP 非 2xx 抛错，而后端把 vendor 的
       业务失败包成 200 + {ok:false, err}；早期实现没判 ok:false，这类失败会掉进
       describeStatus 的兜底分支、显示成「等待扫码…」—— 扫码之后任何一次校验失败
       都表现为「没反应」。这里显式报错并继续重试（可恢复，不 stopPoll）。 */
    if (r === null || r.ok === false) {
      const why = (r && r.err) || '';
      if (hint) hint.textContent = why ? `${why}（重试中）` : '重试中';
      if (qrState.platform && qrState.keyObj) qrTimer = setTimeout(loop, 3000);
      return;
    }
    /* 过期码停止轮询（酷狗 status=0 / 网易云 800） */
    if (r && (r.status === 0 || r.status === 800)) {
      stopPoll();
      if (hint) hint.textContent = '二维码已过期，点击右上角关闭后重新扫码';
      return;
    }
    if (hint) hint.textContent = describeStatus(r, qrState.platform);
    /* 递归调度下一轮（间隔 2s；失败重试 3s） */
    const pollMs = 2000;
    if (qrState.platform && qrState.keyObj) {
      qrTimer = setTimeout(loop, r ? pollMs : 3000);
    }
  };
  qrTimer = setTimeout(loop, 300);
}

function stopPoll() {
  if (qrTimer) { clearTimeout(qrTimer); qrTimer = null; }
  qrPolling = false;
}

function bindModalClose(overlay) {
  const closeBtn = document.getElementById('selfhostQrCloseBtn');
  if (overlay.__qrOnCloseBound) return;
  overlay.__qrOnCloseBound = true;
  const onClose = () => {
    stopPoll();
    clearKgCountdown();
    qrState.platform = null; qrState.keyObj = null;
    overlay.classList.remove('visible');
  };
  overlay.addEventListener('click', e => { if (e.target === overlay) onClose(); });
  if (closeBtn) closeBtn.addEventListener('click', onClose);
}

function describeStatus(r, platform) {
  if (!r) return '等待扫码…';
  const msg = (r && r.message) || '';
  const st = r && r.status;
  if (platform === 'kugou') {
    if (st === 4) return '已登录成功…';
    if (st === 2) return '已扫码，请在手机上确认';
    if (st === 1) return '等待扫码…';
    if (st === 0) return '二维码已过期';
    return msg || '等待扫码…';
  }
  if (platform === 'qq') {
    if (st === 2) return '已扫码，请在手机上确认';
    if (st === 3) return '二维码已失效';
    return msg || '等待扫码…';
  }
  if (platform === 'netease') {
    if (st === 802) return '已扫码，请在手机上确认';
    if (st === 801) return '等待扫码…';
    if (st === 800) return '二维码已过期';
    return msg || '等待扫码…';
  }
  return msg || '等待扫码…';
}

/* 依据三个上游自建 API 源码（KuGouMusicApi / qq-music-api / NeteaseCloudMusicApi）暴露的可配置参数 */
function buildUpstreamOptionsSection(name, st, hasSource) {
  const details = document.createElement('details');
  details.className = 'selfhost-api-details';
  details.style.cssText = 'margin-top:8px;border-top:1px solid rgba(255,255,255,.08);padding-top:6px;';
  const summary = document.createElement('summary');
  summary.className = 'setting-label';
  summary.style.cssText = 'cursor:pointer;font-size:12px;opacity:.88;user-select:none;padding:4px 0;display:flex;align-items:center;justify-content:space-between;';
  summary.innerHTML = '<span class="setting-label" style="margin:0;font-size:12px;">接口与参数配置</span><span class="setting-desc" style="margin:0;font-size:10px;opacity:.6;">按上游 API 自定义</span>';
  details.appendChild(summary);

  const box = document.createElement('div');
  box.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-top:4px;';
  details.appendChild(box);

  const shOpts = getSelfhostOptions(name);
  const srvCfg = (st && st.config) || {};

  const addSelectRow = (label, desc, items, value, onChange) => {
    const r = document.createElement('div');
    r.className = 'setting-row';
    r.style.cssText = 'min-height:36px;';
    const left = document.createElement('div');
    left.innerHTML = `<div class="setting-label" style="font-size:12px;">${esc(label)}</div>`
      + (desc ? `<div class="setting-desc" style="margin:0;font-size:11px;">${esc(desc)}</div>` : '');
    const ctrl = document.createElement('div');
    ctrl.className = 'setting-control';
    const dd = document.createElement('div');
    dd.className = 'setting-dropdown selfhost-option-dropdown';
    const currentVal = value == null ? '' : String(value);
    const options = items.map(([val, txt]) => ({
      value: val == null ? '' : String(val),
      label: String(txt),
    }));
    mountDropdown(dd, options, currentVal, {
      onSelect: (opt) => onChange(opt.value),
    });
    ctrl.appendChild(dd);
    r.appendChild(left);
    r.appendChild(ctrl);
    box.appendChild(r);
  };

  const addToggleRow = (label, desc, checked, onChange) => {
    const r = document.createElement('div');
    r.className = 'setting-row';
    r.style.cssText = 'min-height:36px;';
    const left = document.createElement('div');
    left.innerHTML = `<div class="setting-label" style="font-size:12px;">${esc(label)}</div>`
      + (desc ? `<div class="setting-desc" style="margin:0;font-size:11px;">${esc(desc)}</div>` : '');
    const ctrl = document.createElement('div');
    ctrl.className = 'setting-control';
    const tog = document.createElement('button');
    tog.className = 'setting-toggle' + (checked ? ' on' : '');
    tog.type = 'button';
    tog.addEventListener('click', () => {
      const next = !tog.classList.contains('on');
      tog.classList.toggle('on', next);
      onChange(next);
    });
    ctrl.appendChild(tog);
    r.appendChild(left);
    r.appendChild(ctrl);
    box.appendChild(r);
  };

  const addInputRow = (label, desc, placeholder, value, onSave) => {
    const r = document.createElement('div');
    r.className = 'setting-row';
    r.style.cssText = 'min-height:36px;align-items:flex-start;';
    const left = document.createElement('div');
    left.style.cssText = 'flex:1;padding-right:10px;';
    left.innerHTML = `<div class="setting-label" style="font-size:12px;">${esc(label)}</div>`
      + (desc ? `<div class="setting-desc" style="margin:0;font-size:11px;">${esc(desc)}</div>` : '');
    const ctrl = document.createElement('div');
    ctrl.className = 'setting-control';
    ctrl.style.cssText = 'gap:6px;';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'appearance-font-select';
    inp.placeholder = placeholder || '';
    inp.value = value || '';
    inp.style.cssText = 'min-width:130px;max-width:170px;padding:4px 8px;font-size:11px;';
    const btn = document.createElement('button');
    btn.className = 'setting-btn';
    btn.type = 'button';
    btn.style.cssText = 'padding:4px 10px;font-size:11px;';
    btn.textContent = '应用';
    btn.addEventListener('click', () => onSave(inp.value.trim(), btn));
    ctrl.appendChild(inp);
    ctrl.appendChild(btn);
    r.appendChild(left);
    r.appendChild(ctrl);
    box.appendChild(r);
  };

  const pushBackendCfg = async (patch, restart = false, btn = null) => {
    try {
      if (btn) btn.disabled = true;
      const r = await shFetch(`/api/selfhost/${name}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: patch, restart }),
      });
      if (btn) {
        btn.disabled = false;
        btn.textContent = r && r.ok ? '已保存' : '失败';
        setTimeout(() => { btn.textContent = restart ? '保存并重启' : '应用'; }, 1400);
      }
      if (restart && r && r.ok) {
        invalidateSelfhostCaches();
        initSelfhostSection();
      }
    } catch (e) {
      logCatch('selfhostSettings', e);
      if (btn) { btn.disabled = false; btn.textContent = '失败'; }
    }
  };

  if (name === 'qq') {
    addSelectRow(
      '取链音质偏好',
      '对应 /getMusicPlay 的 quality 参数',
      [['auto', '跟随全局音质'], ['flac', 'FLAC 无损'], ['320', '320kbps MP3'], ['128', '128kbps MP3'], ['m4a', 'M4A']],
      shOpts.playQuality || 'auto',
      (v) => saveSelfhostOption('qq', { playQuality: v }),
    );
    addToggleRow(
      '无版权音质自动降级',
      '高音质无直链时自动沿 flac→320→128 回退',
      shOpts.qualityFallback !== false,
      (v) => saveSelfhostOption('qq', { qualityFallback: v }),
    );
    addSelectRow(
      '每日推荐策略',
      '微信账号建议热门聚合；QQ账号可切个性化日推',
      [['pool', '热门歌单聚合'], ['personal', '官方个性化日推']],
      shOpts.dailyMode || 'pool',
      (v) => saveSelfhostOption('qq', { dailyMode: v }),
    );
    addToggleRow(
      '歌词格式化 (isFormat)',
      '对应 /getLyric?isFormat 参数（换行整理）',
      shOpts.lyricFormat !== false,
      (v) => saveSelfhostOption('qq', { lyricFormat: v }),
    );
    addSelectRow(
      '搜索单页条数 (limit)',
      '对应 /getSearchByKey?limit（上限 60）',
      [['60', '60 首'], ['30', '30 首'], ['20', '20 首'], ['10', '10 首']],
      String(shOpts.searchLimit || 60),
      (v) => saveSelfhostOption('qq', { searchLimit: Number(v) || 60 }),
    );
    addToggleRow(
      '匿名降级模式 (FALLBACK_MODE)',
      '服务端启用：未携带 Cookie 时允许基础接口匿名请求',
      srvCfg.fallbackMode !== false,
      (v) => pushBackendCfg({ fallbackMode: v }, Boolean(st && st.alive && hasSource)),
    );
    addToggleRow(
      '全局兜底 Cookie (USE_GLOBAL_COOKIE)',
      '服务端启用：无显式 Cookie 时使用服务内置全局凭证',
      Boolean(srvCfg.useGlobalCookie),
      (v) => pushBackendCfg({ useGlobalCookie: v }, Boolean(st && st.alive && hasSource)),
    );
  } else if (name === 'kugou') {
    addSelectRow(
      '客户端版本 (platform)',
      '概念版支持签到领 VIP；更改后需重启酷狗服务生效',
      [['lite', '酷狗概念版 (lite)'], ['standard', '手机正式版']],
      srvCfg.platform || 'lite',
      (v) => pushBackendCfg({ platform: v }, Boolean(st && st.alive && hasSource)),
    );
    addSelectRow(
      '每日推荐客户端',
      '对应 /everyday/recommend?platform 参数',
      [['ios', 'iOS 端算法'], ['android', 'Android 端算法']],
      shOpts.dailyPlatform || 'ios',
      (v) => saveSelfhostOption('kugou', { dailyPlatform: v }),
    );
    addInputRow(
      '上游代理 (KUGOU_API_PROXY)',
      '可选 HTTP 代理地址（保存后重启服务生效）',
      'http://127.0.0.1:7890',
      srvCfg.proxy || '',
      (val, btn) => pushBackendCfg({ proxy: val }, Boolean(st && st.alive && hasSource), btn),
    );
  } else if (name === 'netease') {
    addSelectRow(
      '自建取链音质等级 (level)',
      '对应 /song/url/v1?level（支持臻品母带/沉浸环绕）',
      [
        ['auto', '跟随全局音质'],
        ['jymaster', '超清母带 (jymaster)'],
        ['sky', '沉浸环绕声 (sky/c51)'],
        ['jyeffect', '高清环绕声 (jyeffect)'],
        ['hires', 'Hi-Res 无损'],
        ['lossless', 'FLAC 无损'],
        ['exhigh', '极高音质'],
        ['higher', '较高音质'],
        ['standard', '标准音质'],
      ],
      shOpts.playLevel || 'auto',
      (v) => saveSelfhostOption('netease', { playLevel: v }),
    );
    addToggleRow(
      '试听/无版权音质降级',
      '返回 30s 试听链时自动下探兼容音质，避免截断',
      shOpts.levelFallback !== false,
      (v) => saveSelfhostOption('netease', { levelFallback: v }),
    );
    addSelectRow(
      '编码格式 (encodeType)',
      '对应 /song/url/v1?encodeType 参数',
      [['flac', 'FLAC (默认)'], ['aac', 'AAC'], ['mp3', 'MP3']],
      shOpts.encodeType || 'flac',
      (v) => saveSelfhostOption('netease', { encodeType: v }),
    );
    addSelectRow(
      '歌单曲目拉取上限',
      '对应 /playlist/track/all?limit 参数',
      [['200', '200 首'], ['500', '500 首'], ['1000', '1000 首']],
      String(shOpts.playlistLimit || 500),
      (v) => saveSelfhostOption('netease', { playlistLimit: Number(v) || 500 }),
    );
    addInputRow(
      '真实 IP (realIP)',
      '海外或代理环境可填国内 IPv4（如 116.25.146.177）',
      '留空自动',
      shOpts.realIP || '',
      (val, btn) => {
        saveSelfhostOption('netease', { realIP: val });
        btn.textContent = '已保存';
        setTimeout(() => { btn.textContent = '应用'; }, 1200);
      },
    );
    addInputRow(
      '请求代理 (proxy)',
      '可选透传给 Netease API 的代理 URL',
      'http://127.0.0.1:7890',
      shOpts.proxy || '',
      (val, btn) => {
        saveSelfhostOption('netease', { proxy: val });
        btn.textContent = '已保存';
        setTimeout(() => { btn.textContent = '应用'; }, 1200);
      },
    );
  }

  return details;
}

/* 供设置面板显式初始化 */
export function initSelfhostModule() { initSelfhostSection(); }