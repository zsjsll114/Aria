# -*- coding: utf-8 -*-
"""NPS/now-playing HTTP 探针

用途：不动浏览器，直接读 NPS 的 HTTP 接口，回答这几类问题：
  1. 响应结构是什么（字段名 / 层级）——判「歌词走哪个字段」；
  2. 进度字段的**精度**（整数秒 vs 毫秒）——判「虚拟时钟为什么一顿一顿」；
  3. 连续轮询 N 次时的**抖动曲线**——把每个时间源的原始值并排打出来。

用法：
    python scripts/probes/nps-http-probe.py                 # 打一次结构
    python scripts/probes/nps-http-probe.py --json          # 打完整 JSON
    python scripts/probes/nps-http-probe.py --watch 10 0.5  # 连采 10 次、间隔 0.5s
    python scripts/probes/nps-http-probe.py --host http://127.0.0.1:9863

只读，不发任何修改类请求。
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request

# 关心的时间/歌词字段（不同版本命名不一，都列上）
TIME_KEYS = ('progress', 'seek', 'seekbarCurrentPosition', 'position',
             'currentPosition', 'duration', 'seekbarDuration')
LYRIC_KEYS = ('lyric', 'lyrics', 'lrc', 'krc', 'qrc', 'karaokeLyric', 'hasKaraokeLyric')


def fetch(url, timeout=6):
    req = urllib.request.Request(url, headers={'User-Agent': 'aria-probe/1.0'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8', 'replace'))


def shape(o, p='', depth=0, max_depth=4):
    """压平成 'path: type = value'，长字符串只留前 110 字符。"""
    out = []
    if depth > max_depth:
        return out
    if isinstance(o, dict):
        for k, v in o.items():
            if isinstance(v, dict):
                out.append(f'{p}{k}: object')
                out += shape(v, p + '  ', depth + 1, max_depth)
            elif isinstance(v, list):
                out.append(f'{p}{k}: array({len(v)})')
                if v:
                    out += shape(v[0], p + '  [0].', depth + 1, max_depth)
            elif isinstance(v, str):
                s = v if len(v) <= 110 else v[:110] + '…'
                out.append(f'{p}{k}: str(len={len(v)}) = {s!r}')
            else:
                out.append(f'{p}{k}: {type(v).__name__} = {v!r}')
    return out


def find_keys(o, keys, p=''):
    """递归找关心的字段，返回 [(path, value)…]"""
    hits = []
    if isinstance(o, dict):
        for k, v in o.items():
            path = f'{p}.{k}' if p else k
            if k in keys:
                hits.append((path, v))
            if isinstance(v, (dict, list)):
                hits += find_keys(v, keys, path)
    elif isinstance(o, list):
        for i, v in enumerate(o[:3]):
            hits += find_keys(v, keys, f'{p}[{i}]')
    return hits


def precision(v):
    """判断一个数值是整数秒还是毫秒级。"""
    if not isinstance(v, (int, float)):
        return '非数值'
    if isinstance(v, float) and not v.is_integer():
        return '小数秒（毫秒级精度）'
    if abs(v) > 100000:
        return '大整数（疑似毫秒）'
    if float(v).is_integer():
        return '整数（疑似整秒，有截断）'
    return '未知'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', default='http://127.0.0.1:9863')
    ap.add_argument('--path', default='/api/query')
    ap.add_argument('--json', action='store_true', help='打印完整 JSON')
    ap.add_argument('--watch', nargs=2, metavar=('TIMES', 'INTERVAL'),
                    help='连采 N 次、每次间隔秒数，看抖动')
    a = ap.parse_args()
    url = a.host.rstrip('/') + a.path

    try:
        data = fetch(url)
    except urllib.error.URLError as e:
        print(f'连不上 {url}：{e}')
        print('（NPS 未启动？或端口不是 9863）')
        return 1

    if a.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return 0

    print(f'=== {url} 结构 ===')
    print('\n'.join(shape(data)) or '(空)')

    print('\n=== 时间字段精度（判"一顿一顿"的关键）===')
    for path, v in find_keys(data, TIME_KEYS):
        print(f'  {path:44s} = {v!r:>16}  → {precision(v)}')

    print('\n=== 歌词字段 ===')
    lyr = find_keys(data, LYRIC_KEYS)
    if not lyr:
        print('  (无歌词字段——NPS 可能只在 WS 推歌词，用 nps-ws-probe.mjs 看)')
    for path, v in lyr:
        if isinstance(v, str):
            print(f'  {path}: str(len={len(v)}) 前 300 字符:\n    {v[:300]!r}')
        else:
            print(f'  {path} = {v!r}')

    if a.watch:
        times, interval = int(a.watch[0]), float(a.watch[1])
        print(f'\n=== 连采 {times} 次、间隔 {interval}s：原始值抖动 ===')
        print(f'{"#":>3}  {"progress":>12}  {"seekbarPos":>10}  {"isPaused":>9}')
        for i in range(times):
            try:
                d = fetch(url)
            except Exception as e:
                print(f'{i:>3}  采样失败: {e}')
                break
            vals = dict((p.split('.')[-1], v) for p, v in
                        find_keys(d, ('progress', 'seekbarCurrentPosition', 'isPaused')))
            print(f'{i:>3}  {str(vals.get("progress")):>12}  '
                  f'{str(vals.get("seekbarCurrentPosition")):>10}  '
                  f'{str(vals.get("isPaused")):>9}')
            if i < times - 1:
                time.sleep(interval)
        print('\n判读：progress 是毫秒、seekbarCurrentPosition 是整秒时，')
        print('      两者混用会把平滑时钟反复拽回整秒 → 表现为"一顿一顿"。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
