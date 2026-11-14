#include "request.hpp"
#include "workers.hpp"
#include "util/wire_error.hpp"
#include "persistence/config_formats.hpp"
#include "persistence/snapshot_leases.hpp"
#include <vss.h>
#include <vswriter.h>
#include <vsbackup.h>
#include <sddl.h>
#include <chrono>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <thread>

namespace remotekit::snapshot {
using Clock = std::chrono::steady_clock;
struct Failure {
  HRESULT hr;
  bool invalid = false;
};
void Check(HRESULT hr) {
  if (FAILED(hr))
    throw Failure{hr};
}
void Require(bool valid) {
  if (!valid)
    throw Failure{E_INVALIDARG, true};
}
fs::path Path(const std::string& text) {
  return fs::path(std::u8string(text.begin(), text.end()));
}
std::string Text(const fs::path& path) {
  auto text = path.generic_u8string();
  return {text.begin(), text.end()};
}
std::string Id(GUID id) {
  wchar_t text[40]{};
  StringFromGUID2(id, text, 40);
  return Text(text);
}
int64_t Milliseconds() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}
void Wait(IVssAsync* operation) {
  HRESULT status = E_FAIL;
  auto result = operation->Wait();
  if (SUCCEEDED(result))
    result = operation->QueryStatus(&status, nullptr);
  operation->Release();
  Check(result);
  Check(status);
}
struct Shadow {
  IVssBackupComponents* backup = nullptr;
  VSS_ID id = GUID_NULL;
  fs::path device;
  Clock::time_point created;
  int64_t taken_at = 0;
  ~Shadow() {
    if (backup) {
      LONG deleted = 0;
      VSS_ID failed{};
      backup->DeleteSnapshots(id, VSS_OBJECT_SNAPSHOT, TRUE, &deleted, &failed);
      backup->Release();
    }
  }
};
class Service {
 public:
  explicit Service(fs::path root) : root_(fs::absolute(root).lexically_normal()) {
    fs::create_directories(root_);
    root_lock_ = CreateFileW((root_ / L"snapshot.lock").c_str(), GENERIC_READ | GENERIC_WRITE, 0,
                             nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    Check(root_lock_ == INVALID_HANDLE_VALUE ? HRESULT_FROM_WIN32(GetLastError()) : S_OK);
    CheckPath(root_, false);
    wchar_t volume[MAX_PATH]{};
    Check(GetVolumePathNameW(root_.c_str(), volume, MAX_PATH) ? S_OK
                                                              : HRESULT_FROM_WIN32(GetLastError()));
    volume_ = volume;
    journal_ = root_ / L"snapshot-owner.json";
    Cleanup();
  }
  ~Service() { CloseHandle(root_lock_); }
  void Disconnect(uint64_t owner) {
    std::lock_guard lock(mutex_);
    leases_.Disconnect(owner);
  }
  void Expire() {
    std::lock_guard lock(mutex_);
    leases_.Expire(Clock::now());
  }
  void Request(HANDLE pipe, uint64_t owner, const Json& request) {
    std::unique_lock lock(mutex_);
    try {
      const auto method = request.at("method").get<std::string>();
      if (method == "snapshot.take") {
        Require(Path(request.at("root").get<std::string>()).lexically_normal() == root_);
        const auto paths = request.at("paths").get<std::vector<std::string>>();
        Require(!paths.empty());
        for (const auto& path : paths) {
          Require(SafePath(Path(path)));
          CheckPath(root_ / Path(path), true);
        }
        auto shadow = current_.lock();
        if (shadow && !CanMerge(shadow->created, Clock::now()))
          throw Failure{VSS_E_SNAPSHOT_SET_IN_PROGRESS};
        if (!shadow) {
          shadow = Take();
          current_ = shadow;
        }
        GUID token{};
        Check(CoCreateGuid(&token));
        const auto id = Id(token);
        Lease<Shadow> lease{shadow, {}, owner, {}};
        Json files = Json::array();
        for (const auto& name : paths) {
          auto path = Map(*shadow, name);
          CheckPath(path, true);
          if (fs::is_directory(path)) {
            AddFile(lease, files, name, path);
            for (const auto& entry : fs::recursive_directory_iterator(path)) {
              const auto relative = Text(Path(name) / entry.path().lexically_relative(path));
              CheckPath(entry.path(), false);
              AddFile(lease, files, relative, entry.path());
            }
          } else {
            AddFile(lease, files, name, path);
          }
        }
        PublishLease(leases_, id, std::move(lease));
        lock.unlock();
        SendJson(pipe, {{"ok", true},
                        {"result",
                         {{"snapshotId", id}, {"takenAt", shadow->taken_at}, {"files", files}}}});
        return;
      }
      const auto id = request.at("snapshotId").get<std::string>();
      auto found = leases_.find(id);
      Require(found != leases_.end() && found->second.owner == owner);
      auto& lease = found->second;
      lease.renewed = Clock::now();
      if (method == "snapshot.release") {
        leases_.erase(found);
        lock.unlock();
        SendJson(pipe, {{"ok", true}, {"result", Json::object()}});
        return;
      }
      Require(method == "snapshot.read");
      const auto name = request.at("path").get<std::string>();
      Require(lease.paths.contains(name));
      Require(request.at("offset").is_number_unsigned() &&
              request.at("length").is_number_unsigned());
      const auto offset = request.at("offset").get<uint64_t>();
      const auto length = ReadLength(request.at("length"));
      auto path = Map(*lease.shadow, name);
      HANDLE file = CreateFileW(path.c_str(), GENERIC_READ,
                                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                                OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
      Check(file == INVALID_HANDLE_VALUE ? HRESULT_FROM_WIN32(GetLastError()) : S_OK);
      LARGE_INTEGER position{};
      position.QuadPart = static_cast<LONGLONG>(offset);
      std::vector<uint8_t> bytes(length);
      DWORD read = 0;
      const bool ok = SetFilePointerEx(file, position, nullptr, FILE_BEGIN) &&
                      ReadFile(file, bytes.data(), length, &read, nullptr);
      const auto error = GetLastError();
      CloseHandle(file);
      Check(ok ? S_OK : HRESULT_FROM_WIN32(error));
      bytes.resize(read);
      lock.unlock();
      if (SendJson(pipe, {{"ok", true}, {"result", {{"length", read}}}}))
        Send(pipe, bytes);
    } catch (const Failure& error) {
      if (lock.owns_lock())
        lock.unlock();
      ErrorReply(pipe, error);
    } catch (const release::Failure& failure) {
      if (lock.owns_lock())
        lock.unlock();
      SendJson(pipe, {{"ok", false}, {"error", WireError(failure.error)}});
    } catch (const Json::exception&) {
      if (lock.owns_lock())
        lock.unlock();
      ErrorReply(pipe, {E_INVALIDARG, true});
    } catch (const fs::filesystem_error& error) {
      if (lock.owns_lock())
        lock.unlock();
      ErrorReply(pipe, {HRESULT_FROM_WIN32(error.code().value())});
    }
  }

 private:
  void ErrorReply(HANDLE pipe, Failure error) {
    SendJson(
        pipe,
        {{"ok", false},
         {"error",
          {{"code", error.invalid ? "invalid_request" : "unavailable"},
           {"message", error.invalid ? "invalid snapshot path or request" : "snapshot unavailable"},
           {"os", {{"kind", "hresult"}, {"value", int64_t(error.hr)}}}}}});
  }
  void CheckPath(const fs::path& path, bool missing) {
    fs::path current;
    auto relative = path;
    const auto native = path.wstring();
    const std::wstring prefix = L"\\\\?\\GLOBALROOT\\Device\\";
    if (native.starts_with(prefix)) {
      const auto slash = native.find(L'\\', prefix.size());
      Require(slash != std::wstring::npos);
      current = native.substr(0, slash + 1);
      relative = native.substr(slash + 1);
    }
    for (const auto& part : relative) {
      current /= part;
      const auto attributes = GetFileAttributesW(current.c_str());
      if (attributes == INVALID_FILE_ATTRIBUTES) {
        const auto error = GetLastError();
        if (missing && (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND))
          return;
        Check(HRESULT_FROM_WIN32(error));
      }
      Require(!(attributes & FILE_ATTRIBUTE_REPARSE_POINT));
    }
  }
  fs::path Map(const Shadow& shadow, const std::string& name) {
    return shadow.device / (root_ / Path(name)).lexically_relative(volume_);
  }
  void AddFile(Lease<Shadow>& lease, Json& files, const std::string& name, const fs::path& path) {
    if (!lease.paths.insert(name).second)
      return;
    HANDLE file = CreateFileW(
        path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
      auto error = GetLastError();
      if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) {
        files.push_back({{"path", name}, {"missing", true}});
        return;
      }
      Check(HRESULT_FROM_WIN32(error));
    }
    BY_HANDLE_FILE_INFORMATION info{};
    const bool ok = GetFileInformationByHandle(file, &info);
    CloseHandle(file);
    Check(ok ? S_OK : HRESULT_FROM_WIN32(GetLastError()));
    Require(!(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT));
    if (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
      files.push_back({{"path", name}, {"directory", true}});
      return;
    }
    files.push_back({{"path", name},
                     {"size", (uint64_t(info.nFileSizeHigh) << 32) | info.nFileSizeLow},
                     {"mtime", (uint64_t(info.ftLastWriteTime.dwHighDateTime) << 32) |
                                   info.ftLastWriteTime.dwLowDateTime},
                     {"fileId", std::to_string(info.dwVolumeSerialNumber) + ":" +
                                    std::to_string((uint64_t(info.nFileIndexHigh) << 32) |
                                                   info.nFileIndexLow)}});
  }
  void Cleanup() {
    std::ifstream input(journal_);
    if (!input)
      return;
    const std::string bytes((std::istreambuf_iterator<char>(input)), {});
    input.close();
    auto decoded = config_formats::Decode(bytes, config_formats::Owner, persisted::Store::kOwner);
    if (!decoded) {
      ReportError(decoded.error(), "snapshot.owner_corrupt");
      throw Failure{E_FAIL};
    }
    const auto record = std::move(decoded).value();
    GUID id{};
    Check(CLSIDFromString(Path(record.at("snapshotId").get<std::string>()).c_str(), &id));
    IVssBackupComponents* backup = nullptr;
    Check(CreateVssBackupComponents(&backup));
    HRESULT hr = backup->InitializeForBackup();
    if (SUCCEEDED(hr))
      hr = backup->SetContext(VSS_CTX_ALL);
    if (SUCCEEDED(hr)) {
      LONG deleted = 0;
      VSS_ID failed{};
      hr = backup->DeleteSnapshots(id, VSS_OBJECT_SNAPSHOT, TRUE, &deleted, &failed);
    }
    backup->Release();
    if (hr != VSS_E_OBJECT_NOT_FOUND)
      Check(hr);
    fs::remove(journal_);
  }
  void SaveOwner(GUID id) {
    auto encoded =
        config_formats::Encode({{"version", 1}, {"snapshotId", Id(id)}}, config_formats::Owner);
    if (!encoded) {
      ReportError(encoded.error(), "snapshot.owner_corrupt");
      throw Failure{E_FAIL};
    }
    release::AtomicText(journal_, std::move(encoded).value());
  }
  std::shared_ptr<Shadow> Take() {
    Cleanup();
    wchar_t filesystem[MAX_PATH]{};
    Check(GetVolumeInformationW(volume_.c_str(), nullptr, 0, nullptr, nullptr, nullptr, filesystem,
                                MAX_PATH)
              ? S_OK
              : HRESULT_FROM_WIN32(GetLastError()));
    Check(_wcsicmp(filesystem, L"NTFS") == 0 ? S_OK : VSS_E_VOLUME_NOT_SUPPORTED);
    auto shadow = std::make_shared<Shadow>();
    Check(CreateVssBackupComponents(&shadow->backup));
    Check(shadow->backup->InitializeForBackup());
    Check(shadow->backup->SetContext(VSS_CTX_FILE_SHARE_BACKUP));
    Check(shadow->backup->SetBackupState(FALSE, FALSE, VSS_BT_COPY, FALSE));
    VSS_ID set{};
    Check(shadow->backup->StartSnapshotSet(&set));
    auto volume = volume_.wstring();
    Check(shadow->backup->AddToSnapshotSet(volume.data(), GUID_NULL, &shadow->id));
    SaveOwner(shadow->id);
    IVssAsync* operation = nullptr;
    Check(shadow->backup->DoSnapshotSet(&operation));
    Wait(operation);
    VSS_SNAPSHOT_PROP properties{};
    Check(shadow->backup->GetSnapshotProperties(shadow->id, &properties));
    shadow->device = fs::path(std::wstring(properties.m_pwszSnapshotDeviceObject) + L"\\");
    shadow->taken_at = (properties.m_tsCreationTimestamp / 10000) - 11644473600000LL;
    VssFreeSnapshotProperties(&properties);
    shadow->created = Clock::now();
    std::cout << Json{{"event", "snapshot.taken"}, {"takenAt", shadow->taken_at}}.dump()
              << std::endl;
    return shadow;
  }
  HANDLE root_lock_ = INVALID_HANDLE_VALUE;
  fs::path root_, volume_, journal_;
  std::mutex mutex_;
  Leases<Shadow> leases_;
  std::weak_ptr<Shadow> current_;
};
std::wstring AccountSid(DWORD process_id) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, process_id);
  Check(process ? S_OK : HRESULT_FROM_WIN32(GetLastError()));
  HANDLE token = nullptr;
  const bool opened = OpenProcessToken(process, TOKEN_QUERY, &token);
  CloseHandle(process);
  Check(opened ? S_OK : HRESULT_FROM_WIN32(GetLastError()));
  DWORD size = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &size);
  std::vector<uint8_t> storage(size);
  const bool ok = GetTokenInformation(token, TokenUser, storage.data(), size, &size);
  CloseHandle(token);
  Check(ok ? S_OK : HRESULT_FROM_WIN32(GetLastError()));
  LPWSTR sid = nullptr;
  Check(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(storage.data())->User.Sid, &sid)
            ? S_OK
            : HRESULT_FROM_WIN32(GetLastError()));
  std::wstring result(sid);
  LocalFree(sid);
  return result;
}
int Run(int argc, wchar_t** argv) {
  fs::path root;
  std::string node;
  DWORD supervisor = 0;
  for (int i = 1; i < argc; ++i) {
    std::wstring arg(argv[i]);
    if (arg.starts_with(L"--data-root="))
      root = arg.substr(12);
    else if (arg.starts_with(L"--node-id="))
      node = Text(arg.substr(10));
    else if (arg.starts_with(L"--supervisor-pid="))
      supervisor = std::stoul(arg.substr(17));
    else
      Require(false);
  }
  Require(
      root.is_absolute() && !node.empty() &&
      node.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_") ==
          std::string::npos &&
      supervisor != 0);
  Check(CoInitializeEx(nullptr, COINIT_MULTITHREADED));
  Check(CoInitializeSecurity(nullptr, -1, nullptr, nullptr, RPC_C_AUTHN_LEVEL_PKT_PRIVACY,
                             RPC_C_IMP_LEVEL_IDENTIFY, nullptr, EOAC_NONE, nullptr));
  Service service(root);
  auto sddl = L"D:P(A;;GA;;;SY)(A;;GA;;;" + AccountSid(supervisor) + L")";
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1,
                                                             &descriptor, nullptr)
            ? S_OK
            : HRESULT_FROM_WIN32(GetLastError()));
  SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), descriptor, FALSE};
  Workers workers([&service](std::stop_token stop) {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    while (!stop.stop_requested()) {
      Sleep(100);
      service.Expire();
    }
    CoUninitialize();
  });
  uint64_t owner = 0;
  for (;;) {
    updater::Handle listener(CreateNamedPipeW(
        PipeName(node).c_str(), PIPE_ACCESS_DUPLEX,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        PIPE_UNLIMITED_INSTANCES, kMaxRead + 4096, kMaxRead + 4096, 0, &security));
    HANDLE pipe = listener.value;
    Check(pipe == INVALID_HANDLE_VALUE ? HRESULT_FROM_WIN32(GetLastError()) : S_OK);
    if (!ConnectNamedPipe(pipe, nullptr) && GetLastError() != ERROR_PIPE_CONNECTED) {
      continue;
    }
    workers.Connect(std::move(listener), [&service, connection = ++owner](std::stop_token stop,
                                                                          HANDLE pipe) {
      CoInitializeEx(nullptr, COINIT_MULTITHREADED);
      std::vector<uint8_t> bytes;
      while (!stop.stop_requested() && Receive(pipe, bytes)) {
        try {
          const auto request =
              DecodeRequest({reinterpret_cast<const char*>(bytes.data()), bytes.size()});
          service.Request(pipe, connection, request);
        } catch (const release::Failure&) {
          SendJson(
              pipe,
              {{"ok", false},
               {"error", {{"code", "invalid_request"}, {"message", "invalid snapshot request"}}}});
        }
      }
      service.Disconnect(connection);
      DisconnectNamedPipe(pipe);
      CoUninitialize();
    });
  }
}
}  // namespace remotekit::snapshot
int wmain(int argc, wchar_t** argv) {
  try {
    return remotekit::snapshot::Run(argc, argv);
  } catch (const remotekit::snapshot::Failure& failure) {
    std::cout << remotekit::Json{{"event", "snapshot.unavailable"},
                                 {"os", {{"kind", "hresult"}, {"value", int64_t(failure.hr)}}}}
                     .dump()
              << std::endl;
  } catch (const std::exception& error) {
    std::cout << remotekit::Json{{"event", "snapshot.failed"}, {"message", error.what()}}.dump()
              << std::endl;
  }
  return 1;
}
