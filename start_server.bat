@echo off
title Loom Local Server
cd /d "%~dp0"

echo.
echo  ============================================
echo   Loom 로컬 서버를 시작합니다...
echo   주소: http://localhost:3000/loom_lobby.html
echo   이 창을 닫으면 서버가 꺼집니다.
echo  ============================================
echo.

start "Loom Local Server" cmd /k python -m http.server 3000
timeout /t 2 /nobreak >nul
start "" http://localhost:3000/loom_lobby.html
