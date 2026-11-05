@echo off
setlocal
set "RK_VS=C:\Program Files\Microsoft Visual Studio\18\Community"
if defined REMOTEKIT_VS set "RK_VS=%REMOTEKIT_VS%"
call "%RK_VS%\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64 >nul
if errorlevel 1 exit /b %errorlevel%
set "RK_ROOT=%~dp0..\.."
set "RK_TEST_OUT=%RK_ROOT%\develop\tmp\navigation-operations-tests"
if not exist "%RK_TEST_OUT%" mkdir "%RK_TEST_OUT%"
cl /nologo /std:c++20 /EHsc /W4 /utf-8 "%RK_ROOT%\browser\navigation_operations_tests.cc" /Fe:"%RK_TEST_OUT%\navigation_operations_tests.exe" /Fo:"%RK_TEST_OUT%\navigation_operations_tests.obj"
if errorlevel 1 exit /b %errorlevel%
"%RK_TEST_OUT%\navigation_operations_tests.exe"
exit /b %errorlevel%
