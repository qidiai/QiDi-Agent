@echo off
setlocal

set "SERVICE_NAME=AIBridgeHub"
set "NODE_PATH=C:\Program Files\nodejs\node.exe"
REM 统一接入:服务运行共享中枢 server.js(非已弃用的 mcp-server.js),默认端口 9800
set "SCRIPT_PATH=C:\Users\ASUS\Documents\trae_projects\ai-orchestrator\ai-bridge\server.js"
set "BIN_PATH="%NODE_PATH%" "%SCRIPT_PATH%""

echo Stopping and deleting old service...
sc stop %SERVICE_NAME% >nul 2>&1
sc delete %SERVICE_NAME% >nul 2>&1
timeout /t 2 /nobreak >nul

echo Creating service with binPath:
echo %BIN_PATH%

sc create %SERVICE_NAME% binPath= %BIN_PATH% start= auto DisplayName= "AI Bridge Hub (ai-bridge)"

if errorlevel 1 (
    echo Service creation failed!
    pause
    exit /b 1
)

echo Service created successfully!
echo Setting description...
sc description %SERVICE_NAME% "AI Bridge Hub (HTTP mode)"

echo Starting service...
sc start %SERVICE_NAME%

if errorlevel 1 (
    echo Service start failed!
    pause
    exit /b 1
)

echo Service started successfully!
timeout /t 3 /nobreak >nul

echo Checking service status...
sc query %SERVICE_NAME%

echo Done!
pause