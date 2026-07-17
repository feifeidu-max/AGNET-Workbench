@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0ops\Start-AGNET.ps1" %*
set "AGNET_EXIT=%ERRORLEVEL%"
if not "%AGNET_EXIT%"=="0" (
  echo.
  echo AGNET startup failed. Review the error above.
  pause
)
exit /b %AGNET_EXIT%
