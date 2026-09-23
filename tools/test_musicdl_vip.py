# -*- coding: utf-8 -*-
"""
musicdl VIP 歌曲获取能力测试
测试歌曲均为 QQ 音乐平台 VIP 歌曲，验证 musicdl 各源能否取到可下载链接
"""
import sys
import time
import warnings
warnings.filterwarnings('ignore')

from musicdl.musicdl import MusicClient

# 测试用 VIP 歌曲（QQ音乐标记为 VIP/付费）
TEST_SONGS = [
    "周杰伦 晴天",
    "周杰伦 告白气球",
    "林俊杰 江南",
    "邓紫棋 光年之外",
]

# 所有可用源
SOURCES = ['MiguMusicClient', 'QQMusicClient', 'NeteaseMusicClient', 'KuwoMusicClient', 'QianqianMusicClient']

def fmt_size(b):
    if not b: return '?'
    if b > 1048576: return f"{b/1048576:.1f}MB"
    if b > 1024: return f"{b/1024:.1f}KB"
    return f"{b}B"

def test_song(keyword, sources):
    print(f"\n{'='*70}")
    print(f"  搜索: {keyword}")
    print(f"{'='*70}")
    try:
        client = MusicClient(music_sources=sources)
        t0 = time.time()
        results = client.search(keyword=keyword)
        elapsed = time.time() - t0
        print(f"  耗时: {elapsed:.1f}s\n")
    except Exception as e:
        print(f"  搜索失败: {e}")
        return

    for source_name, song_list in results.items():
        if not song_list:
            print(f"  [{source_name}] 无结果")
            continue
        # 只看前3条
        print(f"  [{source_name}] 找到 {len(song_list)} 首，前3条:")
        for i, song in enumerate(song_list[:3]):
            has_url = bool(getattr(song, 'download_url', None) and str(song.download_url).startswith('http'))
            ext = getattr(song, 'ext', '?')
            size = fmt_size(getattr(song, 'file_size_bytes', 0))
            dur = getattr(song, 'duration', '?')
            name = getattr(song, 'song_name', '?')
            singer = getattr(song, 'singers', '?')
            url_head = str(song.download_url)[:60] if has_url else 'N/A'
            tag = f"✓ 可下载 [{ext} {size} {dur}]" if has_url else "✗ 无链接"
            print(f"    {i+1}. {name} - {singer}")
            print(f"       {tag}")
            print(f"       URL: {url_head}{'...' if has_url and len(str(song.download_url))>60 else ''}")

def main():
    print("=" * 70)
    print("  musicdl VIP 歌曲获取能力测试")
    print(f"  musicdl 版本: {__import__('musicdl').__version__}")
    print(f"  测试源: {', '.join(SOURCES)}")
    print(f"  测试歌曲: {len(TEST_SONGS)} 首（均为QQ音乐VIP歌曲）")
    print("=" * 70)

    summary = {}
    for keyword in TEST_SONGS:
        test_song(keyword, SOURCES)

    print(f"\n{'='*70}")
    print("  测试完成")
    print(f"{'='*70}")

if __name__ == '__main__':
    main()
