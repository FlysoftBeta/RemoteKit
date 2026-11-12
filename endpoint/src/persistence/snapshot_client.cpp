#include "persistence/snapshot_client.hpp"
#include "util/result_macros.hpp"

namespace remotekit {
SnapshotClient::SnapshotClient(const std::string& node) {
  pipe_ = CreateFileW(snapshot::PipeName(node).c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                      OPEN_EXISTING, 0, nullptr);
}
SnapshotClient::~SnapshotClient() {
  if (Available())
    CloseHandle(pipe_);
}
Result<Json> SnapshotClient::Request(const Json& request) {
  std::vector<uint8_t> bytes;
  if (!Available() || !snapshot::SendJson(pipe_, request) || !snapshot::Receive(pipe_, bytes)) {
    if (Available())
      CloseHandle(pipe_);
    pipe_ = INVALID_HANDLE_VALUE;
    return Error{ErrorCode::kUnavailable, "snapshot service is unavailable"};
  }
  auto reply = Json::parse(bytes, nullptr, false);
  if (!reply.is_object() || !reply.contains("ok"))
    return Error{ErrorCode::kUnavailable, "invalid snapshot service response"};
  if (!reply.value("ok", false)) {
    const auto& error = reply.at("error");
    Error result{error.value("code", "") == "invalid_request" ? ErrorCode::kInvalidRequest
                                                              : ErrorCode::kUnavailable,
                 error.value("message", "snapshot failed")};
    if (error.contains("os"))
      result.os = OsError{OsError::Kind::kHresult, error["os"].at("value").get<int64_t>()};
    return result;
  }
  return reply.at("result");
}
Result<Json> SnapshotClient::Take(const fs::path& root, const std::vector<std::string>& paths) {
  std::lock_guard lock(mutex_);
  return Request({{"method", "snapshot.take"}, {"root", Utf8(root)}, {"paths", paths}});
}
Result<std::string> SnapshotClient::Read(const std::string& id,
                                         const std::string& path,
                                         uint64_t offset,
                                         uint32_t length) {
  std::lock_guard lock(mutex_);
  if (length > snapshot::kMaxRead)
    return Error{ErrorCode::kInvalidRequest, "snapshot read exceeds 1 MiB"};
  RK_ASSIGN_OR_RETURN(header, Request({{"method", "snapshot.read"},
                                       {"snapshotId", id},
                                       {"path", path},
                                       {"offset", offset},
                                       {"length", length}}));
  std::vector<uint8_t> bytes;
  if (!snapshot::Receive(pipe_, bytes) || bytes.size() != header.at("length")) {
    CloseHandle(pipe_);
    pipe_ = INVALID_HANDLE_VALUE;
    return Error{ErrorCode::kUnavailable, "snapshot data frame is incomplete"};
  }
  return std::string(bytes.begin(), bytes.end());
}
Result<void> SnapshotClient::Release(const std::string& id) {
  std::lock_guard lock(mutex_);
  RK_ASSIGN_OR_RETURN(reply, Request({{"method", "snapshot.release"}, {"snapshotId", id}}));
  return {};
}
}  // namespace remotekit
