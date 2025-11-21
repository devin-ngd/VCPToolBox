@echo off
echo Starting the intermediate server...

REM 清除代理环境变量，使内网连接直连
set HTTP_PROXY=
set HTTPS_PROXY=
set ALL_PROXY=
set NO_PROXY=

node server.js
pause
