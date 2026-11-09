#include "documents/document_types.hpp"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <vector>

namespace remotekit::documents {
namespace {
bool Starts(std::span<const uint8_t> bytes, std::string_view signature) {
  return bytes.size() >= signature.size() &&
         std::equal(signature.begin(), signature.end(), bytes.begin(),
                    [](char a, uint8_t b) { return static_cast<uint8_t>(a) == b; });
}

bool Text(std::span<const uint8_t> bytes) {
  if (Starts(bytes, "\xff\xfe") || Starts(bytes, "\xfe\xff"))
    return true;
  return std::all_of(bytes.begin(), bytes.end(),
                     [](uint8_t c) { return c >= 32 || c == 9 || c == 10 || c == 13; });
}

bool Media(std::span<const uint8_t> bytes) {
  if (Starts(bytes, "\xff\xfe") || Starts(bytes, "\xfe\xff"))
    return false;
  for (auto magic : {"\x89PNG", "\xff\xd8\xff", "GIF87a", "GIF89a", "BM", "ID3", "fLaC", "OggS",
                     "\x1a\x45\xdf\xa3", "MZ"}) {
    if (Starts(bytes, magic))
      return true;
  }
  if (Starts(bytes, std::string_view("II*\0", 4)) || Starts(bytes, std::string_view("MM\0*", 4)))
    return true;
  if (bytes.size() >= 12 && Starts(bytes, "RIFF"))
    return true;
  if (bytes.size() >= 8 && Starts(bytes.subspan(4), "ftyp"))
    return true;
  return bytes.size() >= 2 && bytes[0] == 0xff && (bytes[1] & 0xe0) == 0xe0;
}
struct FormatEntry {
  std::string_view extension;
  DocumentType type;
  std::string_view media_type;
};

static constexpr FormatEntry formats[] = {
    {".doc", DocumentType::kWriter, "application/msword"},
    {".doc", DocumentType::kWriter, "application/vnd.ms-word"},
    {".dot", DocumentType::kWriter, ""},
    {".wps", DocumentType::kWriter, "application/vnd.ms-works"},
    {".wps", DocumentType::kWriter, "application/wps-office.wps"},
    {".docx", DocumentType::kWriter,
     "application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
    {".docm", DocumentType::kWriter, "application/vnd.ms-word.document.macroenabled.12"},
    {".dotx", DocumentType::kWriter,
     "application/vnd.openxmlformats-officedocument.wordprocessingml.template"},
    {".odt", DocumentType::kWriter, "application/vnd.oasis.opendocument.text"},
    {".ppt", DocumentType::kPresentation, "application/vnd.ms-powerpoint"},
    {".pps", DocumentType::kPresentation, ""},
    {".pot", DocumentType::kPresentation, ""},
    {".dps", DocumentType::kPresentation, "application/wps-office.dps"},
    {".pptx", DocumentType::kPresentation,
     "application/vnd.openxmlformats-officedocument.presentationml.presentation"},
    {".ppsx", DocumentType::kPresentation,
     "application/vnd.openxmlformats-officedocument.presentationml.slideshow"},
    {".potx", DocumentType::kPresentation,
     "application/vnd.openxmlformats-officedocument.presentationml.template"},
    {".odp", DocumentType::kPresentation, "application/vnd.oasis.opendocument.presentation"},
    {".xls", DocumentType::kSpreadsheet, "application/vnd.ms-excel"},
    {".et", DocumentType::kSpreadsheet, "application/wps-office.et"},
    {".xlsx", DocumentType::kSpreadsheet,
     "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
    {".xlsm", DocumentType::kSpreadsheet, "application/vnd.ms-excel.sheet.macroenabled.12"},
    {".ods", DocumentType::kSpreadsheet, "application/vnd.oasis.opendocument.spreadsheet"},
    {".pdf", DocumentType::kPdf, "application/pdf"},
    {".rtf", DocumentType::kWriter, "application/rtf"},
    {".rtf", DocumentType::kWriter, "text/rtf"},
    {".txt", DocumentType::kText, "text/plain"},
    {".csv", DocumentType::kSpreadsheet, "text/csv"},
};

DocumentFormat MediaTypeFormat(std::string_view media_type) {
  auto mime = std::string(media_type.substr(0, media_type.find(';')));
  std::transform(mime.begin(), mime.end(), mime.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  while (!mime.empty() && mime.back() == ' ')
    mime.pop_back();
  for (const auto& entry : formats) {
    if (!entry.media_type.empty() && mime == entry.media_type)
      return {entry.type, std::string(entry.extension)};
  }
  return {};
}

}  // namespace

DocumentFormat DetectDocument(std::string_view name, std::span<const uint8_t> prefix) {
  auto dot = name.find_last_of('.');
  std::string extension(dot == name.npos ? "" : name.substr(dot));
  std::transform(extension.begin(), extension.end(), extension.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  if (Starts(prefix, "%PDF-"))
    return {DocumentType::kPdf, ".pdf"};
  if (Starts(prefix, "{\\rtf"))
    return {DocumentType::kWriter, ".rtf"};
  if (Media(prefix))
    return {};
  if ((extension == ".txt" || extension == ".csv") && !Text(prefix))
    return {};
  for (const auto& entry : formats) {
    if (extension == entry.extension)
      return {entry.type, extension};
  }
  return {};
}

static Result<DocumentFormat> SniffDocumentFile(const std::filesystem::path& path) {
  std::ifstream input(path, std::ios::binary | std::ios::ate);
  if (!input) {
    std::error_code error;
    const bool exists = std::filesystem::exists(path, error);
    return Error{!error && !exists ? ErrorCode::kNotFound : ErrorCode::kUnavailable,
                 "Cannot open source document"};
  }
  const auto size = static_cast<uint64_t>(input.tellg());
  std::vector<uint8_t> prefix(static_cast<size_t>(std::min<uint64_t>(size, 4096)));
  input.seekg(0);
  input.read(reinterpret_cast<char*>(prefix.data()), prefix.size());
  auto format = DetectDocument("", prefix);
  if (format.type != DocumentType::kUnsupported)
    return format;
  if (Starts(prefix, std::string_view("\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", 8)))
    return DocumentFormat{DocumentType::kWriter, ".doc"};
  if (!Starts(prefix, "PK\x03\x04")) {
    if (!prefix.empty() && Text(prefix) && !Media(prefix))
      return DocumentFormat{DocumentType::kText, ".txt"};
    return DocumentFormat{};
  }
  const std::string_view header(reinterpret_cast<const char*>(prefix.data()), prefix.size());
  for (const auto& entry : formats) {
    if ((entry.extension == ".odt" || entry.extension == ".ods" || entry.extension == ".odp") &&
        header.find(entry.media_type) != header.npos)
      return DocumentFormat{entry.type, std::string(entry.extension)};
  }
  std::vector<uint8_t> tail(static_cast<size_t>(std::min<uint64_t>(size, 65557)));
  input.seekg(size - tail.size());
  input.read(reinterpret_cast<char*>(tail.data()), tail.size());
  const auto number = [](const auto& bytes, size_t offset, size_t count) {
    uint64_t value = 0;
    for (size_t i = 0; i < count; ++i)
      value |= uint64_t{bytes[offset + i]} << (i * 8);
    return value;
  };
  if (tail.size() < 22)
    return DocumentFormat{};
  for (size_t end = tail.size() - 22;; --end) {
    if (number(tail, end, 4) == 0x06054b50 && end + 22 + number(tail, end + 20, 2) == tail.size()) {
      auto length = number(tail, end + 12, 4);
      auto offset = number(tail, end + 16, 4);
      if (length == 0xffffffff || offset == 0xffffffff) {
        if (end < 20 || number(tail, end - 20, 4) != 0x07064b50)
          return DocumentFormat{};
        const auto zip64_offset = number(tail, end - 12, 8);
        if (zip64_offset > size || size - zip64_offset < 56)
          return DocumentFormat{};
        std::vector<uint8_t> zip64(56);
        input.seekg(zip64_offset);
        input.read(reinterpret_cast<char*>(zip64.data()), zip64.size());
        if (!input || number(zip64, 0, 4) != 0x06064b50)
          return DocumentFormat{};
        length = number(zip64, 40, 8);
        offset = number(zip64, 48, 8);
      }
      if (length > 64 * 1024 * 1024 || offset > size || length > size - offset)
        return DocumentFormat{};
      std::vector<uint8_t> directory(static_cast<size_t>(length));
      input.seekg(offset);
      input.read(reinterpret_cast<char*>(directory.data()), directory.size());
      if (!input)
        return DocumentFormat{};
      size_t position = 0;
      while (position + 46 <= directory.size() && number(directory, position, 4) == 0x02014b50) {
        const auto name_length = number(directory, position + 28, 2);
        const auto record_length = 46 + name_length + number(directory, position + 30, 2) +
                                   number(directory, position + 32, 2);
        if (record_length > directory.size() - position)
          return DocumentFormat{};
        const std::string_view name(reinterpret_cast<const char*>(directory.data() + position + 46),
                                    static_cast<size_t>(name_length));
        for (auto [entry, extension] :
             {std::pair{"word/document.xml", ".docx"}, std::pair{"xl/workbook.xml", ".xlsx"},
              std::pair{"ppt/presentation.xml", ".pptx"}})
          if (name == entry)
            return DetectDocument(extension, {});
        position += static_cast<size_t>(record_length);
      }
      break;
    }
    if (end == 0)
      break;
  }
  return DocumentFormat{};
}
Result<DocumentFormat> DetectDocumentFile(const std::filesystem::path& path,
                                          std::string_view media_type) {
  return DetectDocumentFile(path, MediaTypeFormat(media_type));
}

Result<DocumentFormat> DetectDocumentFile(const std::filesystem::path& path,
                                          const DocumentFormat& declared) {
  auto sniffed = SniffDocumentFile(path);
  if (!sniffed)
    return sniffed.error();
  if (sniffed.value().type != DocumentType::kUnsupported &&
      sniffed.value().type != DocumentType::kText)
    return sniffed;
  if (declared.type == DocumentType::kUnsupported)
    return sniffed;
  if (sniffed.value().type == DocumentType::kText &&
      (declared.extension == ".txt" || declared.extension == ".csv"))
    return declared;
  return Error{ErrorCode::kRejected, "Declared document format is damaged or incomplete",
               ErrorReason::kDocumentCorrupt};
}
}  // namespace remotekit::documents
