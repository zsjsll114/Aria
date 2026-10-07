# -*- coding: utf-8 -*-
"""
tests/python/test_qishui_login.py — 汽水自建服务的登录态分支单测（离线，不碰 vendor）

为什么必须有：汽水与另外三个自建平台的**登录态归属**根本不同 ——
kugou/qq/netease 的 cookie 会被真注入到上游请求里，所以「cookie 非空 = 已登录」成立；
汽水的会话在 vendor 侧（.session.json），Python 侧的 cookie 只是我们自编的标记串
`qishui-session`，注入无从谈起。于是 status_all 必须**去问 vendor** 才准。

这条链有两个容易静默坏掉的地方，本用例各钉一个：
  ① `_qishui_login_snapshot` 的 20s TTL —— 它为的是挡住前端 5s 一次的 status 轮询，
     否则每次轮询都要打 vendor（vendor 在已登录时还会顺带打上游取 profile）。
     TTL 写错（比如判定条件反了）功能上看不出来，只是默默把 vendor 打爆。
  ② vendor 探测异常时必须**保守判未登录**。方向不能反：误判「未登录」的代价只是
     多显示一次扫码按钮，误判「已登录」会让用户点下去才发现播不了。
"""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

import selfhost_service as sh  # noqa: E402  （导入会跑 _restore_login，只读不写）

NAME = 'qishui'


class _FakeVendor:
    """把 _proxy_raw 换成纯内存的假 vendor，并记下调用次数与最后一次请求。"""

    def __init__(self, replies=None, raises=None):
        self.replies = replies or {}
        self.raises = raises
        self.calls = []

    def __call__(self, name, method, path_and_query, body=None, headers=None):
        self.calls.append((method, path_and_query, body))
        if self.raises is not None:
            raise self.raises
        status, data = self.replies.get(path_and_query.split('?')[0], (200, {}))
        return status, data, {}, None


class QishuiLoginTest(unittest.TestCase):

    def setUp(self):
        self._orig_proxy = sh._proxy_raw
        self._orig_persist = sh._persist_login
        # _poll_qishui 成功时会落盘 cache/selfhost_login.json —— 单测不许动用户真实登录态
        sh._persist_login = lambda *a, **k: None
        st = sh._STATE[NAME]
        self._saved = (st.cookie, st.uid, st.tmp)
        st.cookie, st.uid, st.tmp = '', '', ''
        sh._QISHUI_PR.update({'at': 0.0, 'uid': '', 'loggedIn': False})

    def tearDown(self):
        sh._proxy_raw = self._orig_proxy
        sh._persist_login = self._orig_persist
        st = sh._STATE[NAME]
        st.cookie, st.uid, st.tmp = self._saved
        sh._QISHUI_PR.update({'at': 0.0, 'uid': '', 'loggedIn': False})

    # ---------- 服务配置（回环守卫依赖 start 里的相对路径）----------
    def test_service_config(self):
        cfg = sh._SERVICES[NAME]
        self.assertEqual(cfg['port'], 3300)
        self.assertEqual(cfg['env']['PORT'], '3300')
        self.assertTrue(cfg['dir'].endswith(os.path.join('_eval', 'qishui-music-api')), cfg['dir'])
        # ★ 适配层必须在受版本控制的 scripts/ 下（_eval/ 整个目录被 .gitignore），
        #   且必须用相对路径 —— 回环守卫经 NODE_OPTIONS 预加载，中文绝对路径过 cmd 会被毁。
        self.assertIn('scripts/qishui-server.mjs', cfg['start'])
        self.assertTrue(cfg['start'].startswith('node ../../'), cfg['start'])
        self.assertEqual(cfg['qr'], '_get_qr_qishui')
        self.assertEqual(cfg['poll'], '_poll_qishui')

    # ---------- 轮询：token 缺失 ----------
    def test_poll_missing_token_does_not_hit_vendor(self):
        fake = _FakeVendor()
        sh._proxy_raw = fake
        r = sh._poll_qishui(NAME, {})
        self.assertFalse(r['ok'])
        self.assertFalse(r['loggedIn'])
        self.assertIn('token', r['err'])
        self.assertEqual(len(fake.calls), 0, '没有 token 不该白打一次 vendor')

    def test_poll_token_from_tmp_fallback(self):
        sh._STATE[NAME].tmp = 'from-tmp'
        fake = _FakeVendor({'/login/qr/check': (200, {'ok': True, 'status': 'waiting'})})
        sh._proxy_raw = fake
        sh._poll_qishui(NAME, {})
        self.assertEqual(fake.calls[0][2], {'token': 'from-tmp'})

    # ---------- 轮询：等待 / 已扫 / 过期 状态原样透传 ----------
    def test_poll_status_passthrough(self):
        for status in ('waiting', 'scanned', 'expired', 'failed'):
            with self.subTest(status=status):
                sh._STATE[NAME].tmp = 'tok'
                sh._proxy_raw = _FakeVendor(
                    {'/login/qr/check': (200, {'ok': True, 'status': status, 'message': 'm'})})
                r = sh._poll_qishui(NAME, {'key': 'tok'})
                self.assertTrue(r['ok'])
                self.assertFalse(r['loggedIn'])
                self.assertEqual(r['status'], status)
                self.assertEqual(r['message'], 'm')
                self.assertEqual(sh._STATE[NAME].cookie, '', '未登录不得写标记 cookie')

    # ---------- 轮询：登录成功 → 写标记 + uid + 作废快照 ----------
    def test_poll_success_marks_session_and_invalidates_snapshot(self):
        sh._QISHUI_PR.update({'at': 123.0, 'uid': '', 'loggedIn': False})
        sh._STATE[NAME].tmp = 'tok'
        sh._proxy_raw = _FakeVendor(
            {'/login/qr/check': (200, {'ok': True, 'loggedIn': True, 'uid': 4242})})
        r = sh._poll_qishui(NAME, {'key': 'tok'})
        self.assertTrue(r['ok'])
        self.assertTrue(r['loggedIn'])
        self.assertEqual(r['uid'], '4242')
        self.assertEqual(sh._STATE[NAME].cookie, 'qishui-session', '标记而非真 cookie')
        self.assertEqual(sh._STATE[NAME].uid, '4242')
        self.assertEqual(sh._STATE[NAME].tmp, '', '登录后应清掉二维码会话 token')
        self.assertEqual(sh._QISHUI_PR['at'], 0.0, '登录后必须作废快照，否则 20s 内仍报未登录')

    # ---------- 轮询：失败必须显式上报，不得静默降级成「等待扫码…」 ----------
    def test_poll_failure_shapes_are_surfaced(self):
        """★ 回归「扫了码没反应」（用户 2026-10-03 反馈，称「没做校验」）。

        早期 _poll_qishui 只看 d['loggedIn']，于是三种失败被一视同仁地当成
        status='waiting' 透传：vendor 的业务报错（{ok:false}）、副进程没起来
        （HTTP 502 + {'error':...}）、响应根本不是 JSON。前端收到的是「一切正常，
        请继续等」，用户扫完码看到的就是界面毫无变化。
        """
        cases = [
            ('vendor 明确报错', (200, {'ok': False, 'err': '汽水 vendor 库未就绪'}), '汽水 vendor 库未就绪'),
            ('副进程没起来(502)', (502, {'error': '汽水 副进程未运行'}), '汽水 副进程未运行'),
            ('响应不是 JSON', (200, '<html>502 Bad Gateway</html>'), '<html>'),
        ]
        for label, reply, want in cases:
            with self.subTest(case=label):
                sh._STATE[NAME].tmp = 'tok'
                sh._proxy_raw = _FakeVendor({'/login/qr/check': reply})
                r = sh._poll_qishui(NAME, {'key': 'tok'})
                self.assertFalse(r['ok'], label)
                self.assertFalse(r['loggedIn'], label)
                self.assertNotIn(
                    'status', r,
                    '失败响应不得再带 status —— 否则前端 describeStatus 会把它兜底成'
                    '「等待扫码…」，这正是「扫了码没反应」的成因')
                self.assertIn(want, r['err'], label)

    def test_poll_transient_failure_keeps_existing_marker(self):
        """轮询中途抖一下，不能把已登录标记抹掉（不能因为一次 502 就假装退出登录）。"""
        sh._STATE[NAME].cookie = 'qishui-session'
        sh._STATE[NAME].uid = '77'
        sh._STATE[NAME].tmp = 'tok'
        sh._proxy_raw = _FakeVendor({'/login/qr/check': (502, {'error': '副进程未运行'})})
        r = sh._poll_qishui(NAME, {'key': 'tok'})
        self.assertFalse(r['ok'])
        self.assertEqual(sh._STATE[NAME].cookie, 'qishui-session')
        self.assertEqual(sh._STATE[NAME].uid, '77')

    # ---------- 快照：TTL 内不得重复打 vendor ----------
    def test_snapshot_cached_within_ttl(self):
        fake = _FakeVendor({'/status': (200, {'ok': True, 'authenticated': True, 'uid': '77'})})
        sh._proxy_raw = fake
        uid, logged = sh._qishui_login_snapshot(NAME)
        self.assertEqual((uid, logged), ('77', True))
        for _ in range(5):
            self.assertEqual(sh._qishui_login_snapshot(NAME), ('77', True))
        self.assertEqual(len(fake.calls), 1, 'TTL 内 5 次快照只允许 1 次 vendor 请求')

    def test_snapshot_ttl_expiry_refetches(self):
        fake = _FakeVendor({'/status': (200, {'ok': True, 'authenticated': True, 'uid': '77'})})
        sh._proxy_raw = fake
        sh._qishui_login_snapshot(NAME)
        sh._QISHUI_PR['at'] = 0.0            # 模拟 TTL 过期
        sh._qishui_login_snapshot(NAME)
        self.assertEqual(len(fake.calls), 2)

    # ---------- 快照：vendor 异常 → 保守判未登录（方向不可反）----------
    def test_snapshot_vendor_error_is_conservative(self):
        sh._proxy_raw = _FakeVendor(raises=RuntimeError('vendor 挂了'))
        uid, logged = sh._qishui_login_snapshot(NAME)   # 不得抛
        self.assertEqual((uid, logged), ('', False))
        # 异常结果同样进缓存：否则前端每次轮询都会重试一遍挂掉的 vendor
        self.assertGreater(sh._QISHUI_PR['at'], 0.0)

    def test_snapshot_garbage_payload_is_false(self):
        sh._proxy_raw = _FakeVendor({'/status': (200, 'not-a-dict')})
        self.assertEqual(sh._qishui_login_snapshot(NAME), ('', False))

    # ---------- 快照：vendor 有会话但 Python 侧标记被清 → 回填 ----------
    def test_snapshot_backfills_marker_when_vendor_has_session(self):
        self.assertEqual(sh._STATE[NAME].cookie, '')
        sh._proxy_raw = _FakeVendor(
            {'/status': (200, {'ok': True, 'authenticated': True, 'uid': '909'})})
        sh._qishui_login_snapshot(NAME)
        self.assertEqual(sh._STATE[NAME].cookie, 'qishui-session')
        self.assertEqual(sh._STATE[NAME].uid, '909')

    def test_snapshot_does_not_clear_existing_marker_when_not_logged_in(self):
        sh._STATE[NAME].cookie = 'qishui-session'
        sh._proxy_raw = _FakeVendor({'/status': (200, {'ok': True, 'authenticated': False})})
        sh._qishui_login_snapshot(NAME)
        # 快照只负责「已知有会话就回填」，不负责登出清理（登出走 logout()）
        self.assertEqual(sh._STATE[NAME].cookie, 'qishui-session')

    # ---------- 取二维码：成功形状与失败形状 ----------
    def test_get_qr_success_shape(self):
        sh._proxy_raw = _FakeVendor(
            {'/login/qr': (200, {'ok': True, 'token': 'tok-1', 'qrcode': 'data:image/png;base64,AAA'})})
        r = sh._get_qr_qishui(NAME)
        self.assertTrue(r['ok'])
        self.assertEqual(r['platform'], 'qishui')
        self.assertEqual(r['key'], 'tok-1')
        self.assertTrue(r['img'].startswith('data:image/png;base64,'))
        self.assertIn('扫码', r['hint'])
        self.assertEqual(sh._STATE[NAME].tmp, 'tok-1', 'token 应兜底存进 tmp')

    def test_get_qr_failure_shapes(self):
        cases = [
            ('vendor 明确报错', (200, {'ok': False, 'err': '上游限流'}), '上游限流'),
            ('缺 qrcode 字段', (200, {'ok': True, 'token': 't'}), None),
            ('HTTP 5xx', (502, {'ok': True, 'token': 't', 'qrcode': 'x'}), None),
        ]
        for label, reply, want_err in cases:
            with self.subTest(case=label):
                sh._proxy_raw = _FakeVendor({'/login/qr': reply})
                r = sh._get_qr_qishui(NAME)
                self.assertFalse(r['ok'], label)
                if want_err:
                    self.assertEqual(r['err'], want_err)
                else:
                    self.assertIn('取码失败', r['err'], label)


if __name__ == '__main__':
    unittest.main(verbosity=2)
