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
node "node_modules/electron-packager/bin/electron-packager.js" . ClaudeBoard --platform=darwin --arch=arm64 --out=dist --overwrite --asar=false --icon=app/icon.icns --ignore="(^/dist$|^/node_modules/electron$|^/state$|.ps1$|.vbs$|.cmd$|^/ui.*.json$|^/hidden.json$|^/_last-payload|^/board-capture|^/frames)"
echo.

rem Put the distribution notes next to the .app -- they must be inside the
rem folder before it gets tarred, otherwise the archive ships without them.
node "postpack.js"
echo.

rem Probe Info.plist rather than the .app directory itself: a bare directory
rem can survive a half-finished run and would read as success.
if exist "dist/ClaudeBoard-darwin-arm64/ClaudeBoard.app/Contents/Info.plist" goto :findtar
echo === FAILED: no usable .app was produced. Copy the output above and send it back. ===
echo.
pause
exit /b 1

rem ===================================================================
rem  Pack the tarball here instead of by hand, with the exec bit forced on.
rem
rem  Why this step exists at all: "chmod +x" in Git Bash is a NO-OP on NTFS
rem  (verified 2026-08-18: chmod 755 then ls -l still shows -rw-r--r--), so a
rem  plain tar records 0644 for every Mach-O binary. That is the only reason
rem  the install notes used to make each Mac colleague run three chmod
rem  commands by hand. --mode=755 writes the permission bits into the archive
rem  directly, bypassing the filesystem, so the app arrives runnable.
rem
rem  Why NOT bare "tar": on Win10 1803+ that resolves to System32\tar.exe,
rem  which is bsdtar (libarchive 3.5.2) and rejects the flag outright --
rem  "Option --mode=755 is not supported". GNU tar ships inside Git for
rem  Windows and must be called by full path. Getting this wrong is silent
rem  in the worst way: bsdtar would still produce a tarball, just an
rem  unrunnable one, and nobody finds out until a Mac opens it.
rem
rem  Why one blunt 755 instead of per-file modes: GNU tar takes a single
rem  --mode per run. Marking a plist executable costs nothing here (the app
rem  is unsigned, nothing verifies modes); per-file precision would mean
rem  writing the archive format ourselves, which is not worth it.
rem ===================================================================
:findtar
set "GNUTAR=%ProgramFiles%/Git/usr/bin/tar.exe"
if exist "%GNUTAR%" goto :pack
set "GNUTAR=%ProgramFiles(x86)%/Git/usr/bin/tar.exe"
if exist "%GNUTAR%" goto :pack
set "GNUTAR=%LOCALAPPDATA%/Programs/Git/usr/bin/tar.exe"
if exist "%GNUTAR%" goto :pack
echo === FAILED: GNU tar not found in any Git for Windows install dir. ===
echo Do NOT fall back to plain "tar" - that is bsdtar and drops the exec bit.
echo Pack from Git Bash instead:
echo   tar --mode=755 -czf dist/ClaudeBoard-mac-arm64.tar.gz -C dist ClaudeBoard-darwin-arm64
echo.
pause
exit /b 1

:pack
echo === Packing dist/ClaudeBoard-mac-arm64.tar.gz (mode 755 forced) ===
"%GNUTAR%" --mode=755 -czf dist/ClaudeBoard-mac-arm64.tar.gz -C dist ClaudeBoard-darwin-arm64
if errorlevel 1 goto :packfail
echo.

:ok
echo === SUCCESS ===
echo Send this one file: %~dp0dist/ClaudeBoard-mac-arm64.tar.gz
echo.
echo The exec bits are baked in now - no more "chmod +x" on the Mac side.
echo Two things still stand:
echo   - extract with: tar -xzf ClaudeBoard-mac-arm64.tar.gz
echo   - unsigned app: hand it over on the shared drive rather than by
echo     browser/IM download, or the colleague right-clicks - Open once.
echo.
pause
exit /b 0

:packfail
echo === FAILED: tar reported an error while packing. ===
echo The .app in dist/ is fine - only the archive step failed.
echo.
pause
exit /b 1
