#include "archive.hpp"
#include <windows.h>
#include <zstd.h>
#include <algorithm>
#include <charconv>
#include <fstream>
#include <map>
#include <stdexcept>

namespace remotekit::updater {
namespace {
namespace fs = std::filesystem;
void Require(bool condition, const char* message) {
  if (!condition)
    throw std::runtime_error(message);
}
void Exact(const ArchiveRead& read, std::span<uint8_t> bytes) {
  while (!bytes.empty()) {
    size_t n = read(bytes);
    Require(n && n <= bytes.size(), "truncated tar archive");
    bytes = bytes.subspan(n);
  }
}
uint64_t Octal(std::span<const uint8_t> bytes) {
  uint64_t value = 0;
  bool end = false;
  for (uint8_t c : bytes) {
    if (c == 0 || c == ' ') {
      if (value)
        end = true;
      continue;
    }
    Require(!end && c >= '0' && c <= '7' && value <= (UINT64_MAX - 7) / 8, "invalid tar number");
    value = value * 8 + c - '0';
  }
  return value;
}
uint64_t Decimal(std::string_view s) {
  uint64_t n = 0;
  auto [end, ec] = std::from_chars(s.data(), s.data() + s.size(), n);
  Require(!s.empty() && ec == std::errc() && end == s.data() + s.size(), "invalid PAX number");
  return n;
}
std::string Field(std::span<const uint8_t> bytes) {
  return std::string(bytes.begin(), std::find(bytes.begin(), bytes.end(), 0));
}
std::map<std::string, std::string> Pax(std::span<const uint8_t> bytes) {
  std::map<std::string, std::string> result;
  std::string_view text(reinterpret_cast<const char*>(bytes.data()), bytes.size());
  while (!text.empty()) {
    auto space = text.find(' ');
    Require(space != text.npos, "invalid PAX record");
    uint64_t n = Decimal(text.substr(0, space));
    Require(n > space + 2 && n <= text.size() && text[n - 1] == '\n', "invalid PAX length");
    auto record = text.substr(space + 1, static_cast<size_t>(n) - space - 2);
    auto equals = record.find('=');
    Require(equals != record.npos, "invalid PAX key");
    result[std::string(record.substr(0, equals))] = std::string(record.substr(equals + 1));
    text.remove_prefix(static_cast<size_t>(n));
  }
  return result;
}
fs::path SafePath(const std::string& name) {
  Require(!name.empty() && name[0] != '/' && name.find_first_of("\\:\0", 0, 3) == name.npos,
          "unsafe tar path");
  std::vector<std::string> parts;
  size_t start = 0;
  while (start < name.size()) {
    size_t slash = name.find('/', start);
    if (slash == name.npos)
      slash = name.size();
    auto part = name.substr(start, slash - start);
    Require(!part.empty() && part != ".." && part != "." && part.back() != '.' &&
                part.back() != ' ' && part.find_first_of("<>\"|?*") == part.npos,
            "unsafe tar path component");
    std::string base = part.substr(0, part.find('.'));
    std::transform(base.begin(), base.end(), base.begin(),
                   [](unsigned char c) { return static_cast<char>(toupper(c)); });
    Require(base != "CON" && base != "PRN" && base != "AUX" && base != "NUL" &&
                !(base.size() == 4 && (base.starts_with("COM") || base.starts_with("LPT")) &&
                  base[3] >= '0' && base[3] <= '9'),
            "reserved Windows tar path");
    for (unsigned char c : part)
      Require(c >= 32, "invalid tar path character");
    parts.push_back(part);
    start = slash + 1;
  }
  Require(!parts.empty() && parts[0] == "node", "tar entry outside node/");
  int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, name.data(),
                              static_cast<int>(name.size()), nullptr, 0);
  Require(n > 0, "invalid UTF-8 tar path");
  std::wstring wide(n, L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, name.data(), static_cast<int>(name.size()),
                      wide.data(), n);
  return fs::path(wide);
}
fs::path Extended(const fs::path& path) {
  auto absolute = fs::absolute(path).make_preferred().wstring();
  if (absolute.starts_with(L"\\\\?\\"))
    return absolute;
  if (absolute.starts_with(L"\\\\"))
    return L"\\\\?\\UNC\\" + absolute.substr(2);
  return L"\\\\?\\" + absolute;
}
void Padding(const ArchiveRead& read, uint64_t size) {
  std::array<uint8_t, 512> bytes;
  size_t n = static_cast<size_t>((512 - size % 512) % 512);
  if (n)
    Exact(read, std::span(bytes).first(n));
}
class ZstdReader {
 public:
  explicit ZstdReader(const fs::path& path)
      : file_(path, std::ios::binary), stream_(ZSTD_createDStream()) {
    Require(file_.is_open() && stream_, "cannot open zstd archive");
    Require(!ZSTD_isError(ZSTD_initDStream(stream_)), "zstd initialization failed");
  }
  ~ZstdReader() { ZSTD_freeDStream(stream_); }
  size_t Read(std::span<uint8_t> output) {
    ZSTD_outBuffer out{output.data(), output.size(), 0};
    while (out.pos == 0) {
      if (input_.pos == input_.size) {
        file_.read(reinterpret_cast<char*>(buffer_.data()), buffer_.size());
        input_ = {buffer_.data(), static_cast<size_t>(file_.gcount()), 0};
        if (!input_.size) {
          Require(file_.eof() && remaining_ == 0 && seen_, "truncated zstd stream");
          return 0;
        }
      }
      remaining_ = ZSTD_decompressStream(stream_, &out, &input_);
      seen_ = true;
      Require(!ZSTD_isError(remaining_), "invalid zstd stream");
    }
    return out.pos;
  }

 private:
  std::ifstream file_;
  ZSTD_DStream* stream_;
  std::array<uint8_t, 65536> buffer_;
  ZSTD_inBuffer input_{nullptr, 0, 0};
  size_t remaining_ = 0;
  bool seen_ = false;
};
}  // namespace
fs::path ExtendedPath(const fs::path& path) {
  return Extended(path);
}
Result<void> ExtractTar(const ArchiveRead& read, const fs::path& destination) {
  try {
    std::map<std::string, std::string> pax;
    std::array<uint8_t, 512> header;
    std::array<uint8_t, 65536> buffer;
    while (true) {
      Exact(read, header);
      if (std::all_of(header.begin(), header.end(), [](uint8_t b) { return b == 0; })) {
        Exact(read, header);
        Require(std::all_of(header.begin(), header.end(), [](uint8_t b) { return b == 0; }),
                "invalid tar end marker");
        for (size_t n = read(buffer); n; n = read(buffer))
          Require(std::all_of(buffer.begin(), buffer.begin() + n, [](uint8_t b) { return b == 0; }),
                  "trailing tar data");
        Require(pax.empty(), "dangling PAX header");
        return {};
      }
      uint64_t sum = 0;
      for (size_t i = 0; i < 512; ++i)
        sum += (i >= 148 && i < 156) ? 32 : header[i];
      Require(sum == Octal(std::span(header).subspan(148, 8)), "tar checksum mismatch");
      Require(Field(std::span(header).subspan(257, 6)) == "ustar", "unsupported tar format");
      uint64_t size = Octal(std::span(header).subspan(124, 12));
      char type = static_cast<char>(header[156]);
      if (type == 'x' || type == 'g') {
        Require(size <= 1024 * 1024, "PAX header too large");
        std::vector<uint8_t> data(static_cast<size_t>(size));
        Exact(read, data);
        Padding(read, size);
        auto fields = Pax(data);
        if (type == 'x') {
          for (auto& [k, v] : fields)
            pax[k] = std::move(v);
        }
        continue;
      }
      Require(type == 0 || type == '0' || type == '5', "forbidden tar entry type");
      auto name = Field(std::span(header).first(100));
      auto prefix = Field(std::span(header).subspan(345, 155));
      if (!prefix.empty())
        name = prefix + "/" + name;
      if (pax.contains("path"))
        name = pax["path"];
      if (pax.contains("size"))
        size = Decimal(pax["size"]);
      pax.clear();
      auto relative = SafePath(name);
      auto path = Extended(destination / relative);
      if (type == '5') {
        Require(size == 0, "directory has tar data");
        fs::create_directories(path);
      } else {
        Require(relative != L"node", "node root must be a directory");
        fs::create_directories(path.parent_path());
        HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
                                  FILE_ATTRIBUTE_NORMAL, nullptr);
        Require(file != INVALID_HANDLE_VALUE, "cannot create archive file");
        try {
          uint64_t left = size;
          while (left) {
            size_t n = static_cast<size_t>(std::min<uint64_t>(buffer.size(), left));
            Exact(read, std::span(buffer).first(n));
            DWORD written = 0;
            Require(WriteFile(file, buffer.data(), static_cast<DWORD>(n), &written, nullptr) &&
                        written == n,
                    "archive write failed");
            left -= n;
          }
        } catch (...) {
          CloseHandle(file);
          throw;
        }
        CloseHandle(file);
      }
      Padding(read, size);
    }
  } catch (const std::exception& error) {
    return Error{ErrorCode::kInvalidRequest, error.what()};
  }
}
Result<void> ExtractArchive(const fs::path& archive, const fs::path& destination) {
  try {
    ZstdReader reader(archive);
    return ExtractTar([&](std::span<uint8_t> bytes) { return reader.Read(bytes); }, destination);
  } catch (const std::exception& error) {
    return Error{ErrorCode::kInvalidRequest, error.what()};
  }
}
}  // namespace remotekit::updater
