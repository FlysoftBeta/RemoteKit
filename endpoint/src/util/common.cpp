#include <charconv>
#include "util/common.hpp"
#include <windows.h>
#include <wincrypt.h>
#include <algorithm>
namespace remotekit {
std::string Env(const char* key, std::string fallback) {
  const char* v = std::getenv(key);
  return v ? v : fallback;
}
fs::path Utf8Path(const std::string& value) {
  return fs::u8path(value);
}
std::string Utf8(const fs::path& path) {
  auto v = path.u8string();
  return {reinterpret_cast<const char*>(v.data()), v.size()};
}
std::string Required(const Json& object, const char* name) {
  if (!object.contains(name) || !object[name].is_string() ||
      object[name].get<std::string>().empty())
    throw Json::type_error::create(302, std::string("required string: ") + name, &object);
  return object[name].get<std::string>();
}
std::string ViewId(const Json& request) {
  auto id = Required(request, "viewId");
  uint64_t parsed = 0;
  const auto [end, error] = std::from_chars(id.data(), id.data() + id.size(), parsed);
  if (id.empty() || id[0] == '0' || error != std::errc{} || end != id.data() + id.size() || !parsed)
    throw Json::type_error::create(302, "viewId must be nonzero uint64 decimal", &request);
  return id;
}
size_t DecodedSize(const std::string& text) {
  DWORD size = 0;
  if (!CryptStringToBinaryA(text.data(), static_cast<DWORD>(text.size()), CRYPT_STRING_BASE64,
                            nullptr, &size, nullptr, nullptr))
    throw Json::type_error::create(302, "invalid navigation base64",
                                   static_cast<const Json*>(nullptr));
  std::vector<BYTE> bytes(size);
  if (!CryptStringToBinaryA(text.data(), static_cast<DWORD>(text.size()), CRYPT_STRING_BASE64,
                            bytes.data(), &size, nullptr, nullptr))
    throw Json::type_error::create(302, "invalid navigation bytes",
                                   static_cast<const Json*>(nullptr));
  return size;
}
}  // namespace remotekit
