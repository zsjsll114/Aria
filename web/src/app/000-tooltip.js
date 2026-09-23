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

  function getTooltipText(node) {
    if (!node || node.nodeType !== 1) return '';
    /* 表单控件保留原生 title 语义 */
    var tag = node.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION') return '';
    var dt = node.getAttribute('data-tooltip');
    if (dt) return dt.trim();
    var t = node.getAttribute('title');
    if (t && t.trim()) {
      /* 彻底迁移 title → data-tooltip 并移除 title，防止后续代码重写 title 导致原生灰框白底气泡与黑色气泡重叠 */
      node.setAttribute('data-tooltip', t.trim());
      node.removeAttribute('title');
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
  var OOBE_KEY = 'aria_oobe_done';
  /* ★ 修复（2026-09-23）：原先在 IIFE 顶层读到 aria_oobe_done 就整体 return，
     导致 window.showAriaOobe 永远不会被定义——完成过引导的用户点
     「重新运行初始设置」按钮静默无效。守卫移入 schedule()（只管自动弹出），
     全局入口无条件暴露。 */
  var _done = false;
  try {
    _done = !!localStorage.getItem(OOBE_KEY);
  } catch (e) { _done = true; }

  function jsonGet(k, fallback) {
    try { return JSON.parse(localStorage.getItem(k)) || fallback; } catch (e) { return fallback; }
  }
  function jsonSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 静默 */ }
  }

  /* 延迟到首帧与资源之后渲染，避免遮挡启动屏；已完成过引导则不自动弹出 */
  function schedule() {
    if (_done) return;
    if (document.readyState === 'complete') setTimeout(build, 900);
    else window.addEventListener('load', function () { setTimeout(build, 900); });
  }

  function build() {
    if (document.getElementById('ariaOobeOverlay')) return;
    var style = document.createElement('style');
    style.textContent = `
      #ariaOobeOverlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.62);backdrop-filter:blur(36px) saturate(180%);-webkit-backdrop-filter:blur(36px) saturate(180%);animation:ariaOobeFade .35s cubic-bezier(0.1,0.9,0.2,1)}
      @keyframes ariaOobeFade{from{opacity:0}to{opacity:1}}
      @keyframes ariaOobePop{from{opacity:0;transform:scale(0.96) translateY(16px)}to{opacity:1;transform:scale(1) translateY(0)}}
      @keyframes ariaOobeSlideRight{from{opacity:0;transform:translateX(24px)}to{opacity:1;transform:translateX(0)}}
      @keyframes ariaOobeSlideLeft{from{opacity:0;transform:translateX(-24px)}to{opacity:1;transform:translateX(0)}}
      
      /* Win11 风格双栏大卡片 (Mica / Fluent Acrylic 质感) */
      .aria-oobe-card.win11-oobe{
        width:min(800px,94vw);
        min-height:480px;
        background:rgba(26,29,38,.92);
        backdrop-filter:blur(40px) saturate(190%);
        -webkit-backdrop-filter:blur(40px) saturate(190%);
        border:1px solid rgba(255,255,255,.16);
        border-radius:20px;
        padding:32px 36px 24px;
        color:rgba(255,255,255,.94);
        box-shadow:0 32px 80px rgba(0,0,0,.55), 0 2px 6px rgba(0,0,0,.25), inset 0 1px 0 rgba(255,255,255,.15);
        font-family:var(--app-font-family,"Segoe UI Variable Text","Segoe UI","PingFang SC","Microsoft YaHei",sans-serif);
        animation:ariaOobePop .4s cubic-bezier(0.1,0.9,0.2,1);
        display:flex;
        flex-direction:column;
        box-sizing:border-box;
      }
      
      .aria-oobe-layout{display:flex;gap:36px;flex:1;min-height:350px}
      
      /* 左侧 Win11 风格 Hero 专栏 */
      .aria-oobe-hero{width:240px;flex-shrink:0;display:flex;flex-direction:column}
      .aria-oobe-app-badge{display:flex;align-items:center;gap:10px;margin-bottom:18px}
      .aria-oobe-app-icon{
        width:34px;height:34px;display:flex;align-items:center;justify-content:center;
        border-radius:10px;
        background:linear-gradient(135deg,var(--theme-color,#ffcc33) 0%,#ff5f57 100%);
        color:#111;box-shadow:0 6px 18px color-mix(in srgb,var(--theme-color,#ffcc33) 35%,transparent);
      }
      .aria-oobe-app-name{font-size:16px;font-weight:800;color:#fff;letter-spacing:.4px}
      .aria-oobe-step-tag{
        font-size:12px;font-weight:600;color:var(--theme-color,#ffcc33);
        margin-bottom:8px;letter-spacing:.3px;
      }
      .aria-oobe-hero-title{font-size:22px;font-weight:700;line-height:1.3;margin:0 0 12px;color:#fff;letter-spacing:-.2px}
      .aria-oobe-hero-sub{font-size:12.5px;color:rgba(255,255,255,.65);line-height:1.6;margin:0 0 20px;flex:1}
      
      /* Win11 胶囊式平滑进度槽 */
      .aria-oobe-progress-track{width:100%;height:4px;background:rgba(255,255,255,.12);border-radius:2px;overflow:hidden;margin-top:auto}
      .aria-oobe-progress-fill{height:100%;background:var(--theme-color,#ffcc33);border-radius:2px;transition:width .35s cubic-bezier(0.1,0.9,0.2,1)}
      
      /* 右侧内容区 (Fluent 选项卡与平滑横向转场) */
      .aria-oobe-content{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center}
      .aria-oobe-body{display:flex;flex-direction:column;gap:10px}
      .aria-oobe-body.slide-right{animation:ariaOobeSlideRight .3s cubic-bezier(0.1,0.9,0.2,1)}
      .aria-oobe-body.slide-left{animation:ariaOobeSlideLeft .3s cubic-bezier(0.1,0.9,0.2,1)}
      
      .aria-oobe-opt{display:flex;flex-direction:column;gap:10px}
      
      /* Win11 Fluent 风格交互卡片项 */
      .aria-oobe-card-item{
        display:flex;gap:14px;align-items:center;padding:14px 18px;border-radius:12px;
        border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.04);
        cursor:pointer;transition:border-color .2s,background .2s,transform .2s cubic-bezier(0.1,0.9,0.2,1);
      }
      .aria-oobe-card-item:hover{
        border-color:rgba(255,255,255,.26);background:rgba(255,255,255,.08);
        transform:translateY(-2px);
      }
      .aria-oobe-card-item.sel{
        border-color:var(--theme-color,#ffcc33);
        background:color-mix(in srgb,var(--theme-color,#ffcc33) 14%,rgba(255,255,255,.04));
        box-shadow:0 4px 16px color-mix(in srgb,var(--theme-color,#ffcc33) 12%,transparent);
      }
      .aria-oobe-radio{
        width:18px;height:18px;flex:0 0 18px;border-radius:50%;
        border:2px solid rgba(255,255,255,.35);box-sizing:border-box;transition:all .2s cubic-bezier(0.1,0.9,0.2,1);
      }
      .aria-oobe-card-item.sel .aria-oobe-radio{
        border-color:var(--theme-color,#ffcc33);
        background:radial-gradient(circle,var(--theme-color,#ffcc33) 0 45%,transparent 50%);
        transform:scale(1.05);
      }
      .aria-oobe-title{font-size:14px;font-weight:600;margin-bottom:3px;color:#fff}
      .aria-oobe-desc{font-size:12px;color:rgba(255,255,255,.62);line-height:1.5}
      
      .aria-oobe-switch{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:14px}
      .aria-oobe-toggle{
        text-align:center;padding:16px 10px;border-radius:12px;border:1px solid rgba(255,255,255,.10);
        background:rgba(255,255,255,.04);cursor:pointer;font-size:13px;transition:all .2s;
      }
      .aria-oobe-toggle:hover{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.24);transform:translateY(-1px)}
      .aria-oobe-toggle.on{border-color:var(--theme-color,#ffcc33);background:color-mix(in srgb,var(--theme-color,#ffcc33) 14%,transparent);box-shadow:0 4px 14px color-mix(in srgb,var(--theme-color,#ffcc33) 15%,transparent)}
      
      .aria-oobe-scan-row{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
      .aria-oobe-scan-btn{
        padding:10px 8px;border-radius:10px;border:1px solid rgba(255,255,255,.15);
        background:rgba(255,255,255,.06);color:#fff;font-size:12px;font-weight:600;
        cursor:pointer;transition:all .2s cubic-bezier(0.1,0.9,0.2,1);
      }
      .aria-oobe-scan-btn:hover{
        border-color:var(--theme-color,#ffcc33);
        background:color-mix(in srgb,var(--theme-color,#ffcc33) 16%,transparent);
        transform:translateY(-1px);
      }
      
      /* Win11 底部操作栏 */
      .aria-oobe-foot{display:flex;align-items:center;justify-content:space-between;margin-top:28px;padding-top:18px;border-top:1px solid rgba(255,255,255,.08)}
      .aria-oobe-foot-left{display:flex;align-items:center;gap:10px}
      .aria-oobe-foot-right{display:flex;align-items:center;gap:12px}
      
      .aria-oobe-dots{display:flex;align-items:center;gap:6px}
      .aria-oobe-dot{width:6px;height:6px;border-radius:3px;background:rgba(255,255,255,.22);transition:all .3s cubic-bezier(0.1,0.9,0.2,1)}
      .aria-oobe-dot.on{width:20px;background:var(--theme-color,#ffcc33);box-shadow:0 0 8px color-mix(in srgb,var(--theme-color,#ffcc33) 40%,transparent)}
      
      .aria-oobe-btn{border:0;border-radius:8px;padding:9px 24px;font-size:13.5px;cursor:pointer;font-weight:600;transition:all .2s cubic-bezier(0.1,0.9,0.2,1)}
      .aria-oobe-btn.ghost{background:transparent;color:rgba(255,255,255,.65)}
      .aria-oobe-btn.ghost:hover{color:#fff;background:rgba(255,255,255,.08)}
      .aria-oobe-btn.primary{
        background:var(--theme-color,#ffcc33);color:#150f04;
        box-shadow:0 4px 14px color-mix(in srgb,var(--theme-color,#ffcc33) 35%,transparent);
      }
      .aria-oobe-btn.primary:hover{filter:brightness(1.1);transform:scale(1.02)}
      .aria-oobe-btn.primary:active{transform:scale(0.98)}
    `;
    document.head.appendChild(style);

    var overlay = document.createElement('div');
    overlay.id = 'ariaOobeOverlay';
    overlay.innerHTML = `
      <div class="aria-oobe-card win11-oobe">
        <div class="aria-oobe-layout">
          <div class="aria-oobe-hero">
            <div class="aria-oobe-app-badge">
              <div class="aria-oobe-app-icon">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
              </div>
              <span class="aria-oobe-app-name">Aria</span>
            </div>
            <div class="aria-oobe-step-tag" id="ariaOobeStepTag">步骤 1 / 4</div>
            <h2 class="aria-oobe-hero-title" id="ariaOobeTitle">视觉模式偏好</h2>
            <p class="aria-oobe-hero-sub" id="ariaOobeSub">按步骤选择偏好设置，可随时在设置面板更改</p>
            <div class="aria-oobe-progress-track">
              <div class="aria-oobe-progress-fill" id="ariaOobeProgressFill" style="width:25%"></div>
            </div>
          </div>
          <div class="aria-oobe-content">
            <div class="aria-oobe-body" id="ariaOobeBody"></div>
          </div>
        </div>
        <div class="aria-oobe-foot">
          <div class="aria-oobe-foot-left">
            <button class="aria-oobe-btn ghost" id="ariaOobeBack" style="display:none">上一步</button>
            <button class="aria-oobe-btn ghost" id="ariaOobeSkip">跳过引导</button>
          </div>
          <div class="aria-oobe-dots" id="ariaOobeDots"></div>
          <div class="aria-oobe-foot-right">
            <button class="aria-oobe-btn primary" id="ariaOobeNext">下一步</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    var step = 0;
    var lastStep = 0;
    var langPref = (typeof localStorage !== 'undefined' && localStorage.getItem('aria_language')) || 'zh-CN';
    var perfPref = 'auto';                                       /* auto|low|balanced|high */
    var qualityPref = 'lossless';                                /* lossless|exhigh|standard */
    var emotionGlowPref = true;                                  /* AI 情感词高亮与微光 */
    var shEnabled = jsonGet('selfhost_prefs', null) || { enabled: { kugou: false, qq: false, netease: false }, dailySource: 'netease' };
    var themeColor = '#ffcc33';                                  /* 初始主题色 */

    var T = {
      0: {
        title: '界面语言 · Language', sub: '选择界面显示语言，可随时在设置中更改',
        render: function (el) {
          el.innerHTML = '<div class="aria-oobe-opt">' + [
            { v: 'zh-CN', t: '简体中文 (Simplified Chinese)', d: '默认语言，界面文案与排版完全本地化' },
            { v: 'en-US', t: 'English (United States)', d: 'Full English interface' }
          ].map(function (o) {
            return '<div class="aria-oobe-card-item" data-v="' + o.v + '" data-role="lang">' +
              '<div class="aria-oobe-radio"></div><div><div class="aria-oobe-title">' + o.t + '</div>' +
              '<div class="aria-oobe-desc">' + o.d + '</div></div></div>';
          }).join('') + '</div>';

          el.querySelectorAll('[data-role="lang"]').forEach(function (it) {
            it.addEventListener('click', function () {
              el.querySelectorAll('[data-role="lang"]').forEach(function (x) { x.classList.remove('sel'); });
              it.classList.add('sel');
              langPref = it.dataset.v;
              if (typeof globalThis.AriaI18n !== 'undefined' && typeof globalThis.AriaI18n.setLanguage === 'function') {
                globalThis.AriaI18n.setLanguage(langPref);
              }
            });
          });
          var d = el.querySelector('[data-v="' + langPref + '"]'); if (d) d.classList.add('sel');
        }
      },
      1: {
        title: '设备与渲染性能', sub: '按硬件配置选择画质档位；虚拟机或核显建议选流畅优先',
        render: function (el) {
          el.innerHTML = '<div class="aria-oobe-opt">' + [
            { v: 'auto', t: '自动检测（推荐）', d: '按显卡与帧率自动匹配渲染档位' },
            { v: 'balanced', t: '均衡表现', d: '保留主要动效，帧率与画质兼顾' },
            { v: 'high', t: '极致画质', d: '开启全部光效、毛玻璃与运镜细节' },
            { v: 'low', t: '流畅优先（虚拟机/核显推荐）', d: '预烘焙模糊背景，停用复杂滤镜' }
          ].map(function (o) {
            return '<div class="aria-oobe-card-item" data-v="' + o.v + '" data-role="perf">' +
              '<div class="aria-oobe-radio"></div><div><div class="aria-oobe-title">' + o.t + '</div>' +
              '<div class="aria-oobe-desc">' + o.d + '</div></div></div>';
          }).join('') +
          '<div style="margin-top:4px;padding:12px 18px;border-radius:12px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.10);display:flex;align-items:center;justify-content:space-between;cursor:pointer;" id="ariaOobeEmWordToggle">' +
            '<div><div class="aria-oobe-title" style="font-size:13.5px">AI 情绪与情感词上色</div><div class="aria-oobe-desc">为歌词关键词着色并加发光效果</div></div>' +
            '<div class="aria-oobe-radio" id="ariaOobeEmRadio" style="margin-top:0"></div>' +
          '</div></div>';

          el.querySelectorAll('[data-role="perf"]').forEach(function (it) {
            it.addEventListener('click', function () {
              el.querySelectorAll('[data-role="perf"]').forEach(function (x) { x.classList.remove('sel'); });
              it.classList.add('sel'); perfPref = it.dataset.v;
            });
          });
          var d = el.querySelector('[data-v="' + perfPref + '"]'); if (d) d.classList.add('sel');

          var emTog = el.querySelector('#ariaOobeEmWordToggle');
          var emRadio = el.querySelector('#ariaOobeEmRadio');
          var updateEm = function () {
            if (emotionGlowPref) {
              emRadio.style.borderColor = 'var(--theme-color,#ffcc33)';
              emRadio.style.background = 'radial-gradient(circle,var(--theme-color,#ffcc33) 0 45%,transparent 50%)';
            } else {
              emRadio.style.borderColor = 'rgba(255,255,255,.35)';
              emRadio.style.background = 'transparent';
            }
          };
          updateEm();
          emTog.addEventListener('click', function () {
            emotionGlowPref = !emotionGlowPref;
            updateEm();
          });
        }
      },
      2: {
        title: '音质偏好与主题色', sub: '选择默认播放音质与界面主题色',
        render: function (el) {
          var colors = [
            { c: '#ffcc33', n: '曜石金' },
            { c: '#ff5f57', n: '珊瑚红' },
            { c: '#4cd964', n: '极光绿' },
            { c: '#3fa9f5', n: '晴空蓝' },
            { c: '#b57eea', n: '梦幻紫' },
            { c: '#ff7597', n: '霓虹粉' }
          ];
          var qOpts = [
            { v: 'lossless', t: '无损品质 (FLAC / Lossless)', d: '优先获取无损 FLAC 音质' },
            { v: 'exhigh', t: '极高音质 (320kbps)', d: '品质与加载速度兼顾' },
            { v: 'standard', t: '标准音质 (128kbps)', d: '轻量省流，弱网秒开' }
          ];

          el.innerHTML = '<div style="margin-bottom:14px;font-size:12px;font-weight:600;color:rgba(255,255,255,.75)">默认播放音质</div>' +
            '<div class="aria-oobe-opt" style="gap:8px;margin-bottom:18px">' + qOpts.map(function (o) {
              return '<div class="aria-oobe-card-item' + (qualityPref === o.v ? ' sel' : '') + '" data-v="' + o.v + '" data-role="quality" style="padding:10px 14px">' +
                '<div class="aria-oobe-radio"></div><div><div class="aria-oobe-title" style="font-size:13.5px">' + o.t + '</div>' +
                '<div class="aria-oobe-desc" style="font-size:11.5px">' + o.d + '</div></div></div>';
            }).join('') + '</div>' +
            '<div style="margin-bottom:10px;font-size:12px;font-weight:600;color:rgba(255,255,255,.75)">初始主题色</div>' +
            '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">' + colors.map(function (item) {
              var isSel = (themeColor === item.c);
              return '<div class="aria-oobe-colorchip" data-c="' + item.c + '" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid ' + (isSel ? item.c : 'rgba(255,255,255,.10)') + ';cursor:pointer;transition:all .2s">' +
                '<div style="width:20px;height:20px;border-radius:50%;background:' + item.c + ';box-shadow:0 0 10px ' + item.c + '66"></div>' +
                '<span style="font-size:12.5px;font-weight:600;color:#fff">' + item.n + '</span>' +
              '</div>';
            }).join('') + '</div>';

          el.querySelectorAll('[data-role="quality"]').forEach(function (it) {
            it.addEventListener('click', function () {
              el.querySelectorAll('[data-role="quality"]').forEach(function (x) { x.classList.remove('sel'); });
              it.classList.add('sel');
              qualityPref = it.dataset.v;
            });
          });

          var chips = el.querySelectorAll('.aria-oobe-colorchip');
          chips.forEach(function (ch) {
            ch.addEventListener('click', function () {
              themeColor = ch.dataset.c;
              document.documentElement.style.setProperty('--theme-color', themeColor);
              chips.forEach(function (x) {
                x.style.borderColor = (x.dataset.c === themeColor) ? themeColor : 'rgba(255,255,255,.10)';
                x.style.background = (x.dataset.c === themeColor) ? 'rgba(255,255,255,.12)' : 'rgba(255,255,255,.04)';
              });
            });
          });
        }
      },
      3: {
        title: '自建音乐服务', sub: '接入自建音源服务，扫码登录后可使用官方音质与歌单',
        render: function (el) {
          var defs = { netease: '网易云音乐', qq: 'QQ 音乐', kugou: '酷狗音乐' };
          el.innerHTML = '<div class="aria-oobe-switch">' + Object.keys(defs).map(function (k) {
            return '<div class="aria-oobe-toggle' + (shEnabled.enabled[k] ? ' on' : '') + '" data-role="sh" data-k="' + k + '"><div class="aria-oobe-title">' + defs[k] + '</div><div class="aria-oobe-desc" style="font-size:11px">' + (shEnabled.enabled[k] ? '已开启' : '未开启') + '</div></div>';
          }).join('') + '</div>' +
            '<div class="aria-oobe-scan-row">' + Object.keys(defs).map(function (k) {
              return '<button class="aria-oobe-scan-btn" data-role="scan" data-k="' + k + '">扫码登录 ' + defs[k] + '</button>';
            }).join('') + '</div>' +
            '<div class="aria-oobe-desc" style="margin-top:16px;font-size:11.5px;color:rgba(255,255,255,.55)">未启用的音源播放时将自动走多源解析获取。</div>';
          el.querySelectorAll('[data-role="sh"]').forEach(function (it) {
            var k = it.dataset.k;
            it.addEventListener('click', function () {
              shEnabled.enabled[k] = !shEnabled.enabled[k];
              it.classList.toggle('on', shEnabled.enabled[k]);
              it.querySelector('.aria-oobe-desc').textContent = shEnabled.enabled[k] ? '已开启' : '未开启';
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
      }
    };

    /* ★ 扫码登录重构（2026-09-23 修复用户体验核心痛点）：
       绝对不再生硬隐藏 OOBE（overlay.style.display = 'none'）！
       #selfhostQrOverlay 的 z-index 提至 2147483647（最高），
       扫码弹窗直接优雅居中浮现在 OOBE 页面上方，OOBE 稳定作为底层向导。
       扫码完成或关闭弹窗后，扫码弹窗淡出，OOBE 第 4 步服务卡片自动刷新为最新状态！ */
    function doScan(platform) {
      if (typeof window.openSelfHostLogin !== 'function') return;
      try {
        window.openSelfHostLogin(platform);
      } catch (e) { /* 静默 */ }

      /* 观察扫码弹窗，关闭时无缝刷新第 4 步状态 */
      var qr = document.getElementById('selfhostQrOverlay');
      if (qr) {
        var obs = new MutationObserver(function () {
          if (!qr.classList.contains('visible')) {
            obs.disconnect();
            shEnabled = jsonGet('selfhost_prefs', null) || shEnabled;
            if (step === 3) render();
          }
        });
        obs.observe(qr, { attributes: true, attributeFilter: ['class'] });
      }
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
      document.getElementById('ariaOobeProgressFill').style.width = ((step + 1) / n * 100) + '%';
      
      var backBtn = document.getElementById('ariaOobeBack');
      var skipBtn = document.getElementById('ariaOobeSkip');
      if (step > 0) {
        backBtn.style.display = 'inline-block';
        skipBtn.style.display = 'none';
      } else {
        backBtn.style.display = 'none';
        skipBtn.style.display = 'inline-block';
      }
      document.getElementById('ariaOobeNext').textContent = step === n - 1 ? '开始使用' : '下一步';
    }

    function render() {
      var body = document.getElementById('ariaOobeBody');
      body.innerHTML = '';
      body.className = 'aria-oobe-body ' + (step >= lastStep ? 'slide-right' : 'slide-left');
      lastStep = step;
      T[step].render(body);
      renderDots();
    }

    document.getElementById('ariaOobeNext').addEventListener('click', function () {
      var last = Object.keys(T).length - 1;
      if (step < last) { step++; render(); }
      else finish();
    });
    document.getElementById('ariaOobeBack').addEventListener('click', function () {
      if (step > 0) { step--; render(); }
    });
    document.getElementById('ariaOobeSkip').addEventListener('click', finish);

    overlay.addEventListener("click", function (e) { if (e.target === overlay) { /* 忽略背景点击，防误触跳过 */ } });

    function finish() {
      try {
        localStorage.setItem('aria_perf_pref', perfPref);
        jsonSet('selfhost_prefs', shEnabled);
        /* 音质偏好应用 */
        if (qualityPref && typeof appSettings !== 'undefined' && appSettings) {
          if (!appSettings.quality) appSettings.quality = {};
          appSettings.quality.qqPlayback = (qualityPref === 'lossless') ? 'flac' : (qualityPref === 'exhigh' ? '320' : '128');
          appSettings.quality.neteasePlayback = qualityPref;
          try { saveSettings(); } catch (e) { /* 静默 */ }
        }
        /* AI 情感词上色偏好应用 */
        if (typeof appSettings !== 'undefined' && appSettings && appSettings.lyrics) {
          appSettings.lyrics.emotionWords = emotionGlowPref;
          try { saveSettings(); } catch (e) { /* 静默 */ }
        }
        /* 初始主题色：写 localStorage 并即时生效到 <html> */
        if (themeColor) {
          if (localStorage.getItem('aria_theme_color') !== themeColor) {
            localStorage.setItem('aria_theme_color', themeColor);
            document.documentElement.style.setProperty('--theme-color', themeColor);
          }
        }
        /* 立即生效尝试：性能档 */
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

  /* ★ 全局入口暴露：无论是否已完成过，随时可以通过 window.showAriaOobe(force) 呼出体验 */
  window.showAriaOobe = function (force = true) {
    if (force) {
      try { localStorage.removeItem(OOBE_KEY); } catch (e) { /* 静默 */ }
      _done = false;
    }
    const old = document.getElementById('ariaOobeOverlay');
    if (old) old.remove();
    build();
  };
  if (typeof window.Aria === 'object' && window.Aria) {
    window.Aria.showOobe = window.showAriaOobe;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedule);
  } else {
    schedule();
  }
})();