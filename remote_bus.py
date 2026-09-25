# -*- coding: utf-8 -*-
"""remote_bus.py — 手机遥控器视图的进程内消息总线（todos #17）

## 为什么必须新写一条通道（而不是照抄桌面歌词的 localStorage 那套）

桌面歌词窗口（web/lyrics.html）与主窗在**同一台机器、同一个浏览器、同一个 origin**，
所以 250-desktop-lyrics.js 每 120ms 写 localStorage('aria_dtk_state') + 对端 `storage`
事件就能实时同步。手机是**另一台设备上的另一个浏览器**：它的 origin 是
`http://<局域网IP>:8001`，与主窗的 `http://localhost:8001` 既不同源、更不共享任何
web storage（localStorage / IndexedDB / BroadcastChannel 全都按「浏览器实例 + origin」
隔离，跨设备物理上不可能命中）。项目里也没有任何 SSE/WebSocket 通道。

跨设备唯一现成的载体就是本进程已有的 HTTP 服务，所以这里做一条**内存总线**：
  主窗 publish 播放状态  →  手机拉取；手机 publish 控制指令  →  主窗长轮询取回并执行。
不落盘、不新增端口、不引入第三方依赖（约束 1：Python 侧纯标准库）。
状态语义、字段命名、以及「发送端只在变化时推 + 接收端本地 rAF 插值」这套纪律，
全部沿用 250-desktop-lyrics.js 的现成契约（pos/playing/l1/l2/w1/ls/lth/th/...），
不额外发明第二种载荷格式。

## 接线（生产路径 = 嵌进 server.py，见 AGENTS 报告的补丁清单）

    import remote_bus                      # server.py 顶部
    # do_GET  里：  if self.path.startswith('/api/remote/'): remote_bus.handle(self); return
    # do_POST 里：  if self.path.startswith('/api/remote/'): remote_bus.handle(self); return

## 过渡路径（server.py 未打补丁时）

    python remote_bus.py --port 8002 --upstream http://127.0.0.1:8001

在 8002 起一个「只接管 /api/remote/*、其余原样转发给 8001」的反向代理，
这样不改动任何既有文件也能整链路自测。此模式仅用于开发/验证，不是分发形态。

## 安全边界

总线与 --lan 模式的其它接口同一条命：只在可信局域网内使用（server.py 启动横幅已
对此有明确警告），无鉴权——同网段任何人都能控制本机播放。任何新增的「把本机能力
开放给局域网」的功能都要一并考虑这条前提。
"""

import json
import socket
import threading
import time
import urllib.parse

# ============ 载荷上限与新鲜度 ============
MAX_PAYLOAD_BYTES = 64 * 1024     # 主窗一次状态推送的上限（含队列），超出即拒绝
PUBLISHER_TTL_SEC = 6.0           # 主窗心跳超过这个秒数 → 手机判定「已断开」
CONSUMER_TTL_SEC = 5.0            # 手机超过这个秒数没来拉 → 主窗计数里视为离开
MAX_CMD_QUEUED = 64               # 指令队列长度（主窗长时间不在时旧指令直接丢）
CMD_TTL_SEC = 15.0                # 指令过期时间：断线重连后不执行一小时前的误触
LONGPOLL_MAX_WAIT_MS = 20000      # 长轮询单次最长挂起时间

_cond = threading.Condition()
_pub = {'payload': None, 'seq': 0, 'at': 0.0}     # 主窗 → 手机
_cmds = []                                        # 手机 → 主窗（FIFO）
_cmd_seq = 0
_view = {}                                        # 客户端标识 → 最后拉取时刻（调试/观测用）


# ============ 核心读写（全部在 _cond 保护下） ============

def _key(payload):
    """「变化」由发送端自己声明：载荷里的 sig 字段是变化判据。
    为什么不在这里比较整个 payload：pos（播放位置）每时每刻都在动，整体比较等于
    每次心跳都算变化 → seq 每秒递增 → 手机每次轮询都收到全量载荷，
    「只在变化时推」这条桌面歌词用了很多年省下来的规矩就白抄了。"""
    if isinstance(payload, dict) and 'sig' in payload:
        return payload['sig']
    return payload


def publish(payload):
    """主窗推送状态。sig 与上次相同时不递增 seq（手机 ?since= 会拿到 204，
    避免每 250ms 一次无意义传输）；但一定刷新 at —— 它就是心跳本身，
    而存下来的 payload 是最新的（含最新 pos），中途接入的手机拿到的锚点因此不旧。
    返回 (seq, changed)。

    注意：payload 是**整体替换**（不做字段合并）。发送端每次都要带全量状态，
    只发增量会把上一次的字段抹掉——主窗侧 291-phone-remote.js 的 buildPayload
    就是每次都全量重建，这里不再兜底，避免两处都以为对方在做合并。
    """
    global _pub
    with _cond:
        changed = (_key(_pub['payload']) != _key(payload))
        seq = _pub['seq'] + (1 if changed else 0)
        _pub = {'payload': payload, 'seq': seq, 'at': time.time()}
        return seq, changed


def read_state(since=-1, client=None):
    """手机拉状态。since 与服务端 seq 相同**且主窗心跳仍然新鲜**才返回 None（204）。
    心跳一过期就无条件回一份 alive:false 的小载荷：204 不带信息，
    手机会因为「一直没变化」而把「主窗已死」误显示成「一切正常」。"""
    with _cond:
        if client:
            _view[client] = time.time()
        alive = (_pub['payload'] is not None) and (time.time() - _pub['at'] < PUBLISHER_TTL_SEC)
        if since == _pub['seq'] and since >= 0 and alive:
            return None
        return {
            'seq': _pub['seq'],
            'at': int(_pub['at'] * 1000),
            'serverNow': int(time.time() * 1000),
            # alive=false 表示主窗心跳断了：手机要显式提示「已断开」而不是停在旧画面
            'alive': alive,
            'payload': _pub['payload'] if alive or since < 0 else None,
        }


def push_cmd(cmd, arg, client=None):
    """手机投递控制指令，返回指令 id。队列满时丢最旧的一条（遥控器语义：新指令优先）。"""
    global _cmd_seq
    with _cond:
        _cmd_seq += 1
        cid = _cmd_seq
        _cmds.append({'id': cid, 'cmd': cmd, 'arg': arg, 'at': time.time(), 'from': client or ''})
        if len(_cmds) > MAX_CMD_QUEUED:
            del _cmds[:len(_cmds) - MAX_CMD_QUEUED]
        _cond.notify_all()
        return cid


def take_cmds(since_id, wait_ms):
    """主窗长轮询取指令。返回 (可执行指令列表, 当前最大 id)。
    since_id 用于去重：主窗重启后 from=0 会把队列里的过期指令一并按 TTL 丢掉。"""
    deadline = time.time() + min(max(wait_ms, 0), LONGPOLL_MAX_WAIT_MS) / 1000.0
    with _cond:
        while True:
            now = time.time()
            # 消费即回收：id<=since_id 的已交付给唯一消费端（主窗），再加 TTL 淘汰，
            # 否则队列只增不减，stats.pendingCmds 会一直谎报「有指令没取」
            _cmds[:] = [c for c in _cmds if c['id'] > since_id and now - c['at'] < CMD_TTL_SEC]
            pending = [c for c in _cmds if c['id'] > since_id]
            if pending:
                return pending, max(c['id'] for c in pending)
            remain = deadline - now
            if remain <= 0:
                # 队列里全是被丢弃的过期指令时，游标要跳过它们，否则永远停在旧 id
                return [], max([c['id'] for c in _cmds] + [since_id])
            _cond.wait(min(remain, 1.0))


def stats():
    """观测用：当前有几个遥控端在线、队列里还有几条未取指令。"""
    with _cond:
        now = time.time()
        online = sum(1 for t in _view.values() if now - t < CONSUMER_TTL_SEC)
        return {'seq': _pub['seq'], 'viewers': online, 'pendingCmds': len(_cmds)}


def lan_ip():
    """探测本机主网段 IPv4（与 server.py._lan_ip_hint 同一手法：UDP connect 不真的发包）。
    手机页要把它显示成可抄的地址，所以这里必须给一个，而不是让用户去猜。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))
        return s.getsockname()[0]
    except Exception:
        return ''
    finally:
        try:
            s.close()
        except Exception:
            # 关闭失败无信息量（socket 由进程退出兜底回收），留注释说明为何不记日志
            pass


# ============ HTTP 适配层（嵌进 server.py 时只用到这一层） ============

def write_json(h, code, obj):
    body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
    h.send_response(code)
    h.send_header('Content-Type', 'application/json; charset=utf-8')
    h.send_header('Content-Length', str(len(body)))
    # 总线值就是「最新一刻」，任何缓存都会让遥控器停在旧画面
    h.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
    h.send_header('Access-Control-Allow-Origin', '*')
    h.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    h.send_header('Access-Control-Allow-Headers', '*')
    h.end_headers()
    try:
        h.wfile.write(body)
    except Exception:
        # 客户端在响应写出前断开（手机锁屏/切后台是常态）：连接已结束，无后续动作
        pass


def write_204(h):
    h.send_response(204)
    h.send_header('Cache-Control', 'no-store')
    h.send_header('Access-Control-Allow-Origin', '*')
    h.end_headers()


def _origin_key(h):
    """给每个遥控端一个稳定的匿名标识，只用来数在线数量（不含任何设备信息）。"""
    ip = (getattr(h, 'client_address', None) or ('?',))[0]
    return str(ip)


def handle(h):
    """统一入口：命中 /api/remote/* 时处理并返回 True，否则返回 False 交回原路由。"""
    raw = h.path or ''
    path = raw.split('?', 1)[0]
    if not path.startswith('/api/remote/'):
        return False
    q = urllib.parse.parse_qs(raw.split('?', 1)[1] if '?' in raw else '')

    try:
        if path == '/api/remote/state':
            if h.command == 'GET':
                try:
                    since = int((q.get('since') or ['-1'])[0])
                except ValueError:
                    since = -1
                snap = read_state(since, _origin_key(h))
                if snap is None:
                    write_204(h)
                else:
                    write_json(h, 200, snap)
                return True
            if h.command == 'POST':
                n = int(h.headers.get('Content-Length') or 0)
                if n <= 0 or n > MAX_PAYLOAD_BYTES:
                    write_json(h, 413, {'ok': False, 'err': 'payload size'})
                    return True
                try:
                    payload = json.loads(h.rfile.read(n).decode('utf-8'))
                except Exception as e:
                    write_json(h, 400, {'ok': False, 'err': 'bad json: %s' % type(e).__name__})
                    return True
                if not isinstance(payload, dict):
                    write_json(h, 400, {'ok': False, 'err': 'payload must be object'})
                    return True
                seq, changed = publish(payload)
                write_json(h, 200, {'ok': True, 'seq': seq, 'changed': changed})
                return True

        elif path == '/api/remote/cmd':
            if h.command == 'GET':
                try:
                    since_id = int((q.get('since') or ['0'])[0])
                    wait_ms = int((q.get('wait') or ['8000'])[0])
                except ValueError:
                    since_id, wait_ms = 0, 8000
                cmds, max_id = take_cmds(since_id, wait_ms)
                write_json(h, 200, {'ok': True, 'cmds': cmds, 'lastId': max_id, 'stats': stats()})
                return True
            if h.command == 'POST':
                n = int(h.headers.get('Content-Length') or 0)
                if n <= 0 or n > 4096:
                    write_json(h, 413, {'ok': False, 'err': 'cmd size'})
                    return True
                try:
                    body = json.loads(h.rfile.read(n).decode('utf-8'))
                except Exception as e:
                    write_json(h, 400, {'ok': False, 'err': 'bad json: %s' % type(e).__name__})
                    return True
                cmd = body.get('cmd')
                if not isinstance(cmd, str) or not cmd:
                    write_json(h, 400, {'ok': False, 'err': 'cmd required'})
                    return True
                cid = push_cmd(cmd[:32], body.get('arg'), _origin_key(h))
                write_json(h, 200, {'ok': True, 'id': cid})
                return True

        elif path == '/api/remote/info':
            host = (h.headers.get('Host') or '').split(':')[0] or '127.0.0.1'
            port = str(getattr(h, 'server', None) and h.server.server_address[1] or '')
            ip = lan_ip()
            write_json(h, 200, {
                'ok': True, 'ip': ip, 'host': host, 'port': port,
                'remoteUrl': ('http://%s:%s/remote.html' % (ip or '<局域网IP>', port)),
                'stats': stats(),
            })
            return True

        elif path == '/api/remote/ping':
            write_json(h, 200, {'ok': True, 'serverNow': int(time.time() * 1000)})
            return True

        write_json(h, 404, {'ok': False, 'err': 'unknown remote endpoint'})
    except (BrokenPipeError, ConnectionResetError):
        # 对端提前断开是长轮询的正常收场，不是故障
        return True
    except Exception as e:
        try:
            write_json(h, 500, {'ok': False, 'err': str(e)[:200]})
        except Exception:
            # 已经断连，无处可报
            pass
    return True


# ============ 过渡期独立服务（开发/验证用，见模块头「接线」） ============

def _dev_server(port, upstream):
    """只接管 /api/remote/*，其余全部转发给 upstream。仅用于 server.py 尚未接线时自测。"""
    import http.client
    import socketserver
    from http.server import SimpleHTTPRequestHandler

    class _H(SimpleHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, fmt, *args):
            pass  # 手机 250ms 一次的轮询会淹没控制台，验证期静音

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', '*')
            self.end_headers()

        def do_GET(self):
            if handle(self):
                return
            self._relay()

        def do_POST(self):
            if handle(self):
                return
            self._relay()

        def _relay(self):
            """转发给真正的 8001：静态文件与全部业务接口照旧走它，本进程只做总线。"""
            try:
                n = int(self.headers.get('Content-Length') or 0)
                body = self.rfile.read(n) if n else None
                u = urllib.parse.urlparse(upstream)
                conn = http.client.HTTPConnection(u.hostname, u.port or 80, timeout=120)
                hdrs = {k: v for k, v in self.headers.items()
                        if k.lower() in ('range', 'content-type', 'content-length', 'accept',
                                         # origin 必须透传：上游 /proxy 按 Origin 白名单拦局域网来源，
                                         # 不透传就测不出「手机上到底哪些接口会 403」
                                         'origin', 'referer', 'cookie', 'user-agent')}
                hdrs['Host'] = u.netloc
                conn.request(self.command, self.path, body=body, headers=hdrs)
                res = conn.getresponse()
                self.send_response(res.status, res.reason or '')
                for k, v in res.getheaders():
                    if k.lower() in ('transfer-encoding', 'connection', 'content-length', 'date', 'server'):
                        continue
                    self.send_header(k, v)
                data = res.read()
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                if self.command != 'HEAD':
                    self.wfile.write(data)
                conn.close()
            except Exception:
                # 上游断了没法再补状态行（头已发出），静默结束这条连接即可
                pass

    class _S(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    _S(('0.0.0.0', port), _H).serve_forever()


if __name__ == '__main__':
    import argparse

    ap = argparse.ArgumentParser(description='Aria 遥控器总线（独立运行/开发验证）')
    ap.add_argument('--port', type=int, default=8002)
    ap.add_argument('--upstream', default='http://127.0.0.1:8001',
                    help='非 /api/remote/* 请求转发到的地址；传 none 表示只提供总线')
    a = ap.parse_args()
    print('remote_bus on :%d  upstream=%s' % (a.port, a.upstream))
    print('  主窗： http://localhost:%d/index.html' % a.port)
    print('  手机： http://%s:%d/remote.html' % (lan_ip() or '<局域网IP>', a.port))
    if a.upstream.lower() == 'none':
        raise SystemExit('（验证模式必须带 --upstream，否则页面拿不到静态文件与业务接口）')
    _dev_server(a.port, a.upstream)
