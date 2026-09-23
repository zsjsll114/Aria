@echo off
setlocal
cd /d "%~dp0.."
REM Node sidecar : node-shazam 识曲服务 (阶段2 将实现为 HTTP 服务)
if exist scripts/shazam-server.mjs (
  node scripts/shazam-server.mjs
) else (
  echo. >&2
  echo [shazam-server] not yet implemented - skipping >&2
  exit /b 0
)
