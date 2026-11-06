@echo off
setlocal
cd /d "%~dp0"
title YouTube Downloader Companion

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is required.
  echo   Install it from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)

where yt-dlp >nul 2>nul
if errorlevel 1 (
  echo.
  echo   yt-dlp is required.
  echo   Install it with:  winget install yt-dlp.yt-dlp
  echo   or download it from https://github.com/yt-dlp/yt-dlp/releases
  echo.
  pause
  exit /b 1
)

node server.js
pause
