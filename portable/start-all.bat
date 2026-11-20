@echo off
chcp 65001 >nul
setlocal EnableExtensions
title DSH portable - full stack

rem Boots the local console (port 3300) and then the DSH web UI.
rem QQ bridge / SnowLuma / voice engines are NOT started here on purpose:
rem they need their own windows and are started from workspace\*.bat

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "DSH_HOME=%ROOT%\.dsh"
set "DSH_WORKSPACE=%ROOT%\workspace"

echo [1/2] starting console (3300) if needed ...
if exist "%DSH_WORKSPACE%\启动控制台.bat" (
  start "" /min cmd /c ""%DSH_WORKSPACE%\启动控制台.bat""
  timeout /t 3 /nobreak >nul
) else (
  echo    [skip] workspace\qq console launcher not found
)

echo [2/2] starting DSH web ...
call "%~dp0start-dsh.bat" %*
