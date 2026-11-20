#include "files/object_files.hpp"
#include "protocol/file_requests.h"
#include "util/result_macros.hpp"
namespace remotekit {
Result<void> ObjectFiles::Start() {
  RK_RETURN_IF_ERROR(store.Open());
  RK_RETURN_IF_ERROR(file_library.Initialize());
  services.Start(
      [this](const FileJob& job) -> Result<Json> {
        RK_RETURN_IF_ERROR(Require(job));
        return Execute(job, Required(job.message, "method"), job.message.at("params"));
      },
      [this] { return Sweep(); });
  return {};
}
Result<Json> ObjectFiles::Execute(const FileJob& job,
                                  const std::string& method,
                                  const Json& params) {
  const auto check = [&] { return Require(job); };
  if (method == "document.open") {
    if (!protocol::ValidDocumentOpenParams(params))
      return Error{ErrorCode::kInvalidRequest, "invalid_document_open"};
    return file_library.OpenDocument(Required(params, "assetId"),
                                     params.at("type").get<std::string>(), check);
  }
  if (method == "document.resource")
    return file_library.DocumentResource(Required(params, "documentId"),
                                         Required(params, "contentId"),
                                         FileUnsigned(params.at("offset")), check);
  if (method == "asset.begin")
    return file_library.Begin(job.grant, Required(params, "operationId"),
                              {Required(params, "name"), params.value("type", std::string()),
                               FileUnsigned(params.at("size"))},
                              check);
  if (method == "asset.chunk") {
    RK_ASSIGN_OR_RETURN(bytes, DecodeFileChunk(params.at("data")));
    RK_ASSIGN_OR_RETURN(offset,
                        file_library.Chunk(job.grant, Required(params, "uploadId"),
                                           FileUnsigned(params.at("offset")), bytes, check));
    return Json{{"offset", offset}};
  }
  if (method == "asset.seal") {
    RK_ASSIGN_OR_RETURN(asset, file_library.Seal(job.grant, Required(params, "uploadId"), check));
    return asset.Json();
  }
  if (method == "asset.cancel") {
    RK_RETURN_IF_ERROR(file_library.Cancel(job.grant, Required(params, "uploadId"), check));
    return Json{{"cancelled", true}};
  }
  if (method == "asset.describe") {
    RK_ASSIGN_OR_RETURN(asset, file_library.Describe(Required(params, "assetId")));
    RK_RETURN_IF_ERROR(check());
    return asset.Json();
  }
  if (method == "asset.read") {
    const auto offset = FileUnsigned(params.at("offset"));
    RK_ASSIGN_OR_RETURN(read, file_library.Read(Required(params, "assetId"), offset));
    const auto& [asset, bytes] = read;
    RK_RETURN_IF_ERROR(check());
    return Json{{"data", remotekit::EncodeFileChunk(bytes)},
                {"offset", offset + bytes.size()},
                {"total", asset.size}};
  }
  return Photo(job, method, params);
}

Result<Json> ObjectFiles::Photo(const FileJob& job, const std::string& method, const Json& params) {
  const auto check = [&] { return Require(job); };
#ifdef RK_FILE_PHOTO
  const auto cancelled = [&] { return !services.Current(job); };
  if (remotekit::PhotoBurstMethod(method))
    return photo_bursts.Execute(job.grant, method, params, cancelled);
  if (method == "photo.thumbnail") {
    const auto asset_id = Required(params, "assetId");
    RK_ASSIGN_OR_RETURN(source, file_library.Path(asset_id));
    RK_ASSIGN_OR_RETURN(thumbnail,
                        file_library.CachedDerivative(
                            asset_id, FileLibrary::DerivativeFormat::jpeg,
                            [&](const fs::path& output) -> Result<FileLibrary::Derivative> {
                              RK_ASSIGN_OR_RETURN(dimensions,
                                                  CreatePhotoThumbnail(source, output, cancelled));
                              return FileLibrary::Derivative{dimensions.width, dimensions.height};
                            },
                            check, "thumbnail", "320-v1"));
    RK_RETURN_IF_ERROR(check());
    return thumbnail.Json();
  }
  if (method == "photo.preview") {
    if (!protocol::ValidPhotoPreviewParams(params))
      return Error{ErrorCode::kRejected, "invalid_photo_preview"};
    return file_library.Preview(Required(params, "assetId"), params.at("maxSide").get<unsigned>(),
                                check);
  }
  if (method == "photo.process") {
    const auto mode = Required(params, "mode");
    if (mode != "photo" && mode != "scan")
      return Error{ErrorCode::kInvalidRequest, "invalid_photo_mode"};
    std::optional<unsigned> turns;
    if (const auto found = params.find("quarterTurns"); found != params.end()) {
      if ((!found->is_number_integer() && !found->is_number_unsigned()) || *found < 0 || *found > 3)
        return Error{ErrorCode::kInvalidRequest, "invalid_photo_quarter_turns"};
      turns = found->get<unsigned>();
    }
    return file_library.Process(Required(params, "assetId"), mode, turns, check);
  }
#endif
  return Error{ErrorCode::kUnavailable, "photo_processing_unavailable"};
}

Result<void> ObjectFiles::Sweep() {
  RK_RETURN_IF_ERROR(file_library.Sweep());
#ifdef RK_FILE_PHOTO
  photo_bursts.Sweep([&](uint64_t grant) { return services.CurrentLibraryGrant(grant); });
#endif
  return {};
}

}  // namespace remotekit
