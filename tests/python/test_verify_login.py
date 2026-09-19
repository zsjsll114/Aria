# -*- coding: utf-8 -*-
"""tests/python/test_verify_login.py — 登录态失效校验单测

用 unittest.mock.patch 注入 proxy_request 假响应（不碰网络），覆盖
selfhost_service._verify_login 三平台判定：
  - 酷狗：/user/detail 无 data.nickname → 失效
  - QQ：c6.y.qq.com 返回 code!=0 → 失效
  - 网易云：profile 无 userId → 失效
  - 校验异常 → 保守 True（网络/风控异常不判掉线）
运行：python -m unittest tests.python.test_verify_login -v
"""
import os
import sys
import time
import unittest
from unittest.mock import patch

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, PROJECT_DIR)

import selfhost_service  # noqa: E402


class TestVerifyLogin(unittest.TestCase):
    def setUp(self):
        selfhost_service._LG_CACHE.clear()
        selfhost_service._NET_PR['at'] = 0.0

    # ---------- 酷狗 ----------
    def test_kugou_valid_nickname_true(self):
        with patch('selfhost_service.proxy_request',
                   return_value=(200, {'data': {'nickname': '老用户'}}, None)):
            self.assertTrue(selfhost_service._verify_login('kugou'))

    def test_kugou_missing_nickname_false(self):
        """token 失效时 /user/detail 无 data.nickname（签到代码同判据）"""
        with patch('selfhost_service.proxy_request',
                   return_value=(200, {'data': {}}, None)):
            self.assertFalse(selfhost_service._verify_login('kugou'))

    # ---------- QQ ----------
    def test_qq_code_zero_true(self):
        with patch('selfhost_service._resolve_uid', return_value='123',
                   ), patch('selfhost_service.proxy_request',
                            return_value=(200, {'response': {'code': 0}}, None)):
            self.assertTrue(selfhost_service._verify_login('qq'))

    def test_qq_code_nonzero_false(self):
        """未登录时 c6.y.qq.com 返回 code != 0"""
        with patch('selfhost_service._resolve_uid', return_value='123',
                   ), patch('selfhost_service.proxy_request',
                            return_value=(200, {'response': {'code': 400}}, None)):
            self.assertFalse(selfhost_service._verify_login('qq'))

    def test_qq_no_uid_false(self):
        with patch('selfhost_service._resolve_uid', return_value='',
                   ), patch('selfhost_service.proxy_request') as fake:
            self.assertFalse(selfhost_service._verify_login('qq'))
            fake.assert_not_called()

    # ---------- 网易云 ----------
    def test_netease_profile_userid_true(self):
        with patch('selfhost_service.proxy_request',
                   return_value=(200, {'profile': {'userId': 999}}, None)):
            self.assertTrue(selfhost_service._verify_login('netease'))

    def test_netease_no_profile_false(self):
        with patch('selfhost_service.proxy_request',
                   return_value=(200, {'profile': {}}, None)):
            self.assertFalse(selfhost_service._verify_login('netease'))

    # ---------- 异常与缓存 ----------
    def test_exception_conservative_true(self):
        """校验抛异常（网络/风控）→ 保守返回 True，等下次 TTL 再验"""
        with patch('selfhost_service.proxy_request', side_effect=OSError('boom')):
            self.assertTrue(selfhost_service._verify_login('netease'))

    def test_result_is_cached(self):
        """校验结果写入 _LG_CACHE，TTL 内重复调用不再打接口"""
        with patch('selfhost_service.proxy_request',
                   return_value=(200, {'data': {'nickname': 'x'}}, None)) as fake:
            self.assertTrue(selfhost_service._verify_login('kugou'))
            self.assertTrue(selfhost_service._verify_login('kugou'))
            fake.assert_called_once()  # 第二次命中缓存

    def test_cache_expires_then_recheck(self):
        """TTL 过期后重新真实校验"""
        with patch('selfhost_service.proxy_request',
                   return_value=(200, {'data': {'nickname': 'x'}}, None)) as fake:
            self.assertTrue(selfhost_service._verify_login('kugou'))
            rec = selfhost_service._LG_CACHE.get('kugou')
            self.assertIsNotNone(rec)
            rec['at'] = time.time() - 10 ** 9  # 强制过期
            self.assertTrue(selfhost_service._verify_login('kugou'))
            self.assertEqual(fake.call_count, 2)


if __name__ == '__main__':
    unittest.main(verbosity=2)