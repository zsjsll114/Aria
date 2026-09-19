# -*- coding: utf-8 -*-
"""folia 对齐分句/分组器 + PV 集成 自动测试"""
import re
import sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8001/index.html"
results = []

def check(name, cond, extra=""):
    results.append((name, bool(cond), extra))
    print(("PASS" if cond else "FAIL"), name, extra)

def mk(size, start_ms, gap_ms, dur_ms=2500, tag=None):
    """按均齐间隙生成一条歌词行"""
    return {
        "start": start_ms, "end": start_ms + dur_ms,
        "original": ("(Chorus) " if tag == "chorus" else "(间奏) " if tag == "break" else "") + f"line{size}-{size}字歌词内容{size}",
    }

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 720})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
    try:
        page.wait_for_function(
            "() => { const v = document.documentElement.style.getPropertyValue('--theme-color'); return !!v && v.trim() !== ''; }",
            timeout=25000)
    except Exception as e:
        check("app-boot-marker", False, str(e)[:100])
    page.wait_for_timeout(1200)

    r = page.evaluate("""async () => {
      const out = {};
      const gp = await import('./src/core/lyricSceneGrouper.js');
      const pv = await import('./src/core/pvEngine/PVLyricLayout.js');

      // ========== 1. 间隙阈值自适配 ==========
      const linesA = [];
      for (let i = 0; i < 6; i++) linesA.push(mkLine(i, i * 3500, 2500)); // 均匀 1s 间隙
      out.thresholdEven = gp.resolveGapThreshold(linesA); // median 1s * 2.5 -> 2.5
      const linesB = [];
      for (let i = 0; i < 6; i++) linesB.push(mkLine(i, i * 60000, 2500)); // 超大间隙 57.5s
      out.thresholdClamped = gp.resolveGapThreshold(linesB); // 应钳到上限 3.5

      // ========== 2. 大间隙分景 ==========
      const gapLines = [];
      for (let i = 0; i < 4; i++) gapLines.push(mkLine(i, i * 2000, 1000));
      gapLines.push(mkLine(4, 4 * 2000 + 9000, 1000)); // 前面 1s 间隙，这里插 9s 大间隙
      for (let i = 5; i < 8; i++) gapLines.push(mkLine(i, i * 2000 + 9000, 1000));
      const gapScenes = gp.buildSceneGroups(gapLines, { maxLines: 4, maxSpanSec: 6.5 });
      out.gapSceneCount = gapScenes.length; // 大间隙应切开 -> 2

      // ========== 3. 段落标记变化分景 ==========
      const tagLines = [
        { ...mkLine(0, 0, 1500), original: '(Verse) 主歌第一句' },
        { ...mkLine(1, 2000, 1500), original: '(Verse) 主歌第二句' },
        { ...mkLine(2, 4000, 1500), original: '(Chorus) 副歌第一句' },
        { ...mkLine(3, 6000, 1500), original: '(Chorus) 副歌第二句' },
      ];
      const tagScenes = gp.buildSceneGroups(tagLines, { maxLines: 4, maxSpanSec: 6.5 });
      out.tagSceneCount = tagScenes.length; // Verse->Chorus 标记变化 -> 2

      // ========== 4. 组上限行数 ==========
      const manyLines = [];
      for (let i = 0; i < 8; i++) manyLines.push(mkLine(i, i * 1500, 1200)); // 全部紧连
      const capScenes = gp.buildSceneGroups(manyLines, { maxLines: 2, maxSpanSec: 6.5 });
      out.capMaxLineLen = Math.max(...capScenes.map(s => s.lines.length)); // 应 <= 2
      out.capCount = capScenes.length; // 8 行每景2行 -> 4

      // ========== 5. 组内时长上限（跨度>6.5s 拆开） ==========
      const longLines = [];
      for (let i = 0; i < 4; i++) longLines.push(mkLine(i, i * 3000, 2500)); // 跨度 11.5s
      const spanScenes = gp.buildSceneGroups(longLines, { maxLines: 5, maxSpanSec: 6.5 });
      out.spanCount = spanScenes.length; // 4行跨度11.5s > 6.5 -> 至少 2

      // ========== 6. 超大段落拆分（>6行 或 >18s） ==========
      const bigLines = [];
      for (let i = 0; i < 10; i++) bigLines.push(mkLine(i, i * 2000, 1000)); // 10 行
      const bigScenes = gp.buildSceneGroups(bigLines, { maxLines: 6, maxSpanSec: 20 });
      out.bigCount = bigScenes.length; // 10行>6 -> 拆成多段
      out.bigMaxLen = Math.max(...bigScenes.map(s => s.lines.length));

      // ========== 7. 段落类型 kind ==========
      const chorusKinds = [];
      const cLines = [
        { ...mkLine(0, 0, 1500), original: '(Chorus) 你说爱我却要走' },
        { ...mkLine(1, 2000, 1500), original: '(Chorus) 留下我独自守候' },
      ];
      const cScenes = gp.buildSceneGroups(cLines, { maxLines: 4, maxSpanSec: 6.5 });
      chorusKinds.push(cScenes[0] ? cScenes[0].kind : '');
      const shortOne = gp.buildSceneGroups([
        mkLine(0, 0, 1500),
        { ...mkLine(1, 9000, 900), original: '哎' },   // 中段：短 breath（前后大间隙各自成段）
        mkLine(2, 18000, 1800),
      ], { maxLines: 4, maxSpanSec: 6.5 });
      chorusKinds.push(shortOne[1] ? shortOne[1].kind : ''); // breath
      out.chorusKinds = chorusKinds;

      // ========== 8. PV 集成：kind 落到 node + 场景数合理 ==========
      const layout = new pv.PVLyricLayout();
      const nodes = layout.process(gapLines, { emotion_words: [] }, 5);
      out.pvNodeKinds = nodes.map(n => n.kind || '');
      out.pvNodeCount = nodes.length;
      out.pvHasKind = nodes.length > 0 && nodes.every(n => !!n.kind);

      function mkLine(i, start, dur) {
        return { start: start, end: start + dur, original: i % 2 ? '夜风轻轻吹过我身边' : '远方传来你的歌声' };
      }
      return out;
    }""")

    linesA_th = r["thresholdEven"]
    check("threshold-adaptive", 1.24 <= linesA_th <= 2.6, str(linesA_th))
    check("threshold-clamped-max", abs(r["thresholdClamped"] - 3.5) < 1e-6, str(r["thresholdClamped"]))
    check("big-gap-splits", r["gapSceneCount"] >= 2, str(r["gapSceneCount"]))
    check("tag-change-splits", r["tagSceneCount"] >= 2, str(r["tagSceneCount"]))
    check("max-lines-cap", r["capMaxLineLen"] <= 2, f"maxLen={r['capMaxLineLen']}")
    check("max-lines-count", r["capCount"] >= 4, str(r["capCount"]))
    check("span-cap-splits", r["spanCount"] >= 2, str(r["spanCount"]))
    check("oversized-splits", r["bigCount"] >= 2 and r["bigMaxLen"] <= 6, f"count={r['bigCount']} maxLen={r['bigMaxLen']}")
    check("kind-chorus", "chorus" in r["chorusKinds"], str(r["chorusKinds"]))
    check("kind-breath", "breath" in r["chorusKinds"], str(r["chorusKinds"]))
    check("pv-kind-wired", r["pvHasKind"], str(r["pvNodeKinds"]))
    check("pv-scene-count-reasonable", 2 <= r["pvNodeCount"] <= 8, str(r["pvNodeCount"]))

    fatal = [e for e in errors if not any(k in e for k in ("favicon", "net::", "404", "CORS", "Access to image", "Failed to load resource",
                                                           "加载歌曲出错", "音频错误", "DEMUXER", "audio_load_error"))]
    check("no-fatal-page-errors", len(fatal) == 0, "; ".join(fatal[:4]))
    browser.close()

fails = [n for n, ok, _ in results if not ok]
print()
print("=" * 46)
print("TOTAL:", len(results), " PASS:", len(results) - len(fails), " FAIL:", len(fails))
sys.exit(1 if fails else 0)