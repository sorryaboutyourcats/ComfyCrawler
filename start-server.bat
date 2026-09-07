@echo off
REM ComfyCrawler server launcher.
REM Double-click this instead of running "python server.py" in a stray terminal:
REM the window stays open on exit so a crash or startup error is readable, and the
REM full output is also appended to server.log (previous run kept as server.log.1).

cd /d "%~dp0"

echo Starting ComfyCrawler server on http://127.0.0.1:5555  (logs -^> server.log)
echo Close this window or press Ctrl+C to stop the server.
echo.

python server.py

echo.
echo Server process ended (exit code %ERRORLEVEL%). See server.log for details.
pause
