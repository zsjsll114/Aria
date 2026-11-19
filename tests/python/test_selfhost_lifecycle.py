# -*- coding: utf-8 -*-
"""selfhost_service lifecycle / status_all contract tests."""
import os
import sys
import unittest
from unittest.mock import patch

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import selfhost_service as sh  # noqa: E402


class TestSelfhostLifecycle(unittest.TestCase):
    def setUp(self):
        self._orig_persist = sh._persist_login
        self._orig_save_cfg = sh._save_service_config
        self._orig_cfg = {k: dict(v) for k, v in sh._SERVICE_CONFIG.items()}
        sh._persist_login = lambda: None
        sh._save_service_config = lambda: None
        self._saved = {}
        for name, svc in sh._STATE.items():
            self._saved[name] = (
                svc.proc, svc.alive, svc.starting, svc.err,
                svc.cookie, svc.tmp, svc.uid, svc.nickname, svc.vip,
            )
            svc.proc = None
            svc.alive = False
            svc.starting = False
            svc.err = ''
            svc.cookie = ''
            svc.tmp = ''
            svc.uid = ''
            svc.nickname = ''
            svc.vip = ''
        sh._LG_CACHE.clear()

    def tearDown(self):
        sh._persist_login = self._orig_persist
        sh._save_service_config = self._orig_save_cfg
        for k, v in self._orig_cfg.items():
            sh._SERVICE_CONFIG[k] = v
        for name, vals in self._saved.items():
            svc = sh._STATE[name]
            (svc.proc, svc.alive, svc.starting, svc.err,
             svc.cookie, svc.tmp, svc.uid, svc.nickname, svc.vip) = vals
        sh._LG_CACHE.clear()

    def test_start_service_unknown_or_missing_dir(self):
        self.assertFalse(sh.start_service('unknown')['ok'])
        with patch('selfhost_service.os.path.isdir', return_value=False):
            r = sh.start_service('netease')
            self.assertFalse(r['ok'])
            self.assertIn('缺少源码目录', r['err'])

    def test_start_service_restart_calls_stop_and_ensure_running(self):
        stopped = []
        with patch('selfhost_service.os.path.isdir', return_value=True), \
             patch('selfhost_service.stop_service', side_effect=lambda n: stopped.append(n)), \
             patch('selfhost_service.ensure_running', return_value=True):
            r = sh.start_service('netease', restart=True)
        self.assertTrue(r['ok'])
        self.assertTrue(r['alive'])
        self.assertEqual(r['port'], 3201)
        self.assertEqual(stopped, ['netease'])

    def test_status_all_surfaces_port_error_and_nickname(self):
        sh._STATE['qq'].err = '未检测到 Node.js'
        sh._STATE['qq'].alive = False
        sh._STATE['netease'].alive = True
        sh._STATE['netease'].cookie = 'MUSIC_U=abc'
        sh._STATE['netease'].uid = '1001'
        sh._STATE['netease'].nickname = '云音乐达人'
        sh._STATE['netease'].vip = 'vip'
        sh._LG_CACHE['netease'] = {'at': 9e12, 'ok': True}
        with patch('selfhost_service.os.path.isdir', return_value=True), \
             patch('selfhost_service._probe_alive', side_effect=lambda n: n == 'netease'), \
             patch('selfhost_service._ensure_running_async') as mock_spawn, \
             patch('selfhost_service._exposed_cached', return_value=False):
            st = sh.status_all()
        self.assertEqual(st['qq']['port'], 3200)
        self.assertEqual(st['qq']['error'], '未检测到 Node.js')
        self.assertEqual(st['netease']['port'], 3201)
        self.assertEqual(st['netease']['nickname'], '云音乐达人')
        self.assertEqual(st['netease']['vip'], 'vip')
        self.assertNotIn('qishui', st)
        # qq already has err and should NOT spin-spawn while errored
        spawned_names = [call.args[0] for call in mock_spawn.call_args_list]
        self.assertNotIn('qq', spawned_names)
        self.assertIn('config', st['qq'])
        self.assertIn('config', st['kugou'])

    def test_normalize_qq_uid_and_service_config_updates(self):
        self.assertEqual(sh._normalize_qq_uid('o00123456'), '123456')
        self.assertEqual(sh._normalize_qq_uid('O000'), '0')
        self.assertEqual(sh._normalize_qq_uid(' 98765 '), '98765')
        self.assertEqual(sh._normalize_qq_uid(''), '')

        self.assertFalse(sh.set_service_config('invalid', {})['ok'])
        r_kg = sh.set_service_config('kugou', {'platform': 'standard', 'proxy': ' http://127.0.0.1:7890 '})
        self.assertTrue(r_kg['ok'])
        self.assertEqual(r_kg['config']['platform'], 'standard')
        self.assertEqual(r_kg['config']['proxy'], 'http://127.0.0.1:7890')

        r_qq = sh.set_service_config('qq', {'fallbackMode': False, 'useGlobalCookie': True})
        self.assertTrue(r_qq['ok'])
        self.assertFalse(r_qq['config']['fallbackMode'])
        self.assertTrue(r_qq['config']['useGlobalCookie'])
        self.assertEqual(sh.get_service_config('qq'), r_qq['config'])


if __name__ == '__main__':
    unittest.main()
