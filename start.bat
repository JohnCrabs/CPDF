@echo off
title CPDF server
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found.
  echo   Install it from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)

node server.js 8000 --open
pause
