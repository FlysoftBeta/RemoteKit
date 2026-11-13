add_library(schedlab_platform STATIC
  ${PROJECT_SOURCE_DIR}/endpoint/src/platform/process.cpp
  ${PROJECT_SOURCE_DIR}/endpoint/src/util/common.cpp)
target_link_libraries(schedlab_platform PUBLIC endpoint_media remotekit_log crypt32)
target_compile_options(schedlab_platform PRIVATE /W4 /utf-8)
add_executable(schedlab main.cpp resources.cpp video.cpp)
target_link_libraries(schedlab PRIVATE endpoint_media schedlab_platform pdh psapi mfplat mfreadwrite
  mfuuid ole32 oleaut32)
target_compile_options(schedlab PRIVATE /W4 /utf-8)
set_target_properties(schedlab PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/endpoint")
add_custom_command(TARGET schedlab POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different $<TARGET_FILE:VPL> $<TARGET_FILE_DIR:schedlab>)
