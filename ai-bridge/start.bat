@echo off
title AI Bridge Server
cd /d "%~dp0"
echo ==========================================
echo   AI Bridge 服务启动中...
echo   Web UI: http://127.0.0.1:9800
echo ==========================================
echo.
node server.js
echo.
echo 服务已停止。按任意键退出...
pause >nul
