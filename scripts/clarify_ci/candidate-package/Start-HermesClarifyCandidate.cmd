@echo off
rem Starts the Hermes clarify-autosave candidate in its isolated sandbox. Double-click this file.
rem The sandbox (home, Electron user data, profile, temp) lives under %LOCALAPPDATA%\HermesClarifyCandidate.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\Start-HermesClarifyCandidate.ps1" %*
set "CANDIDATE_EXIT=%ERRORLEVEL%"
if not "%CANDIDATE_EXIT%"=="0" (
  echo.
  echo The candidate did not start ^(exit code %CANDIDATE_EXIT%^). Nothing was changed outside its sandbox.
  pause
)
exit /b %CANDIDATE_EXIT%
