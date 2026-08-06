@echo off
setlocal
set "POCKETRISU_WINDOWS_UPDATE_FINALIZER=1"
"%~dp0bin\node.exe" "%~dp0scripts\updater.cjs"
if errorlevel 1 goto :fail
if exist "%~dp0.update-tmp" (
    if exist "%~dp0.update-tmp\new-bin\" (
        xcopy /E /I /Y "%~dp0.update-tmp\new-bin\*" "%~dp0bin\" >nul
        if errorlevel 1 goto :fail
    ) else (
        if not exist "%~dp0.update-tmp\skip-bin-update" goto :fail
    )
    if not exist "%~dp0.update-tmp\latest-version" goto :fail
    copy /Y "%~dp0.update-tmp\latest-version" "%~dp0.installed-version" >nul
    if errorlevel 1 goto :fail
    call :release_recovery_lock
    if errorlevel 1 goto :fail
    rmdir /s /q "%~dp0.update-tmp" 2>nul
)
echo Update complete.
pause
exit /b 0

:release_recovery_lock
if not exist "%~dp0.update-tmp\recovery-path-lock-handoff.json" exit /b 0
"%~dp0bin\node.exe" "%~dp0scripts\recoveryPathLockFinalizer.cjs" "%~dp0.update-tmp\recovery-path-lock-handoff.json"
exit /b %errorlevel%

:fail
call :release_recovery_lock
echo Update finalization failed. Existing installation was left in place where possible.
pause
exit /b 1
