#pragma once
#include "cluster/node_files.hpp"
#include <windows.h>
namespace remotekit::updater {
namespace fs = std::filesystem;
using cluster::Json;
class Handle {
 public:
  HANDLE value = nullptr;
  Handle() = default;
  explicit Handle(HANDLE h) : value(h) {}
  ~Handle() {
    if (value && value != INVALID_HANDLE_VALUE)
      CloseHandle(value);
  }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value(other.value) { other.value = nullptr; }
  HANDLE Release() {
    auto h = value;
    value = nullptr;
    return h;
  }
};
inline std::wstring Quote(const std::wstring& value) {
  std::wstring out = L"\"";
  size_t slashes = 0;
  for (wchar_t c : value) {
    if (c == L'\\') {
      ++slashes;
      continue;
    }
    if (c == L'\"') {
      out.append(slashes * 2 + 1, L'\\');
      out += c;
    } else {
      out.append(slashes, L'\\');
      out += c;
    }
    slashes = 0;
  }
  out.append(slashes * 2, L'\\');
  out += L'\"';
  return out;
}
inline fs::path ExecutablePath() {
  std::wstring path(32768, L'\0');
  DWORD n = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
  if (!n || n == path.size())
    throw std::runtime_error("cannot locate executable");
  path.resize(n);
  return path;
}
inline bool Stopping(HANDLE stop) {
  return WaitForSingleObject(stop, 0) == WAIT_OBJECT_0;
}
inline bool Delay(HANDLE stop, DWORD milliseconds) {
  return WaitForSingleObject(stop, milliseconds) == WAIT_OBJECT_0;
}
}  // namespace remotekit::updater
