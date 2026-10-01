#!/usr/bin/env python3
"""版本号同步：server.py 的 SERVER_VERSION 是唯一来源，本脚本把它推到
package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml。

用法：
    python scripts/sync_version.py          # 同步（就地改写，保留原格式）
    python scripts/sync_version.py --check  # 只校验不写入，漂移时 exit 1（CI 门禁）

设计约束：
- 纯标准库（agents.md 硬约束：Python 侧不许引第三方）。
- 全部走「行内正则替换」而非 JSON round-trip —— 后者会把紧凑数组展开成多行，
  制造无关 diff。
- Cargo.toml 只替换 [package] 段行首的 version（依赖的 version 都在 {} 内联，不锚行首）。
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SERVER_PY = os.path.join(ROOT, 'server.py')

# (文件相对路径, 匹配模式, 替换模板) —— 模板里 {ver} 会被目标版本替换
TARGETS = [
    ('package.json',
     re.compile(r'("version"\s*:\s*")[^"]*(")'),
     r'\g<1>{ver}\g<2>'),
    (os.path.join('src-tauri', 'tauri.conf.json'),
     re.compile(r'("version"\s*:\s*")[^"]*(")'),
     r'\g<1>{ver}\g<2>'),
    (os.path.join('src-tauri', 'Cargo.toml'),
     re.compile(r'(?m)^version\s*=\s*"[^"]*"'),
     'version = "{ver}"'),
]


def read_source_version():
    """从 server.py 提取 SERVER_VERSION 常量值。"""
    with open(SERVER_PY, 'r', encoding='utf-8') as f:
        text = f.read()
    m = re.search(r'''(?m)^SERVER_VERSION\s*=\s*['"]([^'"]+)['"]''', text)
    if not m:
        print('错误：server.py 里找不到 SERVER_VERSION 常量', file=sys.stderr)
        sys.exit(2)
    return m.group(1)


def main():
    check_only = '--check' in sys.argv[1:]
    want = read_source_version()
    drifted = []

    for rel, pattern, template in TARGETS:
        path = os.path.join(ROOT, rel)
        with open(path, 'r', encoding='utf-8') as f:
            text = f.read()
        m = pattern.search(text)
        if not m:
            print(f'错误：{rel} 里找不到版本号字段', file=sys.stderr)
            sys.exit(2)
        # 现行值：Cargo.toml 模式整行匹配，需二次提取；JSON 两个模式第一组即引号前
        cur_m = re.search(r'[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z.\-]*', m.group(0))
        current = cur_m.group(0) if cur_m else '?'
        if current == want:
            print(f'  一致  {rel} = {want}')
            continue
        drifted.append(rel)
        if check_only:
            print(f'  漂移  {rel}: {current} != {want}')
            continue
        new_text = pattern.sub(template.replace('{ver}', want), text, count=1)
        with open(path, 'w', encoding='utf-8', newline='') as f:
            f.write(new_text)
        print(f'  已同步 {rel}: {current} -> {want}')

    if check_only and drifted:
        print(f'\n版本号漂移：{len(drifted)} 个文件与 server.py 的 {want} 不一致。'
              f'运行 python scripts/sync_version.py 修复。', file=sys.stderr)
        sys.exit(1)
    if not drifted:
        print(f'版本号全部一致：{want}')


if __name__ == '__main__':
    main()
