#include "asset.hpp"
#include "codec.hpp"
#include "executor.hpp"
#include "options.hpp"
#include "payload.hpp"
#include "util/error_policy.hpp"
#include <iostream>
#include <thread>
#include <charconv>

namespace remotekit::release {
namespace {
constexpr char kUsage[] =
    "remotekit_release keygen --out=<file>\n"
    "remotekit_release inspect --key=<file> --manifest=<url-or-path>\n"
    "remotekit_release pack --key=<file> --payload=<tar> --build=<id> --url-prefix=<url/> "
    "--out=<dir> "
    "[--base=<tar> --base-build=<id> --base-manifest=<url>] [--full] [--level=<n>] "
    "[--patch-level=<n>]\n"
    "remotekit_release fetch --key=<file> --manifest=<url> --out=<tar> [--base=<tar> "
    "--base-build=<id>]\n";
int Level(const Options& options, const wchar_t* name) {
  if (!options.Has(name))
    return 19;
  auto value = options.Text(name);
  int level = 0;
  auto [end, ec] = std::from_chars(value.data(), value.data() + value.size(), level);
  Require(
      ec == std::errc() && end == value.data() + value.size() && level >= -131072 && level <= 22,
      "invalid zstd level");
  return level;
}
std::string Now() {
  SYSTEMTIME time{};
  GetSystemTime(&time);
  char value[32];
  snprintf(value, sizeof(value), "%04u-%02u-%02uT%02u:%02u:%02uZ", time.wYear, time.wMonth,
           time.wDay, time.wHour, time.wMinute, time.wSecond);
  return value;
}
Asset PackAsset(const fs::path& source,
                const fs::path& directory,
                const std::string& name,
                const std::string& prefix,
                const Key& key,
                Json& upload) {
  Asset asset{cluster::Hex(RandomKey()), fs::file_size(source), {}};
  uint64_t left = asset.size;
  for (size_t i = 0; left; ++i) {
    char suffix[32];
    snprintf(suffix, sizeof(suffix), ".%03zu", i);
    auto filename = name + suffix;
    uint64_t n = std::min(left, kChunkSize);
    asset.slices.push_back({prefix + filename, n + 16});
    left -= n;
  }
  std::ifstream file(source, std::ios::binary);
  for (uint32_t i = 0; i < asset.slices.size(); ++i) {
    Bytes bytes(static_cast<size_t>(asset.slices[i].size - 16));
    Io(static_cast<bool>(file.read(reinterpret_cast<char*>(bytes.data()), bytes.size())),
       "cannot read compressed release");
    auto filename = asset.slices[i].url.substr(prefix.size());
    Write(directory / filename, EncryptSlice(key, asset, i, bytes));
    upload.push_back({{"name", filename}, {"size", asset.slices[i].size}});
  }
  return asset;
}
void SelfCheck(const Asset& asset,
               const fs::path& directory,
               const std::string& prefix,
               const Key& key,
               const Payload& payload,
               const fs::path& base) {
  auto decoded = directory / L"self-check.tar";
  Decode(
      [&](const Consume& consume) {
        for (uint32_t i = 0; i < asset.slices.size(); ++i) {
          auto encrypted = Read(directory / asset.slices[i].url.substr(prefix.size()));
          auto plaintext = DecryptSlice(key, asset, i, encrypted);
          consume(plaintext);
        }
      },
      decoded, payload, base, !base.empty());
  Require(HashFile(decoded) == payload.sha256, "packed asset self-check SHA-256 mismatch");
  fs::remove(decoded);
}
void Pack(const Options& options) {
  auto key = LoadKey(options.Path(L"key"));
  auto payload = options.Path(L"payload");
  auto id = options.Text(L"build");
  Require(PayloadBuildId(payload) == id, "payload build.json does not match --build");
  auto prefix = options.Text(L"url-prefix");
  Require(ValidUrl(prefix) && prefix.ends_with('/') && prefix.find('?') == prefix.npos,
          "invalid release URL prefix");
  auto directory = options.Path(L"out");
  Require(!fs::exists(directory) || (fs::is_directory(directory) && fs::is_empty(directory)),
          "pack output directory must be empty or new");
  fs::create_directories(directory);
  bool has_base = options.Has(L"base");
  Require(has_base == options.Has(L"base-build") && has_base == options.Has(L"base-manifest"),
          "base, base-build and base-manifest are required together");
  Manifest manifest{id, Now(), {fs::file_size(payload), HashFile(payload)}, {}, {}};
  Json upload = Json::array();
  if (!has_base || options.Has(L"full")) {
    auto compressed = directory / L"full.zst";
    Compress(payload, compressed, {}, Level(options, L"level"),
             std::max(1u, std::thread::hardware_concurrency()));
    manifest.full = PackAsset(compressed, directory, "control-full", prefix, key, upload);
    SelfCheck(*manifest.full, directory, prefix, key, manifest.payload, {});
    fs::remove(compressed);
  }
  if (has_base) {
    auto base = options.Path(L"base");
    auto from = options.Text(L"base-build");
    auto previous_url = options.Text(L"base-manifest");
    Require(from != id && PayloadBuildId(base) == from && ValidUrl(previous_url),
            "invalid release base");
    auto compressed = directory / L"patch.zst";
    Compress(payload, compressed, base, Level(options, L"patch-level"), 0);
    manifest.patch = Patch{from, previous_url,
                           PackAsset(compressed, directory, "control-patch", prefix, key, upload)};
    SelfCheck(manifest.patch->asset, directory, prefix, key, manifest.payload, base);
    fs::remove(compressed);
  }
  Write(directory / L"control.manifest", EncryptManifest(manifest, key));
  upload.push_back(
      {{"name", "control.manifest"}, {"size", fs::file_size(directory / L"control.manifest")}});
  WriteText(directory / L"upload.json", upload.dump());
  std::cout << Json{{"buildId", id},
                    {"payload", manifest.payload.size},
                    {"full", manifest.full ? Json(manifest.full->size) : Json(nullptr)},
                    {"patch", manifest.patch ? Json(manifest.patch->asset.size) : Json(nullptr)}}
                   .dump()
            << '\n';
  SecureZeroMemory(key.data(), key.size());
}
void FetchCommand(const Options& options) {
  auto key = LoadKey(options.Path(L"key"));
  auto output = options.Path(L"out");
  fs::create_directories(output.parent_path());
  auto work = fs::path(output.wstring() + L".work");
  bool has_base = options.Has(L"base");
  Require(has_base == options.Has(L"base-build"), "base and base-build are required together");
  fs::path base;
  State state;
  if (has_base) {
    base = options.Path(L"base");
    state.current = options.Text(L"base-build");
    Require(PayloadBuildId(base) == state.current, "base build identity mismatch");
    state.base_usable = true;
  }
  Http http;
  unsigned attempt = 0;
  while (true) {
    try {
      auto result = Fetch(options.Text(L"manifest"), state, base, work, key, http);
      if (result.path != output)
        fs::copy_file(result.path, output, fs::copy_options::overwrite_existing);
      std::cout << Json{{"buildId", result.build_id},
                        {"size", fs::file_size(output)},
                        {"sha256", HashFile(output)}}
                       .dump()
                << '\n';
      break;
    } catch (const Failure& failure) {
      auto delay = RetryDelay(failure.error, attempt++);
      if (!delay)
        throw;
      std::this_thread::sleep_for(*delay);
    }
  }
  SecureZeroMemory(key.data(), key.size());
}
}  // namespace
int ToolMain(int argc, wchar_t** argv) {
  if (argc < 2 || std::wstring_view(argv[1]) == L"--help") {
    std::cout << kUsage;
    return argc < 2 ? 1 : 0;
  }
  std::wstring command = argv[1];
  if (command == L"keygen") {
    Options options(argc, argv, {L"out"});
    auto path = options.Path(L"out");
    fs::create_directories(path.parent_path());
    updater::Handle file(CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
                                     FILE_ATTRIBUTE_NORMAL, nullptr));
    Io(file.value != INVALID_HANDLE_VALUE, "cannot create key file (refusing overwrite)");
    auto key = RandomKey();
    auto text = EncodeKey(key);
    DWORD written = 0;
    Io(WriteFile(file.value, text.data(), static_cast<DWORD>(text.size()), &written, nullptr) &&
           written == text.size(),
       "cannot write key file");
    SecureZeroMemory(key.data(), key.size());
    SecureZeroMemory(text.data(), text.size());
  } else if (command == L"inspect") {
    Options options(argc, argv, {L"key", L"manifest"});
    auto key = LoadKey(options.Path(L"key"));
    auto address = options.Text(L"manifest");
    auto bytes =
        ValidUrl(address) ? Http().Get(address) : Read(options.Path(L"manifest"), 1024 * 1024);
    std::cout << ToJson(DecryptManifest(bytes, key)).dump() << '\n';
    SecureZeroMemory(key.data(), key.size());
  } else if (command == L"pack") {
    Pack(Options(argc, argv,
                 {L"key", L"payload", L"build", L"url-prefix", L"out", L"base", L"base-build",
                  L"base-manifest", L"level", L"patch-level"},
                 {L"full"}));
  } else if (command == L"fetch") {
    FetchCommand(Options(argc, argv, {L"key", L"manifest", L"out", L"base", L"base-build"}));
  } else {
    Fail(ErrorCode::kInvalidRequest, "unknown release command");
  }
  return 0;
}
}  // namespace remotekit::release
int wmain(int argc, wchar_t** argv) {
  try {
    return remotekit::release::ToolMain(argc, argv);
  } catch (const remotekit::release::Failure& failure) {
    std::cerr << failure.what() << '\n';
  } catch (const std::exception&) {
    std::cerr << "release file operation failed\n";
  }
  return 1;
}
