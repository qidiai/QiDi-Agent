# AI Bridge 开机自启注册脚本（schtasks 计划任务）
#
# 用途：注册名为 AIBridgeHub 的开机自启任务，登录时自动执行生产启动脚本
#       start-ai-bridge.ps1（内部会先停旧实例再启动 watchdog 守护进程）。
#
# 注册（在管理员或当前用户 PowerShell 中执行本脚本）：
#   powershell -ExecutionPolicy Bypass -File register-autostart.ps1
#
# 卸载（删除计划任务）：
#   schtasks /delete /tn AIBridgeHub /f
#
# 查看任务状态：
#   schtasks /query /tn AIBridgeHub /v /fo LIST

$startScript = 'C:\Users\ASUS\Documents\trae_projects\ai-orchestrator\output\qoder_qoder_meeting_1784728826451_r2_1784729242580\start-ai-bridge.ps1'

# /sc onlogon : 用户登录时触发（比 onstart 更适合用户级 node 服务，无需 SYSTEM 权限）
# /rl limited : 普通权限运行，中枢不需要管理员
# /f          : 已存在同名任务则覆盖
schtasks /create /tn AIBridgeHub /sc onlogon /rl limited /f `
    /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`""

if ($LASTEXITCODE -eq 0) {
    Write-Host 'AIBridgeHub 开机自启任务注册成功。'
    Write-Host ('启动脚本: ' + $startScript)
    Write-Host '卸载命令: schtasks /delete /tn AIBridgeHub /f'
} else {
    Write-Host ('注册失败，schtasks 退出码: ' + $LASTEXITCODE)
}
