#pragma once
#include "util/common.hpp"
#include "util/error.hpp"
#include <functional>
namespace remotekit {
inline fs::path LongPath(const fs::path& path) {
  auto absolute = fs::absolute(path).lexically_normal().make_preferred().wstring();
  if (absolute.starts_with(L"\\\\?\\"))
    return absolute;
  if (absolute.starts_with(L"\\\\"))
    return L"\\\\?\\UNC\\" + absolute.substr(2);
  return L"\\\\?\\" + absolute;
}
Result<void> FlushFile(const fs::path& path);
Result<void> WriteDurableText(const fs::path& path,
                              std::string_view bytes,
                              const std::function<Result<void>()>& before_commit = {});
Result<void> WriteDurableJson(const fs::path& path,
                              const Json& value,
                              const std::function<Result<void>()>& before_commit = {});
}  // namespace remotekit
