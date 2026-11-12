#pragma once
#include "util/common.hpp"
#include "util/error.hpp"
namespace remotekit {
Result<void> ValidateSitePreferences(const Json& value);
}
