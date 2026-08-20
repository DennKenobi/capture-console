@echo off
rem ECANDI launcher - Session 10. Double-clickable dev-tree start until the
rem packaging session ships a real installer (project DoD: zero manual install).
rem Opens the console on the default scene (created empty on first run if
rem missing); switch scenes from inside the console (New / Open / Save As).
rem Scenes and the console profile live OUTSIDE the repo, beside it:
rem   ..\scenes\default.json      the scene file (a sources.json)
rem   ..\scenes\.console-data     console profile (theme choice lives here)
set "REPO=%~dp0"
start "ECANDI" "%REPO%node_modules\electron\dist\electron.exe" "%REPO%capture\console-main.js" "--config=%REPO%..\scenes\default.json" "--user-data-dir=%REPO%..\scenes\.console-data"
