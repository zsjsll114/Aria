# -*- coding: utf-8 -*-
"""酷狗自建取链接 风控探针（/song/url 的 20028 / v_type）

用途：把「酷狗自建取不到链接」的排查一次性做完并打印证据链：
  1. 登录态是否真的有效（/user/detail 出不出昵称）；
  2. /song/url 到底是 20028 还是别的东西，ssa-code 是什么；
  3. 同一 ssa-code 的 /get/verify/info → v_type，并翻译成人话；
  4. 顺带复现「回传设备 cookie」与「刷新 token」两条已证伪的假设（默认跳过）。

用法：
    python scripts/probes/kugou-verify-probe.py                      # 走 8001 代理（默认）
    python scripts/probes/kugou-verify-probe.py --direct             # 直连 vendor 3100
    python scripts/probes/kugou-verify-probe.py --hash <hash> --quality flac
    python scripts/probes/kugou-verify-probe.py --retest-falsified   # 再验那两条已被否证的假设

注意：风控是**会话级**的，且 issue #206 提到**请求过频会触发「异常事件验证」**。
      别在循环里反复打这个脚本，否则可能把风控自己打出来。

      `--direct` 只用于**读响应头**（ssa-code、设备 cookie）。它的 /user/detail 会稳定
      返回 `20018`，那是注入方式差异（只带 Cookie 头 vs 应用把 token/userid 走 query），
      **不代表登录掉了** —— 登录态判定一律看默认的代理模式。

背景：https://github.com/MakcRe/KuGouMusicApi/issues/206
"""
import argparse
import io
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
COOKIE_FILE = os.path.join(ROOT, 'cache', 'selfhost_login.json')
TMP = os.environ.get('TEMP') or os.environ.get('TMPDIR') or '/tmp'

# v_type → 含义（来源：issue #206 首帖表格 + 评论区 实测）
V_TYPE = {
    16: '绑定 QQ（提交 openid/access_token 等）',
    18: '绑定微信（提交 openid/access_token 等）',
    22: '活体认证（verifycode=orderNo, verifykey=randid）',
    23: '腾讯滑块（verifycode=KGCodeTX|{ticket,randstr}）',
    32: '手机验证码（code=6 位数字）',
    34: '人脸核身',
    36: '需**绑定手机号**（#206 评论实测：绑定后即恢复）',
    38: '**要求登录确认身份**（kg-login，非验证码；不走 verify_user_info）',
    51: '**账号被风控，需申诉**（#206 评论实测）',
}


def curl(url, method='GET', cookie=None, data=None, timeout=25):
    """返回 (http_code, headers_text, body_text, set_cookie_list)。"""
    hp = os.path.join(TMP, '_kgprobe_h.txt')
    bp = os.path.join(TMP, '_kgprobe_b.txt')
    cmd = ['curl', '-s', '--max-time', str(timeout), '-D', hp, '-o', bp, '-X', method]
    if cookie:
        cmd += ['-H', 'Cookie: ' + cookie]
    if data is not None:
        cmd += ['-H', 'Content-Type: application/json', '-d', data]
    cmd += [url]
    subprocess.run(cmd, capture_output=True)
    hd = io.open(hp, encoding='utf-8', errors='replace').read()
    bd = io.open(bp, encoding='utf-8', errors='replace').read()
    code = ''
    for ln in hd.splitlines():
        if ln.startswith('HTTP/'):
            code = ln.split()[1]
    setc = [ln.split(':', 1)[1].strip() for ln in hd.splitlines()
            if ln.lower().startswith('set-cookie:')]
    return code, hd, bd, setc


def js(body):
    try:
        return json.loads(body)
    except Exception:
        return None


def header(hd, name):
    for ln in hd.splitlines():
        if ln.lower().startswith(name.lower() + ':'):
            return ln.split(':', 1)[1].strip()
    return ''


def device_cookies(setc):
    o = {}
    for c in setc:
        kv = c.split(';')[0]
        if '=' in kv:
            k, v = kv.split('=', 1)
            if k.startswith('KUGOU_API_'):
                o[k] = v
    return o


def login_cookie():
    try:
        kg = (json.load(io.open(COOKIE_FILE, encoding='utf-8')).get('kugou') or {})
        return (kg.get('cookie') or '').strip()
    except Exception:
        return ''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default=None, help='显式指定基址')
    ap.add_argument('--direct', action='store_true', help='直连 vendor 3100（默认走 8001 代理）')
    ap.add_argument('--hash', default='41239323b1a962f7cbe0d30a8ebed00b')
    ap.add_argument('--quality', default='128')
    ap.add_argument('--album-id', default='104639181')
    ap.add_argument('--album-audio-id', default='388376980')
    ap.add_argument('--retest-falsified', action='store_true',
                    help='复验「回传设备 cookie」「刷新 token」两条已被否证的假设')
    a = ap.parse_args()

    if a.base:
        base = a.base.rstrip('/')
    elif a.direct:
        base = 'http://127.0.0.1:3100'
    else:
        base = 'http://127.0.0.1:8001/api/selfhost/kugou/proxy'

    def u(path):
        """走 8001 代理时要塞进 ?path=；直连则直接拼。"""
        if 'proxy' in base:
            return f'{base}?path=' + path.replace('/', '%2F').replace('?', '%3F').replace('&', '%26')
        return base + path

    if 'proxy' in base:
        print('（经 8001 代理时无法读响应头，ssa-code / 设备 cookie 拿不到）')
        print('  要看响应头请加 --direct\n')

    ck = login_cookie()
    print(f'落盘登录态: {ck or "(空)"}')
    print('=' * 74)

    # 1) 登录态是否有效
    code, hd, bd, setc = curl(u('/user/detail'))
    j = js(bd)
    nick = (j.get('data') or {}).get('nickname') if isinstance(j, dict) else None
    print(f'[1] /user/detail   HTTP={code}  昵称={nick!r}')
    if not nick:
        if a.direct:
            print('    ⚠ 直连模式 + 只带 Cookie 头 会稳定返回 `20018` —— 这是**注入方式差异**，')
            print('      不代表登录掉了（同一时刻经应用代理能正常出昵称）。')
            print('      判定登录态请用默认的代理模式（不加 --direct）。')
        else:
            print('    ✗ 登录态无效或已过期 → 先在设置页重新扫码登录酷狗')
            print(f'    原始响应: {bd[:200]}')
            return 1
    else:
        print('    ✓ 登录态有效（token 没问题，"20028" 不是因为它）')

    # 2) /song/url 真实返回
    qu = f'/song/url?hash={a.hash}&quality={a.quality}&album_id={a.album_id}&album_audio_id={a.album_audio_id}'
    code, hd, bd, setc = curl(u(qu))
    j = js(bd) or {}
    ssa = header(hd, 'ssa-code')
    dev = device_cookies(setc)
    print(f'\n[2] {qu}')
    print(f'    HTTP={code} errcode={j.get("errcode")} status={j.get("status")} '
          f'error={j.get("error")!r} url={"★有直链" if j.get("url") else "无"}')
    if ssa:
        print(f'    ssa-code={ssa}')
    if dev:
        print('    新建设备 cookie: ' + ', '.join(f'{k}={v[:18]}…' for k, v in dev.items()))
    if not ssa and not j.get('errcode'):
        print(f'    完整响应体: {bd[:400]}')

    # 3) v_type
    if ssa:
        code2, hd2, bd2, _ = curl(u(f'/get/verify/info?eventid={ssa}'))
        j2 = js(bd2) or {}
        d2 = j2.get('data') or {}
        vt = d2.get('v_type')
        print(f'\n[3] /get/verify/info?eventid={ssa}')
        print(f'    v_type={vt}  business={d2.get("business")}  '
              f'v_type_list={d2.get("v_type_list")}')
        print(f'    partnerid_map={d2.get("partnerid_map")}   '
              f'（注意：只用于第三方绑定，与 v_type 判断无关）')
        if vt in V_TYPE:
            print(f'    → 含义：{V_TYPE[vt]}')
        else:
            print('    → 未知 v_type（可去 issue #206 反馈）')

    # 4) 复验已被否证的假设
    if a.retest_falsified:
        print('\n[4] 复验两条已证伪的假设（预期都仍是 20028）')
        if dev:
            echo = '; '.join(f'{k}={v}' for k, v in dev.items())
            if ck:
                echo += ('; ' if echo else '') + ck
            code3, hd3, bd3, _ = curl(u(qu), cookie=echo)
            j3 = js(bd3) or {}
            print(f'    回传设备 cookie → errcode={j3.get("errcode")} '
                  f'（若仍 20028，说明不是设备指纹问题）')
            code4, hd4, bd4, _ = curl(u('/login/token?timestrap=%d' % int(time.time() * 1000)),
                                      method='POST', cookie=echo, data='{}')
            j4 = js(bd4) or {}
            nt = (j4.get('data') or {}).get('token') if isinstance(j4, dict) else None
            print(f'    /login/token → status={j4.get("status")} '
                  f'token 是否更新={"是" if nt and nt not in (ck or "") else "否（原样返回）"}')
        else:
            print('    （需要 --direct 才能读设备 cookie，跳过）')

    print('\n' + '=' * 74)
    print('判读要点：')
    print('  · 若免费曲也被拦 → 与 VIP 无关；')
    print('  · 若多首歌 ssa-code 相同 → 风控是会话级，不是单曲；')
    print('  · v_type=38 → 服务端要求登录确认身份，**不是**验证码，做验证码 UI 是错方向；')
    print('  · 36=需绑定手机号、51=账号风控需申诉，这两类有明确动作可做。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
