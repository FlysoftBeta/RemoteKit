#pragma once
#include <cstdint>
#include <filesystem>
#include <string_view>
namespace remotekit {
inline const char* ExceptionCodeName(uint32_t code) {
  switch (code) {
    case 0xC0000005:
      return "EXCEPTION_ACCESS_VIOLATION";
    case 0xC00000FD:
      return "EXCEPTION_STACK_OVERFLOW";
    case 0xC0000374:
      return "STATUS_HEAP_CORRUPTION";
    case 0xC0000409:
      return "STATUS_STACK_BUFFER_OVERRUN";
    case 0x80000003:
      return "EXCEPTION_BREAKPOINT";
    case 0xC000001D:
      return "EXCEPTION_ILLEGAL_INSTRUCTION";
    case 0xC0000094:
      return "EXCEPTION_INT_DIVIDE_BY_ZERO";
    case 0xC000000D:
      return "STATUS_INVALID_PARAMETER";
    default:
      return "UNKNOWN_EXCEPTION";
  }
}
// Call before parsing ordinary arguments; handler children do no application work.
bool RunCrashHandler(int argc, wchar_t** argv);
bool RunCrashHandler(int argc, char** argv);
void InstallCrashHandler(const std::filesystem::path& logs_root, std::string_view proc);
}  // namespace remotekit
