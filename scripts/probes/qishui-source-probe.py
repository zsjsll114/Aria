# -*- coding: utf-8 -*-
"""汽水音乐（抖音 Soda / Luna）在线源可用性观测探针

用途：在把这些第三方在线源接进正式取链链路之前，先积累**客观的可用率数据**——
      它们的共同风险是「随时关停 / 限流 / 突然要 token」，用一两天的主观印象做架构
      决定不可靠。这里用固定样本 + 固定频次打点，把「稳不稳」变成可读的曲线。

用法：
    python scripts/probes/qishui-source-probe.py              # 打一轮，追加到观测日志
    python scripts/probes/qishui-source-probe.py --json       # 只输出 JSON（给自动化/管道用）
    python scripts/probes/qishui-source-probe.py --summary    # 不联网，只读日志算可用率
    python scripts/probes/qishui-source-probe.py --log X.csv  # 指定日志路径

观测日志默认落在 scratch/qishui_probe.csv（scratch/ 不入库），一行 = 一轮 = 一个源。

★ 为什么用固定分享链接而不是随机搜索：这批接口里只有「解析类」接受完整分享链接。
  分享链接背后的直链有时效，但**接口本身是否活着**与直链新旧无关——我们观测的是
  接口可用率，不是链接有效性。固定样本才能跨时间纵向对比。

★ 网络坑（2026-10-03 实测）：本机 curl 打 Cloudflare 站点会报
  `schannel: CRYPT_E_REVOCATION_OFFLINE`，需要 `--ssl-no-revoke`。但本脚本走 Python
  标准库 urllib，**不受影响**（实测同样 URL 默认 SSL 即 200）。所以这里不碰 curl。
"""
import argparse
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_LOG = os.path.join(ROOT, 'scratch', 'qishui_probe.csv')

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36')

# 固定样本：一条真实存在的汽水分享链接（用于解析类接口）
SAMPLE_SHARE = 'https://qishui.douyin.com/s/ia2T2aMo/'
# 固定关键词（用于搜索类接口）
SAMPLE_KEYWORD = '牵丝戏'

# ★ 源表：新增候选源只加一条记录，--summary 会自动把它纳入统计
SOURCES = [
    {
        'id': 'bugpk_qsmusic', 'label': 'BugPk 汽水解析', 'kind': 'resolve',
        'url': 'https://api.bugpk.com/api/qsmusic?url={share}',
        'note': '实测可用（2026-10-03），返回直链+裸QRC逐字歌词',
    },
    {
        'id': 'xhus_qsmusic', 'label': 'Star API 汽水解析', 'kind': 'resolve',
        'url': 'http://api.xhus.cn/api/qsmusic?url={share}',
        'note': '与 BugPk 同形，作为互备候选',
    },
    {
        'id': 'hhl_qishui', 'label': '灰狐 汽水搜索', 'kind': 'search',
        'url': 'https://hhlqilongzhu.cn/api/dg_qishuimusic.php?msg={kw}',
        'note': '唯一找到的「关键词→列表」路；2026-10-03 实测返回空，疑似已挂',
    },
    {
        'id': 'nonebot_qs', 'label': 'nonebot 汽水解析', 'kind': 'resolve',
        'url': 'http://api.nonebot.top/api/v1/parse/musicqs/music?token=',
        'note': '文档要求 token，无 token 预期 401/422 —— 计入 skipped 不计 fail',
        'need_token': True,
    },
    {
        'id': 'yunzhi_qs', 'label': '云智 汽水解析', 'kind': 'resolve',
        'url': 'https://yunzhiapi.cn/API/qsyyjs.php?msg={kw}&n=1',
        'note': '需要注册 token，同上',
        'need_token': True,
    },
]

FIELDS = ['ts', 'epoch', 'source_id', 'label', 'kind', 'status', 'http',
          'ms', 'bytes', 'biz_code', 'has_url', 'has_lyric', 'err']


def fetch(url, timeout=15):
    """返回 (http_status, body_text, ms, err)。err 非空表示连接层就失败。"""
    t0 = time.time()
    try:
        req = urllib.request.Request(url, headers={'User-Agent': UA,
                                                   'Accept': 'application/json, */*'})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read()
            return r.status, body.decode('utf-8', 'replace'), int((time.time() - t0) * 1000), ''
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode('utf-8', 'replace')
        except Exception:
            body = ''
        return e.code, body, int((time.time() - t0) * 1000), ''
    except Exception as e:  # noqa: BLE001 —— 探针就是要吞掉一切并记录
        return 0, '', int((time.time() - t0) * 1000), f'{type(e).__name__}: {e}'


def probe_one(src):
    """打一个源，返回 FIELDS 顺序的 dict。"""
    url = src['url'].format(share=urllib.parse.quote(SAMPLE_SHARE, safe=''),
                            kw=urllib.parse.quote(SAMPLE_KEYWORD, safe=''))
    http, body, ms, err = fetch(url)
    row = {
        'ts': time.strftime('%Y-%m-%d %H:%M:%S'),
        'epoch': int(time.time()),
        'source_id': src['id'],
        'label': src['label'],
        'kind': src['kind'],
        'status': 'fail',
        'http': http,
        'ms': ms,
        'bytes': len(body),
        'biz_code': '',
        'has_url': 0,
        'has_lyric': 0,
        'err': err,
    }
    if err:
        return row

    obj = None
    try:
        obj = json.loads(body)
    except Exception:
        pass

    if isinstance(obj, dict):
        row['biz_code'] = str(obj.get('code', obj.get('status', '')))
        flat = json.dumps(obj, ensure_ascii=False)
        row['has_url'] = 1 if ('"' + 'url' + '"' in flat and 'douyinvod' in flat.lower()
                               or obj.get('url')) else 0
        row['has_lyric'] = 1 if ('lyric' in flat.lower() or 'lrc' in flat.lower()) else 0

    # 判定：HTTP 200 + 非空 + (有直链 或 搜索类返回了列表)
    if http == 200 and body.strip():
        if src['kind'] == 'search':
            row['status'] = 'ok' if (isinstance(obj, dict) and obj.get('data')) else 'empty'
        else:
            row['status'] = 'ok' if row['has_url'] else 'degraded'
    elif http == 0:
        row['status'] = 'unreachable'
    elif http in (401, 403, 422) and src.get('need_token'):
        row['status'] = 'need_token'
    else:
        row['status'] = 'fail'

    if not row['status']:
        row['status'] = 'fail'
    return row


def append_csv(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    new = not os.path.exists(path)
    with io.open(path, 'a', encoding='utf-8', newline='') as f:
        if new:
            f.write(','.join(FIELDS) + '\n')
        for r in rows:
            f.write(','.join(_csv(r[k]) for k in FIELDS) + '\n')


def _csv(v):
    s = str(v)
    return '"' + s.replace('"', '""') + '"' if (',' in s or '"' in s) else s


def read_csv(path):
    rows = []
    try:
        with io.open(path, encoding='utf-8') as f:
            lines = [ln.rstrip('\n') for ln in f if ln.strip()]
        head = lines[0].split(',')
        for ln in lines[1:]:
            # 极简解析：本脚本自己写出的格式，字段内逗号已加引号
            parts, buf, inq = [], '', False
            for ch in ln:
                if ch == '"':
                    inq = not inq
                elif ch == ',' and not inq:
                    parts.append(buf)
                    buf = ''
                else:
                    buf += ch
            parts.append(buf)
            if len(parts) == len(head):
                rows.append(dict(zip(head, parts)))
    except Exception:
        pass
    return rows


def print_summary(path):
    rows = read_csv(path)
    if not rows:
        print(f'观测日志为空或不存在：{path}')
        return
    rounds = len(set(r['epoch'] for r in rows))
    print(f'观测日志：{path}')
    print(f'共 {rounds} 轮 / {len(rows)} 条记录，'
          f'时间跨度 {rows[0]["ts"]} → {rows[-1]["ts"]}')
    print()
    print(f'{"源":<20} {"可用":>5} {"降级":>5} {"空":>4} {"失败":>5} {"不可达":>7} {"需token":>8}  可用率')
    print('-' * 82)
    by = {}
    for r in rows:
        by.setdefault(r['source_id'], []).append(r['status'])
    for sid, sts in by.items():
        label = next((r['label'] for r in rows if r['source_id'] == sid), sid)
        n = len(sts)
        ok = sts.count('ok')
        print(f'{label:<20} {ok:>5} {sts.count("degraded"):>5} {sts.count("empty"):>4} '
              f'{sts.count("fail"):>5} {sts.count("unreachable"):>7} '
              f'{sts.count("need_token"):>8}  {ok / n * 100:5.1f}%')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--json', action='store_true', help='只输出 JSON（不追加日志）')
    ap.add_argument('--summary', action='store_true', help='不联网，只读日志算可用率')
    ap.add_argument('--log', default=DEFAULT_LOG)
    a = ap.parse_args()

    if a.summary:
        print_summary(a.log)
        return 0

    rows = [probe_one(s) for s in SOURCES]

    if a.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return 0

    append_csv(a.log, rows)
    for r in rows:
        flag = {'ok': '✓', 'degraded': '△', 'empty': '○', 'fail': '✗',
                'unreachable': '…', 'need_token': '🔑'}.get(r['status'], '?')
        extra = f" {r['err'][:40]}" if r['err'] else ''
        print(f"{flag} {r['label']:<18} {r['status']:<11} http={r['http']:<4} "
              f"{r['ms']:>5}ms {r['bytes']:>6}B url={r['has_url']} lyric={r['has_lyric']}{extra}")
    print(f'\n已追加 {len(rows)} 条 → {a.log}')
    print('累计可用率：python scripts/probes/qishui-source-probe.py --summary')
    return 0


if __name__ == '__main__':
    sys.exit(main())
