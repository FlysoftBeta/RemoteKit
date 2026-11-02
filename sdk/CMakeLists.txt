cmake_minimum_required(VERSION 3.24)
project(remotekit_sdk_consumer LANGUAGES CXX)

set(SDK_ROOT "" CACHE PATH "Exported RemoteKit SDK directory")
if(NOT WIN32)
  message(FATAL_ERROR "This SDK package currently targets Windows")
endif()
if(NOT EXISTS "${SDK_ROOT}/lib/remotekit_sdk.lib" OR
   NOT EXISTS "${SDK_ROOT}/bin/remotekit_sdk.dll" OR
   NOT EXISTS "${SDK_ROOT}/include/remotekit_sdk.h")
  message(FATAL_ERROR "SDK_ROOT must contain bin/, lib/, include/ from tools/export-sdk.py")
endif()
add_library(remotekit_sdk SHARED IMPORTED GLOBAL)
set_target_properties(remotekit_sdk PROPERTIES
  IMPORTED_IMPLIB "${SDK_ROOT}/lib/remotekit_sdk.lib"
  IMPORTED_LOCATION "${SDK_ROOT}/bin/remotekit_sdk.dll"
  INTERFACE_INCLUDE_DIRECTORIES "${SDK_ROOT}/include")
add_library(RemoteKit::SDK ALIAS remotekit_sdk)

add_executable(remotekit_sdk_smoke smoke.cc)
target_link_libraries(remotekit_sdk_smoke PRIVATE RemoteKit::SDK)
target_compile_features(remotekit_sdk_smoke PRIVATE cxx_std_17)
add_custom_command(TARGET remotekit_sdk_smoke POST_BUILD
  COMMAND "${CMAKE_COMMAND}" -E copy_directory
    "${SDK_ROOT}/bin" "$<TARGET_FILE_DIR:remotekit_sdk_smoke>")
add_executable(remotekit_control_smoke control-smoke.cc)
target_link_libraries(remotekit_control_smoke PRIVATE RemoteKit::SDK)
target_compile_features(remotekit_control_smoke PRIVATE cxx_std_17)
add_custom_command(TARGET remotekit_control_smoke POST_BUILD
  COMMAND "${CMAKE_COMMAND}" -E copy_directory
    "${SDK_ROOT}/bin" "$<TARGET_FILE_DIR:remotekit_control_smoke>")
add_executable(remotekit_control_client control-client.cc)
target_link_libraries(remotekit_control_client PRIVATE RemoteKit::SDK)
target_compile_features(remotekit_control_client PRIVATE cxx_std_17)
add_custom_command(TARGET remotekit_control_client POST_BUILD
  COMMAND "${CMAKE_COMMAND}" -E copy_directory
    "${SDK_ROOT}/bin" "$<TARGET_FILE_DIR:remotekit_control_client>")
enable_testing()
add_test(NAME remotekit_sdk_smoke COMMAND remotekit_sdk_smoke)

add_executable(remotekit_rtc_smoke rtc-smoke.cc)
target_link_libraries(remotekit_rtc_smoke PRIVATE RemoteKit::SDK d3d11)
target_compile_features(remotekit_rtc_smoke PRIVATE cxx_std_17)
add_custom_command(TARGET remotekit_rtc_smoke POST_BUILD
  COMMAND "${CMAKE_COMMAND}" -E copy_directory
    "${SDK_ROOT}/bin" "$<TARGET_FILE_DIR:remotekit_rtc_smoke>")
add_test(NAME remotekit_rtc_smoke COMMAND remotekit_rtc_smoke)
add_executable(remotekit_audio_smoke audio-smoke.cc)
target_link_libraries(remotekit_audio_smoke PRIVATE RemoteKit::SDK)
target_compile_features(remotekit_audio_smoke PRIVATE cxx_std_20)
add_custom_command(TARGET remotekit_audio_smoke POST_BUILD
  COMMAND "${CMAKE_COMMAND}" -E copy_directory "${SDK_ROOT}/bin" "$<TARGET_FILE_DIR:remotekit_audio_smoke>")
add_test(NAME remotekit_audio_smoke COMMAND remotekit_audio_smoke)
