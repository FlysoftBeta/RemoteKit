#include "codec.hpp"
#include "codec_streams.hpp"

namespace remotekit::release {
void Diff(const fs::path& payload, const fs::path& output, const fs::path& base) {
  FileInput old_data(base), new_data(payload);
  FileOutput destination(output);
  try {
    CreateDiff(old_data.stream, new_data.stream, destination.stream);
  } catch (const std::exception&) {
    Fail(ErrorCode::kUnavailable, "cannot create release diff");
  }
  destination.Finish();
}
}  // namespace remotekit::release
