# -*- coding: utf-8 -*-
"""逐字对齐精度测量（拿真逐字当标准答案）

test_word_align.py 只证明了「链路通、结果偏离均分」。偏离 ≠ 对。
本脚本做真正的精度对拍，用仓库里那首有真词级时间的歌：

  local_music/JVKE - golden hour/
    lyrics.elrc   真逐字（词间隔 0/40/110/550ms 不等，均分摊不出这种，可当标准答案）
    song.flac     音频

流程：把 .elrc 降级成「只有行级时间戳」→ 跑 alignLine → 与真值逐词对拍，
并拿**均分**当对照组。输出平均/中位绝对误差、±100ms 命中率，以及相对均分的提升。

不进 CI：素材在 .gitignore 的 local_music/ 里，CI 上永远 SKIP。
运行：python tests/test_word_align_accuracy.py
"""
import io
import os
import re
import statistics
import sys
from urllib.parse import quote

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR = os.path.join(ROOT, "local_music", "JVKE - golden hour")
ELRC = os.path.join(DIR, "lyrics.elrc")
AUDIO_URL = "/local_music/" + quote("JVKE - golden hour/song.flac")

TAG = re.compile(r"<(\d{2,}):(\d{2})(?:\.(\d{1,3}))?>")


def tag_ms(m):
    return int(m.group(1)) * 60000 + int(m.group(2)) * 1000 + int((m.group(3) or "0").ljust(3, "0")[:3])


def parse_ground_truth(path):
    """→ [{start, end, words:[{text,start,end}]}]，只保留带词标记的行"""
    txt = io.open(path, encoding="utf-8").read()
    rows = []
    for line in txt.split("\n"):
        if not line.startswith("[") or "]<" not in line:
            continue
        head = re.match(r"\[(\d{2,}):(\d{2})(?:\.(\d{1,3}))?\]", line)
        if not head:
            continue
        start = tag_ms(head)
        tags = list(TAG.finditer(line))
        words = []
        for i, m in enumerate(tags):
            # 词文本 = 本标记之后、下一标记之前的内容
            seg = line[m.end(): tags[i + 1].start() if i + 1 < len(tags) else len(line)]
            words.append({"text": seg, "start": tag_ms(m),
                          "end": tag_ms(tags[i + 1]) if i + 1 < len(tags) else start + 3000})
        if words:
            rows.append({"start": start, "words": words})
    for i, r in enumerate(rows):
        r["end"] = rows[i + 1]["start"] if i + 1 < len(rows) else (r["start"] + 4000)
    return rows


def even_split(weights, start, end):
    """对照组：按权重均分（= 约束 17 的摊平行为）"""
    total = sum(weights) or 1
    dur = end - start
    out, acc = [], 0
    for w in weights:
        out.append(round(start + dur * (acc / total)))
        acc += w
    return out


def report(name, errs):
    if not errs:
        print(f"{name}: 无可比样本")
        return None
    n = len(errs)
    mae = statistics.mean(errs)
    med = statistics.median(errs)
    w100 = 100.0 * sum(1 for e in errs if e <= 100) / n
    w200 = 100.0 * sum(1 for e in errs if e <= 200) / n
    print(f"{name:22s} n={n:4d}  平均|误差|={mae:6.1f}ms  中位={med:6.1f}ms  "
          f"±100ms={w100:5.1f}%  ±200ms={w200:5.1f}%")
    return {"n": n, "mae": mae, "med": med, "w100": w100, "w200": w200}


if not os.path.exists(ELRC) or not os.path.exists(os.path.join(DIR, "song.flac")):
    print("SKIP: 缺 local_music/JVKE - golden hour/{lyrics.elrc,song.flac}（local_music 不入库）")
    sys.exit(0)

truth = parse_ground_truth(ELRC)
print(f"标准答案：{len(truth)} 行带真逐字\n")

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={"width": 1000, "height": 600})
    pg.goto("http://localhost:8001/index.html", wait_until="domcontentloaded", timeout=30000)
    pg.wait_for_timeout(2500)

    payload = [{"start": r["start"], "end": r["end"],
                "text": "".join(w["text"] for w in r["words"])} for r in truth]
    aligned = pg.evaluate("""async ({lines, url}) => {
        const wa = await import('/src/services/wordAlign.js');
        const al = await import('/src/core/wordAligner.js');
        const wt = await import('/src/parsers/wordTiming.js');
        const env = await wa.decodeOnsetEnvelope(url);
        if (!env) return { err: 'decode failed' };
        const out = lines.map(l => {
            const tokens = wt.tokenizeForKaraoke(l.text);
            const w = al.alignLine({ tokens, envelope: env, lineStartMs: l.start, lineEndMs: l.end });
            /* 对照组必须是**生产实际用的那个兜底**（synthesizeWords 按词长加权），
               不是等权均分——否则赢的可能只是「我也用了权重」而非「音频给了信息」。 */
            const prod = wt.synthesizeWords([{ start: l.start, end: l.end, text: l.text }],
                                            { totalMs: l.end });
            return { starts: (w || []).map(x => x.start), n: tokens.length,
                     prodStarts: ((prod[0] && prod[0].words) || []).map(x => x.start),
                     dev: al.maxDeviationFromEvenSplit(w, tokens, l.start, l.end) };
        });
        return { envFrames: env.values.length, hopMs: env.hopMs, out };
    }""", {"lines": payload, "url": AUDIO_URL})
    b.close()

if aligned.get("err"):
    print("解码失败：", aligned["err"])
    sys.exit(1)
print(f"包络：{aligned['envFrames']} 帧 @ {aligned['hopMs']}ms\n")

align_errs, prod_errs, skipped, improved = [], [], 0, 0
for r, a in zip(truth, aligned["out"]):
    gt = r["words"]
    if a["n"] != len(gt) or len(a["prodStarts"]) != len(gt):
        skipped += 1          # 分词粒度不同（如标点被并入），无法逐词对拍
        continue
    for i, w in enumerate(gt):
        align_errs.append(abs(a["starts"][i] - w["start"]))
        prod_errs.append(abs(a["prodStarts"][i] - w["start"]))
    tail = len(gt)
    if statistics.mean(align_errs[-tail:]) < statistics.mean(prod_errs[-tail:]):
        improved += 1

print("相对真值逐词起点误差：")
ra = report("频谱对齐", align_errs)
rp = report("生产兜底(加权均分)", prod_errs)

"""逐行看：总误差(MAE)会被少数崩掉的行拖平——中位数和命中率才是主分布。
   两个指标背离时，说明「音频确实给了信息」和「音频把整行带偏」同时存在，
   要修的是后者（异常行拒绝/更强的时长先验），不是前者。"""
per = []
for r, a in zip(truth, aligned["out"]):
    gt = r["words"]
    if a["n"] != len(gt) or len(a["prodStarts"]) != len(gt):
        continue
    ae = [abs(a["starts"][i] - gt[i]["start"]) for i in range(len(gt))]
    pe = [abs(a["prodStarts"][i] - gt[i]["start"]) for i in range(len(gt))]
    per.append((statistics.mean(ae), statistics.mean(pe), r, a))
per.sort(key=lambda x: -x[0])
print("\n最差的几行（平均误差 ms）:")
for am, pm, r, a in per[:5]:
    print(f"  行@{r['start']:6d}ms 字数={a['n']:2d} 时长={r['end'] - r['start']:5d}ms  "
          f"对齐={am:5.0f} 兜底={pm:5.0f}  {(''.join(w['text'] for w in r['words']))[:26].strip()!r}")
if per:
    print(f"\n行平均误差的中位数: 对齐 {statistics.median([p[0] for p in per]):.0f}ms"
          f"  兜底 {statistics.median([p[1] for p in per]):.0f}ms")
    print(f"对齐更好的行数: {sum(1 for p in per if p[0] < p[1])}/{len(per)}")

print(f"\n分词粒度不一致而跳过的行：{skipped}")
if ra and rp:
    print(f"\n整行层面：{improved}/{len(truth) - skipped} 行误差低于生产兜底")
    delta = (rp["mae"] - ra["mae"]) / rp["mae"] * 100
    print(f"平均误差 {ra['mae']:.0f}ms vs 生产兜底 {rp['mae']:.0f}ms  → 降低 {delta:.0f}%")
    print(f"±100ms 命中 {ra['w100']:.0f}% vs 生产兜底 {rp['w100']:.0f}%")
    usable = ra["w100"] >= 60 and ra["mae"] <= 200
    beats = ra["mae"] < rp["mae"] * 0.95   # 至少真降 5% 才算音频有贡献
    print("\n优于生产兜底(≥5%):", "是" if beats else "否")
    print("达到可用阈(±100ms≥60% 且 MAE≤200ms):", "是" if usable else "否")
    if usable:
        print("判定: 频谱对齐可用")
    elif not beats:
        print("判定: 与生产兜底无实质差异 —— 音频没有贡献信息，方案作废")
    else:
        print("判定: 略优于兜底但远未达标，不能冒充真实逐字")
    sys.exit(0 if usable else 1)
