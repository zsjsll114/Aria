# AI Coding Prompt：AI Lyrics PV Mode Upgrade

## Role

你是一名资深前端架构工程师和 Creative Coding 工程师。

你的任务不是重写播放器，而是在现有歌词播放器项目中新增一个独立的 **PV
Mode（歌词视觉PV模式）**。

目标：

将普通歌词播放器升级为：

> AI驱动的实时歌词PV生成系统（AI Lyric PV Engine）

参考日本 J-POP / Vocaloid / Anime MV 的动态歌词视觉语言。

------------------------------------------------------------------------

# 项目现状

当前项目已有：

-   音乐播放
-   歌词同步
-   时间轴系统
-   单词级高亮
-   歌词滚动
-   主题系统
-   动态背景
-   毛玻璃 UI
-   AI主题动画

不要破坏已有功能。

最终应该支持：

    Normal Mode

    +

    PV Mode

PV Mode 是新增 Renderer / Theme，而不是替换原播放器。

------------------------------------------------------------------------

# 开发原则

## 不要一次重写

必须按照：

1.  分析现有代码
2.  找到歌词渲染模块
3.  找到主题系统
4.  找到动画系统
5.  设计扩展接口
6.  增量实现 PV Mode

禁止：

-   删除已有播放器逻辑
-   重构全部代码
-   创建独立无法接入的 Demo

------------------------------------------------------------------------

# 核心理念

普通播放器：

    歌词
    ↓
    显示文字

PV Mode：

    歌词

    ↓

    AI语义理解

    ↓

    视觉设计数据

    ↓

    PV Scene

    ↓

    实时渲染

    ↓

    音乐MV效果

歌词不是字幕。

歌词是视觉对象。

------------------------------------------------------------------------

# AI Lyrics Visual Director

使用 Gemini API 分析歌词。

输入：

-   歌词文本
-   时间轴信息

输出：

Visual JSON。

Gemini负责：

-   语义分词
-   情绪分析
-   关键词识别
-   重要程度判断
-   视觉风格设计
-   动画方式设计
-   场景设计

不要让 Gemini 输出代码。

只输出视觉描述数据。

------------------------------------------------------------------------

# Visual JSON设计

每个歌词对象：

``` json
{
"text":"忘れない",

"importance":0.95,

"emotion":"nostalgia",

"visual":{
    "role":"main",

    "size":2.5,

    "color":"purple",

    "glow":"soft",

    "outline":true,

    "animation":{
        "enter":"slow_fade",
        "motion":"float",
        "exit":"blur_fade"
    }
}
}
```

Renderer负责执行。

------------------------------------------------------------------------

# PV Engine架构

新增：

    PVEngine

    ├── LyricVisualAnalyzer
    │
    ├── SceneManager
    │
    ├── TextRenderer
    │
    ├── CameraController
    │
    ├── ParticleSystem
    │
    ├── HUDRenderer
    │
    ├── BackgroundRenderer
    │
    └── AudioReactive

------------------------------------------------------------------------

# Scene系统

歌词不再滚动。

每一句歌词 = 一个 Scene。

生命周期：

    create

    ↓

    animate in

    ↓

    camera movement

    ↓

    hold

    ↓

    fade out

    ↓

    destroy

下一句歌词出现时：

清空当前场景。

------------------------------------------------------------------------

# 文字系统要求

## 不同词不同视觉身份

根据AI输出：

实现：

-   不同大小
-   不同颜色
-   不同阴影
-   不同发光
-   不同透明度

例如：

主词：

    large
    bright
    glow
    foreground

辅助词：

    small
    low opacity
    background

------------------------------------------------------------------------

# 背景巨大轮廓文字

支持：

背景层文字。

特点：

-   outline only
-   大比例缩放
-   低透明度
-   作为空间装饰

示例：

    Foreground:

    忘れない


    Background:

    忘れない

    scale 5

    opacity 0.1

    outline

------------------------------------------------------------------------

# HUD虚线矩形系统

不要使用CSS border。

使用：

SVG Path。

效果：

-   虚线
-   点状线段
-   四角断开
-   90度向外延伸角
-   从一个角开始逐渐绘制

实现：

    stroke-dasharray

    stroke-dashoffset

    path animation

------------------------------------------------------------------------

# Camera系统

必须使用真正Camera。

不要简单scale文字。

需要：

-   缓慢推进
-   横向移动
-   微旋转
-   阻尼移动

类似：

电影摄影机。

参数：

低阻尼。

产生空间感。

------------------------------------------------------------------------

# Parallax视差

不同Z层：

    Z=-500

    背景文字


    Z=-200

    几何装饰


    Z=0

    歌词


    Z=100

    重点词

移动速度不同。

形成3D空间。

------------------------------------------------------------------------

# 背景系统

包含：

## Particle

支持：

-   粒子
-   光点
-   轨迹
-   连线

## Geometry

支持：

简单：

-   圆
-   矩形
-   线

复杂：

-   SVG矢量图形

模式：

-   fill
-   outline
-   glow

------------------------------------------------------------------------

# 技术建议

优先：

    Three.js

    +

    GSAP

    +

    Web Audio API

    +

    SVG

    +

    GLSL Shader

------------------------------------------------------------------------

# Gemini调用策略

不要实时调用。

流程：

    第一次加载歌曲

    ↓

    检查visual.json

    ↓

    不存在

    ↓

    调用Gemini

    ↓

    生成视觉配置

    ↓

    缓存

    ↓

    播放

以后：

直接读取。

------------------------------------------------------------------------

# 文件结构建议

    src/

    pv/

     ├── PVEngine.js
     ├── SceneManager.js
     ├── CameraController.js
     ├── ParticleSystem.js
     ├── HUDRenderer.js


    ai/

     ├── GeminiAnalyzer.js
     ├── VisualSchema.js


    data/

     ├── lyrics.lrc
     └── lyrics.visual.json

------------------------------------------------------------------------

# 开发阶段

## Phase 1

分析现有代码。

输出：

-   当前架构
-   可复用模块
-   修改方案

## Phase 2

实现PV Mode基础：

-   PV Renderer
-   Scene Manager
-   Visual JSON读取

## Phase 3

实现：

-   AI歌词分析
-   Gemini API接口
-   JSON缓存

## Phase 4

实现视觉：

-   动态文字
-   HUD框
-   背景文字
-   Camera

## Phase 5

高级效果：

-   Particle
-   Shader
-   Audio Reactive

------------------------------------------------------------------------

# 最终目标

不要做：

"带动画的歌词播放器"

而是：

"AI辅助生成日本音乐PV级歌词视觉系统"。

关键词：

-   kinetic typography
-   semantic lyric visualization
-   AI lyric analysis
-   cinematic camera
-   3D typography
-   PV scene generation
