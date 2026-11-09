#pragma once

#include <cstdint>
#include <span>
#include <string>
#include <string_view>
#include <filesystem>
#include "util/error.hpp"

namespace remotekit::documents {
enum class DocumentType { kUnsupported, kPdf, kText, kWriter, kPresentation, kSpreadsheet };

struct DocumentFormat {
  DocumentType type = DocumentType::kUnsupported;
  std::string extension;
};

// PDF/RTF magic wins over the extension; media magic excludes other viewers'
// formats. Known Office extensions also route corrupt inputs to the converter.
DocumentFormat DetectDocument(std::string_view name, std::span<const uint8_t> prefix);
Result<DocumentFormat> DetectDocumentFile(const std::filesystem::path& path,
                                          std::string_view media_type);
Result<DocumentFormat> DetectDocumentFile(const std::filesystem::path& path,
                                          const DocumentFormat& declared);
}  // namespace remotekit::documents
