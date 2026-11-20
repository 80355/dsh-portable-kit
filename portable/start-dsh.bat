@echo off
chcp 65001 >nul
setlocal EnableExtensions
title DeepSeek Harness (portable SD-card edition)

rem ============================================================
rem  Portable launcher for the whole DSH stack living on THIS drive.
rem  Everything is resolved from %~dp0, so the card may be E:, F:, G: ...
rem  Layout expected under this folder:
rem     node\            portable Node runtime
rem     dsh-workspace\   DSH checkout (node_modules\@deepseek-ai\dsh)
rem     .dsh\            DSH_HOME (profiles, sessions, credentials, memory)
rem     workspace\       your working workspace (default-workspace)
rem ============================================================

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "DSH_HOME=%ROOT%\.dsh"
set "DSH_WORKSPACE=%ROOT%\workspace"
set "NODE_EXE=%ROOT%\node\node.exe"
set "DSH_BIN=%ROOT%\dsh-workspace\node_modules\@deepseek-ai\dsh\lib\bin.js"

rem Some plugins spawn a bare `node` from PATH. On a fresh machine there may be no
rem Node installed at all, so put OUR runtime first on PATH.
set "PATH=%ROOT%\node;%PATH%"
if exist "%ROOT%\workspace\qq-bridge\node_modules" set "NODE_PATH=%ROOT%\workspace\qq-bridge\node_modules"

echo ============================================
echo   DeepSeek Harness - portable
echo   root     : %ROOT%
echo   DSH_HOME : %DSH_HOME%
echo ============================================
echo.

if not exist "%NODE_EXE%" goto :no_node
if not exist "%DSH_BIN%" goto :no_bin
if not exist "%DSH_HOME%\profiles\web" goto :no_home

rem Repoint every absolute path inside the profile config at THIS drive letter.
rem Idempotent and takes milliseconds; safe to run on every start.
"%NODE_EXE%" "%ROOT%\portable-repath.mjs"
if errorlevel 1 echo [WARN] portable-repath reported a problem, continuing anyway.
echo.

cd /d "%DSH_WORKSPACE%"
"%NODE_EXE%" "%DSH_BIN%" web %*
set "RC=%errorlevel%"
echo.
echo [dsh exited with code %RC%]
pause
exit /b %RC%

:no_node
echo [X] Node runtime not found: "%NODE_EXE%"
echo     Expected a full Node 22 folder copied here as .\node\
pause
exit /b 1

:no_bin
echo [X] DSH checkout not found: "%DSH_BIN%"
echo     Expected the checkout copied here as .\dsh-workspace\
pause
exit /b 1

:no_home
echo [X] DSH_HOME looks incomplete: "%DSH_HOME%\profiles\web"
echo     Expected the .dsh folder copied here as .\.dsh\
pause
exit /b 1
