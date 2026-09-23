# -*- coding: utf-8 -*-
"""
聚合跨源兜底层（P3/P4）：gdstudio api.php 多源搜索+取链+防试听校验
源顺序 kuwo → netease；上游某源失效时自动跳过，恢复后零改动生效。
仅在 QQ主链 + 酷狗 + 咪咕 全失败后才被调用（前端触发），不占主链延迟。
"""
import json
import ssl
import threading
import time
import urllib.parse
import urllib.request
from collections import OrderedDict

try:
    import qq_resolver
    _validate = qq_resolver.validate_url   # Range+魔数+时长 强校验，直接复用
except Exception:                          # pragma: no cover - 独立调试时可无校验
    _validate = None

# 证书校验：默认强制校验，仅对证书链偶发不全的特定上游豁免（与 qq_resolver 的 _NOVERIFY_HOSTS 同策略）
_SSL_NOVERIFY = ssl.create_default_context()
_SSL_NOVERIFY.check_hostname = False
_SSL_NOVERIFY.verify_mode = ssl.CERT_NONE
_NOVERIFY_HOSTS = {'music-api.gdstudio.xyz', 'api.bugpk.com'}


def _ssl_ctx_for(url):
    """按主机名白名单决定是否豁免 TLS 校验；白名单外一律走默认校验，防中间人。"""
    host = urllib.parse.urlparse(url).netloc.lower()
    if any(host == h or host.endswith('.' + h) for h in _NOVERIFY_HOSTS):
        return _SSL_NOVERIFY
    return None

_BASE = 'https://music-api.gdstudio.xyz/api.php'
_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
_TIMEOUT_SEARCH = 10
_TIMEOUT_URL = 15

# 源优先级（左→右）；br 档位从高到低轮询
_SOURCES = ('kuwo', 'netease')
_BRS = {'kuwo': ('999', '400', '320'), 'netease': ('999', '740', '320')}
_NAME2LABEL = {'kuwo': 'kuwo-gds', 'netease': 'netease-gds'}

_HEALTH = {}
_HEALTH_LOCK = threading.Lock()

_CACHE = OrderedDict()      # "title|artist".lower() -> (expire_ts, result_dict)
_CACHE_LOCK = threading.Lock()
_CACHE_TTL = 600            # 10 分钟
_CACHE_MAX = 128


def _get_json(url, timeout):
    req = urllib.request.Request(url, headers={'User-Agent': _UA, 'Accept': 'application/json, */*'})
    with urllib.request.urlopen(req, timeout=timeout, context=_ssl_ctx_for(url)) as r:
        return json.loads(r.read().decode('utf-8', 'replace'))


def _search(source, keyword, count=6, page=1):
    """page 为真实后端翻页（gdstudio pages 参数），2026-08 实测翻页有效"""
    qs = urllib.parse.urlencode({'types': 'search', 'source': source, 'name': keyword,
                                 'count': str(count), 'pages': str(int(page or 1))})
    data = _get_json(f'{_BASE}?{qs}', _TIMEOUT_SEARCH)
    if not isinstance(data, list):
        return []
    out = []
    for it in data:
        try:
            artist = it.get('artist')
            artist = ' '.join(artist) if isinstance(artist, list) else str(artist or '')
            sid = str(it.get('id') or '')
            name = str(it.get('name') or '')
            if sid and name:
                out.append({'id': sid, 'name': name, 'artist': artist,
                            'album': str(it.get('album') or ''),
                            'pic_id': str(it.get('pic_id') or '')})
        except Exception:
            continue
    return out


def _pick_best(items, title, artist, keep=2):
    """名称相似度排序：完全相等 > 括号前缀相等 > 包含；歌手包含加分。
    提供歌手时先做硬过滤；硬过滤为空时降级为仅名称全等(>=3分)并标记 artist_mismatch。"""
    t = (title or '').lower().replace(' ', '')
    a = (artist or '').lower().strip()

    def _base(n):
        return n.split('(')[0].split('（')[0].strip()

    def _score(it):
        n = it['name'].lower().replace(' ', '')
        if n == t:
            s = 4
        elif _base(n) == t:
            s = 3
        elif t and (t in n or n in t):
            s = 2
        elif t and (t in _base(n) or _base(n) in t):
            s = 1
        else:
            return 0
        if a and a in it['artist'].lower():
            s += 2
        return s

    strict = [it for it in items if a in it['artist'].lower()] if a else []
    pool = strict if strict else items

    scored = sorted(((_score(it), it) for it in pool if _score(it) > 0),
                    key=lambda x: -x[0])

    out = []
    for s, it in scored[:keep]:
        copy = dict(it)
        if a and a not in it['artist'].lower():
            copy['artist_mismatch'] = True
        out.append(copy)
    # 硬过滤为空时：允许名称完全相等(>=3分)的匹配作为最后手段（标记歌手不匹配）
    if not out and t:
        for it in items:
            if _score(it) >= 3:
                copy = dict(it)
                copy['artist_mismatch'] = True
                out.append(copy)
                break
    return out


def _url(source, song_id, br):
    qs = urllib.parse.urlencode({'types': 'url', 'source': source, 'id': song_id, 'br': br})
    data = _get_json(f'{_BASE}?{qs}', _TIMEOUT_URL)
    u = (data or {}).get('url') or ''
    return u if isinstance(u, str) and u.startswith('http') else ''


def _health_record(name, ok):
    with _HEALTH_LOCK:
        h = _HEALTH.setdefault(name, {'ok': 0, 'fail': 0})
        h['ok' if ok else 'fail'] += 1


def stats():
    with _HEALTH_LOCK:
        return json.loads(json.dumps(_HEALTH))


# ---------- 酷我独立源（搜索界面第四源）：优先 bugpk API，失败回退 gdstudio ----------

_KUWO_BRS_BY_Q = {
    '128': ('128', '320'),
    '320': ('320', '400'),
}
_KUWO_BRS_DEFAULT = ('999', '400', '320')   # flac/hires/master 及未指定


_BUGPK_CACHE = OrderedDict()   # sid -> (expire_ts, data_dict)
_BUGPK_LOCK = threading.Lock()
_BUGPK_TTL = 900                # 15 分钟


def _fetch_bugpk_kuwo(song_id):
    """请求 bugpk 酷我详情接口（包含直链、封面、LRC歌词等）。带 15 分钟内存缓存。"""
    if not song_id:
        return None
    sid_str = str(song_id).strip()
    now = time.time()
    with _BUGPK_LOCK:
        hit = _BUGPK_CACHE.get(sid_str)
        if hit and hit[0] > now:
            return dict(hit[1])
        if hit:
            _BUGPK_CACHE.pop(sid_str, None)

    if sid_str.startswith('http'):
        target_url = f'https://api.bugpk.com/api/kuwo?url={urllib.parse.quote(sid_str)}'
    else:
        target_url = f'https://api.bugpk.com/api/kuwo?url=https://www.kuwo.cn/play_detail/{sid_str}'
    try:
        req = urllib.request.Request(target_url, headers={'User-Agent': _UA, 'Accept': 'application/json, */*'})
        with urllib.request.urlopen(req, timeout=10, context=_ssl_ctx_for(target_url)) as r:
            data = json.loads(r.read().decode('utf-8', 'replace'))
            if data and data.get('code') == 200 and isinstance(data.get('data'), dict):
                res_data = data['data']
                with _BUGPK_LOCK:
                    _BUGPK_CACHE[sid_str] = (now + _BUGPK_TTL, dict(res_data))
                    while len(_BUGPK_CACHE) > 256:
                        _BUGPK_CACHE.popitem(last=False)
                return res_data
    except Exception as e:
        pass
    return None


def kuwo_detail(song_id):
    """酷我一站式详情：单次调用同时返回直链、高清封面、LRC歌词及元信息。"""
    bp_data = _fetch_bugpk_kuwo(song_id)
    if not bp_data:
        return {'ok': False, 'err': 'no_data'}
    return {
        'ok': True,
        'url': bp_data.get('music_url') or '',
        'cover': bp_data.get('pic') or bp_data.get('albumpic') or bp_data.get('pic120') or '',
        'lrc': bp_data.get('lyrics_url') or '',
        'title': bp_data.get('title') or '',
        'artist': bp_data.get('artist') or '',
        'album': bp_data.get('album') or '',
        'song_id': str(bp_data.get('song_id') or song_id)
    }


def search_kuwo(keyword, count=99, page=1):
    """酷我搜索（供 /api/kuwo/search）。返回 [{id,name,artist,album,cover},...]。
    封面：gdstudio 搜索自带 pic_id（如 120/s3s94/93/211513640.jpg），
    拼酷我官方 CDN 即为可加载封面（2026-08 实测 200 image/jpeg）。
    count 上限 99（2026-08 实测 count=100 上游返回错误 dict，99 正常）。"""
    items = _search('kuwo', keyword, count, page)
    for it in items:
        pic = it.pop('pic_id', '')
        it['cover'] = f'https://img4.kuwo.cn/star/albumcover/{pic}' if pic else ''
    return items


def kuwo_pic(song_id):
    """酷我歌曲封面：优先 bugpk 官方 500x500 高清大图，失败回退 gdstudio。"""
    # 1. 优先尝试 bugpk 接口
    try:
        bp_data = _fetch_bugpk_kuwo(song_id)
        if bp_data:
            pic = bp_data.get('pic') or bp_data.get('albumpic') or bp_data.get('pic120')
            if pic and isinstance(pic, str) and pic.startswith('http'):
                return pic
    except Exception:
        pass

    # 2. 回退 gdstudio types=pic
    try:
        qs = urllib.parse.urlencode({'types': 'pic', 'source': 'kuwo', 'id': str(song_id)})
        data = _get_json(f'{_BASE}?{qs}', _TIMEOUT_SEARCH)
        u = (data or {}).get('url') or ''
        if not (isinstance(u, str) and u.startswith('http')):
            return ''
        req = urllib.request.Request(u, headers={'User-Agent': _UA}, method='HEAD')
        with urllib.request.urlopen(req, timeout=8) as r:
            ct = (r.headers.get('Content-Type') or '').lower()
            return u if ct.startswith('image/') else ''
    except Exception:
        return ''


def kuwo_lyric(song_id):
    """酷我歌曲 LRC 歌词：通过 bugpk 接口获取 lyrics_url 文本。失败返回 ''。"""
    try:
        bp_data = _fetch_bugpk_kuwo(song_id)
        if bp_data:
            lrc = bp_data.get('lyrics_url') or ''
            if lrc and isinstance(lrc, str) and ('[' in lrc):
                return lrc
    except Exception:
        pass
    return ''


def resolve_kuwo_song(song_id, quality=None, expect_dur=None):
    """按音质阶梯取酷我直链并强校验。优先使用 bugpk 接口，失败回退 gdstudio。"""
    key = f"kw:{song_id}|{(quality or '').strip().lower() or 'auto'}"
    now = time.time()
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if hit and hit[0] > now:
            r = dict(hit[1])
            r['cached'] = True
            return r
        if hit:
            _CACHE.pop(key, None)

    t0 = time.time()

    # 1. 优先尝试 bugpk 酷我接口
    try:
        bp_data = _fetch_bugpk_kuwo(song_id)
        if bp_data:
            music_url = bp_data.get('music_url')
            if music_url and isinstance(music_url, str) and music_url.startswith('http'):
                duration = None
                if _validate is not None:
                    try:
                        v = _validate(music_url, expect_dur=expect_dur, timeout=10)
                        if isinstance(v, dict) and v.get('ok'):
                            duration = v.get('duration')
                    except Exception:
                        pass
                result = {
                    'ok': True,
                    'url': music_url,
                    'provider': 'kuwo-bugpk',
                    'quality': '320',
                    'duration': duration,
                    'cover': bp_data.get('pic') or bp_data.get('albumpic') or '',
                    'elapsed_ms': int((time.time() - t0) * 1000)
                }
                with _CACHE_LOCK:
                    _CACHE[key] = (now + _CACHE_TTL, dict(result))
                    while len(_CACHE) > _CACHE_MAX:
                        _CACHE.popitem(last=False)
                return result
    except Exception as e:
        pass

    # 2. 回退 gdstudio 多音质轮询
    q = (quality or '').strip().lower()
    brs = _KUWO_BRS_BY_Q.get(q, _KUWO_BRS_DEFAULT)
    for br in brs:
        try:
            url = _url('kuwo', song_id, br)
        except Exception:
            _health_record('kuwo-gds', False)
            continue
        if not url:
            continue
        duration = None
        if _validate is not None:
            try:
                v = _validate(url, expect_dur=expect_dur, timeout=10)
            except Exception:
                v = {'ok': False}
            if not (isinstance(v, dict) and v.get('ok')):
                _health_record('kuwo-gds', False)
                continue
            duration = v.get('duration')
        _health_record('kuwo-gds', True)
        result = {'ok': True, 'url': url, 'provider': 'kuwo-gds', 'quality': br,
                  'duration': duration, 'elapsed_ms': int((time.time() - t0) * 1000)}
        with _CACHE_LOCK:
            _CACHE[key] = (now + _CACHE_TTL, dict(result))
            while len(_CACHE) > _CACHE_MAX:
                _CACHE.popitem(last=False)
        return result
    return None


def resolve_same_song(title, artist=''):
    """跨源同名歌兜底主入口。成功: {ok,url,provider,quality,song,...}；失败: {ok:False,err,tried}"""
    key = f'{(title or "").strip()}|{(artist or "").strip()}'.lower()
    now = time.time()
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if hit and hit[0] > now:
            r = dict(hit[1])
            r['cached'] = True
            return r
        if hit:
            _CACHE.pop(key, None)

    tried = []
    for source in _SOURCES:
        label = _NAME2LABEL[source]
        t0 = time.time()
        try:
            items = _search(source, (title or '').strip())
        except Exception as e:
            _health_record(label, False)
            tried.append({'provider': label, 'step': 'search', 'ok': False,
                          'err': type(e).__name__, 'ms': int((time.time() - t0) * 1000)})
            continue
        ranked = _pick_best(items, title, artist)
        if not ranked:
            tried.append({'provider': label, 'step': 'match', 'ok': False, 'err': 'no_match'})
            continue
        for it in ranked:
            for br in _BRS[source]:
                tt = time.time()
                try:
                    url = _url(source, it['id'], br)
                except Exception as e:
                    _health_record(label, False)
                    tried.append({'provider': label, 'step': 'url', 'ok': False,
                                  'err': type(e).__name__, 'ms': int((time.time() - tt) * 1000)})
                    continue
                if not url:
                    continue
                duration = None
                if _validate is not None:
                    try:
                        v = _validate(url, timeout=10)
                    except Exception:
                        v = {'ok': False}
                    if not (isinstance(v, dict) and v.get('ok')):
                        tried.append({'provider': label, 'step': 'validate', 'ok': False, 'br': br})
                        continue
                    duration = v.get('duration')
                _health_record(label, True)
                result = {'ok': True, 'url': url, 'provider': label, 'quality': br,
                          'song': f"{it['name']} - {it['artist']}", 'duration': duration,
                          'artist_mismatch': bool(it.get('artist_mismatch')),
                          'elapsed_ms': int((time.time() - t0) * 1000), 'tried': tried}
                with _CACHE_LOCK:
                    _CACHE[key] = (now + _CACHE_TTL, dict(result))
                    while len(_CACHE) > _CACHE_MAX:
                        _CACHE.popitem(last=False)
                return result
    return {'ok': False, 'err': 'all_sources_failed', 'tried': tried}


if __name__ == '__main__':
    import sys
    sys.stdout.reconfigure(encoding='utf-8')
    print(json.dumps(resolve_same_song(sys.argv[1] if len(sys.argv) > 1 else '晴天',
                                       sys.argv[2] if len(sys.argv) > 2 else '周杰伦'),
                     ensure_ascii=False, indent=1)[:1200])
