@echo off
setlocal
title NCM Batch Converter
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [Error] Node.js was not found.
  echo Install Node.js 20 or newer and add it to PATH, then run this file again.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo [Error] npm was not found in PATH.
  pause
  exit /b 1
)

if not exist "node_modules\ffmpeg-static\index.js" (
  echo [Setup] Installing the local FFmpeg dependency...
  call npm install
  if errorlevel 1 (
    echo [Error] Dependency installation failed.
    pause
    exit /b 1
  )
)

echo Starting NCM Batch Converter...
node server.js --open
if errorlevel 1 pause
