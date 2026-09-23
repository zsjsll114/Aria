# -*- coding: utf-8 -*-
"""tests/python/test_cache_lock.py — 音频缓存写入互斥认领单测

覆盖 server._try_claim_writer（原 _handle_audio_stream 内联逻辑，已抽纯函数）：
  1. 同 clean_id 并发认领唯一性（仅一个 writer）
  2. 非从头请求(start!=0)不认领
  3. 正式缓存已存在时不认领（走直读，不落盘）
  4. 释放(discard)后同 id 可再次认领（后台续传晋升路径）
  5. 不同 clean_id 各自可认领

运行：python -m unittest tests.python.test_cache_lock -v
"""
import os
import shutil
import sys
import tempfile
import threading
import unittest

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, PROJECT_DIR)

import server  # noqa: E402


class TestClaimWriter(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix='aria_lock_')
        server._AUDIO_CACHE_WRITERS.clear()

    def tearDown(self):
        server._AUDIO_CACHE_WRITERS.clear()
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _cache(self, name='song.mp3'):
        return os.path.join(self._tmp, name)

    def test_same_id_first_try_wins(self):
        p = self._cache()
        self.assertTrue(server._try_claim_writer('songX', 0, p))
        # 第二次同 id 再认领失败（已被占用）
        self.assertFalse(server._try_claim_writer('songX', 0, p))

    def test_concurrent_same_id_only_one_writer(self):
        """核心竞态：8 线程并发同一 clean_id，只能有 1 个成为 writer"""
        p = self._cache()
        results = []
        lock = threading.Lock()

        def worker():
            r = server._try_claim_writer('songX', 0, p)
            with lock:
                results.append(r)

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(results.count(True), 1)
        self.assertEqual(len(results), 8)

    def test_range_request_never_becomes_writer(self):
        p = self._cache()
        for start in (1, 12345):
            self.assertFalse(server._try_claim_writer('songX', start, p), f'start={start}')

    def test_existing_cache_never_rewrites(self):
        """正式缓存已存在 → 不认领（并发 Range 直读不受影响）"""
        p = self._cache()
        with open(p, 'wb') as f:
            f.write(b'complete')
        self.assertFalse(server._try_claim_writer('songX', 0, p))
        self.assertEqual(os.path.getsize(p), 8)  # 未被截断重写

    def test_release_then_reclaim(self):
        """writer 释放(后台续传晋升/异常退出)后同 id 可再次认领"""
        p = self._cache()
        self.assertTrue(server._try_claim_writer('songX', 0, p))
        server._AUDIO_CACHE_WRITERS.discard('songX')
        self.assertTrue(server._try_claim_writer('songX', 0, p))

    def test_different_ids_both_claimable(self):
        p1, p2 = self._cache('a.mp3'), self._cache('b.mp3')
        self.assertTrue(server._try_claim_writer('idA', 0, p1))
        self.assertTrue(server._try_claim_writer('idB', 0, p2))


if __name__ == '__main__':
    unittest.main(verbosity=2)