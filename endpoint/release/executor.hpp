#pragma once
#include "planner.hpp"
#include "http.hpp"
namespace remotekit::release {
struct Replan : Failure {
  std::string salt;
  bool base;
  Replan(Error error, std::string asset_salt, bool unusable_base)
      : Failure(std::move(error)), salt(std::move(asset_salt)), base(unusable_base) {}
};
fs::path Execute(const Plan& plan,
                 const fs::path& base,
                 const fs::path& work,
                 const Key& key,
                 const Http& http);
struct Fetched {
  std::string build_id;
  Payload payload;
  fs::path path;
};
Fetched Fetch(const std::string& url,
              State& state,
              const fs::path& base,
              const fs::path& work,
              const Key& key,
              const Http& http);
}  // namespace remotekit::release
