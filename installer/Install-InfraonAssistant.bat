@echo off
title Infraon Code Assistant - Installer
rem Installs, or updates when already installed (the saved API key is kept).
rem To change the API key while updating:  Install-InfraonAssistant.bat -ResetKey
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 (
  echo.
  echo Installation did not complete. See the message above.
)
echo.
pause
