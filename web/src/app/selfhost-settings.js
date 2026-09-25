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
import { kugouTodayStr, updateSelfHostBadge } from './selfhost-runtime.js';
import { esc } from '../utils/formatters.js';
const PLATFORM_LABEL = { kugou: '酷狗音乐', qq: 'QQ音乐', netease: '网易云音乐' };
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

  // 顶部说明
  const tip = document.createElement('div');
  tip.className = 'settings-group-title';
  tip.textContent = '自建服务（本地副进程，需 Node.js）';
  host.appendChild(tip);
  const tipDesc = document.createElement('div');
  tipDesc.className = 'setting-desc';
  tipDesc.style.cssText = 'margin:-2px 0 12px;padding-left:4px;';
  tipDesc.textContent = '登录后日推/收藏/高音质走自建接口；无 VIP 试听链自动回退免费源池。扫码一次长期有效（登录态自动保存）。'
    + '注意：扫码只是「登录」，各平台的启用开关还决定「哪些功能真的走自建」——QQ 的取播放链接也受其开关控制，酷狗目前只有日推/收藏走自建（播放链接仍走公网）。'
    + '酷狗若扫码后仍提示需要验证，可在登录弹窗改用「手机号」短信验证码登录。';
  host.appendChild(tipDesc);

  /* 三平台分栏：Tab 头 + 内容区 */
  const tabWrap = document.createElement('div');
  tabWrap.className = 'settings-group';
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
  /* ★ 首帧立即渲染：不等待 /api/selfhost/status 网络往返，控件立即可交互；
     在线/登录徽标随后异步刷新（后端已预启动时此间隔仅数百毫秒） */
  PLATFORMS.forEach(name => tabBar.appendChild(tabBtn(name, null)));
  host.appendChild(tabBar);
  host.appendChild(bodyWrap);
  showTab(state.active, null);
  getStatus().then(status => {
    if (myId !== _selfhostRenderId) return; // 过期版本，丢弃
    /* 更新三平台「已登录」徽标，并重建当前激活面板的实时状态区 */
    PLATFORMS.forEach(name => {
      const b = tabBar.querySelector(`.setting-btn[data-sname="${name}"]`);
      if (b) {
        const st = status && status[name];
        b.textContent = PLATFORM_LABEL[name] + (st && st.loggedIn ? ' · 已登录' : '');
      }
    });
    if (status) showTab(state.active, status);
    try { updateSelfHostBadge(); } catch (e) { /* ignore */ }
    // ★ 若有副进程尚未就绪，后台拉起中 → 延迟重刷一次
    if (status) {
      const pending = PLATFORMS.some(n => status[n] && status[n].hasSource && !status[n].alive);
      if (pending) setTimeout(() => { if (myId === _selfhostRenderId) initSelfhostSection(); }, 4000);
    }
  }).catch(() => { /* 离线场景保持占位骨架，可交互 */ });
}

/* 当前激活的 Tab（模块级缓存，切换设置页后保留） */
let selfTabActive = 'netease';

function renderTabBody(bodyWrap, name, status) {
  bodyWrap.innerHTML = '';
  /* status === null → 首帧占位（外层已异步刷新）；status === undefined → 点击 tab 主动拉取；
     status 有值 → 直接用传入状态，不重复请求 */
  if (status === null) {
    bodyWrap.appendChild(buildPlatformPanel(name, null, loadPrefs()));
    return;
  }
  if (status) {
    bodyWrap.appendChild(buildPlatformPanel(name, status[name] || null, loadPrefs()));
  } else {
    getStatus().then(s => {
      bodyWrap.appendChild(buildPlatformPanel(name, s ? s[name] : null, loadPrefs()));
    }).catch(() => {
      bodyWrap.appendChild(buildPlatformPanel(name, null, loadPrefs()));
    });
  }
}

function buildPlatformPanel(name, st, prefs) {
  const g = document.createElement('div');
  g.className = 'settings-group';

  const enabled = !!(prefs.enabled && prefs.enabled[name]);
  const alive = !!(st && st.alive);
  const hasSource = !!(st && st.hasSource);
  const loggedIn = !!(st && st.loggedIn);

  // 标题行：图标 + 名称 + 存活状态 + 启用开关
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:8px;';
  const icon = document.createElement('span');
  icon.innerHTML = platformIconImg(name, 18);
  icon.style.cssText = 'opacity:.95;flex:0 0 auto;display:inline-flex;';
  head.appendChild(icon);
  const nameEl = document.createElement('span');
  nameEl.style.cssText = 'font-weight:600;font-size:13px;';
  nameEl.textContent = PLATFORM_LABEL[name];
  head.appendChild(nameEl);
  const dot = document.createElement('span');
  dot.style.cssText = `width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:${
    hasSource ? (alive ? '#4cd964' : '#ff3b30') : '#9a9a9a'};`;
  dot.title = !hasSource ? '源码目录缺失' : (!alive ? '副进程离线' : '本地服务运行中');
  head.appendChild(dot);
  const badge = document.createElement('span');
  badge.className = 'setting-desc';
  badge.style.cssText = 'margin:0;font-size:11px;';
  badge.textContent = !hasSource ? '未安装' : (alive ? '本地运行中' : '离线');
  head.appendChild(badge);
  head.appendChild(Object.assign(document.createElement('div'), { style: 'flex:1;' }));
  const tog = document.createElement('button');
  tog.className = 'setting-toggle' + (enabled ? ' on' : '');
  /* ★ 开关的真实作用域三平台并不一致（详见 selfhost-runtime.js）：
     · QQ     — 日推/收藏 + **取播放链接**（selfhostQQPlayUrl 以此开关为闸门）
     · 网易云 — 日推/收藏/歌单；取播放链接只看副进程是否在线，不受此开关影响
     · 酷狗   — 日推/收藏/签到；**没有**自建取播放链接，播放仍走公网源
     旧文案只写「日推/收藏优先」，于是「扫码登录了却还走在线源」无从解释。 */
  tog.title = {
    qq: '启用 QQ 自建：日推/收藏 + 取播放链接都走本机（关掉则取链接退回在线源池）',
    netease: '启用网易云自建：日推/收藏/歌单走本机（取播放链接只要求副进程在线，不受此开关影响）',
    kugou: '启用酷狗自建：日推/收藏/签到走本机（酷狗暂无自建取播放链接，播放仍走公网源）',
  }[name] || '启用该平台自建';
  tog.addEventListener('click', () => {
    const v = !tog.classList.contains('on');
    tog.classList.toggle('on', v);
    prefs.enabled = prefs.enabled || {}; prefs.enabled[name] = v; savePrefs(prefs);
  });
  head.appendChild(tog);
  g.appendChild(head);

  // 登录状态行
  const row = document.createElement('div');
  row.className = 'setting-row';
  const isOk = alive && loggedIn;
  const stateLabel = loggedIn
    ? `已登录 · uid ${(st && st.uid) || ''}`
    : (alive ? '未登录' : '副进程未就绪');
  row.innerHTML = `<div><div class="setting-label">登录状态</div>
    <div class="setting-desc" style="color:${isOk ? 'var(--theme-color, #3b82f6)' : 'inherit'}">${stateLabel}</div></div>`;
  const ctrl = document.createElement('div');
  ctrl.className = 'setting-control';
  const btn = document.createElement('button');
  btn.className = 'setting-btn' + (loggedIn ? ' danger' : ' primary');
  btn.style.padding = '6px 12px';
  btn.textContent = loggedIn ? '退出登录' : '扫码登录';
  if (!alive) {
    btn.disabled = true;
    btn.style.opacity = '.45';
    btn.style.cursor = 'not-allowed';
    btn.title = hasSource ? '副进程离线，请先启动' : '未安装本地源码';
  }
  btn.addEventListener('click', () => {
    if (loggedIn) {
      shFetch(`/api/selfhost/${name}/logout`, { method: 'POST' }).then(initSelfhostSection).catch(initSelfhostSection);
    } else {
      openLoginModal(name);
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
      if (r && r.ok) initSelfhostSection();
    } catch (e) { ckSave.disabled = false; ckSave.textContent = '✗ 失败'; }
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

  // 说明
  if (!hasSource) {
    const note = document.createElement('div');
    note.style.cssText = 'opacity:.55;font-size:11px;margin-top:-2px;';
    note.textContent = '源码目录缺失，服务无法拉起';
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

/* ==================== 登录弹窗（扫码 / 手机 / 邮箱） ==================== */
async function openLoginModal(platform) {
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
    renderKugouLoginTabs(body, platform);
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

/* ---- 酷狗：扫码 / 手机号（短信验证码） ----
   手机号这条路是后加的：酷狗对 /song/url 的风控会要求「登录确认身份」(v_type=38)，
   扫码在部分账号/风控档位下不足以解锁；手机验证码是官方支持的另一条路
   （issue #206 首帖标注「手机验证码 ✓ 已支持」）。 */
function renderKugouLoginTabs(body, platform) {
  const tabs = ['扫码', '手机号'];
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
      mode = ['qr', 'phone'][i];
      /* 切 tab 时停止上一模式的扫码轮询与倒计时，避免残留请求/定时器 */
      stopPoll();
      clearKgCountdown();
      qrState.keyObj = null;
      renderKugouPanel(wrap, mode, platform);
    });
    tabBar.appendChild(b);
  });
  wrap.appendChild(tabBar);
  renderKugouPanel(wrap, 'qr', platform);
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

  /* 手机号 + 短信验证码 */
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
  hint.textContent = '验证码由酷狗官方短信下发；登录态仅保存在本机';
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

  /* 获取验证码：60 秒倒计时防连点（发短信有频控） */
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
        enablePlatform(platform);   /* ★ 登录即启用（日推/高音质取链的前置开关） */
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
    /* 过期码同样停止轮询（酷狗 status=0 / 网易云 800） */
    if (r && (r.status === 0 || r.status === 800)) {
      stopPoll();
      if (hint) hint.textContent = '二维码已过期，点击右上角关闭后重新扫码';
      return;
    }
    if (hint) hint.textContent = describeStatus(r, qrState.platform);
    /* 递归调度下一轮（间隔 2s；失败重试 3s） */
    if (qrState.platform && qrState.keyObj) {
      qrTimer = setTimeout(loop, r ? 2000 : 3000);
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

/* 供设置面板显式初始化 */
export function initSelfhostModule() { initSelfhostSection(); }