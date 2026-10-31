@echo off
setlocal
set "SDK_VS_ROOT=%ProgramFiles%\Microsoft Visual Studio\18\Community"
if defined REMOTEKIT_VS set "SDK_VS_ROOT=%REMOTEKIT_VS%"
call "%SDK_VS_ROOT%\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64 >nul
if errorlevel 1 exit /b 1
set "VSLANG=1033"
chcp 65001 >nul
set "RK_ROOT=%~dp0.."
set "SDK_CMAKE_ROOT=%SDK_VS_ROOT%\Common7\IDE\CommonExtensions\Microsoft\CMake"
set "SDK_PACKAGE=%~1"
if not defined SDK_PACKAGE set "SDK_PACKAGE=%RK_ROOT%\sdk\dist\dev"
set "SDK_FRESH="
if "%~2"=="fresh" set "SDK_FRESH=--fresh"
"%SDK_CMAKE_ROOT%\CMake\bin\cmake.exe" %SDK_FRESH% -S "%RK_ROOT%\sdk" -B "%RK_ROOT%\build\sdk-smoke" -G Ninja "-DCMAKE_MAKE_PROGRAM=%SDK_CMAKE_ROOT%\Ninja\ninja.exe" "-DSDK_ROOT=%SDK_PACKAGE%"
if errorlevel 1 exit /b 1
"%SDK_CMAKE_ROOT%\CMake\bin\cmake.exe" --build "%RK_ROOT%\build\sdk-smoke" --parallel %NUMBER_OF_PROCESSORS%
if errorlevel 1 exit /b 1
"%SDK_CMAKE_ROOT%\CMake\bin\ctest.exe" --test-dir "%RK_ROOT%\build\sdk-smoke" --output-on-failure
exit /b %errorlevel%
