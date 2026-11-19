/* ============================================================
 * config/appearanceSchema.js — 外观与模式「视觉工坊」声明式 Schema（唯一事实源）
 *
 * 13 种活跃视觉模式按 4 大家族分组（经典歌词 / 空间粒子 / 动态分镜 / 版画建筑），
 * 每个模式的控件明确分层：
 * - core:     核心模式参数（默认展开）
 * - advanced: 进阶调校与后期处理（折叠收纳，零改动保留完整 data-var）
 * - override: 独立背景与字体覆写（默认跟随「背景效果」/「字体管理」全局默认值，支持显式重置）
 *
 * ★ 颜色预设一律走 palette 名与 DEFAULT_ACCENT 令牌，不硬编码旧金色字面量。
 * ★ emotionGlow 作为一等 Schema 字段显式声明于 highlightColor 之前，
 *   不再由运行时 ensureEmotionGlowSliders() 注入 HTML 字符串。
 * ============================================================ */
import { DEFAULT_ACCENT } from './themePalette.js';

const _DATA = {
  "FAMILIES": [
    {
      "id": "classic",
      "label": "经典歌词",
      "labelEn": "Classic Lyrics",
      "modes": [
        "cover",
        "lyrics",
        "flyin"
      ]
    },
    {
      "id": "spatial",
      "label": "空间粒子",
      "labelEn": "Spatial & Particles",
      "modes": [
        "wordcloud",
        "tunnel",
        "dimension",
        "prism"
      ]
    },
    {
      "id": "kinetic",
      "label": "动态分镜",
      "labelEn": "Kinetic & MV",
      "modes": [
        "pv",
        "astrolabe",
        "focalcut"
      ]
    },
    {
      "id": "editorial",
      "label": "版画建筑",
      "labelEn": "Editorial & Craft",
      "modes": [
        "letterpress",
        "jizura",
        "vitrail",
        "tempera"
      ]
    }
  ],
  "MODES_META": [
    {
      "id": "cover",
      "label": "默认模式",
      "labelEn": "Default Mode",
      "family": "classic",
      "desc": "封面与逐字双排居中/左对齐布局",
      "descEn": "Classic cover + word-sync layout"
    },
    {
      "id": "lyrics",
      "label": "拾光 · Lyrics",
      "labelEn": "Lyrics Spotlight",
      "family": "classic",
      "desc": "聚焦渐隐排版，沉浸式阅读歌词",
      "descEn": "Focused centered lyrics view"
    },
    {
      "id": "flyin",
      "label": "飞白 · Fly-In",
      "labelEn": "Fly-In Calligraphy",
      "family": "classic",
      "desc": "逐词飞入浮现与景深渐变层次",
      "descEn": "Dynamic fly-in word entrance & glow"
    },
    {
      "id": "wordcloud",
      "label": "云涌 · WordCloud",
      "labelEn": "3D Word Cloud",
      "family": "spatial",
      "desc": "三维螺旋词云相机追焦漫游",
      "descEn": "3D spiral lyric word-cloud camera"
    },
    {
      "id": "tunnel",
      "label": "格律 · Mondrian",
      "labelEn": "Mondrian Tunnel",
      "family": "spatial",
      "desc": "蒙德里安几何隧道透视空间",
      "descEn": "Mondrian perspective lyric tunnel"
    },
    {
      "id": "dimension",
      "label": "穿行 · Dimension",
      "labelEn": "Dimension Space",
      "family": "spatial",
      "desc": "纵深穿行粒子空间与能量光晕",
      "descEn": "Spatial depth with reactive energy particles"
    },
    {
      "id": "prism",
      "label": "棱镜 · Prism",
      "labelEn": "Prism Refraction",
      "family": "spatial",
      "desc": "晶体切面折射、光谱色散与焦散",
      "descEn": "Crystal facets, dispersion & caustics"
    },
    {
      "id": "pv",
      "label": "诗镜 · Verse",
      "labelEn": "Verse PV Director",
      "family": "kinetic",
      "desc": "多镜头分镜排版 + 后期胶片特效",
      "descEn": "Storyboard typography PV & post-processing"
    },
    {
      "id": "astrolabe",
      "label": "画册 · Folio",
      "labelEn": "Editorial Folio",
      "family": "kinetic",
      "desc": "版画纸墨构图与高反差印刷分镜",
      "descEn": "Editorial printmaking storyboard scenes"
    },
    {
      "id": "letterpress",
      "label": "活字 · Letterpress",
      "labelEn": "Letterpress",
      "family": "editorial",
      "desc": "金属铅字与古籍印章留白版式",
      "descEn": "Tactile letterpress typography"
    },
    {
      "id": "jizura",
      "label": "字面 · Jizura",
      "labelEn": "Jizura Kinetic",
      "family": "editorial",
      "desc": "平面设计感动态排版与拼贴视效",
      "descEn": "Graphic kinetic typography & motion cuts"
    },
    {
      "id": "vitrail",
      "label": "琉璃龛 · Vitrail",
      "labelEn": "Vitrail Cathedral",
      "family": "editorial",
      "desc": "玻璃彩窗建筑光影与圣光浮尘",
      "descEn": "Architectural stained glass & god rays"
    },
    {
      "id": "focalcut",
      "label": "镜幕 · FocalCut",
      "labelEn": "FocalCut Director",
      "family": "kinetic",
      "desc": "建筑展墙排版与 2.5D 多机位分屏闪切",
      "descEn": "Architectural exhibition wall & 2.5D split-lens cuts"
    },
    {
      "id": "tempera",
      "label": "版画 · Tempera",
      "labelEn": "Tempera Fresco",
      "family": "editorial",
      "desc": "蛋彩构图块与撞色丝网印刷动效",
      "descEn": "Tempera geometry blocks & glyph motion"
    }
  ],
  "TIER_META": {
    "core": {
      "label": "核心参数",
      "labelEn": "Core Controls"
    },
    "advanced": {
      "label": "进阶与后期处理",
      "labelEn": "Advanced & Effects"
    },
    "override": {
      "label": "独立背景与字体覆写",
      "labelEn": "Per-Mode Background & Font Override"
    }
  },
  "modesData": {
    "cover": {
      "core": [
        {
          "label": "歌词字体大小",
          "controls": [
            {
              "kind": "slider",
              "var": "fontSize",
              "min": "0.5",
              "max": "2.0",
              "step": "0.05",
              "value": "1.0"
            }
          ],
          "valSpan": {
            "var": "fontSize",
            "text": "1.00x"
          }
        },
        {
          "label": "歌词模糊强度",
          "controls": [
            {
              "kind": "slider",
              "var": "blurLevel",
              "min": "0",
              "max": "8",
              "step": "1",
              "value": "2"
            }
          ],
          "valSpan": {
            "var": "blurLevel",
            "text": "2"
          }
        },
        {
          "label": "情感词发光强度",
          "controls": [
            {
              "kind": "slider",
              "var": "emotionGlow",
              "min": "0",
              "max": "30",
              "step": "1",
              "value": "10"
            }
          ],
          "valSpan": {
            "var": "emotionGlow",
            "text": "10px"
          }
        },
        {
          "label": "高亮颜色",
          "controls": [
            {
              "kind": "color",
              "var": "highlightColor",
              "palette": "accent+white",
              "active": DEFAULT_ACCENT
            }
          ]
        },
        {
          "label": "歌词对齐",
          "controls": [
            {
              "kind": "segment",
              "cls": "setting-btn-group",
              "buttons": [
                {
                  "text": "左",
                  "var": "align",
                  "val": "left",
                  "active": true
                },
                {
                  "text": "中",
                  "var": "align",
                  "val": "center"
                },
                {
                  "text": "右",
                  "var": "align",
                  "val": "right"
                }
              ]
            }
          ]
        },
        {
          "label": "显示翻译",
          "controls": [
            {
              "kind": "toggle",
              "var": "showTranslation",
              "active": true
            }
          ]
        },
        {
          "label": "显示罗马音",
          "controls": [
            {
              "kind": "toggle",
              "var": "showRomaji",
              "active": true
            }
          ]
        }
      ],
      "advanced": [
        {
          "label": "高亮行未高亮部分",
          "controls": [
            {
              "kind": "color",
              "var": "highlightInactiveColor",
              "palette": "dim",
              "active": "rgba(255,255,255,0.6)"
            }
          ]
        },
        {
          "label": "非高亮歌词行颜色",
          "controls": [
            {
              "kind": "color",
              "var": "inactiveColor",
              "palette": "text",
              "active": "rgba(255,255,255,0.4)"
            }
          ]
        }
      ],
      "override": [
        {
          "label": "背景模糊",
          "controls": [
            {
              "kind": "slider",
              "var": "bgBlur",
              "min": "0",
              "max": "120",
              "step": "2",
              "value": "60"
            }
          ],
          "valSpan": {
            "var": "bgBlur",
            "text": "60px"
          }
        },
        {
          "label": "背景亮度",
          "controls": [
            {
              "kind": "slider",
              "var": "bgBrightness",
              "min": "0.05",
              "max": "0.9",
              "step": "0.05",
              "value": "0.35"
            }
          ],
          "valSpan": {
            "var": "bgBrightness",
            "text": "0.35"
          }
        },
        {
          "label": "摇摆动画",
          "controls": [
            {
              "kind": "toggle",
              "var": "swayEnabled",
              "active": true
            }
          ]
        },
        {
          "label": "摇摆幅度",
          "controls": [
            {
              "kind": "slider",
              "var": "swayAmp",
              "min": "0",
              "max": "20",
              "step": "1",
              "value": "12"
            }
          ],
          "valSpan": {
            "var": "swayAmp",
            "text": "12°"
          }
        },
        {
          "label": "摇摆周期",
          "controls": [
            {
              "kind": "slider",
              "var": "swayDuration",
              "min": "6",
              "max": "30",
              "step": "1",
              "value": "16"
            }
          ],
          "valSpan": {
            "var": "swayDuration",
            "text": "16s"
          }
        },
        {
          "label": "字体",
          "controls": [
            {
              "kind": "dropdown",
              "var": "fontFamily",
              "cls": "setting-dropdown appearance-font-dropdown",
              "triggerText": "",
              "options": [
                {
                  "value": "inherit",
                  "text": "系统默认",
                  "selected": true
                },
                {
                  "value": "'Noto Sans SC', sans-serif",
                  "text": "思源黑体"
                },
                {
                  "value": "'Noto Serif SC', serif",
                  "text": "思源宋体"
                },
                {
                  "value": "'Microsoft YaHei', sans-serif",
                  "text": "微软雅黑"
                },
                {
                  "value": "'SimHei', sans-serif",
                  "text": "黑体"
                },
                {
                  "value": "'PingFang SC', sans-serif",
                  "text": "苹方"
                },
                {
                  "value": "monospace",
                  "text": "等宽字体"
                }
              ]
            }
          ]
        },
        {
          "label": "导入自定义字体",
          "controls": [
            {
              "kind": "button",
              "cls": "setting-btn appearance-import-font-btn",
              "text": "选择字体"
            }
          ],
          "desc": "支持 .ttf .otf .woff .woff2"
        }
      ]
    },
    "lyrics": {
      "core": [
        {
          "label": "歌词字体大小",
          "controls": [
            {
              "kind": "slider",
              "var": "fontSize",
              "min": "0.5",
              "max": "2.0",
              "step": "0.05",
              "value": "1.0"
            }
          ],
          "valSpan": {
            "var": "fontSize",
            "text": "1.00x"
          }
        },
        {
          "label": "歌词模糊强度",
          "controls": [
            {
              "kind": "slider",
              "var": "blurLevel",
              "min": "0",
              "max": "8",
              "step": "1",
              "value": "2"
            }
          ],
          "valSpan": {
            "var": "blurLevel",
            "text": "2"
          }
        },
        {
          "label": "情感词发光强度",
          "controls": [
            {
              "kind": "slider",
              "var": "emotionGlow",
              "min": "0",
              "max": "30",
              "step": "1",
              "value": "10"
            }
          ],
          "valSpan": {
            "var": "emotionGlow",
            "text": "10px"
          }
        },
        {
          "label": "高亮颜色",
          "controls": [
            {
              "kind": "color",
              "var": "highlightColor",
              "palette": "accent+white",
              "active": DEFAULT_ACCENT
            }
          ]
        },
        {
          "label": "歌词对齐",
          "controls": [
            {
              "kind": "segment",
              "cls": "setting-btn-group",
              "buttons": [
                {
                  "text": "左",
                  "var": "align",
                  "val": "left",
                  "active": true
                },
                {
                  "text": "中",
                  "var": "align",
                  "val": "center"
                },
                {
                  "text": "右",
                  "var": "align",
                  "val": "right"
                }
              ]
            }
          ]
        },
        {
          "label": "显示翻译",
          "controls": [
            {
              "kind": "toggle",
              "var": "showTranslation",
              "active": true
            }
          ]
        },
        {
          "label": "显示罗马音",
          "controls": [
            {
              "kind": "toggle",
              "var": "showRomaji",
              "active": true
            }
          ]
        }
      ],
      "advanced": [
        {
          "label": "高亮行未高亮部分",
          "controls": [
            {
              "kind": "color",
              "var": "highlightInactiveColor",
              "palette": "dim",
              "active": "rgba(255,255,255,0.6)"
            }
          ]
        },
        {
          "label": "非高亮歌词行颜色",
          "controls": [
            {
              "kind": "color",
              "var": "inactiveColor",
              "palette": "text",
              "active": "rgba(255,255,255,0.4)"
            }
          ]
        }
      ],
      "override": [
        {
          "label": "背景模糊",
          "controls": [
            {
              "kind": "slider",
              "var": "bgBlur",
              "min": "0",
              "max": "120",
              "step": "2",
              "value": "60"
            }
          ],
          "valSpan": {
            "var": "bgBlur",
            "text": "60px"
          }
        },
        {
          "label": "背景亮度",
          "controls": [
            {
              "kind": "slider",
              "var": "bgBrightness",
              "min": "0.05",
              "max": "0.9",
              "step": "0.05",
              "value": "0.35"
            }
          ],
          "valSpan": {
            "var": "bgBrightness",
            "text": "0.35"
          }
        },
        {
          "label": "摇摆动画",
          "controls": [
            {
              "kind": "toggle",
              "var": "swayEnabled",
              "active": true
            }
          ]
        },
        {
          "label": "摇摆幅度",
          "controls": [
            {
              "kind": "slider",
              "var": "swayAmp",
              "min": "0",
              "max": "20",
              "step": "1",
              "value": "12"
            }
          ],
          "valSpan": {
            "var": "swayAmp",
            "text": "12°"
          }
        },
        {
          "label": "摇摆周期",
          "controls": [
            {
              "kind": "slider",
              "var": "swayDuration",
              "min": "6",
              "max": "30",
              "step": "1",
              "value": "16"
            }
          ],
          "valSpan": {
            "var": "swayDuration",
            "text": "16s"
          }
        },
        {
          "label": "字体",
          "controls": [
            {
              "kind": "dropdown",
              "var": "fontFamily",
              "cls": "setting-dropdown appearance-font-dropdown",
              "triggerText": "",
              "options": [
                {
                  "value": "inherit",
                  "text": "系统默认",
                  "selected": true
                },
                {
                  "value": "'Noto Sans SC', sans-serif",
                  "text": "思源黑体"
                },
                {
                  "value": "'Noto Serif SC', serif",
                  "text": "思源宋体"
                },
                {
                  "value": "'Microsoft YaHei', sans-serif",
                  "text": "微软雅黑"
                },
                {
                  "value": "'SimHei', sans-serif",
                  "text": "黑体"
                },
                {
                  "value": "'PingFang SC', sans-serif",
                  "text": "苹方"
                },
                {
                  "value": "monospace",
                  "text": "等宽字体"
                }
              ]
            }
          ]
        },
        {
          "label": "导入自定义字体",
          "controls": [
            {
              "kind": "button",
              "cls": "setting-btn appearance-import-font-btn",
              "text": "选择字体"
            }
          ],
          "desc": "支持 .ttf .otf .woff .woff2"
        }
      ]
    },
    "flyin": {
      "core": [
        {
          "label": "基础字号",
          "controls": [
            {
              "kind": "slider",
              "var": "fontSize",
              "min": "0.5",
              "max": "2.0",
              "step": "0.05",
              "value": "1.0"
            }
          ],
          "valSpan": {
            "var": "fontSize",
            "text": "1.00x"
          }
        },
        {
          "label": "飞入位移距离",
          "controls": [
            {
              "kind": "slider",
              "var": "flyinTranslateY",
              "min": "0",
              "max": "30",
              "step": "1",
              "value": "16"
            }
          ],
          "valSpan": {
            "var": "flyinTranslateY",
            "text": "16px"
          }
        },
        {
          "label": "初始缩放比例",
          "controls": [
            {
              "kind": "slider",
              "var": "flyinScale",
              "min": "0.5",
              "max": "1.0",
              "step": "0.05",
              "value": "0.85"
            }
          ],
          "valSpan": {
            "var": "flyinScale",
            "text": "0.85x"
          }
        },
        {
          "label": "情感词发光强度",
          "controls": [
            {
              "kind": "slider",
              "var": "emotionGlow",
              "min": "0",
              "max": "30",
              "step": "1",
              "value": "10"
            }
          ],
          "valSpan": {
            "var": "emotionGlow",
            "text": "10px"
          }
        },
        {
          "label": "高亮颜色",
          "controls": [
            {
              "kind": "color",
              "var": "highlightColor",
              "palette": "accent+white",
              "active": DEFAULT_ACCENT
            }
          ]
        },
        {
          "label": "显示翻译",
          "controls": [
            {
              "kind": "toggle",
              "var": "showTranslation",
              "active": true
            }
          ]
        },
        {
          "label": "显示罗马音",
          "controls": [
            {
              "kind": "toggle",
              "var": "showRomaji",
              "active": true
            }
          ]
        }
      ],
      "advanced": [
        {
          "label": "发光阴影强度",
          "controls": [
            {
              "kind": "slider",
              "var": "flyinGlow",
              "min": "0",
              "max": "20",
              "step": "1",
              "value": "8"
            }
          ],
          "valSpan": {
            "var": "flyinGlow",
            "text": "8px"
          }
        },
        {
          "label": "翻译区字号",
          "controls": [
            {
              "kind": "slider",
              "var": "flyinTransSize",
              "min": "10",
              "max": "24",
              "step": "1",
              "value": "14"
            }
          ],
          "valSpan": {
            "var": "flyinTransSize",
            "text": "14px"
          }
        },
        {
          "label": "翻译区距底边距",
          "controls": [
            {
              "kind": "slider",
              "var": "flyinTransBottom",
              "min": "0",
              "max": "40",
              "step": "1",
              "value": "16"
            }
          ],
          "valSpan": {
            "var": "flyinTransBottom",
            "text": "16px"
          }
        },
        {
          "label": "背景图形颜色",
          "controls": [
            {
              "kind": "color",
              "var": "graphicColor",
              "palette": "accent",
              "active": DEFAULT_ACCENT
            }
          ],
          "desc": "控制飞入背景装饰图形颜色"
        }
      ],
      "override": [
        {
          "label": "背景模糊",
          "controls": [
            {
              "kind": "slider",
              "var": "bgBlur",
              "min": "0",
              "max": "120",
              "step": "2",
              "value": "80"
            }
          ],
          "valSpan": {
            "var": "bgBlur",
            "text": "80px"
          }
        },
        {
          "label": "背景亮度",
          "controls": [
            {
              "kind": "slider",
              "var": "bgBrightness",
              "min": "0.03",
              "max": "0.2",
              "step": "0.01",
              "value": "0.12"
            }
          ],
          "valSpan": {
            "var": "bgBrightness",
            "text": "0.12"
          }
        },
        {
          "label": "摇摆动画",
          "controls": [
            {
              "kind": "toggle",
              "var": "swayEnabled",
              "active": true
            }
          ]
        },
        {
          "label": "摇摆幅度",
          "controls": [
            {
              "kind": "slider",
              "var": "swayAmp",
              "min": "0",
              "max": "20",
              "step": "1",
              "value": "12"
            }
          ],
          "valSpan": {
            "var": "swayAmp",
            "text": "12°"
          }
        },
        {
          "label": "摇摆周期",
          "controls": [
            {
              "kind": "slider",
              "var": "swayDuration",
              "min": "6",
              "max": "30",
              "step": "1",
              "value": "16"
            }
          ],
          "valSpan": {
            "var": "swayDuration",
            "text": "16s"
          }
        },
        {
          "label": "字体",
          "controls": [
            {
              "kind": "dropdown",
              "var": "fontFamily",
              "cls": "setting-dropdown appearance-font-dropdown",
              "triggerText": "",
              "options": [
                {
                  "value": "inherit",
                  "text": "系统默认",
                  "selected": true
                },
                {
                  "value": "'Noto Sans SC', sans-serif",
                  "text": "思源黑体"
                },
                {
                  "value": "'Noto Serif SC', serif",
                  "text": "思源宋体"
                },
                {
                  "value": "'Microsoft YaHei', sans-serif",
                  "text": "微软雅黑"
                },
                {
                  "value": "'SimHei', sans-serif",
                  "text": "黑体"
                },
                {
                  "value": "'PingFang SC', sans-serif",
                  "text": "苹方"
                },
                {
                  "value": "monospace",
                  "text": "等宽字体"
                }
              ]
            }
          ]
        },
        {
          "label": "导入自定义字体",
          "controls": [
            {
              "kind": "button",
              "cls": "setting-btn appearance-import-font-btn",
              "text": "选择字体"
            }
          ],
          "desc": "支持 .ttf .otf .woff .woff2"
        }
      ]
    },
    "wordcloud": {
      "core": [
        {
          "label": "字体随机 Min",
          "controls": [
            {
              "kind": "slider",
              "var": "wcFontMin",
              "min": "0.8",
              "max": "3.0",
              "step": "0.1",
              "value": "1.2"
            }
          ],
          "valSpan": {
            "var": "wcFontMin",
            "text": "1.2rem"
          }
        },
        {
          "label": "字体随机 Max",
          "controls": [
            {
              "kind": "slider",
              "var": "wcFontMax",
              "min": "2.0",
              "max": "6.0",
              "step": "0.1",
              "value": "3.5"
            }
          ],
          "valSpan": {
            "var": "wcFontMax",
            "text": "3.5rem"
          }
        },
        {
          "label": "螺旋排版间距",
          "controls": [
            {
              "kind": "slider",
              "var": "wcDensity",
              "min": "8",
              "max": "40",
              "step": "1",
              "value": "18"
            }
          ],
          "valSpan": {
            "var": "wcDensity",
            "text": "18px"
          }
        },
        {
          "label": "情感词发光强度",
          "controls": [
            {
              "kind": "slider",
              "var": "emotionGlow",
              "min": "0",
              "max": "30",
              "step": "1",
              "value": "10"
            }
          ],
          "valSpan": {
            "var": "emotionGlow",
            "text": "10px"
          }
        },
        {
          "label": "高亮颜色",
          "controls": [
            {
              "kind": "color",
              "var": "highlightColor",
              "palette": "accent+white",
              "active": DEFAULT_ACCENT
            }
          ]
        },
        {
          "label": "显示翻译",
          "controls": [
            {
              "kind": "toggle",
              "var": "showTranslation",
              "active": true
            }
          ]
        },
        {
          "label": "显示罗马音",
          "controls": [
            {
              "kind": "toggle",
              "var": "showRomaji",
              "active": true
            }
          ]
        }
      ],
      "advanced": [
        {
          "label": "相机阻尼系数",
          "controls": [
            {
              "kind": "slider",
              "var": "wcLerpFactor",
              "min": "0.01",
              "max": "0.15",
              "step": "0.01",
              "value": "0.05"
            }
          ],
          "valSpan": {
            "var": "wcLerpFactor",
            "text": "0.05"
          }
        },
        {
          "label": "非活动行模糊",
          "controls": [
            {
              "kind": "slider",
              "var": "wcDimBlur",
              "min": "0",
              "max": "12",
              "step": "0.5",
              "value": "3"
            }
          ],
          "valSpan": {
            "var": "wcDimBlur",
            "text": "3px"
          }
        },
        {
          "label": "非活动行暗淡",
          "controls": [
            {
              "kind": "slider",
              "var": "wcDimOpacity",
              "min": "0.05",
              "max": "0.5",
              "step": "0.05",
              "value": "0.2"
            }
          ],
          "valSpan": {
            "var": "wcDimOpacity",
            "text": "0.2"
          }
        }
      ],
      "override": [
        {
          "label": "背景模糊",
          "controls": [
            {
              "kind": "slider",
              "var": "bgBlur",
              "min": "0",
              "max": "120",
              "step": "2",
              "value": "80"
            }
          ],
          "valSpan": {
            "var": "bgBlur",
            "text": "80px"
          }
        },
        {
          "label": "背景亮度",
          "controls": [
            {
              "kind": "slider",
              "var": "bgBrightness",
              "min": "0.03",
              "max": "0.2",
              "step": "0.01",
              "value": "0.1"
            }
          ],
          "valSpan": {
            "var": "bgBrightness",
            "text": "0.1"
          }
        },
        {
          "label": "摇摆动画",
          "controls": [
            {
              "kind": "toggle",
              "var": "swayEnabled",
              "active": true
            }
          ]
        },
        {
          "label": "摇摆幅度",
          "controls": [
            {
              "kind": "slider",
              "var": "swayAmp",
              "min": "0",
              "max": "20",
              "step": "1",
              "value": "12"
            }
          ],
          "valSpan": {
            "var": "swayAmp",
            "text": "12°"
          }
        },
        {
          "label": "摇摆周期",
          "controls": [
            {
              "kind": "slider",
              "var": "swayDuration",
              "min": "6",
              "max": "30",
              "step": "1",
              "value": "16"
            }
          ],
          "valSpan": {
            "var": "swayDuration",
            "text": "16s"
          }
        },
        {
          "label": "字体",
          "controls": [
            {
              "kind": "dropdown",
              "var": "fontFamily",
              "cls": "setting-dropdown appearance-font-dropdown",
              "triggerText": "",
              "options": [
                {
                  "value": "inherit",
                  "text": "系统默认",
                  "selected": true
                },
                {
                  "value": "'Noto Sans SC', sans-serif",
                  "text": "思源黑体"
                },
                {
                  "value": "'Noto Serif SC', serif",
                  "text": "思源宋体"
                },
                {
                  "value": "'Microsoft YaHei', sans-serif",
                  "text": "微软雅黑"
                },
                {
                  "value": "'SimHei', sans-serif",
                  "text": "黑体"
                },
                {
                  "value": "'PingFang SC', sans-serif",
                  "text": "苹方"
                },
                {
                  "value": "monospace",
                  "text": "等宽字体"
                }
              ]
            }
          ]
        },
        {
          "label": "导入自定义字体",
          "controls": [
            {
              "kind": "button",
              "cls": "setting-btn appearance-import-font-btn",
              "text": "选择字体"
            }
          ],
          "desc": "支持 .ttf .otf .woff .woff2"
        }
      ]
    },
    "pv": {
      "core": [
        {
          "label": "基础字号",
          "controls": [
            {
              "kind": "slider",
              "var": "fontSize",
              "min": "0.5",
              "max": "2.0",
              "step": "0.05",
              "value": "1.5"
            }
          ],
          "valSpan": {
            "var": "fontSize",
            "text": "1.50x"
          }
        },
        {
          "label": "默认焦距 (镜头特写)",
          "controls": [
            {
              "kind": "slider",
              "var": "cameraZoom",
              "min": "0.8",
              "max": "3.0",
              "step": "0.1",
              "value": "1.0"
            }
          ],
          "desc": "调大：聚焦当前两三个词的特写；调小：显示更完整的句子",
          "valSpan": {
            "var": "cameraZoom",
            "text": "1.0x"
          }
        },
        {
          "label": "动态强度",
          "controls": [
            {
              "kind": "dropdown",
              "var": "animationIntensity",
              "cls": "setting-dropdown",
              "triggerText": "",
              "options": [
                {
                  "value": "calm",
                  "text": "平静"
                },
                {
                  "value": "normal",
                  "text": "标准",
                  "selected": true
                },
                {
                  "value": "chaotic",
                  "text": "激烈"
                }
              ]
            }
          ],
          "desc": "整体运动与镜头的幅度：平静 0.65× ／ 标准 1×（原版默认）／ 激烈 1.35×"
        },
        {
          "label": "情感词多色发光联动",
          "controls": [
            {
              "kind": "toggle",
              "var": "aiColorSync",
              "active": true
            }
          ]
        },
        {
          "label": "情感词发光强度",
          "controls": [
            {
              "kind": "slider",
              "var": "emotionGlow",
              "min": "0",
              "max": "30",
              "step": "1",
              "value": "10"
            }
          ],
          "valSpan": {
            "var": "emotionGlow",
            "text": "10px"
          }
        },
        {
          "label": "高亮颜色",
          "controls": [
            {
              "kind": "color",
              "var": "highlightColor",
              "palette": "accent+white",
              "active": DEFAULT_ACCENT
            }
          ]
        },
        {
          "label": "显示翻译",
          "controls": [
            {
              "kind": "toggle",
              "var": "showTranslation",
              "active": true
            }
          ]
        },
        {
          "label": "显示罗马音",
          "controls": [
            {
              "kind": "toggle",
              "var": "showRomaji",
              "active": true
            }
          ]
        }
      ],
      "advanced": [
        {
          "label": "网点大小",
          "controls": [
            {
              "kind": "slider",
              "var": "halftoneSize",
              "min": "3",
              "max": "12",
              "step": "1",
              "value": "6"
            }
          ],
          "valSpan": {
            "var": "halftoneSize",
            "text": "6px"
          }
        },
        {
          "label": "运镜平滑速度",
          "controls": [
            {
              "kind": "slider",
              "var": "cameraSpeed",
              "min": "0.5",
              "max": "2.0",
              "step": "0.1",
              "value": "1.0"
            }
          ],
          "valSpan": {
            "var": "cameraSpeed",
            "text": "1.0x"
          }
        },
        {
          "label": "相机阻尼系数",
          "controls": [
            {
              "kind": "slider",
              "var": "cameraDamping",
              "min": "0.005",
              "max": "0.05",
              "step": "0.002",
              "value": "0.016"
            }
          ],
          "valSpan": {
            "var": "cameraDamping",
            "text": "0.016"
          }
        },
        {
          "label": "镜头运动强度",
          "controls": [
            {
              "kind": "slider",
              "var": "cameraIntensity",
              "min": "0",
              "max": "2",
              "step": "0.05",
              "value": "1"
            }
          ],
          "valSpan": {
            "var": "cameraIntensity",
            "text": "1.00x"
          }
        },
        {
          "label": "文字动势",
          "controls": [
            {
              "kind": "slider",
              "var": "typographyMotion",
              "min": "0",
              "max": "2",
              "step": "0.05",
              "value": "1"
            }
          ],
          "desc": "逐字入场幅度，同时乘进发光强度",
          "valSpan": {
            "var": "typographyMotion",
            "text": "1.00x"
          }
        },
        {
          "label": "背景短线密度",
          "controls": [
            {
              "kind": "slider",
              "var": "mgDensity",
              "min": "0",
              "max": "2",
              "step": "0.05",
              "value": "1"
            }
          ],
          "valSpan": {
            "var": "mgDensity",
            "text": "1.00x"
          }
        },
        {
          "label": "显示 HUD 边框与准心",
          "controls": [
            {
              "kind": "toggle",
              "var": "showHud",
              "active": true
            }
          ]
        },
        {
          "label": "显示巨型背景字与几何构图",
          "controls": [
            {
              "kind": "toggle",
              "var": "showDecorations",
              "active": true
            }
          ]
        },
        {
          "label": "显示星芒微粒",
          "controls": [
            {
              "kind": "toggle",
              "var": "showParticles",
              "active": true
            }
          ]
        },
        {
          "label": "仅文字",
          "controls": [
            {
              "kind": "toggle",
              "var": "showOnlyText"
            }
          ],
          "desc": "只保留歌词文字：引导线、装饰画框、图形与片尾海报一并隐藏"
        },
        {
          "label": "显示引导线",
          "controls": [
            {
              "kind": "toggle",
              "var": "showGuide",
              "active": true
            }
          ],
          "desc": "逐词入场之前的引导曲线与定位标记"
        },
        {
          "label": "显示巨型装饰字",
          "controls": [
            {
              "kind": "toggle",
              "var": "showGiantDecorativeText",
              "active": true
            }
          ],
          "desc": "每个镜头里的巨型残影字（装饰层，不参与逐字高亮）"
        },
        {
          "label": "装饰画框与文字浮标",
          "controls": [
            {
              "kind": "toggle",
              "var": "showFixedGeo",
              "active": true
            }
          ],
          "desc": "每句背后的开放画框；与「显示巨型背景字与几何构图」不同，后者管的是背景几何层"
        },
        {
          "label": "外层边框",
          "controls": [
            {
              "kind": "dropdown",
              "var": "outerFrameMode",
              "cls": "setting-dropdown",
              "triggerText": "",
              "options": [
                {
                  "value": "none",
                  "text": "完全隐藏"
                },
                {
                  "value": "frame",
                  "text": "仅显示框架"
                },
                {
                  "value": "full",
                  "text": "完全显示",
                  "selected": true
                }
              ]
            }
          ],
          "desc": "完全显示会再叠上场景里那行竖排主题名"
        },
        {
          "label": "间奏标记也走谱面",
          "controls": [
            {
              "kind": "toggle",
              "var": "interludeStaff"
            }
          ],
          "desc": "folia 只认 ♪；打开后 MUSIC / MUSIC- / ♪♪ 与纯点号行（…）也画成五线谱（本仓扩展，默认关 = 原版行为）"
        },
        {
          "label": "背景图形颜色",
          "controls": [
            {
              "kind": "color",
              "var": "graphicColor",
              "palette": "accent",
              "active": DEFAULT_ACCENT
            }
          ],
          "desc": "控制PV模式几何构图与装饰图层颜色"
        },
        {
          "label": "后期处理",
          "controls": [
            {
              "kind": "toggle",
              "var": "postProcessEnabled"
            }
          ],
          "desc": "folia 默认关闭；开启后才叠加胶片颗粒 / RGB 色散 / 半调网点 / 暗角——薄线装饰（图形、画框）上容易显得像雪花噪点"
        },
        {
          "label": "胶片颗粒",
          "controls": [
            {
              "kind": "slider",
              "var": "postProcessGrain",
              "min": "0",
              "max": "1",
              "step": "0.05",
              "value": "0.2"
            }
          ],
          "valSpan": {
            "var": "postProcessGrain",
            "text": "0.20"
          }
        },
        {
          "label": "对比度",
          "controls": [
            {
              "kind": "slider",
              "var": "postProcessContrast",
              "min": "0",
              "max": "1",
              "step": "0.05",
              "value": "0"
            }
          ],
          "valSpan": {
            "var": "postProcessContrast",
            "text": "0.00"
          }
        },
        {
          "label": "RGB 色散",
          "controls": [
            {
              "kind": "slider",
              "var": "postProcessRgbShift",
              "min": "0",
              "max": "1",
              "step": "0.05",
              "value": "0"
            }
          ],
          "valSpan": {
            "var": "postProcessRgbShift",
            "text": "0.00"
          }
        },
        {
          "label": "半调网点",
          "controls": [
            {
              "kind": "slider",
              "var": "postProcessHalftone",
              "min": "0",
              "max": "1",
              "step": "0.05",
              "value": "0"
            }
          ],
          "valSpan": {
            "var": "postProcessHalftone",
            "text": "0.00"
          }
        },
        {
          "label": "暗角",
          "controls": [
            {
              "kind": "slider",
              "var": "postProcessVignette",
              "min": "0",
              "max": "2",
              "step": "0.05",
              "value": "0.85"
            }
          ],
          "valSpan": {
            "var": "postProcessVignette",
            "text": "0.85"
          }
        },
        {
          "label": "镜头畸变",
          "controls": [
            {
              "kind": "slider",
              "var": "postProcessLensDistortion",
              "min": "0",
              "max": "2",
              "step": "0.05",
              "value": "0.3"
            }
          ],
          "valSpan": {
            "var": "postProcessLensDistortion",
            "text": "0.30"
          }
        },
        {
          "label": "镜头色散",
          "controls": [
            {
              "kind": "slider",
              "var": "postProcessLensDispersion",
              "min": "0",
              "max": "1",
              "step": "0.05",
              "value": "0.6"
            }
          ],
          "valSpan": {
            "var": "postProcessLensDispersion",
            "text": "0.60"
          }
        }
      ],
      "override": [
        {
          "label": "字体",
          "controls": [
            {
              "kind": "dropdown",
              "var": "fontFamily",
              "cls": "setting-dropdown appearance-font-dropdown",
              "triggerText": "",
              "options": [
                {
                  "value": "inherit",
                  "text": "系统默认",
                  "selected": true
                },
                {
                  "value": "'Noto Sans SC', sans-serif",
                  "text": "思源黑体"
                },
                {
                  "value": "'Noto Serif SC', serif",
                  "text": "思源宋体"
                },
                {
                  "value": "'Microsoft YaHei', sans-serif",
                  "text": "微软雅黑"
                },
                {
                  "value": "'SimHei', sans-serif",
                  "text": "黑体"
                },
                {
                  "value": "'PingFang SC', sans-serif",
                  "text": "苹方"
                },
                {
                  "value": "monospace",
                  "text": "等宽字体"
                }
              ]
            }
          ]
        },
        {
          "label": "导入自定义字体",
          "controls": [
            {
              "kind": "button",
              "cls": "setting-btn appearance-import-font-btn",
              "text": "选择字体"
            }
          ],
          "desc": "支持 .ttf .otf .woff .woff2"
        }
      ]
    },
    "tunnel": {
      "core": [
        {
          "label": "基础字号",
          "controls": [
            {
              "kind": "slider",
              "var": "fontSize",
              "min": "0.5",
              "max": "2.0",
              "step": "0.05",
              "value": "1.1"
            }
          ],
          "valSpan": {
            "var": "fontSize",
            "text": "1.10x"
          }
        },
        {
          "label": "活泼排版（允许词块倾斜）",
          "controls": [
            {
              "kind": "toggle",
              "var": "mosaicTilt"
            }
          ],
          "desc": "关闭后不旋转，仅按字号大小居中排版"
        },
        {
          "label": "运镜平滑速度",
          "controls": [
            {
              "kind": "slider",
              "var": "cameraSpeed",
              "min": "0.3",
              "max": "2.0",
              "step": "0.1",
              "value": "1.0"
            }
          ],
          "valSpan": {
            "var": "cameraSpeed",
            "text": "1.0x"
          }
        },
        {
          "label": "情感词发光强度",
          "controls": [
            {
              "kind": "slider",
              "var": "emotionGlow",
              "min": "0",
              "max": "30",
              "step": "1",
              "value": "12"
            }
          ],
          "valSpan": {
            "var": "emotionGlow",
            "text": "12px"
          }
        },
        {
          "label": "显示翻译",
          "controls": [
            {
              "kind": "toggle",
              "var": "showTranslation",
              "active": true
            }
          ]
        },
        {
          "label": "显示罗马音",
          "controls": [
            {
              "kind": "toggle",
              "var": "showRomaji",
              "active": true
            }
          ]
        }
      ],
      "advanced": [
        {
          "label": "相机阻尼系数",
          "controls": [
            {
              "kind": "slider",
              "var": "cameraDamping",
              "min": "0.02",
              "max": "0.1",
              "step": "0.01",
              "value": "0.045"
            }
          ],
          "valSpan": {
            "var": "cameraDamping",
            "text": "0.045"
          }
        },
        {
          "label": "场景过渡时长",
          "controls": [
            {
              "kind": "slider",
              "var": "transitDuration",
              "min": "200",
              "max": "800",
              "step": "25",
              "value": "450"
            }
          ],
          "valSpan": {
            "var": "transitDuration",
            "text": "450ms"
          }
        },
        {
          "label": "行间距",
          "controls": [
            {
              "kind": "slider",
              "var": "rowGap",
              "min": "50",
              "max": "160",
              "step": "10",
              "value": "90"
            }
          ],
          "valSpan": {
            "var": "rowGap",
            "text": "90px"
          }
        },
        {
          "label": "显示背景流光",
          "controls": [
            {
              "kind": "toggle",
              "var": "showStreaks",
              "active": true
            }
          ]
        },
        {
          "label": "显示回响装饰字",
          "controls": [
            {
              "kind": "toggle",
              "var": "showEcho",
              "active": true
            }
          ]
        },
        {
          "label": "背景图形颜色",
          "controls": [
            {
              "kind": "color",
              "var": "graphicColor",
              "palette": "accent",
              "active": DEFAULT_ACCENT
            }
          ],
          "desc": "控制回响描边字与构图辅助线颜色"
        }
      ],
      "override": [
        {
          "label": "字体",
          "controls": [
            {
              "kind": "dropdown",
              "var": "fontFamily",
              "cls": "setting-dropdown appearance-font-dropdown",
              "triggerText": "",
              "options": [
                {
                  "value": "inherit",
                  "text": "系统默认",
                  "selected": true
                },
                {
                  "value": "'Noto Sans SC', sans-serif",
                  "text": "思源黑体"
                },
                {
                  "value": "'Noto Serif SC', serif",
                  "text": "思源宋体"
                },
                {
                  "value": "'Microsoft YaHei', sans-serif",
                  "text": "微软雅黑"
                },
                {
                  "value": "'SimHei', sans-serif",
                  "text": "黑体"
                },
                {
                  "value": "'PingFang SC', sans-serif",
                  "text": "苹方"
                },
                {
                  "value": "monospace",
                  "text": "等宽字体"
                }
              ]
            }
          ]
        },
        {
          "label": "导入自定义字体",
          "controls": [
            {
              "kind": "button",
              "cls": "setting-btn appearance-import-font-btn",
              "text": "选择字体"
            }
          ],
          "desc": "支持 .ttf .otf .woff .woff2"
        }
      ]
    },
    "dimension": {
      "core": [
        {
          "label": "基础字号",
          "controls": [
            {
              "kind": "slider",
              "var": "fontSize",
              "min": "0.5",
              "max": "2.0",
              "step": "0.05",
              "value": "1.3"
            }
          ],
          "valSpan": {
            "var": "fontSize",
            "text": "1.30x"
          }
        },
        {
          "label": "情感词发光强度",
          "controls": [
            {
              "kind": "slider",
              "var": "emotionGlow",
              "min": "0",
              "max": "30",
              "step": "1",
              "value": "10"
            }
          ],
          "valSpan": {
            "var": "emotionGlow",
            "text": "10px"
          }
        },
        {
          "label": "高亮颜色",
          "controls": [
            {
              "kind": "color",
              "var": "highlightColor",
              "palette": "accent+white",
              "active": "#ffffff"
            }
          ],
          "desc": "控制非情感词普通高亮文字颜色"
        },
        {
          "label": "显示翻译",
          "controls": [
            {
              "kind": "toggle",
              "var": "showTranslation",
              "active": true
            }
          ]
        },
        {
          "label": "显示罗马音",
          "controls": [
            {
              "kind": "toggle",
              "var": "showRomaji",
              "active": true
            }
          ]
        },
        {
          "label": "背景颜色",
          "controls": [
            {
              "kind": "color",
              "var": "bgColor",
              "palette": "accent",
              "active": DEFAULT_ACCENT
            }
          ],
          "desc": "控制浮空粒子背景色调"
        }
      ],
      "advanced": [],
      "override": [
        {
          "label": "字体",
          "controls": [
            {
              "kind": "dropdown",
              "var": "fontFamily",
              "cls": "setting-dropdown appearance-font-dropdown",
              "triggerText": "",
              "options": [
                {
                  "value": "inherit",
                  "text": "系统默认",
                  "selected": true
                },
                {
                  "value": "'Noto Sans SC', sans-serif",
                  "text": "思源黑体"
                },
                {
                  "value": "'Noto Serif SC', serif",
                  "text": "思源宋体"
                },
                {
                  "value": "'Microsoft YaHei', sans-serif",
                  "text": "微软雅黑"
                },
                {
                  "value": "'SimHei', sans-serif",
                  "text": "黑体"
                },
                {
                  "value": "'PingFang SC', sans-serif",
                  "text": "苹方"
                },
                {
                  "value": "monospace",
                  "text": "等宽字体"
                }
              ]
            }
          ]
        },
        {
          "label": "导入自定义字体",
          "controls": [
            {
              "kind": "button",
              "cls": "setting-btn appearance-import-font-btn",
              "text": "选择字体"
            }
          ],
          "desc": "支持 .ttf .otf .woff .woff2"
        }
      ]
    },
    "letterpress": {
      "core": [
        {
          "label": "基础字号",
          "controls": [
            {
              "kind": "slider",
              "var": "fontSize",
              "min": "0.5",
              "max": "2.0",
              "step": "0.05",
              "value": "1.0"
            }
          ],
          "desc": "活字是大字形模式，1.0x 约为屏宽 6%",
          "valSpan": {
            "var": "fontSize",
            "text": "1.00x"
          }
        },
        {
          "label": "按压辉光",
          "controls": [
            {
              "kind": "slider",
              "var": "emotionGlow",
              "min": "0",
              "max": "30",
              "step": "1",
              "value": "12"
            }
          ],
          "desc": "钢印按下时墨晕的扩散强度",
          "valSpan": {
            "var": "emotionGlow",
            "text": "12px"
          }
        },
        {
          "label": "显示翻译",
          "controls": [
            {
              "kind": "toggle",
              "var": "showTranslation",
              "active": true
            }
          ]
        }
      ],
      "advanced": [],
      "override": [
        {
          "label": "字体",
          "controls": [
            {
              "kind": "dropdown",
              "var": "fontFamily",
              "cls": "setting-dropdown appearance-font-dropdown",
              "triggerText": "",
              "options": [
                {
                  "value": "inherit",
                  "text": "系统默认",
                  "selected": true
                },
                {
                  "value": "'Noto Sans SC', sans-serif",
                  "text": "思源黑体"
                },
                {
                  "value": "'Noto Serif SC', serif",
                  "text": "思源宋体"
                },
                {
                  "value": "'Microsoft YaHei', sans-serif",
                  "text": "微软雅黑"
                },
                {
                  "value": "'SimHei', sans-serif",
                  "text": "黑体"
                },
                {
                  "value": "'PingFang SC', sans-serif",
                  "text": "苹方"
                },
                {
                  "value": "monospace",
                  "text": "等宽字体"
                }
              ]
            }
          ]
        }
      ]
    },
    "jizura": {
      "core": [
        {
          "label": "风格",
          "controls": [
            {
              "kind": "dropdown",
              "var": "style",
              "cls": "setting-dropdown",
              "triggerText": "",
              "options": [
                {
                  "value": "ai",
                  "text": "AI 推荐",
                  "selected": true
                },
                {
                  "value": "auto",
                  "text": "自动匹配"
                },
                {
                  "value": "noir",
                  "text": "noir"
                },
                {
                  "value": "crimson",
                  "text": "crimson"
                },
                {
                  "value": "caution",
                  "text": "caution"
                },
                {
                  "value": "magenta",
                  "text": "magenta"
                },
                {
                  "value": "paper",
                  "text": "paper"
                },
                {
                  "value": "hud",
                  "text": "hud"
                },
                {
                  "value": "mint",
                  "text": "mint"
                },
                {
                  "value": "specimen",
                  "text": "specimen"
                },
                {
                  "value": "transit",
                  "text": "transit"
                },
                {
                  "value": "blueprint",
                  "text": "blueprint"
                },
                {
                  "value": "rouge",
                  "text": "rouge"
                },
                {
                  "value": "mono",
                  "text": "mono"
                },
                {
                  "value": "hrRuin",
                  "text": "hrRuin"
                },
                {
                  "value": "hrNightRec",
                  "text": "hrNightRec"
                },
                {
                  "value": "hrCurse",
                  "text": "hrCurse"
                },
                {
                  "value": "sakura",
                  "text": "sakura"
                },
                {
                  "value": "ocean",
                  "text": "ocean"
                },
                {
                  "value": "sunset",
                  "text": "sunset"
                },
                {
                  "value": "forest",
                  "text": "forest"
                },
                {
                  "value": "vapor",
                  "text": "vapor"
                },
                {
                  "value": "newsprint",
                  "text": "newsprint"
                },
                {
                  "value": "synth80",
                  "text": "synth80"
                },
                {
                  "value": "kraft",
                  "text": "kraft"
                },
                {
                  "value": "candy",
                  "text": "candy"
                },
                {
                  "value": "acid",
                  "text": "acid"
                },
                {
                  "value": "sumi",
                  "text": "sumi"
                },
                {
                  "value": "gold",
                  "text": "gold"
                }
              ]
            }
          ],
          "desc": "27 套版式语言；「AI 推荐」按 AI 分析结果选一套（需先分析；未分析时等同「自动匹配」）"
        },
        {
          "label": "情绪倾向",
          "controls": [
            {
              "kind": "dropdown",
              "var": "mood",
              "cls": "setting-dropdown",
              "triggerText": "",
              "options": [
                {
                  "value": "",
                  "text": "不限",
                  "selected": true
                },
                {
                  "value": "glitch",
                  "text": "glitch"
                },
                {
                  "value": "calm",
                  "text": "calm"
                },
                {
                  "value": "pop",
                  "text": "pop"
                },
                {
                  "value": "graphic",
                  "text": "graphic"
                },
                {
                  "value": "editorial",
                  "text": "editorial"
                },
                {
                  "value": "emotional",
                  "text": "emotional"
                },
                {
                  "value": "horror",
                  "text": "horror"
                },
                {
                  "value": "chaos",
                  "text": "chaos"
                }
              ]
            }
          ],
          "desc": "留「不限」时由「AI 推荐」按分析结果填，或由「自动匹配」抽签决定；手选则强制用它"
        },
        {
          "label": "性能档",
          "controls": [
            {
              "kind": "segment",
              "cls": "setting-btn-group",
              "buttons": [
                {
                  "text": "自动",
                  "var": "perf",
                  "val": "auto",
                  "active": true
                },
                {
                  "text": "省电",
                  "var": "perf",
                  "val": "eco"
                },
                {
                  "text": "高清",
                  "var": "perf",
                  "val": "hd"
                }
              ]
            }
          ],
          "desc": "按实测帧耗时动态调整清晰度；旧机器可选省电"
        },
        {
          "label": "动画节拍",
          "controls": [
            {
              "kind": "segment",
              "cls": "setting-btn-group",
              "buttons": [
                {
                  "text": "逐帧",
                  "var": "beat",
                  "val": "every",
                  "active": true
                },
                {
                  "text": "一拍两格",
                  "var": "beat",
                  "val": "onTwos"
                }
              ]
            }
          ],
          "desc": "逐帧最流畅；「一拍两格」为引擎原生的卡帧感（每秒 12 张）"
        },
        {
          "label": "按字切分镜",
          "controls": [
            {
              "kind": "segment",
              "cls": "setting-btn-group",
              "buttons": [
                {
                  "text": "关",
                  "var": "wordSync",
                  "val": "off",
                  "active": true
                },
                {
                  "text": "开",
                  "var": "wordSync",
                  "val": "cuts"
                }
              ]
            }
          ],
          "desc": "按真实逐字时间把一行拆成多个分镜；引擎里一段即一个画面，拆得太多会显得碎（需要逐字歌词）"
        },
        {
          "label": "导入日文字体",
          "controls": [
            {
              "kind": "button",
              "cls": "setting-btn jizura-font-pack-btn",
              "text": "选择字体文件"
            }
          ],
          "desc": "导入日文字体（支持 .ttf/.otf/.woff/.woff2，可多选）；本模式按原始字体排版，导入的字体也可用于其它模式"
        },
        {
          "label": "显示翻译",
          "controls": [
            {
              "kind": "toggle",
              "var": "showTranslation",
              "active": true
            }
          ]
        },
        {
          "label": "情感词发光强度",
          "controls": [
            {
              "kind": "slider",
              "var": "emotionGlow",
              "min": "0",
              "max": "30",
              "step": "1",
              "value": "10"
            }
          ],
          "valSpan": {
            "var": "emotionGlow",
            "text": "10px"
          }
        }
      ],
      "advanced": [
        {
          "label": "追加部件",
          "controls": [
            {
              "kind": "toggle",
              "var": "extra",
              "active": true
            }
          ],
          "desc": "抽签范围含首版之后新增的部件与 12 套风格（候选池约 1.8 倍）；关掉只用首版部件集，转场这类容易看出重复的部件会明显变少"
        },
        {
          "label": "动感",
          "controls": [
            {
              "kind": "slider",
              "var": "motion",
              "min": "0",
              "max": "1",
              "step": "0.05",
              "value": "0.7"
            }
          ],
          "desc": "镜头与元素的运动幅度",
          "valSpan": {
            "var": "motion",
            "text": "0.70"
          }
        },
        {
          "label": "故障闪烁",
          "controls": [
            {
              "kind": "slider",
              "var": "glitch",
              "min": "0",
              "max": "1",
              "step": "0.05",
              "value": "0.55"
            }
          ],
          "valSpan": {
            "var": "glitch",
            "text": "0.55"
          }
        },
        {
          "label": "色散",
          "controls": [
            {
              "kind": "slider",
              "var": "chroma",
              "min": "0",
              "max": "1",
              "step": "0.05",
              "value": "0.7"
            }
          ],
          "valSpan": {
            "var": "chroma",
            "text": "0.70"
          }
        },
        {
          "label": "装饰",
          "controls": [
            {
              "kind": "slider",
              "var": "decor",
              "min": "0",
              "max": "1",
              "step": "0.05",
              "value": "0.5"
            }
          ],
          "valSpan": {
            "var": "decor",
            "text": "0.50"
          }
        },
        {
          "label": "密度",
          "controls": [
            {
              "kind": "slider",
              "var": "density",
              "min": "0",
              "max": "1",
              "step": "0.05",
              "value": "0.55"
            }
          ],
          "desc": "影响一行切成几个分镜",
          "valSpan": {
            "var": "density",
            "text": "0.55"
          }
        },
        {
          "label": "颗粒质感",
          "controls": [
            {
              "kind": "slider",
              "var": "texture",
              "min": "0",
              "max": "1",
              "step": "0.05",
              "value": "0.6"
            }
          ],
          "valSpan": {
            "var": "texture",
            "text": "0.60"
          }
        },
        {
          "label": "闪光",
          "controls": [
            {
              "kind": "toggle",
              "var": "flash",
              "active": true
            }
          ]
        },
        {
          "label": "HUD",
          "controls": [
            {
              "kind": "dropdown",
              "var": "hud",
              "cls": "setting-dropdown",
              "triggerText": "",
              "options": [
                {
                  "value": "auto",
                  "text": "自动",
                  "selected": true
                },
                {
                  "value": "on",
                  "text": "显示"
                },
                {
                  "value": "off",
                  "text": "隐藏"
                }
              ]
            }
          ],
          "desc": "画面里的角标与刻度"
        },
        {
          "label": "帧率",
          "controls": [
            {
              "kind": "dropdown",
              "var": "fps",
              "cls": "setting-dropdown",
              "triggerText": "",
              "options": [
                {
                  "value": "24",
                  "text": "24 fps",
                  "selected": true
                },
                {
                  "value": "12",
                  "text": "12 fps"
                },
                {
                  "value": "30",
                  "text": "30 fps"
                },
                {
                  "value": "60",
                  "text": "60 fps"
                }
              ]
            }
          ],
          "desc": "画面输出帧率：12 最省电、24 默认、30/60 更顺滑但更吃性能；「动画节拍」选「一拍两格」时固定按 24（步长由 koma 决定）"
        }
      ],
      "override": [
        {
          "label": "字体",
          "controls": [
            {
              "kind": "dropdown",
              "var": "fontFamily",
              "cls": "setting-dropdown appearance-font-dropdown",
              "triggerText": "",
              "options": [
                {
                  "value": "inherit",
                  "text": "系统默认",
                  "selected": true
                },
                {
                  "value": "'Noto Sans SC', sans-serif",
                  "text": "思源黑体"
                },
                {
                  "value": "'Noto Serif SC', serif",
                  "text": "思源宋体"
                },
                {
                  "value": "'Microsoft YaHei', sans-serif",
                  "text": "微软雅黑"
                },
                {
                  "value": "'SimHei', sans-serif",
                  "text": "黑体"
                },
                {
                  "value": "'PingFang SC', sans-serif",
                  "text": "苹方"
                },
                {
                  "value": "monospace",
                  "text": "等宽字体"
                }
              ]
            }
          ]
        },
        {
          "label": "导入自定义字体",
          "controls": [
            {
              "kind": "button",
              "cls": "setting-btn appearance-import-font-btn",
              "text": "选择字体"
            }
          ],
          "desc": "支持 .ttf .otf .woff .woff2"
        }
      ]
    },
    "astrolabe": {
      "core": [
        {
          "label": "版画纸墨色板",
          "controls": [
            {
              "kind": "dropdown",
              "var": "astrolabePreset",
              "cls": "setting-dropdown",
              "triggerText": "",
              "options": [
                {
                  "value": "auto",
                  "text": "跟随封面",
                  "selected": true
                },
                {
                  "value": "obsidian",
                  "text": "曜石羊皮"
                },
                {
                  "value": "prussian",
                  "text": "普鲁士版画"
                },
                {
                  "value": "bauhaus",
                  "text": "包豪斯构成"
                },
                {
                  "value": "vermilion",
                  "text": "朱砂金泥"
                },
                {
                  "value": "celadon",
                  "text": "青瓷松烟"
                },
                {
                  "value": "ochre",
                  "text": "赭石手稿"
                }
              ]
            }
          ]
        },
        {
          "label": "分镜节奏",
          "controls": [
            {
              "kind": "dropdown",
              "var": "astrolabeCutRate",
              "cls": "setting-dropdown",
              "triggerText": "",
              "options": [
                {
                  "value": "phrase",
                  "text": "短语分镜",
                  "selected": true
                },
                {
                  "value": "line",
                  "text": "整句一镜"
                },
                {
                  "value": "fast",
                  "text": "高频快切"
                }
              ]
            }
          ]
        },
        {
          "label": "情感词发光强度",
          "controls": [
            {
              "kind": "slider",
              "var": "emotionGlow",
              "min": "0",
              "max": "30",
              "step": "1",
              "value": "10"
            }
          ],
          "valSpan": {
            "var": "emotionGlow",
            "text": "10px"
          }
        },
        {
          "label": "高亮颜色",
          "controls": [
            {
              "kind": "color",
              "var": "highlightColor",
              "palette": "accent+white",
              "active": "#f5efe4"
            }
          ]
        },
        {
          "label": "字号",
          "controls": [
            {
              "kind": "slider",
              "var": "fontSize",
              "min": "0.7",
              "max": "1.6",
              "step": "0.05",
              "value": "1.0"
            }
          ],
          "valSpan": {
            "var": "fontSize",
            "text": "1.00x"
          }
        },
        {
          "label": "显示翻译",
          "controls": [
            {
              "kind": "toggle",
              "var": "showTranslation",
              "active": true
            }
          ]
        },
        {
          "label": "显示罗马音",
          "controls": [
            {
              "kind": "toggle",
              "var": "showRomaji",
              "active": true
            }
          ]
        }
      ],
      "advanced": [
        {
          "label": "正负形反色块",
          "controls": [
            {
              "kind": "toggle",
              "var": "astrolabeInversion",
              "active": true
            }
          ]
        },
        {
          "label": "版画排线密度",
          "controls": [
            {
              "kind": "slider",
              "var": "astrolabeHatch",
              "min": "0",
              "max": "1",
              "step": "0.05",
              "value": "0.75"
            }
          ],
          "valSpan": {
            "var": "astrolabeHatch",
            "text": "0.75"
          }
        },
        {
          "label": "色块对比张力",
          "controls": [
            {
              "kind": "slider",
              "var": "astrolabeContrast",
              "min": "0",
              "max": "1",
              "step": "0.05",
              "value": "0.80"
            }
          ],
          "valSpan": {
            "var": "astrolabeContrast",
            "text": "0.80"
          }
        },
        {
          "label": "镜头运镜幅度",
          "controls": [
            {
              "kind": "slider",
              "var": "astrolabeCamera",
              "min": "0",
              "max": "1.5",
              "step": "0.05",
              "value": "0.85"
            }
          ],
          "valSpan": {
            "var": "astrolabeCamera",
            "text": "0.85"
          }
        },
        {
          "label": "印刷裁切角标",
          "controls": [
            {
              "kind": "toggle",
              "var": "astrolabeCropMarks",
              "active": true
            }
          ]
        }
      ],
      "override": [
        {
          "label": "字体",
          "controls": [
            {
              "kind": "dropdown",
              "var": "fontFamily",
              "cls": "setting-dropdown appearance-font-dropdown",
              "triggerText": "",
              "options": [
                {
                  "value": "default",
                  "text": "跟随字体设置",
                  "selected": true
                },
                {
                  "value": "serif",
                  "text": "宋体"
                },
                {
                  "value": "kai",
                  "text": "楷体"
                },
                {
                  "value": "hei",
                  "text": "黑体"
                },
                {
                  "value": "fangsong",
                  "text": "仿宋"
                },
                {
                  "value": "mono",
                  "text": "等宽字体"
                }
              ]
            }
          ]
        }
      ]
    },
    "prism": {
      "core": [
        {
          "label": "晶体色温",
          "controls": [
            {
              "kind": "dropdown",
              "var": "prismPreset",
              "cls": "setting-dropdown",
              "triggerText": "",
              "options": [
                {
                  "value": "auto",
                  "text": "跟随封面",
                  "selected": true
                },
                {
                  "value": "diamond",
                  "text": "冰钻"
                },
                {
                  "value": "amber",
                  "text": "琥珀"
                },
                {
                  "value": "obsidian",
                  "text": "黑曜"
                },
                {
                  "value": "aurora",
                  "text": "极光"
                }
              ]
            }
          ]
        },
        {
          "label": "分镜节奏",
          "controls": [
            {
              "kind": "dropdown",
              "var": "prismCutRate",
              "cls": "setting-dropdown",
              "triggerText": "",
              "options": [
                {
                  "value": "phrase",
                  "text": "短语分镜",
                  "selected": true
                },
                {
                  "value": "line",
                  "text": "整句一镜"
                },
                {
                  "value": "fast",
                  "text": "高频快切"
                }
              ]
            }
          ]
        },
        {
          "label": "情感词发光强度",
          "controls": [
            {
              "kind": "slider",
              "var": "emotionGlow",
              "min": "0",
              "max": "30",
              "step": "1",
              "value": "10"
            }
          ],
          "valSpan": {
            "var": "emotionGlow",
            "text": "10px"
          }
        },
        {
          "label": "高亮颜色",
          "controls": [
            {
              "kind": "color",
              "var": "highlightColor",
              "palette": "accent+white",
              "active": "#7ce8ff"
            }
          ]
        },
        {
          "label": "字号",
          "controls": [
            {
              "kind": "slider",
              "var": "fontSize",
              "min": "0.7",
              "max": "1.6",
              "step": "0.05",
              "value": "1.0"
            }
          ],
          "valSpan": {
            "var": "fontSize",
            "text": "1.00x"
          }
        },
        {
          "label": "显示翻译",
          "controls": [
            {
              "kind": "toggle",
              "var": "showTranslation",
              "active": true
            }
          ]
        },
        {
          "label": "显示罗马音",
          "controls": [
            {
              "kind": "toggle",
              "var": "showRomaji",
              "active": true
            }
          ]
        }
      ],
      "advanced": [
        {
          "label": "切面折射强度",
          "controls": [
            {
              "kind": "slider",
              "var": "prismRefraction",
              "min": "0",
              "max": "1",
              "step": "0.05",
              "value": "0.75"
            }
          ],
          "valSpan": {
            "var": "prismRefraction",
            "text": "0.75"
          }
        },
        {
          "label": "光谱色散强度",
          "controls": [
            {
              "kind": "slider",
              "var": "prismDispersion",
              "min": "0",
              "max": "1",
              "step": "0.05",
              "value": "0.68"
            }
          ],
          "valSpan": {
            "var": "prismDispersion",
            "text": "0.68"
          }
        },
        {
          "label": "焦散光束强度",
          "controls": [
            {
              "kind": "slider",
              "var": "prismCaustics",
              "min": "0",
              "max": "1",
              "step": "0.05",
              "value": "0.72"
            }
          ],
          "valSpan": {
            "var": "prismCaustics",
            "text": "0.72"
          }
        },
        {
          "label": "镜头运镜幅度",
          "controls": [
            {
              "kind": "slider",
              "var": "prismCamera",
              "min": "0",
              "max": "1.5",
              "step": "0.05",
              "value": "0.85"
            }
          ],
          "valSpan": {
            "var": "prismCamera",
            "text": "0.85"
          }
        },
        {
          "label": "光学刻度角标",
          "controls": [
            {
              "kind": "toggle",
              "var": "prismHud",
              "active": true
            }
          ]
        }
      ],
      "override": [
        {
          "label": "字体",
          "controls": [
            {
              "kind": "dropdown",
              "var": "fontFamily",
              "cls": "setting-dropdown appearance-font-dropdown",
              "triggerText": "",
              "options": [
                {
                  "value": "default",
                  "text": "跟随字体设置",
                  "selected": true
                },
                {
                  "value": "serif",
                  "text": "宋体"
                },
                {
                  "value": "kai",
                  "text": "楷体"
                },
                {
                  "value": "hei",
                  "text": "黑体"
                },
                {
                  "value": "fangsong",
                  "text": "仿宋"
                },
                {
                  "value": "mono",
                  "text": "等宽字体"
                }
              ]
            }
          ]
        }
      ]
    },
    "vitrail": {
      "core": [
        {
          "label": "光影材质色板",
          "controls": [
            {
              "kind": "dropdown",
              "var": "vitrailPreset",
              "cls": "setting-dropdown",
              "triggerText": "",
              "options": [
                {
                  "value": "auto",
                  "text": "随歌曲智能匹配",
                  "selected": true
                },
                {
                  "value": "amber",
                  "text": "琥珀圣殿"
                },
                {
                  "value": "sapphire",
                  "text": "群青圣堂"
                },
                {
                  "value": "jade",
                  "text": "青石水院"
                },
                {
                  "value": "crimson",
                  "text": "朱砂穹殿"
                },
                {
                  "value": "moonlight",
                  "text": "银月浑仪"
                },
                {
                  "value": "alabaster",
                  "text": "白石日影"
                }
              ]
            }
          ],
          "desc": "选「随歌曲智能匹配」时依据封面色板、歌词情绪与语种自动定调"
        },
        {
          "label": "建筑空间原型",
          "controls": [
            {
              "kind": "dropdown",
              "var": "vitrailArchitecture",
              "cls": "setting-dropdown",
              "triggerText": "",
              "options": [
                {
                  "value": "auto",
                  "text": "随歌曲智能匹配",
                  "selected": true
                },
                {
                  "value": "cathedral",
                  "text": "尖拱大殿"
                },
                {
                  "value": "observatory",
                  "text": "浑天穹顶"
                },
                {
                  "value": "cloister",
                  "text": "静谧回廊"
                },
                {
                  "value": "pavilion",
                  "text": "水镜亭台"
                },
                {
                  "value": "rotunda",
                  "text": "星穹万神坛"
                },
                {
                  "value": "arcade",
                  "text": "水上拱廊"
                },
                {
                  "value": "scriptorium",
                  "text": "秘阁穹廊"
                },
                {
                  "value": "atrium",
                  "text": "曦光晶庭"
                }
              ]
            }
          ],
          "desc": "包含尖拱大殿、浑天穹顶、静谧回廊、水镜亭台、星穹万神坛、水上拱廊、秘阁穹廊与曦光晶庭；选「随歌曲智能匹配」将随全曲乐章无缝巡游切换"
        },
        {
          "label": "渲染画质档",
          "controls": [
            {
              "kind": "segment",
              "cls": "setting-btn-group",
              "buttons": [
                {
                  "text": "自动",
                  "var": "vitrailQuality",
                  "val": "auto",
                  "active": true
                },
                {
                  "text": "高清",
                  "var": "vitrailQuality",
                  "val": "high"
                },
                {
                  "text": "平衡省电",
                  "var": "vitrailQuality",
                  "val": "balanced"
                },
                {
                  "text": "轻量流畅",
                  "var": "vitrailQuality",
                  "val": "lite"
                }
              ]
            }
          ],
          "desc": "「自动」启用自适应分辨率看门狗；低配设备可选平衡或轻量模式"
        },
        {
          "label": "基础字号",
          "controls": [
            {
              "kind": "slider",
              "var": "fontSize",
              "min": "0.6",
              "max": "1.8",
              "step": "0.05",
              "value": "1.0"
            }
          ],
          "valSpan": {
            "var": "fontSize",
            "text": "1.00x"
          }
        },
        {
          "label": "情感词发光强度",
          "controls": [
            {
              "kind": "slider",
              "var": "emotionGlow",
              "min": "0",
              "max": "30",
              "step": "1",
              "value": "10"
            }
          ],
          "valSpan": {
            "var": "emotionGlow",
            "text": "10px"
          }
        },
        {
          "label": "高亮颜色",
          "controls": [
            {
              "kind": "color",
              "var": "highlightColor",
              "palette": "accent+white",
              "active": "#f3d58b"
            }
          ],
          "desc": "控制非情感词逐字扫光高亮颜色（AI 情感词优先保留情绪着色）"
        },
        {
          "label": "显示翻译",
          "controls": [
            {
              "kind": "toggle",
              "var": "showTranslation",
              "active": true
            }
          ]
        },
        {
          "label": "显示罗马音",
          "controls": [
            {
              "kind": "toggle",
              "var": "showRomaji",
              "active": true
            }
          ]
        }
      ],
      "advanced": [
        {
          "label": "运镜幅度",
          "controls": [
            {
              "kind": "slider",
              "var": "vitrailCamera",
              "min": "0",
              "max": "1.5",
              "step": "0.05",
              "value": "0.85"
            }
          ],
          "valSpan": {
            "var": "vitrailCamera",
            "text": "0.85x"
          }
        },
        {
          "label": "圣光束与泛光",
          "controls": [
            {
              "kind": "slider",
              "var": "vitrailLighting",
              "min": "0",
              "max": "1.5",
              "step": "0.05",
              "value": "0.9"
            }
          ],
          "valSpan": {
            "var": "vitrailLighting",
            "text": "0.90x"
          }
        },
        {
          "label": "地面水镜倒影",
          "controls": [
            {
              "kind": "toggle",
              "var": "vitrailReflection",
              "active": true
            }
          ]
        },
        {
          "label": "圣光浮尘微粒",
          "controls": [
            {
              "kind": "toggle",
              "var": "vitrailParticles",
              "active": true
            }
          ]
        },
        {
          "label": "指针 3D 视差",
          "controls": [
            {
              "kind": "toggle",
              "var": "vitrailParallax",
              "active": true
            }
          ]
        }
      ],
      "override": [
        {
          "label": "字体",
          "controls": [
            {
              "kind": "dropdown",
              "var": "fontFamily",
              "cls": "setting-dropdown appearance-font-dropdown",
              "triggerText": "",
              "options": [
                {
                  "value": "default",
                  "text": "跟随字体设置",
                  "selected": true
                },
                {
                  "value": "hei",
                  "text": "思源黑体 / 黑体"
                },
                {
                  "value": "serif",
                  "text": "思源宋体 / 衬线"
                },
                {
                  "value": "kai",
                  "text": "楷体"
                },
                {
                  "value": "fangsong",
                  "text": "仿宋"
                },
                {
                  "value": "mono",
                  "text": "等宽字体"
                }
              ]
            }
          ]
        },
        {
          "label": "导入自定义字体",
          "controls": [
            {
              "kind": "button",
              "cls": "setting-btn appearance-import-font-btn",
              "text": "选择字体"
            }
          ],
          "desc": "支持 .ttf .otf .woff .woff2"
        }
      ]
    },
    "focalcut": {
      "core": [
        {
          "label": "展墙极性模式",
          "controls": [
            {
              "kind": "segment",
              "cls": "setting-btn-group",
              "buttons": [
                { "text": "自动翻转", "var": "focalcutPolarity", "val": "auto", "active": true },
                { "text": "曜石黑墙", "var": "focalcutPolarity", "val": "dark" },
                { "text": "暖白画廊", "var": "focalcutPolarity", "val": "light" }
              ]
            }
          ],
          "desc": "自动模式下主歌为深曜石墙、副歌快门翻转为美术馆暖白墙"
        },
        {
          "label": "闪切节奏密度",
          "controls": [
            {
              "kind": "segment",
              "cls": "setting-btn-group",
              "buttons": [
                { "text": "舒缓", "var": "focalcutCutRate", "val": "calm" },
                { "text": "标准", "var": "focalcutCutRate", "val": "normal", "active": true },
                { "text": "高频", "var": "focalcutCutRate", "val": "intense" }
              ]
            }
          ]
        },
        {
          "label": "基础字号",
          "controls": [
            { "kind": "slider", "var": "fontSize", "min": "0.6", "max": "1.8", "step": "0.05", "value": "1.0" }
          ],
          "valSpan": { "var": "fontSize", "text": "1.00x" }
        },
        {
          "label": "同步双视口分屏",
          "controls": [
            { "kind": "toggle", "var": "focalcutSplitLens", "active": true }
          ],
          "desc": "高潮或情感词触发全景 × 微距同框分屏"
        },
        {
          "label": "显示翻译",
          "controls": [
            { "kind": "toggle", "var": "showTranslation", "active": true }
          ]
        },
        {
          "label": "显示音译/罗马音",
          "controls": [
            { "kind": "toggle", "var": "showRomaji", "active": true }
          ]
        }
      ],
      "advanced": [
        {
          "label": "2.5D 机位景别张力",
          "controls": [
            { "kind": "slider", "var": "focalcutCamera", "min": "0.2", "max": "1.4", "step": "0.05", "value": "0.9" }
          ],
          "valSpan": { "var": "focalcutCamera", "text": "0.90x" }
        },
        {
          "label": "建筑定位标尺线",
          "controls": [
            { "kind": "toggle", "var": "focalcutGuides", "active": true }
          ]
        },
        {
          "label": "切镜光学对焦呼吸",
          "controls": [
            { "kind": "toggle", "var": "focalcutRackFocus", "active": true }
          ]
        }
      ],
      "override": [
        {
          "label": "字体",
          "controls": [
            {
              "kind": "dropdown",
              "var": "fontFamily",
              "cls": "setting-dropdown appearance-font-dropdown",
              "triggerText": "",
              "options": [
                { "value": "default", "text": "跟随字体设置", "selected": true },
                { "value": "hei", "text": "思源黑体 / 黑体" },
                { "value": "serif", "text": "思源宋体 / 衬线" },
                { "value": "kai", "text": "楷体" },
                { "value": "fangsong", "text": "仿宋" },
                { "value": "mono", "text": "等宽字体" }
              ]
            }
          ]
        }
      ]
    },
    "tempera": {
      "core": [
        {
          "label": "歌词字号",
          "controls": [
            {
              "kind": "slider",
              "var": "fontSize",
              "min": "0.6",
              "max": "3.0",
              "step": "0.05",
              "value": "1.0"
            }
          ],
          "desc": "版画文字基准大小的倍率",
          "valSpan": {
            "var": "fontSize",
            "text": "1.00x"
          }
        },
        {
          "label": "运镜强度",
          "controls": [
            {
              "kind": "slider",
              "var": "cameraIntensity",
              "min": "0",
              "max": "2",
              "step": "0.1",
              "value": "1"
            }
          ],
          "valSpan": {
            "var": "cameraIntensity",
            "text": "1.0x"
          }
        },
        {
          "label": "字形动效",
          "controls": [
            {
              "kind": "slider",
              "var": "glyphMotion",
              "min": "0",
              "max": "2",
              "step": "0.1",
              "value": "1"
            }
          ],
          "valSpan": {
            "var": "glyphMotion",
            "text": "1.0x"
          }
        },
        {
          "label": "情感词发光强度",
          "controls": [
            {
              "kind": "slider",
              "var": "emotionGlow",
              "min": "0",
              "max": "30",
              "step": "1",
              "value": "10"
            }
          ],
          "valSpan": {
            "var": "emotionGlow",
            "text": "10px"
          }
        },
        {
          "label": "高亮颜色",
          "controls": [
            {
              "kind": "color",
              "var": "highlightColor",
              "palette": "accent+white",
              "active": DEFAULT_ACCENT
            }
          ]
        }
      ],
      "advanced": [
        {
          "label": "文字反色块",
          "controls": [
            {
              "kind": "toggle",
              "var": "textInversion",
              "active": true
            }
          ]
        },
        {
          "label": "显示构图块",
          "controls": [
            {
              "kind": "toggle",
              "var": "showBlocks",
              "active": true
            }
          ]
        },
        {
          "label": "显示装饰元素",
          "controls": [
            {
              "kind": "toggle",
              "var": "showDecor",
              "active": true
            }
          ]
        },
        {
          "label": "显示角标",
          "controls": [
            {
              "kind": "toggle",
              "var": "showCornerMarks",
              "active": true
            }
          ]
        },
        {
          "label": "镜头转场",
          "controls": [
            {
              "kind": "toggle",
              "var": "enableTransitions",
              "active": true
            }
          ]
        }
      ],
      "override": [
        {
          "label": "字体",
          "controls": [
            {
              "kind": "dropdown",
              "var": "fontFamily",
              "cls": "setting-dropdown appearance-font-dropdown",
              "triggerText": "",
              "options": [
                {
                  "value": "inherit",
                  "text": "系统默认",
                  "selected": true
                },
                {
                  "value": "'Noto Sans SC', sans-serif",
                  "text": "思源黑体"
                },
                {
                  "value": "'Noto Serif SC', serif",
                  "text": "思源宋体"
                },
                {
                  "value": "'Microsoft YaHei', sans-serif",
                  "text": "微软雅黑"
                },
                {
                  "value": "'SimHei', sans-serif",
                  "text": "黑体"
                },
                {
                  "value": "'PingFang SC', sans-serif",
                  "text": "苹方"
                },
                {
                  "value": "monospace",
                  "text": "等宽字体"
                }
              ]
            }
          ]
        },
        {
          "label": "导入自定义字体",
          "controls": [
            {
              "kind": "button",
              "cls": "setting-btn appearance-import-font-btn",
              "text": "选择字体"
            }
          ],
          "desc": "支持 .ttf .otf .woff .woff2"
        }
      ]
    }
  }
};

export const APPEARANCE_FAMILIES = _DATA.FAMILIES;
export const APPEARANCE_MODES = _DATA.MODES_META;
export const APPEARANCE_MODE_MAP = Object.freeze(
    Object.fromEntries(APPEARANCE_MODES.map(m => [m.id, m]))
);
export const APPEARANCE_TIER_META = _DATA.TIER_META;
export const APPEARANCE_SECTIONS = _DATA.modesData;

/**
 * 收集某个模式 Schema 中全部声明的 data-var 字段名（含 button-group 子项与 align）。
 * @param {string} mode
 * @returns {string[]}
 */
export function collectSchemaModeVars(mode) {
    const sec = /** @type {Record<string, any>} */ (APPEARANCE_SECTIONS)[mode];
    if (!sec) return [];
    const vars = new Set();
    for (const tier of ['core', 'advanced', 'override']) {
        for (const row of (sec[tier] || [])) {
            for (const c of (row.controls || [])) {
                if (c.var) vars.add(c.var);
                if (Array.isArray(c.buttons)) {
                    for (const b of c.buttons) {
                        if (b.var) vars.add(b.var);
                        if (b.align !== undefined) vars.add('align');
                    }
                }
            }
        }
    }
    return Array.from(vars);
}
