#include "objects/store.hpp"
#include "persistence/strict_json.hpp"
#include "objects/digest.hpp"
#include "util/result_macros.hpp"
#include <windows.h>
#include <bcrypt.h>
#include <zstd.h>
#include <algorithm>
#include <array>
#include <fstream>
#include <limits>
#include <set>
#include <stdexcept>
#include <chrono>
#include <sstream>

namespace remotekit::objects {
namespace {
namespace fs = std::filesystem;
using cluster::Bytes;
Error Corrupt() {
  return CorruptRecord("Corrupt local object");
}
Error Io(DWORD code = GetLastError()) {
  return WithOsError(ErrorCode::kUnavailable, "object I/O failed", OsError::Kind::kWin32, code);
}
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() {
    if (value != INVALID_HANDLE_VALUE)
      CloseHandle(value);
  }
};
Result<void> Flush(const fs::path& path) {
  Handle file{CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                          FILE_ATTRIBUTE_NORMAL, nullptr)};
  if (file.value == INVALID_HANDLE_VALUE || !FlushFileBuffers(file.value))
    return Io();
  return {};
}
void Append(Bytes& bytes, std::string_view text) {
  bytes.insert(bytes.end(), text.begin(), text.end());
}
void Append32(Bytes& bytes, uint32_t value) {
  const auto encoded = cluster::EncodeLength(value);
  bytes.insert(bytes.end(), encoded.begin(), encoded.end());
}
Bytes EncodeHeader(uint64_t size) {
  const uint64_t count = size / kSegmentSize + (size % kSegmentSize != 0);
  if (count > UINT32_MAX)
    throw std::length_error("object too large");
  Bytes header;
  Append(header, "RKO2");
  Append32(header, 2);
  for (int i = 0; i < 8; ++i)
    header.push_back(static_cast<uint8_t>(size >> (8 * i)));
  Append32(header, kSegmentSize);
  Append32(header, static_cast<uint32_t>(count));
  return header;
}
struct Header {
  uint64_t size;
  uint32_t count;
};
Result<Header> ReadHeader(std::istream& stream) {
  std::array<uint8_t, 24> bytes{};
  stream.read(reinterpret_cast<char*>(bytes.data()), bytes.size());
  auto u32 = [&](size_t offset) {
    return cluster::DecodeLength(std::span<const uint8_t, 4>(bytes.data() + offset, 4));
  };
  uint64_t size = 0;
  for (int i = 0; i < 8; ++i)
    size |= uint64_t(bytes[8 + i]) << (i * 8);
  const uint64_t count = size / kSegmentSize + (size % kSegmentSize != 0);
  if (!stream || std::string_view(reinterpret_cast<char*>(bytes.data()), 4) != "RKO2" ||
      u32(4) != 2 || u32(16) != kSegmentSize || count > UINT32_MAX || u32(20) != count)
    return Corrupt();
  return Header{size, static_cast<uint32_t>(count)};
}
Result<Bytes> Crypt(bool encrypt,
                    const Key& key,
                    const std::string& id,
                    uint32_t index,
                    uint32_t count,
                    std::span<const uint8_t> input) {
  Bytes nonce_input;
  Append(nonce_input, id);
  Append32(nonce_input, index);
  Digest nonce_hash(&key);
  nonce_hash.Add(nonce_input);
  auto nonce = nonce_hash.Finish();
  Bytes aad;
  Append(aad, id);
  Append32(aad, index);
  Append32(aad, count);
  struct Aes {
    BCRYPT_ALG_HANDLE algorithm{};
    BCRYPT_KEY_HANDLE key{};
    ~Aes() {
      if (key)
        BCryptDestroyKey(key);
      if (algorithm)
        BCryptCloseAlgorithmProvider(algorithm, 0);
    }
  } aes;
  if (BCryptOpenAlgorithmProvider(&aes.algorithm, BCRYPT_AES_ALGORITHM, nullptr, 0) < 0 ||
      BCryptSetProperty(aes.algorithm, BCRYPT_CHAINING_MODE,
                        reinterpret_cast<PUCHAR>(const_cast<wchar_t*>(BCRYPT_CHAIN_MODE_GCM)),
                        sizeof(BCRYPT_CHAIN_MODE_GCM), 0) < 0 ||
      BCryptGenerateSymmetricKey(aes.algorithm, &aes.key, nullptr, 0,
                                 const_cast<PUCHAR>(key.data()), 32, 0) < 0)
    return Error{ErrorCode::kInternal, "object cipher initialization failed"};
  if (!encrypt && input.size() < 16)
    return Corrupt();
  const size_t length = encrypt ? input.size() : input.size() - 16;
  Bytes output(length + (encrypt ? 16 : 0));
  BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO info;
  BCRYPT_INIT_AUTH_MODE_INFO(info);
  info.pbNonce = nonce.data();
  info.cbNonce = 12;
  info.pbAuthData = aad.data();
  info.cbAuthData = static_cast<ULONG>(aad.size());
  info.pbTag = encrypt ? output.data() + length : const_cast<PUCHAR>(input.data()) + length;
  info.cbTag = 16;
  ULONG written = 0;
  const auto status =
      encrypt
          ? BCryptEncrypt(aes.key, const_cast<PUCHAR>(input.data()), static_cast<ULONG>(length),
                          &info, nullptr, 0, output.data(), static_cast<ULONG>(length), &written, 0)
          : BCryptDecrypt(aes.key, const_cast<PUCHAR>(input.data()), static_cast<ULONG>(length),
                          &info, nullptr, 0, output.data(), static_cast<ULONG>(length), &written,
                          0);
  if (status < 0 || written != length)
    return Corrupt();
  return output;
}
Result<Bytes> EncodeSegment(const Keys& keys,
                            const std::string& id,
                            uint32_t index,
                            uint32_t count,
                            std::span<const uint8_t> bytes,
                            Bytes& compressed) {
  const auto stored =
      ZSTD_compress(compressed.data(), compressed.size(), bytes.data(), bytes.size(), 3);
  if (ZSTD_isError(stored))
    return Error{ErrorCode::kInternal, "object compression failed"};
  const bool compress = stored < bytes.size();
  RK_ASSIGN_OR_RETURN(
      ciphertext, Crypt(true, keys.object, id, index, count,
                        compress ? std::span<const uint8_t>(compressed.data(), stored) : bytes));
  Bytes encoded{static_cast<uint8_t>(compress)};
  Append32(encoded, static_cast<uint32_t>(ciphertext.size()));
  encoded.insert(encoded.end(), ciphertext.begin(), ciphertext.end());
  return encoded;
}
Result<Bytes> Segment(std::istream& stream,
                      const Header& header,
                      const Keys& keys,
                      const std::string& id,
                      uint32_t index) {
  std::array<uint8_t, 5> prefix{};
  stream.read(reinterpret_cast<char*>(prefix.data()), prefix.size());
  const auto length = cluster::DecodeLength(std::span<const uint8_t, 4>(prefix.data() + 1, 4));
  const size_t expected = static_cast<size_t>(
      std::min<uint64_t>(kSegmentSize, header.size - uint64_t(index) * kSegmentSize));
  if (!stream || prefix[0] > 1 || length < 16 || length > expected + 16 ||
      (prefix[0] == 0 && length != expected + 16))
    return Corrupt();
  Bytes encrypted(length);
  stream.read(reinterpret_cast<char*>(encrypted.data()), encrypted.size());
  if (!stream)
    return Corrupt();
  RK_ASSIGN_OR_RETURN(plain, Crypt(false, keys.object, id, index, header.count, encrypted));
  if (prefix[0]) {
    Bytes decoded(expected);
    if (plain.size() >= expected ||
        ZSTD_findFrameCompressedSize(plain.data(), plain.size()) != plain.size() ||
        ZSTD_decompress(decoded.data(), decoded.size(), plain.data(), plain.size()) != expected)
      return Corrupt();
    return decoded;
  }
  return plain;
}
}  // namespace
bool ValidTenant(std::string_view value) {
  return !value.empty() && value.size() <= 128 &&
         std::all_of(value.begin(), value.end(), [](char c) {
           return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
                  c == '-' || c == '_';
         });
}
bool ValidId(std::string_view value) {
  return value.size() == 64 && std::all_of(value.begin(), value.end(), [](char c) {
           return (c >= 'a' && c <= 'f') || (c >= '0' && c <= '9');
         });
}
Keys::~Keys() {
  SecureZeroMemory(object.data(), object.size());
  SecureZeroMemory(id.data(), id.size());
}
Json ObjectInfo::Committed() const {
  return {{"objectId", id},
          {"size", size},
          {"storedSize", stored_size},
          {"storedSha256", stored_sha256}};
}
Json ObjectInfo::Inventory() const {
  return {{"id", id}, {"storedSize", stored_size}, {"storedSha256", stored_sha256}};
}
ObjectStore::ObjectStore(fs::path data) : root_(std::move(data) / "objects") {
  fs::create_directories(root_);
  constexpr char hex[] = "0123456789abcdef";
  for (char high : std::string_view(hex, 16))
    for (char low : std::string_view(hex, 16))
      fs::create_directory(root_ / std::string{high, low});
}
std::unique_lock<std::recursive_mutex> ObjectStore::Lock(const std::string& id) const {
  return std::unique_lock(locks_[std::hash<std::string>{}(id) % locks_.size()]);
}
Result<fs::path> ObjectStore::StoredPath(const std::string& id) const {
  if (!ValidId(id))
    return Error{ErrorCode::kInvalidRequest, "invalid object identity"};
  return root_ / id.substr(0, 2) / (id + ".rko");
}
Result<ObjectInfo> ObjectStore::Inspect(const std::string& id) const {
  RK_ASSIGN_OR_RETURN(path, StoredPath(id));
  auto lock = Lock(id);
  std::ifstream input(path, std::ios::binary);
  if (!input) {
    unsigned long code = 0;
    _get_doserrno(&code);
    return Error{code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND
                     ? ErrorCode::kNotFound
                     : ErrorCode::kUnavailable,
                 "object open failed: Windows " + std::to_string(code),
                 {},
                 {},
                 OsError{OsError::Kind::kWin32, code}};
  }
  RK_ASSIGN_OR_RETURN(header, ReadHeader(input));
  RK_ASSIGN_OR_RETURN(digest, cluster::Sha256File(path));
  std::error_code error;
  const auto size = fs::file_size(path, error);
  if (error)
    return Io(error.value());
  return ObjectInfo{id, header.size, size, cluster::Hex(digest)};
}
Result<ObjectInfo> ObjectStore::Write(const Keys& keys,
                                      const fs::path& source,
                                      const Check& check) {
  std::ifstream input(source, std::ios::binary);
  if (!input)
    return Io();
  return Write(keys, input, check);
}
Result<ObjectInfo> ObjectStore::WriteChunk(const Keys& keys,
                                           std::string_view plaintext,
                                           const ObjectInfo* known) {
  if (plaintext.size() > kSegmentSize) {
    std::istringstream input{std::string(plaintext)};
    return Write(keys, input);
  }
  const auto bytes =
      std::span(reinterpret_cast<const uint8_t*>(plaintext.data()), plaintext.size());
  Digest digest(&keys.id);
  digest.Add(bytes);
  const auto id = cluster::Hex(digest.Finish());
  if (known && known->id == id)
    return *known;
  auto lock = Lock(id);
  auto local = Inspect(id);
  if (local)
    return local;
  if (local.error().code != ErrorCode::kNotFound)
    return local.error();
  const auto start = std::chrono::steady_clock::now();
  Bytes encoded = EncodeHeader(bytes.size());
  if (!bytes.empty()) {
    Bytes compressed(ZSTD_compressBound(bytes.size()));
    RK_ASSIGN_OR_RETURN(segment, EncodeSegment(keys, id, 0, 1, bytes, compressed));
    encoded.insert(encoded.end(), segment.begin(), segment.end());
  }
  const auto cpu_ms =
      std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
  RK_ASSIGN_OR_RETURN(path, StoredPath(id));
  auto partial = path;
  partial += ".partial";
  std::ofstream output(partial, std::ios::binary | std::ios::trunc);
  output.write(reinterpret_cast<const char*>(encoded.data()),
               static_cast<std::streamsize>(encoded.size()));
  output.close();
  if (!output)
    return Io();
  RK_RETURN_IF_ERROR(Flush(partial));
  if (!MoveFileExW(partial.c_str(), path.c_str(),
                   MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
    return Io();
  return ObjectInfo{id,   bytes.size(), encoded.size(), cluster::Hex(cluster::Sha256(encoded)),
                    true, cpu_ms};
}
Result<ObjectInfo> ObjectStore::Write(const Keys& keys, std::istream& input, const Check& check) {
  // Spooling supports non-seekable streams and fixes the plaintext before its id is used as a nonce
  // input.
  std::array<uint8_t, 16> random{};
  if (BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()),
                      BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
    return Error{ErrorCode::kInternal, "object spool id failed"};
  const auto spool = root_ / (cluster::Hex(random) + ".partial");
  Handle copy{CreateFileW(spool.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, CREATE_NEW,
                          FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE, nullptr)};
  if (copy.value == INVALID_HANDLE_VALUE)
    return Io();
  struct Cleanup {
    fs::path path;
    ~Cleanup() {
      std::error_code error;
      fs::remove(path, error);
    }
  };
  Digest digest(&keys.id);
  Bytes buffer(kSegmentSize);
  uint64_t size = 0;
  while (true) {
    if (check)
      RK_RETURN_IF_ERROR(check());
    input.read(reinterpret_cast<char*>(buffer.data()), buffer.size());
    const auto count = input.gcount();
    if (count) {
      digest.Add(std::span(buffer.data(), static_cast<size_t>(count)));
      DWORD written = 0;
      if (!WriteFile(copy.value, buffer.data(), static_cast<DWORD>(count), &written, nullptr) ||
          written != static_cast<DWORD>(count))
        return Io();
      size += count;
    }
    if ((input.fail() && !input.eof()) || input.bad())
      return Io();
    if (input.eof())
      break;
  }
  if (!SetFilePointerEx(copy.value, LARGE_INTEGER{}, nullptr, FILE_BEGIN))
    return Io();
  const auto id = cluster::Hex(digest.Finish());
  auto lock = Lock(id);
  RK_ASSIGN_OR_RETURN(path, StoredPath(id));
  auto partial = path;
  partial += ".partial";
  Cleanup partial_cleanup{partial};
  std::ofstream output(partial, std::ios::binary | std::ios::trunc);
  const uint64_t count64 = size / kSegmentSize + (size % kSegmentSize != 0);
  if (count64 > UINT32_MAX)
    return Error{ErrorCode::kLimitExceeded, "object too large"};
  const auto count = static_cast<uint32_t>(count64);
  const auto header = EncodeHeader(size);
  output.write(reinterpret_cast<const char*>(header.data()), header.size());
  Bytes compressed(ZSTD_compressBound(kSegmentSize));
  for (uint32_t index = 0; index < count; ++index) {
    if (check)
      RK_RETURN_IF_ERROR(check());
    const auto length = static_cast<size_t>(
        std::min<uint64_t>(kSegmentSize, size - uint64_t(index) * kSegmentSize));
    DWORD read = 0;
    if (!ReadFile(copy.value, buffer.data(), static_cast<DWORD>(length), &read, nullptr) ||
        read != length)
      return Io();
    RK_ASSIGN_OR_RETURN(segment,
                        EncodeSegment(keys, id, index, count,
                                      std::span<const uint8_t>(buffer.data(), length), compressed));
    output.write(reinterpret_cast<const char*>(segment.data()), segment.size());
    if (!output)
      return Io();
  }
  output.close();
  if (!output)
    return Io();
  if (check)
    RK_RETURN_IF_ERROR(check());
  RK_RETURN_IF_ERROR(Flush(partial));
  if (!MoveFileExW(partial.c_str(), path.c_str(),
                   MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
    return Io();
  return Inspect(id);
}
Result<void> ObjectStore::Read(const Keys& keys,
                               const std::string& id,
                               std::ostream& output) const {
  RK_ASSIGN_OR_RETURN(path, StoredPath(id));
  auto lock = Lock(id);
  std::ifstream input(path, std::ios::binary);
  if (!input) {
    unsigned long code = 0;
    _get_doserrno(&code);
    return Error{code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND
                     ? ErrorCode::kNotFound
                     : ErrorCode::kUnavailable,
                 "object open failed: Windows " + std::to_string(code),
                 {},
                 {},
                 OsError{OsError::Kind::kWin32, code}};
  }
  RK_ASSIGN_OR_RETURN(header, ReadHeader(input));
  Digest digest(&keys.id);
  for (uint32_t index = 0; index < header.count; ++index) {
    RK_ASSIGN_OR_RETURN(segment, Segment(input, header, keys, id, index));
    digest.Add(segment);
    output.write(reinterpret_cast<const char*>(segment.data()), segment.size());
    if (!output)
      return Io();
  }
  if (input.peek() != std::char_traits<char>::eof() || cluster::Hex(digest.Finish()) != id)
    return Corrupt();
  return {};
}
Result<Bytes> ObjectStore::ReadRange(const Keys& keys,
                                     const std::string& id,
                                     uint64_t offset,
                                     size_t length) const {
  if (length > kSegmentSize)
    return Error{ErrorCode::kLimitExceeded, "object range too large"};
  RK_ASSIGN_OR_RETURN(path, StoredPath(id));
  auto lock = Lock(id);
  std::ifstream input(path, std::ios::binary);
  if (!input) {
    unsigned long code = 0;
    _get_doserrno(&code);
    return Error{code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND
                     ? ErrorCode::kNotFound
                     : ErrorCode::kUnavailable,
                 "object open failed: Windows " + std::to_string(code),
                 {},
                 {},
                 OsError{OsError::Kind::kWin32, code}};
  }
  RK_ASSIGN_OR_RETURN(header, ReadHeader(input));
  if (offset > header.size)
    return Error{ErrorCode::kInvalidRequest, "invalid object offset"};
  Bytes result;
  const auto end = offset + std::min<uint64_t>(length, header.size - offset);
  for (uint32_t index = 0; index < header.count; ++index) {
    const uint64_t begin = uint64_t(index) * kSegmentSize;
    if (begin >= end || begin + kSegmentSize <= offset) {
      std::array<uint8_t, 5> prefix{};
      input.read(reinterpret_cast<char*>(prefix.data()), prefix.size());
      const auto stored = cluster::DecodeLength(std::span<const uint8_t, 4>(prefix.data() + 1, 4));
      const auto expected = std::min<uint64_t>(kSegmentSize, header.size - begin);
      if (!input || prefix[0] > 1 || stored < 16 || stored > expected + 16 ||
          (prefix[0] == 0 && stored != expected + 16))
        return Corrupt();
      input.seekg(stored, std::ios::cur);
      if (!input)
        return Corrupt();
      continue;
    }
    RK_ASSIGN_OR_RETURN(segment, Segment(input, header, keys, id, index));
    const auto left = std::max(begin, offset), right = std::min(begin + segment.size(), end);
    if (left < right)
      result.insert(result.end(), segment.begin() + (left - begin),
                    segment.begin() + (right - begin));
  }
  const auto position = input.tellg();
  input.seekg(0, std::ios::end);
  if (!input || position != input.tellg() ||
      (!header.count && cluster::Hex(Digest(&keys.id).Finish()) != id))
    return Corrupt();
  return result;
}
Result<ObjectInfo> ObjectStore::Import(const std::string& id,
                                       uint64_t size,
                                       const std::string& sha256) {
  RK_ASSIGN_OR_RETURN(path, StoredPath(id));
  auto lock = Lock(id);
  auto partial = path;
  partial += ".partial";
  std::error_code error;
  const auto actual_size = fs::file_size(partial, error);
  RK_ASSIGN_OR_RETURN(digest, cluster::Sha256File(partial));
  if (error || size != actual_size || !ValidId(sha256) || cluster::Hex(digest) != sha256) {
    fs::remove(partial, error);
    return Corrupt();
  }
  std::ifstream input(partial, std::ios::binary);
  auto header = ReadHeader(input);
  input.close();
  if (!header) {
    fs::remove(partial, error);
    return header.error();
  }
  RK_RETURN_IF_ERROR(Flush(partial));
  if (!MoveFileExW(partial.c_str(), path.c_str(),
                   MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
    return Io();
  return ObjectInfo{id, header.value().size, size, sha256};
}
Result<void> ObjectStore::Delete(const std::string& id) {
  RK_ASSIGN_OR_RETURN(path, StoredPath(id));
  auto lock = Lock(id);
  std::error_code error;
  fs::remove(path, error);
  if (error)
    return Io(error.value());
  path += ".partial";
  fs::remove(path, error);
  if (error)
    return Io(error.value());
  return {};
}
Result<Json> ObjectStore::Inventory(const Json& cursor) const {
  if (!cursor.is_null() && (!cursor.is_string() || !ValidId(cursor.get<std::string>())))
    return Error{ErrorCode::kInvalidRequest, "invalid inventory cursor"};
  const auto after = cursor.is_null() ? std::string() : cursor.get<std::string>();
  std::set<std::string> page;
  for (const auto& entry : fs::recursive_directory_iterator(root_)) {
    if (!entry.is_regular_file() || entry.path().extension() != ".rko")
      continue;
    const auto id = entry.path().stem().string();
    if (!ValidId(id) || id <= after || entry.path() != root_ / id.substr(0, 2) / (id + ".rko"))
      continue;
    page.insert(id);
    if (page.size() > 257)
      page.erase(std::prev(page.end()));
  }
  Json objects = Json::array();
  std::string last;
  for (const auto& id : page) {
    if (objects.size() == 256)
      break;
    RK_ASSIGN_OR_RETURN(info, Inspect(id));
    objects.push_back(info.Inventory());
    last = id;
  }
  return Json{{"objects", objects}, {"next", page.size() > 256 ? Json(last) : Json(nullptr)}};
}
}  // namespace remotekit::objects
