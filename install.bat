@echo off
rem ReelMimic - one-time setup: Python packages, web app, UI build, environment check.
cd /d "%~dp0"
rem first command that really runs Python 3.10+ (the Microsoft Store stub does not)
if not "%PYTHON%"=="" goto :havepy
python -c "import sys; sys.exit(0 if sys.version_info>=(3,10) else 1)" >nul 2>&1 && (set PYTHON=python& goto :havepy)
python3 -c "import sys; sys.exit(0 if sys.version_info>=(3,10) else 1)" >nul 2>&1 && (set PYTHON=python3& goto :havepy)
py -c "import sys; sys.exit(0 if sys.version_info>=(3,10) else 1)" >nul 2>&1 && (set PYTHON=py& goto :havepy)
echo Python 3.10+ not found. Install it from https://www.python.org (tick "Add to PATH"), or set PYTHON.
goto :err
:havepy
echo == Python packages
%PYTHON% -m pip install -r requirements.txt || goto :err
echo == Web app
cd app
call npm install || goto :err
call npm run build || goto :err
echo == Environment check
node scripts\doctor.mjs
echo.
echo Next: install and log in to Claude Code (npm i -g @anthropic-ai/claude-code, then run claude) or Codex (npm i -g @openai/codex, then codex login),
echo optional keys in %USERPROFILE%\.reelmimic\secrets.json, then double-click start.bat
pause
exit /b 0
:err
echo Setup failed - see the messages above.
pause
exit /b 1
