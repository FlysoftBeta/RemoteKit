#include "documents/pdf_renderer.hpp"

namespace remotekit::documents {
PdfRenderer::PdfRenderer(std::filesystem::path tools_directory)
    : tools_(std::filesystem::absolute(tools_directory) / "pdfrender") {}

Result<void> PdfRenderer::Render(const std::filesystem::path& input_pdf,
                                 const std::filesystem::path& output_archive) const {
  try {
    auto share = tools_ / "share/poppler";
    for (const auto* directory : {"nameToUnicode", "cidToUnicode", "unicodeMap", "cMap"}) {
      if (!std::filesystem::is_directory(share / directory))
        return Error{ErrorCode::kUnavailable, "pdfrender share/poppler data missing"};
    }
    auto result = RunTool(tools_ / "pdfrender.exe", {input_pdf.wstring(), output_archive.wstring()},
                          output_archive.parent_path(), {{L"POPPLER_DATADIR", share.wstring()}});
    if (!result)
      return result.error();
    if (!std::filesystem::is_regular_file(output_archive) ||
        std::filesystem::file_size(output_archive) == 0)
      return ToolOutputFailure(output_archive.parent_path() / "tool.log", tools_ / "pdfrender.exe",
                               0);
    return {};
  } catch (const std::filesystem::filesystem_error&) {
    return Error{ErrorCode::kUnavailable, "cannot render PDF"};
  }
}
}  // namespace remotekit::documents
