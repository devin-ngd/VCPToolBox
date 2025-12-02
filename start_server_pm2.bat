@echo off
echo 使用 PM2 启动 VCPToolBox 服务器...

REM 清除代理环境变量，使内网连接直连
set HTTP_PROXY=
set HTTPS_PROXY=
set ALL_PROXY=
set NO_PROXY=

REM 使用 PM2 启动服务器
npx pm2 start ecosystem.config.js

echo.
echo 服务器已启动！
echo 查看状态: npx pm2 list
echo 查看日志: npx pm2 logs VCPToolBox
echo 停止服务器: npx pm2 stop VCPToolBox
echo 重启服务器: npx pm2 restart VCPToolBox
echo.
pause
