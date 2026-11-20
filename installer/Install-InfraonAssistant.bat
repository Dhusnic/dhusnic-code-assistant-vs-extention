@echo off
title Infraon Code Assistant - Installer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo.
  echo Installation did not complete. See the message above.
)
echo.
pause
