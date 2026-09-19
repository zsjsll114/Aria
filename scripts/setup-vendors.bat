@echo off
rem ============================================================
rem setup-vendors.bat - fetch third-party music API vendors into _eval/
rem
rem Why: _eval/ is a runtime dependency (selfhost_service.py spawns these
rem processes). It is git-ignored in this repo; a fresh clone gets an empty
rem _eval/ and self-host services degrade to the free-source pool.
rem This script rebuilds it: clone 4 upstream repos pinned to the same
rem commits the project was tested with, apply our local patches, install deps.
rem
rem Requires: git, node, npm on PATH.
rem Notes:
rem   * qq-music-api-node gets patches/qq-music-api-node-user.patch
rem     (undici fetch to bypass QQ TLS-fingerprint block, cookie resolution
rem     for liked-songs/playlists). The other vendors have no local patches.
rem   * qqmusic-api-py is cloned for completeness but is NOT wired into
rem     selfhost_service._SERVICES yet.
rem   * Keep this file ASCII-only (AGENTS.md constraint).
rem ============================================================
setlocal
cd /d "%~dp0.."
if not exist _eval mkdir _eval

rem ---------- 1. KuGouMusicApi ----------
if exist _eval\KuGouMusicApi (
    echo [skip] _eval\KuGouMusicApi already exists
) else (
    echo [git] cloning MakcRe/KuGouMusicApi...
    git clone --quiet https://github.com/MakcRe/KuGouMusicApi _eval\KuGouMusicApi
    git -C _eval\KuGouMusicApi reset --hard 2934a3228e6f0d57595bce35ea5652e70c39c57e
)
if not exist _eval\KuGouMusicApi\.env (
    echo platform=lite>  _eval\KuGouMusicApi\.env
    echo PORT=3100>>     _eval\KuGouMusicApi\.env
    echo [env] KuGouMusicApi\.env written ^(platform=lite, PORT=3100^)
)
pushd _eval\KuGouMusicApi
call npm install --no-audit --no-fund
popd

rem ---------- 2. NeteaseCloudMusicApi ----------
if exist _eval\NeteaseCloudMusicApi (
    echo [skip] _eval\NeteaseCloudMusicApi already exists
) else (
    echo [git] cloning nooblong/NeteaseCloudMusicApiBackup...
    git clone --quiet https://github.com/nooblong/NeteaseCloudMusicApiBackup.git _eval\NeteaseCloudMusicApi
    git -C _eval\NeteaseCloudMusicApi reset --hard ed28a571a6965f7164fd81b5c4b41098dbe624d4
)
pushd _eval\NeteaseCloudMusicApi
call npm install --no-audit --no-fund
popd

rem ---------- 3. qq-music-api-node ----------
if exist _eval\qq-music-api-node (
    echo [skip] _eval\qq-music-api-node already exists
) else (
    echo [git] cloning sansenjian/qq-music-api...
    git clone --quiet https://github.com/sansenjian/qq-music-api _eval\qq-music-api-node
    git -C _eval\qq-music-api-node reset --hard 45d0d275b590d8c3f99270e7f74135873172c71a
)
pushd _eval\qq-music-api-node
echo [patch] applying patches\qq-music-api-node-user.patch ^(fresh copy only^)...
git apply --check ..\..\patches\qq-music-api-node-user.patch 2>nul
if errorlevel 1 (
    echo [patch] user patch already applied or tree differs - skipped.
) else (
    git apply ..\..\patches\qq-music-api-node-user.patch
)
call npm install --no-audit --no-fund
popd

rem ---------- 4. qqmusic-api-py (standby, not wired into selfhost) ----------
if exist _eval\qqmusic-api-py (
    echo [skip] _eval\qqmusic-api-py already exists
) else (
    echo [git] cloning ylw1997/qqmusic-api...
    git clone --quiet --branch master https://github.com/ylw1997/qqmusic-api _eval\qqmusic-api-py
    git -C _eval\qqmusic-api-py reset --hard 5f87b07b85923f8862d7b57f9d558ce0314ba1a7
)

rem ---------- 5. kuromoji dictionary (same-origin, git-ignored) ----------
rem The PV word segmenter loads this dict from web/src/vendor/kuromoji/dict/.
rem It is ~17MB so it is git-ignored; mirror it from node_modules here.
echo [dict] syncing kuromoji dictionary into web\src\vendor\kuromoji\dict ...
call "%~dp0vendor-kuromoji-dict.bat"
if errorlevel 1 echo [warn] dictionary sync failed - frontend will fall back to CDN.

echo.
echo ============================================================
echo Done. Start the dev server with: python server.py
echo Self-host vendors will be spawned lazily on _prewarm.
echo If any npm install failed, check network, then re-run this script.
echo ============================================================
endlocal