#pragma once

#include "util/error.hpp"

#include <chrono>
#include <filesystem>
#include <span>
#include <string>
#include <vector>

namespace remotekit::documents {
using Bytes = std::vector<uint8_t>;
using Environment = std::vector<std::pair<std::wstring, std::wstring>>;

std::filesystem::path DefaultToolsDirectory();
std::string Sha256Hex(std::span<const uint8_t> bytes);
std::wstring FileUrl(const std::filesystem::path& path);
Error ToolOutputFailure(const std::filesystem::path& log);
Result<void> RunTool(const std::filesystem::path& executable,
                     const std::vector<std::wstring>& arguments,
                     const std::filesystem::path& working_directory,
                     const Environment& environment = {},
                     std::chrono::milliseconds timeout = std::chrono::seconds(180));

class TemporaryDirectory {
 public:
  explicit TemporaryDirectory(const std::filesystem::path& parent);
  ~TemporaryDirectory();
  TemporaryDirectory(const TemporaryDirectory&) = delete;
  TemporaryDirectory& operator=(const TemporaryDirectory&) = delete;
  const std::filesystem::path& path() const { return path_; }

 private:
  std::filesystem::path path_;
};
}  // namespace remotekit::documents
