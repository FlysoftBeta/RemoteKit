#pragma once
#include "common.hpp"

namespace remotekit::release {
struct NotInstalled {
  std::optional<std::string> invalid;
};
struct Installed {
  std::string id;
};
using CurrentState = std::variant<NotInstalled, Installed>;
inline constexpr const wchar_t* kControlFiles[] = {
    L"bin/node.exe",           L"bin/remotekit_control.exe",
    L"bin/remotekit_node.exe", L"control/dist/server.mjs",
    L"release/node.json",      L"release/node.tar.zst"};
inline constexpr const wchar_t* kNodeFiles[] = {
    L"bin/endpoint_service.exe", L"bin/remotekit_node.exe", L"bin/remotekit_snapshot.exe"};

inline std::string InstalledId(const CurrentState& state) {
  const auto* installed = std::get_if<Installed>(&state);
  return installed ? installed->id : std::string{};
}
inline Result<CurrentState> ValidateVersion(const fs::path& version,
                                            const std::string& id,
                                            std::span<const wchar_t* const> required) {
  try {
    for (auto name : required)
      if (!fs::is_regular_file(version / name))
        return CurrentState{NotInstalled{"installed version is missing a required file"}};
    if (!fs::is_regular_file(version / L"build.json"))
      return CurrentState{NotInstalled{"installed version is missing build.json"}};
    std::ifstream file(version / L"build.json", std::ios::binary | std::ios::ate);
    if (!file.is_open())
      return Error{ErrorCode::kUnavailable, "cannot open installed build.json"};
    const auto size = file.tellg();
    if (size < 0)
      return Error{ErrorCode::kUnavailable, "cannot size installed build.json"};
    if (size > 65536)
      return CurrentState{NotInstalled{"installed build.json is too large"}};
    std::string text(static_cast<size_t>(size), '\0');
    file.seekg(0);
    if (!file.read(text.data(), text.size()))
      return Error{ErrorCode::kUnavailable, "cannot read installed build.json"};
    auto build = ParseJson(text);
    Keys(build, {"buildId"});
    if (HexString(build.at("buildId")) != id)
      return CurrentState{NotInstalled{"installed build identity differs from current"}};
    return CurrentState{Installed{id}};
  } catch (const Failure& failure) {
    return CurrentState{NotInstalled{failure.what()}};
  } catch (const Json::exception& error) {
    return CurrentState{NotInstalled{error.what()}};
  } catch (const fs::filesystem_error& error) {
    return Error{ErrorCode::kUnavailable, error.what()};
  }
}
inline Result<CurrentState> ReadCurrent(const fs::path& root,
                                        const fs::path& versions,
                                        std::span<const wchar_t* const> required) {
  try {
    updater::Handle file(CreateFileW((root / L"current").c_str(), GENERIC_READ,
                                     FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                     nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (file.value == INVALID_HANDLE_VALUE) {
      const auto error = GetLastError();
      if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND)
        return CurrentState{NotInstalled{}};
      return WithOsError(ErrorCode::kUnavailable, "cannot open current", OsError::Kind::kWin32,
                         error);
    }
    std::array<char, 67> bytes{};
    DWORD count = 0;
    if (!ReadFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr))
      return WithOsError(ErrorCode::kUnavailable, "cannot read current", OsError::Kind::kWin32,
                         GetLastError());
    std::string id(bytes.data(), count);
    while (!id.empty() && (id.back() == '\r' || id.back() == '\n'))
      id.pop_back();
    if (count == bytes.size() || !cluster::ValidBuildId(id))
      return CurrentState{NotInstalled{"invalid current build identity"}};
    return ValidateVersion(root / versions / id, id, required);
  } catch (const fs::filesystem_error& error) {
    return Error{ErrorCode::kUnavailable, error.what()};
  }
}
}  // namespace remotekit::release
