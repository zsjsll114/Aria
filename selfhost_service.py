#!/usr/bin/env python3
"""
selfhost_service.py — 自建音乐服务副进程托管（酷狗 / QQ / 网易云）
====================================================================
每个平台以独立 Node 服务（后端 music API server）以本地副进程运行，
由 server.py 统一代理访问，避免前端直连副进程、统一 CORS 与超时。

设计约束：
  - 仅用标准库，无第三方依赖（与 qq_resolver.py 一致）
  - 副进程异常/未安装依赖时静默降级：status.alive=False，播放层回退免费源池
  - 登录态（token/cookie）只存内存（由前端 localStorage 提供；进程重启后需重新扫码）
  - 网易云官方仓库已被举报下架，其 vendor 源码需用活跃 fork；当前未安置则始终 offline

平台配置：
  kugou    -> MakcRe/KuGouMusicApi   (概念版 lite, 端口 3100)
  qq       -> sansejian/qq-music-api (tsx src/app.ts, 端口 3200)
  netease  -> NeteaseCloudMusicApi   fork (端口 3201, vendor 待安置)
"""
import atexit
import json
import os
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import uuid

# ★ PyInstaller 打包（绿色版）时：EXE 所在目录 == 绿色版根目录（_eval/cache 数据相对它找）
if getattr(sys, 'frozen', False):
    PROJECT_DIR = os.path.dirname(sys.executable)
else:
    PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))

# 启动超时（秒）：等副进程开始监听端口
_START_WAIT = 12
# 代理请求超时（秒）
_PROXY_TIMEOUT = 18


# ==================== 平台元信息 ====================
# 'start': 在该平台 vendor 目录里执行的启动命令（shell 形式，cwd 已设为 vendor 目录）
# 'env': 启动 env 额外变量（覆盖 PORT / platform 等）
# 'qr'/'poll': 本模块内负责「取码」「轮询」的函数名（见登录流程一节）
_SERVICES = {
    'kugou': {
        'label':   '酷狗',
        'port':    3100,
        'dir':     os.path.join(PROJECT_DIR, '_eval', 'KuGouMusicApi'),
        'start':   'node app.js',
        'env':     {'PORT': '3100', 'platform': 'lite'},
        'qr':      '_get_qr_kugou',
        'poll':    '_poll_kugou',
    },
    'qq': {
        'label':   'QQ',
        'port':    3200,
        'dir':     os.path.join(PROJECT_DIR, '_eval', 'qq-music-api-node'),
        'start':   'npx tsx src/app.ts',
        'env':     {'PORT': '3200'},
        'qr':      '_get_qr_qq',
        'poll':    '_poll_qq',
    },
    'netease': {
        'label':   '网易云',
        'port':    3201,
        'dir':     os.path.join(PROJECT_DIR, '_eval', 'NeteaseCloudMusicApi'),
        'start':   'node app.js',
        'env':     {'PORT': '3201'},
        'qr':   '_get_qr_netease',
        'poll': '_poll_netease',
    },
}


# ==================== 运行时状态（进程 + 登录态） ====================
class _Service:
    __slots__ = ('proc', 'alive', 'base', 'cookie', 'tmp', 'uid')

    def __init__(self, base):
        self.proc = None
        self.alive = False
        self.base = base
        self.cookie = ''   # 登录态：'token=..;userid=..'(kugou) / QQ cookie 串 / 网易云 cookie
        self.tmp = ''      # 网易云二维码会话临时 cookie
        self.uid = ''      # 当前登录账号的数字 id（netease userId / qq loginUin / kugou userid）


_STATE = {name: _Service(f'http://127.0.0.1:{cfg["port"]}') for name, cfg in _SERVICES.items()}
_STATE_LOCK = threading.Lock()

# ==================== 登录态持久化 ====================
# 自建登录 cookie/uid 只存内存时，服务重启即失效 → 重启后"自建收藏/歌单"全部获取不到。
# 这里把登录态落盘到 cache/selfhost_login.json，服务重启自动恢复，扫码一次长期可用。
_PERSIST_PATH = os.path.join(PROJECT_DIR, 'cache', 'selfhost_login.json')


# Set-Cookie 属性段在 Cookie 请求头里必须剔除：网易云官方接口收到带
# Max-Age/Expires/Path 的"cookie"直接判定未登录 → /login/status 返回 account/profile 为 null
_SET_COOKIE_ATTRS = {'max-age', 'expires', 'path', 'domain', 'secure', 'httponly', 'samesite', 'priority', 'partitioned'}


def _sanitize_cookie_str(cookie_str):
    """清洗 Cookie 字符串：剔除 Set-Cookie 属性段，只保留真实 'k=v' 对。幂等可重复调用。"""
    if not cookie_str or not isinstance(cookie_str, str):
        return ''
    out = []
    for pair in cookie_str.split(';'):
        pair = pair.strip()
        if not pair or '=' not in pair:
            continue
        k, v = pair.split('=', 1)
        ks = k.strip().lower()
        if ks in _SET_COOKIE_ATTRS or ks == '':
            continue
        vs = v.strip()
        if vs == '' or vs.lower() in ('0', 'expires'):
            continue
        out.append(f'{k.strip()}={vs}')
    return '; '.join(out)


def _persist_login():
    """把当前三平台登录态（cookie/uid）写盘；异常静默。★ 网易云 cookie 先清洗属性段。"""
    try:
        data = {}
        for name, s in _STATE.items():
            cookie = _sanitize_cookie_str(s.cookie) if name == 'netease' else (s.cookie or '')
            data[name] = {'cookie': cookie, 'uid': s.uid or ''}
        os.makedirs(os.path.dirname(_PERSIST_PATH), exist_ok=True)
        with open(_PERSIST_PATH, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False)
    except Exception:
        pass


def _restore_login():
    """启动时从备份恢复登录态到 _STATE（仅恢复 cookie/uid；tmp 会话 cookie 不持久化）。
    ★ 网易云旧数据含 Set-Cookie 属性段（Max-Age/Expires/Path）→ 恢复时清洗迁移。"""
    try:
        with open(_PERSIST_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
        for name, s in _STATE.items():
            d = data.get(name) or {}
            s.cookie = _sanitize_cookie_str(d.get('cookie') or '') if name == 'netease' else (d.get('cookie') or '')
            s.uid = d.get('uid') or ''
    except Exception:
        pass


_restore_login()


def _probe_alive(name):
    """轻量探测副进程端口是否在监听（最多 1s，不拉起进程）"""
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{_SERVICES[name]["port"]}/', timeout=1) as r:
            return r.status in (200, 404)
    except Exception:
        return False


def _ensure_running_async(name):
    """在后台线程中拉起副进程（不阻塞调用者）。"""
    def _worker():
        try:
            ensure_running(name)
        except Exception:
            pass
    t = threading.Thread(target=_worker, args=(), daemon=True)
    t.start()
    return t


def ensure_running(name):
    """确保副进程已启动并监听端口；返回是否成功"""
    cfg = _SERVICES[name]
    if not os.path.isdir(cfg['dir']):
        _STATE[name].alive = False
        return False
    with _STATE_LOCK:
        if _state_is_ok(name):
            return True
        node = _find_node()
        if not node:
            _STATE[name].alive = False
            return False
        env = dict(os.environ)
        env.update(cfg.get('env', {}))
        try:
            _STATE[name].proc = subprocess.Popen(
                cfg['start'], cwd=cfg['dir'], shell=True,
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            )
        except Exception:
            _STATE[name].alive = False
            return False
    # 等待端口监听
    dead = time.time() + _START_WAIT
    while time.time() < dead:
        if _probe_alive(name):
            _STATE[name].alive = True
            return True
        time.sleep(0.4)
    _STATE[name].alive = False
    return False


def shutdown_all():
    """优雅关闭全部自建 vendor 副进程（atexit / server.py /api/shutdown 调用）。

    副进程是 shell=True 起的 cmd 壳再带 node 子进程，必须按「进程树」清理：
    Windows 用 taskkill /T /F，其余平台先 terminate 再 kill。清理后把状态标为
    offline，避免其它线程误以为还活着。"""
    with _STATE_LOCK:
        for name, svc in _STATE.items():
            p = svc.proc
            if p is not None and p.poll() is None:
                try:
                    if os.name == 'nt':
                        subprocess.run(
                            ['taskkill', '/PID', str(p.pid), '/T', '/F'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                        )
                    else:
                        p.terminate()
                        try:
                            p.wait(timeout=2)
                        except Exception:
                            p.kill()
                except Exception:
                    pass
            svc.proc = None
            svc.alive = False


atexit.register(shutdown_all)


def _state_is_ok(name):
    if _STATE[name].alive and _probe_alive(name):
        return True
    return False


def _find_node():
    """绿色版运行时解析：1) ARIA_NODE 环境变量（启动脚本注入） 2) 与 exe 同级的
    runtime/node.exe（便携版携带） 3) PATH 里的 node/node.exe。"""
    import shutil
    aria = (os.environ.get('ARIA_NODE') or '').strip()
    if aria and os.path.isfile(aria):
        return aria
    if aria and shutil.which(aria):
        return shutil.which(aria)
    local = os.path.join(PROJECT_DIR, 'runtime', 'node.exe')
    if os.path.isfile(local):
        return local
    for exe in ('node', 'node.exe'):
        p = shutil.which(exe)
        if p:
            return p
    return None


# ==================== 通用代理 ====================
def proxy_request(name, method, path_and_query, body=None, headers=None):
    """
    向平台副进程转发请求。path_and_query 以 '/' 开头（不含 base）。
    登录态自动注入：kugou 用 query token/userid；qq 用 query cookie；netease 用 Cookie 头。
    返回 (http_status, json_or_raw, raw_bytes)。
    """
    status, parsed, raw, _ = _proxy_raw(name, method, path_and_query, body, headers)
    return (status, parsed, raw)


def _encode_path_ascii(path_and_query):
    """把上游路径里的非法/非 ASCII 字符编码成 %XX，已编码的 %XX 原样保留。

    ★ 为什么必须做：urllib 构造请求行时按 latin-1 编码，路径里带裸中文（如
    `/getSearchByKey?key=罗生门`）会直接抛 UnicodeEncodeError，被 `_proxy_raw`
    的兜底 except 吞掉 → 代理**瞬时返回 502 且响应体为空**（实测 6ms、0 字节）。
    调用方传入的 path 是 `unquote` 过的（server.py 的 proxy 分支），所以这里是
    最后一道必须补齐编码的地方。

    safe 里保留 '%' 是为了不重复编码已有的 %XX（否则 %2F 会变成 %252F）；
    保留 '/?&=:,#[]@!$'()*+;' 是因为这些在 URL path/query 里合法，
    且现有全部调用（getMusicPlay / song/url/v1 / user/playlist …）都用它们，
    编码后与改动前逐字节一致 —— 不改变任何已经在工作的链路。"""
    if not path_and_query:
        return path_and_query or ''
    try:
        return urllib.parse.quote(path_and_query, safe="/?&=:,#[]@!$'()*+;%-._~")
    except Exception:
        return path_and_query


def _proxy_raw(name, method, path_and_query, body=None, headers=None):
    """代理底层：多返回一个 set-cookie 列表（netease 扫码登录用）。"""
    if not ensure_running(name):
        return (502, {'error': f'{_SERVICES[name]["label"]} 副进程未运行'}, b'', [])
    cfg = _SERVICES[name]
    sep = '&' if '?' in path_and_query else '?'
    inject_cookie_header = None
    if name == 'kugou' and _STATE[name].cookie:
        path_and_query = f'{path_and_query}{sep}{urllib.parse.urlencode(_parse_kugou_cookie(_STATE[name].cookie))}'
    elif name == 'qq' and _STATE[name].cookie:
        path_and_query = f'{path_and_query}{sep}cookie={urllib.parse.quote(_STATE[name].cookie)}'
    elif name == 'netease' and _STATE[name].cookie:
        inject_cookie_header = _STATE[name].cookie
        # ★ 带登录态的业务请求也必须携带唯一 _t：vendor apicache(2min) 按 URL 缓存、不含
        #   Cookie 头，登录前缓存下的 /login/status、歌单等响应会被复用 → "扫码成功仍显示未登录"
        sep2 = '&' if '?' in path_and_query else '?'
        path_and_query = f'{path_and_query}{sep2}_t={_now_ms()}'
    url = f'{_STATE[name].base}{_encode_path_ascii(path_and_query)}'
    data = None
    hdrs = {'User-Agent': 'Mozilla/5.0', 'Accept': '*/*', 'Content-Type': 'application/json'}
    if inject_cookie_header:
        hdrs['Cookie'] = inject_cookie_header
    if headers:
        hdrs.update(headers)
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=_PROXY_TIMEOUT) as r:
            raw = r.read()
            setc = r.headers.get_all('Set-Cookie') or []
            try:
                return (r.status, json.loads(raw.decode('utf-8')), raw, setc)
            except Exception:
                return (r.status, raw.decode('utf-8', 'replace'), raw, setc)
    except urllib.error.HTTPError as e:
        try:
            raw = e.read()
            try:
                return (e.code, json.loads(raw.decode('utf-8')), raw, [])
            except Exception:
                return (e.code, raw.decode('utf-8', 'replace'), raw, [])
        except Exception:
            return (e.code, {'error': str(e.code)}, b'', [])
    except Exception as e:
        return (502, {'error': str(e)[:200]}, b'', [])


def _parse_kugou_cookie(cookie):
    """把 kugou 登录态 'token=..;userid=..' 还原为 dict"""
    d = {}
    for kv in cookie.split(';'):
        if '=' in kv:
            k, v = kv.strip().split('=', 1)
            d[k] = v
    return d


# ==================== 登录流程 ====================
def get_login_qr(name, qr_type=None):
    """
    拉取扫码二维码（第一次握手）。
    qr_type: QQ 平台可选，2=QQ App 3=微信 4=QQ音乐 App；其他平台忽略。
    返回前端可直接使用的 dict，其内容原样回传给 poll_login 作为 key。
    """
    handler = globals().get(_SERVICES[name].get('qr') or '')
    if not handler:
        return {'ok': False, 'err': '该平台暂未接入扫码登录'}
    if name == 'qq':
        return handler(name, qr_type=qr_type)
    return handler(name)


def poll_login(name, key):
    """
    轮询扫码结果。key 为 get_login_qr 返回的 dict（原样回传）。
    成功时把登录态写入 _STATE[name].cookie。
    """
    handler = globals().get(_SERVICES[name].get('poll') or '')
    if not handler:
        return {'ok': False, 'loggedIn': False, 'err': '未接入登录'}
    return handler(name, key or {})


def logout(name):
    _STATE[name].cookie = ''
    _STATE[name].tmp = ''
    _STATE[name].uid = ''
    _invalidate_login_state(name)
    _persist_login()
    return {'ok': True}


def set_cookie(name, cookie=''):
    """手动填入 Cookie 登录（绕过扫码）。cookie 字符串按平台语义入库并持久化。"""
    cookie = (cookie or '').strip()
    if not cookie:
        return {'ok': False, 'err': 'Cookie 为空'}
    _STATE[name].cookie = _sanitize_cookie_str(cookie) if name == 'netease' else cookie
    _STATE[name].tmp = ''
    # 尝试回填 uid（收藏/歌单等需要）
    if name == 'kugou':
        _STATE[name].uid = _parse_kugou_cookie(cookie).get('userid', '')
    elif name == 'netease':
        _STATE[name].uid = _fetch_netease_uid(name)
    elif name == 'qq':
        # QQ cookie 通常含 uin/euin；能解析则回填
        import re as _re
        m = _re.search(r'(?:^|;)\s*uin\s*=\s*([^;]+)', cookie)
        _STATE[name].uid = m.group(1).strip() if m else ''
    _invalidate_login_state(name)
    _persist_login()
    if not _STATE[name].uid:
        return {'ok': True, 'loggedIn': True, 'warn': 'Cookie 已保存，但未能解析账号 uid（部分功能可能受限）'}
    return {'ok': True, 'loggedIn': True, 'uid': _STATE[name].uid}


# ---- 酷狗（MakcRe 普通库扫码登录 + 会话 cookie 贯穿） ----
# ★ 两层修复"扫码授权后无反应"：
#   1) vendor(apicache) 把所有 200 GET 响应缓存 2 分钟 → check 恒返回旧的"等待扫码"，
#      授权状态被缓存吞掉；取码也被缓存 → 刷新二维码显示同一张。
#      修复：所有 vendor GET 加毫秒级唯一 _t 参数绕过缓存。
#   2) 取码与 check 贯穿同一会话 cookie（Set-Cookie 保存/回传）。
def _now_ms():
    return int(time.time() * 1000)


def _get_qr_kugou(name):
    # _proxy_raw 以捕获 set-cookie（扫码会话 cookie）；_t 绕过 vendor 缓存
    status, data, _, setc = _proxy_raw(name, 'GET', f'/login/qr/key?_t={_now_ms()}')
    d = (data or {}).get('data') or {}
    qrcode = d.get('qrcode')
    img = d.get('qrcode_img')
    if status >= 400 or not qrcode:
        return {'ok': False, 'err': f'取码失败(status={status})'}
    if setc:
        _STATE[name].tmp = _join_setcookies(setc)  # 扫码会话 cookie 供 check 贯穿
    return {'ok': True, 'platform': 'kugou', 'img': img, 'key': qrcode}


def _poll_kugou(name, key):
    qrcode = key.get('key') or key.get('qrcode')
    if not qrcode:
        return {'ok': False, 'loggedIn': False, 'err': '缺少 qrcode'}
    hdrs = {}
    if _STATE[name].tmp:
        hdrs['Cookie'] = _STATE[name].tmp
    # ★ _t 毫秒级唯一：绕过 vendor apicache（否则 check 结果被缓存 2 分钟，
    #   手机确认登录后轮询仍拿到旧的"等待扫码"，二维码过期前永远检测不到）
    status, data, _, setc = _proxy_raw(name, 'GET',
                                       f'/login/qr/check?key={urllib.parse.quote(str(qrcode))}&_t={_now_ms()}',
                                       headers=hdrs)
    d = (data or {}).get('data') or {}
    if d.get('status') == 4 or (d.get('token') and d.get('userid')):
        # token/userid 可能来自 body 或 Set-Cookie
        toks = {}
        for c in setc or []:
            seg = c.split(';', 1)[0].strip()
            if '=' in seg:
                k_, v_ = seg.split('=', 1)
                toks[k_.strip()] = v_.strip()
        tok = d.get('token') or toks.get('token') or ''
        uid = d.get('userid') or toks.get('userid') or 0
        if tok and uid:
            _STATE[name].cookie = f'token={tok};userid={uid}'
            _STATE[name].uid = str(uid)
            _STATE[name].tmp = ''
            _invalidate_login_state(name)
            _persist_login()
            return {'ok': True, 'loggedIn': True}
        return {'ok': True, 'loggedIn': False}
    # 追加 check 响应可能带出的会话 cookie，供后续轮询保持会话
    if setc:
        merged = _STATE[name].tmp
        seen = set(x.split(';',1)[0].split('=',1)[0].strip() for x in (merged.split(';') if merged else []))
        parts = [x for x in (merged.split(';') if merged else [])]
        for c in setc:
            seg = c.split(';', 1)[0].strip()
            if '=' in seg and seg.split('=',1)[0].strip() not in seen:
                parts.append(seg); seen.add(seg.split('=',1)[0].strip())
        _STATE[name].tmp = '; '.join(parts)
    # 未扫/已过期：统一由前端按 d.status 提示
    return {'ok': True, 'loggedIn': False, 'status': d.get('status')}


# ---- 酷狗手机号登录（短信验证码） ----
# ★ 为什么单独开这条路：酷狗对 /song/url 的风控会返回 v_type=38「要求登录确认身份」
#   （见 issue #206），扫码登录在部分账号/风控档位下不足以解锁，而手机验证码是官方
#   支持的验证方式之一（issue 首帖表格标注「手机验证码 ✓ 已支持」）。
#   vendor 侧两条现成接口（server.js:343 用 app.use 注册，GET/POST 均收）：
#     · module/captcha_sent.js    → /captcha/sent      （params.mobile）
#     · module/login_cellphone.js → /login/cellphone   （mobile + code）
#   成功时 token/userid 由 Set-Cookie 回传，落盘方式与 _poll_kugou 完全一致。

def _kg_err_msg(d, fallback):
    """取酷狗的错误文案。★ 它有时把信息放在 `data` 里且是**字符串**
    （实测 /captcha/sent 空号 → `{"data":"手机格式不正确","status":0,"error_code":20010}`），
    所以不能直接对 d['data'] 当 dict 用。"""
    for k in ('error', 'errmsg'):
        v = d.get(k)
        if isinstance(v, str) and v:
            return v
    v = d.get('data')
    if isinstance(v, str) and v:
        return v
    return fallback


def kugou_send_captcha(name, mobile):
    """发送酷狗登录短信。**只发短信，不建立登录态**。"""
    mobile = str(mobile or '').strip()
    digits = ''.join(ch for ch in mobile if ch.isdigit())
    if len(digits) < 5:
        return {'ok': False, 'err': '手机号格式不对（只填数字，不带 +86）'}
    status, data, _, _ = _proxy_raw(
        name, 'POST',
        f'/captcha/sent?mobile={urllib.parse.quote(mobile)}&_t={_now_ms()}', body={})
    d = data if isinstance(data, dict) else {}
    if d.get('status') == 1 or d.get('error_code') == 0:
        return {'ok': True}
    return {'ok': False,
            'err': _kg_err_msg(
                d, f"发送失败(status={d.get('status')}, error_code={d.get('error_code')})")}


def login_kugou_cellphone(name, mobile, code):
    """手机号 + 短信验证码登录；成功后写入并落盘 token/userid。"""
    mobile = str(mobile or '').strip()
    code = str(code or '').strip()
    if not mobile or not code:
        return {'ok': False, 'err': '请填写手机号与验证码'}
    status, data, _, setc = _proxy_raw(
        name, 'POST',
        f'/login/cellphone?mobile={urllib.parse.quote(mobile)}'
        f'&code={urllib.parse.quote(code)}&_t={_now_ms()}', body={})
    d = data if isinstance(data, dict) else {}
    toks = {}
    for c in setc or []:
        seg = c.split(';', 1)[0].strip()
        if '=' in seg:
            k_, v_ = seg.split('=', 1)
            toks[k_.strip()] = v_.strip()
    # ★ data 可能是字符串（错误信息），必须判类型再取 token
    dd = d.get('data') if isinstance(d.get('data'), dict) else {}
    tok = dd.get('token') or toks.get('token') or ''
    uid = dd.get('userid') or toks.get('userid') or 0
    if d.get('status') == 1 and tok and uid:
        _STATE[name].cookie = f'token={tok};userid={uid}'
        _STATE[name].uid = str(uid)
        _invalidate_login_state(name)
        _persist_login()
        return {'ok': True, 'loggedIn': True, 'uid': str(uid)}
    return {'ok': False,
            'err': _kg_err_msg(
                d, f"登录失败(status={d.get('status')}, error_code={d.get('error_code')})")}


# ---- QQ（走 vendor sansejian/qq-music-api-node，支持 QQ App 扫码 与 微信扫码） ----
# 官方 ptqrlogin 裸接口带参数校验，直连会被 403 拦截；vendor 已封装完整
# OAuth 链（ptqrlogin → checkSig → graph.qq.com/authorize → musicu.fcg），
# 复用其 /user/getQQLoginQr + /user/checkQQLoginQr（QQ App）与
# /user/getWXLoginQr + /user/checkWXLoginQr（微信开放平台）即可。
_QQ_QR_TYPE_LABELS = {2: 'QQ App', 3: '微信'}


def _get_qr_qq(name, qr_type=None):
    qr_type = qr_type or 2
    if qr_type == 3:
        # 微信扫码：vendor 走 open.weixin.qq.com 官方开放平台（_t 绕过 vendor 缓存）
        status, data, _ = proxy_request(name, 'GET', f'/user/getWXLoginQr?_t={_now_ms()}')
        d = data if isinstance(data, dict) else {}
        img, uuid_ = d.get('img'), d.get('uuid')
        if status >= 400 or not uuid_ or not img:
            return {'ok': False, 'err': f'微信取码失败(status={status})'}
        return {'ok': True, 'platform': 'qq', 'img': img, 'uuid': uuid_,
                'qrType': 3, 'qrTypeLabels': _QQ_QR_TYPE_LABELS}
    # QQ App 扫码（_t 绕过 vendor 缓存）
    status, data, _ = proxy_request(name, 'GET', f'/user/getQQLoginQr?_t={_now_ms()}')
    d = data if isinstance(data, dict) else {}
    img, pt, qs = d.get('img'), d.get('ptqrtoken'), d.get('qrsig')
    if status >= 400 or not qs or not img:
        return {'ok': False, 'err': f'QQ取码失败(status={status})'}
    return {'ok': True, 'platform': 'qq', 'img': img, 'ptqrtoken': pt, 'qrsig': qs,
            'qrType': 2, 'qrTypeLabels': _QQ_QR_TYPE_LABELS}


def _poll_qq(name, key):
    key = key or {}
    if key.get('uuid'):
        # 微信扫码轮询（vendor 内部长轮询等待用户扫码，代理超时后下次轮询继续）
        status, data, _ = proxy_request(name, 'POST', '/user/checkWXLoginQr',
                                        body={'uuid': key['uuid']})
    else:
        pt = key.get('ptqrtoken')
        qs = key.get('qrsig')
        if not pt or not qs:
            return {'ok': False, 'loggedIn': False, 'err': '缺少 ptqrtoken/qrsig'}
        status, data, _ = proxy_request(name, 'POST', '/user/checkQQLoginQr',
                                        body={'ptqrtoken': pt, 'qrsig': qs})
    d = data if isinstance(data, dict) else {}
    if d.get('isOk'):
        session = d.get('session') or {}
        cookie = session.get('cookie') or ''
        uin = str(session.get('uin') or session.get('loginUin') or '')
        if cookie:
            _STATE[name].cookie = cookie
            _STATE[name].uid = uin
            _invalidate_login_state(name)
            _persist_login()
            return {'ok': True, 'loggedIn': True}
        return {'ok': True, 'loggedIn': False}
    return {'ok': True, 'loggedIn': False,
            'refresh': bool(d.get('refresh')),
            'message': d.get('message') or '等待扫码…',
            'status': None}


# ---- 网易云 ----
# 本地 vendor 为 NeteaseCloudMusicApi v4.25.0，扫码流程是标准三步：
#   /login/qr/key → unikey；/login/qr/create?key=<unikey>&qrimg=true → qrimg；
#   /login/qr/check?key=<unikey> → 801 等待 / 802 已扫 / 803 成功(Set-Cookie)。
# 之前"扫码没反应"是取码流程写错（未带 key），不是 fork 本身的问题。
def _get_qr_netease(name):
    # 1) 拿 unikey（_t 绕过 vendor apicache 2 分钟缓存）
    status, data, _, setc = _proxy_raw(name, 'GET', f'/login/qr/key?_t={_now_ms()}')
    d = data if isinstance(data, dict) else {}
    unikey = ((d.get('data') or {}) if isinstance(d.get('data'), dict) else {}).get('unikey') or ''
    if status >= 400 or not unikey:
        return {'ok': False, 'err': f'取码失败(step key, status={status})'}
    # 2) 生成二维码图（qrimg 是 base64 PNG data URI；timestamp 用毫秒级防缓存）
    status, data, _, setc2 = _proxy_raw(
        name, 'GET',
        f"/login/qr/create?key={urllib.parse.quote(str(unikey))}&qrimg=true&timestamp={_now_ms()}")
    d2 = data if isinstance(data, dict) else {}
    dd2 = (d2.get('data') or {}) if isinstance(d2.get('data'), dict) else {}
    qrimg = dd2.get('qrimg') or ''
    if status >= 400 or not qrimg:
        return {'ok': False, 'err': f'取码失败(step create, status={status})'}
    if setc2:
        _STATE[name].tmp = _join_setcookies(setc2)
    return {'ok': True, 'platform': 'netease', 'img': qrimg, 'key': unikey}


def login_netease_account(name, mode, payload):
    """手机号 / 邮箱密码登录。mode: 'phone' | 'email'。密码明文→后端 MD5 后传给 vendor。"""
    import hashlib
    payload = payload or {}
    password = str(payload.get('password') or '')
    if not password:
        return {'ok': False, 'err': '缺少密码'}
    md5 = hashlib.md5(password.encode('utf-8')).hexdigest()
    if mode == 'phone':
        phone = str(payload.get('phone') or '').strip()
        if not phone:
            return {'ok': False, 'err': '缺少手机号'}
        countrycode = str(payload.get('countrycode') or '86').strip()
        path = (f'/login/cellphone?phone={urllib.parse.quote(phone)}'
                f'&countrycode={urllib.parse.quote(countrycode)}&password={md5}'
                f'&timestamp={int(time.time())}')
    elif mode == 'email':
        email = str(payload.get('email') or '').strip()
        if not email:
            return {'ok': False, 'err': '缺少邮箱'}
        path = (f'/login?email={urllib.parse.quote(email)}&password={md5}'
                f'&timestamp={int(time.time())}')
    else:
        return {'ok': False, 'err': '未知登录方式'}
    status, data, _ = proxy_request(name, 'GET', path)
    d = data if isinstance(data, dict) else {}
    cookie = d.get('cookie') or ''
    code = d.get('code')
    if status >= 400 or code != 200 or not cookie:
        msg = d.get('message') or d.get('msg') or ''
        # 常见码：462 需要验证码 / 501 账号或密码错误 / 509 需要登录确认
        hint = {462: '需要验证码（请改用扫码或先在官方App登录）',
                501: '账号或密码错误',
                509: '需要登录确认'}.get(code, '')
        return {'ok': False, 'err': hint or msg or f'登录失败(code={code})'}
    _STATE[name].cookie = _sanitize_cookie_str(d.get('cookie') or '')  # ★ 剔属性段，否则官方判未登录
    profile = d.get('profile') or {}
    _STATE[name].uid = str(profile.get('userId') or profile.get('nickname') or '')
    if not _STATE[name].uid:
        # ★ profile 缺 userId 时回查 /login/status 补 uid，避免"已登录但缺 uid 拿不到歌单"
        _STATE[name].uid = _fetch_netease_uid(name)
    _invalidate_login_state(name)
    _persist_login()
    return {'ok': True, 'loggedIn': True, 'uid': _STATE[name].uid}


def _poll_netease(name, key):
    key = key or {}
    k = key.get('key') or key.get('unikey') or ''
    if not k:
        return {'ok': False, 'loggedIn': False, 'err': '缺少 key'}
    hdrs = {}
    if _STATE[name].tmp:
        hdrs['Cookie'] = _STATE[name].tmp
    # ★ _t 毫秒级唯一绕过 vendor apicache：check 被缓存 2 分钟会吞掉扫码确认状态
    status, data, _, setc = _proxy_raw(name, 'GET',
                                       f'/login/qr/check?key={urllib.parse.quote(str(k))}&_t={_now_ms()}',
                                       headers=hdrs)
    d = data if isinstance(data, dict) else {}
    code = d.get('code')
    # 网易云 fork 成功态：code==803；cookie 在 body 顶层 cookie（含 MUSIC_U），也可能在 Set-Cookie
    body_cookie = d.get('cookie') or ''
    setc_cookie = _join_setcookies(setc)
    joined = body_cookie or setc_cookie
    if code == 803 or (joined and 'MUSIC_U=' in joined):
        cookie = _sanitize_cookie_str(joined)   # ★ 剔除 Max-Age/Expires/Path，否则官方接口判未登录
        if cookie:
            _STATE[name].cookie = cookie
            _STATE[name].tmp = ''
            _STATE[name].uid = _fetch_netease_uid(name)
            _invalidate_login_state(name)
            _persist_login()
            return {'ok': True, 'loggedIn': True}
    # 800 二维码已过期 / 801 等待扫码 / 802 已扫码待确认
    return {'ok': True, 'loggedIn': False, 'status': code, 'message': d.get('message')}


def _fetch_netease_uid(name):
    """登录后用 /login/status 取 profile.userId 作为 uid（重试 3 次，失败返回空串）。"""
    for _ in range(3):
        try:
            status, data, _ = proxy_request(name, 'GET', '/login/status')
            profile = _extract_netease_profile(data)
            uid = str(profile.get('userId', '') or '')
            if uid:
                _STATE[name].uid = uid
                _persist_login()
                return uid
        except Exception:
            pass
        time.sleep(0.4)
    return _STATE[name].uid or ''


def _extract_netease_profile(data):
    """兼容 vendor /login/status 两种响应结构：
    部分 fork 顶层 {code, profile, ...}；本 fork 包一层 {data:{code, profile, ...}}。"""
    if not isinstance(data, dict):
        return {}
    prof = data.get('profile') or {}
    if prof:
        return prof
    inner = data.get('data')
    if isinstance(inner, dict):
        return inner.get('profile') or {}
    return {}


def _join_setcookies(setc):
    """把多条 Set-Cookie 拼成 'k=v; k=v' 的单一 cookie 串（取每条首段）。"""
    parts = []
    for c in setc or []:
        seg = c.split(';', 1)[0].strip()
        if '=' in seg:
            parts.append(seg)
    return '; '.join(parts)


# ==================== 酷狗每日签到领 VIP（源自 KGM-AUTO-CHECKIN，本地化） ====================
# 与 GitHub Actions 版同接口：/user/detail 校验 → /youth/listen/song 听歌领
# → /youth/vip ×8（每次间隔 30s）→ /user/vip/detail 查到期时间。周日顺带刷新 token。
_CHECKIN = {'running': False, 'log': [], 'done': False, 'result': None, 'err': None}


def _checkin_log(msg):
    _CHECKIN['log'] = (_CHECKIN['log'] + [msg])[-40:]


def start_kugou_checkin():
    """启动酷狗每日签到（后台线程，前端轮询 kugou_checkin_status）。"""
    with _STATE_LOCK:
        if _CHECKIN['running']:
            return {'ok': False, 'err': '签到已在运行中'}
        cookie = _STATE['kugou'].cookie or ''
        tok = _parse_kugou_cookie(cookie).get('token', '')
        uid = _parse_kugou_cookie(cookie).get('userid', '')
        if not tok or not uid:
            return {'ok': False, 'err': '酷狗未登录，请先扫码登录'}
        _CHECKIN.update({'running': True, 'log': [], 'done': False, 'result': None, 'err': None})
    threading.Thread(target=_do_kugou_checkin, args=(tok, uid), daemon=True).start()
    return {'ok': True, 'started': True}


def kugou_checkin_status():
    st = {'running': _CHECKIN['running'], 'done': _CHECKIN['done'],
          'log': list(_CHECKIN['log']), 'result': _CHECKIN['result'], 'err': _CHECKIN['err']}
    return st


def _do_kugou_checkin(token, userid):
    try:
        import datetime
        today = datetime.date.today()
        headers = {'cookie': f'token={token}; userid={userid}'}
        _checkin_log(f'开始签到 {today.isoformat()}')

        # 1) 校验 token
        status, data, _ = proxy_request('kugou', 'GET', f'/user/detail?timestrap={int(time.time() * 1000)}', headers={'Cookie': headers['cookie']})
        d = data if isinstance(data, dict) else {}
        nickname = (d.get('data') or {}).get('nickname') if isinstance(d.get('data'), dict) else None
        if nickname is None:
            _checkin_log('token 已过期或账号不存在，请重新扫码登录')
            _CHECKIN['done'] = True
            _CHECKIN['result'] = {'ok': False, 'err': 'token 已过期或账号不存在'}
            return

        # 2) 周日刷新 token
        if today.weekday() == 6:
            st2, data2, _ = proxy_request('kugou', 'POST', f'/login/token?timestrap={int(time.time() * 1000)}', headers={'Cookie': headers['cookie']})
            d2 = data2 if isinstance(data2, dict) else {}
            if d2.get('status') == 1 and d2.get('data') and d2['data'].get('token') and d2['data']['token'] != token:
                token = d2['data']['token']
                headers = {'cookie': f'token={token}; userid={userid}'}
                _STATE['kugou'].cookie = f'token={token};userid={userid}'
                _checkin_log('token 已刷新')

        # 3) 听歌领取
        st3, data3, _ = proxy_request('kugou', 'GET', f'/youth/listen/song?timestrap={int(time.time() * 1000)}', headers={'Cookie': headers['cookie']})
        d3 = data3 if isinstance(data3, dict) else {}
        if d3.get('status') == 1:
            _checkin_log('听歌领取 VIP 成功')
        elif d3.get('error_code') in (130012, 30002):
            _checkin_log('听歌：今日已领取')
        else:
            _checkin_log(f'听歌领取失败(error_code={d3.get("error_code")})')

        # 4) 领取 VIP（最多 8 次，成功间隔 30s）
        claimed = 0
        for i in range(1, 9):
            st4, data4, _ = proxy_request('kugou', 'GET', f'/youth/vip?timestrap={int(time.time() * 1000)}', headers={'Cookie': headers['cookie']})
            d4 = data4 if isinstance(data4, dict) else {}
            if d4.get('status') == 1:
                claimed += 1
                _checkin_log(f'第 {i}/8 次领取成功')
                if i < 8:
                    time.sleep(30)
            elif d4.get('error_code') == 30002:
                _checkin_log('今日次数已用光')
                break
            else:
                _checkin_log(f'第 {i} 次领取失败(error_code={d4.get("error_code")})')
                break

        # 5) VIP 到期时间
        vip_end = '未知'
        st5, data5, _ = proxy_request('kugou', 'GET', f'/user/vip/detail?timestrap={int(time.time() * 1000)}', headers={'Cookie': headers['cookie']})
        d5 = data5 if isinstance(data5, dict) else {}
        if d5.get('status') == 1 and isinstance(d5.get('data'), dict):
            busi = d5['data'].get('busi_vip') or []
            if busi and isinstance(busi[0], dict) and busi[0].get('vip_end_time'):
                vip_end = str(busi[0]['vip_end_time'])
        _checkin_log(f'VIP 到期：{vip_end}')
        _CHECKIN['result'] = {'ok': True, 'claimed': claimed, 'vipEnd': vip_end, 'nickname': nickname}
    except Exception as e:
        _CHECKIN['err'] = str(e)[:200]
        _checkin_log(f'签到异常：{e}')
    finally:
        _CHECKIN['running'] = False
        _CHECKIN['done'] = True


# ==================== 状态聚合 ====================
def _resolve_uid(name):
    """返回当前登录账号的数字 id；netease 有 cookie 且无 uid 时懒查询一次。"""
    if name == 'kugou':
        return _parse_kugou_cookie(_STATE[name].cookie or '').get('userid', '')
    if name == 'qq':
        return _STATE[name].uid
    if name == 'netease':
        if not _STATE[name].uid and _STATE[name].cookie:
            _STATE[name].uid = _fetch_netease_uid(name)
        return _STATE[name].uid
    return ''


# 网易云登录态探测缓存：避免 uid 为空时每个 status 请求都打 /login/status
_NET_PR = {'at': 0.0, 'ok': False, 'uid': ''}
_NET_PROBE_TTL = 60.0


def _probe_netease_login(name):
    """有 cookie 但无 uid 时探测登录态：
    /login/status 拿得到 profile → 缓存 uid(ok=True)；
    拿不到（cookie 已失效）→ 负缓存 60s，避免每次 status 都打 vendor（慢）。"""
    now = time.time()
    if now - _NET_PR['at'] < _NET_PROBE_TTL:
        return _NET_PR['uid']    # 命中（正/负）缓存
    if not _STATE[name].cookie:
        return ''
    uid = _fetch_netease_uid(name)
    _NET_PR.update({'at': now, 'ok': bool(uid), 'uid': uid})
    return uid


# ==================== 登录态有效期校验 ====================
# 三个平台 badge 长期"已登录"的根因：logged_in 只由"cookie 非空"决定，
# 从不向平台验证。酷狗 token / 网易云 cookie 实际会过期，导致 UI 永远假"已登录"。
# 这里在 status_all 内做真实校验（TTL 缓存 30min，异常保守判"仍有效"不冤枉掉线）。
_LG_CACHE = {}          # name -> {'at': ts, 'ok': bool}
_LOGIN_CHECK_TTL = 1800.0


def _invalidate_login_state(name):
    """登录态变化（扫码/填 Cookie/退出）时清掉校验负缓存，避免扫码成功后
    仍命中旧的"未登录"缓存（_LG_CACHE TTL 30min）导致 UI 一直显示未登录。"""
    _LG_CACHE.pop(name, None)
    if name == 'netease':
        _NET_PR['at'] = 0.0


def _verify_login(name):
    """真实调用平台接口确认登录态是否仍有效。返回 True=有效 / False=已失效。
    校验失败（网络/风控等异常）保守返回 True，仅把明确失效的判定为掉线。"""
    now = time.time()
    c = _LG_CACHE.get(name)
    if c and now - c['at'] < _LOGIN_CHECK_TTL:
        return c['ok']
    ok = True
    try:
        if name == 'kugou':
            # token 失效时 /user/detail 无 data.nickname（签到代码同判据）；timestrap 绕过 vendor 缓存
            st, data, _ = proxy_request('kugou', 'GET',
                                        f'/user/detail?timestrap={int(time.time() * 1000)}')
            d = data if isinstance(data, dict) else {}
            dd = d.get('data') if isinstance(d.get('data'), dict) else {}
            ok = bool(dd.get('nickname'))
        elif name == 'qq':
            # 需要 uin；c6.y.qq.com 校验 cookie，未登录响应 code != 0（vendor 已用 undici fetch 免 TLS 风控）
            uin = _resolve_uid(name)
            if not uin:
                ok = False
            else:
                st, data, _ = proxy_request('qq', 'GET',
                                            f'/user/getUserPlaylists?uin={urllib.parse.quote(str(uin))}&limit=1&_t={_now_ms()}')
                d = data if isinstance(data, dict) else {}
                root = (d.get('response') if isinstance(d.get('response'), dict) else None) or d
                ok = bool(root.get('code') == 0)
        elif name == 'netease':
            # /login/status 拿得到 profile.userId 才算有效（proxy 对 netease 自动带 _t 防缓存）
            st, data, _ = proxy_request('netease', 'GET', '/login/status')
            ok = bool(_extract_netease_profile(data).get('userId'))
    except Exception:
        ok = True  # 保守：校验异常不判掉线，等下次 TTL 再验
    _LG_CACHE[name] = {'at': now, 'ok': ok}
    return ok


def status_all():
    """快速返回三平台状态（仅探测端口，不阻塞拉起）；未启动的副进程异步后台拉起。"""
    out = {}
    for name, cfg in _SERVICES.items():
        has_source = os.path.isdir(cfg['dir'])
        # ★ 冷启动（proc=None 且 alive=False）→ 不探测，直接 alive=False
        #   已有进程在跑或正在拉起 → 探测端口确认（最多 1s）
        alive = False
        if has_source and (_STATE[name].proc is not None or _STATE[name].alive):
            alive = _probe_alive(name)
        # 未启动但有源码 → 后台异步拉起，下次轮询即可就绪
        if has_source and not alive and not _STATE[name].alive:
            _STATE[name].alive = True  # 标记正在拉起，防重复 spawn
            _ensure_running_async(name)
        uid = _resolve_uid(name) if alive and _STATE[name].cookie else ''
        logged_in = bool(_STATE[name].cookie)
        if alive and _STATE[name].cookie and uid:
            # ★ 有 cookie + uid 也做真实校验（TTL 30min 缓存，不阻塞）：
            #   酷狗 token / 网易云 cookie 会过期，仅凭"cookie 非空"会永远假"已登录"
            logged_in = _verify_login(name)
        elif name == 'netease' and alive and _STATE[name].cookie and not uid:
            # ★ cookie 在但 uid 解析不出 → 视为登录态失效，提示重新登录而非“缺少账号 uid”
            uid = _probe_netease_login(name)
            logged_in = bool(uid)
        out[name] = {
            'label': cfg['label'],
            'alive': alive,
            'loggedIn': logged_in,
            'hasSource': has_source,
            'uid': uid,
        }
    return out


def login_state(name):
    st = status_all().get(name, {})
    return {'alive': st.get('alive', False), 'loggedIn': st.get('loggedIn', False),
            'uid': st.get('uid', '')}


def proxy_drop_in(name, method, target_path, body=None):
    """供 server.py 通用透传：target_path 以 '/' 开头（含 query）。"""
    return proxy_request(name, method, target_path, body=body)