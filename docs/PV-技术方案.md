# 程序化生成文字 PV 技术方案

> 目标：用纯程序化方式（无图像素材）生成类似《妄想感傷代償連盟》风格的文字 PV，重点是**连续、运镜连贯、预设种类丰富、节奏驱动、AI 联网分析**。

---

## 目录

1. [设计理念](#1-设计理念)
2. [架构总览](#2-架构总览)
3. [连续性的三个技术支柱](#3-连续性的三个技术支柱)
4. [统一解析层](#4-统一解析层)
5. [多语言分词层](#5-多语言分词层)
6. [分句分镜层](#6-分句分镜层)
7. [歌词↔样式匹配策略](#7-歌词样式匹配策略)
8. [参数化生成器（无限变体）](#8-参数化生成器无限变体)
9. [节奏驱动与速度自适应](#9-节奏驱动与速度自适应)
10. [逐字动画系统](#10-逐字动画系统)
11. [几何蒙版与剪切转场](#11-几何蒙版与剪切转场)
12. [3D 透视效果](#12-3d-透视效果)
13. [完整视觉元素库](#13-完整视觉元素库)
14. [运镜系统](#14-运镜系统)
15. [AI 联网搜索方案](#15-ai-联网搜索方案)
16. [用户确认与动态生成流程](#16-用户确认与动态生成流程)
17. [渲染管线](#17-渲染管线)
18. [三级连贯层级（Shot→Group→Section）](#18-三级连贯层级shotgroupsection)
19. [3D 深度堆叠与背景化](#19-3d-深度堆叠与背景化)
20. [落地里程碑](#20-落地里程碑)

---

## 1. 设计理念

### 1.1 核心转变：从"UI 排布"到"世界坐标连续运动"

| 思维 | 旧 PV 实现 | 新方案 |
|---|---|---|
| 歌词是 | 静态文本块 | 世界坐标系里的连续运动物体 |
| 画面是 | 第 N 句的布局 | 随时间演进的连续状态 |
| 场景切换 | 硬切/渐隐 | 重叠转场 + 轨道混合（无缝） |
| 运镜 | 目标跳变 | 速度积分 + 多马达混流（永不跳变） |

### 1.2 参考视频风格分析

参考的两个 B 站视频均为《妄想感傷代償連盟》（DECO*27）的文字 PV 练习作品，属于 B 站典型的「要素文字PV」风格：

- **高频跳切**：每个词块独立构图、随节拍快速弹出
- **视觉语法统一**：排版 → 转场 → 纹理全用同一套设计语法
- **踩拍切镜**：切点多在重音/鼓点，音乐上"感觉顺"
- **缝合转场**：再快的切也带可控的过渡缝合，而非生硬瞬移

本方案采用**双轨并存**：主线用连续长镜头（电影感），副线用节拍跳切（PV 感），中间用"缝合转场"无缝互通。

### 1.3 视觉基调

| 维度 | 取值 |
|---|---|
| 底色 | 纯黑 / 深中性色为主 |
| 主字色 | 纯白，不用渐变 |
| 强调色 | 单腔高饱和（红 / 青 / 品红），一次只用 1-2 腔 |
| 主字体 | 大字形、无衬线、粗档；日文可竖排挤字 |
| 构图偏好 | 非对称、斜切倾斜、大面积留白 + 一个巨物大字 |
| 信息密度 | 一屏一格点信息，"别塞满"（Shaft 式排版） |

---

## 2. 架构总览

### 2.1 四层架构

```
┌─────────────────────────────────────────────┐
│  CONTENT 内容层  歌词/节拍/情感/段落曲线      │
├─────────────────────────────────────────────┤
│  DIRECTOR 导演层  Timeline + 调度器 + 前瞻     │
├─────────────────────────────────────────────┤
│  WORLD 世界层    歌词词块/粒子/装饰 世界坐标    │
├─────────────────────────────────────────────┤
│  CAMERA 摄像机层 多运镜马达 → 混合 → 取景       │
├─────────────────────────────────────────────┤
│  RENDER 渲染层    DOM/CSS3D + WAAPI + SVG      │
└─────────────────────────────────────────────┘
```

### 2.2 数据流总览

```
yrc/qrc 原始歌词
    │
    ▼
┌─ 1. 统一解析层 ────────────────────────┐
│  输出: LyricWord[] (字/词 + 时间戳)      │
└──────────────────────────────────────┘
    │
    ▼
┌─ 2. 多语言分词层 ──────────────────────┐
│  语言检测 → 对应 Segmenter →           │
│  输出: SegmentedWord[] (分词后的词块)    │
└──────────────────────────────────────┘
    │
    ▼
┌─ 3. 分句分镜层 ────────────────────────┐
│  按时间聚类成句 → 语义分组 →            │
│  分镜切分 + 预设分配 →                 │
│  输出: Shot[] (每个 shot 含词块+构图+运镜)│
└──────────────────────────────────────┘
    │
    ▼
┌─ 4. Timeline + 渲染层 ────────────────┐
│  调度器驱动 → 摄像机混流 →             │
│  DOM/SVG 渲染 + 节拍联动               │
└──────────────────────────────────────┘
```

---

## 3. 连续性的三个技术支柱

### 3.1 支柱 A：位置由"速度积分"而不是"目标设值"

摄像机、歌词不直接赋值坐标，而是维护速度向量并逐帧积分：

```js
v = lerp(v, desiredV, 阻尼)      // 速度平滑趋近目标速度
p += v * dt                       // 位置由速度积分得到
```

好处：**任何目标改变（切词、切句、段落变化）影响的只是 desiredV，位置永远连续**。位移、速度、加速度全连续——这是"运镜丝滑"的数学保证，也正是真实摄影机的物理特性。

### 3.2 支柱 B：状态切换走"时间窗口混合"（blend），绝不硬切

场景、运镜、歌词强调之间都设有 **transition buffer**（如 0.6s）。切换时两个状态按正弦曲线混权：

```js
output = mix(prevState, nextState, easeInOutSine(t/duration))
```

画面永远处于"旧 → 新"的平滑流动中，没有瞬时跳变。

### 3.3 支柱 C：前瞻调度 + 回放恢复（lookahead & rewind）

- **lookahead**：提前 300-800ms 预排下一个词块/场景内容，保证画面不等播才生成，避免闪现。
- **seek 恢复**：拖动进度条时，摄像机不用瞬移，而是沿世界坐标以高速跟踪到目标（还是一个平滑曲线），期间歌词按时间重算状态。暂停/恢复同样连续。

---

## 4. 统一解析层

### 4.1 统一数据结构

```js
// 一个"字"或"最小词"——所有语言的原子单位
interface LyricWord {
  text: string;          // 原始文字，如 "僕" / "the" / "梦" / "꿈"
  startTime: number;     // ms，该字开始时间
  endTime: number;       // ms，该字结束时间
  lang: LangTag;         // 'ja' | 'zh' | 'en' | 'ko' | 'mixed'
  isPunctuation: boolean;
  syllable?: string;     // 罗马音/拼音（可选，用于排版）
}

// 一行歌词
interface LyricLine {
  words: LyricWord[];
  startTime: number;     // 行首时间
  endTime: number;       // 行尾时间
  translation?: string;  // 翻译（如果有）
  isChorus?: boolean;    // 副歌标记（AI/手动）
}
```

### 4.2 各格式适配

| 格式 | 已有能力 | 需要补充 |
|---|---|---|
| YRC (QQ) | `yrcParser.js` 已解析逐字时间戳，双格式自动识别 | 输出适配到 `LyricWord[]` |
| QRC (QQ) | 同上 | 同上 |
| LRC (网易云等) | `lrcParser.js` 有行级时间戳 | 行内按字符均分时间（无逐字时间戳时的降级） |
| KRC (酷狗) | `krcParser.js` 已有 | 同 YRC |

**降级策略**：LRC 没有逐字时间戳时，按字符数均分行时长，每个字分到 `duration / charCount`——不精确但保证管线不中断。

---

## 5. 多语言分词层

### 5.1 语言检测

逐字检测每个 `LyricWord` 的语言，用 Unicode 范围做**字符级判定**：

```js
function detectLang(ch: string): LangTag {
  const cp = ch.codePointAt(0);
  // CJK 统一表意文字（中日共用汉字）
  if (cp >= 0x4E00 && cp <= 0x9FFF) {
    return 'zh-or-ja';  // 需要上下文判定
  }
  // 平假名
  if (cp >= 0x3040 && cp <= 0x309F) return 'ja';
  // 片假名
  if (cp >= 0x30A0 && cp <= 0x30FF) return 'ja';
  // 韩文音节
  if (cp >= 0xAC00 && cp <= 0xD7AF) return 'ko';
  // 韩文兼容字母
  if (cp >= 0x1100 && cp <= 0x11FF) return 'ko';
  // 拉丁字母
  if (cp >= 0x0041 && cp <= 0x024F) return 'en';
  return 'other';
}
```

**行级语言判定**——因为一句话里可能混合语言（日文歌词里夹英文）：

```js
function detectLineLang(line: LyricWord[]): LangTag {
  const counts = { ja: 0, zh: 0, en: 0, ko: 0 };
  for (const w of line.words) {
    w.lang = detectLang(w.text);
    if (w.lang === 'zh-or-ja') {
      // 如果同行有平假名/片假名 → 整行判定为日文
      // 否则按中文处理
    }
    if (counts[w.lang] !== undefined) counts[w.lang]++;
  }
  // 取最多的语言为主语言，但如果次语言占比 > 25% 则标记为 'mixed'
  const primary = Object.entries(counts).sort((a,b) => b[1]-a[1])[0][0];
  const total = line.words.length;
  const secondary = Object.entries(counts).sort((a,b) => b[1]-a[1])[1]?.[1] ?? 0;
  return secondary / total > 0.25 ? 'mixed' : primary;
}
```

### 5.2 分词器注册表（策略模式）

```js
interface Segmenter {
  lang: LangTag;
  segment(words: LyricWord[]): SegmentedWord[];
}

const segmenterRegistry: Record<LangTag, Segmenter> = {
  ja: new JapaneseSegmenter(),
  zh: new ChineseSegmenter(),
  en: new EnglishSegmenter(),
  ko: new KoreanSegmenter(),
  mixed: new MixedSegmenter(),
};
```

#### 5.2.1 日文分词器（`JapaneseSegmenter`）

项目已集成 `kuromoji`（`kuromoji@0.1.2`），用它做形态素解析：

```js
class JapaneseSegmenter implements Segmenter {
  lang = 'ja';
  static async init(): Promise<JapaneseSegmenter> {
    const tokenizer = await kuromoji.load({ dicPath: 'kuromoji/dict' });
    return new JapaneseSegmenter(tokenizer);
  }

  segment(words: LyricWord[]): SegmentedWord[] {
    // 1. 把 LyricWord[] 拼回纯文本（保留时间映射）
    const { text, charMap } = this.flattenWithMap(words);
    
    // 2. kuromoji 分词
    const tokens = this.tokenizer.tokenize(text);
    
    // 3. 把 token 映射回 LyricWord，生成 SegmentedWord
    const result: SegmentedWord[] = [];
    let charIdx = 0;
    for (const token of tokens) {
      const tokenLen = token.surface_form.length;
      const subWords = charMap.slice(charIdx, charIdx + tokenLen);
      
      result.push({
        text: token.surface_form,
        startTime: subWords[0].startTime,
        endTime: subWords[subWords.length - 1].endTime,
        lang: 'ja',
        pos: token.pos,
        baseForm: token.basic_form,
        reading: token.reading,
        isEmotional: this.isEmotional(token),
      });
      charIdx += tokenLen;
    }
    
    // 4. 合并非情感词：把助词/助动词"粘"到前一个实词
    return this.mergeNonEmotional(result);
  }

  // 情感词判定：名词/形容词/动词词干 → 情感词；助词/助动词/记号 → 非情感
  private isEmotional(token): boolean {
    const emotionalPos = ['名詞', '形容詞', '動詞', '副詞', '連体詞'];
    return emotionalPos.includes(token.pos);
  }

  // 合并非情感词：连续的非情感词粘到前一个情感词
  private mergeNonEmotional(segments: SegmentedWord[]): SegmentedWord[] {
    const merged: SegmentedWord[] = [];
    for (const seg of segments) {
      if (!seg.isEmotional && merged.length > 0) {
        const last = merged[merged.length - 1];
        last.text += seg.text;
        last.endTime = seg.endTime;
      } else {
        merged.push({ ...seg });
      }
    }
    return merged;
  }
}
```

**关键设计决策**：kuromoji 分完之后，做一步**再合并**——把连续的非情感词（助词、助动词、记号）合并到前一个情感词上，只保留情感词作为独立的"显示词块"。这样分词数适中，不会碎。呼应项目记忆偏好"PV模式日文歌词只按情感词分词"。

#### 5.2.2 中文分词器（`ChineseSegmenter`）

项目已集成 `segmentit`（`segmentit@2.0.3`）：

```js
class ChineseSegmenter implements Segmenter {
  lang = 'zh';
  segment(words: LyricWord[]): SegmentedWord[] {
    const { text, charMap } = this.flattenWithMap(words);
    const segments = segmentit.doSegment(text, { simple: true });
    
    // 映射回时间戳（逻辑同日文）
    // ...
    
    // 情感词判定：segmentit 不返回词性，用停用词表反推
    const stopWords = new Set(['的', '了', '在', '是', '我', '你', '他', '们', '和', '与']);
    return result.map(s => ({
      ...s,
      isEmotional: !stopWords.has(s.text) && s.text.length > 1,
    }));
  }
}
```

#### 5.2.3 英文分词器（`EnglishSegmenter`）

英文不需要分词库——按空格分词，但要做特殊处理：

- 英文词间需保留空格分词
- 过长英文单词按字符逐个上浮（>8 字符按字符拆分）

```js
class EnglishSegmenter implements Segmenter {
  lang = 'en';
  segment(words: LyricWord[]): SegmentedWord[] {
    const result: SegmentedWord[] = [];
    let current: LyricWord[] = [];
    
    for (const w of words) {
      if (w.text === ' ') {
        if (current.length > 0) {
          result.push(this.toSegment(current));
          current = [];
        }
      } else {
        current.push(w);
      }
    }
    if (current.length > 0) result.push(this.toSegment(current));
    
    // 对过长单词（>8字符）按字符拆分
    return result.flatMap(seg => {
      if (seg.text.length > 8) return this.splitByChar(seg);
      return [seg];
    });
  }
  
  private toSegment(words: LyricWord[]): SegmentedWord {
    return {
      text: words.map(w => w.text).join(''),
      startTime: words[0].startTime,
      endTime: words[words.length - 1].endTime,
      lang: 'en',
      isEmotional: true,
    };
  }
}
```

#### 5.2.4 韩文分词器（`KoreanSegmenter`）

韩文有空格分隔，按空格分词即可（类似英文），韩文音节是一个 Unicode 码点 = 一个字，不需要逐字拆分。

#### 5.2.5 混合语言路由器（`MixedSegmenter`）

一首歌里中英日韩混杂——按语言边界切分，每段用对应 Segmenter：

```js
class MixedSegmenter implements Segmenter {
  lang = 'mixed';
  segment(words: LyricWord[]): SegmentedWord[] {
    // 1. 按 lang 分段（连续同语言的词分到一组）
    const groups = this.groupByLangBoundary(words);
    
    // 2. 每组用对应 Segmenter 处理
    const result: SegmentedWord[] = [];
    for (const group of groups) {
      const segmenter = segmenterRegistry[group.lang];
      if (segmenter) {
        result.push(...segmenter.segment(group.words));
      } else {
        // 降级：逐字
        result.push(...group.words.map(w => ({...w, isEmotional: true})));
      }
    }
    return result;
  }
  
  private groupByLangBoundary(words: LyricWord[]) {
    const groups: { lang: LangTag; words: LyricWord[] }[] = [];
    let current: { lang: LangTag; words: LyricWord[] } | null = null;
    for (const w of words) {
      if (!current || current.lang !== w.lang) {
        if (current) groups.push(current);
        current = { lang: w.lang, words: [w] };
      } else {
        current.words.push(w);
      }
    }
    if (current) groups.push(current);
    return groups;
  }
}
```

### 5.3 分词结果统一结构

```js
interface SegmentedWord {
  text: string;
  startTime: number;   // ms
  endTime: number;     // ms
  lang: LangTag;
  isEmotional: boolean;
  reading?: string;    // 罗马音/拼音
  pos?: string;        // 词性
}

interface SegmentedLine {
  words: SegmentedWord[];
  startTime: number;
  endTime: number;
  lang: LangTag;
  translation?: string;
  isChorus?: boolean;
}
```

---

## 6. 分句分镜层

### 6.1 Shot 数据结构

```js
interface Shot {
  id: string;
  words: SegmentedWord[];    // 这个镜头要显示的词块
  startTime: number;          // ms
  endTime: number;            // ms
  duration: number;           // ms
  
  // 导演层分配的"拍摄指令"
  composition: CompositionUnit;  // 构图单元
  cameraMove: CameraMove;        // 运镜动作
  transition: TransitionType;    // 与上一个 shot 的转场方式
  atmosphere: AtmospherePreset;  // 背景纹理预设
  
  // 情感/节拍标记
  energy: number;               // 0-1
  isEmphasis: boolean;          // 是否包含情感词需要强调
  
  // 参数化采样结果
  params: ShotParams;            // 完整参数向量
  timing: ShotTiming;           // 速度自适应时间
  analysis: LineAnalysis;       // AI/词典分析结果
}
```

### 6.2 分句策略

| 条件 | 策略 |
|---|---|
| 短行 ≤4 词 | 整行一个 shot |
| 长行 >4 词 | 按 2 拍一组切分 |
| 行间间隔 > 2 拍 | 行间插入"空 shot"（纯背景运镜） |
| 副歌段 | 每 1 拍切一个 shot（更激烈） |
| 主歌段 | 每 2-4 拍切一个 shot（更舒缓） |

### 6.3 分镜分配算法（Director）

分镜不是随机的——要有**连续逻辑**。核心是**预设序列 + 情感调制**：

```js
class Director {
  private preset: PVPreset;
  
  assignShots(shots: Shot[], lyrics: SegmentedLine[], bpm: number): Shot[] {
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const prev = shots[i - 1];
      
      // 1. 构图分配：60% 概率沿用/微调上一个构图（视觉连贯）
      //             40% 概率从预设池取新构图（节奏变化）
      shot.composition = this.pickComposition(i, prev, this.preset);
      
      // 2. 运镜分配：根据段落能量决定
      const sectionEnergy = this.getSectionEnergy(shot.startTime, lyrics);
      shot.cameraMove = this.pickCamera(shot, sectionEnergy, this.preset);
      
      // 3. 转场：根据与前一个 shot 的关系决定
      shot.transition = this.pickTransition(shot, prev, this.preset);
      
      // 4. 背景纹理
      shot.atmosphere = this.preset.atmosphere;
      
      // 5. 情感标记
      shot.isEmphasis = shot.words.some(w => w.isEmotional);
      shot.energy = this.calcEnergy(shot, bpm);
    }
    return shots;
  }
  
  // 转场选择：相邻 shot 的"距离"决定缝合方式
  private pickTransition(shot: Shot, prev: Shot | undefined, preset: PVPreset): TransitionType {
    if (!prev) return 'fade-in';
    
    const gap = shot.startTime - prev.endTime;
    const sameComposition = shot.composition.type === prev.composition.type;
    
    if (gap < 50) {
      return 'flash';                    // 极快接续 → 频闪/闪白
    } else if (sameComposition) {
      return 'scanline-sweep';           // 同构图 → 只换内容，扫描线扫过
    } else {
      return 'whip-pan';                // 换构图 → 快速扫镜 + RGB分裂
    }
  }
}
```

---

## 7. 歌词↔样式匹配策略

### 7.1 核心原则：四维函数

```
样式 = f( 语义情感 × 段落结构 × 词语权重 × 音乐动态 )
```

四个维度各自独立打分，最后合成一个样式参数集，而不是"悲伤→切到预设A"。这样过渡连续、不至于每句换皮。

### 7.2 维度一：语义情感

#### 获取方式

项目已有 `aiAnalyzer.js`，可以直接复用 AI 分析出的情感标签。没有 AI 时用情感词典降级：

```js
const EMOTION_LEXICON = {
  ja: {
    '悲しい': 'sorrow', '泣く': 'sorrow', '痛い': 'pain',
    '好き': 'love',   '愛': 'love',     '恋': 'love',
    '怒り': 'anger',  '壊': 'anger',     '裂': 'anger',
    '光': 'hope',     '夢': 'hope',      '未来': 'hope',
    '嘘': 'betray',   '偽': 'betray',    '裏切り': 'betray',
  },
  zh: { '哭': 'sorrow', '痛': 'pain', '爱': 'love', '光': 'hope', '谎': 'betray' },
  en: { 'cry': 'sorrow', 'pain': 'pain', 'love': 'love', 'light': 'hope', 'lie': 'betray' },
};

function detectLineEmotion(line: SegmentedLine): EmotionTag {
  const votes: Record<string, number> = {};
  for (const word of line.words) {
    const emotion = EMOTION_LEXICON[word.lang]?.[word.text];
    if (emotion) votes[emotion] = (votes[emotion] || 0) + 1;
  }
  const top = Object.entries(votes).sort((a,b) => b[1]-a[1])[0];
  return top ? top[0] as EmotionTag : 'neutral';
}
```

#### 情感→视觉参数映射表

| 情感类型 | 强调色 | 运镜速度 | 纹理密度 | 构图张力 |
|---|---|---|---|---|
| sorrow | 蓝/青 | 慢、缓 | 高(噪点重) | 收缩、留白多 |
| love | 粉/暖橙 | 中、柔 | 中 | 居中、对称 |
| anger | 红/品红 | 快、甩 | 低(干净) | 斜切、爆字 |
| hope | 白/金 | 升、推 | 中 | 向上、扩散 |
| betray | 紫/青 | 抖、乱 | 高(故障) | 碎裂、错位 |
| neutral | 纯白 | 跟随段落 | 中 | 随构图池轮换 |

### 7.3 维度二：段落结构

项目已有 `chorusDetector.js`，用它得出段落标记。段落驱动**全局基线**：

| 段落 | 切镜频率 | 运镜幅度 | 转场烈度 | 纹理 |
|---|---|---|---|---|
| intro | 4拍/shot | 极缓推 | 淡入 | 静态 |
| verse | 2拍/shot | 中等 | 扫描线 | 中密度 |
| pre | 1拍/shot | 加速、爬升 | 频闪渐强 | 密度上升 |
| chorus | 0.5拍/shot | 爆、甩、脉冲 | 闪白/RGB | 高密度 |
| bridge | 2拍/shot | 不规则、转折 | 故障/错位 | 变化大 |
| outro | 4拍/shot | 缓退 | 淡出 | 逐渐消失 |

### 7.4 维度三：词语权重

```js
function getWordEmphasis(word, lineEmotion, sectionEnergy): WordEmphasis {
  if (!word.isEmotional) {
    return { scale: 0.6, effect: 'none', glow: 0 };  // 功能词：缩小、无特效
  }
  if (sectionEnergy > 0.7) {
    return { scale: 1.8, effect: 'rgb-split', glow: 0.8, burst: true };
  }
  return { scale: 1.3, effect: 'glow', glow: 0.4, burst: false };
}
```

### 7.5 维度四：音乐动态

用 `AnalyserNode` 实时取能量，低频脉冲驱动摄像机呼吸缩放和频闪。

### 7.6 四维合成

```js
function computeStyle(word, lineEmotion, section, audioPulse, preset): ComputedStyle {
  const emotionParams = EMOTION_STYLE_MAP[lineEmotion];
  const sectionParams = SECTION_STYLE_MAP[section.type];
  
  return {
    accentColor: emotionParams.accentColor || preset.palette.accent,
    cameraSpeed: sectionParams.cameraSpeed * emotionParams.speedMultiplier,
    cutRate: sectionParams.cutRate,
    textureDensity: clamp(
      sectionParams.textureDensity + emotionParams.textureOffset + audioPulse.bass * 0.3, 0, 1),
    wordScale: getWordEmphasis(word, lineEmotion, section.energy).scale + audioPulse.bass * 0.05,
    wordEffect: getWordEmphasis(word, lineEmotion, section.energy).effect,
    strobe: audioPulse.bass > 0.7 ? audioPulse.bass : 0,
  };
}
```

### 7.7 叠加关系

```
全局基线（段落结构决定）→ 局部偏移（语义情感决定）→ 逐词强调（词语权重决定）→ 实时脉冲（音频动态决定）
```

四个维度不是"选哪个"，而是"叠加"：段落给底，情感给色，词权给点，音频给呼吸。全部连续叠加，不突跳。

---

## 8. 参数化生成器（无限变体）

### 8.1 设计理念

不做 100 种预设——做参数化生成器。每个分镜不是从列表里"选一个样式"，而是由一组连续参数定义：

```js
interface ShotParams {
  // ── 排版轴 ──
  layout: {
    type: 'diagonal' | 'vertical' | 'center' | 'scatter' | 'arc' | 'tunnel' | ...;
    angle: number;          // -45° ~ 45°，连续
    scale: number;          // 0.5 ~ 4.0，连续
    offsetX: number;        // -1.0 ~ 1.0（归一化），连续
    offsetY: number;         // -1.0 ~ 1.0，连续
    letterSpacing: number;  // -0.1 ~ 0.5em，连续
    lineGap: number;         // 0.8 ~ 2.0，连续
    skew: number;            // -20° ~ 20°，连续
    anchor: 'tl'|'tc'|'tr'|'cl'|'cc'|'cr'|'bl'|'bc'|'br';
  };
  
  // ── 运镜轴 ──
  camera: {
    move: 'push'|'pull'|'pan-l'|'pan-r'|'orbit'|'tilt'|'dive'|'static'|...;
    intensity: number;      // 0 ~ 1，连续
    speed: number;          // 0.5x ~ 3x，连续
    curve: 'linear'|'easeIn'|'easeOut'|'easeInOut'|'spring'|'expo';
    rotX: number;           // -30° ~ 30°
    rotY: number;           // -45° ~ 45°
    rotZ: number;           // -15° ~ 15°
  };
  
  // ── 入场动画轴 ──
  enter: {
    type: 'slide'|'burst'|'flip'|'glitch'|'clip'|'scatter'|'fade'|...;
    direction: number;      // 0° ~ 360°，连续方向
    stagger: number;        // 0 ~ 80ms，逐字错开
    overshoot: number;      // 0 ~ 0.3，弹性过冲
  };
  
  // ── 出场动画轴 ──
  exit: {
    type: 'fade'|'scatter'|'implode'|'slide'|'dissolve'|'glitch'|...;
    direction: number;
    stagger: number;
  };
  
  // ── 转场蒙版轴 ──
  transition: {
    shape: 'rect'|'triangle'|'circle'|'slits'|'blinds'|'diamond'|'none';
    angle: number;
    strips: number;         // 切片数量
    feather: number;        // 0=硬边，1=羽化
    speed: number;
  };
  
  // ── 纹理/氛围轴 ──
  texture: {
    type: 'halftone'|'scanline'|'noise'|'grid'|'concentric'|'none';
    density: number;        // 0 ~ 1
    opacity: number;        // 0 ~ 1
    animated: boolean;
    scrollAngle: number;
  };
  
  // ── 色彩轴 ──
  color: {
    accent: string;         // 强调色（HSL，可做色相旋转）
    bgShift: number;
    wordGlow: number;        // 0 ~ 1
    glitchRGB: number;      // 0 ~ 1
  };
}
```

### 8.2 参数空间采点

```js
function sampleShotParams(
  shotIndex: number,
  prevParams: ShotParams | null,
  emotion: EmotionTag,
  energy: number,
  bpm: number,
  lyricDensity: number,
  seed: number,
): ShotParams {
  
  const rng = seededRandom(seed + shotIndex);
  
  // 连贯性约束：相邻 shot 的参数差不能太大
  // 60%概率沿用上一shot的大部分参数，只微调几个轴
  // 40%概率跳到一个"合理范围内"的新值
  const continuity = rng() < 0.6 ? 0.7 : 0.3;
  
  return {
    layout: {
      type: pickLayout(prevParams, rng, energy),
      angle: lerp(prevParams?.layout.angle ?? 0, rng() * 90 - 45, 1 - continuity),
      scale: lerp(prevParams?.layout.scale ?? 1, 0.5 + rng() * 3.5, 1 - continuity),
      // ...
    },
    camera: {
      move: pickCameraMove(prevParams, rng, energy),
      intensity: lerp(prevParams?.camera.intensity ?? 0.5, energy * rng(), 1 - continuity),
      speed: lyricDensity * 0.3 + rng() * 0.7,  // 速度跟歌词密度联动
      // ...
    },
    // ... 其他轴同理
  };
}
```

**关键点**：`lerp(prev, new, 1 - continuity)` 保证了相邻 shot 有 60-70% 的参数延续，只有少部分轴变化——视觉连贯的数学保证。100 个 shot 里每个都和前一个有 70% 相似但 30% 不同，看起来就是"有变化的连续"。

### 8.3 实际变体数

```
排版类型(16) × 角度(连续) × 缩放(连续) × 位置(连续²)
× 运镜类型(8) × 入场类型(8大类×子类) × 出场类型(5) × 转场形状(6)
× 纹理(25) × 装饰组合(从37种中选3-5个) × 后处理(30) × 转场接续(8)
× 强调色(HSL连续)
= 天文数字，永远不会重复
```

---

## 9. 节奏驱动与速度自适应

### 9.1 用 onset detection 而不是固定 BPM

固定"BPM ÷ 2"切一次是粗暴的。实际应该用**音频 onset 检测**——每个鼓点/重音/能量突变都可以是一个分镜边界：

```js
class OnsetDetector {
  private analyser: AnalyserNode;
  private prevEnergy: number = 0;
  private threshold: number = 0.15;
  private onsetTimes: number[] = [];
  
  // 预扫描整首歌（用户确认后执行，约 2-3 秒）
  async prescan(audioBuffer: AudioBuffer): Promise<number[]> {
    const data = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const windowSize = 1024;
    const energies: number[] = [];
    
    // 1. 计算每帧能量
    for (let i = 0; i < data.length; i += windowSize) {
      let sum = 0;
      for (let j = 0; j < windowSize && i + j < data.length; j++) {
        sum += data[i + j] ** 2;
      }
      energies.push(sum / windowSize);
    }
    
    // 2. 差分 + 峰值检测 → onset 时间点
    for (let i = 1; i < energies.length; i++) {
      const diff = energies[i] - energies[i - 1];
      const time = (i * windowSize) / sampleRate * 1000;
      if (diff > this.threshold * Math.max(...energies) * 0.1) {
        this.onsetTimes.push(time);
      }
    }
    
    // 3. 过滤太密的 onset（< 150ms 的合并）
    return this.mergeCloseOnsets(this.onsetTimes, 150);
  }
}
```

### 9.2 按歌词节奏 + 音频节奏联合分镜

```js
function buildShotsByRhythm(
  lines: SegmentedLine[],
  onsets: number[],
  lyricDensity: Map<number, number>,
): Shot[] {
  const shots: Shot[] = [];
  
  for (const line of lines) {
    const lineOnsets = onsets.filter(t => t >= line.startTime && t <= line.endTime);
    
    if (lineOnsets.length === 0) {
      shots.push(createShot(line.words, line.startTime, line.endTime));
      continue;
    }
    
    const boundaries = [line.startTime, ...lineOnsets, line.endTime];
    for (let i = 0; i < boundaries.length - 1; i++) {
      const segStart = boundaries[i];
      const segEnd = boundaries[i + 1];
      const segWords = line.words.filter(w => w.startTime >= segStart && w.startTime < segEnd);
      
      if (segWords.length > 0) {
        shots.push(createShot(segWords, segStart, segEnd));
      }
    }
  }
  
  return shots;
}
```

切出来的分镜边界天然踩在鼓点上——快歌自然多、慢歌自然少。

### 9.3 速度自适应（不写死）

```js
function calcLyricDensity(line: SegmentedLine): number {
  const duration = (line.endTime - line.startTime) / 1000;
  const charCount = line.words.reduce((sum, w) => sum + [...w.text].length, 0);
  return charCount / duration;  // 字/秒
}

// 动画时长 = 基准 × (参考密度 / 实际密度)
function adaptiveDuration(baseMs: number, density: number): number {
  const REFERENCE_DENSITY = 5;
  const ratio = REFERENCE_DENSITY / Math.max(density, 0.5);
  return clamp(baseMs * ratio, 50, 400);
}

function computeTiming(shot: Shot, lyricDensity: number): ShotTiming {
  return {
    enterDuration: adaptiveDuration(200, lyricDensity),
    exitDuration:  adaptiveDuration(150, lyricDensity),
    transitionDuration: adaptiveDuration(120, lyricDensity),
    staggerDelay: adaptiveDuration(30, lyricDensity),
    cameraDuration: adaptiveDuration(300, lyricDensity),
    perCharInterval: shot.duration / shot.charCount,
  };
}
```

快歌（density=10）→ ratio=0.5，动画缩短一半；慢歌（density=2）→ ratio=2.5，动画放慢。全由数据驱动，不写魔法数字。

---

## 10. 逐字动画系统

### 10.1 拆字粒度（可配置，不固定）

```
粒度三档：
  phrase  ── "僕は嘘で" 整体一个动画单元
  word    ── "僕は" | "嘘で" 按分词拆开
  char    ── "僕" "は" "嘘" "で" 逐字独立动画
```

选择策略——按段落能量动态切换：

| 段落 | 粒度 | 原因 |
|---|---|---|
| intro/verse | phrase | 温和，整行缓入 |
| pre-chorus | word | 开始碎开，加速 |
| chorus | char | 逐字爆入，每个字独立轨迹 |
| bridge | 混合 | 部分字拆部分不拆 |

### 10.2 拆字实现

```js
function splitToCharSpans(word: SegmentedWord, granularity: 'phrase'|'word'|'char'): CharSpan[] {
  if (granularity === 'phrase' || granularity === 'word') {
    return [{
      text: word.text,
      startTime: word.startTime,
      endTime: word.endTime,
      enterDelay: 0,
      exitDelay: 0,
    }];
  }
  
  // char：逐字拆分，每个字分配独立时间窗口
  const chars = [...word.text];  // 用展开运算符正确处理多字节字符
  const charDuration = (word.endTime - word.startTime) / chars.length;
  
  return chars.map((ch, i) => ({
    text: ch,
    startTime: word.startTime + i * charDuration,
    endTime: word.startTime + (i + 1) * charDuration,
    enterDelay: i * 30,
    enterFrom: 'random',
    exitDelay: i * 20,
    exitTo: 'random',
  }));
}
```

### 10.3 入场动画库（8 大类 × 子类型）

#### 1. 直線移動
- 上→下、左→右、斜め方向
- 隣の字と 90° 方向を変える（避免单调）
- 偶数の単語は互いに逆方向から登場（对称强调）
- **リサイズ変形付き移動**：移动方向上拉伸 + 垂直方向压缩（模拟运动模糊感，不用真模糊）

```js
'slide-up': (el, delay) => el.animate(
  [{ transform: 'translateY(60px) scale(0.8)', opacity: 0 },
   { transform: 'translateY(0) scale(1)', opacity: 1 }],
  { duration: 200, delay, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }),

'slide-diagonal': (el, delay) => el.animate(
  [{ transform: 'translate(80px, 40px)', opacity: 0 },
   { transform: 'translate(0, 0)', opacity: 1 }],
  { duration: 180, delay, easing: 'ease-out' }),

'resize-slide': (el, delay, dir = 'x') => el.animate(
  [{ transform: `translate${dir === 'x' ? 'X' : 'Y'}(100px) scaleX(${dir === 'x' ? 1.3 : 0.8})`, opacity: 0 },
   { transform: 'translate(0,0) scale(1)', opacity: 1 }],
  { duration: 200, delay, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }),
```

#### 2. 回転
- Z 轴旋转：バウンド（弹性回弹）旋转登场
- X/Y/Z 三轴旋转：文字前后错位排列后整体旋转 → 立体感
- 横書き→90°回転→縦書き（横竖切换转场）
- 180° 回転退場（翻转退避）

```js
'rotate-z-bounce': (el, delay) => el.animate(
  [{ transform: 'rotate(-45deg) scale(0.5)', opacity: 0 },
   { transform: 'rotate(15deg) scale(1.1)', opacity: 1, offset: 0.6 },
   { transform: 'rotate(0deg) scale(1)', opacity: 1 }],
  { duration: 300, delay, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }),

'rotate-3d': (el, delay) => el.animate(
  [{ transform: 'perspective(400px) rotateY(90deg) rotateX(30deg)', opacity: 0 },
   { transform: 'perspective(400px) rotateY(0deg) rotateX(0deg)', opacity: 1 }],
  { duration: 350, delay, easing: 'ease-out' }),

'rotate-90-h2v': (el, delay) => el.animate(
  [{ transform: 'rotate(0deg) scale(1)', opacity: 1 },
   { transform: 'rotate(90deg) scale(0.9)', opacity: 0.8 }],
  { duration: 250, delay, easing: 'ease-in-out' }),
```

#### 3. 拡大縮小
- 0→1 爆入（ease-out）
- バウンド拡大（弹性过冲）
- **リサイズ引き伸ばし**：运动方向上拉长 + 垂直压扁

```js
'scale-burst': (el, delay) => el.animate(
  [{ transform: 'scale(0)', opacity: 0 },
   { transform: 'scale(1.3)', opacity: 1, offset: 0.7 },
   { transform: 'scale(1)', opacity: 1 }],
  { duration: 250, delay, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }),

'resize-stretch': (el, delay, axis = 'y') => el.animate(
  [{ transform: `scale${axis === 'y' ? 'Y' : 'X'}(2) scale${axis === 'y' ? 'X' : 'Y'}(0.5)`, opacity: 0 },
   { transform: 'scale(1)', opacity: 1 }],
  { duration: 200, delay, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }),
```

#### 4. 歪み系
- **ラスター歪み**：横向/纵向条纹错位，振幅渐小 → 文字ゆらゆら登場
- **一瞬グリッチ**：大幅歪ませた文字を1帧だけ映す → すぐに正常文字に切替
- **引き伸ばし**：文字的一部分拉伸出扫描线状
- **渦巻き**（swirl）：文字涡旋扭曲
- **領域拡張＋クリッピング**：裁切文字一部分 + 向某方向拉伸

```js
'raster-wobble': (el, delay) => el.animate([
  { transform: 'skewX(15deg) translateX(8px)', opacity: 0 },
  { transform: 'skewX(-10deg) translateX(-4px)', opacity: 0.6, offset: 0.3 },
  { transform: 'skewX(5deg) translateX(2px)', opacity: 0.8, offset: 0.6 },
  { transform: 'skewX(0deg) translateX(0)', opacity: 1 }],
  { duration: 250, delay, easing: 'ease-out' }),

'glitch-flash': (el, delay) => el.animate([
  { transform: 'translateX(-10px) skewX(20deg)', opacity: 0,
    textShadow: '-4px 0 #ff00ff, 4px 0 #00ffff' },
  { transform: 'translateX(4px) skewX(-5deg)', opacity: 0.6, offset: 0.3,
    textShadow: '-8px 0 #ff00ff, 8px 0 #00ffff' },
  { transform: 'translateX(0) skewX(0)', opacity: 1, textShadow: 'none' }],
  { duration: 150, delay, easing: 'steps(3)' }),

'swirl-in': (el, delay) => el.animate(
  [{ transform: 'rotate(180deg) scale(0.3)', opacity: 0, filter: 'blur(4px)' },
   { transform: 'rotate(0deg) scale(1)', opacity: 1, filter: 'blur(0)' }],
  { duration: 300, delay, easing: 'cubic-bezier(0.65, 0, 0.35, 1)' }),
```

#### 5. 点滅
- 高速闪烁登場 → 高科技/霓虹感
- 退場時も点滅可能

```js
'blink-in': (el, delay) => el.animate([
  { opacity: 0 }, { opacity: 1 }, { opacity: 0 }, { opacity: 1 },
  { opacity: 0 }, { opacity: 1 }],
  { duration: 200, delay, easing: 'steps(6)' }),
```

#### 6. 砕け散る
- シャター（shatter）逆再生：碎片汇聚成字

```js
'shatter-reverse': (el, delay) => el.animate(
  [{ clipPath: 'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)',
     transform: 'scale(1.5) rotate(10deg)', opacity: 0, filter: 'blur(8px)' },
   { clipPath: 'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)',
     transform: 'scale(1) rotate(0)', opacity: 1, filter: 'blur(0)' }],
  { duration: 300, delay, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }),
```

#### 7. 文字分解
- 把文字拆成笔画零件，每个零件独立动画
- 個別オブジェクト化 → 全部零件同時出現
- 一番目のパーツだけ先に映す → 順番に組み上がる

#### 8. クリップ/スキャン
- clip-path 揭示：从一側扫入
- 領域拡張で文字の一部だけ表示 → 徐々に全表示

```js
'clip-reveal': (el, delay) => el.animate(
  [{ clipPath: 'inset(0 100% 0 0)', opacity: 1 },
   { clipPath: 'inset(0 0% 0 0)', opacity: 1 }],
  { duration: 200, delay, easing: 'cubic-bezier(0.65, 0, 0.35, 1)' }),

'scan-clip': (el, delay) => el.animate(
  [{ clipPath: 'inset(50% 0 50% 0)', opacity: 0 },
   { clipPath: 'inset(0 0 0 0)', opacity: 1 }],
  { duration: 220, delay, easing: 'ease-out' }),
```

### 10.4 出场动画库

```js
const EXIT_ANIMATIONS = {
  'fade-out':     (el, delay) => el.animate(
    [{ opacity: 1 }, { opacity: 0 }],
    { duration: 150, delay, easing: 'ease-in' }),

  'scatter':      (el, delay, i, total) => el.animate(
    [{ transform: 'translate(0,0)', opacity: 1 },
     { transform: `translate(${(i-total/2)*40}px, ${-50 - Math.random()*80}px)`, opacity: 0 }],
    { duration: 200, delay, easing: 'cubic-bezier(0.5, 0, 0.75, 0)' }),

  'implode':      (el, delay) => el.animate(
    [{ transform: 'scale(1)', opacity: 1 },
     { transform: 'scale(0)', opacity: 0 }],
    { duration: 150, delay, easing: 'cubic-bezier(0.5, 0, 0.75, 0)' }),

  'slide-out':    (el, delay) => el.animate(
    [{ transform: 'translateX(0)', opacity: 1 },
     { transform: 'translateX(-120px)', opacity: 0 }],
    { duration: 180, delay, easing: 'ease-in' }),

  'dissolve':     (el, delay) => el.animate([
    { opacity: 1, filter: 'blur(0)' },
    { opacity: 0.5, filter: 'blur(4px)', offset: 0.5 },
    { opacity: 0, filter: 'blur(12px)' }],
    { duration: 250, delay, easing: 'ease-in' }),

  'glitch-out':   (el, delay) => el.animate([
    { transform: 'translateX(0)', opacity: 1, textShadow: 'none' },
    { transform: 'translateX(-4px)', opacity: 0.8, offset: 0.3,
      textShadow: '-6px 0 #ff00ff, 6px 0 #00ffff' },
    { transform: 'translateX(8px)', opacity: 0.4, offset: 0.6,
      textShadow: '-10px 0 #ff00ff, 10px 0 #00ffff' },
    { transform: 'translateX(0)', opacity: 0, textShadow: 'none' }],
    { duration: 200, delay, easing: 'ease-in' }),
};
```

### 10.5 动画选择策略

```js
function pickEnterAnimation(charIndex: number, energy: number, preset: PVPreset): string {
  const pool = energy > 0.7
    ? ['scale-burst', 'glitch-flash', 'rotate-3d', 'rotate-z-bounce']  // 高能
    : ['slide-up', 'slide-diagonal', 'clip-reveal', 'scan-clip', 'raster-wobble']; // 低能

  const seed = hashString(preset.name + charIndex);
  return pool[seed % pool.length];
}
```

---

## 11. 几何蒙版与剪切转场

### 11.1 CSS clip-path 几何裁切

```js
// 矩形从左扫入
'wipe-left': {
  from: 'inset(0 100% 0 0)',
  to:   'inset(0 0% 0 0)',
}

// 从中间向两侧展开
'wipe-center': {
  from: 'inset(0 50% 0 50%)',
  to:   'inset(0 0 0 0)',
}

// 从上往下揭
'wipe-down': {
  from: 'inset(0 0 100% 0)',
  to:   'inset(0 0 0 0)',
}

// 三角形揭幕
'wipe-triangle': {
  from: 'polygon(50% 50%, 50% 50%, 50% 50%)',
  to:   'polygon(-20% -20%, 120% -20%, -20% 120%)',
}

// 圆形扩散
'iris': {
  from: 'circle(0% at 50% 50%)',
  to:   'circle(150% at 50% 50%)',
}

// 多条竖条切片（百叶窗）
'blinds': (el, strips = 6) => {
  // 每条独立 animate，delay = i * 30ms
}
```

### 11.2 SVG mask 方式（更灵活的形状）

```js
function createSlitMask(angle: number, numSlits: number): string {
  const slits = Array.from({ length: numSlits }, (_, i) => {
    const y = (i / numSlits) * 100;
    const h = 100 / numSlits;
    return `<rect x="-20" y="${y}" width="140" height="${h * 0.7}" 
            transform="rotate(${angle} 50 ${y})" fill="white" />`;
  }).join('');
  
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none">
    <defs><mask id="slit-mask">
      <rect width="100" height="100" fill="black"/>${slits}
    </mask></defs></svg>`;
}
```

### 11.3 转场蒙版库

| # | 蒙版名 | 描述 |
|---|---|---|
| 1 | rect-wipe-left | 矩形从右往左扫入 |
| 2 | rect-wipe-right | 矩形从左往右扫入 |
| 3 | rect-wipe-up | 矩形从下往上扫入 |
| 4 | rect-wipe-down | 矩形从上往下扫入 |
| 5 | blinds-h | 6条水平百叶窗，逐条打开 |
| 6 | blinds-v | 6条竖直百叶窗 |
| 7 | slits-rotate | 斜切条形，带角度 |
| 8 | iris-open | circle(0% → 150%) |
| 9 | iris-close | circle(150% → 0%) |
| 10 | triangle-sweep | polygon 三角扩张 |
| 11 | diamond | polygon 菱形扩张 |
| 12 | rect-spin | rect + rotate，旋转着扫入 |
| 13 | gradient-wipe | mask 用 linear-gradient，软边缘过渡 |
| 14 | feather | mask 用 radial-gradient 柔边 |

### 11.4 镜头接续逻辑（シーンのつなぎ）

教程原文明确的 4 种接续方式：

| # | 接续名 | 描述 |
|---|---|---|
| 1 | 横→横 | 退场方向 = 入场方向（视線誘導），中间隔1帧 |
| 2 | 前→後 | 大→小 或 小→大，制造强弱对比 |
| 3 | 回転→回転 | 横書き→90°→縦書き，旋转中切换内容 |
| 4 | 回転→移動 | 立体旋转退场看起来像平面移动 → 用移动入场接续 |

### 11.5 画面のキレ手法

| # | 手法 | 描述 |
|---|---|---|
| 1 | 白/黒1帧挟み | 切镜时插1帧纯白（暗画面时）或纯黑（亮画面时） |
| 2 | 余韻（残像） | 前一个场景的文字故意留在背景里，下一个场景叠上去 |
| 3 | コマ落ち後かけ | 激烈段后加降帧 → 节奏メリハリ |
| 4 | 重ね掛け | 入场 ease-out + 退场 ease-in 叠加 → 更顺滑 |

---

## 12. 3D 透视效果

### 12.1 透视容器

```js
// 世界层容器：设透视
pvViewContainer.style.cssText = `
  perspective: 800px;
  perspective-origin: 50% 50%;
  transform-style: preserve-3d;
`;

// 每帧更新摄像机3D变换
function updateCamera3D(state) {
  cameraLayer.style.transform = `
    translate3d(${state.x}px, ${state.y}px, ${state.z}px)
    rotateX(${state.rotX}deg) rotateY(${state.rotY}deg)
    rotateZ(${state.rotZ}deg) scale(${state.scale})
  `;
}
```

### 12.2 词块的3D布局

```js
function getWord3DPosition(i: number, total: number, composition: CompositionUnit): 3DPos {
  switch (composition.type) {
    case 'arc-depth':
      // 弧形排列，中间近、两侧远（像银幕）
      const t = i / (total - 1) - 0.5;
      return {
        x: t * 800,
        y: Math.abs(t) * -60,
        z: -Math.abs(t) * 200,
        rotY: -t * 30,
      };
    
    case 'tunnel':
      // 隧道排列：词在Z轴上等距排列，镜头穿过
      return { x: 0, y: 0, z: -i * 150, rotY: 0 };
    
    case 'spiral':
      // 螺旋上升
      const angle = i * 0.5;
      return {
        x: Math.cos(angle) * 200,
        y: i * 30 - total * 15,
        z: Math.sin(angle) * 200,
        rotY: -angle * 180 / Math.PI,
      };
    
    case 'flat-tilt':
      // 平面倾斜（整面词块整体向后倾）
      return {
        x: (i - total/2) * 120, y: 0, z: 0,
        rotX: 15, rotY: 0,
      };
  }
}
```

### 12.3 3D运镜动作

```js
const CAMERA_3D_MOVES = {
  'dolly-in': (t) => ({
    z: lerp(0, 300, t),
    scale: lerp(1, 1.1, t),
  }),

  'orbit': (t, radius = 400) => {
    const angle = t * Math.PI * 2;
    return {
      x: Math.sin(angle) * radius,
      z: Math.cos(angle) * radius,
      rotY: -angle * 180 / Math.PI + 90,
    };
  },

  'dive': (t) => ({
    y: lerp(-400, 0, t),
    z: lerp(200, 0, t),
    rotX: lerp(30, 0, t),
  }),

  'tilt-pan': (t) => ({
    rotX: lerp(0, 45, easeInOut(t)),
    y: lerp(0, -100, t),
  }),
};
```

---

## 13. 完整视觉元素库

### 13.1 四层叠加结构

日文教程原文把文字 PV 的制作流程明确分为四步：

```
1. 文字の配置   → 排版层（文字怎么摆）
2. 動きをつける  → 动画层（文字/镜头怎么动）
3. 図形で飾る    → 装饰层（几何图形/线条/框架）
4. 質感を出す    → 纹理层（叠加质感/滤镜/后处理）
```

画面三层叠加：**纹理底 + 装饰中 + 文字顶**，每层都薄但合起来就厚。没有装饰层，画面永远只有"字 + 底纹"两张皮，缺少视觉密度。

### 13.2 第一层：排版（文字配置）—— 16 种

| # | 排版名 | 描述 |
|---|---|---|
| 1 | 漢字大＋平仮名小 | 汉字放大，送假名缩小紧贴——最基础的对比手法 |
| 2 | 1文字目強調 | 每个词组的首字放大，后面字缩小 |
| 3 | 縦詰め込み | 3字时第1字大，剩余2字缩小竖排紧贴 |
| 4 | 上下交互配置 | 字与字上下交替排列，制造不规则节奏感 |
| 5 | 左右交互配置 | 竖排时左右交替 |
| 6 | パズル配置 | 字当图形看，把空隙用另一个字填入（像拼图） |
| 7 | 三角配置 | 3个字摆成三角形 |
| 8 | 四角配置 | 4个字摆成方形 |
| 9 | 斜め一列 | 横一列但整体倾斜 |
| 10 | 中央特大 | 单个关键词居中，占满画面 |
| 11 | 散らばり配置 | 多个词散在画面各处，不规则 |
| 12 | 重ね配置 | 文字前后重叠（3D空间内），制造景深 |
| 13 | 余白活かし | 大面积留白 + 一角放字（Shaft 式非对称） |
| 14 | 帯状配置 | 文字条带横切画面 |
| 15 | 角配置＋中央大字 | 左上/右下角放小字注释，中央放巨字 |
| 16 | 回転配置 | 文字旋转 90° 从横排变竖排 |

### 13.3 第二层：动画（文字の動かし方）—— 8 大类 × 子类型

| # | 动画大类 | 子类型 |
|---|---|---|
| 1 | 直線移動 | 上→下、左→右、斜め、90°方向変え、逆方向対称、リサイズ変形付き |
| 2 | 回転 | Z軸バウンド、3軸回転（立体感）、横→縦90°、180°退避 |
| 3 | 拡大縮小 | 0→1爆入、バウンド拡大、リサイズ引き伸らし |
| 4 | 歪み系 | ラスター歪み、一瞬グリッチ、引き伸ばし、渦巻き、領域拡張＋クリッピング |
| 5 | 点滅 | 高速闪烁登場、退場時も点滅 |
| 6 | 砕け散る | シャター逆再生、碎片汇聚成字 |
| 7 | 文字分解 | パーツ分割、個別オブジェクト化、順番組み上がり |
| 8 | クリップ/スキャン | clip-path 揭示、領域拡張で一部表示→徐々に全表示 |

### 13.4 第三层：装饰（図形・オブジェクト）—— 37 种

#### 几何图形类（18 种）

| # | 装饰元素 | 实现方式 |
|---|---|---|
| 1 | 円（圆） | SVG `<circle>` 或 CSS `border-radius:50%` |
| 2 | 菱形 | `transform: rotate(45deg)` 的方形 |
| 3 | 十字 | 两个 `<rect>` 交叉 |
| 4 | 直線（线条） | `<line>` 或 `border` |
| 5 | 集中線（放射线） | `conic-gradient` 或 SVG 放射状 `<line>` |
| 6 | 破線（虚线） | `stroke-dasharray` |
| 7 | 三角格子 | SVG `<polygon>` 平铺 |
| 8 | チェッカーボード | `repeating-conic-gradient` 棋盘格 |
| 9 | カラーブロック（色块） | 满屏 `<rect>` 色块 |
| 10 | バーストレイ（爆裂射线） | 从中心放射的三角条 |
| 11 | 透視グリッド（透视网格） | CSS `perspective` + 横竖线 |
| 12 | 幾何学模様（几何纹样） | SVG `<pattern>` 平铺多边形 |
| 13 | 括弧（方括号） | `[]` 形状的装饰框 |
| 14 | 矢印（箭头） | SVG `<polygon>` |
| 15 | アスタリスク | `*` 字符装饰 |
| 16 | 十字マーカー（瞄准框） | 四角 L 型 brackets → HUD 感 |
| 17 | リング（圆环） | `border` 圆环 |
| 18 | ノコギリ縞（锯齿条） | `clip-path: polygon` 锯齿 |

#### 有机/流动类（5 种）

| # | 装饰元素 | 实现方式 |
|---|---|---|
| 19 | 流線（流动曲线） | SVG `<path>` 贝塞尔曲线 |
| 20 | 波（波浪） | SVG path + animate `d` |
| 21 | 雲（云朵） | SVG `filter: blur` 组合圆 |
| 22 | 有機blob | SVG `<path>` 不规则闭合 + animate |
| 23 | 光斑（bokeh） | `radial-gradient` + `filter: blur` |

#### 构图辅助线类（4 种）

| # | 装饰元素 | 实现方式 |
|---|---|---|
| 24 | 黄金螺旋 | SVG path 螺旋 |
| 25 | 三分割線 | 横竖各 2 条线 |
| 26 | phi grid | 黄金比例分割线 |
| 27 | 構図ガイド（构图框） | 画面内的框中框 |

#### 文字装饰类（10 种）

| # | 装饰元素 | 实现方式 |
|---|---|---|
| 28 | メインテキスト（主文字） | 主体歌词 |
| 29 | 散らばりテキスト | 背景里散落的小字（信息量感） |
| 30 | テキストストリップ（文字条带） | 横切画面的文字带 |
| 31 | テキストカード | 卡片式文字容器 |
| 32 | アウトライン文字（描边字） | `text-stroke` 或 `paint-order` |
| 33 | 重ね文字（叠层字） | 同一文字多层错开 |
| 34 | グロー文字（发光字） | `text-shadow` 多层模糊 |
| 35 | 縦サブテキスト（竖排小字） | 角落竖排注释 |
| 36 | 数式オーバーレイ | 画面上叠加公式/坐标 → 理性/科技感 |
| 37 | 降る文字雨 | Matrix 式文字雨 |

### 13.5 第四层：纹理/后处理—— 55 种

#### 叠加纹理类（25 种）

| # | 纹理 | 实现方式 |
|---|---|---|
| 1 | ハーフトーン（网点） | SVG `<pattern>` radial-gradient 点阵 |
| 2 | スキャンライン | `repeating-linear-gradient` 横纹 |
| 3 | フィルムグレイン（胶片颗粒） | SVG `feTurbulence` |
| 4 | グリッチバー（故障横条） | 随机高度横条 + `clip-path` 切片 |
| 5 | RGB分離（色差） | 红/青/蓝三层 `text-shadow` 偏移 |
| 6 | クロマティックアベレーション | `filter: hue-rotate` + 位移 |
| 7 | ドットスクリーン（半调网点） | 同 halftone 但更粗 |
| 8 | ビネット（暗角） | `radial-gradient` 外暗内亮 |
| 9 | カラーマスク（色块蒙版） | 半透明色块覆盖 |
| 10 | HUD要素 | 瞄准框/坐标读数/波形图 |
| 11 | CRT/TV仿真 | 凸面弯曲 + 扫描线 + 色差 |
| 12 | VHS tracking | 横条错位 + 颜色偏移 |
| 13 | モザイク | `image-rendering: pixelated` 块化 |
| 14 | ラフエッジ（毛边） | SVG `feDisplacementMap` |
| 15 | フイルムスクラッチ（划痕） | 随机白线 |
| 16 | ライトリーク（漏光） | `radial-gradient` 柔光斑 |
| 17 | ブラーフ（模糊） | `filter: blur` |
| 18 | ディスプレイスメント | SVG `feDisplacementMap` 波纹扭曲 |
| 19 | フラクタルノイズ | SVG `feTurbulence` + `feColorMatrix` |
| 20 | テクスチャ合成 | `mix-blend-mode: overlay/multiply` |
| 21 | ポスタリゼーション | `filter` 限色 → 色阶断层感 |
| 22 | 閾値（threshold） | 黑白两极化 |
| 23 | モーションタイル | `repeating` + 滚动 |
| 24 | ストロボ（频闪） | opacity 0/1 踩拍 |
| 25 | 色反転（亮度反转） | `filter: invert` 1帧插入 |

#### 后处理镜头类（30 种）

| # | 后处理 | 实现方式 |
|---|---|---|
| 1 | 画面シェイク（手抖） | `transform: translate` 随机微抖 |
| 2 | ズーム（镜头推拉） | `transform: scale` |
| 3 | チルト（倾斜） | `transform: rotate` |
| 4 | 色相シフト | `filter: hue-rotate` 渐变 |
| 5 | コマ落ち（降帧） | 跳帧渲染 → 卡顿感 |
| 6 | ブラーフ强度変化 | `filter: blur` 动态调整 |
| 7 | ブライトネス変化 | `filter: brightness` |
| 8 | コントラスト変化 | `filter: contrast` |
| 9 | 彩度変化 | `filter: saturate` |
| 10 | セピア | `filter: sepia` |
| 11 | 反転 | `filter: invert` |
| 12 | ドロップシャドウ | `filter: drop-shadow` |
| 13 | 明度反転1帧 | `filter: invert` 1帧 → 画面のキレ |
| 14 | 色相回転 | `filter: hue-rotate` 持续旋转 |
| 15 | グレースケール | `filter: grayscale` |
| 16 | 古い映画フィルタ | sepia + contrast + grain |
| 17 | ネオン发光 | `filter: drop-shadow` 多色 |
| 18 | レンズフレア | radial-gradient 光斑 |
| 19 | デプスオブラー | `filter: blur` 按深度 |
| 20 | エンボス | `filter: url(#emboss)` |
| 21 | 輪郭抽出 | `filter: url(#edge-detect)` |
| 22 | ノイズ増幅 | `filter: url(#noise)` |
| 23 | 波形歪み | `filter: url(#wave-distort)` |
| 24 | 焼き込み | `mix-blend-mode: color-burn` |
| 25 | 覆い焼き | `mix-blend-mode: color-dodge` |
| 26 | オーバーレイ | `mix-blend-mode: overlay` |
| 27 | スクリーン | `mix-blend-mode: screen` |
| 28 | マルチプライ | `mix-blend-mode: multiply` |
| 29 | 差の絶対値 | `mix-blend-mode: difference` |
| 30 | 排除 | `mix-blend-mode: exclusion` |

---

## 14. 运镜系统

### 14.1 多"运镜马达"（Camera Motors）

每个马达是一条独立轨迹，输出 `{P(位置), F(焦点), Z(缩放)}`：

| 马达类型 | 轨迹特点 | 情绪质感 |
|---|---|---|
| 缓动转移 | 两目标间 easeInOutCubic 补间 | 干净、优雅 |
| 弹性跟拍 | 弹簧/阻尼追踪目标，带拖尾回弹 | 电影感、跟拍歌词 |
| 路径轨道 | 沿贝塞尔/椭圆/直线缓速运动 | 环绕、推进、横移 |
| 参数化 | 正弦摆动 / 呼吸缩放 / 手持抖动 | 日常、呼吸、真实 |
| 关键帧 | 时间点+锚点自动插值 | 精确控制、爆点 |
| 节拍脉冲 | 随 BPM 缩放/抖动 | 燃、节奏感 |
| 扫镜/翻页 | 快速位移（一拍内完成），带轻微弹性 | 跳切缝合 |
| 长镜头轨道 | Catmull-Rom 样条路径 | 连续运镜段 |

### 14.2 马达混合（Motor Blending）

摄像机不是"当前是哪个马达"，而是多个马达输出按权重重叠混合（权重本身连续变化）：

```js
cam = Σwi × motor_i( t )            // Σwi = 1，wi 平滑增减
```

### 14.3 运镜硬指标

- 位移 / 速度 / 加速度三者连续（一阶二阶可导）
- 目标路径用三次样条（Catmull-Rom）保证平滑经过所有锚点
- 缩放与位移联动（推拉时焦点锁定，避免"贴图滑动感"）

### 14.4 双轨并存

- **节拍跳切轨**：每个 onset 触发快速扫镜/频闪/RGB分裂——PV 感
- **连续长镜头轨**：副歌或尾部，一条路径轨道载着镜头扫入多个词块——电影感
- 中间用"缝合转场"无缝互通

---

## 15. AI 联网搜索方案

### 15.1 两阶段分析

```
阶段A：联网搜索（了解这首歌"是什么"）
    │  搜索歌名+歌手 → 获取歌曲背景、情绪基调、结构信息、乐评
    │  不需要传整首歌词，token 消耗小
    ▼
阶段B：歌词分析（了解歌词"在说什么"）
    │  把歌词分批传给 AI → 逐句情感标签 + 逐词权重 + 段落结构
    │  token 消耗大，但可以分批 + 缓存
```

### 15.2 阶段 A：联网搜索歌曲信息

```js
async function searchSongContext(songTitle: string, artist: string): Promise<SongContext> {
  const prompt = `
搜索歌曲《${songTitle}》- ${artist}，告诉我：
1. 这首歌的整体情绪基调（如：悲伤、愤怒、希望、混合）
2. 歌曲结构信息（有没有明确的副歌/桥段/间奏段落）
3. 歌曲的BPM范围（如果找得到）
4. 歌词的主题和大意
5. 这首歌在粉丝/乐评中的常见情感标签

以 JSON 格式返回：
{
  "mood": "sorrow|anger|love|hope|betray|mixed",
  "moodDetail": "一句话描述",
  "bpm": 数字或null,
  "structure": ["intro","verse","chorus",...],
  "theme": "主题简述",
  "tags": ["标签1","标签2",...],
  "energyCurve": "描述能量走势的一句话"
}
  `;
  
  const result = await callAIWithSearch(prompt);  // Gemini 自带联网
  return JSON.parse(result);
}
```

### 15.3 阶段 B：歌词分批分析（控制 token）

```js
async function analyzeLyricsWithAI(
  lines: SegmentedLine[],
  songContext: SongContext,
): Promise<LineAnalysis[]> {
  
  const BATCH_SIZE = 10;
  const results: LineAnalysis[] = [];
  
  for (let i = 0; i < lines.length; i += BATCH_SIZE) {
    const batch = lines.slice(i, i + BATCH_SIZE);
    
    const prompt = `
歌曲背景：${songContext.moodDetail}，主题：${songContext.theme}
以下是第 ${i+1}-${i+batch.length} 行歌词，请为每行标注：

1. emotion: 这行的情感（sorrow|anger|love|hope|betray|neutral|excitement|fear）
2. energy: 0-1 的能量值
3. keywords: 这行需要强调的关键词（1-3个）
4. visualHint: 视觉建议（如"紧凑碎裂""柔和扩散""倾斜爆字"）

歌词：
${batch.map((l, idx) => `${idx+1}. ${l.words.map(w=>w.text).join('')}`).join('\n')}
    `;
    
    const result = await callAI(prompt);
    results.push(...JSON.parse(result));
  }
  
  return results;
}
```

### 15.4 Token 消耗估算

```
阶段A（联网搜索）：~2,000-3,000 tokens（只搜歌曲信息）
阶段B（歌词分析）：~1,500 tokens/批 × 10批 = ~15,000 tokens
总计：~17,000-18,000 tokens

分批好处：
  - 可以只分析前几行就开始渲染（流式）
  - 用户可以中断
  - 每批结果独立缓存
```

### 15.5 三种模式

```js
const PV_MODES = {
  full: {
    name: 'AI 联网完整分析',
    needsAI: true,
    tokenEstimate: (lyrics) => Math.round(lyrics.length * 8 + 2000),
    desc: '语义情感 + 段落结构 + 词权 + BPM，效果最佳',
  },
  lightweight: {
    name: '轻量分析（无 AI）',
    needsAI: false,
    desc: '用情感词典 + 节拍检测，效果略简化但不耗 token',
  },
  manual: {
    name: '纯预设（无分析）',
    needsAI: false,
    desc: '只用预设风格卡 + 逐字时间戳，最简单',
  },
};
```

### 15.6 降级路径（无 AI 也能用）

```js
function analyzeWithoutAI(lines: SegmentedLine[], audio: HTMLAudioElement): PVAnalysis {
  return {
    emotions: lines.map(l => detectLineEmotion(l)),  // 情感词典
    sections: detectSectionsByEnergy(lines, audio),   // 能量推断段落
    // 词权：分词器自带 isEmotional
    bpm: detectBPM(audio),                            // Web Audio 自动检测
  };
}
```

---

## 16. 用户确认与动态生成流程

### 16.1 用户确认对话框

```
┌──────────────────────────────────────────────┐
│  「动态海报 PV 模式」需要 AI 分析歌词以         │
│   生成最佳视觉效果。                           │
│                                              │
│   预计消耗：                                   │
│   • Token: ~12,000-18,000（视歌词长度）        │
│   • 时间:  约 15-30 秒                        │
│                                              │
│   分析内容包括：                               │
│   ✓ 每句歌词的语义情感标签                     │
│   ✓ 歌曲段落结构（主歌/副歌/桥段）              │
│   ✓ 逐词权重与强调标记                         │
│   ✓ BPM 节拍检测                              │
│                                              │
│   生成后效果会缓存，下次播放同一首歌不再消耗     │
│                                              │
│   分析模式：                                   │
│   ○ AI 联网完整分析（效果最佳）                 │
│   ○ 轻量分析（无 AI，用词典+节奏检测）          │
│   ○ 纯预设（无分析，最简单）                   │
│                                              │
│   [取消]                    [开始生成]         │
└──────────────────────────────────────────────┘
```

### 16.2 动态生成效果（6 阶段渐进式可视化）

```
阶段1（0-20%）   解析歌词 → 屏幕逐行显示歌词文本，打字机效果
阶段2（20-40%）  分词 → 词语高亮闪烁，显示"正在分词"
阶段3（40-70%）  AI 分析 → 每句出现情感标签气泡（悲伤/爱/愤怒…）
阶段4（70-85%）  分镜排布 → 画面开始按分镜表"排练"（慢速预览）
阶段5（85-95%）  预设应用 → 纹理/颜色/运镜渐入
阶段6（95-100%） 就绪 → 淡入正式播放
```

```js
async function generateWithProgress(lyrics, audio) {
  const overlay = showGenerationOverlay();
  
  overlay.setStatus('解析歌词…');
  overlay.showLyricsTyping(lyrics);
  const parsed = await parseLyrics(lyrics);
  await overlay.progressTo(20);
  
  overlay.setStatus('多语言分词…');
  const segmented = await segmentAll(parsed);
  overlay.highlightWords(segmented);
  await overlay.progressTo(40);
  
  if (useAI) {
    overlay.setStatus('AI 情感分析…');
    const emotions = await aiAnalyzeEmotions(segmented);
    overlay.showEmotionBubbles(emotions);
    await overlay.progressTo(70);
  } else {
    overlay.setStatus('轻量分析…');
    const emotions = analyzeWithoutAI(segmented, audio);
    await overlay.progressTo(70);
  }
  
  overlay.setStatus('分镜排布…');
  const shots = director.assignShots(buildShots(segmented, bpm), ...);
  overlay.previewShotsSlow(shots);
  await overlay.progressTo(85);
  
  overlay.setStatus('应用预设…');
  applyPreset(shots, preset);
  overlay.fadeInTextures();
  await overlay.progressTo(95);
  
  overlay.setStatus('就绪');
  await overlay.progressTo(100);
  overlay.fadeOut();
  
  return shots;
}
```

### 16.3 流式生成（不等全部完成）

```js
async function generatePVStreaming(song, lyrics, audio) {
  // 1. 快速阶段：联网搜索歌曲信息（2-3秒）
  const context = await searchSongContext(song.title, song.artist);
  
  // 2. 快速阶段：onset 预扫描 + BPM 检测（可并行）
  const [onsets, bpm] = await Promise.all([
    onsetDetector.prescan(audio),
    detectBPM(audio),
  ]);
  
  // 3. 分词
  const segmented = await segmentAll(lyrics);
  
  // 4. 流式 AI 分析：每批分析完就开始排那些行
  const allShots = [];
  for (let i = 0; i < segmented.length; i += 8) {
    const batch = segmented.slice(i, i + 8);
    const analysis = await analyzeLyricsBatch(batch, context);
    const batchShots = buildShotsFromAnalysis(batch, analysis, onsets, bpm);
    allShots.push(...batchShots);
    
    // 立即把已生成的 shot 推给渲染器开始预览
    previewRenderer.appendShots(batchShots);
  }
  
  return allShots;
}
```

### 16.4 缓存策略

```js
// key = songId + lyricsHash
function getCachedAnalysis(songId, lyricsHash) {
  const key = `pv_analysis_${songId}_${lyricsHash}`;
  const cached = localStorage.getItem(key);
  return cached ? JSON.parse(cached) : null;
}

function cacheAnalysis(songId, lyricsHash, analysis) {
  const key = `pv_analysis_${songId}_${lyricsHash}`;
  localStorage.setItem(key, JSON.stringify(analysis));
}

// 流程：切歌时先查缓存
async function ensureAnalysis(song, lyrics) {
  const hash = md5(lyrics.map(l => l.words.map(w => w.text).join('')).join(''));
  const cached = getCachedAnalysis(song.id, hash);
  if (cached) return cached;  // 命中缓存，不耗 token
  
  const confirmed = await showAIConfirmDialog(song, lyrics);
  if (!confirmed) return analyzeWithoutAI(lyrics, audio);  // 降级
  
  const analysis = await analyzeWithAI(lyrics);
  cacheAnalysis(song.id, hash, analysis);
  return analysis;
}
```

---

## 17. 渲染管线

### 17.1 Timeline 主循环

```js
class PVTimeline {
  private shots: Shot[];
  private currentShotIndex: number = 0;
  private renderer: PVRenderer;
  private camera: PVMixedCamera;
  private audioAnalyser: AudioAnalyser;
  
  update(audioTime: number) {
    // 1. 找到当前应该播放的 shot（支持 seek）
    const shot = this.findShotAt(audioTime);
    
    // 2. 如果 shot 变了 → 触发转场
    if (shot.index !== this.currentShotIndex) {
      this.triggerTransition(this.shots[this.currentShotIndex], shot);
      this.currentShotIndex = shot.index;
    }
    
    // 3. 计算当前 shot 内的进度 (0-1)
    const shotProgress = (audioTime - shot.startTime) / shot.duration;
    
    // 4. 摄像机更新（马达混流 + 节拍脉冲）
    const beatPulse = this.audioAnalyser.getBeatPulse(audioTime);
    this.camera.update(shot, shotProgress, beatPulse);
    
    // 5. 渲染
    this.renderer.render(shot, shotProgress, this.camera.getState());
  }
}
```

### 17.2 渲染器

```js
class PVRenderer {
  private worldLayer: HTMLElement;    // 世界层（歌词词块 + 装饰）
  private textureLayer: SVGElement;  // 纹理层（网点/扫描线/噪点）
  private decorationLayer: SVGElement; // 装饰层（几何图形/线条/构图框）
  private cameraLayer: HTMLElement;   // 摄像机层（transform 容器）
  
  render(shot: Shot, progress: number, camState: CameraState) {
    // 1. 摄像机 transform
    this.cameraLayer.style.transform = 
      `translate3d(${camState.x}px, ${camState.y}px, ${camState.z}px) ` +
      `rotateX(${camState.rotX}deg) rotateY(${camState.rotY}deg) ` +
      `scale(${camState.scale})`;
    
    // 2. 词块渲染（只在新 shot 时重建 DOM）
    if (this.currentShotId !== shot.id) {
      this.buildWordBlocks(shot);
      this.currentShotId = shot.id;
    }
    this.updateWordHighlight(shot, progress);
    
    // 3. 装饰层渲染
    if (this.currentDecorations !== shot.params.decoration) {
      this.rebuildDecorations(shot.params.decoration);
      this.currentDecorations = shot.params.decoration;
    }
    
    // 4. 纹理层
    if (this.currentTexture !== shot.params.texture.type) {
      this.rebuildTexture(shot.params.texture);
      this.currentTexture = shot.params.texture.type;
    }
    
    // 5. 后处理（每帧，只改 filter/opacity）
    this.applyPostFX(shot.params.postFX, camState.beatPulse);
  }
}
```

### 17.3 渲染策略

- **DOM + CSS 3D transform** 为主（GPU 合成、字体清晰、无缝接入现有歌词/背景）
- 纹理用 **SVG 内联 / CSS 渐变**（一次生成，GPU 复用）
- 动画统一走 **WAAPI 关键帧** 或自管单循环 rAF 批量读/写（消除强制回流）
- **60fps 锁定**、必要时降级（关闭粒子/景深/噪点）
- 世界层用**轴向对齐裁剪**：只渲染出现在镜头内的词块
- 复用现有 yrc/qrc 逐字时间戳、情感标记、YRC 双格式解析

### 17.4 多语言字体处理

```js
function getFontForLang(lang: LangTag): string {
  const map = {
    ja: 'MultiLangFont-ja, "Noto Sans JP", sans-serif',
    zh: 'MultiLangFont-zh, "Noto Sans SC", sans-serif',
    en: 'MultiLangFont-en, "Inter", sans-serif',
    ko: 'MultiLangFont-ko, "Noto Sans KR", sans-serif',
  };
  return map[lang] || map.en;
}
```

---

## 18. 三级连贯层级（Shot→Group→Section）

### 18.1 问题：每个 shot 都是独立个体会导致画面碎裂

当前方案中每个 shot 被当作独立个体处理，各自有独立的场景、运镜、纹理——一首快歌 100+ 个 shot 意味着 100+ 次场景跳变，画面会非常碎。

正确的结构应该是**三级层级**：句子被分组，组内共享场景和连续运镜，组间才有明显场景切换，段间才有大变化。

### 18.2 三级层级定义

| 层级 | 名称 | 粒度 | 连贯程度 | 切换时发生什么 |
|---|---|---|---|---|
| **Level 1** | Shot（分镜） | 单词/单句 | 逐字动画不同，装饰可微调 | 轻微——只换词块，镜头不停 |
| **Level 2** | Group（句组） | 2-6 句歌词 | **镜头连续运动，场景共享** | 明显——场景变换 + 新运镜轨道 |
| **Level 3** | Section（段落） | 主歌/副歌/桥段 | 整体氛围基调统一 | 大变化——预设/色板/纹理全换 |

### 18.3 层级关系示意图

```
Song
 └─ Section (段落) × 3-8
     ├─ 预设/色板/纹理基线（段内共享）
     ├─ energy 曲线
     └─ Group (句组) × 2-5/段
         ├─ 场景状态（组内共享：纹理类型 + 色板 + 装饰族）
         ├─ 连续运镜轨道（组内共享：Catmull-Rom 样条）
         ├─ 组级情感
         └─ Shot (分镜) × 1-6/组
             ├─ 逐字动画（各自不同）
             ├─ 装饰微调（同族变体，不跳风格）
             └─ 词块内容
```

### 18.4 数据结构

```js
// 句组
interface ShotGroup {
  id: number;
  shots: Shot[];
  startTime: number;
  endTime: number;
  
  // 组级共享
  scene: SceneState;              // 共享场景（纹理 + 色板 + 装饰族）
  cameraTrack: GroupCameraState;  // 连续运镜轨道
  groupEmotion: EmotionTag;       // 组级情感
  
  // 组的角色（在段落中的位置）
  roleInSection: 'opening' | 'building' | 'peak' | 'resolving' | 'transition';
}

// 场景状态（组内共享）
interface SceneState {
  groupId: number;
  // 共享属性（组内不变）
  palette: { bg: string; fg: string; accent: string };
  textureType: string;       // 组内纹理类型不变
  textureParams: object;     // 纹理参数不变
  decorationFamily: string;  // 装饰族（组内所有 shot 从同族中取变体）
  
  // 组内可微调属性（每个 shot 略有不同但不跳变）
  decorationSeed: number;    // 装饰布局用同一种子系列 → 风格统一
  cameraIntensity: number;   // 运镜强度可微调
}

// 连续运镜轨道（组内共享）
interface GroupCameraState {
  spline: CatmullRomSpline;  // 经过组内所有 shot 锚点的平滑曲线
  startState: CameraAnchor;   // 轨道起点
  endState: CameraAnchor;     // 轨道终点
  duration: number;            // 组总时长
  moveType: 'pan'|'push'|'orbit'|'tilt'|'dive'|'spiral'|...;
}

// 段落
interface SongSection {
  type: 'intro' | 'verse' | 'pre' | 'chorus' | 'bridge' | 'outro';
  groups: ShotGroup[];
  energy: number;
  preset: PVPreset;             // 段落级预设
  startTime: number;
  endTime: number;
}

// Shot 补充字段
interface Shot {
  // ... 原有字段
  groupId: number;              // 所属句组
  indexInGroup: number;         // 组内序号
  groupRole: 'start' | 'mid' | 'end';  // 在组内的位置
}
```

### 18.5 AI 分组逻辑

AI 分析时不只标逐句情感，还要标**句组归属**和**组内角色**：

```js
interface LineAnalysis {
  emotion: EmotionTag;
  energy: number;
  keywords: string[];
  visualHint: string;
  groupId: number;                          // 句组编号
  groupRole: 'start' | 'mid' | 'end';      // 在组内的位置
}
```

AI 分组 prompt：

```js
const GROUPING_PROMPT = `
歌曲背景：${songContext.moodDetail}

以下是歌词，请将它们分组（groupId），分组的依据：
1. 语义连贯：意思上属于同一句话的多句归为一组
   - 例如"僕は嘘で染まった / それでもいいと笑った"应为一组
   - "もう戻れない / 進むしかない" 应为一组
2. 旋律连贯：同一旋律乐句内的歌词归为一组
3. 呼吸点：明显的长停顿/换气处作为组分界
4. 每组通常 2-6 句

同时标注每句在组内的角色：
- start: 组的第一句（入场，镜头开始新轨道）
- mid: 组的中间句（延续，镜头保持运动）
- end: 组的最后一句（收束，镜头准备过渡到下一组）

歌词：
${lines.map((l, idx) => `${idx+1}. ${l.words.map(w=>w.text).join('')}`).join('\n')}

返回 JSON 数组，每行包含 emotion, energy, keywords, visualHint, groupId, groupRole
`;
```

### 18.6 句组内的运镜连贯

同一个 group 内，**摄像机走一条连续轨道**，不跳变：

```js
class CameraGroupController {
  private currentGroup: number = -1;
  private groupCamera: GroupCameraState = null;
  private prevGroupEndState: CameraAnchor = null;
  
  update(shot: Shot, shotProgress: number, audioTime: number) {
    // ── 句组切换：开始新的连续运镜轨道 ──
    if (shot.groupId !== this.currentGroup) {
      this.currentGroup = shot.groupId;
      
      // 为整组规划一条连续轨道（Catmull-Rom 样条经过组内所有 shot 的锚点）
      this.groupCamera = this.planGroupTrack(shot.group);
      
      // 组间过渡：不是硬切，而是用"轨道衔接"
      // 上一组的轨道终点 → 这一组的轨道起点，用一段过渡曲线连接
      if (this.prevGroupEndState) {
        this.startGroupTransition(this.prevGroupEndState, this.groupCamera.startState);
      }
    }
    
    // ── 组内：沿轨道连续运动 ──
    // shot 之间不切换轨道，只是沿轨道前进到下一个锚点
    const groupProgress = this.calcGroupProgress(shot, shotProgress);
    const camState = this.groupCamera.spline.sample(groupProgress);
    
    // 叠加节拍脉冲（不破坏轨道连续性，只做微调）
    const pulse = this.audioAnalyser.getBeatPulse(audioTime);
    camState.scale += pulse * 0.03;
    camState.x += Math.sin(audioTime * 0.01) * pulse * 5;  // 微抖
    
    return camState;
  }
  
  // 为整组规划连续轨道
  planGroupTrack(group: ShotGroup): GroupCameraState {
    const anchors = group.shots.map(shot => ({
      time: shot.startTime,
      pos: { x: shot.params.layout.offsetX * 400, 
             y: shot.params.layout.offsetY * 300 },
      scale: 1 + shot.params.layout.scale * 0.1,  // 微缩放，不夸张
      rotation: shot.params.layout.angle * 0.3,   // 微旋转
      z: 0,  // Z 轴默认 0，3D 深度堆叠另算（见第 19 章）
    }));
    
    // Catmull-Rom 样条：经过所有锚点的平滑曲线
    // 保证位移/速度/加速度连续
    return {
      spline: new CatmullRomSpline(anchors),
      startState: anchors[0],
      endState: anchors[anchors.length - 1],
      duration: group.endTime - group.startTime,
      moveType: this.pickMoveType(group.groupEmotion, group.roleInSection),
    };
  }
  
  // 组间过渡：轨道衔接（不是硬切）
  startGroupTransition(fromState: CameraAnchor, toState: CameraAnchor) {
    // 用 200-400ms 的过渡曲线连接两组轨道
    // 过渡期间画面处于"旧轨道终点 → 新轨道起点"的平滑流动中
    const duration = 300;  // ms
    // 过渡方式根据组间关系选择：
    // - 相邻组情感相似 → 轨道直接延伸（极轻过渡）
    // - 相邻组情感变化大 → 蒙版扫入 + 轨道转折（明显过渡）
    // - 段落边界 → 闪白 + 轨道重置（大过渡）
  }
  
  // 选择运镜类型：根据组级情感和组在段落中的位置
  pickMoveType(emotion: EmotionTag, role: string): string {
    const map = {
      'sorrow': { opening: 'pan', building: 'push', peak: 'dive', resolving: 'tilt', transition: 'pan' },
      'anger':   { opening: 'pan', building: 'push', peak: 'orbit', resolving: 'pan', transition: 'dive' },
      'love':    { opening: 'push', building: 'orbit', peak: 'push', resolving: 'tilt', transition: 'pan' },
      'hope':    { opening: 'push', building: 'push', peak: 'dive', resolving: 'orbit', transition: 'push' },
    };
    return map[emotion]?.[role] || 'pan';
  }
}
```

### 18.7 句组内的场景共享

同一个 group 内，**场景（背景纹理 + 色板 + 装饰风格）共享**，只有词块和装饰微调变：

```js
// 组内 shot 的装饰从"同一族"中取，不是随机跳
function pickDecorationForShot(shot: Shot, groupScene: SceneState): Decoration {
  // 用 groupScene.decorationSeed 作为种子系列
  // 组内所有 shot 用同一个种子 → 装饰是"同族变体"
  // 而不是每个 shot 随机选 → 避免风格跳变
  const rng = seededRandom(groupScene.decorationSeed + shot.indexInGroup);
  
  // 从装饰池中选，但限定在"同族"子集
  // 例如：族=集中線 → 组内所有 shot 都用集中線的变体
  //      只是数量/角度/大小略变，不跳到方括号或圆环
  return pickFromFamily(groupScene.decorationFamily, rng);
}
```

### 18.8 三级之间的过渡策略

```
Level 1 (Shot → Shot，组内)：
  - 镜头不停，沿轨道继续
  - 逐字入场/出场动画不同
  - 装饰微调（同族变体）
  - 过渡：极轻（扫描线扫过 / 1帧白闪 / 词块直接替换）
  - 时长：50-150ms

Level 2 (Group → Group，句组间)：
  - 镜头从旧轨道平滑过渡到新轨道
  - 场景变换（纹理类型/色板可能换）
  - 过渡：明显但平滑
    · 蒙版扫入（clip-path 扫过）
    · 轨道衔接（曲线连接两组轨道）
    · 余韻残像（旧组文字推到背景层，新组叠上）
  - 时长：200-400ms

Level 3 (Section → Section，段落间)：
  - 整体氛围基调变化
  - 预设/色板/纹理/运镜强度全换
  - 过渡：大变化
    · 闪白 + 场景重建
    · 镜头穿退（dive 反向 → 镜头拉远穿过所有背景层）
    · 大幅缩放（从特写拉到全景）
    · 3D 深度清理（所有旧背景层快速向远处消散）
  - 时长：400-800ms
```

### 18.9 过渡烈度与情感/段落的关系

过渡的"烈度"不是写死的，由**段落数量 + 组间情感差异**共同决定：

```js
function calcTransitionIntensity(
  fromGroup: ShotGroup, 
  toGroup: ShotGroup,
  section: SongSection,
): TransitionIntensity {
  // 段落边界 → 最大烈度
  if (fromGroup.sectionId !== toGroup.sectionId) {
    return { level: 'section', duration: 600, type: 'flash-rebuild' };
  }
  
  // 组间情感差异 → 中等烈度
  const emotionDiff = emotionDistance(fromGroup.groupEmotion, toGroup.groupEmotion);
  if (emotionDiff > 0.5) {
    return { level: 'group-strong', duration: 350, type: 'mask-sweep' };
  }
  
  // 相邻组情感相似 → 轻过渡
  return { level: 'group-light', duration: 200, type: 'track-extend' };
}

// 情感距离计算（不同情感之间的"跳跃感"）
function emotionDistance(a: EmotionTag, b: EmotionTag): number {
  if (a === b) return 0;  // 相同情感 → 无跳跃
  const opposite = { sorrow: 'hope', anger: 'love', betray: 'love' };
  if (opposite[a] === b) return 1.0;  // 对立情感 → 最大跳跃
  return 0.5;  // 不同但不对立 → 中等跳跃
}
```

### 18.10 完整示例：《妄想感傷代償連盟》副歌段

```
Section: chorus (能量 0.9, 预设=故障凌厉, 色板=红/品红/黑)

  Group-1 (scene: 网点纹理+红色, camera: 横移轨道, emotion: anger)
    shot1: "僕は"     → 逐字爆入, 装饰=集中線(族)
    shot2: "嘘で"     → 逐字故障入场, 装饰=集中線变体(同族)
    shot3: "染まった" → 逐字爆入, 装饰=集中線变体(同族)
    [镜头全程横移，不停——轨道连续]

  ── 组间过渡：蒙版扫入 + 轨道衔接 300ms ──
  （旧组"染まった"推到背景层 Z=-200，新组在前方演）

  Group-2 (scene: 扫描线纹理+品红, camera: 推进轨道, emotion: betray)
    shot4: "それでも"  → 逐字弹入, 装饰=方括号(族)
    shot5: "いいと"    → 逐字弹入, 装饰=方括号变体(同族)
    shot6: "笑った"    → 逐字爆入, 装饰=方括号变体(同族)
    [镜头全程推进，不停——轨道连续]

  ── 组间过渡：闪白 + 余韻残像 200ms ──
  （旧组"笑った"推到背景层 Z=-400，叠在 Group-1 后面）

  Group-3 (scene: 噪点纹理+红, camera: 环绕轨道, emotion: anger)
    shot7: "もう"      → 逐字故障入场, 装饰=瞄准框(族)
    shot8: "戻れない"  → 逐字爆入, 装饰=瞄准框变体(同族)
    [镜头全程环绕，不停——轨道连续]

  ── 段落过渡：镜头穿退 + 3D 深度清理 600ms ──
  （所有背景层快速向远处消散，镜头拉回到全景，准备进入下一段落）
```

**关键效果**：每个 group 内镜头连续运动 + 场景共享，group 之间才有明显场景切换——这样 100 个 shot 不是 100 次跳变，而是大约 15-20 个 group = 15-20 次场景切换，节奏舒服。

### 18.11 轨道样条实现

```js
// Catmull-Rom 样条：经过所有锚点的平滑曲线
// 保证位移/速度/加速度连续（一阶二阶可导）
class CatmullRomSpline {
  private anchors: CameraAnchor[];
  
  constructor(anchors: CameraAnchor[]) {
    this.anchors = anchors;
  }
  
  // 采样：t ∈ [0, 1]，返回该时刻的摄像机状态
  sample(t: number): CameraState {
    // 1. 找到 t 落在哪两个锚点之间
    const n = this.anchors.length - 1;
    const scaledT = t * n;
    const i = Math.floor(scaledT);
    const localT = scaledT - i;
    
    // 2. 获取周围的锚点（Catmull-Rom 需要 4 个点）
    const p0 = this.anchors[Math.max(0, i - 1)];
    const p1 = this.anchors[i];
    const p2 = this.anchors[Math.min(n, i + 1)];
    const p3 = this.anchors[Math.min(n, i + 2)];
    
    // 3. Catmull-Rom 插值
    return {
      x: this.crm(p0.x, p1.x, p2.x, p3.x, localT),
      y: this.crm(p0.y, p1.y, p2.y, p3.y, localT),
      z: this.crm(p0.z, p1.z, p2.z, p3.z, localT),
      scale: this.crm(p0.scale, p1.scale, p2.scale, p3.scale, localT),
      rotation: this.crm(p0.rotation, p1.rotation, p2.rotation, p3.rotation, localT),
    };
  }
  
  // Catmull-Rom 插值公式
  private crm(p0, p1, p2, p3, t): number {
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (
      (2 * p1) +
      (-p0 + p2) * t +
      (2*p0 - 5*p1 + 4*p2 - p3) * t2 +
      (-p0 + 3*p1 - 3*p2 + p3) * t3
    );
  }
}
```

### 18.12 装饰族系统

装饰不是每个 shot 随机选，而是以"族"为单位，组内共享族、shot 内取变体：

```js
// 装饰族定义
const DECORATION_FAMILIES = {
  'concentric-lines': {
    // 集中線族：放射线变体
    variants: [
      { type: 'concentric', count: 12, angle: 0, length: 200 },
      { type: 'concentric', count: 16, angle: 15, length: 250 },
      { type: 'concentric', count: 8, angle: -10, length: 180 },
      { type: 'concentric', count: 20, angle: 5, length: 300 },
    ],
  },
  'brackets': {
    // 方括号族：L型瞄准框变体
    variants: [
      { type: 'bracket', size: 60, corner: 'all', thickness: 3 },
      { type: 'bracket', size: 80, corner: 'tl-br', thickness: 2 },
      { type: 'bracket', size: 50, corner: 'all', thickness: 4 },
    ],
  },
  'circles': {
    // 圆环族
    variants: [
      { type: 'ring', radius: 150, thickness: 2, count: 1 },
      { type: 'ring', radius: 100, thickness: 1, count: 3, spacing: 30 },
      { type: 'ring', radius: 200, thickness: 3, count: 1, dashed: true },
    ],
  },
  'grid': {
    // 网格族
    variants: [
      { type: 'grid', spacing: 40, thickness: 1, opacity: 0.3 },
      { type: 'grid', spacing: 60, thickness: 1, opacity: 0.2 },
      { type: 'grid', spacing: 30, thickness: 2, opacity: 0.4 },
    ],
  },
};

// 族选择：根据组级情感决定
function pickDecorationFamily(emotion: EmotionTag, energy: number): string {
  if (energy > 0.7) return 'concentric-lines';  // 高能 → 集中線
  if (emotion === 'betray') return 'grid';       // 背叛 → 网格（冰冷感）
  if (emotion === 'love') return 'circles';      // 爱 → 圆环（柔和）
  return 'brackets';                              // 默认 → 方括号
}
```

---

## 19. 3D 深度堆叠与背景化

### 19.1 核心概念：已完成的句组作为背景层

当一组句子演完后，不直接删除，而是**推到 Z 轴深处成为背景层**。新句组在前方演出，旧句组在背景中可见——形成纵深堆叠，画面有"历史感"和"层次感"。

```
Z 轴深度堆叠示意（侧视图）：

  镜头位置
  ────►
         │
         │  ← Group-N（当前，正在演）Z=0
         │
         │  ← Group-N-1（刚演完）Z=-300，缩放 0.7，模糊 2px
         │
         │  ← Group-N-2（更早）Z=-600，缩放 0.5，模糊 4px
         │
         │  ← Group-N-3（更更早）Z=-900，缩放 0.35，模糊 6px，透明度 0.3
         │
         │  ← Group-N-4+（最远，渐隐）Z=-1200+，缩放 0.2，透明度 0.1
         │
```

### 19.2 背景化的触发时机

背景化在**句组切换**（Level 2 过渡）时触发：

```js
class DepthStackManager {
  private backgroundLayers: BackgroundLayer[] = [];
  private maxLayers: number = 5;  // 最多保留 5 层背景，更老的丢弃
  
  // 句组结束时调用
  pushGroupToBackground(group: ShotGroup, scene: SceneState) {
    // 1. 把刚演完的句组"快照"成一个背景层
    const layer: BackgroundLayer = {
      id: group.id,
      content: this.snapshotGroupContent(group),  // 文字 + 装饰的静态快照
      z: 0,          // 初始 Z=0（当前位置）
      targetZ: -300, // 目标 Z=-300（推到背景）
      scale: 1,
      targetScale: 0.7,
      blur: 0,
      targetBlur: 2,       // px
      opacity: 1,
      targetOpacity: 0.5,
      emotion: group.groupEmotion,
      texture: scene.textureType,
      palette: scene.palette,
    };
    
    // 2. 推入背景层栈
    this.backgroundLayers.push(layer);
    
    // 3. 把所有已有背景层再往深处推一层
    this.shiftAllLayersDeeper();
    
    // 4. 超过最大层数 → 丢弃最老的（渐隐消失）
    if (this.backgroundLayers.length > this.maxLayers) {
      this.fadeOutOldest();
    }
    
    // 5. 启动动画：当前层推到目标深度
    this.animateToDepth(layer);
  }
  
  // 所有已有背景层再往深处推
  private shiftAllLayersDeeper() {
    const DEPTH_STEP = 300;  // 每层间隔 300px
    for (let i = 0; i < this.backgroundLayers.length - 1; i++) {
      const layer = this.backgroundLayers[i];
      layer.targetZ -= DEPTH_STEP;
      layer.targetScale *= 0.85;
      layer.targetBlur += 2;
      layer.targetOpacity *= 0.7;
      this.animateToDepth(layer);
    }
  }
  
  // 动画到目标深度（平滑过渡，不跳变）
  private animateToDepth(layer: BackgroundLayer) {
    const el = layer.content;
    el.animate([
      { 
        transform: `translateZ(${layer.z}px) scale(${layer.scale})`,
        filter: `blur(${layer.blur}px)`,
        opacity: layer.opacity,
      },
      { 
        transform: `translateZ(${layer.targetZ}px) scale(${layer.targetScale})`,
        filter: `blur(${layer.targetBlur}px)`,
        opacity: layer.targetOpacity,
      },
    ], {
      duration: 400,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',  // ease-out
      fill: 'forwards',
    });
    
    layer.z = layer.targetZ;
    layer.scale = layer.targetScale;
    layer.blur = layer.targetBlur;
    layer.opacity = layer.targetOpacity;
  }
}
```

### 19.3 背景层的视觉参数

越深的背景层越虚化——通过缩放、模糊、透明度三个参数控制：

| 深度层 | Z 值 | 缩放 | 模糊 | 透明度 | 视觉效果 |
|---|---|---|---|---|---|
| 当前层（在演） | 0 | 1.0 | 0px | 1.0 | 清晰、前景 |
| 第 1 层背景 | -300 | 0.7 | 2px | 0.5 | 可辨认、虚化 |
| 第 2 层背景 | -600 | 0.5 | 4px | 0.35 | 模糊轮廓 |
| 第 3 层背景 | -900 | 0.35 | 6px | 0.2 | 仅影子 |
| 第 4 层背景 | -1200 | 0.2 | 8px | 0.1 | 几乎不可见 |
| 第 5 层+ | -1500+ | 0.1 | 12px | 0.0 | 淡出消失 |

### 19.4 背景层的动态行为

背景层不是静态的——它们可以**随当前镜头运动**产生视差效果，也可以被**特殊运镜穿透**：

```js
class BackgroundLayerController {
  // 视差效果：背景层随当前镜头轻微移动（但幅度更小）
  updateParallax(camState: CameraState, layer: BackgroundLayer) {
    // 越深的层移动幅度越小（视差原理）
    const parallaxFactor = 1 - Math.abs(layer.z) / 1500;  // 0~1
    const parallaxX = camState.x * parallaxFactor * 0.3;
    const parallaxY = camState.y * parallaxFactor * 0.3;
    
    // 应用到背景层（在原有 transform 基础上叠加）
    layer.content.style.transform = 
      `translateZ(${layer.z}px) ` +
      `translate(${parallaxX}px, ${parallaxY}px) ` +
      `scale(${layer.scale})`;
  }
  
  // 镜头穿透：镜头向 Z 轴深处推进时穿过背景层
  // 当 camState.z 接近某背景层的 z 时，该层"放大掠过"
  flyThroughCheck(camState: CameraState, layers: BackgroundLayer[]) {
    for (const layer of layers) {
      const distance = Math.abs(camState.z - layer.z);
      if (distance < 150) {
        // 镜头正在穿过这一层 → 放大效果
        const proximity = 1 - distance / 150;  // 0~1
        layer.content.style.transform = 
          `translateZ(${layer.z - camState.z}px) ` +
          `scale(${layer.scale + proximity * 0.5})`;  // 接近时放大
        layer.content.style.opacity = String(layer.opacity + proximity * 0.3);
      }
    }
  }
  
  // 背景层旋转：所有背景层可以整体缓慢旋转，增加空间感
  updateGlobalRotation(camState: CameraState, layers: BackgroundLayer[]) {
    const globalRotY = camState.rotY * 0.3;  // 背景旋转幅度是前景的 30%
    for (const layer of layers) {
      // 在原有 transform 上叠加 Y 轴旋转
      // ...
    }
  }
}
```

### 19.5 深度堆叠的运镜类型

利用背景层的 Z 轴深度，可以实现特殊的 3D 运镜效果：

| 运镜类型 | 描述 | 效果 |
|---|---|---|
| **dolly-through（穿越）** | 镜头沿 Z 轴前进，穿过所有背景层 | 像穿过文字隧道，旧歌词从身边掠过 |
| **pull-back（拉远）** | 镜头沿 Z 轴后退，所有层缩小 | 从特写拉到全景，看到所有背景层堆叠 |
| **orbit-depth（纵深环绕）** | 镜头绕 Z 轴旋转，背景层产生视差 | 3D 空间感，层与层之间有相对运动 |
| **tilt-depth（纵深倾斜）** | 镜头绕 X 轴旋转，背景层透视变化 | 俯视/仰视所有堆叠的歌词层 |
| **zoom-pulse（纵深脉冲）** | 节拍驱动 Z 轴微推拉 | 所有层同时呼吸缩放，越深的层幅度越小 |

```js
const DEPTH_CAMERA_MOVES = {
  // 穿越：镜头沿 Z 前进
  'dolly-through': (t, layers) => ({
    z: lerp(0, -1200, t),  // 镜头 Z 从 0 到 -1200
    // 当镜头 Z 接近某层 Z 时，该层放大掠过
  }),
  
  // 拉远：镜头后退
  'pull-back': (t, layers) => ({
    z: lerp(0, 400, t),     // 镜头 Z 从 0 到 +400（后退）
    scale: lerp(1, 0.6, t),  // 整体缩小
  }),
  
  // 纵深环绕
  'orbit-depth': (t, layers) => {
    const angle = t * Math.PI * 2;
    return {
      x: Math.sin(angle) * 200,
      z: Math.cos(angle) * 200,
      rotY: -angle * 180 / Math.PI,
    };
  },
  
  // 纵深倾斜
  'tilt-depth': (t) => ({
    rotX: lerp(0, 35, easeInOut(t)),
    y: lerp(0, -80, t),
  }),
  
  // 脉冲呼吸
  'zoom-pulse': (t, pulse) => ({
    z: pulse * 20,           // 节拍驱动微推拉
    scale: 1 + pulse * 0.03,
  }),
};
```

### 19.6 段落切换时的深度清理

段落切换（Level 3 过渡）时，需要清理所有背景层——不是瞬间删除，而是**向远处快速消散**：

```js
class DepthStackManager {
  // 段落切换：所有背景层快速消散
  clearAllForSectionTransition() {
    for (const layer of this.backgroundLayers) {
      layer.targetZ = -3000;    // 推到极远
      layer.targetScale = 0.05; // 极小
      layer.targetBlur = 20;   // 极糊
      layer.targetOpacity = 0; // 透明
      this.animateToDepth(layer);
    }
    
    // 动画结束后清空数组
    setTimeout(() => {
      this.backgroundLayers = [];
    }, 600);
  }
}
```

### 19.7 背景层与前景层的渲染层级

```html
<!-- 3D 空间结构 -->
<div id="pvViewContainer" style="perspective: 800px; transform-style: preserve-3d;">
  
  <!-- 背景层栈（从远到近）-->
  <div id="bgLayer-4" style="transform: translateZ(-1200px) scale(0.2); filter: blur(8px); opacity: 0.1;"></div>
  <div id="bgLayer-3" style="transform: translateZ(-900px) scale(0.35); filter: blur(6px); opacity: 0.2;"></div>
  <div id="bgLayer-2" style="transform: translateZ(-600px) scale(0.5); filter: blur(4px); opacity: 0.35;"></div>
  <div id="bgLayer-1" style="transform: translateZ(-300px) scale(0.7); filter: blur(2px); opacity: 0.5;"></div>
  
  <!-- 当前演出层（前景）-->
  <div id="currentGroupLayer" style="transform: translateZ(0px);">
    <!-- 当前句组的文字 + 装饰 + 纹理 -->
  </div>
  
  <!-- 摄像机层（控制所有层的整体 transform）-->
  <div id="cameraLayer" style="transform-style: preserve-3d;">
    <!-- 通过 transform 控制视角 -->
  </div>
</div>
```

### 19.8 背景层的"拉伸"效果

背景层不只是静止的快照——可以做**拉伸变形**，让画面更有张力：

```js
// 背景层拉伸：根据当前运镜方向拉伸旧歌词
function stretchBackgroundLayer(layer: BackgroundLayer, camMove: CameraMove) {
  const stretchAxis = camMove.axis;  // 'x' | 'y'
  const stretchAmount = camMove.intensity * 0.3;
  
  // 在移动方向上拉伸，垂直方向压扁（运动模糊感）
  layer.content.style.transform = 
    `translateZ(${layer.z}px) ` +
    `scale(${stretchAxis === 'x' ? 1 + stretchAmount : 1 - stretchAmount * 0.3}` +
           `${stretchAxis === 'y' ? 1 + stretchAmount : 1 - stretchAmount * 0.3})`;
}

// 例子：当前镜头在横向移动
// → 所有背景层在横向上被拉伸，纵向上被压扁
// → 营造"速度感"和"运动模糊感"
// → 但因为是 CSS transform 实现的，不消耗 blur 滤镜性能
```

### 19.9 完整的深度堆叠 + 三级连贯工作流程

```js
class PVDepthTimeline {
  private depthStack: DepthStackManager;
  private cameraController: CameraGroupController;
  private renderer: PVRenderer;
  
  update(audioTime: number) {
    // 1. 找到当前 shot
    const shot = this.findShotAt(audioTime);
    
    // 2. 检测句组切换
    if (shot.groupId !== this.currentGroupId) {
      // ── Level 2 过渡 ──
      // 把旧组推到背景层
      if (this.currentGroup) {
        this.depthStack.pushGroupToBackground(this.currentGroup, this.currentScene);
      }
      // 新组开始新的轨道
      this.currentGroupId = shot.groupId;
      this.currentGroup = this.getGroup(shot.groupId);
      this.currentScene = this.currentGroup.scene;
    }
    
    // 3. 检测段落切换
    if (shot.sectionId !== this.currentSectionId) {
      // ── Level 3 过渡 ──
      // 所有背景层快速消散
      this.depthStack.clearAllForSectionTransition();
      this.currentSectionId = shot.sectionId;
    }
    
    // 4. 摄像机更新（组内连续轨道 + 节拍脉冲 + 3D 深度运镜）
    const shotProgress = (audioTime - shot.startTime) / shot.duration;
    const camState = this.cameraController.update(shot, shotProgress, audioTime);
    
    // 5. 背景层视差更新
    for (const layer of this.depthStack.backgroundLayers) {
      this.renderer.updateBackgroundParallax(layer, camState);
    }
    
    // 6. 渲染
    this.renderer.render(shot, shotProgress, camState, this.depthStack.backgroundLayers);
  }
}
```

### 19.10 背景层与装饰层的协同

背景层不仅保留旧歌词文字，还保留旧装饰——越深的背景层装饰也越虚化，形成层次：

```
前景（当前组）：
  ├ 文字（清晰、强调色、发光）
  ├ 装饰（集中線，清晰）
  └ 纹理（网点，正常密度）

背景层 1（刚演完的组）：
  ├ 文字（白色、模糊 2px、半透明）
  ├ 装饰（集中線变体，模糊 2px、半透明）
  └ 纹理（同类型网点，低密度）

背景层 2（更早的组）：
  ├ 文字（灰色、模糊 4px、更透明）
  ├ 装饰（方括号变体，模糊 4px）
  └ 纹理（不同类型，极低密度）

背景层 3+（最远）：
  └ 仅剩模糊的色块和文字影子
```

### 19.11 性能控制

3D 深度堆叠的性能开销主要在 `filter: blur()` 上：

```js
class DepthStackManager {
  private maxLayers: number = 5;

  // 性能降级策略
  applyPerformanceTier(tier: 'high' | 'medium' | 'low') {
    if (tier === 'high') {
      this.maxLayers = 5;
      // 所有层都用 filter: blur
    } else if (tier === 'medium') {
      this.maxLayers = 3;
      // 只对最近的 1 层用 blur，更远的用 opacity 代替
    } else {
      this.maxLayers = 2;
      // 不用 blur，只用 opacity + scale 模拟
    }
  }

  // 低性能替代：用 opacity 代替 blur
  getBlurStyle(layer: BackgroundLayer, tier: string): string {
    if (tier === 'low') return 'none';
    return `blur(${layer.blur}px)`;
  }
}
```

### 19.12 高级 3D 变换矩阵

除了基础的 scale/translate/blur，背景层还可以施加**完整的 3D 变换矩阵**，让旧歌词在背景中产生丰富的空间变形：

```js
class Background3DTransformer {

  // 1. 透视翘曲：背景层的四角向不同方向偏移，产生"歪斜墙面"效果
  perspectiveWarp(layer: BackgroundLayer, intensity: number) {
    // 模拟 perspective-origin 偏移
    const skewX = intensity * 8;   // 度
    const skewY = intensity * 3;
    layer.content.style.transform =
      `translateZ(${layer.z}px) ` +
      `scale(${layer.scale}) ` +
      `skew(${skewX}deg, ${skewY}deg)`;
    // 效果：旧歌词像一面被风吹歪的墙，在背景中微微倾斜
  }

  // 2. Z 轴旋转涟漪：每个背景层以不同速度绕 Z 轴旋转
  zAxisRipple(layers: BackgroundLayer[], audioTime: number) {
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      // 越深的层旋转越慢、幅度越小
      const depthFactor = 1 - Math.abs(layer.z) / 1500;
      const rotSpeed = 0.3 + depthFactor * 0.7;     // rad/s
      const rotAmp = 2 + depthFactor * 6;           // 度
      const rotZ = Math.sin(audioTime * rotSpeed) * rotAmp;

      layer.content.style.transform =
        `translateZ(${layer.z}px) ` +
        `scale(${layer.scale}) ` +
        `rotateZ(${rotZ}deg)`;
    }
    // 效果：背景层各自微微摇摆，像水波涟漪一样层层传递
  }

  // 3. 深度方向的拉伸+压缩（运动模糊感）
  // 当镜头快速移动时，背景层在移动方向上被拉长，垂直方向被压扁
  motionStretch(layer: BackgroundLayer, camVelocity: { vx: number, vy: number }) {
    const speed = Math.hypot(camVelocity.vx, camVelocity.vy);
    const angle = Math.atan2(camVelocity.vy, camVelocity.vx);  // 弧度
    const stretchAmount = Math.min(speed * 0.002, 0.15);       // 限制最大拉伸

    // 沿运动方向拉伸
    layer.content.style.transform =
      `translateZ(${layer.z}px) ` +
      `rotate(${angle}rad) ` +
      `scaleX(${1 + stretchAmount}) scaleY(${1 - stretchAmount * 0.4}) ` +
      `rotate(${-angle}rad) ` +
      `scale(${layer.scale})`;
    // 效果：快速运镜时旧歌词产生"速度线"般的拉伸变形
  }

  // 4. 3D 翻转：背景层绕 X 或 Y 轴翻转（像翻牌子的背面）
  flipTransition(layer: BackgroundLayer, axis: 'x' | 'y', t: number) {
    // t: 0→1，翻转进度
    const angle = lerp(0, 180, easeInOut(t));  // 0°→180°
    const targetAxis = axis === 'x' ? 'rotateX' : 'rotateY';
    const opacityAtMid = Math.abs(Math.cos(angle * Math.PI / 180));  // 90° 时最透明

    layer.content.style.transform =
      `translateZ(${layer.z}px) ` +
      `scale(${layer.scale}) ` +
      `${targetAxis}(${angle}deg)`;
    layer.content.style.opacity = String(layer.opacity * opacityAtMid);
    // 效果：旧歌词在背景中缓缓翻转，像翻书页一样消逝
  }

  // 5. 碎片化拆解：背景层拆成多个碎片各自飘散
  shatterEffect(layer: BackgroundLayer, t: number) {
    // 把背景层的内容分成 N×M 网格碎片
    const fragments = layer.fragments ?? this.createFragments(layer, 4, 3);
    layer.fragments = fragments;

    for (const frag of fragments) {
      // 每个碎片向不同方向飘散
      const driftX = frag.dirX * t * 80;
      const driftY = frag.dirY * t * 60;
      const driftZ = frag.dirZ * t * -200;  // 向远处飘
      const rotFrag = frag.rotSpeed * t * 360;

      frag.el.style.transform =
        `translate3d(${driftX}px, ${driftY}px, ${driftZ}px) ` +
        `rotateZ(${rotFrag}deg) ` +
        `scale(${1 - t * 0.5})`;
      frag.el.style.opacity = String(layer.opacity * (1 - t));
    }
    // 效果：旧歌词"破碎"成碎片向四周飘散，用于段落切换高潮
  }

  private createFragments(layer: BackgroundLayer, cols: number, rows: number): Fragment[] {
    // 用 clip-path 或 position 把背景层切成网格碎片
    // 每个碎片有随机的飘散方向
    const fragments: Fragment[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        fragments.push({
          el: layer.content.cloneNode(true),  // 克隆内容
          dirX: (Math.random() - 0.5) * 2,
          dirY: (Math.random() - 0.5) * 2,
          dirZ: -(Math.random() * 0.5 + 0.5),
          rotSpeed: (Math.random() - 0.5) * 2,
          clipPath: `inset(${r/rows*100}% ${c/cols*100}% ${(rows-r-1)/rows*100}% ${(cols-c-1)/cols*100}%)`,
        });
      }
    }
    return fragments;
  }
}
```

### 19.13 背景层与前景的 3D 交互

背景层不是被动的——它们可以**响应前景运动**，形成前景和背景之间的动态对话：

```js
class ForegroundBackgroundInteraction {

  // 1. 前景推力：前景文字移动时，推动背景层产生波纹
  rippleFromForeground(foregroundPos: { x: number, y: number },
                       layers: BackgroundLayer[],
                       intensity: number) {
    for (const layer of layers) {
      // 计算前景到背景层中心的距离
      const dx = foregroundPos.x - layer.centerX;
      const dy = foregroundPos.y - layer.centerY;
      const dist = Math.hypot(dx, dy);
      const maxDist = 800;

      // 距离越近、层越浅 → 影响越大
      const depthFactor = 1 - Math.abs(layer.z) / 1500;
      const proximityFactor = 1 - Math.min(dist / maxDist, 1);
      const wave = Math.sin(dist * 0.02 - performance.now() * 0.005);

      const offsetX = dx / dist * wave * intensity * depthFactor * 20;
      const offsetY = dy / dist * wave * intensity * depthFactor * 20;

      layer.content.style.transform =
        `translateZ(${layer.z}px) ` +
        `translate(${offsetX}px, ${offsetY}px) ` +
        `scale(${layer.scale})`;
    }
    // 效果：前景文字像在水面投石，波纹向背景层扩散
  }

  // 2. 背景层"呼应"前景颜色
  // 当前句组颜色变化时，背景层渐变到与前景呼应的色调
  colorEcho(foregroundPalette: Palette, layers: BackgroundLayer[]) {
    for (const layer of layers) {
      // 背景层取前景调色盘的互补色或类似色
      const echoColor = this.getEchoColor(foregroundPalette, layer.emotion);
      // 越深的层呼应越弱
      const depthFactor = 1 - Math.abs(layer.z) / 1500;
      const blendAmount = 0.3 * depthFactor;

      layer.content.style.mixBlendMode = 'screen';
      layer.content.style.filter =
        `blur(${layer.blur}px) ` +
        `hue-rotate(${echoColor.hueShift}deg) ` +
        `saturate(${1 + echoColor.satBoost * depthFactor})`;
    }
  }

  // 3. 呼吸同步：所有层（前景+背景）随节拍呼吸，但相位错开
  breatheSync(layers: BackgroundLayer[], beatPhase: number) {
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      // 每层延迟一个相位，形成"波"传递效果
      const phaseOffset = i * 0.15;
      const breathScale = 1 + Math.sin(beatPhase - phaseOffset) * 0.02 * (1 - i / layers.length);

      layer.content.style.transform =
        `translateZ(${layer.z}px) ` +
        `scale(${layer.scale * breathScale})`;
    }
    // 效果：节拍来时，缩放波从前景传向背景，像心跳脉冲
  }

  // 4. 前景"锁定"背景层：前景文字与某层背景产生连线/引力
  gravitationalLink(foregroundWords: WordElement[], layers: BackgroundLayer[]) {
    // 在最近一层背景中找到与当前文字"对应"的旧文字
    // 绘制 SVG 连线，表示"呼应"
    for (const word of foregroundWords) {
      const counterpart = this.findCounterpart(word, layers[0]);
      if (counterpart) {
        const line = this.drawLinkLine(word.position, counterpart.position);
        line.style.opacity = '0.2';
        line.style.strokeDasharray = '4 4';
        // 效果：新歌词和旧歌词之间有微弱的虚线连接，暗示"呼应"
      }
    }
  }
}
```

### 19.14 3D 粒子层

在背景层之间，可以插入**3D 粒子层**——细小的几何粒子在 Z 轴不同深度飘浮，增强空间感：

```js
class Particle3DLayer {
  private particles: Particle3D[] = [];
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  init(count: number, perspective: number) {
    for (let i = 0; i < count; i++) {
      this.particles.push({
        x: (Math.random() - 0.5) * 1920,
        y: (Math.random() - 0.5) * 1080,
        z: -(Math.random() * 1200),    // 分散在 0 到 -1200 之间
        size: Math.random() * 3 + 1,
        speed: Math.random() * 0.5 + 0.1,
        type: Math.random() > 0.5 ? 'dot' : 'line',
        opacity: Math.random() * 0.5 + 0.2,
      });
    }
  }

  update(camState: CameraState, audioTime: number) {
    const perspective = 800;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // 按 Z 排序（远→近），远的先画
    const sorted = [...this.particles].sort((a, b) => a.z - b.z);

    for (const p of sorted) {
      // 飘浮运动
      p.y += Math.sin(audioTime * p.speed + p.x) * 0.3;
      p.x += Math.cos(audioTime * p.speed + p.y) * 0.2;

      // 透视投影
      const relZ = p.z - camState.z;     // 相对镜头的 Z
      if (relZ >= 0) continue;            // 在镜头后方，跳过
      const scale = perspective / (perspective - relZ);
      const projX = p.x * scale + camState.x * scale * 0.3;  // 视差
      const projY = p.y * scale + camState.y * scale * 0.3;
      const projSize = p.size * scale;

      // 越远的粒子越暗
      const depthAlpha = p.opacity * Math.max(1 - Math.abs(relZ) / 1500, 0.1);

      this.ctx.fillStyle = `rgba(255, 255, 255, ${depthAlpha})`;
      if (p.type === 'dot') {
        this.ctx.beginPath();
        this.ctx.arc(projX, projY, projSize, 0, Math.PI * 2);
        this.ctx.fill();
      } else {
        this.ctx.strokeStyle = `rgba(255, 255, 255, ${depthAlpha})`;
        this.ctx.lineWidth = projSize * 0.5;
        this.ctx.beginPath();
        this.ctx.moveTo(projX, projY);
        this.ctx.lineTo(projX + projSize * 4, projY);
        this.ctx.stroke();
      }
    }
  }
}
```

```
3D 粒子层在空间中的分布（侧视图）：

  镜头 ────►
  │                           ·    ·        ← Z=-1100，极小、极暗
  │              ·         ·       ·       ← Z=-800
  │      ·          ·    ·                  ← Z=-500
  │  ·       ·                         ·    ← Z=-200
  │  ═════════════════════════════════════  ← Z=0 当前演出层
  │    ·           ·              ·          ← Z=200 前景粒子
  │
  说明：粒子分布在镜头前方和后方不同深度
  → 镜头移动时产生强烈视差
  → 远处粒子几乎不动，近处粒子快速划过
  → 空间感如同"在星云中穿行"
```

### 19.15 Z 轴光照与阴影

利用 3D 空间的 Z 轴深度，可以模拟**光源照射**效果——越靠近镜头（Z 值越大）的层越亮，越远的层越暗：

```js
class DepthLighting {

  // 1. 方向光：模拟从镜头位置发出的光，近亮远暗
  applyDirectionalLight(layers: BackgroundLayer[]) {
    for (const layer of layers) {
      // Z=0 → brightness 1.0，Z=-1200 → brightness 0.4
      const brightness = 1 - Math.abs(layer.z) / 1200 * 0.6;
      layer.content.style.filter =
        `blur(${layer.blur}px) ` +
        `brightness(${brightness})`;
    }
  }

  // 2. 聚光灯效果：当前演出位置最亮，向外衰减
  spotlight(foregroundCenter: { x: number, y: number },
            layers: BackgroundLayer[],
            beamAngle: number = 30) {
    for (const layer of layers) {
      const dx = layer.centerX - foregroundCenter.x;
      const dy = layer.centerY - foregroundCenter.y;
      const dist = Math.hypot(dx, dy);
      const maxBeam = 600 + layer.z * -0.3;  // 越深的层光束范围越大

      // 聚光灯内 → 正常亮度，外面 → 变暗
      const inBeam = dist < maxBeam;
      const lightFactor = inBeam
        ? 1.0
        : Math.max(1 - (dist - maxBeam) / 300, 0.3);

      layer.content.style.filter =
        `blur(${layer.blur}px) ` +
        `brightness(${lightFactor}) ` +
        `contrast(${1 + (1 - lightFactor) * 0.2})`;  // 暗处提高对比度
    }
    // 效果：当前歌词位置像被聚光灯照亮，旧歌词隐没在黑暗中
  }

  // 3. 彩色光晕：根据情感给不同深度的层上色
  emotionalLighting(layers: BackgroundLayer[], currentEmotion: EmotionTag) {
    const lightColor = this.getEmotionLightColor(currentEmotion);

    for (const layer of layers) {
      // 越近的层受当前情绪光影响越大
      const depthFactor = 1 - Math.abs(layer.z) / 1500;
      const hueShift = lightColor.hue * depthFactor;
      const satBoost = lightColor.sat * depthFactor;

      layer.content.style.filter =
        `blur(${layer.blur}px) ` +
        `hue-rotate(${hueShift}deg) ` +
        `saturate(${1 + satBoost})`;
    }
    // 效果：当前情绪（如"悲伤"→冷蓝色光）从前景向背景层蔓延
  }

  // 4. 投影：前景文字在最近一层背景上产生"投影"
  castShadow(foregroundText: HTMLElement, bgLayer: BackgroundLayer) {
    const shadow = bgLayer.content.querySelector('.fg-shadow') as HTMLElement;
    if (!shadow) return;

    // 投影偏移方向取决于"光源"位置（假设光从左上方来）
    const shadowOffsetX = 8;
    const shadowOffsetY = 8;
    const shadowBlur = 4 + Math.abs(bgLayer.z) / 300;  // 越远的层投影越糊

    shadow.style.transform =
      `translate(${shadowOffsetX}px, ${shadowOffsetY}px)`;
    shadow.style.filter = `blur(${shadowBlur}px)`;
    shadow.style.opacity = '0.3';
    shadow.style.color = 'rgba(0, 0, 0, 0.5)';
    // 效果：前景文字像浮雕一样在背景上投下影子
  }
}
```

### 19.16 深度景深（DOF）效果

模拟真实摄像机的**景深效果**——只有特定深度范围内的层清晰，更远或更近的层模糊：

```js
class DepthOfField {
  private focusZ: number = 0;       // 当前焦点 Z 值
  private focusRange: number = 400; // 焦点前后清晰范围

  // 根据镜头运动动态调整焦点
  updateFocus(camState: CameraState, currentGroupZ: number) {
    // 焦点跟随当前演出层
    this.focusZ = currentGroupZ;

    // 镜头快速移动时扩大景深范围（减少模糊感）
    const speed = Math.hypot(camState.vx, camState.vy);
    this.focusRange = 400 + speed * 2;
  }

  applyDOF(layers: BackgroundLayer[]) {
    for (const layer of layers) {
      const distFromFocus = Math.abs(layer.z - this.focusZ);

      if (distFromFocus <= this.focusRange) {
        // 在景深范围内 → 清晰
        layer.content.style.filter = `blur(0px)`;
        layer.content.style.opacity = '1';
      } else {
        // 越远越模糊
        const blurAmount = (distFromFocus - this.focusRange) / 100;
        layer.content.style.filter =
          `blur(${Math.min(blurAmount, 10)}px)`;
        layer.content.style.opacity =
          String(Math.max(1 - blurAmount * 0.1, 0.1));
      }
    }
  }

  // 焦点转移动画：从聚焦前景→聚焦背景层（用于特殊运镜）
  rackFocus(targetLayer: BackgroundLayer, duration: number = 800) {
    const startFocus = this.focusZ;
    const endFocus = targetLayer.z;
    const startTime = performance.now();

    const animate = (now: number) => {
      const t = Math.min((now - startTime) / duration, 1);
      const eased = easeInOut(t);
      this.focusZ = lerp(startFocus, endFocus, eased);
      // applyDOF 在主循环中调用，会自动应用新焦点

      if (t < 1) requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
    // 效果：像电影里的焦点转移——前景模糊、背景变清晰，
    //       观众注意力从当前歌词被引导到旧歌词上
  }
}
```

### 19.17 3D 运镜预设库（扩展）

在原有 19.5 的基础运镜之上，扩展更多**复合 3D 运镜预设**，利用背景层深度实现高级效果：

```js
const DEPTH_CAMERA_PRESETS_EXT = {

  // 1. 隧道穿越+旋转：镜头沿 Z 前进的同时绕 Z 轴旋转
  // 效果：像穿过旋转的文字隧道
  'tunnel-spin': (t, layers, beat) => {
    const z = lerp(0, -1000, easeInOut(t));
    const rotZ = t * 90;  // 整体旋转 90°
    const breath = Math.sin(beat * Math.PI * 2) * 0.02;
    return { z, rotZ, scale: 1 + breath };
  },

  // 2. 螺旋上升：镜头沿 Y 轴上升的同时绕 Y 轴旋转
  // 效果：像螺旋楼梯视角，背景层在周围旋转
  'spiral-ascent': (t, layers) => {
    const y = lerp(0, -300, t);
    const rotY = t * 360;  // 整圈旋转
    const z = Math.sin(t * Math.PI * 4) * 50;  // Z 轴呼吸
    return { y, rotY, z };
  },

  // 3. 多层穿透弹弓：镜头快速向前冲穿过 N 层，然后弹回
  // 效果：高能段落，"嗖"地穿过所有旧歌词然后弹回
  'slingshot-through': (t, layers) => {
    if (t < 0.4) {
      // 0→40%：快速前冲
      const localT = t / 0.4;
      return { z: lerp(0, -800, easeIn(localT)) };
    } else if (t < 0.55) {
      // 40%→55%：最远处停留（穿越瞬间）
      return { z: -800 };
    } else {
      // 55%→100%：弹回
      const localT = (t - 0.55) / 0.45;
      return { z: lerp(-800, 100, easeOut(localT)) };
    }
  },

  // 4. 景深拉变：镜头不动，但景深焦点从前景转移到背景
  // 效果：旧歌词从模糊变清晰，当前歌词从清晰变模糊
  'rack-focus-pull': (t, layers, dof: DepthOfField) => {
    // 不动镜头，只转移景深焦点
    dof.rackFocus(layers[layers.length - 1], 1000);
    return { x: 0, y: 0, z: 0 };  // 摄像机不动
  },

  // 5. 全景纵深巡视：镜头在高处俯视所有背景层堆叠
  // 效果：像从高处俯瞰一座"歌词遗迹"
  'aerial-overview': (t, layers) => {
    const rotX = lerp(0, 55, easeInOut(t));     // 俯视角度
    const y = lerp(0, -200, t);                  // 升高
    const z = lerp(0, 300, t);                   // 后退
    return { rotX, y, z };
  },

  // 6. 背景层波浪：所有背景层像多米诺骨牌一样逐层翻转
  'domino-flip': (t, layers) => {
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      // 每层延迟触发
      const delay = i * 0.1;
      const localT = Math.max(0, Math.min((t - delay) / 0.5, 1));
      const flipAngle = easeInOut(localT) * 90;
      layer.content.style.transform =
        `translateZ(${layer.z}px) ` +
        `scale(${layer.scale}) ` +
        `rotateX(${flipAngle}deg)`;
      layer.content.style.opacity =
        String(layer.opacity * (1 - localT * 0.5));
    }
    return {};  // 摄像机本身不动
  },

  // 7. 3D 抖动手持：模拟手持摄像机的 3D 抖动
  // 所有层都有抖动，但近处抖动大、远处抖动小（视差）
  'handheld-3d': (t, layers, time) => {
    const shakeX = (Math.sin(time * 13) + Math.sin(time * 7)) * 3;
    const shakeY = (Math.cos(time * 11) + Math.sin(time * 5)) * 2;
    const shakeRot = Math.sin(time * 9) * 0.5;
    return { x: shakeX, y: shakeY, rotZ: shakeRot };
  },
};
```

### 19.18 背景层的情感联动

背景层的视觉参数可以与**歌曲的情感走向**联动——不同情感段落使用不同的背景层处理风格：

```js
const EMOTION_BG_PROFILES: Record<EmotionTag, BgProfile> = {

  // 悲伤：背景层缓慢消散，冷色调
  sad: {
    fadeSpeed: 0.8,         // 慢慢消散
    colorTreatment: 'cool',
    blurMultiplier: 1.5,    // 更模糊
    scaleShrink: 0.6,       // 缩更小
    depthSpacing: 400,      // 层间距更大 → 更空旷
    particleDensity: 'sparse',
    particleColor: 'rgba(100, 150, 255, 0.3)',  // 冷色粒子
    bgLayerRot: 'slow-sway',  // 缓慢摇摆
  },

  // 激烈：背景层快速消散，暖色调，更多变形
  intense: {
    fadeSpeed: 1.5,         // 快速消散
    colorTreatment: 'warm',
    blurMultiplier: 0.5,    // 更清晰（残留更锐利）
    scaleShrink: 0.8,       // 不缩太小
    depthSpacing: 200,      // 层间距小 → 更密集、压迫感
    particleDensity: 'dense',
    particleColor: 'rgba(255, 100, 50, 0.5)',  // 热色粒子
    bgLayerRot: 'fast-vibrate',  // 快速振动
  },

  // 温柔：背景层长时间停留，柔和色调
  gentle: {
    fadeSpeed: 0.3,         // 极慢消散 → 历史感
    colorTreatment: 'soft',
    blurMultiplier: 2.0,    // 很柔和
    scaleShrink: 0.5,
    depthSpacing: 500,      // 层间距大 → 宽松
    particleDensity: 'medium',
    particleColor: 'rgba(255, 200, 200, 0.2)',  // 粉色粒子
    bgLayerRot: 'gentle-breathe',  // 轻柔呼吸
  },

  // 神秘：背景层不完全消散，色调偏暗
  mysterious: {
    fadeSpeed: 0.2,         // 几乎不消散 → 层层累积
    colorTreatment: 'dark',
    blurMultiplier: 1.0,
    scaleShrink: 0.7,
    depthSpacing: 350,
    particleDensity: 'sparse',
    particleColor: 'rgba(150, 100, 255, 0.15)',  // 紫色幽光
    bgLayerRot: 'slow-rotate',  // 持续旋转
  },

  // 高潮/爆发：所有背景层瞬间放大推回，形成冲击
  climax: {
    fadeSpeed: 3.0,         // 瞬间消散
    colorTreatment: 'burst',
    blurMultiplier: 0.0,    // 瞬间清晰然后消失
    scaleShrink: 1.2,       // 反而放大
    depthSpacing: 100,      // 层间距极小 → 压迫
    particleDensity: 'ultra-dense',
    particleColor: 'rgba(255, 255, 255, 0.8)',  // 白色闪光
    bgLayerRot: 'explosion',  // 向四周爆散
  },
};
```

```js
class EmotionDrivenBackground {
  private currentProfile: BgProfile;
  private depthStack: DepthStackManager;
  private particleLayer: Particle3DLayer;

  // 情感切换时平滑过渡到新 profile
  transitionToEmotion(newEmotion: EmotionTag, duration: number = 1000) {
    const newProfile = EMOTION_BG_PROFILES[newEmotion];
    const oldProfile = this.currentProfile;

    // 对每个参数做插值过渡
    const startTime = performance.now();
    const animate = (now: number) => {
      const t = Math.min((now - startTime) / duration, 1);
      const eased = easeInOut(t);

      // 插值所有参数
      this.depthStack.updateParams({
        fadeSpeed: lerp(oldProfile.fadeSpeed, newProfile.fadeSpeed, eased),
        blurMultiplier: lerp(oldProfile.blurMultiplier, newProfile.blurMultiplier, eased),
        scaleShrink: lerp(oldProfile.scaleShrink, newProfile.scaleShrink, eased),
        depthSpacing: lerp(oldProfile.depthSpacing, newProfile.depthSpacing, eased),
      });

      this.particleLayer.updateParams({
        density: this.lerpDensity(oldProfile.particleDensity, newProfile.particleDensity, eased),
        color: this.lerpColor(oldProfile.particleColor, newProfile.particleColor, eased),
      });

      if (t < 1) requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);

    this.currentProfile = newProfile;
  }
}
```

### 19.19 3D 效果与运镜的整合渲染流程

将上述所有 3D 效果整合到统一渲染流程中：

```js
class PV3DRenderer {
  private depthStack: DepthStackManager;
  private bgTransformer: Background3DTransformer;
  private interaction: ForegroundBackgroundInteraction;
  private particles: Particle3DLayer;
  private lighting: DepthLighting;
  private dof: DepthOfField;
  private emotionBg: EmotionDrivenBackground;
  private cameraController: CameraGroupController;

  render(audioTime: number, beat: number) {
    // ━━ 1. 摄像机更新 ━━
    const camState = this.cameraController.update(audioTime, beat);

    // ━━ 2. 情感驱动参数更新 ━━
    this.emotionBg.update(audioTime);

    // ━━ 3. 景深焦点更新 ━━
    this.dof.updateFocus(camState, 0);

    // ━━ 4. 背景层 3D 变换 ━━
    const layers = this.depthStack.backgroundLayers;
    for (const layer of layers) {
      // 4a. 深度推移（基础动画）
      this.depthStack.applyDepthAnim(layer);

      // 4b. Z 轴涟漪旋转
      this.bgTransformer.zAxisRipple(layers, audioTime);

      // 4c. 运动拉伸
      this.bgTransformer.motionStretch(layer, camState.velocity);

      // 4d. 视差
      this.depthStack.applyParallax(camState, layer);
    }

    // ━━ 5. 前景-背景交互 ━━
    const fgCenter = this.cameraController.getForegroundCenter();
    this.interaction.rippleFromForeground(fgCenter, layers, beat);
    this.interaction.breatheSync(layers, beat);

    // ━━ 6. 光照 ━━
    this.lighting.spotlight(fgCenter, layers);
    this.lighting.emotionalLighting(layers, this.emotionBg.currentEmotion);

    // ━━ 7. 景深 ━━
    this.dof.applyDOF(layers);

    // ━━ 8. 粒子层 ━━
    this.particles.update(camState, audioTime);

    // ━━ 9. 前景渲染 ━━
    this.renderForeground(camState, audioTime);

    // ━━ 10. 投影 ━━
    if (layers.length > 0) {
      this.lighting.castShadow(this.foregroundEl, layers[0]);
    }
  }
}
```

```
3D 渲染流程时序图：

  audioTime ──►
  │
  │  ┌─ 摄像机更新（位置、旋转、速度）
  │  ├─ 情感参数更新（fadeSpeed, blur, color...）
  │  ├─ 景深焦点更新
  │  │
  │  │  ┌── 背景层循环 ──────────────────────┐
  │  │  │  4a. 深度推移                       │
  │  │  │  4b. Z 轴涟漪                      │
  │  │  │  4c. 运动拉伸                      │
  │  │  │  4d. 视差                          │
  │  │  └────────────────────────────────────┘
  │  │
  │  ├─ 前景-背景交互（波纹、呼吸同步、连线）
  │  ├─ 光照（聚光灯、情感色光）
  │  ├─ 景深应用
  │  ├─ 粒子层更新
  │  ├─ 前景渲染
  │  └─ 投影计算
  │
  ▼  合成输出到 #pvViewContainer
```

### 19.20 背景层生命周期的完整状态机

一个句组从"当前演出"到"最终消散"经历多个阶段，每个阶段有不同的 3D 表现：

```js
type BgLayerState =
  | 'active'        // 当前正在演出（Z=0）
  | 'transitioning' // 正在被推到背景（Z: 0 → -300）
  | 'settled'       // 已稳定在背景层（Z=-300，静止/视差）
  | 'drifting'      // 被新层推得更深（Z: -300 → -600）
  | 'fading'        // 超过最大层数，正在淡出（Z → -2000, opacity → 0）
  | 'shattered'     // 被特殊运镜击碎（碎片飘散）
  | 'cleared';      // 段落切换，快速消散完毕

class BgLayerStateMachine {
  transition(layer: BackgroundLayer, event: BgEvent): BgLayerState {
    switch (layer.state) {
      case 'active':
        if (event === 'group_end') return 'transitioning';
        break;
      case 'transitioning':
        if (event === 'anim_done') return 'settled';
        break;
      case 'settled':
        if (event === 'new_group_pushed') return 'drifting';
        if (event === 'section_transition') return 'cleared';
        if (event === 'shatter_trigger') return 'shattered';
        break;
      case 'drifting':
        if (event === 'anim_done') return 'settled';
        if (event === 'max_layers_exceeded') return 'fading';
        if (event === 'section_transition') return 'cleared';
        break;
      case 'fading':
        if (event === 'anim_done') return 'cleared';
        break;
      case 'shattered':
        if (event === 'anim_done') return 'cleared';
        break;
    }
    return layer.state;  // 状态不变
  }
}
```

```
背景层生命周期可视化：

  时间 ──────────────────────────────────────────────────────►

  ┌──────────┐
  │  active   │  句组正在演出（Z=0，前景）
  │           │
  └─────┬─────┘
        │ group_end
        ▼
  ┌──────────┐
  │transition│  被推到背景（Z: 0→-300，scale 1→0.7）
  │  -ing    │  → 3D 变换：perspectiveWarp + motionStretch
  └─────┬─────┘
        │ anim_done
        ▼
  ┌──────────┐  ┌──────────┐
  │ settled   │─►│ drifting │  新句组推入，此层被推更深
  │ (视差)    │  │ Z:-300   │  → Z 轴涟漪 + 呼吸同步
  └──────────┘  │  →-600   │
                └─────┬─────┘
                      │ max_layers_exceeded
                      ▼
                ┌──────────┐
                │  fading   │  淡出消失（Z→-2000, opacity→0）
                │           │  → flipTransition 或 shatterEffect
                └─────┬─────┘
                      │ anim_done
                      ▼
                ┌──────────┐
                │  cleared  │  DOM 移除
                └──────────┘

  特殊路径：
  settled/drifting ──[section_transition]──► cleared（快速消散）
  settled/drifting ──[shatter_trigger]────► shattered ──► cleared（碎片爆散）
```

---

## 20. 落地里程碑

### 20.1 实施阶段

| 阶段 | 内容 | 产出 |
|---|---|---|
| M1 | 素材库（纯几何/栅格/噪点纹理）+ 底色/颜色系统 | 一屏"像那样"的静止画面 |
| M2 | 版式单元 + 切镜乐谱 + 缝合转场 | 高频跳切也"接得上" |
| M3 | 节拍脉冲 + 长镜头轨道（连续运镜段） | 连贯运镜成型 |
| M4 | 正交预设库（风格卡） | 预设丰富 |
| M5 | 情感/段落驱动 + 性能优化 | 内容联动 |
| M6 | 多语言分词 + 拆字 + 逐字动画 | 多语言支持 |
| M7 | 3D 透视 + 几何蒙版 + 装饰层 | 视觉密度 |
| M8 | AI 联网分析 + 动态生成 + 缓存 | AI 驱动 |
| M9 | 三级连贯层级（Shot→Group→Section）+ Catmull-Rom 轨道 | 组内连贯、组间过渡 |
| M10 | 3D 深度堆叠 + 背景化 + 视差 + 穿越运镜 | 纵深层次感 |

### 20.2 完整初始化流程

```js
// 1. 初始化分词器（异步，kuromoji 需要加载字典）
const jaSeg = await JapaneseSegmenter.init();
const segmenterRouter = new SegmenterRouter({
  ja: jaSeg,
  zh: new ChineseSegmenter(),
  en: new EnglishSegmenter(),
  ko: new KoreanSegmenter(),
  mixed: new MixedSegmenter(),
});

// 2. 确认 + 分析（含 AI 分组）
const analysis = await ensureAnalysis(song, lyrics);
// analysis 包含：songContext + lineAnalyses（含 groupId, groupRole）

// 3. 解析歌词
const lines = yrcParser.parse(rawYrc);
const segmentedLines = lines.map(line => {
  const lang = detectLineLang(line.words);
  const segmenter = segmenterRouter.get(lang);
  return { ...line, lang, words: segmenter.segment(line.words) };
});

// 4. 分镜
const bpm = analysis.bpm || await detectBPM(audioElement);
const onsets = await onsetDetector.prescan(audioBuffer);
const rawShots = buildShotsByRhythm(segmentedLines, onsets, bpm);

// 5. AI 分组 → 构建 ShotGroup
const groups = buildShotGroups(rawShots, analysis.lineAnalyses);
// 每个 group 内的 shot 共享 scene + cameraTrack

// 6. 段落划分
const sections = buildSections(groups, analysis.songContext.structure);

// 7. 导演层分配
const director = new Director(preset);
director.assignShots(groups, sections);

// 8. 启动 Timeline（含深度堆叠）
const depthStack = new DepthStackManager();
const cameraController = new CameraGroupController();
const timeline = new PVDepthTimeline(
  sections, renderer, cameraController, depthStack, audioAnalyser
);
timeline.start();
```

---

## 附录：之前缺了什么、现在补了什么

| 层 | 之前 | 现在 |
|---|---|---|
| 排版 | 8 种 | **16 种**（补了パズル配置/三角/四角/角配置/回転配置等） |
| 动画 | 7 种入场 | **8 大类 × 子类**（补了ラスター歪み/一瞬グリッチ/引き伸ばし/渦巻き/砕け散る/文字分解/リサイズ変形） |
| 装饰层 | **完全缺失** | **37 种**（几何/有机/构图辅助/文字装饰） |
| 纹理 | 5 种 | **25 种**（补了 CRT/VHS/モザイク/ラフエッジ/フラクタルノイズ/ポスタリゼーション等） |
| 后处理 | 3 种 | **30 种**（补了色相シフト/コマ落ち/色反転/ストロボ等） |
| 转场缝合 | 12 种蒙版 | **8 种接续逻辑 + 14 种蒙版**（补了横→横/前→後/回転→回転 + 白黒1帧挟み/余韻/コマ落ち/重ね掛け） |
| 连贯层级 | **无分组概念** | **三级层级**（Shot→Group→Section），组内共享场景+连续轨道，组间过渡 |
| 3D 深度 | 仅词块 3D 布局 | **深度堆叠系统**（背景层 Z 轴堆叠 + 视差 + 穿越运镜 + 拉伸 + 段落清理） |

**最大遗漏是装饰层和连贯层级**——没有装饰层，画面缺少视觉密度；没有连贯层级，100 个 shot 就是 100 次跳变。补上之后：每个镜头有三层叠加（纹理底 + 装饰中 + 文字顶），句组内镜头连续运动 + 场景共享，句组间才有场景切换，旧句组推到背景层形成纵深堆叠——画面"满而不乱、连贯不碎、有层次有深度"。
