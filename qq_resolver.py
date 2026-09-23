#!/usr/bin/env python3
"""
qq_resolver.py — QQ音乐多源解析池（供 server.py 的 /api/qq/resolve 使用）
====================================================================
返回链（2026-08 实测排序）：
  Tier A 竞速(先到先得)： vkeys新接口(q14母带) | ygking(master) | nki(sq)
  Tier A2 竞速降档：      vkeys新接口(q10无损) | ygking(flac)
  Tier B 顺序降级：       tang(sq) → xcvts(HQ高品质/SQ无损) → moeyao(meting)
  Tier C 节流备胎(429型)： xianyuw(hires) → hk0cc(sq)
  Tier D 官方兜底：       GetVkey F000(flac) → M800(320mp3) → M500(128mp3)

防伪校验（试听片段30~60s无法伪装成完整曲）：
  - Range 抓首 128KB + 魔数嗅探 (fLaC / ID3 / OggS / ftypM4A / 裸MP3帧头)
  - FLAC STREAMINFO 时长解析，与前端传入的官方时长比对（容差 ±5s 或 5%）
  - MP3 按总字节数×8/码率估算时长比对
缓存：LRU 256 条，TTL 15 分钟。
健康度：连续失败 ≥3 进入冷却 120 秒（期间跳过该源，冷却后自动重探）。
仅用标准库，无第三方依赖。
"""
import base64
import json
import random
import re
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, FIRST_COMPLETED, wait

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36')

# 部分源证书不规范，跳过校验（与 musicdl verify=False 一致）
_SSL_NOVERIFY = ssl.create_default_context()
_SSL_NOVERIFY.check_hostname = False
_SSL_NOVERIFY.verify_mode = ssl.CERT_NONE
_NOVERIFY_HOSTS = {'api.nki.pw'}

# ==================== 密钥（musicdl 混淆方案） ====================

def _dekey_prefix(t):
    """剥离14字符前缀 'charlespikachu' 后 base64 解码"""
    return base64.b64decode(t[14:].encode('utf-8')).decode('utf-8')


XCVTS_KEYS = [
    'charlespikachuNzg5OTMzNDRiOWJmMTEwNTY1NTU5OTAwOWNkYmEzZDI=',
    'charlespikachuY2U3NzhlYjBkMTg1OGVkZmI0YjIwNzFhMTE1ZjFlZGY=',
    'charlespikachuNzRhNjdhZjM3ZjUyODg4MjYxNmRkMzU1OTdlYTc0MGQ=',
]
XIANYUW_KEYS = [
    'charlespikachuc2stNTc2ZmFkZTQxNjI2M2I3ZmY3MjZhZjM1NGQ5ZDkzNzM=',
    'charlespikachuc2stMDE4YjlmOGQ4MGRjMTg5OGEyOTI3ZTgwMjA2NjNkODY=',
]
# nki 为纯 base64 无前缀
NKI_KEYS = [
    'MjhmZWNlOTI1NDM5YjA1Mjc5MmE5Nzk4OWM4NzBjZWQzODAzYTcxYzZiNTM0ZjcxZTVhNTMzMzhiMmQzMWVmOA==',
    'YzRjNGY1ZmMzNmJhZDRjYWNiOTg4MzllMTRmZWE0MDI3N2IzNWVhMmViMWJhYmRhZDdiYmRlMTI4NDAwZjNiMQ==',
]

# ==================== HTTP 基础 ====================

"""
★ 限流保护（2026-08-30 修复「浏览器手动能成、应用内容易失败」）：
  vkeys / ygking 为免费频控接口，竞速阶段会并发打同一源的多个 quality，
  秒级配额被瞬间打满 → 全部返回空/503，并连坐 health 冷却(120s) → 整池 all_providers_failed。
  对策：① 同源请求串行（每源一把 RLock）；② 请求失败重试 1 次（0.35s 间隔）。
"""
_LOCK_VKEYS = threading.RLock()
_LOCK_YGKING = threading.RLock()


class _HttpError(Exception):
    pass


def _get_bytes(url, timeout=10, headers=None):
    """GET 并返回完整 body bytes；nki 域名跳过证书校验"""
    h = {'User-Agent': UA}
    if headers:
        h.update(headers)
    host = urllib.parse.urlparse(url).netloc.lower()
    ctx = _SSL_NOVERIFY if any(host == h or host.endswith('.' + h) for h in _NOVERIFY_HOSTS) else None
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
        return r.read()


def _get_json(url, timeout=10, headers=None):
    try:
        return json.loads(_get_bytes(url, timeout=timeout, headers=headers).decode('utf-8'))
    except urllib.error.HTTPError as e:
        raise _HttpError(f'http{e.code}')
    except _HttpError:
        raise
    except Exception as e:
        raise _HttpError(str(e)[:120])


def _get_text(url, timeout=10, headers=None):
    try:
        return _get_bytes(url, timeout=timeout, headers=headers).decode('utf-8', 'ignore')
    except urllib.error.HTTPError as e:
        raise _HttpError(f'http{e.code}')
    except Exception as e:
        raise _HttpError(str(e)[:120])


BROWSER_HEADERS = {
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.7',
}

# ==================== 直链预检（防试听/防失效） ====================

def _sniff_ext(buf):
    if buf[:4] == b'fLaC':
        return 'flac'
    if buf[:4] == b'OggS':
        return 'ogg'
    if len(buf) > 11 and buf[4:8] == b'ftyp':
        return 'm4a'
    if buf[:3] == b'ID3':
        return 'mp3'
    if len(buf) > 2 and buf[0] == 0xFF and (buf[1] & 0xE0) == 0xE0:
        return 'mp3'
    return ''


def _flac_duration(buf):
    """FLAC STREAMINFO: fLaC + 4B块头 + 34B元数据，末64位打包字段"""
    i = buf.find(b'fLaC')
    if i < 0 or len(buf) < i + 42:
        return None
    si = buf[i + 8:i + 26]
    if len(si) < 18:
        return None
    val = int.from_bytes(si[10:18], 'big')
    sr = val >> 44
    total = val & ((1 << 36) - 1)
    if not sr:
        return None
    return round(total / sr, 1)


_MP3_BR = {3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
           2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]}
_MP3_SR = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]}


def _mp3_duration(buf, total_size):
    """按首个MP3帧头码率估算 CBR 总时长（用于试听检测足够）"""
    n = min(len(buf), 4096)
    for i in range(n - 4):
        if buf[i] == 0xFF and (buf[i + 1] & 0xE0) == 0xE0:
            ver = (buf[i + 1] >> 3) & 3
            layer = (buf[i + 1] >> 1) & 3
            br_i = (buf[i + 2] >> 4) & 15
            sr_i = (buf[i + 2] >> 2) & 3
            if br_i in (0, 15) or sr_i == 3 or layer != 1:
                continue
            br_tab, sr_tab = _MP3_BR.get(ver), _MP3_SR.get(ver)
            if not br_tab or not sr_tab:
                continue
            br = br_tab[br_i] * 1000
            if br <= 0 or total_size <= 0:
                continue
            return round(total_size * 8.0 / br, 1)
    return None


def validate_url(url, expect_dur=None, timeout=8):
    """Range 抓首32KB：魔数嗅探 + 时长比对（32KB足够：魔数前12B、FLAC STREAMINFO前42B、MP3帧头首4KB内）。
    返回 {'ok':bool,'ext':str,'dur':float,'err':str}"""
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': UA, 'Referer': 'https://y.qq.com/', 'Range': 'bytes=0-32767'})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status = r.status
            buf = r.read(32768)
            cr = r.headers.get('Content-Range', '')
        if status not in (200, 206) or len(buf) < 1024:
            return {'ok': False, 'ext': '', 'dur': 0, 'err': f'status{status}'}
        ext = _sniff_ext(buf)
        if not ext:
            return {'ok': False, 'ext': '', 'dur': 0, 'err': 'bad_magic'}
        m = re.search(r'/(\d+)', cr)
        total = int(m.group(1)) if m else 0
        dur = None
        if ext == 'flac':
            dur = _flac_duration(buf)
        elif ext == 'mp3' and total > 0:
            dur = _mp3_duration(buf, total)
        # 时长比对：FLAC 头部不可伪造，是最强防线
        if expect_dur and dur:
            tol = max(5.0, float(expect_dur) * 0.05)
            if abs(dur - float(expect_dur)) > tol:
                return {'ok': False, 'ext': ext, 'dur': dur,
                        'err': f'trial({dur}s vs {expect_dur}s)'}
        # 无头部时长的兜底：整体码率过低视为试听/残片
        if total and expect_dur and not dur:
            kbps = total * 8.0 / max(float(expect_dur), 1.0) / 1000.0
            if kbps < 96:
                return {'ok': False, 'ext': ext, 'dur': 0, 'err': f'low_bitrate({kbps:.0f}kbps)'}
        return {'ok': True, 'ext': ext, 'dur': dur or 0, 'err': ''}
    except urllib.error.HTTPError as e:
        return {'ok': False, 'ext': '', 'dur': 0, 'err': f'http{e.code}'}
    except Exception as e:
        return {'ok': False, 'ext': '', 'dur': 0, 'err': str(e)[:80]}

# ==================== Provider 实现（返回 (url, quality_label)，失败抛异常） ====================

_VKEYS_Q_LABEL = {14: 'master', 13: 'atmos', 11: 'hires', 10: 'flac', 9: 'hq'}


def _p_vkeys(mid, q):
    # ★ 同源串行 + 失败重试 1 次（防免费接口频控打爆，见文件头 2026-08-30 修复说明）
    with _LOCK_VKEYS:
        for attempt in range(2):
            try:
                data = _get_json(f'https://api.vkeys.cn/music/tencent/song/link?mid={mid}&quality={q}',
                                 headers=BROWSER_HEADERS)
                u = ((data.get('data') or {}).get('url')) or ''
                if not str(u).startswith('http'):
                    raise _HttpError(f'vkeys empty(q{q})')
                return u, _VKEYS_Q_LABEL.get(q, f'q{q}')
            except Exception:
                if attempt == 0:
                    time.sleep(0.35)
                    continue
                raise
    raise _HttpError(f'vkeys failed(q{q})')


def _p_ygking(mid, quality):
    # ★ 同源串行 + 失败重试 1 次（ygking 同样限频）
    with _LOCK_YGKING:
        for attempt in range(2):
            try:
                data = _get_json(f'https://api.ygking.top/api/song/url?mid={mid}&quality={quality}')
                if data.get('code') != 0:
                    raise _HttpError(f"ygking code={data.get('code')}")
                u = ((data.get('data') or {}).get(mid)) or ''
                if not str(u).startswith('http'):
                    raise _HttpError('ygking empty')
                return u, quality
            except Exception:
                if attempt == 0:
                    time.sleep(0.35)
                    continue
                raise
    raise _HttpError(f'ygking failed({quality})')


def _pick_songplay(data):
    for k in ('song_play_url_sq', 'song_play_url_pq', 'song_play_url_accom',
              'song_play_url_hq', 'song_play_url', 'song_play_url_standard',
              'song_play_url_fq'):
        u = data.get(k)
        if isinstance(u, str) and u.startswith('http'):
            label = k.replace('song_play_url_', '') or 'sq'
            return u, (label if label != 'sq' else 'sq')
    raise _HttpError('no song_play_url')


def _p_nki(mid):
    apikey = base64.b64decode(random.choice(NKI_KEYS).encode('utf-8')).decode('utf-8')
    data = _get_json(f'https://api.nki.pw/API/music_open_api.php?mid={mid}&apikey={apikey}',
                     timeout=10, headers=BROWSER_HEADERS)
    return _pick_songplay(data)


def _p_tang(mid):
    data = _get_json(f'https://tang.api.s01s.cn/music_open_api.php?mid={mid}',
                     headers=BROWSER_HEADERS)
    return _pick_songplay(data)


def _p_hk0cc(mid):
    data = _get_json(f'https://api.hk0.cc/api/qqmusic?mid={mid}', timeout=10)
    return _pick_songplay(data)


_XCVTS_TYPES = ('HQ高品质', 'SQ无损')


def _p_xcvts(mid):
    last_err = 'xcvts empty'
    for t in _XCVTS_TYPES:
        try:
            apikey = _dekey_prefix(random.choice(XCVTS_KEYS))
            q = urllib.parse.quote(t)
            data = _get_json(f'https://api.xcvts.cn/api/music/qq?apiKey={apikey}&mid={mid}&type={q}')
            d = data.get('data')
            u = d.get('music') if isinstance(d, dict) else d
            if isinstance(u, dict):
                u = u.get('url') or ''
            if isinstance(u, str) and u.startswith('http'):
                return u, t.lower()
            last_err = f'xcvts {t}: {str(data.get("code") or data.get("msg") or "empty")[:60]}'
        except _HttpError as e:
            last_err = f'xcvts {t}: {e}'
    raise _HttpError(last_err)


def _p_moeyao(mid):
    txt = _get_text(f'https://api.moeyao.cn/meting/?server=tencent&type=url&id={mid}')
    u = txt.strip().strip('"')
    if u.startswith('http'):
        return u, 'standard'
    raise _HttpError('moeyao empty')


def _p_xianyuw(mid):
    key = _dekey_prefix(random.choice(XIANYUW_KEYS))
    data = _get_json(
        f'https://apii.xianyuw.cn/api/v1/qq-music-search?id={mid}&key={key}&no_url=0&br=hires')
    u = ((data.get('data') or {}).get('url')) or ''
    if not str(u).startswith('http'):
        raise _HttpError('xianyuw empty')
    return u, 'hires'


_OFFICIAL_TIERS = [('F000', '.flac', 'flac'), ('M800', '.mp3', '320'), ('M500', '.mp3', '128')]
_GUID_HEX = '0123456789abcdef'


def _p_official(mid, prefix, ext, label):
    guid = ''.join(random.choices(_GUID_HEX, k=32))
    payload = {"req_0": {"module": "vkey.GetVkeyServerBaseCgi", "method": "CgiGetVkey",
                         "param": {"guid": guid, "songmid": [mid], "songtype": [0],
                                   "uin": "0", "loginflag": 1, "platform": "20",
                                   "filename": [f"{prefix}{mid}{mid}{ext}"]}}}
    body = json.dumps(payload, separators=(',', ':')).encode('utf-8')
    req = urllib.request.Request('https://u.y.qq.com/cgi-bin/musicu.fcg', data=body, headers={
        'Content-Type': 'application/json', 'User-Agent': UA,
        'Referer': 'https://y.qq.com/', 'Origin': 'https://y.qq.com'})
    with urllib.request.urlopen(req, timeout=10) as r:
        j = json.loads(r.read().decode('utf-8'))
    purl = ((((j.get('req_0') or {}).get('data') or {}).get('midurlinfo') or [{}])[0]).get('purl') or ''
    if not purl:
        raise _HttpError(f'official no purl ({prefix})')
    u = purl if purl.startswith('http') else 'https://isure.stream.qqmusic.qq.com/' + purl.lstrip('/')
    return u, label

# ==================== 健康度统计 ====================
# 两类失败分开计：API 硬失败(fail)与"取到URL但被判废/死链"(invalid)。
# 死链同样需要被惩罚：持续返回死链的源若一直不降温，会在每次竞速中
# 占据首位白等一轮 —— "取链成功却播放不了/随机慢"的重要来源。

_HEALTH = {}
_HEALTH_LOCK = threading.Lock()
_COOLDOWN_S = 120
_MAX_CONSEC_FAIL = 3        # API 硬失败阈值
_MAX_CONSEC_INVALID = 5     # 死链阈值（放宽容差，避免个别歌的VIP限制误伤全源）


def _health_allow(name):
    with _HEALTH_LOCK:
        st = _HEALTH.get(name)
        if not st:
            return True
        n_fail = st.get('consec_fail', 0)
        n_invalid = st.get('consec_invalid', 0)
        limit = _MAX_CONSEC_INVALID if n_invalid >= n_fail else _MAX_CONSEC_FAIL
        if max(n_fail, n_invalid) < limit:
            return True
        return (time.time() - st['last_fail_ts']) > _COOLDOWN_S


def _health_record(name, ok, invalid=False):
    with _HEALTH_LOCK:
        st = _HEALTH.setdefault(name, {'ok': 0, 'fail': 0, 'invalid': 0,
                                       'consec_fail': 0, 'consec_invalid': 0, 'last_fail_ts': 0.0})
        if ok:
            st['ok'] += 1
            st['consec_fail'] = 0
            st['consec_invalid'] = 0
        else:
            st['fail'] += 1
            st['last_fail_ts'] = time.time()
            if invalid:
                st['invalid'] += 1
                st['consec_invalid'] += 1
            else:
                st['consec_fail'] += 1


def stats():
    with _HEALTH_LOCK:
        return {k: dict(v) for k, v in _HEALTH.items()}

# ==================== 缓存（LRU + TTL + 新鲜度预检） ====================
# QQ系CDN的带签名URL(vkey/surl)有3~5分钟风控时效，静态TTL直接命中可能返回
# 已失效链接导致"随机播放不了"。因此命中时间超过 _FRESH_AGE 的缓存先做一次
# 2s 快速 Range 预检再返回，失败即弃缓存重新解析。

_CACHE = OrderedDict()          # mid -> (expire_ts, fetched_ts, result_dict)
_CACHE_LOCK = threading.Lock()
_CACHE_TTL = 900                # 15 分钟
_CACHE_MAX = 256
_FRESH_AGE = 300                # 5 分钟内直接返回，超过预检


def _probe_light(url, timeout=2.5):
    """极轻量预检：Range 读首2KB即断。仅用于缓存新鲜度把关"""
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': UA, 'Referer': 'https://y.qq.com/', 'Range': 'bytes=0-2047'})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            buf = r.read(2048)
            ctype = (r.headers.get('Content-Type') or '').lower()
            return len(buf) > 0 and r.status in (200, 206) and 'text/html' not in ctype
    except Exception:
        return False

# ==================== 主流程 ====================

def _race(tasks, expect_dur, deadline_s=8.0):
    """并发竞速：所有任务同时发，第一个通过预检的结果胜出。
    tasks: [(name, fn)]，fn() -> (url, quality_label)
    返回 (winner|None, tried_list)"""
    tried = []
    winner = None
    ex = ThreadPoolExecutor(max_workers=max(1, len(tasks)))
    try:
        futs = {}
        now = time.monotonic()
        for name, fn in tasks:
            futs[ex.submit(fn)] = name
        t_submit = {f: now for f in futs}
        pending = set(futs.keys())
        end = now + deadline_s
        while pending and winner is None:
            done, pending = wait(pending, timeout=max(0.05, end - time.monotonic()),
                                 return_when=FIRST_COMPLETED)
            if not done and time.monotonic() >= end:
                break
            for f in done:
                name = futs[f]
                ms = int((time.monotonic() - t_submit[f]) * 1000)
                try:
                    url, qlabel = f.result()
                    chk = validate_url(url, expect_dur)
                    if chk['ok']:
                        tried.append({'provider': name, 'ok': True, 'ms': ms,
                                      'quality': qlabel, 'ext': chk['ext']})
                        _health_record(name, True)
                        winner = {'url': url, 'provider': name.split(':')[0],
                                  'quality': qlabel, 'ext': chk['ext'], 'duration': chk['dur']}
                        break
                    # API 通了但链接被判废（试听/死链）：必须计为失败，否则坏源永不降温
                    _health_record(name, False, invalid=True)
                    tried.append({'provider': name, 'ok': False, 'ms': ms,
                                  'err': f"invalid:{chk['err']}"})
                except Exception as e:
                    _health_record(name, False)
                    tried.append({'provider': name, 'ok': False, 'ms': ms,
                                  'err': str(e)[:80]})
    finally:
        ex.shutdown(wait=False, cancel_futures=True)
    return winner, tried


def _plans_for(mid, quality):
    """按用户音质构造解析阶梯。quality ∈ {master,atmos,hires,flac,'320','128'}，空=全阶梯（旧行为）。
    关键设计：用户选320/128时不再竞速母带FLAC——手机带宽跟不上高码率流是"播2s就停"的根因。"""
    q = (quality or '').strip().lower()
    tail_lossless = ('seq', [
        ('tang', lambda: _p_tang(mid)),
        ('xcvts:hq', lambda: _p_xcvts(mid)),
        ('moeyao', lambda: _p_moeyao(mid)),
    ])
    tail_rare = ('seq', [
        ('xianyuw', lambda: _p_xianyuw(mid)),
        ('hk0cc', lambda: _p_hk0cc(mid)),
    ])
    tail_official = ('seq', [
        ('official:F000', lambda: _p_official(mid, *_OFFICIAL_TIERS[0])),
        ('official:M800', lambda: _p_official(mid, *_OFFICIAL_TIERS[1])),
        ('official:M500', lambda: _p_official(mid, *_OFFICIAL_TIERS[2])),
    ])
    race_master = ('race', [
        ('vkeys:q14', lambda: _p_vkeys(mid, 14)),
        ('ygking:master', lambda: _p_ygking(mid, 'master')),
        ('nki:sq', lambda: _p_nki(mid)),
    ])
    race_flac = ('race', [
        ('vkeys:q10', lambda: _p_vkeys(mid, 10)),
        ('ygking:flac', lambda: _p_ygking(mid, 'flac')),
    ])
    race_320 = ('race', [
        ('vkeys:q9', lambda: _p_vkeys(mid, 9)),
        ('ygking:320', lambda: _p_ygking(mid, '320')),
    ])

    if q in ('master', 'atmos'):
        return [race_master, race_flac, tail_lossless, tail_rare, tail_official]
    if q == 'hires':
        return [
            ('race', [('vkeys:q11', lambda: _p_vkeys(mid, 11)), ('nki:sq', lambda: _p_nki(mid))]),
            race_flac, tail_lossless, tail_rare, tail_official,
        ]
    if q in ('flac', 'sq', 'lossless'):
        return [race_flac, tail_lossless, tail_rare, tail_official]
    if q in ('320', 'hq'):
        # 320档：先竞速320源；全挂时降级无损兜底（有歌播 > 严格音质）
        return [
            race_320,
            ('seq', [('moeyao', lambda: _p_moeyao(mid)),
                     ('official:M800', lambda: _p_official(mid, *_OFFICIAL_TIERS[1]))]),
            race_flac,
            ('seq', [('official:F000', lambda: _p_official(mid, *_OFFICIAL_TIERS[0])),
                     ('official:M500', lambda: _p_official(mid, *_OFFICIAL_TIERS[2]))]),
        ]
    if q == '128':
        return [
            ('race', [('ygking:128', lambda: _p_ygking(mid, '128')),
                      ('official:M500', lambda: _p_official(mid, *_OFFICIAL_TIERS[2]))]),
            race_320, race_flac,
            ('seq', [('official:F000', lambda: _p_official(mid, *_OFFICIAL_TIERS[0]))]),
        ]
    # 未指定/未知音质：保持旧全阶梯
    return [race_master, race_flac, tail_lossless, tail_rare, tail_official]


def resolve(mid, dur=None, quality=None, skip_cache=False):
    """主入口：为 mid 找一条可播直链。dur 为官方时长秒数（可选但强烈建议传）。
    quality 为用户播放音质偏好（可选）：master/atmos/hires/flac/320/128。
    skip_cache=True 时强制绕过缓存重新解析（前端播放失败重试用），成功后仍写回新缓存。
    缓存 key 含质量维度，不同音质互不污染。
    返回 {'ok':bool, 'url','provider','quality','ext','elapsed_ms','tried'|...}"""
    mid = (mid or '').strip()
    if not re.fullmatch(r'[0-9A-Za-z]{10,16}', mid):
        return {'ok': False, 'err': 'invalid_mid'}
    dur = float(dur) if dur else None
    qkey = (quality or '').strip().lower() or 'auto'
    cache_key = f'{mid}|{qkey}'

    if not skip_cache:
        with _CACHE_LOCK:
            hit = _CACHE.get(cache_key)
            if hit and hit[0] > time.time():
                expire_ts, fetched_ts, res = hit
                if time.time() - fetched_ts < _FRESH_AGE:
                    # 新鲜命中：直接返回，秒回
                    _CACHE.move_to_end(cache_key)
                    out = dict(res)
                    out['cached'] = True
                    out['tried'] = [{'provider': out.get('provider'), 'ok': True, 'ms': 0, 'cached': True}]
                    return out
                # 较旧命中：快速预检，通过则续新返回；失败则弃缓存重新解析
                if _probe_light(res.get('url')):
                    with _CACHE_LOCK:
                        _CACHE[cache_key] = (time.time() + _CACHE_TTL, time.time(), dict(res))
                    out = dict(res)
                    out['cached'] = True
                    out['freshened'] = True
                    out['tried'] = [{'provider': out.get('provider'), 'ok': True, 'ms': 0, 'cached': True}]
                    return out
                _CACHE.pop(cache_key, None)
            elif hit:
                _CACHE.pop(cache_key, None)

    t0 = time.time()
    tried_all = []
    plans = _plans_for(mid, quality)

    winner = None
    for kind, items in plans:
        items = [(n, f) for n, f in items if _health_allow(n)]
        if not items:
            continue
        if kind == 'race':
            w, tr = _race(items, dur)
            tried_all.extend(tr)
            if w:
                winner = w
                break
        else:
            for name, fn in items:
                # 顺序降级层单次尝试也收紧到 7s：不再允许单个慢源拖 11 秒
                w, tr = _race([(name, fn)], dur, deadline_s=7.0)
                tried_all.extend(tr)
                if w:
                    winner = w
                    break
            if winner:
                break

    elapsed = int((time.time() - t0) * 1000)
    if winner:
        result = {'ok': True, **winner}
        with _CACHE_LOCK:
            _CACHE[cache_key] = (time.time() + _CACHE_TTL, time.time(), dict(result))
            while len(_CACHE) > _CACHE_MAX:
                _CACHE.popitem(last=False)
        print(f"[QQResolve] OK {mid}(q={qkey}) <- {winner['provider']}({winner['quality']},{winner['ext']}) "
              f"{elapsed}ms tried={len(tried_all)}")
        result.update({'elapsed_ms': elapsed, 'tried': tried_all})
        return result

    print(f"[QQResolve] FAIL {mid} {elapsed}ms "
          f"tried={[t['provider'] + ':' + t.get('err', '')[:24] for t in tried_all]}")
    return {'ok': False, 'err': 'all_providers_failed', 'elapsed_ms': elapsed, 'tried': tried_all}


if __name__ == '__main__':
    import sys
    m = sys.argv[1] if len(sys.argv) > 1 else '0039MnYb0qxYhV'
    d = sys.argv[2] if len(sys.argv) > 2 else None
    q = sys.argv[3] if len(sys.argv) > 3 else None
    r = resolve(m, d, q)
    print(json.dumps(r, ensure_ascii=False, indent=2))
