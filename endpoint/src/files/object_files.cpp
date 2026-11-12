#include "files/object_files.hpp"
#include "media/gpu_device.hpp"
#include "util/result_macros.hpp"
namespace remotekit {
using media::QpcFrequency;
using media::QpcNow;
Result<void> ObjectFiles::Start() {
  RK_RETURN_IF_ERROR(store.Open());
  RK_RETURN_IF_ERROR(file_library.Initialize());
  services.Start(
      [this](const FileJob& job) -> Result<Json> {
        RK_RETURN_IF_ERROR(Require(job));
        return Execute(job, Required(job.message, "method"), job.message.at("params"));
      },
      [this] { Sweep(); });
  return {};
}
Result<Json> ObjectFiles::Execute(const FileJob& job,
                                  const std::string& method,
                                  const Json& params) {
  const auto check = [&] { return Require(job); };
  if (method == "document.open")
    return file_library.OpenDocument(Required(params, "assetId"), check);
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
    const auto now = QpcNow();
    const auto cached = photo_thumbnails.find(asset_id);
    if (cached != photo_thumbnails.end()) {
      std::optional<remotekit::FileLibrary::Asset> thumbnail;
      if (now < cached->second.refresh_after) {
        {
          auto described = file_library.Describe(cached->second.asset_id);
          if (described)
            thumbnail = described.value();
          else if (described.error().code != ErrorCode::kNotFound)
            return described.error();
        }
      }
      if (thumbnail) {
        RK_RETURN_IF_ERROR(check());
        return thumbnail->Json();
      }
      photo_thumbnails.erase(cached);
    }
    RK_ASSIGN_OR_RETURN(
        thumbnail,
        file_library.CreateDerivative(
            [&](const fs::path& output) -> Result<remotekit::FileLibrary::Derivative> {
              RK_ASSIGN_OR_RETURN(dimensions,
                                  remotekit::CreatePhotoThumbnail(source, output, cancelled));
              return remotekit::FileLibrary::Derivative{dimensions.width, dimensions.height};
            },
            [&] { return Require(job); }, FileLibrary::DerivativeFormat::jpeg, asset_id));
    RK_RETURN_IF_ERROR(check());
    constexpr size_t kThumbnailCacheEntries = 256;
    if (photo_thumbnails.size() >= kThumbnailCacheEntries) {
      const auto oldest =
          std::min_element(photo_thumbnails.begin(), photo_thumbnails.end(),
                           [](const auto& left, const auto& right) {
                             return left.second.refresh_after < right.second.refresh_after;
                           });
      photo_thumbnails.erase(oldest);
    }
    photo_thumbnails.emplace(asset_id,
                             PhotoThumbnail{thumbnail.id, QpcNow() + QpcFrequency() * 3600});
    return thumbnail.Json();
  }
  if (method == "photo.process") {
    RK_ASSIGN_OR_RETURN(source, file_library.Path(Required(params, "assetId")));
    const auto mode = Required(params, "mode");
    if (mode != "photo" && mode != "scan")
      return Error{ErrorCode::kInvalidRequest, "invalid_photo_mode"};
    std::optional<unsigned> turns;
    if (const auto found = params.find("quarterTurns"); found != params.end()) {
      if ((!found->is_number_integer() && !found->is_number_unsigned()) || *found < 0 || *found > 3)
        return Error{ErrorCode::kInvalidRequest, "invalid_photo_quarter_turns"};
      turns = found->get<unsigned>();
    }
    PhotoProcessResult processed;
    RK_ASSIGN_OR_RETURN(
        derivative, file_library.CreateDerivative(
                        [&](const fs::path& output) -> Result<FileLibrary::Derivative> {
                          RK_ASSIGN_OR_RETURN(
                              dimensions,
                              ProcessPhoto(source, output,
                                           mode == "scan" ? PhotoMode::kScan : PhotoMode::kPhoto,
                                           turns, cancelled));
                          processed = std::move(dimensions);
                          return FileLibrary::Derivative{processed.width, processed.height};
                        },
                        check, FileLibrary::DerivativeFormat::webp, Required(params, "assetId")));
    auto asset = derivative.Json();
    asset["geometry"] = processed.geometry;
    asset["quarterTurns"] = processed.quarter_turns;
    asset["orientation"] = processed.orientation;
    return asset;
  }
#endif
  return Error{ErrorCode::kUnavailable, "photo_processing_unavailable"};
}

void ObjectFiles::Sweep() {
  auto swept = file_library.Sweep();
  if (!swept)
    LogError(LogLevel::kWarn, "files.sweep_failed", swept.error());
#ifdef RK_FILE_PHOTO
  photo_bursts.Sweep([&](uint64_t grant) { return services.CurrentLibraryGrant(grant); });
#endif
}

}  // namespace remotekit
