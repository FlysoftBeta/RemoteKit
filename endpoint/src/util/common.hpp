#pragma once
#include <json.hpp>
#include <filesystem>
#include <stdexcept>
#include <string>
namespace remotekit {
using Json = nlohmann::json;
namespace fs = std::filesystem;
class InvalidRequest : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};
std::string Env(const char* key, std::string fallback = {});
fs::path Utf8Path(const std::string& value);
std::string Utf8(const fs::path& path);
std::string Required(const Json& object, const char* name);
std::string ViewId(const Json& request);
size_t DecodedSize(const std::string& text);
}  // namespace remotekit
