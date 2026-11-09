#pragma once
#include "updater/platform.hpp"
#include <fstream>
#include <algorithm>
#include <set>

namespace remotekit::release {
namespace fs = std::filesystem;
using cluster::Bytes;
using cluster::Json;
using cluster::Key;
struct Failure : std::exception {
  Error error;
  explicit Failure(Error value) : error(std::move(value)) {}
  const char* what() const noexcept override { return error.message.c_str(); }
};
inline void Fail(ErrorCode code, std::string message) {
  throw Failure({code, std::move(message)});
}
inline void Require(bool value, const char* message) {
  if (!value)
    Fail(ErrorCode::kRejected, message);
}
inline void Io(bool value, const char* message) {
  if (!value)
    Fail(ErrorCode::kUnavailable, message);
}
template <class T>
T Take(Result<T> result) {
  if (!result)
    throw Failure(result.error());
  return std::move(result).value();
}
inline void Take(Result<void> result) {
  if (!result)
    throw Failure(result.error());
}
Bytes Read(const fs::path& path, uint64_t limit = UINT64_MAX);
void Write(const fs::path& path, std::span<const uint8_t> bytes);
void WriteText(const fs::path& path, const std::string& text);
Json ParseJson(std::string_view text);
void Keys(const Json& json,
          std::initializer_list<std::string_view> required,
          std::initializer_list<std::string_view> optional = {});
uint64_t Unsigned(const Json& json);
std::string HexString(const Json& json);
Key Unhex(const std::string& hex);
std::string HashFile(const fs::path& path);
void AtomicText(const fs::path& path, const std::string& text);
class Mapping {
 public:
  explicit Mapping(const fs::path& path, std::optional<uint64_t> output_size = {});
  ~Mapping();
  Mapping(const Mapping&) = delete;
  Mapping& operator=(const Mapping&) = delete;
  std::span<uint8_t> bytes() { return {data_, size_}; }

 private:
  updater::Handle file_, mapping_;
  uint8_t* data_ = nullptr;
  size_t size_ = 0;
};
}  // namespace remotekit::release
