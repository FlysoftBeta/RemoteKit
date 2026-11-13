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
  std::map<DWORD, std::string> roots_, groups_;
  struct Process {
    HANDLE handle = nullptr;
    double previous_seconds = 0;
    std::string group;
  };
  std::map<DWORD, Process> processes_;
  double previous_ms_ = 0;
};
}  // namespace schedlab
