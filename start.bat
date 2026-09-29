@echo off
node "%~dp0cli\index.js" start %*
exit /b %errorlevel%
