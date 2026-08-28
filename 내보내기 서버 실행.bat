@echo off
chcp 65001 >nul
title Konny Image Exporter - 로컬 저장 서버
powershell -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0konny-export-server.ps1"
echo.
echo 창을 닫으려면 아무 키나 누르세요.
pause >nul
