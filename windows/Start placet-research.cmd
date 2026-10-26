@echo off
title placet-research
cd /d "%~dp0"
where node >nul 2>nul || goto nonode
node "placet-research\bin\placet-research.js" serve --app
if errorlevel 1 pause
exit /b
:nonode
echo placet-research needs Node.js 22 or newer.
echo Install it from https://nodejs.org, then double-click this file again.
pause
