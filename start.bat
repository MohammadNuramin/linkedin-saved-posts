@echo off
title LinkedIn Saved Posts Viewer

:: Kill any existing processes on our ports
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":4781 " ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":4782 " ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1

set PORT=4781
cd /d "%~dp0"
npm run viewer
