/**
 * scripts/vendor-loopback-guard.cjs — 把第三方 vendor 的监听强制收到回环地址
 *
 * 背景（AGENTS.md 约束 3 的已知残留）：三个 vendor 是第三方代码，自己
 * `app.listen(port)` 时不传 host、也不读 HOST 环境变量，于是**即使 server.py 没开
 * --lan，它们仍然绑 0.0.0.0**，同网段任何人都能调你的 QQ/酷狗/网易登录态接口。
 *
 * 为什么是 preload 而不是 patches/ 下的 .patch：
 *   补丁要精确的上下文行号，而 `_eval/` 是 clone 出来的第三方仓库，上游一改行号就漂移；
 *   漂移后的 `git apply` 失败如果没被人盯住，就是**静默不生效**——安全修复以这种方式
 *   失效比不修更糟。preload 不依赖行号，且配了外部探针（见 selfhost_service.py 的
 *   probe_vendor_exposed）来证明它到底生效没有。
 *
 * 注入方式：selfhost_service.py 在 spawn 时给 env 加
 *   NODE_OPTIONS="--require <本文件绝对路径>"
 * 只在 ARIA_VENDOR_HOST 未显式指定时生效；显式给了 host 一律尊重，不改。
 */
'use strict';

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const WANT = String(process.env.ARIA_VENDOR_HOST || '127.0.0.1').trim() || '127.0.0.1';
let patchedCount = 0;

function isPortLike(v) {
  return typeof v === 'number' ? Number.isFinite(v)
    : (typeof v === 'string' && /^\d+$/.test(v));
}

/**
 * 只在「给了端口但没给 host」这一种形态上补 host。
 * 其它形态（已有 host 字符串 / options 对象里带 host / unix socket 路径 / IPC handle）
 * 一律原样放行 —— 我们的目标是收口默认值，不是接管别人的绑定决策。
 */
function rewrite(args) {
  const a = Array.from(args);
  if (!a.length) return null;

  // listen(port[, backlog[, cb]]) / listen(port[, cb])
  if (isPortLike(a[0])) {
    const second = a[1];
    const hasHost = typeof second === 'string' && second.length > 0 && second !== '0.0.0.0';
    if (hasHost) return null;                       // 显式 host：尊重
    if (second === '0.0.0.0') a[1] = WANT;          // 显式全绑：也收口（这是本文件存在的理由）
    else a.splice(1, 0, WANT);
    return a;
  }

  // listen(options[, cb]) —— options 里没给 host 才补
  if (a[0] && typeof a[0] === 'object' && !Array.isArray(a[0]) && 'port' in a[0]) {
    const opt = a[0];
    const h = opt.host;
    if (typeof h === 'string' && h && h !== '0.0.0.0') return null;
    a[0] = Object.assign({}, opt, { host: WANT });
    return a;
  }

  return null;
}

function wrap(Ctor, label) {
  const proto = Ctor.prototype;
  const orig = proto.listen;
  if (typeof orig !== 'function' || orig.__ariaLoopbackGuard) return;

  function listen(...args) {
    const next = rewrite(args);
    if (next) {
      patchedCount++;
      try {
        if (process.env.ARIA_VENDOR_GUARD_LOG) {
          process.stderr.write(`[loopback-guard] ${label} -> ${next[0]} @ ${next[1]}\n`);
        }
      } catch (_) { /* 日志开关本身不许影响启动 */ }
      return orig.apply(this, next);
    }
    return orig.apply(this, args);
  }
  listen.__ariaLoopbackGuard = true;
  proto.listen = listen;
}

wrap(http.Server, 'http.Server');
wrap(https.Server, 'https.Server');
/* 少数框架（Koa 之外的 express 变体、ws）直接 net.createServer().listen(port) */
wrap(net.Server, 'net.Server');

/* 让 selfhost_service.py 能确认「preload 真的被这个进程加载了」。
   这只证明加载，不证明绑定成功 —— 绑定与否由 probe_vendor_exposed 黑盒判定。 */
try {
  if (process.env.ARIA_VENDOR_GUARD_MARK) {
    require('node:fs').writeFileSync(process.env.ARIA_VENDOR_GUARD_MARK,
      JSON.stringify({ pid: process.pid, want: WANT, patched: patchedCount, at: Date.now() }));
  }
} catch (_) { /* 标记写失败不影响服务 */ }
