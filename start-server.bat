@echo off
REM ComfyCrawler server launcher.
REM Double-click this instead of running "python server.py" in a stray terminal:
REM the window stays open on exit so a crash or startup error is readable, and the
REM full output is also appended to server.log (previous run kept as server.log.1).

cd /d "%~dp0"

echo Starting ComfyCrawler server on http://127.0.0.1:5555  (logs -^> server.log)
echo Close this window or press Ctrl+C to stop the server.
echo.

REM Pinned to 3.10: a bare "python" picks up whatever is first on PATH (miniconda
REM 3.12 when launched from Explorer), which has numpy/PIL but NOT imageio-ffmpeg or
REM piper-tts - so every sfx and music clip and the narration silently drop out.
py -3.10 server.py

echo.
echo Server process ended (exit code %ERRORLEVEL%). See server.log for details.
pause
