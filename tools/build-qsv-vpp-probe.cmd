@echo off
setlocal
set "VSLANG=1033"
set "RK_VS=C:\Program Files\Microsoft Visual Studio\18\Community"
if defined REMOTEKIT_VS set "RK_VS=%REMOTEKIT_VS%"
call "%RK_VS%\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64
if errorlevel 1 exit /b %errorlevel%
set "VSLANG=1033"
set "RK_CMAKE=%RK_VS%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
set "RK_NINJA=%RK_VS%\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe"
set "RK_ROOT=%~dp0.."
set "RK_BUILD=%RK_ROOT%\build\qsv-vpp-probe"
set "RK_PYTHON=C:\src\depot_tools\python3.bat"
if defined REMOTEKIT_PYTHON set "RK_PYTHON=%REMOTEKIT_PYTHON%"
call "%RK_PYTHON%" "%RK_ROOT%\tools\fetch-media-deps.py"
if errorlevel 1 exit /b %errorlevel%
"%RK_CMAKE%" -S "%RK_ROOT%" -B "%RK_BUILD%" -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF -DCMAKE_MAKE_PROGRAM="%RK_NINJA%"
if errorlevel 1 exit /b %errorlevel%
"%RK_CMAKE%" --build "%RK_BUILD%" --parallel %NUMBER_OF_PROCESSORS% --target endpoint_qsv_vpp_probe
exit /b %errorlevel%
