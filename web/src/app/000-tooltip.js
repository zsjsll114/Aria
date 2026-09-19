/* ============================================================
 * 000-tooltip.js — 全局统一样式 tooltip（黑色圆角矩形 + 文本）
 * ------------------------------------------------------------
 * 无论元素用 data-tooltip 还是原生 title，悬停时统一渲染为
 * 右上角按钮区同款气泡。气泡挂在 <body>（position:fixed），
 * entirely 不随任何父级元素旋转/缩放动画——即使悬停的按钮自身
 * 在旋转（如收藏按钮的 SVG），气泡也不会跟着转。
 * 同时把元素的原生 title 迁移为 data-tooltip 并移除 title，
 * 消除系统「白色矩形」原生 tooltip。
 * ============================================================ */
import { saveSettings } from './180-boot-config.js';
(function () {
  if (document.getElementById('aria-tip')) return;

  /* 注入全局样式（随模块自带的样式，任何页面加载本模块即可生效） */
  var style = document.createElement('style');
  style.textContent = `
    #aria-tip {
      position: fixed;
      z-index: 2147483647;
      transform: translate(-50%, 0);
      background: rgba(0, 0, 0, 0.86);
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      line-height: 1;
      font-family: var(--app-font-family, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif);
      padding: 6px 10px;
      border-radius: 6px;
      white-space: nowrap;
      max-width: 60vw;
      overflow: hidden;
      text-overflow: ellipsis;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
      border: 1px solid rgba(255, 255, 255, 0.10);
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transition: opacity 0.15s ease, visibility 0.15s ease;
    }
    #aria-tip.visible { opacity: 1; visibility: visible; }
  `;
  document.head.appendChild(style);

  var tip = document.createElement('div');
  tip.id = 'aria-tip';
  tip.setAttribute('role', 'tooltip');
  tip.style.display = 'none';
  document.body.appendChild(tip);

  var converted = new WeakSet();

  function getTooltipText(node) {
    if (!node || node.nodeType !== 1) return '';
    /* 表单控件保留原生 title 语义 */
    var tag = node.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION') return '';
    var dt = node.getAttribute('data-tooltip');
    if (dt) return dt.trim();
    var t = node.getAttribute('title');
    if (t && t.trim()) {
      /* 迁移 title → data-tooltip 并移除 title，避免系统白色原生气泡与
         全局气泡叠加；只迁移一次 */
      if (!converted.has(node)) {
        converted.add(node);
        node.setAttribute('data-tooltip', t.trim());
        node.removeAttribute('title');
      }
      return t.trim();
    }
    return '';
  }

  function showAt(el) {
    var text = getTooltipText(el);
    if (!text) { hide(); return; }
    tip.textContent = text;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { hide(); return; }
    var cx = r.left + r.width / 2;

    tip.style.display = 'block';
    /* 定位前需先让布局生效以获得自身尺寸 */
    var tw = tip.offsetWidth;
    var th = tip.offsetHeight;

    var left = cx;
    var top = r.bottom + 8;               /* 默认下方 */
    if (top + th > window.innerHeight - 6) {
      top = r.top - th - 8;               /* 容量不足则移到上方 */
    }
    left = Math.max(tw / 2 + 4, Math.min(window.innerWidth - tw / 2 - 4, left));

    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(top) + 'px';
    tip.classList.add('visible');
    /* 记录本次关联目标，供 mouseout 判断 */
    tip._for = el;
  }

  function hide() {
    tip.classList.remove('visible');
    tip.style.display = 'none';
    tip._for = null;
  }

  /* 事件委托（capture 阶段保证抢先于其它 stopPropagation 逻辑） */
  document.addEventListener('mouseover', function (e) {
    var node = e.target;
    var el = node && node.closest ? node.closest('[data-tooltip],[title]') : null;
    if (!el || el === tip || tip.contains(el)) { hide(); return; }
    showAt(el);
  }, true);

  document.addEventListener('mouseout', function (e) {
    var from = e.target;
    var to = e.relatedTarget;
    if (!from) return;
    /* 仍经由 data-tooltip 祖先，则不隐藏 / 或多级悬停 */
    var next = to && to.closest ? to.closest('[data-tooltip],[title]') : null;
    if (next && next === tip._for) return;
    if (from === tip._for || !(tip._for && tip._for.contains(from))) {
      hide();
    }
  }, true);

  ['click', 'keydown', 'blur'].forEach(function (evt) {
    document.addEventListener(evt, hide, true);
  });
  /* ★ scroll 单独处理：视觉模式（PV/词云/谱线等）的 rAF 连续滚动会每帧触发
     capture 级 hide，tooltip 闪几下后永久消失（鼠标停住后没有 mouseover 再补显示）。
     播器舞台内部的滚动忽略；真实列表滚动仍隐藏。 */
  document.addEventListener('scroll', function (e) {
    var t = e.target;
    if (t && t.nodeType === 1 && t.closest && t.closest('.player-container, .visualizer-stage, .preview-player')) return;
    hide();
  }, true);
  window.addEventListener('resize', hide);

  Aria.__hideAriaTip = hide;
})();

/* ============================================================
 * ★ OOBE：首次打开引导（一次性）。五步：
 *   1) 性能偏好（自动/流畅优先/均衡/画质优先 → aria_perf_pref）
 *   2) 自建服务平台开关（selfhost_prefs 同构写回，扫码仍去设置页）
 *   3) Now Playing 接管（接管其它播放器 → 写 appSettings.nowPlaying + saveSettings）
 *   4) 初始主题色（aria_theme_color + <html> --theme-color 即时生效）
 *   5) 音乐偏好（本地/流媒体/两者 → aria_music_pref）
 * 完成后写 aria_oobe_done，不再弹出；全程 try/catch，任何异常静默。
 * ============================================================ */
(function () {
  try {
    if (localStorage.getItem('aria_oobe_done')) return;
  } catch (e) { return; }
  var OOBE_KEY = 'aria_oobe_done';

  function jsonGet(k, fallback) {
    try { return JSON.parse(localStorage.getItem(k)) || fallback; } catch (e) { return fallback; }
  }
  function jsonSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 静默 */ }
  }

  /* 延迟到首帧与资源之后渲染，避免遮挡启动屏 */
  function schedule() {
    if (document.readyState === 'complete') setTimeout(build, 900);
    else window.addEventListener('load', function () { setTimeout(build, 900); });
  }

  function build() {
    if (document.getElementById('ariaOobeOverlay')) return;
    var style = document.createElement('style');
    style.textContent = `
      #ariaOobeOverlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(6,4,16,.46);backdrop-filter:blur(26px) saturate(160%);-webkit-backdrop-filter:blur(26px) saturate(160%);animation:ariaOobeFade .25s ease}
      @keyframes ariaOobeFade{from{opacity:0}to{opacity:1}}
      .aria-oobe-card{width:min(560px,92vw);background:rgba(26,20,44,.72);backdrop-filter:blur(30px) saturate(180%);-webkit-backdrop-filter:blur(30px) saturate(180%);border:1px solid rgba(255,255,255,.16);border-radius:20px;padding:24px 26px 18px;color:rgba(255,255,255,.93);box-shadow:0 26px 80px rgba(0,0,0,.55);font-family:var(--app-font-family,"PingFang SC","Microsoft YaHei",sans-serif)}
      .aria-oobe-head{display:flex;align-items:center;gap:10px;margin-bottom:4px}
      .aria-oobe-logo{font-size:19px;font-weight:800;color:#fff;letter-spacing:.5px}
      .aria-oobe-sub{font-size:12px;color:rgba(255,255,255,.55);margin-bottom:16px}
      .aria-oobe-step{font-size:11px;color:var(--theme-color,#ffcc33);background:color-mix(in srgb,var(--theme-color,#ffcc33) 14%,transparent);padding:3px 10px;border-radius:20px}
      .aria-oobe-body{min-height:196px}
      .aria-oobe-opt{display:flex;flex-direction:column;gap:8px}
      .aria-oobe-card-item{display:flex;gap:10px;align-items:flex-start;padding:11px 13px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.045);cursor:pointer;transition:border-color .15s,background .15s}
      .aria-oobe-card-item:hover{border-color:rgba(255,255,255,.3);background:rgba(255,255,255,.08)}
      .aria-oobe-card-item.sel{border-color:var(--theme-color,#ffcc33);background:color-mix(in srgb,var(--theme-color,#ffcc33) 12%,transparent)}
      .aria-oobe-radio{width:16px;height:16px;flex:0 0 16px;margin-top:2px;border-radius:50%;border:2px solid rgba(255,255,255,.35);box-sizing:border-box}
      .aria-oobe-card-item.sel .aria-oobe-radio{border-color:var(--theme-color,#ffcc33);background:radial-gradient(circle,var(--theme-color,#ffcc33) 0 45%,transparent 50%)}
      .aria-oobe-title{font-size:14px;font-weight:700;margin-bottom:2px}
      .aria-oobe-desc{font-size:12px;color:rgba(255,255,255,.6);line-height:1.55}
      .aria-oobe-switch{display:flex;gap:12px;margin-top:2px}
      .aria-oobe-toggle{flex:1;text-align:center;padding:12px 10px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.045);cursor:pointer;font-size:13px}
      .aria-oobe-toggle.on{border-color:var(--theme-color,#ffcc33);background:color-mix(in srgb,var(--theme-color,#ffcc33) 14%,transparent)}
      .aria-oobe-scan-row{display:flex;gap:8px;margin-top:14px}
      .aria-oobe-scan-btn{flex:1;padding:10px 8px;border-radius:10px;border:1px solid var(--theme-color,#ffcc33);background:color-mix(in srgb,var(--theme-color,#ffcc33) 12%,transparent);color:#fff;font-size:12px;font-weight:600;cursor:pointer;transition:filter .15s}
      .aria-oobe-scan-btn:hover{filter:brightness(1.2)}
      .aria-oobe-foot{display:flex;align-items:center;justify-content:space-between;margin-top:18px}
      .aria-oobe-dots{display:flex;gap:6px}
      .aria-oobe-dot{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.22);transition:background .2s}
      .aria-oobe-dot.on{background:var(--theme-color,#ffcc33)}
      .aria-oobe-btn{border:0;border-radius:10px;padding:9px 18px;font-size:13px;cursor:pointer;font-weight:600}
      .aria-oobe-btn.ghost{background:transparent;color:rgba(255,255,255,.6)}
      .aria-oobe-btn.ghost:hover{color:#fff}
      .aria-oobe-btn.primary{background:var(--theme-color,#ffcc33);color:#150f04}
    `;
    document.head.appendChild(style);

    var overlay = document.createElement('div');
    overlay.id = 'ariaOobeOverlay';
    overlay.innerHTML = `
      <div class="aria-oobe-card">
        <div class="aria-oobe-head">
          <span class="aria-oobe-step" id="ariaOobeStepTag">步骤 1 / 5</span>
          <span class="aria-oobe-logo" id="ariaOobeTitle">欢迎使用 Aria</span>
        </div>
        <div class="aria-oobe-sub" id="ariaOobeSub">花 30 秒完成个性化设置</div>
        <div class="aria-oobe-body" id="ariaOobeBody"></div>
        <div class="aria-oobe-foot">
          <button class="aria-oobe-btn ghost" id="ariaOobeSkip">跳过引导</button>
          <div class="aria-oobe-dots" id="ariaOobeDots"></div>
          <button class="aria-oobe-btn primary" id="ariaOobeNext">下一步</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    var step = 0;
    var perfPref = 'auto';                                       /* auto|low|balanced|high */
    var shEnabled = jsonGet('selfhost_prefs', null) || { enabled: { kugou: false, qq: false, netease: false }, dailySource: 'netease' };
    var musicPref = 'both';                                      /* local|stream|both */
    var npOn = false, npAuto = true, npUrl = 'http://localhost:9863/api/query';  /* Now Playing 接管 */
    var themeColor = '#ffcc33';                                  /* 初始主题色 */

    var T = {
      0: {
        title: '第一步 · 性能偏好', sub: '按设备情况选择视觉效果档位，随时可在设置里调整',
        render: function (el) {
          el.innerHTML = '<div class="aria-oobe-opt">' + [
            { v: 'auto', t: '自动检测（推荐）', d: '启动时按显卡/帧率自动定档' },
            { v: 'low', t: '流畅优先', d: '关闭毛玻璃/模糊、降低粒子和特效，适合低配或集显' },
            { v: 'balanced', t: '均衡', d: '保留主要视觉特效，兼顾流畅度' },
            { v: 'high', t: '画质优先', d: '开启全部背景特效与运镜细节' }
          ].map(function (o) {
            return '<div class="aria-oobe-card-item" data-v="' + o.v + '" data-role="perf">' +
              '<div class="aria-oobe-radio"></div><div><div class="aria-oobe-title">' + o.t + '</div>' +
              '<div class="aria-oobe-desc">' + o.d + '</div></div></div>';
          }).join('') + '</div>';
          el.querySelectorAll('[data-role="perf"]').forEach(function (it) {
            it.addEventListener('click', function () {
              el.querySelectorAll('[data-role="perf"]').forEach(function (x) { x.classList.remove('sel'); });
              it.classList.add('sel'); perfPref = it.dataset.v;
            });
          });
          var d = el.querySelector('[data-v="' + perfPref + '"]'); if (d) d.classList.add('sel');
        }
      },
      1: {
        title: '第二步 · 自建音乐服务', sub: '启用后扫码登录即可享受高音质与完整歌单',
        render: function (el) {
          var defs = { kugou: '酷狗', qq: 'QQ 音乐', netease: '网易云' };
          el.innerHTML = '<div class="aria-oobe-switch">' + Object.keys(defs).map(function (k) {
            return '<div class="aria-oobe-toggle" data-role="sh" data-k="' + k + '"><div class="aria-oobe-title">' + defs[k] + '</div><div class="aria-oobe-desc" style="font-size:11px">' + (shEnabled.enabled[k] ? '已启用' : '未启用') + '</div></div>';
          }).join('') + '</div>' +
            '<div class="aria-oobe-scan-row">' + Object.keys(defs).map(function (k) {
              return '<button class="aria-oobe-scan-btn" data-role="scan" data-k="' + k + '">扫码登录 ' + defs[k] + '</button>';
            }).join('') + '</div>' +
            '<div class="aria-oobe-desc" style="margin-top:12px;font-size:11px">未启用/未登录的平台播放时自动走免费源。</div>';
          el.querySelectorAll('[data-role="sh"]').forEach(function (it) {
            var k = it.dataset.k;
            if (shEnabled.enabled[k]) it.classList.add('on');
            it.addEventListener('click', function () {
              shEnabled.enabled[k] = !shEnabled.enabled[k];
              it.classList.toggle('on', shEnabled.enabled[k]);
              it.querySelector('.aria-oobe-desc').textContent = shEnabled.enabled[k] ? '已启用' : '未启用';
            });
          });
          el.querySelectorAll('[data-role="scan"]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              shEnabled.enabled[btn.dataset.k] = true;
              try { jsonSet('selfhost_prefs', shEnabled); } catch (e) { /* 静默 */ }
              doScan(btn.dataset.k);
            });
          });
        }
      },
      2: {
        title: '第三步 · 接管外部播放器', sub: '连上本机 now-playing 服务，让 Aria 跟播其它软件正在播放的歌（可跳过，事后在设置里配）',
        render: function (el) {
          var np = (typeof appSettings !== 'undefined' && appSettings && appSettings.nowPlaying) ? appSettings.nowPlaying : {};
          npOn = !!np.enabled; npAuto = np.autoFollow !== false; npUrl = np.url || 'http://localhost:9863/api/query';
          el.innerHTML =
            '<div class="aria-oobe-toggle' + (npOn ? ' on' : '') + '" data-role="npOn">' +
            '<div class="aria-oobe-title">启用 Now Playing 接管</div>' +
            '<div class="aria-oobe-desc" style="font-size:11px">' + (npOn ? '已启用' : '未启用') + '</div></div>' +
            '<div style="margin-top:10px"><div class="aria-oobe-desc" style="font-size:11px;margin-bottom:4px">now-playing-service 服务地址</div>' +
            '<input type="text" id="ariaNpUrl" value="' + npUrl + '" autocomplete="off" style="width:100%;box-sizing:border-box;padding:9px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#fff;font-size:12px;outline:none;font-family:inherit"></div>' +
            '<div class="aria-oobe-toggle' + (npAuto ? ' on' : '') + '" data-role="npAuto" style="margin-top:8px">' +
            '<div class="aria-oobe-title">自动跟播</div>' +
            '<div class="aria-oobe-desc" style="font-size:11px">检测到其它软件切歌后，Aria 自动播同一首</div></div>';
          el.querySelectorAll('[data-role="npOn"], [data-role="npAuto"]').forEach(function (it) {
            it.addEventListener('click', function () {
              it.classList.toggle('on');
              if (it.dataset.role === 'npOn') npOn = it.classList.contains('on');
              else npAuto = it.classList.contains('on');
            });
          });
          var inp = el.querySelector('#ariaNpUrl');
          inp.addEventListener('input', function () { npUrl = inp.value; });
        }
      },
      3: {
        title: '第四步 · 初始主题色', sub: '主界面与歌词高亮主色，随时可在设置里改',
        render: function (el) {
          var colors = ['#ffcc33', '#ff5f57', '#4cd964', '#3fa9f5', '#b57eea', '#ff8fab'];
          el.innerHTML = '<div style="display:flex;flex-wrap:wrap;gap:12px">' + colors.map(function (c) {
            return '<div class="aria-oobe-colorchip" data-c="' + c + '" style="width:46px;height:46px;border-radius:12px;background:' + c + ';cursor:pointer;border:3px solid transparent;box-sizing:border-box"></div>';
          }).join('') + '</div>';
          var chips = el.querySelectorAll('[data-c]');
          chips.forEach(function (ch) {
            ch.addEventListener('click', function () {
              chips.forEach(function (x) { x.classList.remove('sel'); x.style.borderColor = 'transparent'; });
              ch.classList.add('sel'); ch.style.borderColor = '#fff'; themeColor = ch.dataset.c;
            });
          });
          var cur = el.querySelector('[data-c="' + (themeColor || '#ffcc33') + '"]');
          if (cur) { cur.classList.add('sel'); cur.style.borderColor = '#fff'; }
        }
      },
      4: {
        title: '第五步 · 音乐偏好', sub: '决定默认播放的内容方向，随时可改',
        render: function (el) {
          el.innerHTML = '<div class="aria-oobe-opt">' + [
            { v: 'local', t: '本地音乐', d: '优先浏览和播放本地文件' },
            { v: 'stream', t: '流媒体', d: '默认使用在线搜索/歌单播放' },
            { v: 'both', t: '两者都要', d: '本地与在线资源都可以' }
          ].map(function (o) {
            return '<div class="aria-oobe-card-item" data-v="' + o.v + '" data-role="mp">' +
              '<div class="aria-oobe-radio"></div><div><div class="aria-oobe-title">' + o.t + '</div>' +
              '<div class="aria-oobe-desc">' + o.d + '</div></div></div>';
          }).join('') + '</div>';
          el.querySelectorAll('[data-role="mp"]').forEach(function (it) {
            it.addEventListener('click', function () {
              el.querySelectorAll('[data-role="mp"]').forEach(function (x) { x.classList.remove('sel'); });
              it.classList.add('sel'); musicPref = it.dataset.v;
            });
          });
          var d = el.querySelector('[data-v="' + musicPref + '"]'); if (d) d.classList.add('sel');
        }
      }
    };

    /* 扫码登录：隐藏 OOBE（z 远高于扫码弹窗），拉起复用弹窗，关闭后恢复 */
    function doScan(platform) {
      if (!overlay || !overlay.parentNode) return;
      if (typeof window.openSelfHostLogin !== 'function') return;
      overlay.style.display = 'none';
      try {
        window.openSelfHostLogin(platform);
      } catch (e) { /* 静默 */ }
      /* ★ 修复"二维码窗口弹不出来"：原先 600ms 定时器在取码网络返回前就判定
         "扫码弹窗未打开" → 立刻把 OOBE 显示回来，而 OOBE z-index 高达 21 亿、
         扫码弹窗仅 10000，二维码其实在后面打开了却彻底被 OOBE 盖住。
         现改为：等扫码弹窗「真正打开过」且「又被关闭」才恢复 OOBE。 */
      var qrOpened = false;
      var elapsed = 0;
      var timer = setInterval(function () {
        elapsed += 400;
        var qr = document.getElementById('selfhostQrOverlay');
        var vis = !!(qr && qr.isConnected && qr.classList.contains('visible'));
        if (vis) qrOpened = true;
        var closed = !qr || !qr.isConnected || !qr.classList.contains('visible');
        if (qrOpened && closed) {
          clearInterval(timer);
          if (overlay.parentNode) { overlay.style.display = ''; }
        } else if (!qrOpened && elapsed >= 15000) {
          /* 逃生兜底：扫码弹窗一直没出现（异常情况）时恢复 OOBE，避免卡隐藏 */
          clearInterval(timer);
          if (overlay.parentNode) { overlay.style.display = ''; }
        }
      }, 400);
    }

    function renderDots() {
      var n = Object.keys(T).length;
      var box = document.getElementById('ariaOobeDots');
      var arr = [];
      for (var i = 0; i < n; i++) { arr.push(i); }
      box.innerHTML = arr.map(function (i) {
        return '<span class="aria-oobe-dot' + (i === step ? ' on' : '') + '"></span>';
      }).join('');
      document.getElementById('ariaOobeStepTag').textContent = '步骤 ' + (step + 1) + ' / ' + n;
      document.getElementById('ariaOobeTitle').textContent = T[step].title;
      document.getElementById('ariaOobeSub').textContent = T[step].sub;
      document.getElementById('ariaOobeNext').textContent = step === n - 1 ? '完成' : '下一步';
    }

    function render() {
      var body = document.getElementById('ariaOobeBody');
      body.innerHTML = '';
      T[step].render(body);
      renderDots();
    }

    document.getElementById('ariaOobeNext').addEventListener('click', function () {
      var last = Object.keys(T).length - 1;
      if (step < last) { step++; render(); }
      else finish();
    });
    document.getElementById('ariaOobeSkip').addEventListener('click', finish);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) { finish(); } });

    function finish() {
      try {
        localStorage.setItem('aria_perf_pref', perfPref);
        localStorage.setItem('aria_music_pref', musicPref);
        jsonSet('selfhost_prefs', shEnabled);
        /* ★ 第三步 Now Playing 接管配置写回 appSettings 并持久化（与设置页同路径） */
        if (typeof appSettings !== 'undefined' && appSettings && appSettings.nowPlaying) {
          appSettings.nowPlaying.enabled = npOn;
          appSettings.nowPlaying.autoFollow = npAuto;
          appSettings.nowPlaying.url = (typeof npUrl === 'string' ? npUrl.trim() : '') || 'http://localhost:9863/api/query';
          try { saveSettings(); } catch (e) { /* 静默 */ }
        }
        /* ★ 第四步初始主题色：写 localStorage 并即时生效到 <html> */
        if (themeColor) {
          if (localStorage.getItem('aria_theme_color') !== themeColor) {
            localStorage.setItem('aria_theme_color', themeColor);
            document.documentElement.style.setProperty('--theme-color', themeColor);
          }
        }
        /* 立即生效尝试：性能档（若有全局应用口子则调用，否则仅持久化） */
        if (perfPref !== 'auto' && Aria.__applyPerfTier) {
          try { Aria.__applyPerfTier(perfPref); } catch (e) { /* 静默 */ }
        }
      } catch (e) { /* 静默 */ }
      try { localStorage.setItem(OOBE_KEY, '1'); } catch (e) { /* 静默 */ }
      if (overlay.parentNode) overlay.remove();
      if (document.getElementById('welcomeOverlay')) {
        document.getElementById('welcomeOverlay').classList.add('hidden');
      }
    }

    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedule);
  } else {
    schedule();
  }
})();