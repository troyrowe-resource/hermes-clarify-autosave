@echo off
rem Stops the candidate and the background gateway it started (the gateway outlives the window).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\Stop-HermesClarifyCandidate.ps1" %*
set "CANDIDATE_EXIT=%ERRORLEVEL%"
if not "%CANDIDATE_EXIT%"=="0" pause
exit /b %CANDIDATE_EXIT%
