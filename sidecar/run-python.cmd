@echo off
setlocal
cd /d "%~dp0.."
REM 播放 Python 后端 server.py (端口 8001) : CORS 代理 + QQ/咪咨解析
python server.py
