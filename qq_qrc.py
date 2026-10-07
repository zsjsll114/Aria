# -*- coding: utf-8 -*-
"""QQ 音乐 QRC 逐字歌词解密（纯 Python，零第三方依赖）。

背景
----
QQ 音乐的逐字歌词（QRC）、翻译、罗马音都藏在
    https://c.y.qq.com/qqmusic/fcgi-bin/lyric_download.fcg?lrctype=4&musicid=<songid>
返回体里（三个 CDATA：content=QRC / contentts=翻译 / contentroma=罗马音）。
内容是**十六进制字符串**，解密流程：

    十六进制串 → bytes → 3DES 解密 → zlib 解压 → UTF-8 明文 XML

★ 关键坑（2026-10-03 踩过，务必别再走回头路）
  1. **这不是标准 DES**。QQ 用的是私改变体，三处与标准不同：
       · 每个 8 字节分组进入 IP 前，两个 32 位字**各自内部字节反序**
         （`block[3::-1] + block[7:3:-1]`）；
       · 密钥调度里 4 字节字按**小端**解释，且 PC2 的 D 半部索引偏移是
         `index-27`（标准是 `index-28`）；
       · **两个 S 盒值被改过**（S3、S4 各一处）。
     结论：用 pycryptodome / cryptography / 任何标准 3DES 实现，哪怕密钥完全
     相同也永远解不开，症状是 zlib 解压校验失败 —— 极易误判成「密钥不对」。
  2. 网上流传的 CSDN 文章给的密钥 `b"qq_encrypt_key_decode"` 是**假的**
     （付费资源的诱饵，文章自己也声明"可能与实际略有差异"）。
     真密钥是 24 字节的 `!@#)(*$%123ZXC!@!@#)(NHL`，但只有配合上面的变体才有效。

移植来源
--------
算法移植自 WXRIW/QQMusicDecoder（MIT）→ Sep26JI/touchbar-lyrics 的
`Resources/qrc_decoder.py`（MIT）。此处保留其算法，改成本项目所用的
「异常式」接口（失败抛异常，由调用方降级到普通 LRC），并补上 XML 解析层。
"""

import re
import zlib

#: QQ 音乐 web 端内置固定 24 字节密钥（与账号无关）
QQ_QRC_KEY = b'!@#)(*$%123ZXC!@!@#)(NHL'

_IP = (57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
       61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
       56, 48, 40, 32, 24, 16, 8, 0, 58, 50, 42, 34, 26, 18, 10, 2,
       60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6)
_FP = tuple(_IP.index(i) for i in range(64))
_E = (31, 0, 1, 2, 3, 4, 3, 4, 5, 6, 7, 8, 7, 8, 9, 10, 11, 12,
      11, 12, 13, 14, 15, 16, 15, 16, 17, 18, 19, 20, 19, 20, 21, 22, 23, 24,
      23, 24, 25, 26, 27, 28, 27, 28, 29, 30, 31, 0)
_P = (15, 6, 19, 20, 28, 11, 27, 16, 0, 14, 22, 25, 4, 17, 30, 9,
      1, 7, 23, 13, 31, 26, 2, 8, 18, 12, 29, 5, 21, 10, 3, 24)
_PC1 = (56, 48, 40, 32, 24, 16, 8, 0, 57, 49, 41, 33, 25, 17, 9, 1,
        58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35,
        62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21,
        13, 5, 60, 52, 44, 36, 28, 20, 12, 4, 27, 19, 11, 3)
_PC2 = (13, 16, 10, 23, 0, 4, 2, 27, 14, 5, 20, 9, 22, 18, 11, 3, 25, 7, 15, 6, 26, 19, 12, 1,
        40, 51, 30, 36, 46, 54, 29, 39, 50, 44, 32, 47, 43, 48, 38, 55, 33, 52, 45, 41, 49, 35, 28, 31)
_SHIFTS = (1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1)

# ★ S3 / S4 与标准 DES 不同（QQ 改过），照抄勿「修正」
_SBOX = (
    (14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
     4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13),
    (15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 15, 12, 0, 1, 10, 6, 9, 11, 5,
     0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9),
    (10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
     13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12),
    (7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
     10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 10, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14),
    (2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
     4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3),
    (12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
     9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13),
    (4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
     1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12),
    (13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
     7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11),
)


def _permute(value, positions, bits):
    result = 0
    for position in positions:
        result = (result << 1) | ((value >> (bits - 1 - position)) & 1)
    return result


def _byte_tables(positions, bits):
    return tuple(tuple(_permute(v << (bits - 8 - 8 * i), positions, bits)
                       for v in range(256)) for i in range(bits // 8))


_IP_TABLE = _byte_tables(_IP, 64)
_FP_TABLE = _byte_tables(_FP, 64)
_E_TABLE = _byte_tables(_E, 32)
_SP = tuple(tuple(_permute(box[(v & 32) | ((v & 31) >> 1) | ((v & 1) << 4)]
                           << (28 - 4 * i), _P, 32) for v in range(64))
            for i, box in enumerate(_SBOX))


def _scheduled_keys(key):
    # QQ 的 BITNUM 把每个 4 字节字当小端读（标准实现是大端）
    value = (int.from_bytes(key[:4], 'little') << 32) | int.from_bytes(key[4:], 'little')
    c_and_d = _permute(value, _PC1, 64)
    c, d = c_and_d >> 28, c_and_d & 0xfffffff
    keys = []
    for shift in _SHIFTS:
        c = ((c << shift) | (c >> (28 - shift))) & 0xfffffff
        d = ((d << shift) | (d >> (28 - shift))) & 0xfffffff
        # ★ D 半部索引偏移是 27 而非标准的 28 —— 照抄勿改
        round_key = 0
        for index in _PC2[:24]:
            round_key = (round_key << 1) | ((c >> (27 - index)) & 1)
        for index in _PC2[24:]:
            round_key = (round_key << 1) | (((d << 4) >> (31 - (index - 27))) & 1)
        keys.append(round_key)
    return keys


def _crypt(block, keys):
    # ★ 32 位字内部字节反序，这是 QQ 变体最显著的一处
    data = block[3::-1] + block[7:3:-1]
    value = 0
    for i, byte in enumerate(data):
        value |= _IP_TABLE[i][byte]
    left, right = value >> 32, value & 0xffffffff
    for round_key in keys:
        expanded = (_E_TABLE[0][right >> 24] | _E_TABLE[1][(right >> 16) & 255]
                    | _E_TABLE[2][(right >> 8) & 255] | _E_TABLE[3][right & 255]) ^ round_key
        f = (_SP[0][(expanded >> 42) & 63] | _SP[1][(expanded >> 36) & 63]
             | _SP[2][(expanded >> 30) & 63] | _SP[3][(expanded >> 24) & 63]
             | _SP[4][(expanded >> 18) & 63] | _SP[5][(expanded >> 12) & 63]
             | _SP[6][(expanded >> 6) & 63] | _SP[7][expanded & 63])
        left, right = right, left ^ f
    swapped = ((right << 32) | left).to_bytes(8, 'big')
    value = 0
    for i, byte in enumerate(swapped):
        value |= _FP_TABLE[i][byte]
    return (value >> 32).to_bytes(4, 'little') + (value & 0xffffffff).to_bytes(4, 'little')


#: 解密顺序 = D(K3) → E(K2) → D(K1)（与 pyDes 的 triple_des 同款 EDE）
_KEYS = (tuple(reversed(_scheduled_keys(QQ_QRC_KEY[16:]))),
         tuple(_scheduled_keys(QQ_QRC_KEY[8:16])),
         tuple(reversed(_scheduled_keys(QQ_QRC_KEY[:8]))))


# ---------------------------------------------------------------- QRC 业务层

_HEX_ONLY = re.compile(r'[0-9a-fA-F]')

#: 单条歌词密文 / 明文的尺寸上限（正常 QRC 密文 < 100KB，用于挡住异常输入）
MAX_CIPHER_HEX = 2_000_000
MAX_PLAIN = 2_000_000


def triple_des_decrypt(data, keys=_KEYS):
    """QQ 变体 3DES 解密，`data` 长度必须是 8 的倍数。"""
    out = bytearray()
    for i in range(0, len(data), 8):
        block = data[i:i + 8]
        for round_keys in keys:
            block = _crypt(block, round_keys)
        out.extend(block)
    return bytes(out)


def decrypt_qrc(hex_text):
    """十六进制密文 → 明文 XML 字符串。失败抛 ValueError，由调用方降级。"""
    if not isinstance(hex_text, str):
        raise ValueError('密文不是字符串')
    cleaned = ''.join(_HEX_ONLY.findall(hex_text))
    if not cleaned:
        raise ValueError('空密文')
    if len(cleaned) > MAX_CIPHER_HEX:
        raise ValueError('密文过大')
    if len(cleaned) % 2:
        cleaned = cleaned[:-1]
    raw = bytes.fromhex(cleaned)
    if not raw or len(raw) % 8:
        raise ValueError('密文长度不是 8 的倍数')
    plain = triple_des_decrypt(raw)
    try:
        unzip = zlib.decompress(plain)
    except zlib.error as e:
        raise ValueError('zlib 解压失败: %s' % e)
    if len(unzip) > MAX_PLAIN:
        raise ValueError('明文过大')
    return unzip.decode('utf-8')


def _cdata_blocks(body):
    """从 lyric_download.fcg 响应里取出 {标签: 内容}。

    响应整体被包在 `<!--<command-lable-...>` 注释里，结构与语义（2026-10-03 实测）：
        <content type="file" …>     <![CDATA[QRC 逐字原文]]>   ← 密文
        <contentts type="file" …>   <![CDATA[翻译]]>           ← **明文 LRC**（日文歌可能是假名注音版）
        <contentroma type="file" …> <![CDATA[罗马音]]>         ← 密文
    中文歌的 ts / roma 通常是空 CDATA。
    """
    out = {}
    for m in re.finditer(r'<(\w+)\s*[^>]*?>\s*<!\[CDATA\[([\s\S]*?)\]\]>', body):
        tag, content = m.group(1), m.group(2).strip()
        if tag in ('content', 'contentts', 'contentroma') and content:
            out[tag] = content
    return out


def extract_lyric_text(text):
    """解密后的 XML → LyricContent 文本；传入的本来就是纯歌词时原样返回。"""
    m = re.search(r'<Lyric_1[^>]*?LyricContent="([\s\S]*?)"\s*/>', text)
    if not m:
        return text
    return (m.group(1)
            .replace('&quot;', '"').replace('&apos;', "'")
            .replace('&lt;', '<').replace('&gt;', '>')
            .replace('&amp;', '&'))


#: 纯十六进制（含空白）判定 —— 用来区分「密文块」和「本来就是明文的块」
_HEX_FULL = re.compile(r'^[0-9a-fA-F\s]+$')


def parse_qrc_xml(text):
    """单块内容 → 歌词文本。

    · 纯十六进制 → 必然是密文，解密失败就抛（由调用方丢弃该块）
    · 其它       → `<contentts>` 这类本来就是明文的块，直接透传
    ★ 不能一律先试解密再回退：明文 LRC 里也混着大量十六进制字符，
      拿它去 unhexlify 会「碰巧」成功再 zlib 失败，从而把翻译整块丢掉。
    """
    if _HEX_FULL.match(text):
        return extract_lyric_text(decrypt_qrc(text))
    return extract_lyric_text(text)


def parse_response(body):
    """lyric_download.fcg 原始响应 → {qrc, trans, roma}。

    · qrc  ：逐字歌词（一定会尝试解密）
    · trans：翻译（明文 LRC，直接透传）
    · roma ：罗马音（密文，解密）
    任何一块解不开都只是该块为空，不影响其它块 —— 调用方据此降级。
    """
    blocks = _cdata_blocks(body)
    result = {'qrc': '', 'trans': '', 'roma': ''}
    for tag, dest in (('content', 'qrc'), ('contentts', 'trans'), ('contentroma', 'roma')):
        raw = blocks.get(tag)
        if not raw:
            continue
        try:
            result[dest] = parse_qrc_xml(raw)
        except ValueError:
            continue
    return result


def decode(hex_text):
    """一步到位：单块十六进制密文 → 歌词文本。"""
    return parse_qrc_xml(hex_text)
