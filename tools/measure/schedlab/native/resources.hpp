#pragma once
#include <windows.h>
#include <pdh.h>
#include <json.hpp>
#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
#include <string>

namespace schedlab {
double EpochMs();
class Resources {
 public:
  explicit Resources(const std::filesystem::path& path);
  ~Resources();
  void AddRoot(std::string group, DWORD pid);
  nlohmann::json Sample();

 private:
  std::ofstream out_;
  PDH_HQUERY query_ = nullptr;
  PDH_HCOUNTER counter_ = nullptr;
  std::mutex mutex_;
  struct Root {
    std::string group;
    uint64_t created = 0;
  };
  std::map<DWORD, Root> roots_;
  std::map<DWORD, std::string> groups_;
  struct Process {
    HANDLE handle = nullptr;
    uint64_t created = 0;
    double previous_seconds = 0;
    std::string group;
  };
  std::map<DWORD, Process> processes_;
  double previous_ms_ = 0;
};
}  // namespace schedlab
