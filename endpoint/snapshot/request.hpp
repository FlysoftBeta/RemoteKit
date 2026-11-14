#pragma once
#include "../release/common.hpp"
#include "persistence/snapshot_protocol.hpp"

namespace remotekit::snapshot {
inline uint32_t ReadLength(const Json& value) {
  const auto length = release::Unsigned(value);
  release::Require(length <= kMaxRead, "snapshot read is too large");
  return static_cast<uint32_t>(length);
}
inline void ValidateRequest(const Json& request) {
  release::Require(
      request.is_object() && request.contains("method") && request.at("method").is_string(),
      "invalid snapshot request");
  const auto method = request.at("method").get<std::string>();
  if (method == "snapshot.take") {
    release::Keys(request, {"method", "root", "paths"});
    release::Require(request.at("root").is_string() && request.at("paths").is_array(),
                     "invalid snapshot take");
  } else if (method == "snapshot.release") {
    release::Keys(request, {"method", "snapshotId"});
  } else if (method == "snapshot.read") {
    release::Keys(request, {"method", "snapshotId", "path", "offset", "length"});
    release::Require(request.at("path").is_string(), "invalid snapshot path");
    release::Unsigned(request.at("offset"));
    ReadLength(request.at("length"));
  } else {
    release::Fail(ErrorCode::kInvalidRequest, "unknown snapshot method");
  }
  if (method != "snapshot.take")
    release::Require(request.at("snapshotId").is_string(), "invalid snapshot identity");
}
inline Json DecodeRequest(std::string_view text) {
  auto request = release::ParseJson(text);
  ValidateRequest(request);
  return request;
}
template <class Table, class Lease>
void PublishLease(Table& leases, const std::string& id, Lease lease) {
  lease.renewed = std::chrono::steady_clock::now();
  leases.emplace(id, std::move(lease));
}
}  // namespace remotekit::snapshot
