@echo off
REM Resolve path relative to this .bat — works for any user, any clone
REM location, regardless of folder name. %~dp0 expands to the directory
REM containing this script (with trailing backslash).
cd /d "%~dp0desktop"
"node_modules\.bin\electron.cmd" "dist\main.js"
