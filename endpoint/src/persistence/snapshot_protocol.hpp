#pragma once
#include "util/common.hpp"
#include "util/error.hpp"
#include <windows.h>
#include <span>
#include <vector>

namespace remotekit::snapshot {
constexpr uint32_t kMaxRead = 1024 * 1024;
constexpr uint32_t kMaxFrame = 32 * 1024 * 1024;
inline bool SafePath(const fs::path& path) {
  if (path.empty() || path.is_absolute() || path.has_root_name())
    return false;
  for (const auto& part : path) {
    const auto text = part.wstring();
    if (text.empty() || text == L"." || text == L".." ||
        text.find_first_of(L":*?<>|\"") != std::wstring::npos || text.back() == L'.' ||
        text.back() == L' ')
      return false;
  }
  return true;
}
inline bool Transfer(HANDLE pipe, void* data, uint32_t size, bool write) {
  auto* next = static_cast<uint8_t*>(data);
  while (size) {
    DWORD done = 0;
    const bool ok = write ? WriteFile(pipe, next, size, &done, nullptr)
                          : ReadFile(pipe, next, size, &done, nullptr);
    if (!ok || !done)
      return false;
    next += done;
    size -= done;
  }
  return true;
}
inline bool Send(HANDLE pipe, std::span<const uint8_t> bytes) {
  uint32_t size = static_cast<uint32_t>(bytes.size());
  return size <= kMaxFrame && Transfer(pipe, &size, 4, true) &&
         Transfer(pipe, const_cast<uint8_t*>(bytes.data()), size, true);
}
inline bool SendJson(HANDLE pipe, const Json& json) {
  auto text = json.dump();
  return Send(pipe, {reinterpret_cast<const uint8_t*>(text.data()), text.size()});
}
inline bool Receive(HANDLE pipe, std::vector<uint8_t>& bytes) {
  uint32_t size = 0;
  if (!Transfer(pipe, &size, 4, false) || size > kMaxFrame)
    return false;
  bytes.resize(size);
  return Transfer(pipe, bytes.data(), size, false);
}
inline std::wstring PipeName(const std::string& node) {
  return L"\\\\.\\pipe\\remotekit-snapshot-" + fs::path(node).wstring();
}
}  // namespace remotekit::snapshot
