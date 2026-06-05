@echo off
REM Resolve path relative to this .bat — works for any user, any clone
REM location, regardless of folder name. %~dp0 expands to the directory
REM containing this script (with trailing backslash).
cd /d "%~dp0desktop"
REM Launch loader.js, not main.js: loader.js runs app.setName("Local Agent X")
REM before Electron resolves userData, so localStorage/IndexedDB land in
REM %APPDATA%\Local Agent X\ instead of the default %APPDATA%\electron\.
"node_modules\.bin\electron.cmd" "dist\loader.js"
