$serviceName = "AIBridgeHub"
$nodePath = "C:\Program Files\nodejs\node.exe"
# 统一接入:服务运行共享中枢 server.js(非已弃用的 mcp-server.js),默认端口 9800
$scriptPath = "C:\Users\ASUS\Documents\trae_projects\ai-orchestrator\ai-bridge\server.js"
$arguments = "`"$scriptPath`""
$binPath = "`"$nodePath`" $arguments"

Write-Host "Preparing to create service..."
Write-Host "Service name: $serviceName"
Write-Host "binPath: $binPath"

$service = Get-WmiObject -Class Win32_Service -Filter "Name='$serviceName'" -ErrorAction SilentlyContinue
if ($service) {
    Write-Host "Stopping and deleting old service..."
    $service.StopService()
    Start-Sleep -Seconds 2
    $service.Delete()
    Start-Sleep -Seconds 2
}

Write-Host "Creating new service..."
$newService = Get-WmiObject -Class Win32_Service -List
$result = $newService.Create($serviceName, $binPath, $null, $null, $null, $true, $null, $null, $null, $null, $null)

if ($result.ReturnValue -eq 0) {
    Write-Host "Service created successfully"
    
    $service = Get-WmiObject -Class Win32_Service -Filter "Name='$serviceName'"
    $service.Change($null, $null, $null, $null, $null, $null, $null, $null, "AI Bridge Hub (HTTP mode)", $null, $null)
    Write-Host "Description set successfully"
    
    $service.StartService()
    Write-Host "Service started successfully"
    
    Start-Sleep -Seconds 3
    
    $service = Get-WmiObject -Class Win32_Service -Filter "Name='$serviceName'"
    Write-Host "Service status: $($service.State)"
} else {
    Write-Host "Service creation failed, error code: $($result.ReturnValue)"
}