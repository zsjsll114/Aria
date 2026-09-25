<div align="center">

<img src="src-tauri/icons/icon.png" width="110" alt="Aria">

# Aria Lyric Player

[简体中文](README.md) | **English**

[![Release](https://img.shields.io/github/v/release/zsjsll114/Aria)](https://github.com/zsjsll114/Aria/releases/latest)
[![Download](https://img.shields.io/badge/download-portable%20zip-2ea44f)](https://github.com/zsjsll114/Aria/releases/latest)

**A multi-source online music player built around word-by-word lyrics: QQ / KuGou / Netease / Kuwo search, nine full-screen lyric visual modes, a desktop lyrics overlay, and AI mood analysis**

Web app + Tauri 2 desktop shell — a player built for one person's long listening sessions.

[Visual Showcase](#nine-lyric-visuals) ·
[Core Features](#core-features) ·
[Quick Start](#quick-start) ·
[FAQ](#faq) ·
[Architecture](#architecture) ·
[License](#license)

</div>

---

For personal use only. This repository contains no audio, lyrics, or cover art; online music-source APIs are provided at runtime by third-party open-source projects running locally — see the [Disclaimer](#third-party-sources-and-disclaimer) at the bottom.

## Nine Lyric Visuals

| Mode | Description |
|---|---|
| Cover | Cover art and lyrics side by side, with the full control bar |
| Lyrics | Default. Word-by-word highlighting + smooth scrolling, with translation / romaji lines |
| Fly-In | Whole-line fly-in, great for singing along |
| WordCloud | Lyrics aggregate into a word cloud that floats with playback |
| PV Art | Storyboard engine: 60 layouts rotating by section mood, poster-style typography, camera moves & particles |
| Mondrian | Mondrian color-block collage, seven layout families + depth fly-through, smooth morphing between sections |
| Tunnel | 3D particle scene with multi-layer parallax camera |
| Letterpress | Print-shop theme: words are inked in one by one, 30 rotating layouts, paper color follows section mood |
| Neon | Street-sign theme: unsung words are dark tubes that light up word by word, with a storefront watermark |

<table>
  <tr>
    <td align="center" width="33%"><img src="docs/screenshots/pv.png" width="100%" alt="PV Art"><br><sub><b>PV Art</b></sub></td>
    <td align="center" width="33%"><img src="docs/screenshots/mondrian.png" width="100%" alt="Mondrian"><br><sub><b>Mondrian</b></sub></td>
    <td align="center" width="33%"><img src="docs/screenshots/tunnel.png" width="100%" alt="Tunnel"><br><sub><b>Tunnel</b></sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/screenshots/letterpress.png" width="100%" alt="Letterpress"><br><sub><b>Letterpress</b></sub></td>
    <td align="center"><img src="docs/screenshots/neon.png" width="100%" alt="Neon"><br><sub><b>Neon</b></sub></td>
    <td align="center"><img src="docs/screenshots/wordcloud.png" width="100%" alt="WordCloud"><br><sub><b>WordCloud</b></sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/screenshots/flyin.png" width="100%" alt="Fly-In"><br><sub><b>Fly-In</b></sub></td>
    <td align="center"><img src="docs/screenshots/lyrics1.png" width="100%" alt="Lyrics"><br><sub><b>Lyrics</b></sub></td>
    <td align="center"><img src="docs/screenshots/lyrics2.png" width="100%" alt="Lyrics clean layout"><br><sub><b>Lyrics</b> (clean layout)</sub></td>
  </tr>
</table>

PV and Mondrian shine brightest with AI mood analysis enabled: the AI handles per-line pagination, emotion tagging and layout suggestions. Everything works without AI too — layouts and palettes just won't follow the song's emotion.

RTL lyrics (Arabic / Hebrew etc.) light up right-to-left automatically in every visual mode, no configuration needed.

## Core Features

| Module | Description |
|---|---|
| Word-by-word lyrics | YRC / KRC / QRC full-format word timelines, original / translation / romaji three-line layout |
| Multi-source search | QQ Music / KuGou / Netease / Kuwo with aggregated fallback; hi-fi & daily mixes via self-hosted services |
| AI mood analysis | Gemini per-line emotion tagging + chorus detection; PV / Mondrian / Neon / Letterpress adapt layout & palette to mood |
| Desktop lyrics | Standalone transparent window, free drag, click-through, local per-word interpolation |
| Local music | Local library scan + Enhanced LRC word-timeline generation + song recognition (Shazam / Vosk) |
| Playlists & favorites | Favorites / playlists / public playlist import from Netease, QQ & KuGou / play stats |
| Audio | 10-band equalizer, speed control (pitch preserved), seamless crossfade, downloads |

## Quick Start

### Portable build (regular users)

Grab `Aria-Portable.zip` from [Releases](../../releases), extract to a path with **ASCII characters only**, then:

- `Aria.exe` — desktop window version (recommended)
- `StartAria.bat` — browser web version

No Python / Node installation needed; all dependencies are bundled.

### Running from source

Prerequisites: Python 3.10+ (backend uses stdlib only), Node.js 20.19+ or 22.13+ (22 LTS recommended), Git. The desktop shell needs the Rust toolchain.
The Node floor comes from two dependencies: the QQ music-source mirror requires `^20.17.0 || >=22.9.0`, and this repo's ESLint 10 requires `^20.19.0 || ^22.13.0 || >=24`.

```bat
:: 1. Fetch music-source services into _eval\ (not committed; required once after a fresh clone)
scripts\setup-vendors.bat

:: 2. Start the local server (listens on localhost only by default)
python server.py

:: 3a. Web: open http://localhost:8001 in your browser
:: 3b. Desktop: double-click restart-aria.bat (restart + incremental cargo build, first run compiles)
```

macOS / Linux have no .bat files — run the equivalent commands manually.

## Before You Start (read these three)

1. **Mainland users going through a Cloudflare Worker proxy for AI: the page URL must be `http://localhost:8001`**, not `127.0.0.1` — the Worker validates by page Origin, and `127.0.0.1` gets `403 Forbidden`. Calling the Gemini API directly (no Worker) has no such restriction.
2. **The server listens on localhost only by default.** To use it from your phone, run `python server.py --lan`. This exposes search, proxy and config APIs (including AI keys) to your LAN — home WiFi only, turn it off afterwards.
3. **Music-source services need separate logins.** Without login it automatically falls back to the free source pool: search and playback still work, but no hi-fi, daily mixes or playlist sync. Login lives in Settings → Self-Hosted.

## Feature Guide

### Desktop Lyrics

Toggle via the "Desktop Lyrics" button at the top right. Drag the lyric bar to move it, ✕ to close, the lock button toggles click-through. Position is saved automatically after dragging. Font size, color, stroke and fonts are in Settings → Interface.

### Fonts

- Pick the global font in Settings → Fonts; each visual mode can override it in its own section under Settings → Appearance.
- **Drop files into the font folder**: put `.ttf / .otf / .woff / .woff2` files into `src/font/` at the project root (create it if missing), refresh, and they appear in every font dropdown.
- The font manager auto-categorizes into Serif / Hei / Kai / Pixel / Monospace with collapsible groups.
- Recommended fonts (large glyph coverage, free for commercial use): Noto Sans SC, Noto Serif SC, MiSans, HarmonyOS Sans, LXGW WenKai.
- **Prefer static-weight versions**: variable fonts (VF, often `-VF` in the filename) are expensive to render at full-screen sizes and may cause frame drops on low-end devices.

### Playlists & Favorites

Favorites: the heart button at the end of any row. Playlists: create / rename / delete on the "Playlists" page, with import from public Netease / QQ / KuGou playlist links.

### AI Mood Analysis

Fill in a Gemini API key under Settings → AI. For mainland networks a Cloudflare Worker proxy is recommended (`docs/cf-gemini-auth-worker.js` has a ready-made script); direct API URLs work too. Keys are stored only in your local `user_config.json` and never uploaded.

## Known Limitations

- The three third-party music-source vendors listen on `0.0.0.0` by upstream code (no host parameter passed), so they bind all NICs even without `--lan` — fully closing this requires patching the vendors, still an open item.
- Multi-monitor / mixed-DPI setups are not fully tested; external screens may show cursor or positioning offsets.
- Visual modes are GPU-heavy at fullscreen + high refresh rate; rendering does not auto-throttle when minimized.
- Variable fonts (VF) as the global font are expensive to interpolate at full-screen sizes — low-end devices should use static-weight fonts (e.g. Noto Sans SC Bold) or lower the performance tier.
- Embedded lyrics (USLT / multi-track AWLRC) may pick the wrong track on some files.

## About How This Is Built

This project is developed with extensive AI assistance: product shape, architecture decisions and code review are done by the author, while a large share of implementation, refactoring, tests and documentation is produced in collaboration with AI. No need to worry about who wrote what when filing issues — just report normally.

## FAQ

- **Blank page / can't connect**: make sure the server window is still open and port 8001 isn't taken; on desktop check `server_debug.log`.
- **Search returns nothing**: try another source; if all fail it's most likely a temporary third-party API outage — retry later.
- **Hi-fi options are greyed out**: login to that platform's self-hosted service is required.
- **AI always returns 403**: your page URL isn't `localhost` — see note 1 above.
- **Desktop lyrics in the wrong place after restart**: wait a moment after dragging before closing; if it still misbehaves, lock → unlock once.

Please report issues with the [ISSUE template](.github/ISSUE_TEMPLATE/bug_report.md) — attaching console errors and system info speeds things up a lot.

## Architecture

```
Tauri 2 shell (Rust) ── loads http://localhost:8001, spawns two sidecars
        │
Python backend (stdlib-only http.server, port 8001)
  ├ serves web/ statically + /proxy + /api/*
  └ selfhost_service.py: three Node music-source sidecars (3100/3200/3201)
```

The frontend is a framework-free sharded module system (`web/src/app/*.js`, loaded by number), with visual engines in `web/src/core/` (pvEngine / tunnelEngine / visualizers). See [AGENTS.md](AGENTS.md) and [CODE_WIKI.md](CODE_WIKI.md) for details.

## Third-Party Sources and Disclaimer

The `_eval/` directory holds local mirrors of three third-party music-source API projects (KuGouMusicApi / NeteaseCloudMusicApi / qq-music-api-node), cloned and installed by `scripts/setup-vendors.bat`. They are **not part of this repository**, follow their original licenses, and are maintained independently upstream. This project merely calls them on 127.0.0.1 and does not modify their upstream logic (`patches/` contains local fixes for the QQ mirror, used by this project only).

On top of that:

1. This repository contains and distributes no audio, lyrics, or cover art. Media content either comes from files already on your machine or is returned at runtime by the third-party APIs above.
2. Third-party APIs may change or break at any time; no availability is guaranteed.
3. This project is a personal-learning, personal-use player frontend. Please check the terms of service and copyright rules that apply in your region, and support official releases where you can. Do not use this project or its packaged builds for commercial distribution.

## Acknowledgements

- [folia-major](https://github.com/chthollyphile/folia-major) — reference for this project's visual storyboard design
- [KuGouMusicApi](https://github.com/makbkf/KuGouMusicApi) / [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) / [qq-music-api-node](https://github.com/jsososo/QQMusicApi) — music-source APIs
- [Tauri](https://tauri.app/) · [segmentit](https://github.com/nekobato/segmentit) · [kuromoji.js](https://github.com/takuyaa/kuromoji.js)
- Fonts: Noto Sans SC / Noto Serif SC (Noto CJK, SIL OFL) · LXGW family · Fangzheng Pixel · Cubic 11

## License

[MIT](LICENSE). Covers this repository's own source code only; third-party projects under `_eval/` are excluded.

## Related Docs

- [AGENTS.md](AGENTS.md) — runtime architecture & hard constraints
- [CODE_WIKI.md](CODE_WIKI.md) — module evolution history
- [docs/打包分发方案.md](docs/打包分发方案.md) — portable packaging (Chinese)
- [docs/歌词模式视觉规范.md](docs/歌词模式视觉规范.md) — per-mode layout & visual rules (Chinese)
