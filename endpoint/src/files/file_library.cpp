#include "util/log.hpp"
#include "files/file_library.hpp"
#include "files/library_records.hpp"
#include "files/file_selection.hpp"
#include "documents/object_documents.hpp"
#include "files/dc_file_services.hpp"
#include "persistence/durable_json.hpp"
#include "util/file_io.hpp"

#include <windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <charconv>
#include <fstream>
#include <iostream>
#include <limits>
#include <span>
#include <cstring>
#ifdef RK_FILE_PHOTO
#include <webp/decode.h>
#include <webp/encode.h>
#include <wincodec.h>
#include <wrl/client.h>
#endif
#include "util/result_macros.hpp"
#include "util/file_io.hpp"

namespace remotekit {
ServiceJson FileLibrary::StopBlockers(const std::function<bool(uint64_t)>& current) const {
  std::lock_guard lock(mutex_);
  const auto selections =
      std::count_if(selections_.begin(), selections_.end(), [](const auto& item) {
        return item.second.state == Selection::State::pending ||
               item.second.state == Selection::State::dispatching ||
               item.second.state == Selection::State::unknown;
      });
  const auto uploads = std::count_if(drafts_.begin(), drafts_.end(), [&](const auto& item) {
    return item.second.sealed.empty() && current(item.second.grant);
  });
  return {{"pendingNativeSelections", selections}, {"inFlightUploads", uploads}};
}
namespace {
namespace fs = std::filesystem;
using Json = ServiceJson;
using State = FileLibrary::Selection::State;
using namespace library_records;
constexpr std::uint64_t kMiB = 1024 * 1024;

constexpr std::uint64_t kStagingBytes = 512 * kMiB;
constexpr std::uint64_t kDraftBytes = 512 * kMiB;
constexpr std::uint64_t kJpegDerivativeBytes = 24 * kMiB;
constexpr std::uint64_t kPngDerivativeBytes = 64 * kMiB;
constexpr std::size_t kAssets = kLibraryAssetLimit;
constexpr std::size_t kDrafts = 1024;
constexpr std::size_t kActiveDrafts = 32;
constexpr std::size_t kSelections = 65536;
constexpr std::int64_t kDraftLifetime = 30 * 60;
constexpr std::size_t kChunk = 16384;

std::int64_t Now() {
  return std::chrono::duration_cast<std::chrono::seconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}
std::string Hex(std::span<const unsigned char> bytes) {
  constexpr char digits[] = "0123456789abcdef";
  std::string result;
  result.reserve(bytes.size() * 2);
  for (auto byte : bytes) {
    result += digits[byte >> 4];
    result += digits[byte & 15];
  }
  return result;
}
Result<std::string> RandomId() {
  std::array<unsigned char, 16> bytes{};
  if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()),
                      BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
    return Error{ErrorCode::kUnavailable, "file_random_failed"};
  return Hex(bytes);
}
bool Plain(const fs::path& path, bool directory = false) {
  const auto attributes = GetFileAttributesW(path.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
         bool(attributes & FILE_ATTRIBUTE_DIRECTORY) == directory;
}
Result<void> Verify(const fs::path& path, std::uint64_t size) {
  RK_ASSIGN_OR_RETURN(actual_size, FileSize(path));
  if (!Plain(path) || actual_size != size)
    return Error{ErrorCode::kUnavailable, "asset_unavailable"};

  return {};
}
bool Remove(const fs::path& path) {
  std::error_code error;
  fs::remove(path, error);
  return !error;
}

#ifdef RK_FILE_PHOTO
using Microsoft::WRL::ComPtr;
Result<void> PreviewImaging(HRESULT result) {
  if (FAILED(result))
    return WithOsError(ErrorCode::kRejected, "invalid_photo_preview", OsError::Kind::kHresult,
                       result);
  return {};
}
unsigned PreviewExif(std::span<const uint8_t> tiff) {
  if (tiff.size() >= 6 && std::memcmp(tiff.data(), "Exif\0\0", 6) == 0)
    tiff = tiff.subspan(6);
  if (tiff.size() < 8)
    return 1;
  const bool little = tiff[0] == 'I' && tiff[1] == 'I';
  if (!little && !(tiff[0] == 'M' && tiff[1] == 'M'))
    return 1;
  const auto number = [&](size_t offset, size_t count) {
    uint32_t value = 0;
    for (size_t i = 0; i < count; ++i)
      value = value * 256 + tiff[offset + (little ? count - i - 1 : i)];
    return value;
  };
  if (number(2, 2) != 42)
    return 1;
  const auto offset = number(4, 4);
  if (offset > tiff.size() - 2)
    return 1;
  const auto count = number(offset, 2);
  if (count > (tiff.size() - offset - 2) / 12)
    return 1;
  for (size_t i = 0; i < count; ++i) {
    const auto entry = offset + 2 + i * 12;
    if (number(entry, 2) == 274 && number(entry + 2, 2) == 3 && number(entry + 4, 4) == 1) {
      const auto orientation = number(entry + 8, 2);
      return orientation >= 1 && orientation <= 8 ? orientation : 1;
    }
  }
  return 1;
}
class PreviewImage {
 public:
  ~PreviewImage() {
    frame_.Reset();
    decoder_.Reset();
    factory_.Reset();
    if (initialized_)
      CoUninitialize();
  }
  Result<void> Open(const fs::path& path) {
    RK_ASSIGN_OR_RETURN(size, FileSize(path));
    if (!size || size > 64 * kMiB)
      return Error{ErrorCode::kLimitExceeded, "photo_preview_input_too_large"};
    bytes_.resize(static_cast<size_t>(size));
    std::ifstream input(path, std::ios::binary);
    input.read(reinterpret_cast<char*>(bytes_.data()), bytes_.size());
    if (!input)
      return Error{ErrorCode::kUnavailable, "photo_preview_read_failed"};
    const auto initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (initialized != RPC_E_CHANGED_MODE)
      RK_RETURN_IF_ERROR(PreviewImaging(initialized));
    initialized_ = SUCCEEDED(initialized);
    RK_RETURN_IF_ERROR(PreviewImaging(CoCreateInstance(
        CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory_))));
    webp_ = bytes_.size() >= 12 && std::memcmp(bytes_.data(), "RIFF", 4) == 0 &&
            std::memcmp(bytes_.data() + 8, "WEBP", 4) == 0;
    if (webp_) {
      WebPBitstreamFeatures features{};
      if (WebPGetFeatures(bytes_.data(), bytes_.size(), &features) != VP8_STATUS_OK ||
          features.has_animation)
        return Error{ErrorCode::kRejected, "invalid_photo_preview"};
      width_ = features.width;
      height_ = features.height;
      type = "image/webp";
      for (size_t offset = 12; offset <= bytes_.size() && bytes_.size() - offset >= 8;) {
        const uint64_t length = uint64_t(bytes_[offset + 4]) | (uint64_t(bytes_[offset + 5]) << 8) |
                                (uint64_t(bytes_[offset + 6]) << 16) |
                                (uint64_t(bytes_[offset + 7]) << 24);
        if (length > bytes_.size() - offset - 8)
          return Error{ErrorCode::kRejected, "invalid_photo_preview"};
        if (std::memcmp(bytes_.data() + offset, "EXIF", 4) == 0)
          orientation_ = PreviewExif(std::span(bytes_).subspan(offset + 8, length));
        offset += 8 + length + (length & 1);
      }
    } else {
      RK_RETURN_IF_ERROR(PreviewImaging(factory_->CreateDecoderFromFilename(
          path.c_str(), nullptr, GENERIC_READ, WICDecodeMetadataCacheOnDemand, &decoder_)));
      GUID format{};
      RK_RETURN_IF_ERROR(PreviewImaging(decoder_->GetContainerFormat(&format)));
      if (format != GUID_ContainerFormatJpeg && format != GUID_ContainerFormatPng)
        return Error{ErrorCode::kRejected, "invalid_photo_preview"};
      type = format == GUID_ContainerFormatJpeg ? "image/jpeg" : "image/png";
      RK_RETURN_IF_ERROR(PreviewImaging(decoder_->GetFrame(0, &frame_)));
      RK_RETURN_IF_ERROR(PreviewImaging(frame_->GetSize(&width_, &height_)));
      ComPtr<IWICMetadataQueryReader> metadata;
      if (SUCCEEDED(frame_->GetMetadataQueryReader(&metadata))) {
        PROPVARIANT value{};
        if (SUCCEEDED(metadata->GetMetadataByName(L"/app1/ifd/{ushort=274}", &value)) &&
            value.vt == VT_UI2 && value.uiVal >= 1 && value.uiVal <= 8)
          orientation_ = value.uiVal;
        PropVariantClear(&value);
      }
      if (type == "image/png") {
        for (size_t offset = 8; offset <= bytes_.size() && bytes_.size() - offset >= 12;) {
          uint64_t length = 0;
          for (size_t i = 0; i < 4; ++i)
            length = length * 256 + bytes_[offset + i];
          if (length > bytes_.size() - offset - 12)
            return Error{ErrorCode::kRejected, "invalid_photo_preview"};
          if (std::memcmp(bytes_.data() + offset + 4, "eXIf", 4) == 0)
            orientation_ = PreviewExif(std::span(bytes_).subspan(offset + 8, length));
          offset += length + 12;
        }
      }
    }
    if (!width_ || !height_ || width_ > 16384 || height_ > 16384 ||
        uint64_t(width_) * height_ > 32 * 1024 * 1024)
      return Error{ErrorCode::kLimitExceeded, "photo_preview_input_too_large"};
    width = orientation_ >= 5 ? height_ : width_;
    height = orientation_ >= 5 ? width_ : height_;
    return {};
  }
  Result<FileLibrary::Derivative> Write(const fs::path& output,
                                        unsigned max_side,
                                        const FileLibrary::Check& check) {
    RK_RETURN_IF_ERROR(check());
    const UINT longest = std::max(width_, height_);
    const UINT target_width = std::max(1u, width_ * max_side / longest);
    const UINT target_height = std::max(1u, height_ * max_side / longest);
    std::vector<uint8_t> pixels(size_t(target_width) * target_height * 4);
    if (webp_) {
      WebPDecoderConfig config{};
      if (!WebPInitDecoderConfig(&config))
        return Error{ErrorCode::kUnavailable, "photo_preview_decoder_failed"};
      config.options.use_scaling = 1;
      config.options.scaled_width = target_width;
      config.options.scaled_height = target_height;
      config.output.colorspace = MODE_BGRA;
      config.output.is_external_memory = 1;
      config.output.u.RGBA.rgba = pixels.data();
      config.output.u.RGBA.stride = target_width * 4;
      config.output.u.RGBA.size = pixels.size();
      const auto status = WebPDecode(bytes_.data(), bytes_.size(), &config);
      WebPFreeDecBuffer(&config.output);
      if (status != VP8_STATUS_OK)
        return Error{ErrorCode::kRejected, "invalid_photo_preview"};
    } else {
      ComPtr<IWICBitmapScaler> scaler;
      ComPtr<IWICFormatConverter> converter;
      RK_RETURN_IF_ERROR(PreviewImaging(factory_->CreateBitmapScaler(&scaler)));
      RK_RETURN_IF_ERROR(PreviewImaging(scaler->Initialize(
          frame_.Get(), target_width, target_height, WICBitmapInterpolationModeFant)));
      RK_RETURN_IF_ERROR(PreviewImaging(factory_->CreateFormatConverter(&converter)));
      RK_RETURN_IF_ERROR(PreviewImaging(
          converter->Initialize(scaler.Get(), GUID_WICPixelFormat32bppBGRA, WICBitmapDitherTypeNone,
                                nullptr, 0, WICBitmapPaletteTypeCustom)));
      RK_RETURN_IF_ERROR(PreviewImaging(converter->CopyPixels(
          nullptr, target_width * 4, static_cast<UINT>(pixels.size()), pixels.data())));
    }
    RK_RETURN_IF_ERROR(check());
    const UINT oriented_width = orientation_ >= 5 ? target_height : target_width;
    const UINT oriented_height = orientation_ >= 5 ? target_width : target_height;
    std::vector<uint8_t> oriented(pixels.size());
    constexpr WICBitmapTransformOptions transforms[] = {
        WICBitmapTransformRotate0,
        WICBitmapTransformRotate0,
        WICBitmapTransformFlipHorizontal,
        WICBitmapTransformRotate180,
        WICBitmapTransformFlipVertical,
        static_cast<WICBitmapTransformOptions>(WICBitmapTransformRotate90 |
                                               WICBitmapTransformFlipHorizontal),
        WICBitmapTransformRotate90,
        static_cast<WICBitmapTransformOptions>(WICBitmapTransformRotate270 |
                                               WICBitmapTransformFlipHorizontal),
        WICBitmapTransformRotate270};
    ComPtr<IWICBitmap> bitmap;
    ComPtr<IWICBitmapFlipRotator> rotator;
    RK_RETURN_IF_ERROR(PreviewImaging(factory_->CreateBitmapFromMemory(
        target_width, target_height, GUID_WICPixelFormat32bppBGRA, target_width * 4,
        static_cast<UINT>(pixels.size()), pixels.data(), &bitmap)));
    RK_RETURN_IF_ERROR(PreviewImaging(factory_->CreateBitmapFlipRotator(&rotator)));
    RK_RETURN_IF_ERROR(PreviewImaging(rotator->Initialize(bitmap.Get(), transforms[orientation_])));
    RK_RETURN_IF_ERROR(PreviewImaging(rotator->CopyPixels(
        nullptr, oriented_width * 4, static_cast<UINT>(oriented.size()), oriented.data())));
    uint8_t* encoded = nullptr;
    const auto size = WebPEncodeBGRA(oriented.data(), oriented_width, oriented_height,
                                     oriented_width * 4, 80, &encoded);
    std::unique_ptr<uint8_t, decltype(&WebPFree)> encoded_owner(encoded, WebPFree);
    if (!size)
      return Error{ErrorCode::kUnavailable, "photo_preview_encode_failed"};
    RK_RETURN_IF_ERROR(check());
    std::ofstream stream(output, std::ios::binary);
    stream.write(reinterpret_cast<const char*>(encoded), size);
    stream.close();
    if (!stream)
      return Error{ErrorCode::kUnavailable, "photo_output_failed"};
    return FileLibrary::Derivative{oriented_width, oriented_height};
  }
  UINT width{}, height{};
  std::string type;

 private:
  bool initialized_ = false, webp_ = false;
  UINT width_{}, height_{};
  unsigned orientation_ = 1;
  std::vector<uint8_t> bytes_;
  ComPtr<IWICImagingFactory> factory_;
  ComPtr<IWICBitmapDecoder> decoder_;
  ComPtr<IWICBitmapFrameDecode> frame_;
};
#endif
}  // namespace

ServiceJson FileLibrary::Asset::Json() const {
  ServiceJson result = {{"assetId", id}, {"size", size}};
  if (type)
    result["type"] = *type;
  if (width && height) {
    result["width"] = width;
    result["height"] = height;
  }
  return result;
}

FileLibrary::FileLibrary(fs::path root,
                         objects::ObjectService& objects,
                         std::string tenant,
                         LibraryStore store,
                         std::shared_ptr<objects::SessionObjects> access)
    : root_(std::move(root)),
      store_(store),
      objects_(objects),
      tenant_(std::move(tenant)),
      access_(access ? std::move(access)
                     : std::make_shared<objects::SessionObjects>(objects, tenant_)),
      remove_file_(RemoveFile) {}
Result<void> FileLibrary::Initialize() {
  std::error_code absolute_error;
  root_ = fs::absolute(root_, absolute_error).make_preferred();
  if (absolute_error)
    return Error{ErrorCode::kUnavailable, "library path unavailable"};
  const auto native = root_.native();
  if (!native.starts_with(LR"(\\?\)"))
    root_ = native.starts_with(LR"(\\)") ? fs::path(LR"(\\?\UNC\)" + native.substr(2))
                                         : fs::path(LR"(\\?\)" + native);
  for (const auto& directory : {root_, root_ / "staging", root_ / "incoming"}) {
    RK_RETURN_IF_ERROR(CreateDirectories(directory));
    if (!Plain(directory, true))
      return Error{ErrorCode::kUnavailable, "unsafe_library_root"};
  }
  RK_ASSIGN_OR_RETURN(assets, store_.Load(LibraryTable::kAssets));
  for (const auto& [id, value] : assets) {
    entries_.emplace(
        id, Entry{Asset{id,
                        value.contains("type") ? std::optional(value.at("type").get<std::string>())
                                               : std::nullopt,
                        value.at("size").get<uint64_t>(),
                        value.contains("width") ? value.at("width").get<unsigned>() : 0u,
                        value.contains("height") ? value.at("height").get<unsigned>() : 0u}});
  }
  RK_ASSIGN_OR_RETURN(drafts, store_.Load(LibraryTable::kDrafts));
  if (drafts.size() > kDrafts)
    return CorruptState("library draft limit");
  for (const auto& [id, value] : drafts) {
    Draft draft{id,
                value.at("operation").get<std::string>(),
                value.at("sealed").get<std::string>(),
                {value.at("name").get<std::string>(), value.at("type").get<std::string>(),
                 value.at("size").get<uint64_t>()},
                value.at("expires").get<int64_t>()};
    if (draft.sealed.empty()) {
      RK_ASSIGN_OR_RETURN(exists, FileExists(DraftData(id)));
      if (!exists)
        return CorruptState("missing asset draft payload");
      RK_ASSIGN_OR_RETURN(size, FileSize(DraftData(id)));
      if (!Plain(DraftData(id)) || size > draft.spec.size ||
          draft.spec.size > kDraftBytes - draft_bytes_)
        return CorruptState("invalid asset draft payload");
      draft_bytes_ += draft.spec.size;
    }
    drafts_.emplace(id, std::move(draft));
  }
  RK_ASSIGN_OR_RETURN(selections, store_.Load(LibraryTable::kSelections));
  if (selections.size() > kSelections)
    return CorruptState("library selection limit");
  for (const auto& [id, value] : selections) {
    RK_ASSIGN_OR_RETURN(selection, ParseSelection(id, value));
    selections_.emplace(id, std::move(selection));
  }
  const auto clean = [&](const fs::path& directory, std::size_t maximum,
                         auto keep) -> Result<void> {
    std::size_t count = 0;
    RK_ASSIGN_OR_RETURN(entries, DirectoryEntries(directory));
    for (const auto& entry : entries) {
      if (++count > maximum)
        return CorruptState("invalid_library_payload");
      if (!Plain(entry.path()) && directory == root_ / "staging") {
        LogEvent(LogLevel::kWarn, "library.staging_discarded", {{"path", entry.path().string()}});
        RK_RETURN_IF_ERROR(RemoveTree(entry.path()));
        continue;
      }
      if (!Plain(entry.path()))
        return CorruptState("invalid_library_payload");
      if (!keep(entry.path().filename().string()) && !Remove(entry.path()))
        return Error{ErrorCode::kUnavailable, "cannot_clean_library_payload"};
    }
    return {};
  };
  RK_RETURN_IF_ERROR(clean(root_ / "staging", kAssets + 1, [](const auto&) { return false; }));
  RK_RETURN_IF_ERROR(clean(root_ / "incoming", kDrafts + 1, [&](const auto& id) {
    const auto found = drafts_.find(id);
    return found != drafts_.end() && found->second.sealed.empty();
  }));
  RK_RETURN_IF_ERROR(Sweep());

  return {};
}
Result<void> FileLibrary::PrepareCheckpoint() {
  std::lock_guard lock(mutex_);
  RK_RETURN_IF_ERROR(store_.ClearDrafts());
  for (const auto& [id, draft] : drafts_)
    retiring_drafts_[id] = draft.sealed.empty() ? draft.spec.size : 0;
  drafts_.clear();
  RK_RETURN_IF_ERROR(RemoveTree(root_ / "incoming"));
  retiring_drafts_.clear();
  draft_bytes_ = 0;
  return {};
}
fs::path FileLibrary::DraftData(const std::string& id) const {
  return root_ / "incoming" / id;
}
Result<const FileLibrary::Entry*> FileLibrary::RequireAsset(const std::string& id) const {
  auto found = entries_.find(id);
  RK_ASSIGN_OR_RETURN(info, access_->Ensure(id));
  if (found != entries_.end() && found->second.asset.size != info.size) {
    return CorruptRecord("library asset size does not match its object");
  }
  if (found == entries_.end()) {
    if (info.size > kFileBytes)
      return Error{ErrorCode::kLimitExceeded, "asset_too_large", ErrorReason::kFileTooLarge};
    Entry entry{Asset{id, std::nullopt, info.size}};
    RK_RETURN_IF_ERROR(SaveEntry(entry));
    found = entries_.emplace(id, std::move(entry)).first;
  }
  return &found->second;
}
Result<FileLibrary::Draft*> FileLibrary::RequireDraft(std::uint64_t grant, const std::string& id) {
  const auto found = drafts_.find(id);
  if (!grant || found == drafts_.end() || found->second.grant != grant)
    return Error{ErrorCode::kNotFound, "unknown_asset_upload"};
  return &found->second;
}
Result<void> FileLibrary::SaveDraft(const Draft& draft, const Check& check) const {
  if (check) {
    RK_RETURN_IF_ERROR(check());
  }
  RK_RETURN_IF_ERROR(store_.Save(LibraryTable::kDrafts, draft.id,
                                 {{"operation", draft.operation},
                                  {"name", draft.spec.name},
                                  {"type", draft.spec.type},
                                  {"size", draft.spec.size},
                                  {"expires", draft.expires},
                                  {"sealed", draft.sealed}}));

  return {};
}
Result<void> FileLibrary::SaveEntry(const Entry& entry, const Check& check) const {
  if (check) {
    RK_RETURN_IF_ERROR(check());
  }
  auto value = entry.asset.Json();
  RK_RETURN_IF_ERROR(store_.Save(LibraryTable::kAssets, entry.asset.id, value));

  return {};
}
Result<void> FileLibrary::SaveSelection(const Selection& selection, const Check& check) const {
  if (check) {
    RK_RETURN_IF_ERROR(check());
  }
  const auto& binding = selection.binding;
  Json files = Json::array();
  for (const auto& file : selection.files)
    files.push_back({{"assetId", file.asset_id}, {"name", file.name}, {"type", file.type}});
  RK_RETURN_IF_ERROR(store_.Save(LibraryTable::kSelections, selection.id,
                                 {{"requestId", selection.request_id},
                                  {"files", files},
                                  {"accept", selection.accept},
                                  {"limits",
                                   {{"maxFileBytes", selection.limits.file_bytes},
                                    {"maxBatchBytes", selection.limits.batch_bytes},
                                    {"maxFiles", selection.limits.files}}},
                                  {"binding",
                                   {{"browserIncarnation", binding.browser_incarnation},
                                    {"view", binding.view},
                                    {"instance", binding.instance},
                                    {"document", binding.document},
                                    {"request", binding.request}}},
                                  {"state", StateName(selection.state)}}));

  return {};
}
Result<ServiceJson> FileLibrary::Begin(std::uint64_t grant,
                                       const std::string& operation,
                                       const FileUploadStore::Spec& spec,
                                       const Check& check) {
  if (!grant || !BoundedServiceId(operation) || !ValidSpec(spec))
    return Error{ErrorCode::kInvalidRequest, "invalid_asset_upload"};
  std::lock_guard lock(mutex_);
  RK_RETURN_IF_ERROR(check());
  for (auto& [id, draft] : drafts_) {
    if (draft.operation != operation)
      continue;
    if (draft.spec.name != spec.name || draft.spec.type != spec.type ||
        draft.spec.size != spec.size)
      return Error{ErrorCode::kConflict, "asset_operation_conflict"};
    uint64_t offset = spec.size;
    if (draft.sealed.empty()) {
      RK_ASSIGN_OR_RETURN(received, FileSize(DraftData(id)));
      offset = received;
    }
    draft.grant = grant;
    return Json{{"uploadId", id}, {"offset", offset}};
  }
  const auto active = std::count_if(drafts_.begin(), drafts_.end(),
                                    [](const auto& item) { return item.second.sealed.empty(); });
  if (drafts_.size() + retiring_drafts_.size() >= kDrafts ||
      static_cast<std::size_t>(active) >= kActiveDrafts || spec.size > kDraftBytes - draft_bytes_)
    return Error{ErrorCode::kLimitExceeded, "asset_draft_quota",
                 ErrorReason::kStorageQuotaExceeded};
  RK_ASSIGN_OR_RETURN(random, RandomId());
  Draft draft{random, operation, {}, spec, Now() + kDraftLifetime, grant};
  const auto path = DraftData(draft.id);
  const HANDLE handle = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
                                    FILE_ATTRIBUTE_NORMAL, nullptr);
  if (handle == INVALID_HANDLE_VALUE)
    return Error{ErrorCode::kUnavailable, "cannot_create_asset_draft"};
  CloseHandle(handle);
  RK_RETURN_IF_ERROR(FlushFile(path));
  auto saved = SaveDraft(draft, check);
  if (!saved) {
    Remove(path);
    return saved.error();
  }
  draft_bytes_ += spec.size;
  const auto id = draft.id;
  drafts_.emplace(id, std::move(draft));
  return Json{{"uploadId", id}, {"offset", 0}};
}
Result<std::uint64_t> FileLibrary::Chunk(std::uint64_t grant,
                                         const std::string& id,
                                         std::uint64_t offset,
                                         const std::vector<std::uint8_t>& bytes,
                                         const Check& check) {
  std::lock_guard lock(mutex_);
  RK_RETURN_IF_ERROR(check());
  RK_ASSIGN_OR_RETURN(draft_ptr, RequireDraft(grant, id));
  auto& draft = *draft_ptr;
  if (!draft.sealed.empty() || bytes.empty() || bytes.size() > kChunk || offset > draft.spec.size ||
      bytes.size() > draft.spec.size - offset)
    return Error{ErrorCode::kInvalidRequest, "invalid_asset_chunk"};
  const auto path = DraftData(id);
  if (!Plain(path))
    return Error{ErrorCode::kUnavailable, "asset_unavailable"};
  RK_ASSIGN_OR_RETURN(received, FileSize(path));
  if (offset > received || received > draft.spec.size)
    return Error{ErrorCode::kConflict, "file_chunk_out_of_order"};
  std::fstream stream(path, std::ios::binary | std::ios::in | std::ios::out);
  if (!stream)
    return Error{ErrorCode::kUnavailable, "file_read_failed"};
  const auto previous_size =
      static_cast<std::size_t>(std::min<std::uint64_t>(received - offset, bytes.size()));
  if (previous_size) {
    std::vector<std::uint8_t> previous(previous_size);
    stream.seekg(static_cast<std::streamoff>(offset));
    stream.read(reinterpret_cast<char*>(previous.data()),
                static_cast<std::streamsize>(previous.size()));
    if (!stream || !std::equal(previous.begin(), previous.end(), bytes.begin()))
      return Error{ErrorCode::kConflict, "file_chunk_conflict"};
  }
  if (previous_size < bytes.size()) {
    stream.seekp(static_cast<std::streamoff>(received));
    stream.write(reinterpret_cast<const char*>(bytes.data() + previous_size),
                 static_cast<std::streamsize>(bytes.size() - previous_size));
    stream.close();
    if (!stream)
      return Error{ErrorCode::kUnavailable, "file_write_failed"};
  }
  draft.expires = Now() + kDraftLifetime;
  return std::max(received, offset + bytes.size());
}
Result<FileLibrary::Asset> FileLibrary::Publish(const fs::path& source,
                                                Asset asset,
                                                const Check& check,
                                                const std::string& derived_from,
                                                const std::string& kind) {
  RK_RETURN_IF_ERROR(Verify(source, asset.size));
  RK_ASSIGN_OR_RETURN(info, access_->Write(source, check, derived_from, kind));
  asset.id = info.id;
  std::lock_guard lock(mutex_);
  RK_RETURN_IF_ERROR(check());
  Entry entry{asset};
  RK_RETURN_IF_ERROR(store_.Seal(asset.id, asset.Json(), {}, Json()));
  entries_.insert_or_assign(asset.id, std::move(entry));
  return asset;
}
Result<FileLibrary::Asset> FileLibrary::Seal(std::uint64_t grant,
                                             const std::string& id,
                                             const Check& check) {
  Draft draft;
  {
    std::lock_guard lock(mutex_);
    RK_RETURN_IF_ERROR(check());
    RK_ASSIGN_OR_RETURN(current, RequireDraft(grant, id));
    draft = *current;
    if (!draft.sealed.empty()) {
      RK_ASSIGN_OR_RETURN(entry, RequireAsset(draft.sealed));
      return entry->asset;
    }
  }
  RK_RETURN_IF_ERROR(FlushFile(DraftData(id)));
  RK_RETURN_IF_ERROR(Verify(DraftData(id), draft.spec.size));
  RK_ASSIGN_OR_RETURN(info, access_->Write(DraftData(id), check));
  Asset asset{info.id, draft.spec.type, draft.spec.size};
  std::lock_guard lock(mutex_);
  RK_RETURN_IF_ERROR(check());
  draft.sealed = asset.id;
  draft.expires = Now() + kDraftLifetime;
  RK_RETURN_IF_ERROR(store_.Seal(asset.id, asset.Json(), id,
                                 {{"operation", draft.operation},
                                  {"name", draft.spec.name},
                                  {"type", draft.spec.type},
                                  {"size", draft.spec.size},
                                  {"expires", draft.expires},
                                  {"sealed", draft.sealed}}));
  entries_.insert_or_assign(asset.id, Entry{asset});
  drafts_.at(id) = std::move(draft);
  draft_bytes_ -= asset.size;
  Remove(DraftData(id));
  return asset;
}
Result<FileLibrary::Asset> FileLibrary::ImportDownload(const fs::path& profile,
                                                       const ServiceJson& download) {
  const auto reference = download.at("fileReference").get<std::string>();
  const auto size_text = download.at("size").get<std::string>();
  uint64_t size = 0;
  const auto parsed = std::from_chars(size_text.data(), size_text.data() + size_text.size(), size);
  if (parsed.ec != std::errc() || parsed.ptr != size_text.data() + size_text.size())
    return Error{ErrorCode::kInvalidRequest, "invalid_download_size"};
  if (size > kFileBytes)
    return Error{ErrorCode::kLimitExceeded, "file_too_large", ErrorReason::kFileTooLarge};
  const FileUploadStore::Spec spec{download.at("name").get<std::string>(),
                                   download.at("mimeType").get<std::string>(), size};
  if (!ValidSpec(spec) || reference.empty() || reference.find('\\') != std::string::npos ||
      reference.find(':') != std::string::npos || reference.find('\0') != std::string::npos)
    return Error{ErrorCode::kInvalidRequest, "invalid_download_path"};
  const auto relative = fs::u8path(reference);
  if (relative.is_absolute() || relative.has_root_path() || *relative.begin() != L"downloads")
    return Error{ErrorCode::kInvalidRequest, "invalid_download_path"};
  for (const auto& component : relative)
    if (component.empty() || component == L"." || component == L".." ||
        component.native().back() == L'.' || component.native().back() == L' ')
      return Error{ErrorCode::kInvalidRequest, "invalid_download_path"};
  if (std::distance(relative.begin(), relative.end()) < 2)
    return Error{ErrorCode::kInvalidRequest, "invalid_download_path"};

  // Denying writes and renames keeps every checked component fixed while the
  // object store reads the file. OPEN_REPARSE_POINT checks the link itself.
  struct Handles {
    std::vector<HANDLE> values;
    ~Handles() {
      for (const auto handle : values)
        CloseHandle(handle);
    }
  } handles;
  auto path = profile;
  std::vector<fs::path> paths{profile.parent_path().parent_path(), profile.parent_path(), profile};
  for (const auto& component : relative) {
    path /= component;
    paths.push_back(path);
  }
  for (size_t index = 0; index < paths.size(); ++index) {
    const bool directory = index + 1 < paths.size();
    const auto handle = CreateFileW(
        paths[index].c_str(), directory ? FILE_READ_ATTRIBUTES : GENERIC_READ, FILE_SHARE_READ,
        nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    if (handle == INVALID_HANDLE_VALUE) {
      const auto error = GetLastError();
      return Error{error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND
                       ? ErrorCode::kNotFound
                       : ErrorCode::kUnavailable,
                   "download_open_failed",
                   {},
                   {},
                   OsError{OsError::Kind::kWin32, error}};
    }
    handles.values.push_back(handle);
    BY_HANDLE_FILE_INFORMATION info{};
    if (GetFileType(handle) != FILE_TYPE_DISK || !GetFileInformationByHandle(handle, &info))
      return Error{ErrorCode::kUnavailable, "download_stat_failed"};
    if ((info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
        bool(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory)
      return Error{ErrorCode::kInvalidRequest, "invalid_download_path"};
    if (!directory) {
      const auto actual = (uint64_t(info.nFileSizeHigh) << 32) | info.nFileSizeLow;
      if (actual > kFileBytes)
        return Error{ErrorCode::kLimitExceeded, "file_too_large", ErrorReason::kFileTooLarge};
      if (actual != size)
        return Error{ErrorCode::kInternal, "download_size_mismatch"};
    }
  }
  return Publish(path, {{}, spec.type, size}, []() -> Result<void> { return {}; });
}
Result<void> FileLibrary::EraseDraft(std::map<std::string, Draft>::iterator draft) {
  RK_RETURN_IF_ERROR(store_.Erase(LibraryTable::kDrafts, draft->first));
  const auto id = draft->first;
  cleanup_grants_[id] = draft->second.grant;
  retiring_drafts_[id] = draft->second.sealed.empty() ? draft->second.spec.size : 0;
  drafts_.erase(draft);
  return RetireDraft(id);
}
Result<void> FileLibrary::RetireDraft(const std::string& id) {
  const auto found = retiring_drafts_.find(id);
  if (found == retiring_drafts_.end())
    return {};
  auto& retry = cleanup_retries_.try_emplace(id, "files.draft_cleanup").first->second;
  retry.Input("retiring:" + id + ":" + std::to_string(cleanup_grants_[id]));
  if (!retry.Ready())
    return *retry.Failure();
  auto removed = remove_file_(DraftData(id));
  if (!removed) {
    retry.Fail(removed.error());
    return removed.error();
  }
  retry.Success();
  draft_bytes_ -= found->second;
  retiring_drafts_.erase(found);
  cleanup_grants_.erase(id);
  return {};
}
Result<void> FileLibrary::Cancel(std::uint64_t grant, const std::string& id, const Check& check) {
  std::lock_guard lock(mutex_);
  RK_RETURN_IF_ERROR(check());
  const auto found = drafts_.find(id);
  if (found != drafts_.end())
    RK_RETURN_IF_ERROR(RequireDraft(grant, id));
  if (found != drafts_.end() && found->second.sealed.empty())
    return EraseDraft(found);
  if (retiring_drafts_.contains(id))
    cleanup_grants_[id] = grant;
  return RetireDraft(id);
}
Result<FileLibrary::Asset> FileLibrary::Describe(const std::string& id) const {
  std::lock_guard lock(mutex_);
  RK_ASSIGN_OR_RETURN(entry, RequireAsset(id));
  return entry->asset;
}
Result<std::vector<FileUploadStore::Source>> FileLibrary::SelectionSources(
    const Selection& selection,
    const Check& check) {
  RK_RETURN_IF_ERROR(check());
  std::vector<FileUploadStore::Source> sources;
  for (const auto& file : selection.files) {
    RK_ASSIGN_OR_RETURN(asset, Describe(file.asset_id));
    std::string name = file.name;
    std::string type = file.type;
    if (type == "image/webp") {
      const auto format = SelectionWebpTranscode(selection.accept);
      if (format) {
#ifdef RK_FILE_PHOTO
        RK_ASSIGN_OR_RETURN(original, Path(file.asset_id));
        const auto cancelled = [&] { return !check(); };
        RK_ASSIGN_OR_RETURN(
            transcoded, CachedDerivative(
                            file.asset_id,
                            *format == PhotoTranscode::kJpeg ? FileLibrary::DerivativeFormat::jpeg
                                                             : FileLibrary::DerivativeFormat::png,
                            [&](const fs::path& output) -> Result<FileLibrary::Derivative> {
                              RK_ASSIGN_OR_RETURN(
                                  dimensions, TranscodePhoto(original, output, *format, cancelled));
                              return FileLibrary::Derivative{dimensions.width, dimensions.height};
                            },
                            check));
        asset = std::move(transcoded);
        type = *format == PhotoTranscode::kJpeg ? "image/jpeg" : "image/png";
        auto filename = fs::u8path(name);
        filename.replace_extension(*format == PhotoTranscode::kJpeg ? ".jpg" : ".png");
        const auto encoded_name = filename.u8string();
        name.assign(encoded_name.begin(), encoded_name.end());
#else
        return Error{ErrorCode::kUnavailable, "photo_processing_unavailable"};
#endif
      }
    }
    RK_ASSIGN_OR_RETURN(path, Path(asset.id));
    sources.push_back({{name, type, asset.size}, path});
  }
  RK_RETURN_IF_ERROR(CheckSelectionSources(sources, selection.limits));
  return sources;
}
Result<ServiceJson> FileLibrary::OpenDocument(const std::string& asset,
                                              const std::string& type,
                                              const Check& check) {
  RK_RETURN_IF_ERROR(check());
  RK_RETURN_IF_ERROR(objects_.Documents().Available());
  {
    std::lock_guard lock(mutex_);
    RK_RETURN_IF_ERROR(RequireAsset(asset));
  }
  RK_ASSIGN_OR_RETURN(result, objects_.Documents().Open(asset, tenant_, root_ / "documents", type));
  RK_RETURN_IF_ERROR(check());
  if (result["state"] == "ready") {
    std::lock_guard lock(mutex_);
    documents_.insert(result["documentId"].get<std::string>());
  }
  return result;
}
Result<ServiceJson> FileLibrary::DocumentResource(const std::string& document,
                                                  const std::string& content,
                                                  uint64_t offset,
                                                  const Check& check) {
  RK_RETURN_IF_ERROR(check());
  RK_RETURN_IF_ERROR(objects_.Documents().Available());
  {
    std::lock_guard lock(mutex_);
    if (!documents_.contains(document))
      return Error{ErrorCode::kForbidden, "document not opened by session"};
  }
  RK_ASSIGN_OR_RETURN(resource, objects_.Documents().Resource(document, content, offset));
  RK_RETURN_IF_ERROR(check());
  return ServiceJson{{"data", EncodeFileChunk(resource.bytes)},
                     {"offset", offset + resource.bytes.size()},
                     {"total", resource.total},
                     {"mime", resource.mime}};
}
Result<fs::path> FileLibrary::Path(const std::string& id) const {
  std::lock_guard lock(mutex_);
  RK_ASSIGN_OR_RETURN(entry, RequireAsset(id));
  const auto path = root_ / "staging" / id;
  std::error_code error;
  if (fs::exists(path, error))
    return path;
  uint64_t used = 0;
  for (const auto& staged : fs::directory_iterator(root_ / "staging"))
    used += staged.file_size();
  if (entry->asset.size > kStagingBytes - std::min(used, kStagingBytes))
    return Error{ErrorCode::kLimitExceeded, "asset_staging_quota",
                 ErrorReason::kStorageQuotaExceeded};
  auto partial = path;
  partial += ".new";
  std::ofstream output(partial, std::ios::binary | std::ios::trunc);
  auto read = objects_.Store().Read(objects_.ObjectKeys(), id, output);
  output.close();
  if (!read || !output) {
    Remove(partial);
    return read ? Error{ErrorCode::kUnavailable, "asset_staging_failed"} : read.error();
  }
  if (!MoveFileExW(partial.c_str(), path.c_str(),
                   MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
    return Error{ErrorCode::kUnavailable, "asset_staging_failed"};
  return path;
}
Result<std::pair<FileLibrary::Asset, std::vector<std::uint8_t>>> FileLibrary::Read(
    const std::string& id,
    std::uint64_t offset) const {
  std::optional<Asset> asset;
  if (access_->HasGrant(id)) {
    std::lock_guard lock(mutex_);
    if (const auto found = entries_.find(id); found != entries_.end())
      asset = found->second.asset;
  }
  if (!asset) {
    RK_ASSIGN_OR_RETURN(described, Describe(id));
    asset = described;
  }
  auto bytes = objects_.Store().ReadRange(objects_.ObjectKeys(), id, offset, kChunk);
  if (!bytes && bytes.error().code == ErrorCode::kNotFound) {
    RK_ASSIGN_OR_RETURN(described, Describe(id));
    asset = described;
    bytes = objects_.Store().ReadRange(objects_.ObjectKeys(), id, offset, kChunk);
  }
  if (!bytes)
    return bytes.error();
  return std::pair{*asset, std::move(bytes).value()};
}
Result<FileLibrary::Asset> FileLibrary::CreateDerivative(const Render& render,
                                                         const Check& check,
                                                         DerivativeFormat format,
                                                         const std::string& derived_from,
                                                         const std::string& kind,
                                                         ServiceJson* metadata) {
  const bool jpeg = format == DerivativeFormat::jpeg;
  const auto budget = jpeg ? kJpegDerivativeBytes : kPngDerivativeBytes;
  const char* extension = jpeg ? ".jpg" : format == DerivativeFormat::png ? ".png" : ".webp";
  const char* type = jpeg                              ? "image/jpeg"
                     : format == DerivativeFormat::png ? "image/png"
                                                       : "image/webp";
  {
    std::lock_guard lock(mutex_);
    RK_RETURN_IF_ERROR(check());
  }
  RK_ASSIGN_OR_RETURN(random, RandomId());
  const auto path = DraftData(random + extension);
  struct Cleanup {
    fs::path path;
    ~Cleanup() { Remove(path); }
  } cleanup{path};
  {
    RK_ASSIGN_OR_RETURN(dimensions, render(path));
    if (!Plain(path))
      return Error{ErrorCode::kUnavailable, "photo_output_failed"};
    RK_ASSIGN_OR_RETURN(size, FileSize(path));
    if (size > budget)
      return Error{ErrorCode::kLimitExceeded, "photo_output_too_large", ErrorReason::kFileTooLarge};
    RK_RETURN_IF_ERROR(FlushFile(path));
    auto result = Publish(path, {{}, type, size, dimensions.width, dimensions.height}, check,
                          derived_from, kind);
    if (result && metadata)
      *metadata = dimensions.metadata;
    return result;
  }
}
Result<FileLibrary::Asset> FileLibrary::CachedDerivative(const std::string& source,
                                                         DerivativeFormat format,
                                                         const Render& render,
                                                         const Check& check,
                                                         const std::string& kind,
                                                         const std::string& variant,
                                                         ServiceJson* metadata) {
  const std::string encoding = format == DerivativeFormat::jpeg  ? "jpeg"
                               : format == DerivativeFormat::png ? "png"
                                                                 : "webp";
  const DerivativeKey key{source, kind, variant.empty() ? encoding : variant + ":" + encoding};
  const auto lock_key = source + ":" + kind + ":" + key.parameters;
  std::lock_guard lock(
      derivatives_mutexes_[std::hash<std::string>{}(lock_key) % derivatives_mutexes_.size()]);
  RK_RETURN_IF_ERROR(check());
  RK_RETURN_IF_ERROR(Describe(source));
  RK_ASSIGN_OR_RETURN(cached, store_.FindDerivative(key));
  if (cached) {
    auto asset = Describe(cached->asset_id);
    if (asset) {
      RK_RETURN_IF_ERROR(check());
      if (metadata)
        *metadata = cached->metadata;
      return asset;
    }
    if (asset.error().code != ErrorCode::kNotFound)
      return asset.error();
    // A missing derivative is repairable only while the original is still readable.
    RK_RETURN_IF_ERROR(Path(source));
    RK_RETURN_IF_ERROR(check());
    RK_RETURN_IF_ERROR(store_.EraseDerivative(key, check));
  }
  ServiceJson rendered_metadata;
  RK_ASSIGN_OR_RETURN(asset,
                      CreateDerivative(render, check, format, source, kind, &rendered_metadata));
  RK_RETURN_IF_ERROR(store_.SaveDerivative(key, {asset.id, rendered_metadata}, check));
  if (metadata)
    *metadata = std::move(rendered_metadata);
  return asset;
}
Result<ServiceJson> FileLibrary::Preview(const std::string& source,
                                         unsigned max_side,
                                         const Check& check) {
  if (max_side != 1280 && max_side != 2560)
    return Error{ErrorCode::kRejected, "invalid_photo_preview_max_side"};
#ifdef RK_FILE_PHOTO
  RK_RETURN_IF_ERROR(check());
  RK_ASSIGN_OR_RETURN(path, Path(source));
  PreviewImage image;
  RK_RETURN_IF_ERROR(image.Open(path));
  if (std::max(image.width, image.height) <= max_side) {
    RK_RETURN_IF_ERROR(check());
    return ServiceJson{{"assetId", source},
                       {"width", image.width},
                       {"height", image.height},
                       {"type", image.type}};
  }
  RK_ASSIGN_OR_RETURN(
      asset, CachedDerivative(
                 source, DerivativeFormat::webp,
                 [&](const fs::path& output) { return image.Write(output, max_side, check); },
                 check, "preview", std::to_string(max_side) + "-q80-v1"));
  RK_RETURN_IF_ERROR(check());
  return ServiceJson{{"assetId", asset.id},
                     {"width", asset.width},
                     {"height", asset.height},
                     {"type", "image/webp"}};
#else
  return Error{ErrorCode::kUnavailable, "photo_processing_unavailable"};
#endif
}
Result<ServiceJson> FileLibrary::Process(const std::string& source,
                                         const std::string& mode,
                                         std::optional<unsigned> turns,
                                         const Check& check) {
  if (mode != "photo" && mode != "scan")
    return Error{ErrorCode::kInvalidRequest, "invalid_photo_mode"};
  if (turns && *turns > 3)
    return Error{ErrorCode::kInvalidRequest, "invalid_photo_quarter_turns"};
#ifdef RK_FILE_PHOTO
  const auto variant = mode + "-" + (turns ? std::to_string(*turns) : "auto") + "-v" +
                       std::to_string(derivative_records::kPhotoAlgorithmVersion);
  ServiceJson metadata;
  RK_ASSIGN_OR_RETURN(asset, CachedDerivative(
                                 source, DerivativeFormat::webp,
                                 [&](const fs::path& output) -> Result<Derivative> {
                                   RK_ASSIGN_OR_RETURN(path, Path(source));
                                   RK_ASSIGN_OR_RETURN(
                                       processed, ProcessPhoto(path, output,
                                                               mode == "scan" ? PhotoMode::kScan
                                                                              : PhotoMode::kPhoto,
                                                               turns, [&] { return !check(); }));
                                   return Derivative{processed.width,
                                                     processed.height,
                                                     {{"geometry", processed.geometry},
                                                      {"quarterTurns", processed.quarter_turns},
                                                      {"orientation", processed.orientation}}};
                                 },
                                 check, "photo", variant, &metadata));
  RK_RETURN_IF_ERROR(check());
  auto result = asset.Json();
  result.update(metadata);
  return result;
#else
  return Error{ErrorCode::kUnavailable, "photo_processing_unavailable"};
#endif
}
ServiceJson FileLibrary::CleanupFailures() const {
  std::lock_guard lock(mutex_);
  ServiceJson errors = ServiceJson::object();
  for (const auto& [id, retry] : cleanup_retries_)
    if (retry.Failure())
      errors[id] = WireError(*retry.Failure());
  return errors;
}
Result<void> FileLibrary::Sweep() {
  std::lock_guard lock(mutex_);
  const auto now = Now();
  if (now < sweep_after_)
    return {};
  sweep_after_ = now + 10;
  std::optional<Error> failure;
  for (auto it = drafts_.begin(); it != drafts_.end();) {
    const auto current = it++;
    if (current->second.expires <= now) {
      auto& retry =
          cleanup_retries_.try_emplace(current->first, "files.draft_cleanup").first->second;
      retry.Input("retiring:" + current->first + ":" + std::to_string(current->second.grant));
      if (!retry.Ready())
        continue;
      const auto before = retry.Attempt();
      auto erased = EraseDraft(current);
      if (!erased) {
        if (retry.Attempt() == before)
          retry.Fail(erased.error());
        failure = erased.error();
      }
    }
  }
  for (auto it = retiring_drafts_.begin(); it != retiring_drafts_.end();) {
    const auto id = (it++)->first;
    auto retired = RetireDraft(id);
    if (!retired)
      failure = retired.error();
  }
  for (const auto& entry : fs::directory_iterator(root_ / "staging")) {
    if (fs::file_time_type::clock::now() - entry.last_write_time() > std::chrono::minutes(10)) {
      auto retired = RetireStaging(entry);
      if (!retired)
        failure = retired.error();
    }
  }

  return failure ? Result<void>{*failure} : Result<void>{};
}
Result<void> FileLibrary::RetireStaging(const fs::directory_entry& entry) {
  const auto name = entry.path().string();
  auto& retry = cleanup_retries_.try_emplace(name, "files.staging_cleanup").first->second;
  retry.Input(name + ":" + std::to_string(entry.last_write_time().time_since_epoch().count()));
  if (!retry.Ready())
    return *retry.Failure();
  auto removed = remove_file_(entry.path());
  if (!removed) {
    retry.Fail(removed.error());
    return removed.error();
  }
  retry.Success();
  return {};
}
Result<void> FileLibrary::Prepare(const Selection& selection) {
  if (!HexId(selection.id, 32) || !BoundedServiceId(selection.request_id) ||
      selection.request_id == "library" || selection.files.empty() || selection.files.size() > 64 ||
      selection.files.size() > selection.limits.files || !selection.limits.file_bytes ||
      !selection.limits.batch_bytes)
    return Error{ErrorCode::kInvalidRequest, "invalid_selection_manifest"};
  std::lock_guard lock(mutex_);
  const auto found = selections_.find(selection.id);
  if (found != selections_.end()) {
    if (found->second.binding != selection.binding || found->second.files != selection.files ||
        found->second.request_id != selection.request_id ||
        found->second.accept != selection.accept ||
        found->second.limits.file_bytes != selection.limits.file_bytes ||
        found->second.limits.batch_bytes != selection.limits.batch_bytes ||
        found->second.limits.files != selection.limits.files)
      return Error{ErrorCode::kConflict, "selection_manifest_conflict"};
    return {};
  }
  if (selections_.size() >= kSelections)
    return Error{ErrorCode::kLimitExceeded, "selection_receipt_quota",
                 ErrorReason::kStorageQuotaExceeded};
  std::uint64_t bytes = 0;
  for (const auto& file : selection.files) {
    RK_ASSIGN_OR_RETURN(asset_entry, RequireAsset(file.asset_id));
    const auto& entry = *asset_entry;
    if (!ValidSpec({file.name, file.type, entry.asset.size}) ||
        entry.asset.size > 2 * kFileBytes - bytes)
      return Error{ErrorCode::kInvalidRequest, "invalid_selection_file"};
    bytes += entry.asset.size;
  }
  RK_RETURN_IF_ERROR(SaveSelection(selection));
  selections_.emplace(selection.id, selection);

  return {};
}
std::optional<FileLibrary::Selection> FileLibrary::FindSelection(const std::string& id) const {
  std::lock_guard lock(mutex_);
  const auto found = selections_.find(id);
  if (found == selections_.end())
    return std::nullopt;
  return found->second;
}
Result<bool> FileLibrary::Claim(const std::string& id, const Check& check) {
  std::lock_guard lock(mutex_);
  RK_RETURN_IF_ERROR(check());
  auto& selection = selections_.at(id);
  if (selection.state != State::pending)
    return false;
  for (const auto& [other_id, other] : selections_) {
    if (id != other_id && other.binding == selection.binding && other.state != State::pending)
      return Error{ErrorCode::kConflict, "file_selection_already_submitted"};
  }
  auto submitted = selection;
  submitted.state = State::dispatching;
  RK_RETURN_IF_ERROR(SaveSelection(submitted, check));
  selection.state = State::dispatching;
  return true;
}
Result<void> FileLibrary::ReleaseClaim(const std::string& id) {
  std::lock_guard lock(mutex_);
  auto& selection = selections_.at(id);
  if (selection.state != State::dispatching)
    return Error{ErrorCode::kConflict, "selection dispatch state changed"};
  auto prepared = selection;
  prepared.state = State::pending;
  RK_RETURN_IF_ERROR(SaveSelection(prepared));
  selection = std::move(prepared);
  return {};
}
Result<void> FileLibrary::Unknown(const std::string& id) {
  std::lock_guard lock(mutex_);
  auto& selection = selections_.at(id);
  if (selection.state != State::dispatching && selection.state != State::unknown)
    return Error{ErrorCode::kConflict, "selection is not dispatching"};
  auto unknown = selection;
  unknown.state = State::unknown;
  RK_RETURN_IF_ERROR(SaveSelection(unknown));
  selection = std::move(unknown);
  return {};
}
Result<std::optional<State>> FileLibrary::CancelPendingSelections(
    const FileUploadStore::Binding& binding,
    const Check& check) {
  std::lock_guard lock(mutex_);
  RK_RETURN_IF_ERROR(check());
  std::optional<State> result;
  for (const auto& [id, selection] : selections_) {
    if (selection.binding != binding)
      continue;
    if (selection.state == State::dispatching || selection.state == State::unknown ||
        selection.state == State::selected)
      return std::optional<State>{selection.state};
  }
  std::map<std::string, Json> cancelled;
  RK_ASSIGN_OR_RETURN(records, store_.Load(LibraryTable::kSelections));
  for (const auto& [id, selection] : selections_) {
    if (selection.binding != binding)
      continue;
    if (selection.state == State::pending) {
      auto document = records.at(id);
      document["state"] = "cancelled";
      cancelled.emplace(id, std::move(document));
      result = State::cancelled;
    } else
      result = selection.state;
  }
  RK_RETURN_IF_ERROR(store_.Selections(cancelled));
  for (const auto& [id, document] : cancelled)
    selections_.at(id).state = State::cancelled;
  return result;
}
Result<State> FileLibrary::Finish(const std::string& id,
                                  State state,
                                  std::optional<State> expected) {
  std::lock_guard lock(mutex_);
  auto& selection = selections_.at(id);
  if (selection.state == state || selection.state == State::selected ||
      selection.state == State::cancelled || (expected && selection.state != *expected))
    return selection.state;
  if (state != State::cancelled &&
      !(state == State::selected &&
        (selection.state == State::dispatching || selection.state == State::unknown)))
    return Error{ErrorCode::kInvalidRequest, "invalid_selection_state"};
  auto terminal = selection;
  terminal.state = state;
  RK_RETURN_IF_ERROR(SaveSelection(terminal));
  selection.state = state;
  return state;
}
}  // namespace remotekit
