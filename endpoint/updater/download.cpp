#include "download.hpp"
#include "archive.hpp"
#include "replacement.hpp"
#include "util/wire_error.hpp"
#include "cluster/channel.hpp"
#include <fstream>

namespace remotekit::updater {
namespace {
using namespace std::chrono_literals;
Error Retry(const char* message) {
  return {ErrorCode::kUnavailable, message};
}
Result<void> SetCurrent(const fs::path& root, const std::string& id) {
  if (id.empty()) {
    std::error_code ec;
    fs::remove(root / L"current", ec);
    if (ec)
      return Retry("cannot clear current");
    return {};
  }
  auto temporary = root / L"current.tmp";
  {
    std::ofstream file(temporary, std::ios::binary | std::ios::trunc);
    if (!file.write(id.data(), id.size()))
      return Retry("cannot write current");
  }
  if (!MoveFileExW(temporary.c_str(), (root / L"current").c_str(),
                   MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
    return Retry("cannot activate runtime");
  return {};
}
Result<void> Download(cluster::Channel& channel,
                      const Json& release,
                      const fs::path& partial,
                      HANDLE stop) {
  uint64_t expected = release["size"].get<uint64_t>();
  uint64_t offset = fs::exists(partial) ? fs::file_size(partial) : 0;
  if (offset > expected) {
    fs::remove(partial);
    offset = 0;
  }
  auto requested =
      channel.Send({{"type", "package.get"}, {"buildId", release["buildId"]}, {"offset", offset}});
  if (!requested)
    return requested.error();
  std::ofstream file(partial, std::ios::binary | std::ios::app);
  if (!file)
    return Retry("cannot open partial download");
  auto deadline = std::chrono::steady_clock::now() + 20s;
  while (!Stopping(stop)) {
    auto message = channel.Receive(100ms);
    if (!message) {
      if (message.error().code == ErrorCode::kBusy && std::chrono::steady_clock::now() < deadline)
        continue;
      return Retry("package download interrupted");
    }
    deadline = std::chrono::steady_clock::now() + 20s;
    auto& frame = message.value();
    auto& json = frame.json;
    if (frame.kind == cluster::Message::Kind::kBinary &&
        json.value("type", "") == "package.chunk") {
      if (!json.contains("offset") || !json["offset"].is_number_unsigned() ||
          json["offset"].get<uint64_t>() != offset || frame.bytes.empty() ||
          frame.bytes.size() > 1024 * 1024 || frame.bytes.size() > expected - offset)
        return Error{ErrorCode::kInternal, "invalid package chunk"};
      if (!file.write(reinterpret_cast<const char*>(frame.bytes.data()), frame.bytes.size()))
        return Retry("package write failed");
      offset += frame.bytes.size();
    } else if (frame.kind == cluster::Message::Kind::kJson &&
               json.value("type", "") == "package.end") {
      if (!json.contains("size") || !json["size"].is_number_unsigned() ||
          json["size"].get<uint64_t>() != expected || offset != expected)
        return Error{ErrorCode::kInternal, "package size mismatch"};
      file.close();
      auto hash = cluster::Sha256File(partial);
      if (!hash)
        return hash.error();
      if (cluster::Hex(hash.value()) != release["sha256"].get<std::string>()) {
        fs::remove(partial);
        return Error{ErrorCode::kRejected, "package SHA-256 mismatch"};
      }
      return {};
    } else if (frame.kind == cluster::Message::Kind::kJson &&
               json.value("type", "") == "package.error") {
      return ParseWireError(json.value("error", Json()));
    } else
      return Error{ErrorCode::kInternal, "unexpected package response"};
  }
  return Retry("update stopped");
}
bool RuntimeInstalled(const fs::path& runtime, const std::string& id) {
  auto build = cluster::ReadBuildId(runtime);
  return build && build.value() == id &&
         fs::is_regular_file(runtime / L"bin/endpoint_service.exe") &&
         fs::is_regular_file(runtime / L"bin/remotekit_node.exe");
}
Result<void> InstallRuntime(const fs::path& root, const fs::path& archive, const std::string& id) {
  auto runtime = root / L"runtime" / id;
  if (RuntimeInstalled(runtime, id))
    return {};
  fs::create_directories(runtime.parent_path());
  auto temporary = runtime.parent_path() / (".extract-" + std::to_string(GetCurrentProcessId()) +
                                            "-" + std::to_string(GetTickCount64()));
  if (!fs::create_directory(temporary))
    return Retry("cannot create extraction directory");
  auto extracted = ExtractArchive(archive, temporary);
  std::error_code error;
  if (extracted && RuntimeInstalled(temporary / L"node", id))
    fs::rename(temporary / L"node", runtime, error);
  std::error_code cleanup_error;
  fs::remove_all(ExtendedPath(temporary), cleanup_error);
  if (!extracted)
    return extracted.error();
  if (error)
    return Error{ErrorCode::kUnavailable, "Cannot move extracted runtime: " + error.message()};
  if (!RuntimeInstalled(runtime, id))
    return Error{ErrorCode::kInternal, "Release archive does not contain the promised runtime"};
  return {};
}
}  // namespace
std::string ReadCurrent(const fs::path& root) {
  std::ifstream file(root / L"current", std::ios::binary);
  std::string id((std::istreambuf_iterator<char>(file)), {});
  while (!id.empty() && (id.back() == '\r' || id.back() == '\n'))
    id.pop_back();
  if (!cluster::ValidBuildId(id))
    return {};
  auto runtime = root / L"runtime" / id;
  auto build = cluster::ReadBuildId(runtime);
  if (!build || build.value() != id || !fs::is_regular_file(runtime / L"bin/endpoint_service.exe"))
    return {};
  return id;
}
Result<void> InstallBundled(const fs::path& root, const fs::path& package) {
  auto build = cluster::ReadBuildId(package);
  if (!build)
    return build.error();
  const auto& id = build.value();
  if (!cluster::ValidBuildId(id))
    return Error{ErrorCode::kInternal, "invalid bundled build identity"};
  if (RuntimeInstalled(root / L"runtime" / id, id)) {
    CleanupRuntime(root, id, false);
    return {};
  }
  auto archive = package / L"release/node.tar.zst";
  std::ifstream descriptor(package / L"release/node.json", std::ios::binary);
  auto release = Json::parse(descriptor, nullptr, false);
  if (!release.is_object() || !release.contains("buildId") || release["buildId"] != id ||
      !release.contains("sha256") || !release["sha256"].is_string() || !release.contains("size") ||
      !release["size"].is_number_unsigned() ||
      fs::file_size(archive) != release["size"].get<uint64_t>())
    return Error{ErrorCode::kInternal, "invalid bundled node release"};
  auto hash = cluster::Sha256File(archive);
  if (!hash)
    return hash.error();
  if (cluster::Hex(hash.value()) != release["sha256"].get<std::string>())
    return Error{ErrorCode::kRejected, "bundled node package SHA-256 mismatch"};
  auto installed = InstallRuntime(root, archive, id);
  if (installed)
    CleanupRuntime(root, id, false);
  return installed;
}
Result<bool> Update(const fs::path& root, HANDLE stop, Log& log, bool service) {
  static std::string failed_release;
  try {
    auto files = cluster::LoadNodeFiles(root);
    if (!files)
      return files.error();
    std::string previous = ReadCurrent(root);
    auto connection = cluster::ConnectWebSocket(
        files.value().control, files.value().key,
        {"updater", files.value().node_id, previous.empty() ? "dev" : previous, {}});
    if (!connection)
      return connection.error();
    auto& reply = connection.value().reply;
    if (reply.value("type", "") != "node.release" || !reply.contains("release") ||
        reply["release"].is_null())
      return Retry("Control has no node release");
    auto release = reply["release"];
    if (!release.is_object() || !release.contains("buildId") || !release["buildId"].is_string() ||
        !cluster::ValidBuildId(release["buildId"].get<std::string>()) ||
        !release.contains("sha256") || !release["sha256"].is_string() ||
        !cluster::ValidBuildId(release["sha256"].get<std::string>()) || !release.contains("size") ||
        !release["size"].is_number_unsigned() || release["size"].get<uint64_t>() == 0)
      return Error{ErrorCode::kInternal, "invalid node release"};
    std::string id = release["buildId"].get<std::string>();
    if (id == failed_release)
      return Retry("Waiting for a different Control release");
    if (id == previous)
      return Retry("Control release equals current runtime");
    fs::create_directories(root / L"downloads");
    fs::create_directories(root / L"runtime");
    auto partial = root / L"downloads" / (id + ".tar.zst.partial");
    auto archive = root / L"downloads" / (id + ".tar.zst");
    auto downloaded = Download(*connection.value().channel, release, partial, stop);
    connection.value().channel->Close();
    if (!downloaded) {
      if (downloaded.error().code == ErrorCode::kRejected ||
          downloaded.error().code == ErrorCode::kInternal)
        failed_release = id;
      return downloaded.error();
    }
    if (!MoveFileExW(partial.c_str(), archive.c_str(),
                     MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
      return Retry("cannot finish archive download");
    auto installed = InstallRuntime(root, archive, id);
    if (!installed) {
      if (installed.error().code == ErrorCode::kRejected ||
          installed.error().code == ErrorCode::kInternal)
        failed_release = id;
      return installed.error();
    }
    auto runtime = root / L"runtime" / id;
    auto activated = SetCurrent(root, id);
    if (!activated)
      return activated.error();
    log.Event(LogLevel::kInfo, "runtime.activated", {{"buildId", id}});
    auto replaced =
        ReplaceExecutable(root / L"remotekit_node.exe", runtime / L"bin/remotekit_node.exe", root,
                          L"run --root=" + Quote(root.wstring()), service, log);
    if (!replaced) {
      auto rolled_back = SetCurrent(root, previous);
      if (!rolled_back)
        return rolled_back.error();
      return replaced.error();
    }
    CleanupRuntime(root, id, true);
    return replaced;
  } catch (const fs::filesystem_error& error) {
    return Error{ErrorCode::kUnavailable, error.what()};
  } catch (const std::exception& error) {
    return Error{ErrorCode::kInternal, error.what()};
  }
}
}  // namespace remotekit::updater
