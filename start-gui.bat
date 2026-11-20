@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title DSH 随身卡 - 新手启动器

rem ============================================================
rem  双击这个文件即可。
rem  它会找一个 Node 运行时，然后启动 launcher/server.mjs，
rem  再自动用默认浏览器打开 http://127.0.0.1:3400
rem
rem  目录有两种可能的摆放方式，脚本都认：
rem    1) 仓库根目录：  <ROOT>\launcher\server.mjs        ← 本文件就在 <ROOT> 根
rem    2) 随身卡根目录：<ROOT>\launcher\server.mjs        ← 本文件从 portable\ 里被拷到根
rem  找不到 launcher 时，会去 ..\launcher 再找一次。
rem ============================================================

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "LAUNCHER=%ROOT%\launcher\server.mjs"
if not exist "%LAUNCHER%" set "LAUNCHER=%ROOT%\..\launcher\server.mjs"
if not exist "%LAUNCHER%" goto :no_launcher

rem ---- 找 Node：优先用卡上自带的 node\ ，其次用系统 PATH ----
set "NODE_EXE="
if exist "%ROOT%\node\node.exe" set "NODE_EXE=%ROOT%\node\node.exe"
if not defined NODE_EXE if exist "%ROOT%\..\node\node.exe" set "NODE_EXE=%ROOT%\..\node\node.exe"
if not defined NODE_EXE (
  for /f "delims=" %%I in ('where node 2^>nul') do (
    set "NODE_EXE=%%I"
    goto :got_node
  )
)
:got_node
if not defined NODE_EXE goto :no_node

rem 让插件里裸调用的 node 也走同一个运行时
for %%D in ("%NODE_EXE%") do set "NODE_DIR=%%~dpD"
set "PATH=%NODE_DIR%;%PATH%"

echo ============================================
echo   DSH 随身卡 - 新手启动器
echo   Node : %NODE_EXE%
echo   根目录: %ROOT%
echo ============================================
echo.
echo 浏览器会自动打开界面；用完后关掉这个黑窗口即可。
echo 注意：关掉黑窗口只是关启动器，已经跑起来的 DSH 不会被停。
echo.

"%NODE_EXE%" "%LAUNCHER%" %*
set "RC=%errorlevel%"
if not "%RC%"=="0" (
  echo.
  echo [X] 启动器异常退出（code=%RC%），上面就是原因。
  pause
)
exit /b %RC%

:no_node
echo [X] 没找到 Node 运行时。
echo     办法一：把 Node 22 的文件夹复制到 "%ROOT%\node\"
echo     办法二：装一个 Node LTS（https://nodejs.org），重启这个窗口
echo.
pause
exit /b 1

:no_launcher
echo [X] 没找到 launcher\server.mjs
echo     当前根目录: %ROOT%
echo     如果你只拷了 portable\ 里的文件，需要把仓库里的 launcher\ 一起拷过来。
echo.
pause
exit /b 1