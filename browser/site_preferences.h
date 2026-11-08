#pragma once

#include <string_view>
#include "base/values.h"
#include "url/gurl.h"

namespace remotekit::browser {
bool ValidSitePermission(std::string_view);
bool ValidProtocolHandler(std::string_view origin, std::string_view protocol, std::string_view url);
bool ValidSitePreferences(const base::DictValue&);
}  // namespace remotekit::browser
