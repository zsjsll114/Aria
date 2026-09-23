# -*- coding: utf-8 -*-
"""tests/python/test_kugou_cellphone.py — 酷狗「手机号 + 短信验证码登录」单测

全部用 unittest.mock 注入假响应，**不碰网络、不写落盘登录态**。

为什么要覆盖这些点：
  · `/captcha/sent` 与 `/login/cellphone` 的返回里，`data` 有时是**字符串**
    （如 `{"data":"手机格式不正确","status":0,"error_code":20010}`），
    早期实现直接 `d['data'].get(...)` 会抛 AttributeError —— 这里做回归保护。
  · `_persist_login` 一旦被真实调用会覆盖 cache/selfhost_login.json，
    测试里必须 patch 掉，否则会毁掉本机真实登录态。

运行：python -m unittest tests.python.test_kugou_cellphone -v
"""
import os
import sys
import unittest
from unittest.mock import patch

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, PROJECT_DIR)

import selfhost_service  # noqa: E402


class TestKugouErrMsg(unittest.TestCase):
    def test_prefers_error_field(self):
        self.assertEqual(
            selfhost_service._kg_err_msg({'error': '本次请求需要验证'}, 'fb'), '本次请求需要验证')

    def test_falls_back_to_string_data(self):
        """★ 酷狗常把文案放 data 且是字符串（早期 bug 的来源）"""
        self.assertEqual(
            selfhost_service._kg_err_msg(
                {'data': '手机格式不正确', 'status': 0, 'error_code': 20010}, 'fb'),
            '手机格式不正确')

    def test_dict_data_falls_through_to_fallback(self):
        self.assertEqual(selfhost_service._kg_err_msg({'data': {'token': 'x'}}, 'fb'), 'fb')

    def test_empty_strings_ignored(self):
        self.assertEqual(selfhost_service._kg_err_msg({'error': '', 'data': ''}, 'fb'), 'fb')

    def test_non_dict_safe(self):
        self.assertEqual(selfhost_service._kg_err_msg({}, 'fb'), 'fb')


class TestSendCaptcha(unittest.TestCase):
    def test_rejects_bad_mobile_without_calling_vendor(self):
        with patch('selfhost_service._proxy_raw') as m:
            r = selfhost_service.kugou_send_captcha('kugou', 'abc')
        self.assertFalse(r['ok'])
        self.assertIn('格式', r['err'])
        m.assert_not_called()

    def test_success_status_1(self):
        with patch('selfhost_service._proxy_raw', return_value=(200, {'status': 1}, b'', [])):
            self.assertTrue(selfhost_service.kugou_send_captcha('kugou', '13800000000')['ok'])

    def test_success_error_code_0(self):
        with patch('selfhost_service._proxy_raw', return_value=(200, {'error_code': 0}, b'', [])):
            self.assertTrue(selfhost_service.kugou_send_captcha('kugou', '13800000000')['ok'])

    def test_vendor_error_surfaces_message(self):
        with patch('selfhost_service._proxy_raw',
                   return_value=(200, {'data': '手机格式不正确', 'status': 0, 'error_code': 20010}, b'', [])):
            r = selfhost_service.kugou_send_captcha('kugou', '00000')
        self.assertFalse(r['ok'])
        self.assertEqual(r['err'], '手机格式不正确')

    def test_vendor_non_dict_body_does_not_crash(self):
        with patch('selfhost_service._proxy_raw', return_value=(502, None, b'', [])):
            self.assertFalse(selfhost_service.kugou_send_captcha('kugou', '13800000000')['ok'])


class TestLoginCellphone(unittest.TestCase):
    def setUp(self):
        st = selfhost_service._STATE['kugou']
        self._saved = (st.cookie, st.uid)
        # ★ 必须 patch：否则会把假 token 写进 cache/selfhost_login.json
        self._p_persist = patch('selfhost_service._persist_login', return_value=None)
        self._p_persist.start()

    def tearDown(self):
        self._p_persist.stop()
        st = selfhost_service._STATE['kugou']
        st.cookie, st.uid = self._saved

    def test_requires_mobile_and_code(self):
        self.assertFalse(selfhost_service.login_kugou_cellphone('kugou', '', '123456')['ok'])
        self.assertFalse(selfhost_service.login_kugou_cellphone('kugou', '13800000000', '')['ok'])

    def test_string_data_does_not_crash(self):
        """★ 回归：data 是字符串时早期实现会抛 AttributeError"""
        with patch('selfhost_service._proxy_raw',
                   return_value=(200, {'data': '参数错误', 'status': 0, 'error_code': 20010}, b'', [])):
            r = selfhost_service.login_kugou_cellphone('kugou', '13800000000', '123456')
        self.assertFalse(r['ok'])
        self.assertEqual(r['err'], '参数错误')

    def test_token_from_set_cookie(self):
        setc = ['token=abc123; PATH=/', 'userid=2256708976; PATH=/']
        with patch('selfhost_service._proxy_raw',
                   return_value=(200, {'status': 1, 'data': {'t1': 'x'}}, b'', setc)):
            r = selfhost_service.login_kugou_cellphone('kugou', '13800000000', '123456')
        self.assertTrue(r['ok'])
        self.assertTrue(r['loggedIn'])
        st = selfhost_service._STATE['kugou']
        self.assertEqual(st.cookie, 'token=abc123;userid=2256708976')
        self.assertEqual(st.uid, '2256708976')

    def test_token_from_body(self):
        with patch('selfhost_service._proxy_raw',
                   return_value=(200, {'status': 1, 'data': {'token': 't9', 'userid': 42}}, b'', [])):
            r = selfhost_service.login_kugou_cellphone('kugou', '13800000000', '123456')
        self.assertTrue(r['ok'])
        self.assertEqual(selfhost_service._STATE['kugou'].cookie, 'token=t9;userid=42')

    def test_status_1_without_token_is_failure(self):
        with patch('selfhost_service._proxy_raw',
                   return_value=(200, {'status': 1, 'data': {}}, b'', [])):
            self.assertFalse(
                selfhost_service.login_kugou_cellphone('kugou', '13800000000', '123456')['ok'])


if __name__ == '__main__':
    unittest.main()
