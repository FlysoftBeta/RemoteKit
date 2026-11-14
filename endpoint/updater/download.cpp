#include "download.hpp"
#include "archive.hpp"
#include "replacement.hpp"
#include "util/wire_error.hpp"
#include "cluster/channel.hpp"
#include "protocol/limits.hpp"
#include <fstream>

namespace remotekit::updater {
namespace {
using namespace std::chrono_literals;
Error Retry(const char* message) {
  return {ErrorCode::kUnavailable, message};
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
      if (message.error().code != ErrorCode::kBusy)
        return message.error();
      if (std::chrono::steady_clock::now() < deadline)
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
          frame.bytes.size() > limits::objectChunkBytes || frame.bytes.size() > expected - offset)
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
         fs::is_regular_file(runtime / L"bin/remotekit_node.exe") &&
         fs::is_regular_file(runtime / L"bin/remotekit_snapshot.exe");
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
  if (extracted && RuntimeInstalled(temporary / L"node", id) &&
      !MoveFileExW((temporary / L"node").c_str(), runtime.c_str(), MOVEFILE_WRITE_THROUGH))
    error = std::error_code(GetLastError(), std::system_category());
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
Result<release::CurrentState> ReadCurrent(const fs::path& root) {
  return release::ReadCurrent(root, L"runtime", release::kNodeFiles);
}
Json DecodeNodeRelease(std::string_view text) {
  auto value = release::ParseJson(text);
  release::Keys(value, {"buildId", "sha256", "size"});
  release::HexString(value.at("buildId"));
  release::HexString(value.at("sha256"));
  release::Require(release::Unsigned(value.at("size")) > 0, "invalid node release size");
  return value;
}
Result<void> InstallBundled(const fs::path& root, const fs::path& package) {
  auto build = cluster::ReadBuildId(package);
  if (!build)
    return build.error();
  const auto& id = build.value();
  if (!cluster::ValidBuildId(id))
    return Error{ErrorCode::kInternal, "invalid bundled build identity"};
  auto archive = package / L"release/node.tar.zst";
  std::ifstream descriptor(package / L"release/node.json", std::ios::binary);
  if (!descriptor.is_open())
    return Retry("cannot open bundled node release");
  const std::string text((std::istreambuf_iterator<char>(descriptor)), {});
  if (descriptor.bad())
    return Retry("cannot read bundled node release");
  Json release;
  try {
    release = DecodeNodeRelease(text);
  } catch (const release::Failure& failure) {
    return failure.error;
  }
  if (release["buildId"] != id || fs::file_size(archive) != release["size"].get<uint64_t>())
    return Error{ErrorCode::kRejected, "invalid bundled node release"};
  if (RuntimeInstalled(root / L"runtime" / id, id)) {
    CleanupRuntime(root, id, false);
    return {};
  }
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
Result<bool> Update(const fs::path& root,
                    HANDLE stop,
                    Log& log,
                    bool service,
                    RetryUnit& retry,
                    UpdateStage& stage) {
  try {
    auto files = cluster::LoadNodeFiles(root);
    if (!files)
      return files.error();
    auto current = ReadCurrent(root);
    if (!current)
      return current.error();
    const auto previous = release::InstalledId(current.value());
    if (std::holds_alternative<DiscoverRelease>(stage)) {
      auto connection = cluster::ConnectWebSocket(
          files.value().control, files.value().private_key, files.value().control_public_key,
          {"updater", files.value().node_id, previous.empty() ? "dev" : previous, {}});
      if (!connection)
        return connection.error();
      auto& reply = connection.value().reply;
      if (reply.value("type", "") != "node.release" || !reply.contains("release") ||
          reply["release"].is_null())
        return Retry("Control has no node release");
      auto release = DecodeNodeRelease(reply["release"].dump());
      std::string id = release["buildId"].get<std::string>();
      retry.Input(release.dump());
      if (!retry.Ready())
        return *retry.Failure();
      if (id == previous)
        return ReplaceExecutable(root / L"remotekit_node.exe",
                                 root / L"runtime" / id / L"bin/remotekit_node.exe", root,
                                 L"run --root=" + Quote(root.wstring()), service, log);
      fs::create_directories(root / L"downloads");
      fs::create_directories(root / L"runtime");
      auto partial = root / L"downloads" / (id + ".tar.zst.partial");
      auto archive = root / L"downloads" / (id + ".tar.zst");
      auto downloaded = Download(*connection.value().channel, release, partial, stop);
      connection.value().channel->Close();
      if (!downloaded) {
        return downloaded.error();
      }
      if (!MoveFileExW(partial.c_str(), archive.c_str(),
                       MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
        return Retry("cannot finish archive download");
      stage = DownloadedRelease{std::move(release), std::move(archive)};
    }
    const auto& downloaded = std::get<DownloadedRelease>(stage);
    const auto id = downloaded.descriptor["buildId"].get<std::string>();
    auto installed = InstallRuntime(root, downloaded.archive, id);
    if (!installed) {
      return installed.error();
    }
    auto runtime = root / L"runtime" / id;
    release::AtomicText(root / L"current", id);
    log.Event(LogLevel::kInfo, "runtime.activated", {{"buildId", id}});
    auto replaced =
        ReplaceExecutable(root / L"remotekit_node.exe", runtime / L"bin/remotekit_node.exe", root,
                          L"run --root=" + Quote(root.wstring()), service, log);
    if (!replaced)
      return replaced.error();
    CleanupRuntimeBestEffort(root, id, log);
    stage = DiscoverRelease{};
    return replaced;
  } catch (const release::Failure& failure) {
    return failure.error;
  } catch (const fs::filesystem_error& error) {
    return Error{ErrorCode::kUnavailable, error.what()};
  } catch (const std::exception& error) {
    return Error{ErrorCode::kInternal, error.what()};
  }
}
}  // namespace remotekit::updater
