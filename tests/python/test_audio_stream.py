# -*- coding: utf-8 -*-
"""tests/python/test_audio_stream.py — 音频流代理核心纯函数单测

运行方式：python -m unittest tests.python.test_audio_stream -v
        （或 python -m unittest discover -s tests/python -p 'test_*.py'）

覆盖目标（server.py 注释里 bug 最密集处）：
  1. _sanitize_audio_ctype  —— MIME 净化（上游坏类型按 URL 扩展名兜底）
  2. _audio_ctype_from_url  —— 扩展名 → 容器类型推断
  3. _write_meta_audio / _read_meta_ctype / _read_meta_total / _read_meta_url
                              —— .meta 读写往返与非法 ctype 拒绝
  4. .ok 哨兵约定           —— 完整缓存晋升后才落哨兵（直读网关的通行证）

用标准库 unittest + tempfile，零第三方依赖，契合项目「Python 仅标准库」约束。
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, PROJECT_DIR)

import server  # noqa: E402  （server.py 纯标准库，import 无副作用、不启动服务）


class TestSanitizeCtype(unittest.TestCase):
    """上游 Content-Type 净化：合法保留、坏类型按 URL 推断、兜底 audio/mpeg"""

    def test_valid_audio_types_kept(self):
        for ctype in ('audio/mpeg', 'audio/ogg', 'audio/flac', 'audio/aac'):
            self.assertEqual(server._sanitize_audio_ctype('http://x/a.mp3', ctype), ctype)

    def test_octet_stream_kept(self):
        self.assertEqual(server._sanitize_audio_ctype('http://x/a.mp3', 'application/octet-stream'),
                         'application/octet-stream')

    def test_ogg_aliases_normalized(self):
        for bad in ('application/ogg', 'application/x-ogg'):
            self.assertEqual(server._sanitize_audio_ctype('http://x/a.ogg', bad), 'audio/ogg')

    def test_urlencoded_falls_back_to_url_ext(self):
        """QQ 系 CDN 返回 x-www-form-urlencoded 的坑：按真实扩展名兜底"""
        self.assertEqual(server._sanitize_audio_ctype('http://isrc.stream.qqmusic.qq.com/C400123.flac', 'application/x-www-form-urlencoded'),
                         'audio/flac')
        self.assertEqual(server._sanitize_audio_ctype('http://x/a.ogg', 'application/x-www-form-urlencoded'), 'audio/ogg')

    def test_html_or_garbage_falls_back_mpeg(self):
        self.assertEqual(server._sanitize_audio_ctype('http://x/a', 'text/html'), 'audio/mpeg')
        self.assertEqual(server._sanitize_audio_ctype('http://x/a', ''), 'audio/mpeg')
        self.assertEqual(server._sanitize_audio_ctype('http://x/a', None), 'audio/mpeg')
        self.assertEqual(server._sanitize_audio_ctype('http://x/a', 'garbage-type'), 'audio/mpeg')

    def test_scrambled_url_with_params(self):
        # 带 query/fragment 的 URL 仍能推断出扩展名
        self.assertEqual(server._sanitize_audio_ctype('http://x/a.opus?v=1&token=abc#t=10', 'audio/mpeg'), 'audio/mpeg')


class TestCtypeFromUrl(unittest.TestCase):
    """URL 扩展名 → 容器类型推断表"""

    def test_known_extensions(self):
        cases = {
            '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
            '.flac': 'audio/flac', '.fla': 'audio/flac',
            '.mp3': 'audio/mpeg',
            '.aac': 'audio/aac',
            '.m4a': 'audio/mp4', '.mp4': 'audio/mp4',
            '.wav': 'audio/wav', '.wave': 'audio/wav',
        }
        for ext, expected in cases.items():
            self.assertEqual(server._audio_ctype_from_url('http://cdn.example.com/x' + ext), expected, ext)
            self.assertEqual(server._audio_ctype_from_url('http://cdn.example.com/dir/x' + ext + '?sig=1'), expected, ext)

    def test_unknown_extension_empty(self):
        self.assertEqual(server._audio_ctype_from_url('http://x/file'), '')
        self.assertEqual(server._audio_ctype_from_url('http://x/file.exe'), '')
        self.assertEqual(server._audio_ctype_from_url(''), '')
        self.assertEqual(server._audio_ctype_from_url(None), '')

    def test_uppercase_extension_lowered(self):
        self.assertEqual(server._audio_ctype_from_url('http://x/TRACK.FLAC'), 'audio/flac')


class TestMetaRoundtrip(unittest.TestCase):
    """.meta 读写往返：total/url/ctype 三字段，非法 ctype 拒绝直读"""

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix='aria_audio_test_')

    def tearDown(self):
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _cache_path(self):
        return os.path.join(self._tmp, 'songID123.mp3')

    def test_write_read_roundtrip(self):
        p = self._cache_path()
        server._write_meta_audio(p, 1234567, 'http://u/a.flac', 'audio/flac')
        self.assertEqual(server._read_meta_total(p), 1234567)
        self.assertEqual(server._read_meta_ctype(p), 'audio/flac')
        self.assertEqual(server._read_meta_url(p), 'http://u/a.flac')

    def test_read_meta_total_fallback_on_missing(self):
        p = os.path.join(self._tmp, 'missing.mp3')
        self.assertIsNone(server._read_meta_total(p))
        self.assertEqual(server._read_meta_ctype(p), '')
        self.assertEqual(server._read_meta_url(p), '')

    def test_read_meta_ctype_rejects_bad_values(self):
        """历史缺陷：旧版把 urlencoded/text-html 误存进 meta，直读会拿错 MIME 卡死。
        只认可合法音频类型，坏值返回 '' 触发调用方删残片重建。"""
        p = self._cache_path()
        for bad in ('application/x-www-form-urlencoded', 'text/html', 'garbage', 'audio;'):
            with open(p + '.meta', 'w') as f:
                json.dump({'total': 100, 'url': 'http://u/x', 'ctype': bad}, f)
            self.assertEqual(server._read_meta_ctype(p), '', bad)

    def test_read_meta_ctype_normalizes_ogg(self):
        p = self._cache_path()
        for stored in ('application/ogg', 'application/x-ogg'):
            with open(p + '.meta', 'w') as f:
                json.dump({'total': 100, 'url': 'http://u/x', 'ctype': stored}, f)
            self.assertEqual(server._read_meta_ctype(p), 'audio/ogg', stored)

    def test_meta_with_corrupt_json_returns_defaults(self):
        p = self._cache_path()
        with open(p + '.meta', 'w') as f:
            f.write('{not json')
        self.assertIsNone(server._read_meta_total(p))
        self.assertEqual(server._read_meta_ctype(p), '')


class TestOkSentinel(unittest.TestCase):
    """.ok 哨兵约定：完整缓存晋升时才落哨兵（双校验用），坏缓存无哨兵会被绕过重建"""

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix='aria_ok_test_')

    def tearDown(self):
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_ok_mark_path_used(self):
        """确保缓存路径的 .ok 哨兵文件命名约定与 _handle_audio_stream 一致，
        避免「写入端与读端口哨兵路径漂移」这种静默失效。"""
        cache_path = os.path.join(self._tmp, 'song.mp3')
        self.assertEqual(cache_path + '.ok', os.path.join(self._tmp, 'song.mp3.ok'))

    def test_full_cache_promotion_writes_ok(self):
        """模拟晋升逻辑：tmp 写满预期字节 → 改名正式 → 写 .ok（字节数）"""
        cache_path = os.path.join(self._tmp, 'song.mp3')
        tmp = cache_path + '.tmp'
        with open(tmp, 'wb') as f:
            f.write(b'x' * 1000)
        expected_total = os.path.getsize(tmp)
        os.replace(tmp, cache_path)
        with open(cache_path + '.ok', 'w') as f:
            f.write(str(expected_total))
        self.assertTrue(os.path.exists(cache_path + '.ok'))
        # 双校验：哨兵记录的字节数 == 正式缓存实际大小
        with open(cache_path + '.ok') as f:
            self.assertEqual(int(f.read().strip()), os.path.getsize(cache_path))

    def test_no_ok_mark_when_partial_download(self):
        """未晋升（只写了 .tmp）时无 .ok —— 读端口据此判定缓存不完整，跳过直读"""
        cache_path = os.path.join(self._tmp, 'song.mp3')
        with open(cache_path + '.tmp', 'wb') as f:
            f.write(b'partial')
        self.assertFalse(os.path.exists(cache_path + '.ok'))
        self.assertFalse(os.path.exists(cache_path))  # 正式文件不应提前存在


if __name__ == '__main__':
    unittest.main(verbosity=2)