#pragma once

#include "documents/document_types.hpp"
#include "documents/tool_process.hpp"

#include <array>
#include <mutex>

namespace remotekit::documents {
class OfficeConverter {
 public:
  OfficeConverter(std::filesystem::path data_directory,
                  std::filesystem::path tools_directory = DefaultToolsDirectory());
  Result<void> Convert(const std::filesystem::path& input,
                       const DocumentFormat& format,
                       size_t slot,
                       const std::filesystem::path& output_pdf);

 private:
  std::filesystem::path data_, tools_;
  std::array<std::mutex, 2> slots_;
};
}  // namespace remotekit::documents
