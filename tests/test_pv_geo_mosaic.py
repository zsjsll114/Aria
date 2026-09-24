# -*- coding: utf-8 -*-
"""PV 图形场（folia shapeField 对齐） + 蒙德里安方格必现 + 色板轮换 自动测试"""
import re
import sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8001/index.html"
results = []

def check(name, cond, extra=""):
    results.append((name, bool(cond), extra))
    print(("PASS" if cond else "FAIL"), name, extra)

# 先做静态花括号校验
for fn in ("web/src/styles/pv.css", "web/src/styles/pv-tunnel.css"):
    src = open(fn, encoding="utf-8", errors="replace").read()
    buf = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    buf = re.sub(r'"(?:[^"\\]|\\.)*"', '""', buf)
    buf = re.sub(r"'(?:[^'\\]|\\.)*'", "''", buf)
    check(f"css-braces-{fn.split('/')[-1]}", buf.count("{") == buf.count("}"),
          f"open={buf.count('{')} close={buf.count('}')}")
# ★ 图形场动画体系存在于 pv.css（folia shapeField 对齐）
pv_css = open("web/src/styles/pv.css", encoding="utf-8", errors="replace").read()
check("css-shape-orbit-keyframes", "pv-shape-orbit" in pv_css)
check("css-shape-breathe-keyframes", "pv-shape-breathe" in pv_css)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 720}, reduced_motion="no-preference")
    # ★ CI 稳定（2026-09-19 首次 CI 实证）：预置「手动高性能档」短路启动期异步性能自检，
    # 防止 2 核 CI 上自检晚于测试把 perf-minimal 加回 body，触发 pv.css 的 animation:none !important。
    page.add_init_script(
        "try { localStorage.setItem('lyrics_player_performance', JSON.stringify({ profile: 'high', manuallyConfigured: true })); } catch (e) {}"
    )
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
    try:
        page.wait_for_function(
            "() => { const v = document.documentElement.style.getPropertyValue('--theme-color'); return !!v && v.trim() !== ''; }",
            timeout=25000)
    except Exception as e:
        check("app-boot-marker", False, str(e)[:100])
    page.wait_for_timeout(1500)

    ev = page.evaluate("""async () => {
      const out = {};
      // 无头环境 WebGL 缺失会降级 body.perf-minimal 禁动画，摘掉 perf-* 档
      document.body.className = document.body.className.split(' ').filter(c => !c.startsWith('perf-')).join(' ');

      // ========== 1. PVDecorations folia 图形场 ==========
      const decoMod = await import('./src/core/pvEngine/PVDecorations.js');
      const PVDecorations = decoMod.PVDecorations;
      const layer = document.createElement('div');
      layer.id = 'geo-test-layer';
      document.body.appendChild(layer);
      const deco = new PVDecorations(layer);
      const mkNode = (index, n) => ({
        index, lines: new Array(n).fill({}), pos: { x: 0, y: 0 },
        backgroundWords: ['PV']
      });
      deco.renderForNode(mkNode(0, 2), '#ffcc33', 'seedA');
      const field = layer.querySelector('.pv-shape-field');
      out.fieldCreated = !!field;
      out.shapeCount = field ? field.querySelectorAll('.pv-shape').length : 0;
      out.iconCount = field ? field.querySelectorAll('.pv-shape--icon').length : 0;
      out.geoCount = field ? field.querySelectorAll('.pv-shape--circle, .pv-shape--square, .pv-shape--triangle, .pv-shape--cross').length : 0;
      out.particleCount = field ? field.querySelectorAll('.pv-shape-particle').length : 0;
      out.colorFollows = field ? field.style.color === 'rgb(255, 204, 51)' : false;
      // 同 seed + 同色：不重建（歌曲级持久）
      const html0 = field.innerHTML;
      deco.renderForNode(mkNode(1, 2), '#ffcc33', 'seedA');
      const field2 = layer.querySelector('.pv-shape-field');
      out.sameSeedStable = field2.innerHTML === html0;
      // 换 seed：重新洗牌
      deco.renderForNode(mkNode(1, 2), '#ffcc33', 'seedB');
      const field3 = layer.querySelector('.pv-shape-field');
      out.newSeedReshuffles = field3.innerHTML !== html0;
      // 动画体系挂在块上（CSS 动画名来自 pv.css）
      const firstShape = field3.querySelector('.pv-shape');
      out.orbitAnim = firstShape ? getComputedStyle(firstShape).animationName : '';

      // ========== 2. TunnelEngine 蒙德里安方格必现 + 色板轮换 ==========
      const tunMod = await import('./src/core/tunnelEngine/TunnelEngine.js');
      const TunnelEngine = tunMod.TunnelEngine;
      const tcont = document.createElement('div');
      tcont.id = 'tunnel-test-container';
      tcont.style.cssText = 'position:absolute;left:0;top:0;width:800px;height:600px;';
      document.body.appendChild(tcont);
      const tun = new TunnelEngine(tcont);
      const built = tun.init(tcont);
      out.engineBuilt = !!built && !!tun.mosaicLayer;
      // 逐 pattern 校验：任一 pattern 渲染后必现栅格方块
      let gridAlways = true, allPatterns = 0, maxGrids = 0;
      for (let s = 0; s < 32; s++) {
        tun._lastBgCacheKey = null;              // 强制重渲染
        tun._updateMosaicBackground({ sectionId: s, groupId: 0, params: { alignment: 'center' } });
        const grids = tun.mosaicLayer.querySelectorAll('.t-m-block.is-grid-block');
        const withBg = tun.mosaicLayer.querySelectorAll('.t-m-block.is-grid-block .t-m-grid-inner');
        allPatterns++;
        maxGrids = Math.max(maxGrids, grids.length);
        const hasGridImg = [...withBg].some(el => (el.style.backgroundImage || '').includes('repeating-linear-gradient'));
        if (grids.length === 0 || !hasGridImg) gridAlways = false;
      }
      out.gridAlways = gridAlways;
      out.maxGrids = maxGrids;
      out.allPatterns = allPatterns;
      // 块透明度已烘焙进背景色（opacity:1，背景 8 位 hex）
      const anyBlock = tun.mosaicLayer.querySelector('.t-m-block');
      out.blockOpacity = anyBlock ? anyBlock.style.opacity : '';
      out.bgColorSample = anyBlock ? anyBlock.style.backgroundColor : '';
      // _hexWithAlpha 单元校验
      out.hexA = tun._hexWithAlpha('#ffcc33', 0.5);
      out.hexNeutral = tun._hexWithAlpha('#ffffff12', 0.5);
      // ★ 反色判定 v2：_isLightColor 单元校验（莫奈亮块必须判亮）
      out.lightTone1 = tun._isLightColor('#9db9dd');   // 湖蓝 tone2 × 0.78 → 亮
      out.darkTone4 = tun._isLightColor('#3f5178');    // 湖蓝 tone4 → 暗
      // ★ 色板轮换：同 section 不同 groupId → 块颜色应变化
      tun._lastBgCacheKey = null;
      tun._updateMosaicBackground({ sectionId: 2, groupId: 0, params: { alignment: 'center' } });
      const c1 = tun.mosaicLayer.querySelector('.t-m-block') ? tun.mosaicLayer.querySelector('.t-m-block').style.backgroundColor : '';
      tun._lastBgCacheKey = null;
      tun._updateMosaicBackground({ sectionId: 2, groupId: 5, params: { alignment: 'center' } });
      const c2 = tun.mosaicLayer.querySelector('.t-m-block') ? tun.mosaicLayer.querySelector('.t-m-block').style.backgroundColor : '';
      out.paletteRotates = c1 !== c2;
      return out;
    }""")

    # 图形场断言
    check("shape-field-created", ev["fieldCreated"])
    check("shape-count-15", ev["shapeCount"] == 15, str(ev["shapeCount"]))
    check("shape-icons-present", ev["iconCount"] >= 1, str(ev["iconCount"]))
    check("shape-geoms-present", ev["geoCount"] >= 5, str(ev["geoCount"]))
    check("shape-particles-20", ev["particleCount"] == 20, str(ev["particleCount"]))
    check("shape-color-follows-theme", ev["colorFollows"])
    check("shape-same-seed-stable", ev["sameSeedStable"])
    check("shape-new-seed-reshuffles", ev["newSeedReshuffles"])
    check("shape-orbit-anim", "pv-shape-orbit" in str(ev["orbitAnim"]), str(ev["orbitAnim"]))

    check("mosaic-engine-built", ev["engineBuilt"])
    check("mosaic-grid-always", ev["gridAlways"], f"patterns={ev['allPatterns']} maxGrids={ev['maxGrids']}")
    check("mosaic-block-opacity-1", ev["blockOpacity"] == "1", str(ev["blockOpacity"]))
    # 计算样式统一归一化为 rgba()；alpha 已烘焙进背景色（非父 opacity）即为修复生效
    bgc = str(ev["bgColorSample"])
    check("mosaic-alpha-baked", "rgba(" in bgc and float(re.search(r"rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)", bgc).group(1)) > 0,
          bgc)
    check("hexWithAlpha-6-digit", re.match(r"^#[0-9a-fA-F]{8}$", ev["hexA"] or "") is not None, str(ev["hexA"]))
    # 8 位色不再原样返回：自带 alpha(0x12) × opacity(0.5) → 0x09，否则中性块永远 ~7% 不透明
    check("hexWithAlpha-8digit-multiplied", str(ev["hexNeutral"]) == "#ffffff09", str(ev["hexNeutral"]))
    # ★ 反色判定 v2 + 色板轮换
    check("invert-light-tone1", ev["lightTone1"] is True, str(ev["lightTone1"]))
    check("invert-dark-tone4", ev["darkTone4"] is False, str(ev["darkTone4"]))
    check("palette-rotates-per-group", ev["paletteRotates"])

    fatal = [e for e in errors if not any(k in e for k in ("favicon", "net::", "404", "CORS", "Access to image", "Failed to load resource",
                                                           "加载歌曲出错", "音频错误", "DEMUXER", "audio_load_error"))]
    check("no-fatal-page-errors", len(fatal) == 0, "; ".join(fatal[:4]))
    browser.close()

fails = [n for n, ok, _ in results if not ok]
print()
print("=" * 46)
print("TOTAL:", len(results), " PASS:", len(results) - len(fails), " FAIL:", len(fails))
sys.exit(1 if fails else 0)
