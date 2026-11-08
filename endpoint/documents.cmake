if(WIN32)
  add_library(remotekit_documents STATIC
    src/documents/document_types.cpp
    src/documents/tool_process.cpp
    src/documents/office_converter.cpp
    src/documents/pdf_renderer.cpp
    src/documents/render_queue.cpp
    src/documents/render_archive.cpp)
  target_include_directories(remotekit_documents PUBLIC src PRIVATE ${RK_DEPS})
  target_compile_features(remotekit_documents PUBLIC cxx_std_20)
  target_compile_definitions(remotekit_documents PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN
    _WIN32_WINNT=0x0A00 WINVER=0x0A00)
  target_compile_options(remotekit_documents PRIVATE /W4 /utf-8)
  target_link_libraries(remotekit_documents PUBLIC remotekit_zstd PRIVATE bcrypt)
  target_sources(remotekit_objects PRIVATE src/documents/object_documents.cpp)
  target_link_libraries(remotekit_objects PUBLIC remotekit_documents)
  set(RK_DOCUMENT_DEPS "${RK_DEPS}/documents")
  add_custom_command(TARGET endpoint_service POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory "${RK_DOCUMENT_DEPS}/libreoffice"
      "$<TARGET_FILE_DIR:endpoint_service>/documents/libreoffice"
    COMMAND ${CMAKE_COMMAND} -E copy_directory "${RK_DOCUMENT_DEPS}/pdfrender"
      "$<TARGET_FILE_DIR:endpoint_service>/documents/pdfrender")
  if(BUILD_TESTING)
    add_executable(endpoint_documents_tests tests/document_tests.cpp)
    target_link_libraries(endpoint_documents_tests PRIVATE remotekit_documents)
    target_include_directories(endpoint_documents_tests PRIVATE ${RK_DEPS})
    target_compile_definitions(endpoint_documents_tests PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
    target_compile_options(endpoint_documents_tests PRIVATE /W4 /utf-8)
    add_test(NAME endpoint_documents COMMAND endpoint_documents_tests
      "${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures" "${PROJECT_SOURCE_DIR}/develop/tmp/documents")
    add_test(NAME endpoint_documents_integration COMMAND endpoint_documents_tests --integration
      "${PROJECT_SOURCE_DIR}/develop/tmp/documents"
      "${RK_DOCUMENT_DEPS}")
    set_tests_properties(endpoint_documents PROPERTIES TIMEOUT 60)
    set_tests_properties(endpoint_documents_integration PROPERTIES TIMEOUT 780 SKIP_RETURN_CODE 77)
  endif()
endif()
