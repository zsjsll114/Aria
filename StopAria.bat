@echo off
title Stop Aria

:: Kill the backend process tree by port (8001/18089/3100/3200/3201)
:: instead of taskkill on node.exe, so unrelated Node.js processes survive.
powershell -NoProfile -WindowStyle Hidden -Command ^
 "$ports=8001,18089,3100,3200,3201; $p=Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$_.LocalPort -in $ports} | Select-Object -ExpandProperty OwningProcess -Unique; if($p){$p | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }}; Write-Host 'Aria stopped. You may close this window.'" 
timeout /t 1 /nobreak >nul