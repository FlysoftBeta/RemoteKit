#include "payload.hpp"
#include "current.hpp"
#include "updater/archive.hpp"
#include <zstd.h>
#include <algorithm>
#include <thread>

namespace remotekit::release {
namespace {
bool AllowedRoot(std::string_view root) {
  std::string lower(root);
  std::transform(lower.begin(), lower.end(), lower.begin(),
                 [](unsigned char c) { return static_cast<char>(tolower(c)); });
  return lower != "release" && lower != "payload.tar" && lower != "payload.json";
}
updater::ArchiveRead Reader(std::ifstream& file) {
  return [&](std::span<uint8_t> bytes) {
    file.read(reinterpret_cast<char*>(bytes.data()), bytes.size());
    Io(!file.bad(), "cannot read payload tar");
    return static_cast<size_t>(file.gcount());
  };
}
std::string Build(std::span<const uint8_t> bytes) {
  auto json = ParseJson({reinterpret_cast<const char*>(bytes.data()), bytes.size()});
  Keys(json, {"buildId"});
  return HexString(json["buildId"]);
}
Bytes EntryBytes(const updater::ArchiveEntry& entry, const updater::ArchiveRead& read) {
  Require(entry.type != '5' && entry.size <= 65536, "invalid payload build.json");
  Bytes data(static_cast<size_t>(entry.size));
  size_t offset = 0;
  while (offset < data.size()) {
    size_t n = read(std::span(data).subspan(offset));
    Require(n != 0, "truncated payload build.json");
    offset += n;
  }
  return data;
}
class NodeWriter {
 public:
  explicit NodeWriter(const fs::path& path)
      : file_(path, std::ios::binary), context_(ZSTD_createCCtx()), buffer_(ZSTD_CStreamOutSize()) {
    Io(file_.is_open() && context_, "cannot create node archive");
    Check(ZSTD_CCtx_setParameter(context_, ZSTD_c_compressionLevel, 9));
    Check(ZSTD_CCtx_setParameter(context_, ZSTD_c_checksumFlag, 1));
    Check(ZSTD_CCtx_setParameter(context_, ZSTD_c_nbWorkers,
                                 std::max(1u, std::thread::hardware_concurrency())));
  }
  ~NodeWriter() { ZSTD_freeCCtx(context_); }
  void Write(std::span<const uint8_t> bytes, bool end = false) {
    ZSTD_inBuffer input{bytes.data(), bytes.size(), 0};
    size_t remaining;
    do {
      ZSTD_outBuffer output{buffer_.data(), buffer_.size(), 0};
      remaining =
          ZSTD_compressStream2(context_, &output, &input, end ? ZSTD_e_end : ZSTD_e_continue);
      Check(remaining);
      Io(static_cast<bool>(file_.write(reinterpret_cast<const char*>(buffer_.data()), output.pos)),
         "cannot write node archive");
    } while (input.pos != input.size || (end && remaining));
    if (end) {
      file_.close();
      Io(!file_.fail(), "cannot finish node archive");
    }
  }

 private:
  static void Check(size_t result) { Io(!ZSTD_isError(result), "node archive compression failed"); }
  std::ofstream file_;
  ZSTD_CCtx* context_;
  Bytes buffer_;
};
}  // namespace
std::string PayloadBuildId(const fs::path& tar) {
  std::ifstream file(tar, std::ios::binary);
  Io(file.is_open(), "cannot open payload tar");
  std::string id;
  Take(updater::WalkTar(Reader(file), AllowedRoot,
                        [&](const updater::ArchiveEntry& entry, const updater::ArchiveRead& data,
                            const updater::ArchiveCopy&) {
                          if (entry.name == "build.json") {
                            Require(id.empty(), "duplicate payload build.json");
                            id = Build(EntryBytes(entry, data));
                          }
                        }));
  Require(!id.empty(), "payload has no build.json");
  return id;
}
fs::path InstallPayload(const fs::path& root,
                        const fs::path& tar,
                        const std::string& expected,
                        PayloadSource source) {
  Require(cluster::ValidBuildId(expected), "invalid payload identity");
  auto version = root / L"versions" / expected;
  if (fs::exists(version)) {
    auto valid = ValidateVersion(version, expected, kControlFiles);
    if (!valid)
      throw Failure(valid.error());
    if (std::holds_alternative<NotInstalled>(valid.value()))
      Fail(ErrorCode::kConflict, "existing version differs from payload or is incomplete");
    Require(PayloadBuildId(tar) == expected, "payload build identity mismatch");
    return version;
  }
  auto stage = root / L"work" / ("stage-" + expected);
  fs::create_directories(root / L"work");
  fs::create_directories(root / L"versions");
  if (fs::exists(stage))
    fs::remove_all(updater::ExtendedPath(stage));
  fs::create_directories(stage / L"release");
  try {
    auto archive = stage / L"release/node.tar.zst";
    NodeWriter node(archive);
    std::ifstream file(tar, std::ios::binary);
    Io(file.is_open(), "cannot open payload tar");
    std::string node_id;
    Take(updater::WalkTar(
        Reader(file), AllowedRoot,
        [&](const updater::ArchiveEntry& entry, const updater::ArchiveRead& data,
            const updater::ArchiveCopy& raw) {
          if (entry.name == "node" || entry.name.starts_with("node/")) {
            Require(entry.name != "node" || entry.type == '5', "node root must be a directory");
            if (entry.name == "node/build.json") {
              Require(node_id.empty() && entry.size <= 65536 && entry.type != '5',
                      "invalid node build.json");
              Bytes record;
              raw([&](std::span<const uint8_t> bytes) {
                record.insert(record.end(), bytes.begin(), bytes.end());
                node.Write(bytes);
              });
              node_id = Build(std::span(record).subspan(entry.raw_header.size(),
                                                        static_cast<size_t>(entry.size)));
            } else {
              raw([&](std::span<const uint8_t> bytes) { node.Write(bytes); });
            }
            return;
          }
          auto destination = updater::ExtendedPath(stage / entry.path);
          if (entry.type == '5') {
            fs::create_directories(destination);
            return;
          }
          fs::create_directories(destination.parent_path());
          updater::Handle output(CreateFileW(destination.c_str(), GENERIC_WRITE, 0, nullptr,
                                             CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
          Io(output.value != INVALID_HANDLE_VALUE, "cannot create payload entry");
          std::array<uint8_t, 65536> bytes;
          while (size_t n = data(bytes)) {
            DWORD written = 0;
            Io(WriteFile(output.value, bytes.data(), static_cast<DWORD>(n), &written, nullptr) &&
                   written == n,
               "cannot write payload entry");
          }
        }));
    std::array<uint8_t, 1024> end{};
    node.Write(end, true);
    Require(Take(cluster::ReadBuildId(stage)) == expected && node_id == expected,
            "payload build identity mismatch");
    for (auto required : {L"bin/node.exe", L"bin/remotekit_control.exe", L"bin/remotekit_node.exe",
                          L"control/dist/server.mjs"})
      Require(fs::is_regular_file(stage / required), "payload missing required file");
    WriteText(
        stage / L"release/node.json",
        Json{{"buildId", expected}, {"sha256", HashFile(archive)}, {"size", fs::file_size(archive)}}
            .dump());
    auto size = fs::file_size(tar);
    auto hash = HashFile(tar);
    file.close();
    if (source == PayloadSource::kMove)
      fs::rename(tar, stage / L"payload.tar");
    else
      fs::copy_file(tar, stage / L"payload.tar");
    WriteText(stage / L"payload.json", Json{{"size", size}, {"sha256", hash}}.dump());
    Require(!fs::exists(version), "version already installed");
    fs::rename(stage, version);
    return version;
  } catch (...) {
    std::error_code ec;
    fs::remove_all(updater::ExtendedPath(stage), ec);
    throw;
  }
}
}  // namespace remotekit::release
