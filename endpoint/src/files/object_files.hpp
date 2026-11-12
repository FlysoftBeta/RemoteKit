#pragma once
#include "files/dc_file_services.hpp"
#include "files/file_library.hpp"
#include "rtc/event.hpp"

namespace remotekit {
class ObjectFiles {
 public:
  ObjectFiles(fs::path root, objects::ObjectService& objects, const std::string& tenant)
      : store(root),
        file_library(root / "files", objects, tenant, store.Library()),
        services({{"tenantId", tenant}}) {}
  ~ObjectFiles() { services.Stop(); }
  Result<void> Start();
  void Bind(uint64_t peer, const std::string& connection = {}) { services.Bind(peer, connection); }
  Result<void> Authorize(const std::string& connection) {
    return services.Authorize(connection, 0, {}, true);
  }
  Result<Json> Describe(const std::string& id) {
    auto asset = file_library.Describe(id);
    if (!asset)
      return asset.error();
    return asset.value().Json();
  }
  void Admit(const RtcEvent& event) {
    if (LibraryFileMethod(event.message.value("method", std::string())) &&
        FileRequestEnvelope(event.message, event.bytes.size()))
      services.Admit(event.peer, event.message);
  }
  void Flush(uint64_t peer, const std::function<int(const std::string&)>& send) {
    services.Flush(peer, send);
  }

 private:
  using FileJob = DcFileServices::Job;
  Result<void> Require(const FileJob& job) {
    if (!services.Current(job))
      return Error{ErrorCode::kConflict, "file_transfer_interrupted"};
    return {};
  }
  static uint64_t FileUnsigned(const Json& value) {
    if ((!value.is_number_unsigned() && !value.is_number_integer()) || value < 0)
      throw InvalidRequest("invalid_file_integer");
    return value.get<uint64_t>();
  }
  Result<Json> Execute(const FileJob&, const std::string&, const Json&);
  Result<Json> Photo(const FileJob&, const std::string&, const Json&);
  void Sweep();
  SessionDb store;
  FileLibrary file_library;
  DcFileServices services;
#ifdef RK_FILE_PHOTO
  PhotoBurstSessions<PhotoBurstAnalyzer> photo_bursts;
  struct PhotoThumbnail {
    std::string asset_id;
    int64_t refresh_after;
  };
  std::map<std::string, PhotoThumbnail> photo_thumbnails;
#endif
};
}  // namespace remotekit
