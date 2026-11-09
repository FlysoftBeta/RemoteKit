#include "documents/render_archive.hpp"

#include <json.hpp>
#include <zstd.h>

#include <algorithm>
#include <cmath>
#include <fstream>
#include <map>
#include <set>
#include <stdexcept>

namespace remotekit::documents {
namespace {
using Json = nlohmann::json;
constexpr uint64_t kResourceLimit = 64 * 1024 * 1024;
constexpr uint64_t kManifestLimit = 8 * 1024 * 1024;
constexpr uint64_t kDictionaryLimit = 64 * 1024;

struct ArchiveFailure {
  Error error;
};

void Require(bool condition, const char* reason) {
  if (!condition)
    throw ArchiveFailure{{ErrorCode::kRejected, reason}};
}

uint64_t Number(std::span<const uint8_t> bytes, size_t offset, size_t count) {
  Require(offset <= bytes.size() && count <= bytes.size() - offset, "truncated ZIP record");
  uint64_t result = 0;
  for (size_t i = 0; i < count; ++i)
    result |= uint64_t{bytes[offset + i]} << (8 * i);
  return result;
}

uint64_t Unsigned(const Json& value) {
  Require(value.is_number_unsigned(), "invalid manifest integer");
  return value.get<uint64_t>();
}

bool ContentId(std::string_view id) {
  return id.size() == 64 && std::all_of(id.begin(), id.end(), [](char c) {
           return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
         });
}

bool SafeName(std::string_view name) {
  if (name.empty() || name.front() == '/' || name.find_first_of("\\:") != name.npos)
    return false;
  for (unsigned char c : name) {
    if (c < 32 || c == 127 || c == '<' || c == '>' || c == '"' || c == '|' || c == '?' || c == '*')
      return false;
  }
  size_t start = 0;
  while (start < name.size()) {
    auto end = name.find('/', start);
    if (end == name.npos)
      end = name.size();
    auto part = name.substr(start, end - start);
    if (part.empty() || part == "." || part == ".." || part.back() == '.' || part.back() == ' ')
      return false;
    start = end + 1;
  }
  return name.back() != '/';
}

bool EntryName(std::string_view name) {
  if (name == "manifest.json" || name == "dictionary.zdict")
    return true;
  if (!name.starts_with("objects/"))
    return false;
  name.remove_prefix(8);
  if (name.ends_with(".zst"))
    name.remove_suffix(4);
  return ContentId(name);
}

struct Entry {
  uint64_t local, offset, size;
  uint32_t crc;
  uint16_t flags;
};

struct Object {
  std::string mime, encoding;
  uint64_t offset, stored, raw;
};
}  // namespace

struct RenderArchive::Impl {
  ArchiveRead read;
  uint64_t size;
  std::map<std::string, Entry> entries;
  std::map<std::string, Object> objects;
  ArchiveInfo info;
  std::unique_ptr<ZSTD_DDict, decltype(&ZSTD_freeDDict)> dictionary{nullptr, ZSTD_freeDDict};

  Bytes Read(uint64_t offset, uint64_t length) const {
    Require(offset <= size && length <= size - offset && length <= SIZE_MAX,
            "ZIP range outside archive");
    auto result = read(offset, static_cast<size_t>(length));
    if (!result)
      throw ArchiveFailure{result.error()};
    Require(result.value().size() == length, "truncated archive source");
    return std::move(result).value();
  }

  void Directory() {
    Require(size >= 98, "missing ZIP64 end records");
    auto tail = Read(size - std::min<uint64_t>(size, 65557), std::min<uint64_t>(size, 65557));
    size_t end = tail.size() - 22;
    for (;;) {
      if (Number(tail, end, 4) == 0x06054b50 && end + 22 + Number(tail, end + 20, 2) == tail.size())
        break;
      Require(end != 0, "missing ZIP end record");
      --end;
    }
    uint64_t end_offset = size - tail.size() + end;
    Require(end_offset >= 20 && Number(tail, end + 4, 2) == 0 && Number(tail, end + 6, 2) == 0,
            "split ZIP archive");
    auto locator = Read(end_offset - 20, 20);
    Require(Number(locator, 0, 4) == 0x07064b50 && Number(locator, 4, 4) == 0 &&
                Number(locator, 16, 4) == 1,
            "invalid ZIP64 locator");
    uint64_t zip64_offset = Number(locator, 8, 8);
    Require(zip64_offset <= end_offset - 20 && end_offset - 20 - zip64_offset >= 56,
            "invalid ZIP64 end offset");
    auto zip64 = Read(zip64_offset, 56);
    uint64_t record_size = Number(zip64, 4, 8);
    Require(Number(zip64, 0, 4) == 0x06064b50 && record_size >= 44 &&
                record_size == end_offset - 20 - zip64_offset - 12 && Number(zip64, 16, 4) == 0 &&
                Number(zip64, 20, 4) == 0,
            "invalid ZIP64 end record");
    uint64_t count = Number(zip64, 32, 8);
    uint64_t directory_size = Number(zip64, 40, 8);
    uint64_t directory_offset = Number(zip64, 48, 8);
    Require(count > 0 && count <= 250000 && count == Number(zip64, 24, 8) &&
                directory_size <= 64 * 1024 * 1024 && directory_offset <= zip64_offset &&
                directory_size == zip64_offset - directory_offset,
            "invalid ZIP directory bounds");
    auto matches_end = [&](size_t offset, size_t width, uint64_t actual) {
      auto value = Number(tail, end + offset, width);
      return value == ((uint64_t{1} << (width * 8)) - 1) || value == actual;
    };
    Require(matches_end(8, 2, count) && matches_end(10, 2, count) &&
                matches_end(12, 4, directory_size) && matches_end(16, 4, directory_offset),
            "inconsistent ZIP end records");
    auto central = Read(directory_offset, directory_size);
    size_t position = 0;
    for (uint64_t i = 0; i < count; ++i) {
      Require(Number(central, position, 4) == 0x02014b50, "invalid ZIP directory entry");
      uint16_t flags = static_cast<uint16_t>(Number(central, position + 8, 2));
      Require((flags & ~0x0808) == 0 && Number(central, position + 10, 2) == 0,
              "ZIP entry must be unencrypted STORED data");
      uint64_t compressed = Number(central, position + 20, 4);
      uint64_t raw = Number(central, position + 24, 4);
      size_t name_length = static_cast<size_t>(Number(central, position + 28, 2));
      size_t extra_length = static_cast<size_t>(Number(central, position + 30, 2));
      size_t comment_length = static_cast<size_t>(Number(central, position + 32, 2));
      Require(Number(central, position + 34, 2) == 0, "split ZIP entry");
      uint64_t local = Number(central, position + 42, 4);
      size_t length = 46 + name_length + extra_length + comment_length;
      Require(length <= central.size() - position, "truncated ZIP directory entry");
      std::string name(central.begin() + position + 46,
                       central.begin() + position + 46 + name_length);
      Require(SafeName(name) && EntryName(name), "unsafe or unexpected ZIP name");
      auto extra = std::span(central).subspan(position + 46 + name_length, extra_length);
      bool found_zip64 = false;
      for (size_t p = 0; p < extra.size();) {
        uint64_t tag = Number(extra, p, 2);
        size_t n = static_cast<size_t>(Number(extra, p + 2, 2));
        Require(n <= extra.size() - p - 4, "invalid ZIP extra field");
        if (tag == 1) {
          Require(!found_zip64, "duplicate ZIP64 extra field");
          found_zip64 = true;
          size_t at = p + 4;
          auto take = [&](uint64_t& value) {
            if (value == 0xffffffff) {
              Require(at + 8 <= p + 4 + n, "truncated ZIP64 extra field");
              value = Number(extra, at, 8);
              at += 8;
            }
          };
          take(raw);
          take(compressed);
          take(local);
        }
        p += 4 + n;
      }
      Require(
          (found_zip64 || (raw != 0xffffffff && compressed != 0xffffffff && local != 0xffffffff)) &&
              raw == compressed && raw <= kResourceLimit + 1024 * 1024 && local < directory_offset,
          "invalid ZIP entry sizes");
      Entry entry{local, 0, raw, static_cast<uint32_t>(Number(central, position + 16, 4)), flags};
      Require(entries.emplace(name, entry).second, "duplicate ZIP name");
      position += length;
    }
    Require(position == central.size(), "extra ZIP directory data");

    std::vector<std::pair<uint64_t, uint64_t>> ranges;
    for (auto& [name, entry] : entries) {
      Require(entry.local <= directory_offset && directory_offset - entry.local >= 30,
              "truncated ZIP local header");
      auto local = Read(entry.local, 30);
      Require(Number(local, 0, 4) == 0x04034b50 && Number(local, 6, 2) == entry.flags &&
                  Number(local, 8, 2) == 0 && Number(local, 14, 4) == entry.crc,
              "ZIP local header mismatch");
      uint64_t name_length = Number(local, 26, 2);
      uint64_t extra_length = Number(local, 28, 2);
      Require(name_length + extra_length <= directory_offset - entry.local - 30,
              "ZIP local header overlaps directory");
      auto local_name = Read(entry.local + 30, name_length);
      Require(std::string(local_name.begin(), local_name.end()) == name, "ZIP local name mismatch");
      entry.offset = entry.local + 30 + name_length + extra_length;
      Require(entry.offset <= directory_offset && entry.size <= directory_offset - entry.offset,
              "ZIP payload overlaps directory");
      auto local_extra = Read(entry.local + 30 + name_length, extra_length);
      uint64_t raw = Number(local, 22, 4), stored = Number(local, 18, 4);
      bool found_zip64 = false;
      for (size_t p = 0; p < local_extra.size();) {
        auto tag = Number(local_extra, p, 2);
        auto n = Number(local_extra, p + 2, 2);
        Require(n <= local_extra.size() - p - 4, "invalid ZIP local extra field");
        if (tag == 1) {
          Require(!found_zip64, "duplicate local ZIP64 extra field");
          found_zip64 = true;
          size_t at = p + 4;
          for (uint64_t* value : {&raw, &stored}) {
            if (*value == 0xffffffff) {
              Require(at + 8 <= p + 4 + n, "truncated local ZIP64 sizes");
              *value = Number(local_extra, at, 8);
              at += 8;
            }
          }
        }
        p += 4 + static_cast<size_t>(n);
      }
      Require(raw == entry.size && stored == entry.size, "ZIP local size mismatch");
      ranges.emplace_back(entry.local, entry.offset + entry.size);
    }
    std::sort(ranges.begin(), ranges.end());
    for (size_t i = 1; i < ranges.size(); ++i)
      Require(ranges[i - 1].second <= ranges[i].first, "overlapping ZIP entries");
  }

  const Entry& CrossCheck(const Json& metadata, uint64_t stored) const {
    auto path = metadata.at("path").get<std::string>();
    auto it = entries.find(path);
    Require(it != entries.end() && it->second.offset == Unsigned(metadata.at("storedOffset")) &&
                it->second.size == stored,
            "manifest ZIP offset or size mismatch");
    return it->second;
  }

  void Manifest() {
    auto manifest = entries.find("manifest.json");
    Require(manifest != entries.end() && manifest->second.size <= kManifestLimit,
            "missing or oversized manifest");
    auto bytes = Read(manifest->second.offset, manifest->second.size);
    Json json = Json::parse(bytes);
    Require(json.at("format") == "classapp-render-archive" && Unsigned(json.at("version")) == 2,
            "unsupported document archive format");
    bool has_dictionary = !json.at("dictionary").is_null();
    if (has_dictionary) {
      const auto& metadata = json.at("dictionary");
      uint64_t length = Unsigned(metadata.at("size"));
      Require(metadata.at("path") == "dictionary.zdict" && length > 0 && length <= kDictionaryLimit,
              "invalid document dictionary");
      auto entry = CrossCheck(metadata, length);
      auto data = Read(entry.offset, entry.size);
      Require(Sha256Hex(data) == metadata.at("contentId").get<std::string>(),
              "dictionary hash mismatch");
      Require(ZSTD_getDictID_fromDict(data.data(), data.size()) != 0, "invalid zstd dictionary");
      dictionary.reset(ZSTD_createDDict(data.data(), data.size()));
      Require(dictionary != nullptr, "cannot load zstd dictionary");
    }
    const auto& resources = json.at("resources");
    Require(resources.is_array(), "invalid manifest resources");
    for (const auto& metadata : resources) {
      auto id = metadata.at("contentId").get<std::string>();
      auto encoding = metadata.at("encoding").get<std::string>();
      uint64_t raw = Unsigned(metadata.at("rawSize"));
      uint64_t stored = Unsigned(metadata.at("storedSize"));
      Require(ContentId(id) && raw <= kResourceLimit && stored <= kResourceLimit + 1024 * 1024,
              "invalid resource size or content ID");
      bool identity = encoding == "identity";
      Require(identity || encoding == "zstd" || (encoding == "zstd-dictionary" && dictionary),
              "unsupported resource encoding");
      Require(!identity || raw == stored, "identity resource size mismatch");
      Require(metadata.at("path") == "objects/" + id + (identity ? "" : ".zst"),
              "invalid resource path");
      auto entry = CrossCheck(metadata, stored);
      auto mime = metadata.at("mime").get<std::string>();
      Require(!mime.empty() && mime.size() <= 256 && mime.find_first_of("\r\n") == mime.npos,
              "invalid resource MIME");
      Require(objects.emplace(id, Object{mime, encoding, entry.offset, stored, raw}).second,
              "duplicate resource content ID");
    }
    Require(entries.size() == objects.size() + 1 + (has_dictionary ? 1 : 0),
            "unindexed ZIP entries");
    auto references = [&](const Json& list) {
      Require(list.is_array(), "invalid document dependencies");
      std::vector<std::string> ids;
      std::set<std::string> unique;
      // pdfrender lists an image once per use, and identical images share a content ID.
      for (const auto& value : list) {
        auto id = value.get<std::string>();
        Require(objects.contains(id), "invalid resource reference");
        if (unique.insert(id).second)
          ids.push_back(std::move(id));
      }
      return ids;
    };
    const auto& document = json.at("document");
    Require(document.at("sourceMime") == "application/pdf", "invalid document source MIME");
    info.shared = references(document.at("shared"));
    const auto& items = document.at("items");
    Require(items.is_array() && items.size() <= 20000, "too many document pages");
    std::set<std::string> ids;
    for (const auto& page : items) {
      auto id = page.at("id").get<std::string>();
      uint64_t ordinal = Unsigned(page.at("ordinal"));
      double width = page.at("width").get<double>(), height = page.at("height").get<double>();
      auto html = page.at("document").get<std::string>();
      Require(!id.empty() && ids.insert(id).second && ordinal == info.pages.size() &&
                  std::isfinite(width) && std::isfinite(height) && width > 0 && height > 0 &&
                  objects.contains(html) && objects.at(html).mime == "text/html",
              "invalid document page");
      info.pages.push_back({id, static_cast<uint32_t>(ordinal), width, height, html,
                            references(page.at("dependencies"))});
    }
    const auto& files = json.at("files");
    Require(files.is_array(), "invalid document files");
    std::set<std::string> paths;
    for (const auto& file : files) {
      auto name = file.at("path").get<std::string>();
      Require(SafeName(name) && paths.insert(name).second &&
                  objects.contains(file.at("contentId").get<std::string>()),
              "invalid semantic file mapping");
    }
  }
};

Result<RenderArchive> RenderArchive::Open(ArchiveRead read, uint64_t size) {
  try {
    auto impl = std::make_shared<Impl>();
    Require(static_cast<bool>(read), "missing archive source");
    impl->read = std::move(read);
    impl->size = size;
    impl->Directory();
    impl->Manifest();
    return RenderArchive(std::move(impl));
  } catch (const ArchiveFailure& failure) {
    return failure.error;
  } catch (const std::exception&) {
    return Error{ErrorCode::kRejected, "invalid document archive"};
  }
}

Result<RenderArchive> RenderArchive::OpenFile(const std::filesystem::path& path) {
  std::error_code error;
  uint64_t size = std::filesystem::file_size(path, error);
  if (error)
    return Error{ErrorCode::kNotFound, "document archive missing"};
  return Open(
      [path](uint64_t offset, size_t length) -> Result<Bytes> {
        std::ifstream file(path, std::ios::binary);
        file.seekg(static_cast<std::streamoff>(offset));
        Bytes data(length);
        file.read(reinterpret_cast<char*>(data.data()), static_cast<std::streamsize>(length));
        if (!file)
          return Error{ErrorCode::kRejected, "cannot read document archive"};
        return data;
      },
      size);
}

Result<ArchiveInfo> RenderArchive::Info() const {
  return impl_->info;
}

Result<std::pair<std::string, Bytes>> RenderArchive::Resource(const std::string& content_id) const {
  auto found = impl_->objects.find(content_id);
  if (found == impl_->objects.end())
    return Error{ErrorCode::kNotFound, "document resource missing"};
  try {
    const auto& object = found->second;
    Bytes stored = impl_->Read(object.offset, object.stored);
    Bytes raw;
    if (object.encoding == "identity") {
      raw = std::move(stored);
    } else {
      Require(ZSTD_findFrameCompressedSize(stored.data(), stored.size()) == stored.size(),
              "invalid zstd frame size");
      std::unique_ptr<ZSTD_DCtx, decltype(&ZSTD_freeDCtx)> context(ZSTD_createDCtx(),
                                                                   ZSTD_freeDCtx);
      Require(context != nullptr, "cannot create zstd decoder");
      Require(!ZSTD_isError(ZSTD_DCtx_setParameter(context.get(), ZSTD_d_windowLogMax, 26)),
              "cannot limit zstd window");
      raw.resize(static_cast<size_t>(object.raw));
      size_t length =
          object.encoding == "zstd-dictionary"
              ? ZSTD_decompress_usingDDict(context.get(), raw.data(), raw.size(), stored.data(),
                                           stored.size(), impl_->dictionary.get())
              : ZSTD_decompressDCtx(context.get(), raw.data(), raw.size(), stored.data(),
                                    stored.size());
      Require(!ZSTD_isError(length) && length == object.raw, "invalid zstd resource");
    }
    Require(raw.size() == object.raw && Sha256Hex(raw) == content_id,
            "document resource hash mismatch");
    return std::pair{object.mime, std::move(raw)};
  } catch (const ArchiveFailure& failure) {
    return failure.error;
  } catch (const std::exception&) {
    return Error{ErrorCode::kRejected, "cannot decode document resource"};
  }
}
}  // namespace remotekit::documents
