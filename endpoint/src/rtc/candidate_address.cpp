#include "rtc/candidate_address.hpp"
#include <winsock2.h>
#include <ws2tcpip.h>
#include <charconv>
#include <vector>
namespace remotekit {
namespace {
std::vector<std::string_view> Fields(std::string_view text) {
  std::vector<std::string_view> fields;
  size_t start = 0;
  while (start < text.size()) {
    const auto end = text.find(' ', start);
    fields.push_back(text.substr(start, end - start));
    if (end == std::string_view::npos)
      break;
    start = end + 1;
  }
  return fields;
}
}  // namespace
std::optional<std::string> AdvertisedCandidate(std::string_view candidate,
                                               std::string_view ip,
                                               uint16_t port_min,
                                               uint16_t port_max) {
  // candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> ...
  const auto fields = Fields(candidate);
  if (fields.size() < 8 || !fields[0].starts_with("candidate:") || fields[2] != "udp" ||
      fields[6] != "typ" || fields[7] != "host" || fields[4] == ip)
    return std::nullopt;
  unsigned port = 0;
  const auto port_text = fields[5];
  if (std::from_chars(port_text.data(), port_text.data() + port_text.size(), port).ptr !=
          port_text.data() + port_text.size() ||
      port < port_min || port > port_max)
    return std::nullopt;
  // A distinct foundation keeps the Viewer from treating both addresses as one candidate base.
  std::string out = "candidate:rk";
  out += fields[0].substr(10);
  for (size_t i = 1; i < fields.size(); ++i) {
    out += ' ';
    out += i == 4 ? ip : fields[i];
  }
  return out;
}
Result<std::string> ResolveRtcAddress(const std::string& host) {
  static const bool initialized = [] {
    WSADATA data;
    return WSAStartup(MAKEWORD(2, 2), &data) == 0;
  }();
  if (!initialized)
    return Error{ErrorCode::kUnavailable, "Winsock unavailable"};
  addrinfo hints{};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_DGRAM;
  addrinfo* found = nullptr;
  if (getaddrinfo(host.c_str(), nullptr, &hints, &found) != 0 || !found)
    return Error{ErrorCode::kUnavailable, "cannot resolve rtc.address " + host};
  std::string ip;
  // Prefer IPv4: the forwarded address is normally a router's public IPv4 address.
  for (int family : {AF_INET, AF_INET6}) {
    for (auto* entry = found; entry && ip.empty(); entry = entry->ai_next) {
      if (entry->ai_family != family)
        continue;
      char text[INET6_ADDRSTRLEN]{};
      const void* address =
          family == AF_INET
              ? static_cast<const void*>(&reinterpret_cast<sockaddr_in*>(entry->ai_addr)->sin_addr)
              : &reinterpret_cast<sockaddr_in6*>(entry->ai_addr)->sin6_addr;
      if (inet_ntop(family, address, text, sizeof(text)))
        ip = text;
    }
  }
  freeaddrinfo(found);
  if (ip.empty())
    return Error{ErrorCode::kUnavailable, "rtc.address has no IP address"};
  return ip;
}
}  // namespace remotekit
