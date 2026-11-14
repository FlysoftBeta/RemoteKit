#include "diagnostics/node_metrics.hpp"
#include "util/thread.hpp"
#include <dxgi1_2.h>
#include <pdhmsg.h>
#include <wrl/client.h>
#include <algorithm>
#include <iomanip>
#include <sstream>
#include <cmath>
#include <vector>

namespace remotekit {
namespace {
using Microsoft::WRL::ComPtr;
uint64_t Ticks(FILETIME value) {
  return (uint64_t(value.dwHighDateTime) << 32) | value.dwLowDateTime;
}
std::string Luid(LUID value) {
  std::ostringstream text;
  text << "luid_0x" << std::hex << std::setfill('0') << std::setw(8)
       << static_cast<uint32_t>(value.HighPart) << "_0x" << std::setw(8) << value.LowPart;
  return text.str();
}
void Counters(PDH_HCOUNTER counter, const std::function<void(std::string, double)>& consume) {
  if (!counter)
    return;
  DWORD bytes = 0, count = 0;
  if (PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &bytes, &count, nullptr) !=
      PDH_MORE_DATA)
    return;
  std::vector<uint8_t> buffer(bytes);
  auto* values = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(buffer.data());
  if (PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &bytes, &count, values) !=
      ERROR_SUCCESS)
    return;
  for (DWORD i = 0; i < count; ++i)
    if ((values[i].FmtValue.CStatus == PDH_CSTATUS_VALID_DATA ||
         values[i].FmtValue.CStatus == PDH_CSTATUS_NEW_DATA) &&
        std::isfinite(values[i].FmtValue.doubleValue))
      consume(Utf8(fs::path(values[i].szName)), std::max(0.0, values[i].FmtValue.doubleValue));
}
}  // namespace
NodeMetrics::NodeMetrics(fs::path data) : data_(std::move(data)) {
  if (PdhOpenQueryW(nullptr, 0, &query_) == ERROR_SUCCESS) {
    PdhAddEnglishCounterW(query_, L"\\GPU Engine(*)\\Utilization Percentage", 0, &engines_);
    PdhAddEnglishCounterW(query_, L"\\GPU Adapter Memory(*)\\Dedicated Usage", 0, &memory_);
    PdhCollectQueryData(query_);
  }
  FILETIME idle{}, kernel{}, user{};
  GetSystemTimes(&idle, &kernel, &user);
  idle_ = Ticks(idle);
  kernel_ = Ticks(kernel);
  user_ = Ticks(user);
}
NodeMetrics::~NodeMetrics() {
  Stop();
  if (query_)
    PdhCloseQuery(query_);
}
Json NodeMetrics::Sample(size_t sessions) {
  FILETIME idle{}, kernel{}, user{};
  GetSystemTimes(&idle, &kernel, &user);
  const auto total = Ticks(kernel) - kernel_ + Ticks(user) - user_;
  const auto idle_delta = Ticks(idle) - idle_;
  const double cpu = total ? std::clamp(1.0 - double(idle_delta) / double(total), 0.0, 1.0) : 0;
  idle_ = Ticks(idle);
  kernel_ = Ticks(kernel);
  user_ = Ticks(user);
  MEMORYSTATUSEX memory{sizeof(memory)};
  GlobalMemoryStatusEx(&memory);
  ULARGE_INTEGER available{}, disk_total{}, disk_free{};
  GetDiskFreeSpaceExW(data_.c_str(), &available, &disk_total, &disk_free);
  Json gpus = Json::array();
  ComPtr<IDXGIFactory1> factory;
  if (SUCCEEDED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) {
    ComPtr<IDXGIAdapter1> adapter;
    for (UINT index = 0; factory->EnumAdapters1(index, &adapter) != DXGI_ERROR_NOT_FOUND;
         ++index, adapter.Reset()) {
      DXGI_ADAPTER_DESC1 desc{};
      if (FAILED(adapter->GetDesc1(&desc)) || (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE))
        continue;
      gpus.push_back({{"luid", Luid(desc.AdapterLuid)},
                      {"name", Utf8(fs::path(desc.Description))},
                      {"engine3d", 0.0},
                      {"engineVideoEncode", 0.0},
                      {"dedicatedUsed", 0.0},
                      {"dedicatedTotal", desc.DedicatedVideoMemory}});
    }
  }
  if (query_ && PdhCollectQueryData(query_) == ERROR_SUCCESS) {
    Counters(engines_, [&](const std::string& name, double value) {
      for (auto& gpu : gpus) {
        if (name.find(gpu["luid"].get<std::string>()) == std::string::npos)
          continue;
        const char* field = name.find("engtype_3D") != std::string::npos ? "engine3d"
                            : name.find("engtype_VideoEncode") != std::string::npos
                                ? "engineVideoEncode"
                                : nullptr;
        if (field)
          gpu[field] = std::min(1.0, gpu[field].get<double>() + value / 100.0);
      }
    });
    Counters(memory_, [&](const std::string& name, double value) {
      for (auto& gpu : gpus)
        if (name.find(gpu["luid"].get<std::string>()) != std::string::npos)
          gpu["dedicatedUsed"] = gpu["dedicatedUsed"].get<double>() + value;
    });
  }
  uint64_t object_bytes = 0;
  std::error_code error;
  for (auto entry = fs::recursive_directory_iterator(data_ / "objects", error);
       !error && entry != fs::recursive_directory_iterator(); entry.increment(error)) {
    if (entry->is_regular_file(error) && entry->path().extension() == ".rko") {
      const auto size = entry->file_size(error);
      if (!error)
        object_bytes += size;
      error.clear();
    }
  }
  return {{"cpu", cpu},
          {"memory", {{"total", memory.ullTotalPhys}, {"available", memory.ullAvailPhys}}},
          {"gpus", gpus},
          {"disk", {{"total", disk_total.QuadPart}, {"free", available.QuadPart}}},
          {"sessions", sessions},
          {"objectBytes", object_bytes}};
}
RetryUnit::Snapshot NodeMetrics::RetryStatus() const {
  std::lock_guard lock(retry_mutex_);
  return retry_;
}
void NodeMetrics::Publish(const std::string& input,
                          const std::function<Json()>& sample,
                          const std::function<Result<void>(Json)>& publish) {
  std::lock_guard lock(retry_mutex_);
  retry_.Input(input);
  if (!retry_.Ready())
    return;
  try {
    auto result = publish(sample());
    if (result)
      retry_.Success();
    else
      retry_.Fail(result.error());
  } catch (const std::filesystem::filesystem_error& error) {
    retry_.Fail(WithOsError(ErrorCode::kUnavailable, error.what(), OsError::Kind::kWin32,
                            error.code().value()));
  } catch (const std::exception& error) {
    retry_.Fail({ErrorCode::kInternal, error.what()});
  }
}
void NodeMetrics::Start(std::function<size_t()> sessions,
                        std::function<Result<void>(Json)> publish,
                        std::function<std::string()> input) {
  worker_ = std::thread([this, sessions = std::move(sessions), publish = std::move(publish),
                         input = std::move(input)] {
    RunThread(
        "node metrics",
        [&] {
          std::unique_lock lock(mutex_);
          while (!stop_) {
            lock.unlock();
            Publish(input(), [&] { return Sample(sessions()); }, publish);
            lock.lock();
            wake_.wait_for(lock, std::chrono::seconds(5), [this] { return stop_; });
          }
        },
        [] {});
  });
}
void NodeMetrics::Stop() {
  {
    std::lock_guard lock(mutex_);
    stop_ = true;
  }
  wake_.notify_all();
  if (worker_.joinable())
    worker_.join();
}
}  // namespace remotekit
