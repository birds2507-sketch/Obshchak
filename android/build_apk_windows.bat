@echo off
setlocal
rem Run with Gradle already installed or within Android Studio Terminal.
where gradle >nul 2>nul
if errorlevel 1 (
 echo Gradle not found. Easiest path: upload project to GitHub and run Actions ^> Build test Android APK.
 echo Or install Gradle 8.11.1 and Android SDK via Android Studio.
 pause
 exit /b 1
)
gradle --no-daemon assembleDebug
if errorlevel 1 ( echo Build failed & pause & exit /b 1 )
echo.
echo APK: app\build\outputs\apk\debug\app-debug.apk
pause