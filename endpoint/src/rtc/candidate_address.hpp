#pragma once
#include "util/error.hpp"
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
namespace remotekit {
// Viewers outside the node's network reach it through a forwarded address the node cannot see on
// its own interfaces. Each local UDP host candidate in the forwarded port range gets a copy that
// names that address; the original stays so Viewers on the same network still connect directly.
std::optional<std::string> AdvertisedCandidate(std::string_view candidate,
                                               std::string_view ip,
                                               uint16_t port_min,
                                               uint16_t port_max);
// Resolves a configured host name to one IP literal; dynamic DNS names are resolved per offer.
Result<std::string> ResolveRtcAddress(const std::string& host);
}  // namespace remotekit
