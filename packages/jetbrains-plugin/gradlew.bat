@echo off
setlocal
node ..\..\scripts\ensure-jetbrains-wrapper.mjs %*
exit /b %ERRORLEVEL%
