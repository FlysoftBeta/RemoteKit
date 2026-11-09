#include "documents/office_converter.hpp"

#include <fstream>

namespace remotekit::documents {
OfficeConverter::OfficeConverter(std::filesystem::path data_directory,
                                 std::filesystem::path tools_directory)
    : data_(std::filesystem::absolute(data_directory) / "documents"),
      tools_(std::filesystem::absolute(tools_directory)) {}

Result<void> OfficeConverter::Convert(const std::filesystem::path& input,
                                      const DocumentFormat& format,
                                      size_t slot,
                                      const std::filesystem::path& output_pdf) {
  const auto detected = DetectDocument("input" + format.extension, {});
  if (slot >= slots_.size() || format.type == DocumentType::kUnsupported ||
      format.type == DocumentType::kPdf || detected.type != format.type ||
      detected.extension != format.extension)
    return Error{ErrorCode::kRejected, "Unsupported Office document",
                 ErrorReason::kDocumentUnsupported};
  std::lock_guard lock(slots_[slot]);
  try {
    TemporaryDirectory temporary(data_ / "work");
    auto profile = data_ / "profiles" / ("slot-" + std::to_string(slot));
    std::filesystem::create_directories(profile);
    auto source = temporary.path() / ("input" + format.extension);
    std::filesystem::copy_file(input, source);
    std::wstring filter = L"pdf";
    // Calc's CLI PDF filter exposes SinglePageSheets, which also collapses all
    // rows onto one page. It has no columns-only fit option; retain pagination.
    auto converted =
        RunTool(tools_ / "libreoffice/program/soffice.com",
                {L"-env:UserInstallation=" + FileUrl(profile), L"--headless", L"--norestore",
                 L"--nolockcheck", L"--nodefault", L"--nologo", L"--convert-to", filter,
                 L"--outdir", temporary.path().wstring(), source.wstring()},
                temporary.path());
    if (!converted)
      return converted.error();
    auto pdf = temporary.path() / "input.pdf";
    std::ifstream file(pdf, std::ios::binary);
    char magic[5]{};
    file.read(magic, sizeof(magic));
    if (!file)
      return Error{ErrorCode::kUnavailable, "Cannot read converted PDF"};
    if (std::string_view(magic, sizeof(magic)) != "%PDF-")
      return ToolOutputFailure(temporary.path() / "tool.log",
                               tools_ / "libreoffice/program/soffice.com", 0);
    file.close();
    std::filesystem::copy_file(pdf, output_pdf);
    return {};
  } catch (const std::filesystem::filesystem_error&) {
    return Error{ErrorCode::kUnavailable, "cannot stage Office document"};
  }
}
}  // namespace remotekit::documents
