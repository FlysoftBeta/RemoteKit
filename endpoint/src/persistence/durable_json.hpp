#pragma once
#include "util/common.hpp"
#include "util/error.hpp"
#include <functional>
namespace remotekit {
Result<void> FlushFile(const fs::path& path);
Result<void> WriteDurableJson(const fs::path& path,
                              const Json& value,
                              const std::function<Result<void>()>& before_commit = {});
}  // namespace remotekit
