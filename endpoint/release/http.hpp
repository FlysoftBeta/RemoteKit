#pragma once
#include "common.hpp"
#include "util/log.hpp"
namespace remotekit::release {
bool ValidUrl(const std::string& url);
class Http {
 public:
  explicit Http(std::string proxy = {}, HANDLE stop = nullptr);
  Bytes Get(const std::string& url, uint64_t limit = 1024 * 1024) const;
  void Download(const std::string& url, const fs::path& partial, uint64_t expected) const;
  void LogFailure(const Error& error) const;

 private:
  std::string proxy_;
  HANDLE stop_;
  void Request(const std::string& url,
               uint64_t offset,
               const std::function<void(bool)>& begin,
               const std::function<void(std::span<const uint8_t>)>& consume) const;
};
}  // namespace remotekit::release
