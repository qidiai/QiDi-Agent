@echo off
REM AI Bridge mitmproxy 启动脚本
REM 用法: start-mitm.bat  (启动后会自动设置系统代理,关闭时自动还原)

echo ========================================
echo  AI Bridge - mitmproxy 流量监控
echo ========================================
echo.

REM 检查 mitmproxy 是否安装
where mitmdump >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] mitmproxy 未安装,请运行: pip install mitmproxy
    pause
    exit /b 1
)

echo [1/4] 启动 mitmproxy (端口 8888)...
start "mitmproxy" mitmdump -s "%~dp0mitm-addon.py" --listen-port 8888 --set stream_large_bodies=10m

echo [2/4] 等待 mitmproxy 启动...
timeout /t 3 /nobreak >nul

echo [3/4] 检查 CA 证书...
if not exist "%USERPROFILE%\.mitmproxy\mitmproxy-ca-cert.cer" (
    echo [!] 首次运行,正在生成 CA 证书...
    timeout /t 3 /nobreak >nul
)

if exist "%USERPROFILE%\.mitmproxy\mitmproxy-ca-cert.cer" (
    echo [!] 请将以下证书安装到"受信任的根证书颁发机构":
    echo     %USERPROFILE%\.mitmproxy\mitmproxy-ca-cert.cer
    echo.
    echo     方法:双击该文件 -> 安装证书 -> 本地计算机 -> 受信任的根证书颁发机构
    echo.
    choice /c YN /m "CA 证书已安装? (Y/N)"
    if errorlevel 2 (
        echo [!] 未安装 CA 证书,HTTPS 拦截将无法工作。
        echo     请手动安装后重新运行此脚本。
        pause
        exit /b 1
    )
) else (
    echo [!] CA 证书文件未找到,请等待 mitmproxy 完成首次生成。
    echo     证书路径: %%USERPROFILE%%\.mitmproxy\mitmproxy-ca-cert.cer
    echo     安装后重新运行此脚本。
    pause
    exit /b 1
)

echo [4/4] 设置系统代理为 127.0.0.1:8888...
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyServer /t REG_SZ /d "127.0.0.1:8888" /f >nul

echo.
echo ========================================
echo  mitmproxy 已启动! AI 工具流量监控中
echo ========================================
echo  代理地址: 127.0.0.1:8888
echo  Web UI: http://127.0.0.1:9800 (流量 Tab)
echo  仅捕获 AI API 域名流量,其他流量透传不记录
echo.
echo  按任意键停止监控并还原系统代理...
pause >nul

echo 还原系统代理...
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f >nul

echo 停止 mitmproxy...
taskkill /fi "WINDOWTITLE eq mitmproxy*" /f >nul 2>&1
taskkill /im mitmdump.exe /f >nul 2>&1

echo 已停止,代理已还原。
timeout /t 2 /nobreak >nul
