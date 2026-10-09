@echo off
rem ReelMimic - build the UI if needed and start the server on http://localhost:4318
cd /d "%~dp0app"
if not exist node_modules call npm install
if not exist dist call npm run build
rem open the browser once the server answers /api/health (a cold start can take a while), checking in the background
rem so the server keeps this window; 20 tries is about a minute (Windows takes ~2 s to refuse a connection, ping waits 1 s)
start "" /b cmd /d /q /c "(for /l %%i in (1,1,20) do (curl -sf -m 2 http://localhost:4318/api/health >nul 2>&1 && (start "" http://localhost:4318 & exit) || ping -n 2 127.0.0.1 >nul)) & echo ReelMimic is not answering on http://localhost:4318: see the messages above, or open it yourself once it is up."
node server\index.ts
