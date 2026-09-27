"""
tests/python/test_vendor_loopback_guard.py — vendor 回环收口 + 暴露探针的端到端回归

为什么必须有：AGENTS.md 约束 3 把「三个 vendor 仍绑 0.0.0.0」记成未完成项很多天了。
补了守卫之后，如果只测「守卫文件存在」或「守卫自报加载」，那都证明不了绑定结果 ——
而这类安全修复最危险的失效方式恰恰是**静默不生效**（补丁行号漂移、NODE_OPTIONS 被
子进程吞掉、vendor 用了我们没覆盖的 listen 形态）。

所以这里测两件事，都是黑盒：
  ① 不加守卫起一个 listen(port) → 探针必须报 exposed（证明探针有鉴别力，不是恒 False）
  ② 加守卫起同样的代码        → 探针必须报 not exposed（证明守卫真的改了绑定）
两个方向都过，才说明「not exposed」这个结果有意义。

没有局域网地址的机器（纯回环/离线）会 SKIP，不报红。
"""
import json
import os
import socket
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

GUARD = os.path.join(ROOT, 'scripts', 'vendor-loopback-guard.cjs')

# 起一个只传端口的 server，把实际绑定地址和端口打到 stdout
SNIPPET = (
    "const h=require('node:http');"
    "const s=h.createServer((_,r)=>r.end('ok'));"
    "s.listen(0,()=>{console.log(JSON.stringify({port:s.address().port,"
    "address:s.address().address}));});"
)


def _local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(('8.8.8.8', 80))
            return s.getsockname()[0]
        finally:
            s.close()
    except Exception:
        return ''


def _stop(proc):
    """关管道再杀进程，否则 unittest 会报 ResourceWarning: subprocess still running。"""
    for pipe in (proc.stdout, proc.stderr):
        try:
            if pipe:
                pipe.close()
        except Exception:
            pass
    try:
        proc.kill()
        proc.wait(timeout=5)
    except Exception:
        pass


def _spawn(with_guard):
    """启动一个 vendor 形态的 server，返回 (port, address)。"""
    args = ['node']
    if with_guard:
        args += ['--require', GUARD]
    args += ['-e', SNIPPET]
    proc = subprocess.Popen(args, cwd=ROOT, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True)
    try:
        line = proc.stdout.readline()
        info = json.loads(line.strip())
        return proc, info['port'], info['address']
    except Exception as e:
        _stop(proc)
        raise AssertionError(f'node 子进程没有按预期输出: {e}')


def _connect_to(ip, port, timeout=0.6):
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return True
    except Exception:
        return False


IP = _local_ip()
HAS_LAN = bool(IP) and not IP.startswith('127.')


@unittest.skipUnless(HAS_LAN, '本机没有非回环 IPv4，无法区分绑定面')
@unittest.skipUnless(os.path.isfile(GUARD), '缺少 scripts/vendor-loopback-guard.cjs')
class TestVendorLoopbackGuard(unittest.TestCase):

    def test_baseline_without_guard_is_exposed(self):
        """探针必须能抓到真实的暴露，否则它恒 False、后面所有结论都没意义。"""
        proc, port, addr = _spawn(with_guard=False)
        try:
            self.assertTrue(_connect_to(IP, port),
                            f'基线失败：不加载守卫时 {addr}:{port} 应可从 {IP} 连上')
        finally:
            _stop(proc)

    def test_guard_moves_default_listen_to_loopback(self):
        """同样的代码加了守卫之后，局域网地址必须连不上。"""
        proc, port, addr = _spawn(with_guard=True)
        try:
            self.assertEqual(addr, '127.0.0.1', f'守卫未改写绑定地址：{addr}')
            self.assertFalse(_connect_to(IP, port),
                             f'守卫失效：{port} 仍可从局域网地址 {IP} 连上')
        finally:
            _stop(proc)

    def test_probe_function_agrees(self):
        """直接跑 selfhost_service 里的那个探针函数，避免测试自己复刻一套判定逻辑。"""
        import selfhost_service as sh
        proc, port, addr = _spawn(with_guard=True)
        try:
            orig_port = sh._SERVICES['qq']['port']
            sh._SERVICES['qq']['port'] = port
            sh._EXPOSE_CACHE.clear()
            self.assertFalse(sh.probe_vendor_exposed('qq'), '探针在有守卫时应报未暴露')
            proc2, port2, _ = _spawn(with_guard=False)
            try:
                sh._SERVICES['qq']['port'] = port2
                sh._EXPOSE_CACHE.clear()
                self.assertTrue(sh.probe_vendor_exposed('qq'), '探针在无守卫时必须报暴露')
            finally:
                _stop(proc2)
        finally:
            sh._SERVICES['qq']['port'] = orig_port
            sh._EXPOSE_CACHE.clear()
            _stop(proc)


if __name__ == '__main__':
    unittest.main(verbosity=2)
