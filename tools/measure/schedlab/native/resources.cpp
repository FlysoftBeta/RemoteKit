#include "resources.hpp"
#include <tlhelp32.h>
#include <winternl.h>
#include <pdhmsg.h>
#include <psapi.h>
#include <regex>
#include <stdexcept>
#include <vector>

namespace schedlab {
namespace {
void CheckPdh(PDH_STATUS status, const char* operation) {
  if (status != ERROR_SUCCESS)
    throw std::runtime_error(std::string(operation) + " PDH status " + std::to_string(status));
}
uint64_t CreationTime(HANDLE process) {
  FILETIME created{}, exited{}, kernel{}, user{};
  if (!GetProcessTimes(process, &created, &exited, &kernel, &user))
    return 0;
  return (uint64_t(created.dwHighDateTime) << 32) | created.dwLowDateTime;
}
double CpuSeconds(HANDLE process) {
  FILETIME created{}, exited{}, kernel{}, user{};
  if (!GetProcessTimes(process, &created, &exited, &kernel, &user))
    return 0;
  auto ticks = [](FILETIME value) {
    return (uint64_t(value.dwHighDateTime) << 32) | value.dwLowDateTime;
  };
  return double(ticks(kernel) + ticks(user)) / 10000000;
}
std::wstring CommandLine(HANDLE process) {
  using Query = NTSTATUS(NTAPI*)(HANDLE, PROCESSINFOCLASS, PVOID, ULONG, PULONG);
  static auto query = reinterpret_cast<Query>(
      GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess"));
  ULONG bytes = 0;
  query(process, static_cast<PROCESSINFOCLASS>(60), nullptr, 0, &bytes);
  if (!bytes)
    return {};
  std::vector<char> buffer(bytes);
  if (query(process, static_cast<PROCESSINFOCLASS>(60), buffer.data(), bytes, &bytes) < 0)
    return {};
  auto* text = reinterpret_cast<UNICODE_STRING*>(buffer.data());
  return std::wstring(text->Buffer, text->Length / sizeof(wchar_t));
}
}  // namespace
double EpochMs() {
  FILETIME value{};
  GetSystemTimePreciseAsFileTime(&value);
  const uint64_t ticks = (uint64_t(value.dwHighDateTime) << 32) | value.dwLowDateTime;
  return double(ticks - 116444736000000000ULL) / 10000;
}
Resources::Resources(const std::filesystem::path& path) : out_(path) {
  CheckPdh(PdhOpenQueryW(nullptr, 0, &query_), "open");
  CheckPdh(PdhAddEnglishCounterW(query_, L"\\GPU Engine(*)\\Utilization Percentage", 0, &counter_),
           "add GPU counter");
  CheckPdh(PdhCollectQueryData(query_), "initial collect");
  previous_ms_ = EpochMs();
}
Resources::~Resources() {
  for (auto& [pid, process] : processes_)
    CloseHandle(process.handle);
  PdhCloseQuery(query_);
}
void Resources::AddRoot(std::string group, DWORD pid) {
  std::lock_guard lock(mutex_);
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process)
    throw std::runtime_error("Cannot open resource root");
  const auto created = CreationTime(process);
  CloseHandle(process);
  if (!created)
    throw std::runtime_error("Cannot identify resource root");
  roots_[pid] = {std::move(group), created};
}
nlohmann::json Resources::Sample() {
  const double now = EpochMs();
  std::map<DWORD, DWORD> parents;
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  PROCESSENTRY32W entry{sizeof(entry)};
  if (snapshot != INVALID_HANDLE_VALUE) {
    if (Process32FirstW(snapshot, &entry)) {
      do {
        parents[entry.th32ProcessID] = entry.th32ParentProcessID;
      } while (Process32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);
  }
  std::map<DWORD, Root> roots;
  {
    std::lock_guard lock(mutex_);
    for (auto it = roots_.begin(); it != roots_.end();) {
      HANDLE process =
          OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, it->first);
      const bool same = process && CreationTime(process) == it->second.created &&
                        WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
      if (process)
        CloseHandle(process);
      if (!same)
        it = roots_.erase(it);
      else
        ++it;
    }
    roots = roots_;
  }
  for (auto it = processes_.begin(); it != processes_.end();) {
    if (WaitForSingleObject(it->second.handle, 0) != WAIT_TIMEOUT) {
      groups_.erase(it->first);
      CloseHandle(it->second.handle);
      it = processes_.erase(it);
    } else {
      ++it;
    }
  }
  for (auto& [pid, parent] : parents) {
    DWORD ancestor = pid;
    for (int depth = 0; depth < 20; ++depth) {
      if (roots.contains(ancestor)) {
        const std::string group = roots.at(ancestor).group;
        if (!processes_.contains(pid)) {
          HANDLE handle =
              OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | SYNCHRONIZE, FALSE, pid);
          if (handle && WaitForSingleObject(handle, 0) == WAIT_TIMEOUT) {
            const auto created = CreationTime(handle);
            if (created < roots.at(ancestor).created) {
              CloseHandle(handle);
              break;
            }
            groups_[pid] = group;
            const bool gpu = CommandLine(handle).find(L"--type=gpu-process") != std::wstring::npos;
            processes_[pid] = {handle, created, CpuSeconds(handle), gpu ? group + "/gpu" : group};
          } else if (handle) {
            CloseHandle(handle);
          }
        }
        break;
      }
      auto found = parents.find(ancestor);
      if (found == parents.end() || ancestor == found->second)
        break;
      ancestor = found->second;
    }
  }
  nlohmann::json cpu = nlohmann::json::array();
  for (auto& [pid, process] : processes_) {
    const double seconds = CpuSeconds(process.handle);
    PROCESS_MEMORY_COUNTERS_EX memory{};
    memory.cb = sizeof(memory);
    GetProcessMemoryInfo(process.handle, reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&memory),
                         sizeof(memory));
    cpu.push_back({{"pid", pid},
                   {"createdFileTime", process.created},
                   {"privateBytes", memory.PrivateUsage},
                   {"workingSetBytes", memory.WorkingSetSize},
                   {"group", process.group},
                   {"totalSeconds", seconds},
                   {"seconds", seconds - process.previous_seconds},
                   {"cores", (seconds - process.previous_seconds) * 1000 / (now - previous_ms_)}});
    process.previous_seconds = seconds;
  }
  CheckPdh(PdhCollectQueryData(query_), "collect");
  DWORD bytes = 0, count = 0;
  const auto size_status = PdhGetFormattedCounterArrayW(counter_, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100,
                                                        &bytes, &count, nullptr);
  nlohmann::json gpu = nlohmann::json::array();
  bool gpu_valid = size_status == ERROR_SUCCESS;
  if (size_status == PDH_MORE_DATA && bytes) {
    std::vector<char> buffer;
    auto status = size_status;
    while (status == PDH_MORE_DATA) {
      buffer.resize(bytes);
      status = PdhGetFormattedCounterArrayW(
          counter_, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, &bytes, &count,
          reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(buffer.data()));
    }
    if (status != PDH_CSTATUS_INVALID_DATA)
      CheckPdh(status, "GPU array");
    gpu_valid = status == ERROR_SUCCESS;
    auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(buffer.data());
    const std::wregex identity(L"pid_(\\d+)_.*engtype_(.+)");
    for (DWORD i = 0; gpu_valid && i < count; ++i) {
      if (items[i].FmtValue.CStatus > 1)
        continue;
      std::wstring name(items[i].szName);
      std::wsmatch match;
      if (!std::regex_search(name, match, identity))
        continue;
      const DWORD pid = std::stoul(match[1]);
      const std::wstring engine = match[2];
      gpu.push_back({{"pid", pid},
                     {"engine", std::string(engine.begin(), engine.end())},
                     {"group", groups_.contains(pid) ? groups_.at(pid) : "external"},
                     {"percent", items[i].FmtValue.doubleValue},
                     {"instance", std::string(name.begin(), name.end())}});
    }
  } else if (size_status != PDH_CSTATUS_INVALID_DATA && size_status != ERROR_SUCCESS) {
    CheckPdh(size_status, "GPU array size");
  }
  nlohmann::json result{
      {"type", "resources"},   {"epochMs", now}, {"intervalMs", now - previous_ms_},
      {"gpuValid", gpu_valid}, {"cpu", cpu},     {"gpu", gpu}};
  out_ << result.dump() << '\n';
  out_.flush();
  previous_ms_ = now;
  return result;
}
}  // namespace schedlab
