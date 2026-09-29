@echo off
node "%~dp0cli\index.js" stop %*
exit /b %errorlevel%
