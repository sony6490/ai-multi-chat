@echo off
chcp 65001 >nul
cd /d "%~dp0"
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
if not exist node_modules (
  call npm install --registry=https://registry.npmmirror.com
)
call npm start
