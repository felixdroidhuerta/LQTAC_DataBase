@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0desktop\Start-LQTAC.ps1"
if errorlevel 1 pause
