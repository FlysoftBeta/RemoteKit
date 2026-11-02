#pragma once

#include <string>
#include <vector>

#include "base/values.h"

namespace remotekit::browser {
struct FileChooserAcceptHints {
  base::ListValue types;
  bool omitted = false;
};
// Selection hints only. Never mutate native chooser identity or selected files.
FileChooserAcceptHints ExportFileChooserAcceptHints(const std::vector<std::u16string>& types);
}  // namespace remotekit::browser
