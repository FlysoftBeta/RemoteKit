@echo off
setlocal
set "VSLANG=1033"
set "RK_VS=C:\Program Files\Microsoft Visual Studio\18\Community"
if defined REMOTEKIT_VS set "RK_VS=%REMOTEKIT_VS%"
call "%RK_VS%\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64
if errorlevel 1 exit /b %errorlevel%
set "VSLANG=1033"
chcp 65001 >nul
set "RK_CMAKE=%RK_VS%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin"
set "RK_NINJA=%RK_VS%\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe"
set "RK_ROOT=%~dp0.."
set "RK_BUILD=%RK_ROOT%\build\endpoint"
set "RK_PACKAGE_ARGS="
set "RK_TARGET="
if "%~1"=="package" (
  set "RK_BUILD=%RK_ROOT%\build\endpoint-package"
  set "RK_PACKAGE_ARGS=-DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF"
  set "RK_TARGET=--target endpoint_service remotekit_node remotekit_control remotekit_release"
)
if "%~1"=="encoder-smoke" (
  set "RK_BUILD=%RK_ROOT%\build\endpoint-package"
  set "RK_PACKAGE_ARGS=-DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF"
  set "RK_TARGET=--target endpoint_encoder_smoke"
)
set "RK_PYTHON=C:\src\depot_tools\python3.bat"
if defined REMOTEKIT_PYTHON set "RK_PYTHON=%REMOTEKIT_PYTHON%"
call "%RK_PYTHON%" "%RK_ROOT%\tools\fetch-media-deps.py"
if errorlevel 1 exit /b %errorlevel%
call "%RK_PYTHON%" "%RK_ROOT%\tools\fetch-document-deps.py"
if errorlevel 1 exit /b %errorlevel%
if not "%~1"=="encoder-smoke" (
  call "%RK_PYTHON%" "%RK_ROOT%\tools\setup-face-auth.py"
  if errorlevel 1 exit /b 1
)
set "RK_FRESH="
if "%~1"=="fresh" set "RK_FRESH=--fresh"
"%RK_CMAKE%\cmake.exe" %RK_FRESH% -S "%RK_ROOT%" -B "%RK_BUILD%" -G Ninja -DCMAKE_MAKE_PROGRAM="%RK_NINJA%" %RK_PACKAGE_ARGS%
if errorlevel 1 exit /b %errorlevel%
set "RK_CLEAN="
if "%~1"=="fresh" set "RK_CLEAN=--clean-first"
"%RK_CMAKE%\cmake.exe" --build "%RK_BUILD%" --parallel %NUMBER_OF_PROCESSORS% %RK_CLEAN% %RK_TARGET%
if errorlevel 1 exit /b %errorlevel%
if "%~1"=="build-only" exit /b 0
if "%~1"=="package" exit /b 0
if "%~1"=="encoder-smoke" exit /b 0
"%RK_CMAKE%\ctest.exe" --test-dir "%RK_BUILD%" --output-on-failure
exit /b %errorlevel%
