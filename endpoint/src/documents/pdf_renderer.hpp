#pragma once

#include "documents/tool_process.hpp"

namespace remotekit::documents {
class PdfRenderer {
 public:
  explicit PdfRenderer(std::filesystem::path tools_directory = DefaultToolsDirectory());
  // The caller supplies a private work directory containing input_pdf. The
  // archive must not already exist. Both paths are absolute.
  Result<void> Render(const std::filesystem::path& input_pdf,
                      const std::filesystem::path& output_archive) const;

 private:
  std::filesystem::path tools_;
};
}  // namespace remotekit::documents
