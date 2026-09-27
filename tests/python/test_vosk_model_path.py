# -*- coding: utf-8 -*-
"""tests/python/test_vosk_model_path.py — Vosk 模型路径必须纯 ASCII

背景（实测过，不是猜的）：Vosk 的 C++/Kaldi 层在 Windows 上打不开含非 ASCII 的模型
路径——同一个模型放 ASCII 目录能加载，放 `D:\\旧电脑\\...\\models\\...` 下报
`does not contain model files`。生产代码目前把模型放在 `~/.cache/vosk/models/`
绕开了这一点，但** Windows 用户名本身含中文时那条路径也会变成非 ASCII **，
而失败方式是：vosk.Model() 抛错 → main() 没有 try → stdout 没有 JSON →
调用方 local_music_server 拿不到结果、静默退化到 ID3/文件名清洗。

覆盖：
  1. ASCII 路径原样返回（别多事）
  2. 非 ASCII 路径绝不能原样交出去：要么给一个 ASCII 可用路径，要么 None
  3. 空值 / None 不抛
  4. main() 在模型加载抛错时仍输出可解析的 JSON 错误（不吐 traceback）

运行：python -m unittest tests.python.test_vosk_model_path -v
"""
import io
import json
import os
import shutil
import sys
import tempfile
import unittest

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(PROJECT_DIR, "tools"))

import vosk_recognizer as vr  # noqa: E402


class TestResolveModelPath(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="voskpath_")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_ascii_path_returned_unchanged(self):
        """ASCII 路径不该被改写——正常机器上必须零影响"""
        p = os.path.join(self.tmp, "vosk-model-small-cn-0.22")
        os.makedirs(p)
        self.assertEqual(vr.prepare_model_dir(p)[0], p)

    def test_non_ascii_path_never_handed_over_verbatim(self):
        """核心断言：非 ASCII 路径要么换成 ASCII 可加载的形式，要么明确 None，
           绝不允许原样交给 vosk.Model()（那只会得到误导性的
           "does not contain model files"）。"""
        cn = os.path.join(self.tmp, "旧电脑模型", "vosk-model-small-cn-0.22")
        os.makedirs(cn)
        before = os.getcwd()
        got, restore = vr.prepare_model_dir(cn)
        try:
            if got is None:
                return                       # 明确不可用也算合法结果
            self.assertTrue(got.isascii(), "返回路径仍含非 ASCII: %r" % got)
            self.assertFalse(os.path.isabs(got), "应返回相对名，靠 cwd 定位: %r" % got)
            self.assertTrue(os.path.isdir(os.path.join(os.getcwd(), got)),
                            "切完 cwd 后该相对目录定位不到")
        finally:
            restore()
            self.assertEqual(os.getcwd(), before, "恢复函数必须把 cwd 还原")

    def test_falsy_inputs_do_not_raise(self):
        """契约是「不抛、且绝不返回非 ASCII 路径」；空值原样送回即可，
           是否有模型由调用方的 exists 检查负责。"""
        for bad in (None, "", 0):
            got, restore = vr.prepare_model_dir(bad)
            restore()
            self.assertFalse(got and not str(got).isascii(), "不该返回非 ASCII 路径: %r" % got)

    def test_non_ascii_but_missing_dir(self):
        """目录不存在时不要费劲去转换，直接原样返回让 os.path.exists 那层报真错"""
        p = os.path.join(self.tmp, "中文不存在的目录")
        got, restore = vr.prepare_model_dir(p)
        restore()
        self.assertEqual(got, p)


class TestMainReportsFailure(unittest.TestCase):
    def test_main_emits_json_when_model_load_raises(self):
        """回归的是「静默失效」本身：模型加载抛错时 stdout 必须是可解析 JSON"""
        audio = os.path.join(tempfile.gettempdir(), "vosk_probe_audio.mp3")
        io.open(audio, "wb").write(b"\x00" * 16)
        orig_model, orig_trans = vr.ensure_vosk_model, vr.transcribe_audio_snippet
        try:
            vr.ensure_vosk_model = lambda: os.path.join(tempfile.gettempdir(), "模型目录")

            def boom(*a, **k):
                raise Exception("Failed to create a model")
            vr.transcribe_audio_snippet = boom
            buf, out = io.StringIO(), sys.stdout
            sys.stdout = buf
            try:
                vr.main([audio])
            finally:
                sys.stdout = out
            line = [l for l in buf.getvalue().strip().split("\n") if l.strip()]
            self.assertTrue(line, "main() 什么都没输出 → 调用方会静默退化")
            res = json.loads(line[-1])
            self.assertFalse(res.get("success"))
            self.assertIn("error", res)
        finally:
            vr.ensure_vosk_model, vr.transcribe_audio_snippet = orig_model, orig_trans
            if os.path.exists(audio):
                os.remove(audio)


if __name__ == "__main__":
    unittest.main(verbosity=2)
