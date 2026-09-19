# -*- coding: utf-8 -*-
"""PV 底部几何（folia fixedGeo 对齐） + 蒙德里安方格必现 自动测试"""
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

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 720}, reduced_motion="no-preference")
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

      // ========== 1. PVDecorations 底部几何 ==========
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
      deco.renderForNode(mkNode(0, 2), '#ffcc33');
      const svg0 = layer.querySelector('svg.pv-geo-svg');
      out.geoSvg = !!svg0;
      out.geoStroke = layer.querySelectorAll('.geo-stroke').length;
      out.geoFill = layer.querySelectorAll('.geo-fill').length;
      out.geoSoft = layer.querySelectorAll('.geo-soft').length;
      out.geoBottom = svg0 ? /bottom\\s*:|2vh/.test(svg0.getAttribute('style') || '') : false;
      out.geoFloatAnim = svg0 ? getComputedStyle(svg0).animationName : '';
      // 元件描边生长动画（等一帧后读动画名）
      await new Promise(r => setTimeout(r, 60));
      const gs0 = layer.querySelector('.geo-stroke');
      out.geoStrokeAnim = gs0 ? getComputedStyle(gs0).animationName : '';
      out.dashArray = gs0 ? getComputedStyle(gs0).strokeDasharray : '';
      // 换个场景构图变化
      deco.renderForNode(mkNode(1, 2), '#ffcc33');
      const svg1 = layer.querySelector('svg.pv-geo-svg');
      deco.renderForNode(mkNode(0, 2), '#ffcc33');
      const svgBack = layer.querySelector('svg.pv-geo-svg');
      out.variantChanges = !!(svg0 && svg1 && svg0.outerHTML !== svg1.outerHTML);
      out.variantBack = !!(svg0 && svgBack && svg0.outerHTML === svgBack.outerHTML);

      // ========== 2. TunnelEngine 蒙德里安方格必现 ==========
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
      for (let s = 0; s < 24; s++) {
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
      return out;
    }""")

    check("deco-svg-created", ev["geoSvg"])
    check("deco-has-stroke-geo", ev["geoStroke"] > 0, str(ev["geoStroke"]))
    check("deco-has-fill-geo", ev["geoFill"] > 0, str(ev["geoFill"]))
    check("deco-has-hatch", ev["geoSoft"] > 0, str(ev["geoSoft"]))
    check("deco-bottom-anchored", ev["geoBottom"])
    check("deco-svg-floating", "pv-geo-float" in str(ev["geoFloatAnim"]), str(ev["geoFloatAnim"]))
    check("deco-stroke-grow-anim", "pv-geo-draw" in str(ev["geoStrokeAnim"]), str(ev["geoStrokeAnim"]))
    check("deco-stroke-dash-prep", str(ev["dashArray"]).find("1") >= 0, str(ev["dashArray"]))
    check("deco-variant-changes", ev["variantChanges"])
    check("deco-variant-deterministic", ev["variantBack"])

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

    fatal = [e for e in errors if not any(k in e for k in ("favicon", "net::", "404", "CORS", "Access to image", "Failed to load resource",
                                                           "加载歌曲出错", "音频错误", "DEMUXER", "audio_load_error"))]
    check("no-fatal-page-errors", len(fatal) == 0, "; ".join(fatal[:4]))
    browser.close()

fails = [n for n, ok, _ in results if not ok]
print()
print("=" * 46)
print("TOTAL:", len(results), " PASS:", len(results) - len(fails), " FAIL:", len(fails))
sys.exit(1 if fails else 0)