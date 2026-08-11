@echo off
rem ===================================================================
rem  Build the macOS (Apple Silicon) app bundle from Windows.
rem
rem  Needs admin because a .app contains symlinks (inside the Electron
rem  Framework) and Windows only allows creating symlinks when elevated
rem  or when Developer Mode is on. Without that, electron-packager just
rem  prints "Cannot create symlinks" and produces nothing.
rem
rem  Deliberate constraints, each one paid for by a real failure:
rem    - ASCII only + CRLF endings: cmd.exe mishandles LF-only batch
rem      files (silent death on parenthesised if-blocks), and chcp
rem      mid-file makes things worse.
rem    - forward slashes everywhere: node and cmd both accept them on
rem      Windows, and they survive every layer of shell quoting.
rem      Backslashes did not - one got eaten and a stray \b became a
rem      literal backspace character inside the path.
rem    - goto labels instead of if(...) blocks: fewer parser corners.
rem ===================================================================
setlocal

rem "net session" succeeds only for administrators -- cheap elevation probe.
net session >nul 2>&1
if %errorlevel% equ 0 goto :build

echo Requesting administrator rights, please approve the UAC prompt...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
exit /b

:build
cd /d "%~dp0"
echo.
echo === Building macOS arm64 package ===
echo.
node "node_modules/electron-packager/bin/electron-packager.js" . ClaudeBoard --platform=darwin --arch=arm64 --out=dist --overwrite --asar=false --ignore="(^/dist$|^/node_modules/electron$|^/state$|.ps1$|.vbs$|.cmd$|^/ui.*.json$|^/hidden.json$|^/_last-payload|^/board-capture|^/frames)"
echo.

rem Probe Info.plist rather than the .app directory itself: a bare directory
rem can survive a half-finished run and would read as success.
if exist "dist/ClaudeBoard-darwin-arm64/ClaudeBoard.app/Contents/Info.plist" goto :ok
echo === FAILED: no usable .app was produced. Copy the output above and send it back. ===
echo.
pause
exit /b 1

:ok
echo === SUCCESS ===
echo Output folder: %~dp0dist
echo   ClaudeBoard-darwin-arm64/ClaudeBoard.app
echo.
echo Tell your Mac colleague: Gatekeeper blocks it the first time.
echo Right-click - Open, or run:  xattr -dr com.apple.quarantine ClaudeBoard.app
echo.
pause
