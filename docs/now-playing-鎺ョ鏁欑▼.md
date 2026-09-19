# Now Playing 接管教程（拉取跟播）

Aria 支持读取**本机 now-playing 服务**上报的「正在播放」歌曲，检测到另一款软件切歌后，自动用跨源搜索在 Aria 里同步播放同一首。服务地址、轮询间隔全由用户自行配置。

## 一、原理与数据流

```
其它播放器（网易云/QQ/酷狗/酷我/Spotify/Apple Music…）
        │ 被 now-playing-service 检测
        ▼
now-playing-service（本地 HTTP 服务，默认端口 9863）
        │ GET /api/query → JSON（歌曲信息 + 播放器信息）
        ▼
Aria「本机 Now Playing 接管」
        │ 经 Aria 8001 /proxy 同源转发轮询（天然跨域）→ 多键容错解析 → 切歌判定
        ▼
跨源搜索（网易→酷狗→QQ→酷我）→ loadOnlineSong → 在 Aria 播放
```

服务**主端点是 `http://localhost:9863/api/query`**（一次返回歌曲+播放器信息，Aria 轮询就是调它）。其余常用接口：

| 接口 | 说明 |
|---|---|
| `GET /api/query` | 歌曲 + 播放器信息 |
| `GET /api/query/track` | 仅歌曲信息 |
| `GET /api/query/hasSong` | 是否有歌曲 |
| `GET /api/query/player` | 播放器信息 |
| `GET /api/query/progress` | 进度（毫秒） |
| `GET /api/lyric` | 完整歌词（时间轴解析前端做） |
| `GET /api/query/isConnected` | 是否已连接平台 |
| `GET /api/cover/convert` | 封面 base64（POST；开 SMTC 时优先 SMTC 封面） |
| `ws://localhost:9863/api/ws/lyric` | WebSocket 实时推送（歌曲/歌词/播放状态） |

字段解析做了多键容错：`cover_url`、`artists[]`、`{data:{song:{...}}}` 嵌套、`is_playing` 等均兼容，也支持 `kthri/now-playing`（Apple Music/Spotify）和常见 `{song,singer}` 键集。

## 二、部署 now-playing-service（一次即可）

1. 到项目 **Release** 页下载整合包（无需配置的版本），解压后双击启动；
2. 首次启动可能要求安装/选择 **音频设备**，建议选「扬声器（输出）」相关的回环设备；整合包一般自带 C# 探测程序，直接运行即可；
3. 在另一款音乐软件里播放一首歌，然后浏览器打开 `http://localhost:9863/api/query`（或 `/api/query/track`），能看到类似 JSON 即部署成功：

```json
{ "data": { "title": "雾里看花", "artist": "那英", "cover": "http://...", "duration": 214, "isPlaying": true } }
```

## 三、Aria 侧配置

1. 打开 Aria 设置 → **播放** → **本机 Now Playing 接管**；
2. **启用接管**：打开；
3. **服务地址**：保持默认 `http://localhost:9863/api/query`（自建或换了端口就改成自己的；**填错也不怕**——若该路径读不到，Aria 会自动探测 `/api/query/track`、`/api/main`、`/query` 等常见路径并写回配置，无需手试）；
4. **轮询间隔(秒)**：默认 5 秒，想更跟手可调小（最小 2 秒）；
5. **自动跟播**：打开（关闭后只显示当前歌曲、不自动切 Aria 的歌）；
6. 点 **「立即试读」**，右侧状态文字应显示正在播放的歌曲名——出现该歌名即链路通了。

完成。之后别的软件切歌，Aria 会跟着搜同一首并播放（**接管本地音乐**）。

## 四、典型问题

| 现象 | 原因与处理 |
|---|---|
| 试读一直「读取失败」 | 服务未启动或地址/端口不对（会先自动探测常见路径，全失败才提示）；或 9863 被防火墙拦（放行本机回环即可）——**跨域不再是原因**：Aria 侧读取已改走 8001 同源 `/proxy` 转发，服务端不需要带 CORS 头 |
| 别家软件在播但读不到 | now-playing-service 对部分播放器需在整合包内单独勾选/安装探测模块（网易云/QQ 走窗口钩子，Spotify 系走 PDB 扫描）；确认它自己能看到歌再配 Aria |
| 报「播放失败」但歌名显示出来了 | 读取成功、跟播链路上该曲在四源都搜不到（版权/译名差异）。可尝试在服务地址后追加 `?from=netease` 类参数，或用 `kthri/now-playing` 式平铺 JSON（本模块两种结构都兼容） |
| 想用 `kthri/now-playing` | 地址填它暴露的端点（如 `http://localhost:8080/now-playing/apple-music`），字段自动兼容 |

## 五、安全提示

- 服务默认只监听本机，Aria 也只用本机地址，**不要**把 9863 暴露到局域网；
- 「接管」会持续推歌，工作时如不想被打断，直接关掉「启用接管」即可（配置保留）。