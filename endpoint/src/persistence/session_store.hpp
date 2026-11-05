#pragma once
#include "util/common.hpp"
#include "util/error.hpp"
#include <functional>
namespace remotekit {
Result<void> FlushFile(const fs::path& path);
Result<void> WriteDurableJson(const fs::path& path,
                              const Json& value,
                              const std::function<Result<void>()>& before_commit = {});
class SessionStore {
 public:
  explicit SessionStore(fs::path directory) : directory_(std::move(directory)) {}
  Json Load(const fs::path& name, Json fallback = Json::object()) const;
  Result<void> Save(const fs::path& name, const Json& value) const;

 private:
  const fs::path directory_;
};
}  // namespace remotekit
