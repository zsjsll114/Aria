#!/usr/bin/env python3
"""
歌词播放器本地服务器（含 CORS 代理功能）
- 静态文件服务：同 python -m http.server
- 代理端点：/proxy?url=<目标URL>  →  获取外部资源并附加 CORS 头
  用于解决 AMLL TTML DB 等外部 API 不支持跨域的问题
"""
import http.server
import socketserver
import socket
import urllib.request
import urllib.parse
import urllib.error
import os
import sys

# 让 print 日志在重定向到文件时也实时落盘，方便排查识曲各阶段
# 无控制台打包（--noconsole）下 sys.stdout 为 None，重定向到日志文件防止 print 崩溃
try:
    if sys.stdout is None:
        _ROOT_FOR_LOG = (os.path.dirname(sys.executable)
                         if getattr(sys, 'frozen', False)
                         else os.path.dirname(os.path.abspath(__file__)))
        sys.stdout = open(os.path.join(_ROOT_FOR_LOG, 'server_console.log'),
                          'a', encoding='utf-8', buffering=1)
    else:
        sys.stdout.reconfigure(line_buffering=True)
    if sys.stderr is None:
        sys.stderr = sys.stdout
    else:
        sys.stderr.reconfigure(line_buffering=True)
except Exception:
    pass

PORT = 8001

# ★ 监听地址：默认只绑本机回环（127.0.0.1）。
#   历史行为是绑 ""（等价 0.0.0.0 全接口），意味着同网段任何设备都能直接访问
#   /proxy（通用代理，可当跳板）、/api/selfhost/*（携带登录态）、
#   /api/local-music/list、/api/config/load —— 属于把整面 API 白白暴露给局域网。
#   需要手机/平板等其它设备连本机听歌时，显式加 --lan 才绑 0.0.0.0。
#   注意：绑回环后应用内一律走 127.0.0.1 访问（避免 localhost 先解析到 ::1 的
#   IPv6 回退延迟）；--lan 模式下 /api/shutdown 仍只接受回环来源。
LAN_MODE = '--lan' in sys.argv[1:]
BIND_HOST = '0.0.0.0' if LAN_MODE else '127.0.0.1'


def _lan_ip_hint():
    """探测本机主网段 IPv4，供 --lan 模式提示手机该访问哪个地址。
    用 UDP connect 定位出口网卡地址——不会真的发包，纯标准库。"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(('10.255.255.255', 1))
            return s.getsockname()[0]
        finally:
            s.close()
    except Exception:
        return ''


# ★ PyInstaller 打包（绿色版）时：EXE 所在目录 == 绿色版根目录，
#   所有数据目录（web / _eval / cache / local_music）都相对它查找。
#   开发模式下回退 __file__ 所在目录（与历史行为一致）。
if getattr(sys, 'frozen', False):
    _PROJECT_DIR = os.path.dirname(sys.executable)
else:
    _PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))

# 静态文件根指向 web/（Tauri frontendDist 同源，保证浏览器与桌面版加载同一份最新代码）。
# 项目根保留的历史 index.html/src 副本不再被本地服务器服务。
# ★ 多候选回退：新建/解压后的目录结构各异（web 可能被放到 server.exe 同级/上级/dist 内），
#   只要候选里存在 index.html 就用它；全都没有时至少让服务器能启动并在日志里明示问题，
#   避免"服务在跑但 404"(摸不着头脑)。
def _resolve_web_dir():
    _candidates = [
        os.path.join(_PROJECT_DIR, 'web'),
        os.path.join(_PROJECT_DIR, 'dist', 'app', 'web'),
        os.path.join(os.path.dirname(_PROJECT_DIR), 'web'),
    ]
    for _c in _candidates:
        if os.path.isfile(os.path.join(_c, 'index.html')):
            return _c
    return _candidates[0]

WEB_DIR = _resolve_web_dir()
DIRECTORY = WEB_DIR


import shutil
import local_music_server
import qq_resolver
import agg_resolver
import selfhost_service
import json
import threading
import time
import atexit

# ==================== 音频缓存写入互斥 ====================
# 同一首歌的 .tmp 缓存同一时刻只允许一个线程写。
# 此前播放流(Range请求)与高潮解析fetch(无Range)并发到达时，两个线程都
# open(tmp,'wb')：后到者截断先到者的半成品、交错写入后 os.replace 把损坏
# 文件提升为正式缓存 —— 之后播放/解码一直失败("下载完了却说本地解析失败")。
_AUDIO_CACHE_WRITERS = set()
_AUDIO_WRITERS_LOCK = threading.Lock()


def _try_claim_writer(clean_id, start, cache_path):
    """缓存写入互斥认领（核心竞态判定，便于单测）：
    仅「从头请求(start==0) + 正式缓存不存在 + 未被认领」的第一个并发线程成为 writer，
    负责落盘 .tmp；其余并发请求只代理转发，杜绝截断半成品/交错写入/晋升损坏缓存。"""
    if start == 0 and not os.path.exists(cache_path):
        with _AUDIO_WRITERS_LOCK:
            if clean_id not in _AUDIO_CACHE_WRITERS:
                _AUDIO_CACHE_WRITERS.add(clean_id)
                return True
    return False

# ==================== 音频流调试日志 ====================
# 排查"播到1~4秒卡死"专用：记录每个 /api/audio/stream 请求的 Range、
# 命中分支、发送字节数与结束原因，写入 server_debug.log（不影响控制台输出）
_DEBUG_LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'server_debug.log')
_DEBUG_LOCK = threading.Lock()


def dbg(msg):
    try:
        with _DEBUG_LOCK:
            with open(_DEBUG_LOG_PATH, 'a', encoding='utf-8') as f:
                f.write(f"[{time.strftime('%H:%M:%S')}.{int(time.time() * 1000) % 1000:03d}] {msg}\n")
    except Exception:
        pass

# ==================== 咪咕音乐源辅助（官方 H5 接口，实测可用） ====================
UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
_MIGU_MAGIC = b'\xab\xcd\x01'
_MIGU_KEY = b'Jk8qzuePiJ1qE3mDYhLQ3T73DtDoAhLP'


def _migu_headers(extra=None):
    h = {'User-Agent': UA_DESKTOP, 'Accept': 'application/json, text/plain, */*',
         'Origin': 'https://h5.nf.migu.cn', 'Referer': 'https://h5.nf.migu.cn/',
         'ua': 'Android_migu', 'version': '6.8.8', 'channel': '014021I', 'subchannel': '014021I'}
    if extra:
        h.update(extra)
    return h


def _migu_decrypt(raw, resp_headers):
    """咪咕部分接口响应为加密体: MAGIC(3B) + seed(1B) + 逐字节异或偏移密文"""
    if (resp_headers or {}).get('signature') == '1' or raw[:3] == _MIGU_MAGIC:
        seed = raw[3]
        plain = bytes((b + seed - _MIGU_KEY[i % len(_MIGU_KEY)]) & 0xFF
                      for i, b in enumerate(raw[4:]))
        return json.loads(plain.decode('utf-8'))
    return json.loads(raw.decode('utf-8'))


def _http_get_bytes(url, headers, timeout=12):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), dict(r.headers)


def _probe_audio_url(url, extra_headers=None):
    """轻量探测音频URL可播性: Range 读首2KB即断，不落盘不转发。
    返回 {ok, status, contentType, total}；total 为完整文件字节数
    （从 Content-Range 'bytes 0-2047/N' 或 Content-Length 解析，未知则 0）。
    调用方可用 total 与期望时长估算是否"试听预览"（VIP 未开通时常见）。"""
    h = {'User-Agent': UA_DESKTOP, 'Accept': '*/*', 'Range': 'bytes=0-2047'}
    if extra_headers:
        h.update(extra_headers)
    try:
        req = urllib.request.Request(url, headers=h)
        with urllib.request.urlopen(req, timeout=5) as r:
            data = r.read(2048)
            ctype = (r.headers.get('Content-Type') or '').lower()
            # 2xx 且有数据且非HTML错误页才算可播
            ok = len(data) > 0 and r.status in (200, 206) and 'text/html' not in ctype
            total = 0
            cr = r.headers.get('Content-Range') or ''
            m = __import__('re').search(r'/\s*(\d+)\s*$', cr)
            if m:
                total = int(m.group(1))
            elif r.status == 200:
                cl = r.headers.get('Content-Length')
                if cl and cl.isdigit():
                    total = int(cl)
            return {'ok': ok, 'status': r.status,
                    'contentType': r.headers.get('Content-Type', ''),
                    'total': total}
    except Exception as e:
        return {'ok': False, 'err': str(e)[:160]}


def _is_preview_probe(result, expected_sec):
    """用 total 字节数与期望时长粗判试听预览：total 已知且明显短于整曲（<55% 时长按 128kbps 折算）时判定为试听。"""
    total = int((result or {}).get('total') or 0)
    if total <= 0:
        return False
    expected_sec = int(expected_sec or 0)
    if expected_sec < 60:
        return False  # 短歌不做试听判定，避免误伤
    bytes_full = expected_sec * 16 * 1024  # 128kbps 满时长约 16KB/秒
    return total < bytes_full * 0.55


# ==================== 部分缓存(.tmp)真实总长记录 ====================
# 首次从上游回源时会把 Content-Range 中 '/' 后的总字节数写入 <id>.mp3.meta。
# seek 直读 .tmp 部分缓存时以此作为 Content-Range 分母，浏览器才能做
# 时间→字节映射即时跳到任意位置；否则部分缓存会被当成完整文件（秒开失效）。


def _read_meta_total(cache_path):
    try:
        with open(cache_path + '.meta', 'r') as f:
            t = int(json.load(f).get('total', 0))
            return t if t > 0 else None
    except Exception:
        return None


def _read_meta_url(cache_path):
    """读取 .meta 记录的首次回源 upstream URL，用于部分缓存直读的来源一致性校验"""
    try:
        with open(cache_path + '.meta', 'r') as f:
            return json.load(f).get('url', '')
    except Exception:
        return ''


_AUDIO_EXT_CTYPE = {
    '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
    '.flac': 'audio/flac', '.fla': 'audio/flac',
    '.mp3': 'audio/mpeg',
    '.aac': 'audio/aac',
    '.m4a': 'audio/mp4', '.mp4': 'audio/mp4',
    '.wav': 'audio/wav', '.wave': 'audio/wav',
}


def _audio_ctype_from_url(url):
    """按上游URL扩展名推断容器类型。QQ系CDN(_stream.qqmusic.qq.com等)有时返回
    application/x-www-form-urlencoded 之类的错误 Content-Type，必须按 .ogg/.flac
    等真实扩展名兜底，否则浏览器拿错 MIME 不进媒体管线解码而陷入停滞。"""
    try:
        path = urllib.parse.urlparse(url or '').path.lower()
        ext = os.path.splitext(path)[1]
    except Exception:
        ext = ''
    return _AUDIO_EXT_CTYPE.get(ext, '')


def _sanitize_audio_ctype(url, upstream_ctype):
    """从回源响应 Header 得到可靠音频 Content-Type：
    - 上游已是合法音频类型(audio/*、octet-stream、application/ogg等) → 直接使用
    - 上游缺失/错误类型(urlencoded、text/html等) → 按URL扩展名推断
    - 仍无法确定 → 回退 audio/mpeg
    保证写入 .meta 与回头的 Content-Type 一致且可信。"""
    raw = (upstream_ctype or '').strip().lower()
    if raw.startswith('audio/'):
        return raw
    if raw in ('application/octet-stream',):
        return raw
    if raw in ('application/ogg', 'application/x-ogg'):
        return 'audio/ogg'
    return _audio_ctype_from_url(url) or 'audio/mpeg'


def _read_meta_ctype(cache_path):
    """读取 .meta 记录的上游真实 Content-Type（如 audio/ogg、audio/flac）。
    回源时缓存文件扩展名固定 .mp3，若本地直读仍用 guess_type 会返回 audio/mpeg，
    与真实容器不匹配导致浏览器解码失败(stalled死循环)——必须用回源时记录的真实
    MIME，保证"回源播放"与"缓存直读"两种路径给浏览器完全一致的 Content-Type。
    只认可合法音频类型：旧版误存了 urlencoded/text-html 之类的错误类型时返回 '',
    调用方会按"无有效ctype"删除残片回源重建，自动自愈。"""
    try:
        with open(cache_path + '.meta', 'r') as f:
            raw = (json.load(f).get('ctype', '') or '').strip().lower()
        if raw.startswith('audio/'):
            return raw
        if raw in ('application/ogg', 'application/x-ogg'):
            return 'audio/ogg'
        if raw in ('application/octet-stream',):
            return raw
        return ''
    except Exception:
        return ''


def _write_meta_audio(cache_path, total, url, content_type=''):
    try:
        with open(cache_path + '.meta', 'w') as f:
            json.dump({'total': int(total), 'url': url or '', 'ctype': content_type or ''}, f)
    except Exception:
        pass


def _launch_bg_audio_download(clean_id, cache_path, tmp_cache, ok_mark, resp, expected_total):
    """客户端断开后：后台继续读上游响应余量写入 .tmp，完整后晋升为正式缓存。
    写入认领权由本线程持有，退出时释放，防止并发请求截断半成品。"""
    def _bg():
        _out = None
        try:
            _out = open(tmp_cache, 'ab')
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                _out.write(chunk)
                _out.flush()
        except Exception as e:
            dbg(f"[{clean_id}] 后台续传中断({type(e).__name__}: {str(e)[:60]}) @tmp={os.path.getsize(tmp_cache) if os.path.exists(tmp_cache) else 0}")
        finally:
            try:
                if _out is not None:
                    _out.close()
            except Exception:
                pass
        try:
            got = os.path.getsize(tmp_cache)
            if got > 1024 and (expected_total is None or got == expected_total):
                os.replace(tmp_cache, cache_path)
                with open(ok_mark, 'w') as f:
                    f.write(str(got))
                local_music_server.cleanup_audio_cache(keep_id=clean_id)
                dbg(f"[{clean_id}] 后台续传完成 got={got}")
        except Exception as e:
            print(f"[AudioStream] 后台续传失败: {e}")
        with _AUDIO_WRITERS_LOCK:
            _AUDIO_CACHE_WRITERS.discard(clean_id)

    threading.Thread(target=_bg, daemon=True, name=f"bg-audio-{clean_id[:10]}").start()

# ==================== 榜单兜底：第三方源失效时走本地 vendor ====================
def _rank_fallback_qq(rid=''):
    """QQ 榜单兜底：走 sansejian/qq-music-api-node（官方域名，免登录）。
    无 id → /getTopLists 榜首列表；有 id → /getRanks 榜内歌曲。
    输出与前端 loadRankSource 期望形状一致：{code:0, data:{group:[{toplist:[
      {topId,title,cover,song:[{cover}]}]}]}（榜首列表）或 {code:0, data:[歌手数组]}（榜内）。"""
    try:
        if not rid:
            st, parsed, _ = selfhost_service.proxy_drop_in('qq', 'GET', '/getTopLists')
            if st >= 300 or not isinstance(parsed, dict):
                return b'{}'
            toplists = ((parsed.get('response') or {}).get('data') or {}).get('topList') or []
            group = []
            for t in toplists:
                if not isinstance(t, dict) or not t.get('id'):
                    continue
                pic = t.get('picUrl') or ''
                preview = []
                for s in (t.get('songList') or [])[:3]:
                    if isinstance(s, dict):
                        preview.append({'cover': pic or '', 'songname': s.get('songname', ''), 'singername': s.get('singername', '')})
                # ★ 曲目总数上游不提供（songList 仅 3 首预览），补充 listenCount 为人气展示用
                group.append({'topId': t.get('id'), 'title': t.get('topTitle') or '榜单',
                              'cover': pic, 'listen': t.get('listenCount') or 0, 'song': preview})
            return json.dumps({'code': 0, 'data': {'group': [{'groupName': 'QQ音乐', 'toplist': group}]}},
                              ensure_ascii=False).encode('utf-8')
        st, parsed, _ = selfhost_service.proxy_drop_in('qq', 'GET',
                                                       f'/getRanks?topId={urllib.parse.quote(rid)}&limit=100&page=0')
        if st >= 300 or not isinstance(parsed, dict):
            return b'{}'
        songs = (((((parsed.get('response') or {}).get('req_1') or {}).get('data') or {}).get('data') or {})
                 .get('song') or [])
        norm = []
        for s in songs:
            if not isinstance(s, dict) or not s.get('songId'):
                continue
            singer = s.get('singerName') or ''
            # ★ getRanks 上游只为前 3 首带 cover；其余用 albumMid 拼唱片封面补全，
            #   否则榜单歌曲大面积无封面（播放时也不切封面）。
            cover = s.get('cover') or ''
            if not cover and s.get('albumMid'):
                cover = f'https://y.gtimg.cn/music/photo_new/T002R300x300M000{s.get("albumMid")}.jpg'
            norm.append({'song': s.get('title') or '', 'singer': singer,
                         'cover': cover, 'id': str(s.get('songId')),
                         'source': 'tencent', 'mid': s.get('songMid') or s.get('albumMid') or ''})
        return json.dumps({'code': 0, 'data': norm}, ensure_ascii=False).encode('utf-8')
    except Exception:
        return b'{}'


def _rank_fallback_ncm(rid=''):
    """网易云榜单兜底：走 NeteaseCloudMusicApi /toplist 与 /playlist/track/all。
    无 id → 榜首列表 {code:0, data:{data:[{id,name,cover}]}}；
    有 id → 榜内歌曲 {code:0, data:[原始 track 对象{id,name,ar,al}]}（前端按此形状映射）。"""
    try:
        if not rid:
            st, parsed, _ = selfhost_service.proxy_drop_in('netease', 'GET', '/toplist')
            if st >= 300 or not isinstance(parsed, dict):
                return b'{}'
            lst = parsed.get('list') or []
            norm = []
            for t in lst:
                if not isinstance(t, dict) or not t.get('id'):
                    continue
                norm.append({'id': str(t.get('id')), 'name': t.get('name') or '榜',
                             'cover': t.get('coverImgUrl') or t.get('coverImgId_str') or '',
                             'songs': None, 'meta': t})
            return json.dumps({'code': 0, 'data': {'data': norm}}, ensure_ascii=False).encode('utf-8')
        st2, parsed2, _ = selfhost_service.proxy_drop_in('netease', 'GET',
                                                         f'/playlist/track/all?id={urllib.parse.quote(rid)}&limit=100')
        tracks = []
        if st2 < 300 and isinstance(parsed2, dict):
            tracks = parsed2.get('songs') or (parsed2.get('playlist') or {}).get('tracks') or []
        return json.dumps({'code': 0, 'data': tracks}, ensure_ascii=False).encode('utf-8')
    except Exception:
        return b'{}'


class LyricServerHandler(http.server.SimpleHTTPRequestHandler):
    # ★ 榜单结果服务端短缓存（90s，进程内）；键 = "action|rid"
    _RANK_CACHE = {}
    _RANK_CACHE_TTL = 90
    """静态文件服务 + CORS 代理 + 本地音乐管理 API"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def _handle_shutdown(self):
        """优雅退出入口（Tauri 关窗时由 lib.rs 触发）：
        先回 200，再在后台线程执行「清 shazam → 清自建 vendor → 强退」。
        不走 httpd.shutdown()+atexit 链路，避免 serve_forever 未就绪时挂死；
        vendor 清理显式调用 selfhost_service.shutdown_all()（进程树 taskkill）。"""
        # ★ 仅允许回环来源触发关机：服务可能绑定 0.0.0.0（局域网可达），
        #   若不对来源做校验，同网段任何设备 curl /api/shutdown 即可关掉本应用
        try:
            if self.client_address[0] not in ('127.0.0.1', '::1', '::ffff:127.0.0.1'):
                self._send_json_response({'error': 'forbidden: localhost only'}, status_code=403)
                return
        except Exception:
            pass
        try:
            self._send_json_response({'ok': True})
        except Exception:
            pass
        threading.Thread(target=_graceful_exit, daemon=True,
                         name='graceful-exit').start()

    def guess_type(self, path):
        """★ MIME 强制映射：Windows/PyInstaller 下 Python mimetypes 可能未注册
        .mjs（乃至 .js/.css）扩展 → 回落 text/plain，导致 <script type="module">
        被浏览器按 MIME 拒绝、整条模块链不执行，应用卡死启动屏（实测根因）。
        前端资源走本机 8001，必须显式声明正确 MIME 才能跑 ESM。"""
        ext = os.path.splitext(path)[1].lower()
        if ext == '.mjs':
            return 'application/javascript; charset=utf-8'
        if ext == '.js':
            return 'application/javascript; charset=utf-8'
        if ext == '.css':
            return 'text/css; charset=utf-8'
        if ext == '.html':
            return 'text/html; charset=utf-8'
        return super().guess_type(path)

    def _handle_cover_query(self):
        """全网补封面：网易云搜索为主，QQ 兜底，返回 {ok, cover}。"""
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        query = ('%s %s' % ((q.get('title') or [''])[0], (q.get('artist') or [''])[0])).strip()
        title_only = (q.get('title') or [''])[0].strip()
        if not query:
            return {'ok': False, 'err': '缺少关键词', 'cover': ''}
        import urllib.request as _ur
        hdrs = {'User-Agent': UA_DESKTOP, 'Referer': 'https://music.163.com/'}
        # 1) 网易云
        for s_query in ('"%s"' % query, query, title_only):
            try:
                url = ('https://music.163.com/api/search/get?s=%s&type=1&limit=8&offset=0'
                       % urllib.parse.quote(s_query))
                req = _ur.Request(url, headers=hdrs)
                with _ur.urlopen(req, timeout=8) as r:
                    d = json.loads(r.read().decode('utf-8', 'replace'))
                songs = (d.get('result') or {}).get('songs') or []
                for one in songs[:8]:
                    pic = (((one or {}).get('album') or {}).get('picUrl')) or ''
                    if pic:
                        return {'ok': True, 'cover': pic}
            except Exception:
                continue
        # 2) QQ（走自建 vendor /getSearchByKey，返回 albummid 拼封面）
        try:
            import selfhost_service
            for s_query in ('"%s"' % query, query):
                st, parsed, _ = selfhost_service.proxy_drop_in(
                    'qq', 'GET', '/getSearchByKey?key=%s' % urllib.parse.quote(s_query))
                lst = (((((parsed or {}).get('response') or {}).get('data') or {}).get('song') or {}).get('list')) or []
                for one in lst[:5]:
                    am = ((one or {}).get('albummid')) or ''
                    if am:
                        return {'ok': True, 'cover': 'https://y.gtimg.cn/music/photo_new/T002R300x300M000%s.jpg' % am}
        except Exception:
            pass
        return {'ok': False, 'err': '未找到封面', 'cover': ''}

    def do_GET(self):
        # 构建版本信息查询：/api/version 或 /version.json
        if self.path in ('/api/version', '/version.json', '/build_info.json'):
            self._handle_version_api()
            return

        # 优雅退出：/api/shutdown（Tauri 关窗/网页版退出时通知，触发本进程清理副进程后退出）
        if self.path.startswith('/api/shutdown'):
            self._handle_shutdown()
            return

        # 代理请求：/proxy?url=<编码后的URL>
        if self.path.startswith('/proxy?url='):
            self._handle_proxy()
            return
        
        # 本地音乐列表：/api/local-music/list
        if self.path.startswith('/api/local-music/list'):
            self._send_json_response(local_music_server.list_local_songs())
            return
        # ★ 全网补封面：/api/cover?title=&artist=（网易云优先，QQ 兜底）
        if self.path.startswith('/api/cover'):
            self._send_json_response(self._handle_cover_query())
            return

        # 本地字体列表：/api/font/list
        if self.path.startswith('/api/font/list'):
            self._send_json_response(local_music_server.list_local_fonts())
            return

        # 用户全量配置：/api/config/load
        if self.path.startswith('/api/config/load'):
            self._send_json_response(local_music_server.load_user_config())
            return

        # 听歌识曲 isrc 本地化缓存：/api/recognize/cache
        if self.path.startswith('/api/recognize/cache'):
            self._send_json_response(local_music_server.load_recognize_cache())
            return

        # 在线音频流式代理：/api/audio/stream?url=<URL>&songId=<ID>
        if self.path.startswith('/api/audio/stream'):
            self._handle_audio_stream()
            return

        # 在线音频播放性校验：/api/audio/check?url=<URL>&songId=<ID>
        # 轻量探测目标URL是否真的可播（读首2KB即断），用于取链结果的前置过滤
        if self.path.startswith('/api/audio/check'):
            self._handle_audio_check()
            return

        # 咪咕音乐源：/api/migu/search?keyword=<关键词> / /api/migu/url?contentId=&copyrightId=
        if self.path.startswith('/api/migu/'):
            self._handle_migu()
            return

        # QQ音乐解析池：/api/qq/resolve?mid=<songMid>&dur=<官方时长秒>  (debug: &stats=1)
        if self.path.startswith('/api/qq/resolve'):
            self._handle_qq_resolve()
            return

        # 聚合跨源兜底：/api/agg/resolve?title=<歌名>&artist=<歌手>  (debug: &stats=1)
        if self.path.startswith('/api/agg/resolve'):
            self._handle_agg_resolve()
            return

        # 酷我独立源：/api/kuwo/search?word=&num= | /api/kuwo/url?id=&q= | /api/kuwo/pic?id=
        if self.path.startswith('/api/kuwo/'):
            self._handle_kuwo()
            return

        # 榜单代理：/api/rank/qq | /api/rank/kugou | /api/rank/ncm[?id=榜单id]
        if self.path.startswith('/api/rank/'):
            self._handle_rank()
            return

        # 自建音乐服务副进程：/api/selfhost/<platform>/<action>
        if self.path.startswith('/api/selfhost/'):
            self._handle_selfhost('GET')
            return

        # Aria 应用图标：从 src-tauri/icons 目录提供（标题栏 Logo / favicon 用）
        if self.path.startswith('/icons/'):
            icons_dir = os.path.join(_PROJECT_DIR, 'src-tauri', 'icons')
            name = os.path.basename(urllib.parse.unquote(self.path.split('?', 1)[0]))
            ipath = os.path.join(icons_dir, name)
            if os.path.isfile(ipath):
                self._serve_file_with_range(ipath)
                return
            self.send_error(404, "Icon not found")
            return

        # ★ 本地音乐静态资源（音频/封面/歌词）：web 目录外的 local_music/ 需显式映射
        # （DIRECTORY 指向 web/，translate_path 无法命中项目根下的 local_music/）
        if self.path.startswith('/local_music/'):
            path_unescaped = urllib.parse.unquote(self.path.split('?', 1)[0])
            rel = path_unescaped[len('/local_music/'):]
            # 防御路径穿越：只允许两层（文件夹名/文件名）
            parts = [p for p in rel.split('/') if p and p not in ('.', '..')][:2]
            if len(parts) == 2:
                lm_path = os.path.join(local_music_server.LOCAL_MUSIC_DIR, *parts)
                if os.path.isfile(lm_path):
                    self._serve_file_with_range(lm_path)
                    return
            self.send_error(404, "Local music file not found")
            return

        # 静态文件或音频文件请求（支持 Range 206 断点与时间轴拖拽跳转）
        filepath = self.translate_path(self.path)
        if os.path.isfile(filepath):
            self._serve_file_with_range(filepath)
            return

        # 目录等其他请求
        super().do_GET()

    def _handle_version_api(self):
        """返回服务端构建与版本信息"""
        base_dir = os.path.dirname(os.path.abspath(__file__))
        ver_file = os.path.join(base_dir, 'version.json')
        if os.path.exists(ver_file):
            try:
                with open(ver_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                self._send_json_response(data)
                return
            except Exception:
                pass
        self._send_json_response({"server_version": "2.0.0", "tauri_supported": True})

    def _serve_file_with_range(self, path, total_override=None, content_type=None):
        """支持 HTTP 206 Partial Content (Range) 断点与时间轴拖拽。
        total_override: 部分缓存(.tmp)直读时传入 .meta 记录的真实文件总长，
        使浏览器的 Content-Range 分母=真实长度（时间↔字节映射），缺省以本地文件大小为准
        content_type: 音频直读时传入 .meta 记录的上游真实 Content-Type（ogg/flac 等），
        避免 .mp3 扩展名导致 audio/mpeg 与真实容器不符、浏览器解码循环停滞"""
        if not os.path.exists(path) or os.path.isdir(path):
            self.send_error(404, "File not found")
            return

        ctype = content_type or self.guess_type(path)
        file_size = os.path.getsize(path)
        total_size = file_size
        if total_override and total_override > file_size:
            total_size = total_override
        range_header = self.headers.get('Range')
        # 代码文件禁用启发式缓存：强制浏览器重新拉取，避免改码后仍运行旧缓存（音频/字体等大文件不受影响）
        no_cache_ext = os.path.splitext(path)[1].lower() in ('.js', '.css', '.html', '.htm', '.json', '.svg', '.mjs')

        if range_header and range_header.startswith('bytes='):
            # 解析 Range: bytes=start-end
            ranges = range_header[6:].split('-')
            start_str = ranges[0].strip()
            end_str = ranges[1].strip() if len(ranges) > 1 else ''

            try:
                if start_str and end_str:
                    start = int(start_str)
                    end = min(int(end_str), total_size - 1)
                elif start_str:
                    start = int(start_str)
                    end = total_size - 1
                elif end_str:
                    start = max(0, total_size - int(end_str))
                    end = total_size - 1
                else:
                    start = 0
                    end = total_size - 1
            except ValueError:
                start = 0
                end = total_size - 1

            if start >= total_size or start > end:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{total_size}')
                self.end_headers()
                return

            # ★ 部分缓存直读：end 封顶到本地实际字节数，绝不虚构超出已下载范围的数据
            end = min(end, file_size - 1)
            if end < start:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{total_size}')
                self.end_headers()
                return

            length = end - start + 1
            self.send_response(206)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Range', f'bytes {start}-{end}/{total_size}')
            self.send_header('Content-Length', str(length))
            self.send_header('Accept-Ranges', 'bytes')
            if no_cache_ext:
                self.send_header('Cache-Control', 'no-cache')
            self.send_header('Access-Control-Allow-Headers', '*')
            self.send_header('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges')
            self.end_headers()

            try:
                with open(path, 'rb') as f:
                    f.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk_size = min(65536, remaining)
                        chunk = f.read(chunk_size)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        self.wfile.flush()
                        remaining -= len(chunk)
            except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
                pass
        else:
            # 完整文件请求，附带 Accept-Ranges 允许后续拖拽
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(file_size))
            self.send_header('Accept-Ranges', 'bytes')
            if no_cache_ext:
                self.send_header('Cache-Control', 'no-cache')
            self.send_header('Access-Control-Allow-Headers', '*')
            self.send_header('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges')
            self.end_headers()

            try:
                with open(path, 'rb') as f:
                    shutil.copyfileobj(f, self.wfile)
                self.wfile.flush()
            except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
                pass

    def _open_upstream_continuation(self, target_url, start_byte, result):
        """后台线程：预连接上游续流（Range 从残片末尾起），结果写入 result dict。
        只建立连接+读响应头，不读 body——body 由主线程接力转发，无并发读写问题。"""
        try:
            _up_host = urllib.parse.urlparse(target_url).netloc.lower()
            headers = {
                'User-Agent': UA_DESKTOP,
                'Accept': '*/*',
                'Range': f'bytes={start_byte}-',
            }
            if 'qq.com' in _up_host:
                headers['Referer'] = 'https://y.qq.com/'
            req = urllib.request.Request(target_url, headers=headers)
            result['resp'] = urllib.request.urlopen(req, timeout=3)
        except Exception as e:
            result['err'] = str(e)[:120]
        finally:
            result['done'] = True

    def _try_seamless_tmp_stream(self, tmp_cache, tmp_size, tmp_total, target_url):
        """将 .tmp 残片与上游续流拼为单个 206 响应，从头播放时不再出现断档。
        - 立即发出响应头与本地残片（保住秒开），同时后台预连接上游续传；
        - 残片发完后若上游已就绪，无缝接力转发至 meta 总长；
        - 未就绪/上游未按续传响应(非206或起点不符)则提前收尾——浏览器会按已消费
          字节重新发起续段 Range，属于标准恢复，不会损坏流。
        返回 True 表示该响应已处理完毕；False 表示无法拼接，调用方退回普通路径。"""
        result = {'resp': None, 'err': '', 'done': False}
        try:
            th = threading.Thread(target=self._open_upstream_continuation,
                                  args=(target_url, tmp_size, result), daemon=True)
            th.start()
        except Exception as e:
            print(f"[Seamless] 续流传线程启动失败: {e}")
            return False

        try:
            self.send_response(206)
            # 用 .meta 记录的真实 Content-Type（ogg/flac 等），不能用 audio/mpeg
            # 硬编码：MIME 突变会让浏览器解码失败，无缝续流瞬间变 stalled 死循环
            self.send_header('Content-Type', _read_meta_ctype(tmp_cache[:-len('.tmp')]) or 'audio/mpeg')
            self.send_header('Content-Range', f'bytes 0-{tmp_total - 1}/{tmp_total}')
            self.send_header('Content-Length', str(tmp_total))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Access-Control-Allow-Headers', '*')
            self.send_header('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges')
            self.end_headers()
        except Exception:
            return True

        # 1) 本地残片（瞬时送出，浏览器立即可播）
        sent = 0
        try:
            with open(tmp_cache, 'rb') as f:
                while sent < tmp_size:
                    chunk = f.read(65536)
                    if not chunk:
                        break
                    chunk = chunk[: tmp_size - sent]
                    self.wfile.write(chunk)
                    self.wfile.flush()
                    sent += len(chunk)
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            return True
        except Exception as e:
            print(f"[Seamless] 本地残片发送异常: {str(e)[:120]}")
            return True

        # 2) 等上游预连接（残片播完前留给 CDN 的连接窗口，最多 1.2s）
        if not result['done']:
            try:
                th.join(1.2)
            except Exception:
                pass
        resp = result.get('resp')
        if resp is None:
            return True  # 未连上：提前收尾，浏览器将重发续段请求
        try:
            crange = resp.headers.get('Content-Range', '') or ''
            start_str = crange.split(' ')[-1].split('/')[0].split('-')[0] if crange else ''
            if resp.status != 206 or start_str != str(tmp_size):
                print(f"[Seamless] 上游未按续传响应 (status={resp.status}, CR='{crange[:40]}')，提前收尾")
                return True
            # 上游读超时 5 秒：静默不要再等，提前收尾交浏览器续段（避免残片后无限挂起）
            try:
                _fp = getattr(resp, 'fp', None)
                _raw = getattr(_fp, 'raw', None) if _fp is not None else None
                _sock = getattr(_raw, '_sock', None) if _raw is not None else getattr(_fp, '_sock', None)
                if _sock is not None:
                    _sock.settimeout(5.0)
            except Exception:
                pass
            remaining = tmp_total - sent
            while remaining > 0:
                try:
                    chunk = resp.read(min(65536, remaining))
                except Exception:
                    break  # 上游静默超时：提前收尾，浏览器重发续段
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
                sent += len(chunk)
                remaining -= len(chunk)
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            pass
        except Exception as e:
            print(f"[Seamless] 上游续流传输出错: {str(e)[:120]}")
        finally:
            try:
                resp.close()
            except Exception:
                pass
        return True

    def _handle_audio_stream(self):
        """在线音频流式代理：边从上游下载边转发给浏览器（首包不必等整首下载完）。

        浏览器首次请求通常带 Range: bytes=0-，我们实时回源并边读边写响应，
        使 canplay 在得到开头若干字节即触发，避免此前"整首落盘后才返回"的秒级冷启动。
        - 首次从头拉取（bytes=0-）时同时写 .tmp 缓存，完整读完才 replace 为正式缓存。
        - seek / 中途接续（Range > 0）若本地缓存不完整，则实时回源对应区间，不依赖本地文件。
        - 本地缓存已完整存在时，直接走 _serve_file_with_range（秒开且支持拖拽）。
        """
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        target_url = params.get('url', [''])[0]
        song_id = params.get('songId', [''])[0]
        # nc=1 (no-cache)：前端播放失败重试时强制绕过全部本地缓存（完整缓存+.tmp残片），
        # 直接回源重新拉流，杜绝"旧残片/旧URL反复导致连续play失败"的循环
        no_cache = params.get('nc', [''])[0] == '1'
        if not target_url or not song_id:
            self.send_error(400, "Missing url or songId")
            return

        clean_id = local_music_server.sanitize_filename(str(song_id))
        cache_path = os.path.join(local_music_server.AUDIO_CACHE_DIR, f"{clean_id}.mp3")

        range_header = self.headers.get('Range', '')
        start = 0
        if range_header and range_header.startswith('bytes='):
            try:
                rs = range_header[6:].split('-', 1)[0].strip()
                if rs:
                    start = int(rs)
            except (ValueError, IndexError):
                start = 0

        # 本地缓存已完整存在：直接按 Range 从本地文件服务（秒开且支持任意拖拽）
        # .ok 哨兵记录晋升时的字节数，双校验；旧损坏缓存(无哨兵)会被自动绕过并重建
        tmp_cache = f"{cache_path}.tmp"
        ok_mark = cache_path + '.ok'

        def _cache_valid():
            try:
                if not os.path.exists(cache_path) or os.path.getsize(cache_path) <= 10240:
                    return False
                if not os.path.exists(ok_mark):
                    return False
                with open(ok_mark, 'r') as f:
                    return f.read().strip() == str(os.path.getsize(cache_path))
            except Exception:
                return False

        if not no_cache and _cache_valid() and _read_meta_ctype(cache_path):
            local_music_server.cleanup_audio_cache(keep_id=clean_id)
            dbg(f"[{clean_id}] Range='{range_header}' -> 完整缓存直读")
            self._serve_file_with_range(cache_path, content_type=_read_meta_ctype(cache_path))
            return

        # ★ seek 提速：若目标区间已在临时缓存内(正边下边转发的 .tmp)，直接从本地区间服务，
        #   避免为中途拖拽重新向上游 CDN 回源(秒级延迟/卡顿元凶)。超出已下载范围才回源。
        #   必须持有 .meta 记录的真实总长才能直读：否则 .tmp 被当成完整文件服务，
        #   浏览器据此算出极短的时长(例如3分钟的歌变成43秒)且无法继续续传。
        #   无总长记录的 .tmp(例如上游chunked响应)一律回源重新获取(自动整首重下并补记)。
        tmp_cache = f"{cache_path}.tmp"
        # ★ 无真实 Content-Type 的旧残片(升级前生成)不予直读：MIME 不对必然解码失败，
        #   同时级联删除旧 .tmp，强制整首重新下载——绝不能让"旧残片+新上游"异源拼接
        if not no_cache and _read_meta_ctype(cache_path).strip() == '' and os.path.exists(tmp_cache):
            try:
                os.remove(cache_path + '.meta')
            except Exception:
                pass
            try:
                os.remove(tmp_cache)
            except Exception:
                pass
            dbg(f"[{clean_id}] Range='{range_header}' 旧缓存无ctype，删残片回源重建")
        # ★ 安全策略：只有通过 .ok 哨兵校验的【完整缓存】才允许直读。
        #   未完成的 .tmp 残片严禁与新流强行二进制拼接（残片拼接正是导致音频帧错位、丢句删词的元凶）。
        #   若无完整缓存且从头播放(start==0)，一律回源拉取纯净流，边播边由 writer 完整落盘。
        if start == 0 and os.path.exists(tmp_cache) and not _cache_valid():
            # 从头播放时如果遗留有未完成的旧残片，清除它以保证新下载纯净完整
            if time.time() - os.path.getmtime(tmp_cache) > 10:
                try:
                    os.remove(tmp_cache)
                except Exception:
                    pass

        # Referer 按上游主机区分：QQ系CDN需要 y.qq.com，其余源带上QQ Referer 反而可能被拒
        _up_host = urllib.parse.urlparse(target_url).netloc.lower()
        _stream_headers = {
            'User-Agent': UA_DESKTOP,
            'Accept': '*/*',
            'Range': range_header or 'bytes=0-',
        }
        if 'qq.com' in _up_host:
            _stream_headers['Referer'] = 'https://y.qq.com/'
        req = urllib.request.Request(target_url, headers=_stream_headers)

        # ★ 缓存写入互斥：仅第一个从头请求担任 writer 落盘，其余并发请求只代理转发，
        #   不再触碰 .tmp —— 杜绝"截断半成品 + 交错写入 + 晋升损坏缓存"的竞态。
        is_writer = _try_claim_writer(clean_id, start, cache_path)
        handoff = False  # 断连后是否已交给后台续传线程（写入认领权随之移交）
        if is_writer and os.path.exists(tmp_cache):
            try:
                # 仅清理异常退出遗留的陈旧半成品（60s 无写入）
                if time.time() - os.path.getmtime(tmp_cache) > 60:
                    os.remove(tmp_cache)
            except Exception:
                pass

        try:
            resp = urllib.request.urlopen(req, timeout=20)
            try:
                status = resp.status if resp.status in (200, 206) else 200
                # ★ 净化上游 Content-Type：QQ系CDN可能返回 urlencoded/octet-stream
                # 等错误头，直接透传会让浏览器 MIME 不匹配而无法解码(1~4秒停滞)。统一
                # 走 _sanitize_audio_ctype(合法audio头→URL扩展名→audio/mpeg兜底)。
                ctype = _sanitize_audio_ctype(target_url, resp.headers.get('Content-Type', ''))
                content_range = resp.headers.get('Content-Range', '')
                content_length = resp.headers.get('Content-Length', '')

                # 完整性基准：优先 Content-Range 总长，其次 200 响应的 Content-Length
                expected_total = None
                try:
                    if content_range and '/' in content_range:
                        t = int(content_range.rsplit('/', 1)[1])
                        if t > 0:
                            expected_total = t
                    elif status == 200 and content_length:
                        t = int(content_length)
                        if t > 0:
                            expected_total = t
                except Exception:
                    expected_total = None
                # ★ 记录真实文件总长：后续 seek 直读 .tmp 部分缓存时用它对浏览器
                # 声明完整长度，时间→字节映射秒级完成（拖拽秒开的必要条件）。
                # 同时记录上游真实 Content-Type：本地直读时若返回 guess_type(.mp3)
                # 的 audio/mpeg，与真实容器(ogg/flac等)不符会导致解码失败循环停滞
                if expected_total:
                    _write_meta_audio(cache_path, expected_total, target_url, ctype)

                dbg(f"[{clean_id}] 回源 Range='{range_header}' writer={is_writer} "
                    f"up={status} CL={content_length} CR='{content_range[:50]}'")

                self.send_response(status)
                self.send_header('Content-Type', ctype)
                if content_range:
                    self.send_header('Content-Range', content_range)
                if content_length:
                    self.send_header('Content-Length', content_length)
                self.send_header('Accept-Ranges', 'bytes')
                self.send_header('Access-Control-Allow-Headers', '*')
                self.send_header('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges')
                self.end_headers()

                # 上游响应体拉流：socket 读超时 5 秒——上游"连接活着但不发数据"时
                # 立即断开交浏览器续段，避免浏览器在 ~1 秒处长时间的无声停滞等待。
                try:
                    _fp = getattr(resp, 'fp', None)
                    _raw = getattr(_fp, 'raw', None) if _fp is not None else None
                    _sock = getattr(_raw, '_sock', None) if _raw is not None else getattr(_fp, '_sock', None)
                    if _sock is not None:
                        _sock.settimeout(5.0)
                except Exception:
                    pass

                out = open(tmp_cache, 'wb') if is_writer else None
                completed = True
                eof_clean = False       # 干净EOF(非超时)且未到总长 → 上游截断，可续传
                total_sent = 0
                cont_attempts = 0
                try:
                    while True:
                        try:
                            chunk = resp.read(65536)
                        except Exception as e_read:
                            # 上游静默超时：数据已停滞，不再续传，直接断开交浏览器续段
                            dbg(f"[{clean_id}] 上游读异常({type(e_read).__name__}) @sent={total_sent}，断开交浏览器续段")
                            break
                        if not chunk:
                            eof_clean = True
                            break
                        try:
                            self.wfile.write(chunk)
                            self.wfile.flush()
                        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError) as e_disc:
                            completed = False
                            dbg(f"[{clean_id}] 客户端断开({type(e_disc).__name__}) @sent={total_sent}")
                            break
                        if out is not None:
                            out.write(chunk)
                        total_sent += len(chunk)
                    # ★ 上游提前断流自愈：干净EOF且声明总长 > 实际收满时，立即以
                    # bytes=<已收字节> 重新请求上游续传，把"断头流"拼进同一个响应。
                    # 否则浏览器只会拿到残缺流（在约1~2秒缓存边界耗尽缓冲），后续
                    # 陷入"停滞→回退→复用旧残片→再停滞"的死循环。
                    while completed and eof_clean and expected_total and total_sent < expected_total and cont_attempts < 3:
                        cont_attempts += 1
                        print(f"[AudioStream] 上游提前断流(已收{total_sent}/{expected_total})，自动续传第{cont_attempts}次")
                        retry_hdrs = dict(_stream_headers)
                        retry_hdrs['Range'] = f'bytes={total_sent}-'
                        try:
                            req2 = urllib.request.Request(target_url, headers=retry_hdrs)
                            with urllib.request.urlopen(req2, timeout=20) as resp2:
                                try:
                                    _fp2 = getattr(resp2, 'fp', None)
                                    _raw2 = getattr(_fp2, 'raw', None) if _fp2 is not None else None
                                    _sock2 = getattr(_raw2, '_sock', None) if _raw2 is not None else getattr(_fp2, '_sock', None)
                                    if _sock2 is not None:
                                        _sock2.settimeout(5.0)
                                except Exception:
                                    pass
                                if resp2.status != 206:
                                    print(f"[AudioStream] 续传被拒(status={resp2.status})，保留残片交浏览器续段")
                                    break
                                cr2 = resp2.headers.get('Content-Range', '') or ''
                                try:
                                    rs = int(cr2.split(' ')[-1].split('/')[0].split('-')[0])
                                except Exception:
                                    rs = -1
                                if rs < 0 or rs != total_sent:
                                    print(f"[AudioStream] 续传起点不符(start={rs}!=期望{total_sent})，保留残片")
                                    break
                                while True:
                                    try:
                                        ch = resp2.read(65536)
                                    except Exception:
                                        break   # 上游静默：断开交浏览器续段
                                    if not ch:
                                        break
                                    try:
                                        self.wfile.write(ch)
                                        self.wfile.flush()
                                    except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
                                        completed = False
                                        break
                                    if out is not None:
                                        out.write(ch)
                                    total_sent += len(ch)
                                if not completed:
                                    break
                        except Exception as e:
                            print(f"[AudioStream] 续传失败({total_sent}): {str(e)[:120]}")
                            break
                finally:
                    if out is not None:
                        out.close()

                got = total_sent
                if os.path.exists(tmp_cache):
                    got = os.path.getsize(tmp_cache)
                if is_writer and completed and got > 1024 and (expected_total is None or got == expected_total):
                    try:
                        os.replace(tmp_cache, cache_path)
                    except Exception as e:
                        print(f"[AudioStream] 缓存落盘失败: {e}")
                    else:
                        try:
                            with open(ok_mark, 'w') as f:
                                f.write(str(got))
                        except Exception:
                            pass
                        local_music_server.cleanup_audio_cache(keep_id=clean_id)
                elif is_writer and not completed and got > 1024:
                    # ★ 客户端断开：不再丢弃半成品。保留 .tmp 供后续 seek 直读（秒开），
                    # 并启动后台线程把余量下载完再晋升正式缓存——否则每次跳转都得
                    # 整首重新下载，就是"跳转要加载好几秒才能继续播放"的元凶。
                    # 写入认领权移交后台线程，防并发截断。
                    handoff = True
                    _launch_bg_audio_download(clean_id, cache_path, tmp_cache, ok_mark,
                                              resp, expected_total)
                elif is_writer and os.path.exists(tmp_cache):
                    # 已完整读完但大小与上游不符（上游截断）或近乎空文件：
                    # 保留实质部分供 seek 直读，只丢弃垃圾大小的残留
                    if got <= 1024:
                        try:
                            os.remove(tmp_cache)
                        except Exception:
                            pass
                dbg(f"[{clean_id}] 请求结束 sent={total_sent}/{expected_total} "
                    f"completed={completed} eof={eof_clean} writer={is_writer} handoff={handoff}")
            finally:
                # ★ resp 生命周期：移交给后台续传线程(handoff)时绝不能在此关闭——
                #   此前用 with urlopen(...) 语法，块退出即 close()，后台线程第一个
                #   read 就抛异常死亡，.tmp 永远冻结在断开时刻(128KB)，后续播放
                #   只能反复撞残片边界。未移交时才正常关闭。
                if not handoff:
                    try:
                        resp.close()
                    except Exception:
                        pass
        except Exception as e:
            print(f"[AudioStream] 流式获取音频失败 ({song_id}): {e}")
            try:
                self.send_error(502, "Failed to stream audio")
            except Exception:
                pass
        finally:
            if is_writer and not handoff:
                with _AUDIO_WRITERS_LOCK:
                    _AUDIO_CACHE_WRITERS.discard(clean_id)

    def _handle_audio_check(self):
        """在线音频播放性校验：本地有完整缓存直接 ok；否则探测目标URL首块（读2KB即断）"""
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        target_url = params.get('url', [''])[0]
        song_id = params.get('songId', [''])[0]
        referer = params.get('referer', [''])[0]

        # 本地已有该歌完整缓存（哨兵校验通过）→ 无需探测，直接可播
        if song_id:
            clean_id = local_music_server.sanitize_filename(str(song_id))
            cache_path = os.path.join(local_music_server.AUDIO_CACHE_DIR, f"{clean_id}.mp3")
            ok_mark = cache_path + '.ok'
            valid = False
            try:
                if os.path.exists(cache_path) and os.path.getsize(cache_path) > 10240 and os.path.exists(ok_mark):
                    with open(ok_mark, 'r') as f:
                        valid = f.read().strip() == str(os.path.getsize(cache_path))
            except Exception:
                valid = False
            if valid:
                self._send_json_response({'ok': True, 'cached': True})
                return

        if not target_url:
            self._send_json_response({'ok': False, 'err': 'missing url'})
            return

        extra = {'Referer': referer} if referer else None
        result = _probe_audio_url(target_url, extra)
        # 试听预览判定：期望整曲时长 + 探测到 total 明显过短 → 视为不可播，让前端回退其他源
        expected_sec = params.get('expectedSec', [''])[0]
        if result.get('ok') and expected_sec:
            try:
                if _is_preview_probe(result, int(expected_sec)):
                    result['ok'] = False
                    result['preview'] = True
            except Exception:
                pass
        print(f"[AudioCheck] {'OK' if result.get('ok') else 'FAIL'} {result.get('status', '')} total={result.get('total', 0)} {(target_url or '')[:80]}")
        self._send_json_response(result)

    def _handle_migu(self):
        """咪咕音乐源：/api/migu/search 搜索 / /api/migu/url 取链（官方接口+免登录兜底）"""
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)

        if self.path.startswith('/api/migu/search'):
            keyword = (params.get('keyword', [''])[0] or '').strip()
            if not keyword:
                self._send_json_response({'ok': False, 'err': 'missing keyword'})
                return
            q = urllib.parse.urlencode({
                'text': keyword, 'pageNo': 1, 'pageSize': 20, 'isCopyright': 1, 'sort': 1,
                'searchSwitch': '{"song":1,"album":0,"singer":0,"tagSong":1,"mvSong":0,"bestShow":1}'})
            try:
                raw, _hh = _http_get_bytes(
                    'https://c.musicapp.migu.cn/v1.0/content/search_all.do?' + q,
                    _migu_headers())
                data = json.loads(raw.decode('utf-8'))
                results = (data.get('songResultData') or {}).get('result') or []
                songs = []
                for it in results:
                    try:
                        cid = str(it.get('contentId') or '')
                        cpr = str(it.get('copyrightId') or '')
                        if not cid or not cpr:
                            continue
                        songs.append({
                            'contentId': cid,
                            'copyrightId': cpr,
                            'name': it.get('name') or it.get('songName') or '',
                            'singer': '/'.join(s.get('name', '') for s in (it.get('singers') or []) if isinstance(s, dict)),
                            'album': it.get('albumName') or '',
                        })
                    except Exception:
                        continue
                print(f"[Migu] search '{keyword}' -> {len(songs)} 首")
                self._send_json_response({'ok': True, 'songs': songs})
            except Exception as e:
                print(f"[Migu] search 失败: {e}")
                self._send_json_response({'ok': False, 'err': str(e)[:200]})
            return

        # /api/migu/url
        content_id = (params.get('contentId', [''])[0] or '').strip()
        copyright_id = (params.get('copyrightId', [''])[0] or '').strip()
        if not content_id or not copyright_id:
            self._send_json_response({'ok': False, 'err': 'missing contentId/copyrightId'})
            return

        url = None
        quality = ''
        h2 = _migu_headers({'Content-Type': 'application/json;charset=UTF-8',
                            'birth': 'h5page', 'signature': '1'})
        for ft in ('HQ', 'SQ', 'ZQ24', 'PQ'):
            qp = urllib.parse.urlencode([
                ('contentId', content_id), ('copyrightId', copyright_id),
                ('resourceType', '2'), ('netType', '01'), ('toneFlag', ft),
                ('scene', ''), ('lowerQualityContentId', content_id)])
            try:
                raw2, hh2 = _http_get_bytes(
                    'https://c.musicapp.migu.cn/strategy/listen-url/h5/v2.4?' + qp, h2)
                dj = _migu_decrypt(raw2, hh2)
                u = ((dj.get('data') or {}).get('url')) or ''
                if u:
                    st = _probe_audio_url(u)
                    if st.get('ok'):
                        url, quality = u, ft
                        break
                    print(f"[Migu] listen-url {ft} 有URL但探测失败: {st.get('status')} {st.get('err', '')[:80]}")
            except Exception as e2:
                print(f"[Migu] listen-url {ft} err: {str(e2)[:120]}")

        # 免登录兜底模板（实测独立可播）
        if not url:
            fb = (f'https://app.pd.nf.migu.cn/MIGUM3.0/v1.0/content/sub/listenSong.do?channel=mx'
                  f'&copyrightId={copyright_id}&contentId={content_id}&toneFlag=PQ&resourceType=2'
                  f'&userId=15548614588710179085069&netType=00')
            st = _probe_audio_url(fb)
            if st.get('ok'):
                url, quality = fb, 'PQ-fallback'

        print(f"[Migu] url {content_id} -> {'OK ' + quality if url else 'FAILED'}")
        self._send_json_response({'ok': bool(url), 'url': url or '', 'quality': quality})

    def _handle_qq_resolve(self):
        """QQ音乐解析池：多API竞速 + 分层降级 + 防试听校验 + 15min缓存（详见 qq_resolver.py）"""
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        if params.get('stats', [''])[0] == '1':
            self._send_json_response({'ok': True, 'health': qq_resolver.stats(),
                                      'cache_size': len(qq_resolver._CACHE)})
            return
        mid = (params.get('mid', [''])[0] or '').strip()
        quality = (params.get('q', [''])[0] or '').strip()
        # skip_cache=1：播放失败重试时前端强制重新解析（服务端成功后会写入新缓存）
        skip_cache = params.get('skip_cache', [''])[0] == '1'
        try:
            dur = float(params.get('dur', ['0'])[0] or 0)
        except ValueError:
            dur = 0.0
        if not mid:
            self._send_json_response({'ok': False, 'err': 'missing mid'})
            return
        result = qq_resolver.resolve(mid, dur=dur or None, quality=quality or None,
                                     skip_cache=skip_cache)
        self._send_json_response(result)

    def _handle_agg_resolve(self):
        """聚合跨源兜底：gdstudio 多源（酷我→网易）搜索+取链+校验（详见 agg_resolver.py）"""
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        if params.get('stats', [''])[0] == '1':
            self._send_json_response({'ok': True, 'health': agg_resolver.stats(),
                                      'cache_size': len(agg_resolver._CACHE)})
            return
        title = (params.get('title', [''])[0] or '').strip()
        artist = (params.get('artist', [''])[0] or '').strip()
        if not title:
            self._send_json_response({'ok': False, 'err': 'missing title'})
            return
        result = agg_resolver.resolve_same_song(title, artist)
        print(f"[Agg] {title} / {artist or '?'} -> "
              f"{'OK ' + result.get('provider', '') + ' ' + result.get('song', '') if result.get('ok') else result.get('err')}"
              f"{' [歌手不符]' if result.get('artist_mismatch') else ''}")
        self._send_json_response(result)

    def _handle_kuwo(self):
        """酷我独立源（gdstudio 通道，详见 agg_resolver.py）：
        /api/kuwo/search?word=<关键词>&num=<条数>
        /api/kuwo/url?id=<歌曲id>&q=<master|flac|320|128>
        /api/kuwo/pic?id=<歌曲id>"""
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        action = parsed.path.rsplit('/', 1)[-1]

        if action == 'search':
            word = (params.get('word', [''])[0] or '').strip()
            try:
                num = min(int(params.get('num', ['99'])[0] or 99), 99)   # gdstudio 实测上限 99
            except ValueError:
                num = 99
            try:
                page = max(1, int(params.get('page', ['1'])[0] or 1))    # 真实后端翻页
            except ValueError:
                page = 1
            if not word:
                self._send_json_response({'ok': False, 'err': 'missing word'})
                return
            try:
                items = agg_resolver.search_kuwo(word, num, page)
            except Exception as e:
                self._send_json_response({'ok': False, 'err': f'{type(e).__name__}: {e}'})
                return
            # 归一化为前端搜索结果通用字段（与 vkeys 条目同构）；cover 来自 pic_id 拼接
            out = [{'song': it['name'], 'singer': it['artist'], 'id': str(it['id']),
                    'source': 'kuwo', 'interval': '',
                    'cover': it.get('cover', ''), 'album': it.get('album', '')} for it in items]
            print(f"[Kuwo] 搜索 '{word}' -> {len(out)} 条")
            self._send_json_response({'ok': True, 'list': out})
            return

        if action == 'url':
            sid = (params.get('id', [''])[0] or '').strip()
            quality = (params.get('q', [''])[0] or '').strip()
            if not sid:
                self._send_json_response({'ok': False, 'err': 'missing id'})
                return
            result = agg_resolver.resolve_kuwo_song(sid, quality=quality or None)
            print(f"[Kuwo] 取链 {sid}(q={quality or 'auto'}) -> "
                  f"{'OK br=' + str(result.get('quality')) if result else '未命中'}")
            self._send_json_response(result or {'ok': False, 'err': 'no_url'})
            return

        if action == 'pic':
            sid = (params.get('id', [''])[0] or '').strip()
            url = agg_resolver.kuwo_pic(sid) if sid else ''
            self._send_json_response({'ok': bool(url), 'url': url})
            return

        if action == 'lyric':
            sid = (params.get('id', [''])[0] or '').strip()
            lrc = agg_resolver.kuwo_lyric(sid) if sid else ''
            self._send_json_response({'ok': bool(lrc), 'lrc': lrc})
            return

        if action == 'detail':
            sid = (params.get('id', [''])[0] or '').strip()
            detail = agg_resolver.kuwo_detail(sid) if sid else {'ok': False, 'err': 'missing id'}
            self._send_json_response(detail)
            return

        self._send_json_response({'ok': False, 'err': 'unknown action'})

    def _handle_selfhost(self, method):
        """自建音乐服务副进程代理：/api/selfhost/<platform>/<action>
        action: status | qr | check | logout | proxy(?path=<上游路径>)
        平台未 vendor / 端口被占用时均安全降级为 JSON 报错，不影响主服务。"""
        # 读取 POST 请求体
        body = {}
        try:
            cl = int(self.headers.get('Content-Length', 0))
            raw_body = self.rfile.read(cl) if cl > 0 else b''
            if raw_body:
                body = json.loads(raw_body.decode('utf-8'))
        except Exception:
            body = {}

        rest = self.path.split('/api/selfhost/', 1)[1].split('?', 1)[0]
        parts = [p for p in rest.split('/') if p]
        # 顶层状态：/api/selfhost/status（聚合三平台）
        if parts and parts[0] == 'status':
            self._send_json_response(selfhost_service.status_all())
            return
        if len(parts) < 2:
            self._send_json_response({'error': 'bad path'}, 400)
            return
        platform, action = parts[0], parts[1]
        if platform not in selfhost_service._SERVICES:
            self._send_json_response({'error': 'unknown platform'}, 404)
            return
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)

        if action == 'status':
            self._send_json_response(selfhost_service.status_all())
        elif action == 'qr':
            qr_type = None
            if platform == 'qq':
                qr_type = query.get('qr_type', [None])[0]
                try: qr_type = int(qr_type)
                except Exception: qr_type = None
            self._send_json_response(
                selfhost_service.get_login_qr(platform, qr_type=qr_type))
        elif action == 'check':
            key = body.get('key') or {}
            self._send_json_response(selfhost_service.poll_login(platform, key))
        elif action == 'checkin' and platform == 'kugou':
            sub = parts[2] if len(parts) > 2 else ''
            if sub == 'status':
                self._send_json_response(selfhost_service.kugou_checkin_status())
            else:
                self._send_json_response(selfhost_service.start_kugou_checkin())
        elif action == 'login' and platform == 'netease':
            mode = body.get('mode') or 'phone'
            self._send_json_response(
                selfhost_service.login_netease_account(platform, mode, body))
        elif action == 'login' and platform == 'kugou':
            # 手机号 + 短信验证码登录（绕过 v_type=38 那条路，见 selfhost_service 注释）
            self._send_json_response(
                selfhost_service.login_kugou_cellphone(
                    platform, body.get('mobile'), body.get('code')))
        elif action == 'captcha' and platform == 'kugou':
            mobile = body.get('mobile') or (query.get('mobile') or [''])[0]
            self._send_json_response(
                selfhost_service.kugou_send_captcha(platform, mobile))
        elif action == 'logout':
            self._send_json_response(selfhost_service.logout(platform))
        elif action == 'setcookie':
            self._send_json_response(
                selfhost_service.set_cookie(platform, str(body.get('cookie') or '')))
        elif action == 'proxy':
            tpath = urllib.parse.unquote((query.get('path') or ['/'])[0])
            status, parsed, raw = selfhost_service.proxy_drop_in(
                platform, method, tpath, body=(body if method == 'POST' else None))
            ctype = ('application/json; charset=utf-8'
                     if isinstance(parsed, (dict, list)) else 'text/plain; charset=utf-8')
            # ★ 错误路径必须回传响应体：_proxy_raw 失败时返回 (502, {'error': ...}, b'')，
            #   raw 为空 —— 若照旧只写 raw，客户端只拿到「502 + 0 字节」，前端只能报
            #   "HTTP 502" 而看不到「副进程未运行」这类真正原因（实测就是这样）。
            body_bytes = raw
            if not body_bytes:
                if isinstance(parsed, (dict, list)):
                    body_bytes = json.dumps(parsed, ensure_ascii=False).encode('utf-8')
                elif isinstance(parsed, str):
                    body_bytes = parsed.encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body_bytes)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body_bytes)
        else:
            self._send_json_response({'error': 'unknown action'}, 404)

    def do_POST(self):
        # 自建音乐服务副进程：/api/selfhost/<platform>/<action>
        if self.path.startswith('/api/selfhost/'):
            self._handle_selfhost('POST')
            return
        # 解析请求体 JSON
        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length) if content_length > 0 else b'{}'
        try:
            data = json.loads(post_data.decode('utf-8'))
        except Exception:
            data = {}

        try:
            if self.path == '/api/local-music/upload':
                result = local_music_server.handle_upload(data)
                self._send_json_response(result)
            elif self.path == '/api/audio/recognize':
                # 听歌识曲全流程（Shazam 声学指纹 → Vosk 语音转写+歌词反查 → ID3/文件名回退）
                result = local_music_server.handle_recognize_raw_audio(data)
                self._send_json_response(result)
            elif self.path == '/api/local-music/recognize':
                result = local_music_server.handle_recognize_song(data)
                self._send_json_response(result)
            elif self.path == '/api/local-music/save':
                result = local_music_server.handle_save_song(data)
                self._send_json_response(result)
            elif self.path == '/api/local-music/upload-custom-lrc':
                result = local_music_server.handle_upload_custom_lrc(data)
                self._send_json_response(result)
            elif self.path == '/api/local-music/delete':
                result = local_music_server.handle_delete_song(data)
                self._send_json_response(result)
            elif self.path == '/api/font/save':
                result = local_music_server.handle_save_font(data)
                self._send_json_response(result)
            elif self.path == '/api/font/delete':
                result = local_music_server.handle_delete_font(data)
                self._send_json_response(result)
            elif self.path == '/api/config/save':
                result = local_music_server.save_user_config(data)
                self._send_json_response(result)
            elif self.path == '/api/recognize/cache':
                result = local_music_server.save_recognize_cache(data)
                self._send_json_response(result)
            elif self.path == '/api/audio/cleanup':
                keep_id = data.get('keepId')
                local_music_server.cleanup_audio_cache(keep_id)
                self._send_json_response({'success': True})
            else:
                self.send_error(404, "API endpoint not found")
        except Exception as e:
            self._send_json_response({'error': str(e)}, status_code=500)

    def _send_json_response(self, data, status_code=200):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        # ★ 禁止浏览器缓存 API 响应：无此头时 Chrome 会对 GET 做启发式缓存，
        #   扫码刷新拿到缓存旧码 → 显示旧码但轮询新 key → 扫码永远"等待"。
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        """处理 CORS 预检请求"""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _handle_proxy(self):
        raw_url = self.path.split('/proxy?url=', 1)[1]
        target_url = urllib.parse.unquote(raw_url)

        # ★ 开放代理最小加固（防开放式跳板）：
        #   ① scheme 白名单：只允许 http/https，杜绝 file:// 等本地文件读取；
        #   ② 来源校验：仅放行本机页面（localhost/127.0.0.1 任一端口的 http Origin 或无 Origin 的同源请求），
        #      公网页面无法借用本机代理（防 SSRF/白嫖）。目标域名保持开放——播放链接/CDN/AMLL 为动态域名，
        #      固定白名单会误伤（2026-09 评估后选择不误伤的加固方式）。
        try:
            parsed = urllib.parse.urlparse(target_url)
            if parsed.scheme not in ('http', 'https') or not parsed.netloc:
                self.send_error(400, "proxy scheme/url rejected")
                return
            origin = self.headers.get('Origin') or ''
            if origin and not origin.startswith(('http://localhost', 'http://127.0.0.1')):
                self.send_error(403, "proxy origin rejected")
                return
        except Exception:
            self.send_error(400, "proxy url invalid")
            return

        try:
            req = urllib.request.Request(target_url, headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': '*/*',
            })
            with urllib.request.urlopen(req, timeout=15) as resp:
                content = resp.read()
                content_type = resp.headers.get('Content-Type', 'text/plain; charset=utf-8')

                self.send_response(200)
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', str(len(content)))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(content)

        except urllib.error.HTTPError as e:
            # AMLL 数据库中不存在该歌曲时返回 404
            # 统一返回 200 + 空响应体，避免浏览器控制台报 404 错误
            # 前端通过检查响应体是否为空来判断是否找到歌词
            body = b''
            try:
                body = e.read()
            except Exception:
                pass
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Content-Length', '0')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('X-Proxy-Status', str(e.code))
            self.end_headers()

        except urllib.error.URLError as e:
            msg = f'代理请求失败: {e.reason}'.encode('utf-8')
            self.send_response(502)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Content-Length', str(len(msg)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(msg)

        except Exception as e:
            msg = f'服务器错误: {e}'.encode('utf-8')
            self.send_response(500)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Content-Length', str(len(msg)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(msg)

    def _handle_rank(self):
        """音乐榜单代理：QQ/网易云 优先本地 vendor（时延最短），失败才回退外部 ygking/viki；
        酷狗直接本进程打 mobilecdnbj 官方接口（vendor 内部同源，此即最短路径）。
        服务端统一控制超时、UA、Referer，并把酷狗「HTML 裹 JSON」提取为纯 JSON。"""
        action = self.path.split('/api/rank/', 1)[1].split('?', 1)[0]
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        rid = (q.get('id') or [''])[0]
        KG_HDRS = {'User-Agent': ('Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) '
                                  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1'),
                   'Referer': 'http://m.kugou.com/'}
        _send_body = lambda body: (self.send_response(200),
                                   self.send_header('Content-Type', 'application/json; charset=utf-8'),
                                   self.send_header('Cache-Control', 'no-cache'),
                                   self.send_header('Content-Length', str(len(body))),
                                   self.send_header('Access-Control-Allow-Origin', '*'),
                                   self.end_headers(), self.wfile.write(body))
        # ★ 榜单结果服务端短缓存（90s）：连续进入/切源秒回，减轻 mobilecdnbj 冷启动抖动
        _ckey = action + '|' + rid
        _chit = LyricServerHandler._RANK_CACHE.get(_ckey)
        if _chit and time.time() - _chit[0] < LyricServerHandler._RANK_CACHE_TTL:
            _send_body(_chit[1])
            return
        try:
            # ★ vendor 优先：本地副进程（QQ 3200 / 网易云 3201）时延最短，先取；空才走外部
            if action == 'qq':
                _body = _rank_fallback_qq(rid)
                if len(_body) > 20:
                    _send_body(_body)
                    return
            elif action == 'ncm':
                _body = _rank_fallback_ncm(rid)
                if len(_body) > 20:
                    _send_body(_body)
                    return

            kg_rid = ''
            if action == 'qq':
                url = 'https://api.ygking.top/api/top'
                headers = {'User-Agent': UA_DESKTOP, 'Accept': 'application/json'}
            elif action == 'kugou':
                kg_rid = rid
                if kg_rid:
                    # 传入榜单 id：先取最新期号(vol)，再拉该期全量歌曲(最多 100 首)
                    vol_url = ('http://mobilecdnbj.kugou.com/api/v3/rank/vol?ranktype=2&plat=0'
                               f'&rankid={urllib.parse.quote(kg_rid)}&with_res_tag=1')
                    volid = ''
                    try:
                        vreq = urllib.request.Request(vol_url, headers=KG_HDRS)
                        with urllib.request.urlopen(vreq, timeout=20) as vresp:
                            vtxt = vresp.read()
                        vs = vtxt.find(b'{')
                        ve = vtxt.rfind(b'}')
                        vol_obj = json.loads(vtxt[vs:ve + 1]) if (vs >= 0 and ve > vs) else {}
                        vol_list = (vol_obj.get('data', {}).get('info') or [])
                        if vol_list and vol_list[0].get('vols'):
                            volid = str(vol_list[0]['vols'][0].get('volid', ''))
                    except Exception:
                        volid = ''
                    url = ('http://mobilecdnbj.kugou.com/api/v3/rank/song?version=9108&ranktype=2&plat=0&pagesize=100'
                           '&area_code=1&page=1'
                           + (f'&volid={volid}' if volid else '')
                           + f'&rankid={urllib.parse.quote(kg_rid)}&with_res_tag=1')
                    headers = KG_HDRS
                else:
                    url = ('http://mobilecdnbj.kugou.com/api/v3/rank/list?version=9108&plat=0&showtype=2'
                           '&parentid=0&apiver=6&area_code=1&withsong=1&with_res_tag=1')
                    headers = KG_HDRS
            elif action == 'ncm':
                url = ('https://60s.viki.moe/v2/ncm-rank/list'
                       if not rid else f'https://60s.viki.moe/v2/ncm-rank/song/{urllib.parse.quote(rid)}')
                headers = {'User-Agent': UA_DESKTOP, 'Accept': 'application/json'}
            else:
                raise ValueError('unknown rank action')
            req = urllib.request.Request(url, headers=headers)
            # 网易云榜单歌曲端点在 60s.viki.moe 上慢且不稳：收紧到 25s，避免长时间转圈
            probe_to = 25 if (action == 'ncm' and rid) else 45
            body = b''
            for _rtry in range(2):
                try:
                    with urllib.request.urlopen(req, timeout=probe_to) as resp:
                        body = resp.read()
                    break
                except Exception:
                        if _rtry == 1:
                            body = b''  # 主源彻底失败：留空交由下方 vendor 兜底
            if action == 'kugou':
                def _kg_extract(bd):
                    s = bd.find(b'{')
                    e = bd.rfind(b'}')
                    p = bd[s:e + 1] if (s >= 0 and e > s) else b'{}'
                    try:
                        o = json.loads(p)
                        if kg_rid:
                            inf = (o.get('data') or {}).get('info') or []
                            if not inf:
                                return b''
                            # ★ 附带真实歌曲总数 total（供前端卡片回填"500 首"等）
                            total = (o.get('data') or {}).get('total') or 0
                            return json.dumps({'code': 0, 'data': inf, 'total': total}).encode('utf-8')
                        return p  # p 已是剥好的 bytes，勿再 .encode()
                    except Exception:
                        return b''
                body = _kg_extract(body)
                # ★ 首请求为空（CDN 冷启动/限流）：立即补一次「不带 volid」的请求——
                #   无 volid 的 rank/song 同样返回最新一期（本地实测 data.info 100 首）
                if kg_rid and not body:
                    no_vol_url = ('http://mobilecdnbj.kugou.com/api/v3/rank/song?version=9108&ranktype=2&plat=0'
                                  '&pagesize=100&area_code=1&page=1'
                                  f'&rankid={urllib.parse.quote(kg_rid)}&with_res_tag=1')
                    try:
                        with urllib.request.urlopen(urllib.request.Request(no_vol_url, headers=KG_HDRS),
                                                    timeout=probe_to) as nr:
                            body = _kg_extract(nr.read())
                    except Exception:
                        body = b''
                if not body:
                    body = json.dumps({'code': 0, 'data': []}).encode('utf-8')
            # 注：QQ/网易云的 vendor 已在函数开头优先尝试，外部路径仅作 vendor 空时兜底
            # ★ 只缓存有效响应：空/失败结果不缓存，避免上游抖动被"冻住"90 秒
            if len(body) > 4:
                LyricServerHandler._RANK_CACHE[_ckey] = (time.time(), body)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)
        except Exception:
            body = b'{}'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)

    def end_headers(self):
        # 为静态文件响应附加 CORS 头（代理响应已自行处理）
        if not self.path.startswith('/proxy?url='):
            self.send_header('Access-Control-Allow-Origin', '*')
        # ★ 缓存控制：HTML 禁止缓存（no-store），JS/CSS 每次强制重验证（no-cache）。
        #   防止 WebView2/浏览器用陈旧 HTML 引用旧版本模块 URL，导致同一模块双实例。
        try:
            path = self.path.split('?')[0].split('#')[0].lower()
            last = path.rsplit('/', 1)[-1]
            if path.endswith('.html') or path in ('/', '') or '.' not in last:
                self.send_header('Cache-Control', 'no-store, must-revalidate')
            elif last.endswith(('.js', '.mjs', '.css')):
                self.send_header('Cache-Control', 'no-cache')
        except Exception:
            pass
        super().end_headers()


class ReusableThreadingTCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

def _prewarm_selfhost_vendors():
    """自建服务 vendor 后台预启动：所有带源码的平台并行常驻拉起（本机常驻 API 语义），
    让网易云/QQ/酷狗播放直链、日推、榜单在用户未主动登录设置页时也能秒回；
    无人机的平台（目录缺失/无 node）静默跳过，不影响主服务。"""
    try:
        import selfhost_service as _sh
        for _n in ('netease', 'kugou', 'qq'):
            try:
                if os.path.isdir(_sh._SERVICES[_n]['dir']):
                    _sh._ensure_running_async(_n)
            except Exception:
                pass
    except Exception:
        pass


def _ensure_shazam_sidecar():
    """网页版（无 Tauri 壳）启动时后台拉起 18089 识曲 sidecar：
    用同一套 node 解析（ARIA_NODE → runtime/node.exe → PATH），失败仅静默
    （识曲不可用，不影响主服务/自建三平台）。Tauri 版由 lib.rs 负责拉启。
    防止"一次拉一个":用 setattr 标记,进程内只尝试一次。"""
    try:
        if getattr(_ensure_shazam_sidecar, '_tried', False):
            return
        _ensure_shazam_sidecar._tried = True
        import urllib.request as _urq
        def _alive():
            try:
                with _urq.urlopen('http://127.0.0.1:18089/health', timeout=1.5) as r:
                    return r.status == 200
            except Exception:
                return False
        if _alive():
            return
        node = selfhost_service._find_node()
        if not node:
            return
        script = os.path.join(_PROJECT_DIR, 'scripts', 'shazam-server.mjs')
        if not os.path.isfile(script):
            return
        import subprocess as _sp
        _sp.Popen(
            [node, script], cwd=_PROJECT_DIR, shell=False,
            stdout=_sp.DEVNULL, stderr=_sp.DEVNULL,
            creationflags=getattr(_sp, 'CREATE_NO_WINDOW', 0),
        )
    except Exception:
        pass


def _kill_port_occupant(port):
    """Windows 下自动查找并杀死占用指定端口的旧进程"""
    try:
        import subprocess
        _nowinflags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
        # ★ 不用 shell=True 拼 netstat|findstr（管道+隐形注入面）；改列表参数 + Python 侧解析
        output = subprocess.check_output(
            ['netstat', '-ano'], text=True, creationflags=_nowinflags)
        my_pid = os.getpid()
        target = str(port)
        for line in output.strip().splitlines():
            # 仅 TCP LISTENING 行（UDP 行无 State，跳过）
            if 'LISTENING' not in line:
                continue
            parts = line.strip().split()
            if len(parts) < 5:
                continue
            # 本地地址列（parts[1]），端口取最后一段：兼容 IPv4 "0.0.0.0:18089"
            # 与 IPv6 "[::]:18089" 两种格式；✓ 修历史缺陷：先前不比对端口，
            # 遍历所有 LISTENING 进程全 taskkill，误杀用户机器上其它服务
            local_addr = parts[1]
            if not local_addr.rsplit(':', 1)[-1] == target:
                continue
            pid = int(parts[-1])
            if pid != my_pid and pid != 0:
                print(f"[*] 发现端口 {port} 被旧进程 (PID: {pid}) 占用，正在自动释放...")
                subprocess.run(['taskkill', '/F', '/PID', str(pid)],
                               capture_output=True, creationflags=_nowinflags)
                time.sleep(0.5)
    except Exception:
        pass


# ==================== 进程退出清理 ====================
# ★ 关窗/退出后副进程残留是历史硬缺陷（node vendor 3100/3200/3201、shazam 18089
#   全部变孤儿，只能靠 StopAria.bat 手动清）。这里统一：任何正常退出路径都清干净。
_MAIN_HTTPD = None     # main() 里绑定后赋值，供 /api/shutdown 引用


def _shutdown_server_process():
    """网页版/桌面版后端退出时的统一清理：停掉本进程拉起的 shazam(18089)。
    自建 vendor(3100/3200/3201) 由 selfhost_service.shutdown_all() 清理
    （该模块已注册 atexit，宿主进程正常退出即触发）。"""
    try:
        _kill_port_occupant(18089)
    except Exception:
        pass


def _graceful_exit():
    """/api/shutdown 触发的后台退出线程：清 shazam → 清自建 vendor → 强退。
    用 os._exit 兜底保证即使 serve_forever 尚未就绪也能退出；
    vendor 清理显式调用 shutdown_all()（内含 Windows 进程树 taskkill）。"""
    _shutdown_server_process()
    try:
        selfhost_service.shutdown_all()
    except Exception:
        pass
    os._exit(0)


atexit.register(_shutdown_server_process)


if __name__ == '__main__':
    # ★ 构建时间戳：取自 server.py 本身的最后修改时间，写入 version.json / build_info.json
    #   供 Web 端与 Tauri 桌面端并行读取与版本校验
    try:
        from datetime import datetime as _dt
        _mtime = os.path.getmtime(os.path.abspath(__file__))
        _build_stamp = _dt.fromtimestamp(_mtime).strftime('%Y年%m月%d日 %H:%M:%S')
        _iso_stamp = _dt.fromtimestamp(_mtime).isoformat()
        _base_dir = _PROJECT_DIR
        
        _ver_info = {
            "build_time": _build_stamp,
            "timestamp": _iso_stamp,
            "server_version": "2.0.0",
            "tauri_supported": True
        }
        for _fname in ('build_info.json', 'version.json'):
            try:
                with open(os.path.join(_base_dir, _fname), 'w', encoding='utf-8') as _vf:
                    json.dump(_ver_info, _vf, ensure_ascii=False, indent=2)
            except Exception:
                pass
    except Exception:
        _build_stamp = '未知'

    # 尝试绑定端口，如遇 WinError 10048 自动清理并自愈重试
    httpd = None
    for attempt in range(3):
        try:
            httpd = ReusableThreadingTCPServer((BIND_HOST, PORT), LyricServerHandler)
            break
        except OSError as e:
            if getattr(e, 'winerror', None) == 10048 or '10048' in str(e):
                print(f"[!] 端口 {PORT} 被占用，正在自动清理旧实例 (重试 {attempt + 1}/3)...")
                _kill_port_occupant(PORT)
                time.sleep(1.0)
            else:
                raise

    if not httpd:
        print(f"[ERROR] 无法绑定端口 {PORT}，请检查是否有其他软件占用了该端口。")
        sys.exit(1)

    _MAIN_HTTPD = httpd

    # 网页版（无 Tauri 壳）后台拉起 18089 识曲 sidecar，不阻塞主服务启动
    threading.Thread(target=_ensure_shazam_sidecar, daemon=True,
                     name='shazam-sidecar').start()
    # ★ 自建服务 vendor 后台预启动：曾登录/在跑的平台并行拉起，打开设置页/日推/榜单即就绪，
    #   避免「首次进入要等 node 冷启动 + 4s 后重查」的空白感
    threading.Thread(target=_prewarm_selfhost_vendors, daemon=True,
                     name='selfhost-prewarm').start()

    with httpd:
        print(f"{'=' * 50}")
        print(f"  歌词播放器本地服务器（含 CORS 代理 + Tauri 支持）")
        print(f"{'=' * 50}")
        print(f"  服务端构建时间: {_build_stamp}")
        print(f"  服务器地址:  http://127.0.0.1:{PORT}")
        print(f"  主界面地址:  http://127.0.0.1:{PORT}/index.html (模块化版)")
        print(f"  监听地址:    {BIND_HOST}:{PORT}")
        if LAN_MODE:
            print()
            print(f"  [!] --lan 已开启：服务对整个局域网开放，同网段任何设备均可访问")
            print(f"      /proxy、/api/selfhost/*（携带平台登录态）、/api/local-music/list、")
            print(f"      /api/config/load（含 AI Key 等配置）。仅在可信网络下使用。")
            print(f"      手机访问入口： http://{_lan_ip_hint() or '<本机局域网IP>'}:{PORT}/index.html")
        else:
            print(f"  仅本机可访问（需要手机/平板连接时加 --lan 参数重新启动）")
        print(f"  web 根目录:  {WEB_DIR}")
        if not os.path.isfile(os.path.join(WEB_DIR, 'index.html')):
            print(f"[警告] {WEB_DIR} 下找不到 index.html！")
            print(f"        请确认 web 文件夹与 server.exe 放在同一目录（绿色版整包解压）。")
            print(f"        若已整包解压仍报错，请重新解压 zip（推荐 7-Zip，勿用部分解压）。")
        print(f"{'=' * 50}")
        print(f"  按 Ctrl+C 停止服务器")
        print()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n服务器已停止")
            sys.exit(0)
