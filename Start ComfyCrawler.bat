@echo off
REM ComfyCrawler server launcher.
REM Double-click this instead of running "python server.py" in a stray terminal:
REM the window stays open on exit so a crash or startup error is readable, and the
REM full output is also appended to server.log (previous run kept as server.log.1).

cd /d "%~dp0"

echo Starting ComfyCrawler server  (logs -^> server.log)
echo Close this window or press Ctrl+C to stop the server.
echo.

REM The UI's Tailwind watcher, only for a checkout that has run "npm install": it rebuilds
REM tailwind.css whenever index.html or game.js gains a class, so edit-and-refresh keeps working.
REM It shares this window, so closing the window stops it too. Its first build takes ~20s to
REM start on a network drive. No node_modules = skipped - the committed tailwind.css is all
REM playing the game needs.
if exist "node_modules\.bin\tailwindcss.cmd" (
  echo Tailwind watcher on - tailwind.css rebuilds when index.html or game.js change.
  start "" /b cmd /c "npm run tw:watch >nul 2>&1"
)

REM Pinned to 3.10: a bare "python" picks up whatever is first on PATH (miniconda
REM 3.12 when launched from Explorer), which has numpy/PIL but NOT imageio-ffmpeg or
REM piper-tts - so every sfx and music clip and the narration silently drop out.
py -3.10 server.py

echo.
echo Server process ended (exit code %ERRORLEVEL%). See server.log for details.
pause
