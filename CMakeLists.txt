cmake_minimum_required(VERSION 3.25)
project(RemoteKit VERSION 0.1.0 LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
include(CTest)
if(MSVC)
  # Release binaries must be byte-identical for identical sources, because the package buildId
  # hashes them. /Brepro replaces timestamps and the PDB GUID with content hashes; /Z7 keeps debug
  # info in each object instead of a shared compile PDB written concurrently by mspdbsrv. The
  # package build links with lld-link (tools/build-endpoint.cmd): link.exe PDBs differ per link.
  add_compile_options("$<$<CONFIG:Release>:/Z7>" "$<$<CONFIG:Release>:/Brepro>")
  add_link_options("$<$<CONFIG:Release>:/DEBUG:FULL>" "$<$<CONFIG:Release>:/OPT:REF>"
    "$<$<CONFIG:Release>:/OPT:ICF>" "$<$<CONFIG:Release>:/Brepro>")
  string(APPEND CMAKE_STATIC_LINKER_FLAGS_RELEASE " /Brepro")
endif()
if(WIN32)
  set(RK_DEPS "${PROJECT_SOURCE_DIR}/build/dependencies")
  if(NOT EXISTS "${RK_DEPS}/libvpl-2.17.0/CMakeLists.txt")
    message(FATAL_ERROR "Run depot_tools python3 tools/fetch-media-deps.py first")
  endif()
  set(BUILD_SHARED_LIBS ON CACHE BOOL "" FORCE)
  set(BUILD_TESTS OFF CACHE BOOL "" FORCE)
  set(BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(BUILD_EXPERIMENTAL OFF CACHE BOOL "" FORCE)
  set(INSTALL_EXAMPLES OFF CACHE BOOL "" FORCE)
  add_subdirectory("${RK_DEPS}/libvpl-2.17.0" "${CMAKE_BINARY_DIR}/libvpl" EXCLUDE_FROM_ALL)
endif()
add_subdirectory(endpoint)
