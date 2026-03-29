@echo off
title Open Agent X
cd /d "%~dp0"
echo Starting Open Agent X...
echo.

:: Start server in background
start /b node --max-old-space-size=512 dist/index.js

:: Wait for server to be ready
echo Waiting for server...
:wait_loop
timeout /t 1 /nobreak >nul
curl -s http://127.0.0.1:7007/api/health >nul 2>&1
if %errorlevel% neq 0 goto wait_loop

:: Get auth token and open browser
for /f "tokens=*" %%t in ('node -e "try{const f=require('fs'),p=require('path'),o=require('os');const c=JSON.parse(f.readFileSync(p.join(o.homedir(),'.sax','config.json'),'utf-8'));console.log(c.authToken)}catch{try{const s=f.readFileSync(p.join(o.homedir(),'.sax','settings.json'),'utf-8');console.log(JSON.parse(s).authToken||'')}catch{}}" 2^>nul') do set "TOKEN=%%t"

if defined TOKEN (
    start http://127.0.0.1:7007/?token=%TOKEN%
) else (
    start http://127.0.0.1:7007
)

echo.
echo Open Agent X is running. Close this window to stop the server.
echo.

:: Keep window open so server stays running
cmd /k
