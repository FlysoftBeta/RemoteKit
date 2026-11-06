#include "download.hpp"
#include "archive.hpp"
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
        return Retry("invalid package chunk");
      if (!file.write(reinterpret_cast<const char*>(frame.bytes.data()), frame.bytes.size()))
        return Retry("package write failed");
      offset += frame.bytes.size();
    } else if (frame.kind == cluster::Message::Kind::kJson &&
               json.value("type", "") == "package.end") {
      if (!json.contains("size") || !json["size"].is_number_unsigned() ||
          json["size"].get<uint64_t>() != expected || offset != expected)
        return Retry("package size mismatch");
      file.close();
      auto hash = cluster::Sha256File(partial);
      if (!hash)
        return hash.error();
      if (cluster::Hex(hash.value()) != release["sha256"].get<std::string>()) {
        fs::remove(partial);
        return Retry("package SHA-256 mismatch");
      }
      return {};
    } else
      return Retry("unexpected package response");
  }
  return Retry("update stopped");
}
Result<bool> ReplaceSelf(const fs::path& root, const fs::path& runtime, bool service, Log& log) {
  auto installed = root / L"remotekit_node.exe";
  auto running = ExecutablePath();
  if (!fs::exists(installed) || !fs::equivalent(running, installed))
    return false;
  auto replacement = runtime / L"bin/remotekit_node.exe";
  auto old_hash = cluster::Sha256File(running), new_hash = cluster::Sha256File(replacement);
  if (!old_hash)
    return old_hash.error();
  if (!new_hash)
    return new_hash.error();
  if (old_hash.value() == new_hash.value())
    return false;
  auto old = root / L"remotekit_node.exe.old";
  if (!MoveFileExW(installed.c_str(), old.c_str(),
                   MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
    return Retry("cannot rename installed updater");
  if (!CopyFileW(replacement.c_str(), installed.c_str(), TRUE)) {
    MoveFileExW(old.c_str(), installed.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
    return Retry("cannot install new updater");
  }
  log.Line("installed updated supervisor");
  if (!service) {
    std::wstring command = Quote(installed.wstring()) + L" run --root=" + Quote(root.wstring());
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(installed.c_str(), command.data(), nullptr, nullptr, FALSE,
                        CREATE_NO_WINDOW, nullptr, root.c_str(), &startup, &process)) {
      DeleteFileW(installed.c_str());
      MoveFileExW(old.c_str(), installed.c_str(),
                  MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
      return Retry("cannot start updated supervisor");
    }
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
  }
  return true;
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
Result<bool> Update(const fs::path& root, HANDLE stop, Log& log, bool service) {
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
      return Retry("invalid node release");
    std::string id = release["buildId"].get<std::string>();
    if (id == previous)
      return Retry("Control release equals current runtime");
    fs::create_directories(root / L"downloads");
    fs::create_directories(root / L"runtime");
    auto partial = root / L"downloads" / (id + ".tar.zst.partial");
    auto archive = root / L"downloads" / (id + ".tar.zst");
    auto downloaded = Download(*connection.value().channel, release, partial, stop);
    connection.value().channel->Close();
    if (!downloaded)
      return downloaded.error();
    if (!MoveFileExW(partial.c_str(), archive.c_str(),
                     MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
      return Retry("cannot finish archive download");
    auto temporary = root / L"runtime" /
                     (".extract-" + std::to_string(GetCurrentProcessId()) + "-" +
                      std::to_string(GetTickCount64()));
    if (!fs::create_directory(temporary))
      return Retry("cannot create extraction directory");
    auto extracted = ExtractArchive(archive, temporary);
    if (!extracted) {
      fs::remove_all(ExtendedPath(temporary));
      return extracted.error();
    }
    auto build = cluster::ReadBuildId(temporary / L"node");
    if (!build || build.value() != id ||
        !fs::is_regular_file(temporary / L"node/bin/endpoint_service.exe") ||
        !fs::is_regular_file(temporary / L"node/bin/remotekit_node.exe")) {
      fs::remove_all(ExtendedPath(temporary));
      return Retry("node archive build identity or binaries invalid");
    }
    auto runtime = root / L"runtime" / id;
    if (fs::exists(runtime))
      fs::remove_all(ExtendedPath(runtime));
    fs::rename(temporary / L"node", runtime);
    fs::remove(temporary);
    auto activated = SetCurrent(root, id);
    if (!activated)
      return activated.error();
    for (auto& entry : fs::directory_iterator(root / L"runtime")) {
      auto name = entry.path().filename().string();
      if (name != id && name != previous) {
        std::error_code ec;
        fs::remove_all(ExtendedPath(entry.path()), ec);
      }
    }
    fs::remove(archive);
    log.Line("activated runtime " + id);
    auto replaced = ReplaceSelf(root, runtime, service, log);
    if (!replaced) {
      auto rolled_back = SetCurrent(root, previous);
      if (!rolled_back)
        return rolled_back.error();
      return replaced.error();
    }
    return replaced;
  } catch (...) {
    return Retry("node update failed");
  }
}
}  // namespace remotekit::updater
