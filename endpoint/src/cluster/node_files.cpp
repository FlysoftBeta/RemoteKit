#include "cluster/node_files.hpp"
#include "persistence/config_formats.hpp"
#include <windows.h>
#include <winhttp.h>
#include <algorithm>
#include <fstream>
namespace remotekit::cluster {
NodeFiles::~NodeFiles() {
  SecureZeroMemory(private_key.data(), private_key.size());
}
bool ValidNodeId(std::string_view s) {
  auto alnum = [](char c) { return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'); };
  return !s.empty() && s.size() <= 63 && alnum(s[0]) &&
         std::all_of(s.begin(), s.end(), [&](char c) { return alnum(c) || c == '-'; });
}
bool ValidBuildId(std::string_view s) {
  return s.size() == 64 && std::all_of(s.begin(), s.end(), [](char c) {
           return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
         });
}
Result<Key> DecodeKey(std::string_view s) {
  Key key{};
  auto fail = [&]() -> Result<Key> {
    SecureZeroMemory(key.data(), key.size());
    return Error{ErrorCode::kInvalidRequest, "X25519 key must be base64 of 32 bytes"};
  };
  if (s.size() != 44 || s.back() != '=')
    return fail();
  constexpr std::string_view alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  uint32_t accumulator = 0;
  int bits = 0;
  size_t at = 0;
  for (size_t i = 0; i < 43; ++i) {
    auto digit = alphabet.find(s[i]);
    if (digit == std::string_view::npos)
      return fail();
    accumulator = (accumulator << 6) | static_cast<uint32_t>(digit);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (at >= 32)
        return fail();
      key[at++] = static_cast<uint8_t>(accumulator >> bits);
    }
  }
  if (at != 32 || (accumulator & 3) != 0)
    return fail();
  Key out = key;
  SecureZeroMemory(key.data(), key.size());
  return out;
}
Result<ControlAddress> ParseControlUrl(const std::string& url) {
  if ((!url.starts_with("ws://") && !url.starts_with("wss://")) ||
      url.find_first_of("?#\\") != std::string::npos ||
      std::any_of(url.begin(), url.end(), [](unsigned char c) { return c <= 32; }))
    return Error{ErrorCode::kInvalidRequest, "control URL must be ws(s)://host[:port]/api/node"};
  size_t host = url.find("://") + 3, slash = url.find('/', host);
  if (slash == std::string::npos || slash == host || url.substr(slash) != "/api/node" ||
      url.find('@', host) != std::string::npos)
    return Error{ErrorCode::kInvalidRequest, "invalid control URL"};
  bool secure = url.starts_with("wss://");
  std::string http = (secure ? "https://" : "http://") + url.substr(secure ? 6 : 5);
  int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, http.data(),
                                  static_cast<int>(http.size()), nullptr, 0);
  if (!count)
    return Error{ErrorCode::kInvalidRequest, "invalid control URL encoding"};
  std::wstring wide(count, L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, http.data(), static_cast<int>(http.size()),
                      wide.data(), count);
  URL_COMPONENTS parts{};
  parts.dwStructSize = sizeof(parts);
  parts.dwHostNameLength = parts.dwUserNameLength = parts.dwPasswordLength = static_cast<DWORD>(-1);
  if (!WinHttpCrackUrl(wide.c_str(), static_cast<DWORD>(wide.size()), 0, &parts) ||
      !parts.dwHostNameLength || parts.dwUserNameLength || parts.dwPasswordLength)
    return Error{ErrorCode::kInvalidRequest, "invalid control URL"};
  return ControlAddress{std::wstring(parts.lpszHostName, parts.dwHostNameLength), parts.nPort,
                        secure};
}
Result<NodeFiles> LoadNodeFiles(const std::filesystem::path& root) {
  try {
    std::ifstream file(root / L"node.json", std::ios::binary);
    if (!file)
      return Error{ErrorCode::kUnavailable, "cannot read node.json"};
    std::string raw((std::istreambuf_iterator<char>(file)), {});
    auto decoded = config_formats::Decode(raw, config_formats::Node, persisted::Store::kNode);
    SecureZeroMemory(raw.data(), raw.size());
    if (!decoded)
      return decoded.error();
    auto json = std::move(decoded).value();
    auto& encoded = json["privateKey"].get_ref<std::string&>();
    auto key = DecodeKey(encoded);
    SecureZeroMemory(encoded.data(), encoded.size());
    if (!key)
      return key.error();
    auto control_key = DecodeKey(json["controlPublicKey"].get<std::string>());
    if (!control_key)
      return control_key.error();
    NodeFiles out;
    out.private_key = key.value();
    SecureZeroMemory(key.value().data(), 32);
    out.control_public_key = control_key.value();
    if (json.contains("control")) {
      out.control = json["control"].get<std::string>();
      auto valid = ParseControlUrl(out.control);
      if (!valid)
        return valid.error();
    }
    out.node_id = json["nodeId"].get<std::string>();
    if (!ValidNodeId(out.node_id))
      return Error{ErrorCode::kInvalidRequest, "invalid nodeId"};
    return out;
  } catch (const std::exception& error) {
    return CorruptState(std::string("node.json: ") + error.what());
  }
}
Result<std::string> ReadBuildId(const std::filesystem::path& root) {
  std::error_code ec;
  bool exists = std::filesystem::exists(root / L"build.json", ec);
  if (ec)
    return Error{ErrorCode::kUnavailable, "cannot inspect build.json"};
  if (!exists)
    return std::string("dev");
  std::ifstream file(root / L"build.json", std::ios::binary);
  auto json = Json::parse(file, nullptr, false);
  if (!json.is_object() || json.size() != 1 || !json.contains("buildId") ||
      !json["buildId"].is_string() || !ValidBuildId(json["buildId"].get<std::string>()))
    return Error{ErrorCode::kInvalidRequest, "invalid build.json"};
  return json["buildId"].get<std::string>();
}
}  // namespace remotekit::cluster
