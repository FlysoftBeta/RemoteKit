#include "files/photo_processing.hpp"
#include "files/photo_scan.hpp"
#include "files/photo_geometry.hpp"
#include <webp/decode.h>
#include <webp/encode.h>

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <wincodec.h>
#include <wrl/client.h>

#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>

#include <algorithm>
#include <cmath>
#include <fstream>
#include <numeric>
#include <cstring>
#include <chrono>
#include <semaphore>
#include "util/result_macros.hpp"
#include <utility>

namespace remotekit {
namespace {

using Microsoft::WRL::ComPtr;
constexpr int kMaxPixels = 8 * 1024 * 1024;
constexpr int kMaxDimension = 8192;
constexpr std::streamoff kMaxCompressedBytes = 64 * 1024 * 1024;
constexpr int kAnalysisSide = 512;
constexpr std::size_t kMaxAnalysisBytes = 44 * 1024;
constexpr int kThumbnailSide = 320;
constexpr ULONG kMaxThumbnailBytes = 64 * 1024;
constexpr char kThumbnailOutputError[] = "photo_output_failed";
constexpr int kSignatureSize = 24;

Result<void> Check(HRESULT result, const char* error = "invalid-photo") {
  if (FAILED(result)) {
    if (result == WINCODEC_ERR_BADIMAGE || result == WINCODEC_ERR_BADHEADER ||
        result == WINCODEC_ERR_UNKNOWNIMAGEFORMAT || result == WINCODEC_ERR_COMPONENTNOTFOUND)
      return Error{ErrorCode::kRejected, error};
    return Error{ErrorCode::kUnavailable, error};
  }

  return {};
}

Result<void> CheckCancelled(const PhotoCancelled& cancelled) {
  if (cancelled && cancelled())
    return Error{ErrorCode::kCanceled, "Photo processing canceled"};

  return {};
}

class Imaging {
 public:
  Result<void> Open(const char* error = "photo-imaging-unavailable") {
    const auto result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (result != RPC_E_CHANGED_MODE)
      RK_RETURN_IF_ERROR(Check(result, error));
    initialized_ = SUCCEEDED(result);
    const auto factory_result = CoCreateInstance(CLSID_WICImagingFactory, nullptr,
                                                 CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory));
    if (FAILED(factory_result)) {
      RK_RETURN_IF_ERROR(Check(factory_result, error));
    }

    return {};
  }
  ~Imaging() {
    factory.Reset();
    if (initialized_)
      CoUninitialize();
  }

  ComPtr<IWICImagingFactory> factory;

 private:
  bool initialized_ = false;
};

unsigned Orientation(IWICBitmapFrameDecode& frame) {
  ComPtr<IWICMetadataQueryReader> metadata;
  if (FAILED(frame.GetMetadataQueryReader(&metadata)))
    return 1;
  PROPVARIANT value{};
  const auto result = metadata->GetMetadataByName(L"/app1/ifd/{ushort=274}", &value);
  const unsigned orientation = SUCCEEDED(result) && value.vt == VT_UI2 ? value.uiVal : 1;
  PropVariantClear(&value);
  return orientation;
}

unsigned TiffOrientation(std::span<const BYTE> tiff) {
  if (tiff.size() >= 6 && std::memcmp(tiff.data(), "Exif\0\0", 6) == 0)
    tiff = tiff.subspan(6);
  if (tiff.size() < 8)
    return 1;
  const bool little = tiff[0] == 'I' && tiff[1] == 'I';
  if (!little && !(tiff[0] == 'M' && tiff[1] == 'M'))
    return 1;
  const auto number = [&](std::size_t start, std::size_t bytes) {
    std::uint32_t value = 0;
    for (std::size_t index = 0; index < bytes; ++index)
      value = value * 256 + tiff[start + (little ? bytes - index - 1 : index)];
    return value;
  };
  if (number(2, 2) != 42)
    return 1;
  const std::size_t ifd = number(4, 4);
  if (ifd < 8 || ifd > tiff.size() - 2)
    return 1;
  const auto count = number(ifd, 2);
  if (count > (tiff.size() - ifd - 2) / 12)
    return 1;
  for (std::size_t index = 0; index < count; ++index) {
    const auto entry = ifd + 2 + index * 12;
    if (number(entry, 2) == 274 && number(entry + 2, 2) == 3 && number(entry + 4, 4) == 1)
      return number(entry + 8, 2);
  }
  return 1;
}

unsigned PngOrientation(std::span<const BYTE> png) {
  for (std::size_t offset = 8; offset <= png.size() && png.size() - offset >= 12;) {
    std::size_t length = 0;
    for (int index = 0; index < 4; ++index)
      length = length * 256 + png[offset + index];
    if (length > png.size() - offset - 12)
      break;
    if (std::memcmp(png.data() + offset + 4, "eXIf", 4) == 0)
      return TiffOrientation(png.subspan(offset + 8, length));
    offset += length + 12;
  }
  return 1;
}

unsigned WebpOrientation(std::span<const BYTE> bytes) {
  for (std::size_t offset = 12; offset <= bytes.size() && bytes.size() - offset >= 8;) {
    const std::size_t length = bytes[offset + 4] | (bytes[offset + 5] << 8) |
                               (bytes[offset + 6] << 16) |
                               (static_cast<std::size_t>(bytes[offset + 7]) << 24);
    if (length > bytes.size() - offset - 8)
      break;
    if (std::memcmp(bytes.data() + offset, "EXIF", 4) == 0)
      return TiffOrientation(bytes.subspan(offset + 8, length));
    offset += 8 + length + (length & 1);
  }
  return 1;
}

UINT ScaleSide(UINT dimension, UINT longest, UINT target) {
  return std::max(1u, (dimension * target + longest / 2) / longest);
}

void Orient(cv::Mat& image, unsigned orientation) {
  switch (orientation) {
    case 2:
      cv::flip(image, image, 1);
      break;
    case 3:
      cv::rotate(image, image, cv::ROTATE_180);
      break;
    case 4:
      cv::flip(image, image, 0);
      break;
    case 5:
      cv::transpose(image, image);
      break;
    case 6:
      cv::rotate(image, image, cv::ROTATE_90_CLOCKWISE);
      break;
    case 7:
      cv::transpose(image, image);
      cv::flip(image, image, -1);
      break;
    case 8:
      cv::rotate(image, image, cv::ROTATE_90_COUNTERCLOCKWISE);
      break;
    default:
      break;
  }
}

Result<cv::Mat> DecodeWebp(std::span<const BYTE> bytes,
                           bool thumbnail,
                           const PhotoCancelled& cancelled) {
  WebPBitstreamFeatures features{};
  if (WebPGetFeatures(bytes.data(), bytes.size(), &features) != VP8_STATUS_OK ||
      features.has_animation)
    return Error{ErrorCode::kRejected, "invalid-photo"};
  const int maximum = thumbnail ? 16384 : kMaxDimension;
  const auto pixels = static_cast<std::uint64_t>(features.width) * features.height;
  if (features.width > maximum || features.height > maximum ||
      pixels > static_cast<std::uint64_t>(thumbnail ? 32 * 1024 * 1024 : kMaxPixels))
    return Error{ErrorCode::kLimitExceeded, "photo-too-large"};
  if (features.width < (thumbnail ? 1 : 32) || features.height < (thumbnail ? 1 : 32))
    return Error{ErrorCode::kRejected, "invalid-photo"};
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  WebPDecoderConfig config;
  if (!WebPInitDecoderConfig(&config))
    return Error{ErrorCode::kUnavailable, "photo-imaging-unavailable"};
  int width = features.width;
  int height = features.height;
  if (thumbnail && std::max(width, height) > kThumbnailSide) {
    const int longest = std::max(width, height);
    width = static_cast<int>(ScaleSide(width, longest, kThumbnailSide));
    height = static_cast<int>(ScaleSide(height, longest, kThumbnailSide));
    config.options.use_scaling = 1;
    config.options.scaled_width = width;
    config.options.scaled_height = height;
  }
  cv::Mat decoded(height, width, features.has_alpha ? CV_8UC4 : CV_8UC3);
  config.output.colorspace = features.has_alpha ? MODE_BGRA : MODE_BGR;
  config.output.is_external_memory = 1;
  config.output.u.RGBA.rgba = decoded.data;
  config.output.u.RGBA.stride = static_cast<int>(decoded.step);
  config.output.u.RGBA.size = decoded.total() * decoded.elemSize();
  const auto status = WebPDecode(bytes.data(), bytes.size(), &config);
  WebPFreeDecBuffer(&config.output);
  if (status != VP8_STATUS_OK)
    return Error{ErrorCode::kRejected, "invalid-photo"};
  if (features.has_alpha) {
    cv::Mat opaque(decoded.size(), CV_8UC3);
    for (int row = 0; row < decoded.rows; ++row) {
      if (row % 32 == 0)
        RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
      const auto* source = decoded.ptr<cv::Vec4b>(row);
      auto* output = opaque.ptr<cv::Vec3b>(row);
      for (int col = 0; col < decoded.cols; ++col)
        for (int channel = 0; channel < 3; ++channel)
          output[col][channel] = static_cast<std::uint8_t>(
              (source[col][channel] * source[col][3] + 255 * (255 - source[col][3]) + 127) / 255);
    }
    decoded = std::move(opaque);
  }
  Orient(decoded, WebpOrientation(bytes));
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  return decoded;
}

Result<cv::Mat> DecodeMemory(IWICImagingFactory& factory,
                             std::span<const BYTE> compressed,
                             const PhotoCancelled& cancelled,
                             bool thumbnail,
                             bool analysis) {
  const char* invalid = thumbnail ? "invalid_photo" : "invalid-photo";
  const char* too_large = thumbnail ? "photo_too_large" : "photo-too-large";
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  if (compressed.size() < 8)
    return Error{ErrorCode::kRejected, invalid};
  constexpr std::array<BYTE, 8> png_signature{137, 80, 78, 71, 13, 10, 26, 10};
  const bool jpeg = compressed[0] == 0xff && compressed[1] == 0xd8 && compressed[2] == 0xff;
  if (!analysis && compressed.size() >= 12 && std::memcmp(compressed.data(), "RIFF", 4) == 0 &&
      std::memcmp(compressed.data() + 8, "WEBP", 4) == 0)
    return DecodeWebp(compressed, thumbnail, cancelled);
  if (!jpeg &&
      (analysis || !std::equal(png_signature.begin(), png_signature.end(), compressed.begin())))
    return Error{ErrorCode::kRejected, invalid};

  ComPtr<IWICStream> stream;
  ComPtr<IWICBitmapDecoder> decoder;
  ComPtr<IWICBitmapFrameDecode> frame;
  RK_RETURN_IF_ERROR(Check(factory.CreateStream(&stream), invalid));
  // The decoder only reads this caller-owned buffer.
  RK_RETURN_IF_ERROR(Check(stream->InitializeFromMemory(const_cast<BYTE*>(compressed.data()),
                                                        static_cast<DWORD>(compressed.size())),
                           invalid));
  RK_RETURN_IF_ERROR(
      Check(factory.CreateDecoder(jpeg ? GUID_ContainerFormatJpeg : GUID_ContainerFormatPng,
                                  &GUID_VendorMicrosoft, &decoder),
            invalid));
  RK_RETURN_IF_ERROR(
      Check(decoder->Initialize(stream.Get(), WICDecodeMetadataCacheOnDemand), invalid));
  UINT frame_count = 0;
  RK_RETURN_IF_ERROR(Check(decoder->GetFrameCount(&frame_count), invalid));
  if (frame_count != 1)
    return Error{ErrorCode::kRejected, invalid};
  RK_RETURN_IF_ERROR(Check(decoder->GetFrame(0, &frame), invalid));
  UINT width = 0, height = 0;
  RK_RETURN_IF_ERROR(Check(frame->GetSize(&width, &height), invalid));
  const UINT max_dimension = analysis ? kAnalysisSide : thumbnail ? 16384 : kMaxDimension;
  const auto max_pixels = thumbnail ? 32 * 1024 * 1024 : kMaxPixels;
  if (width > max_dimension || height > max_dimension ||
      static_cast<std::uint64_t>(width) * height > max_pixels)
    return Error{ErrorCode::kLimitExceeded, too_large};
  const UINT min_dimension = thumbnail ? 1 : analysis ? 16 : 32;
  if (width < min_dimension || height < min_dimension)
    return Error{ErrorCode::kRejected, invalid};
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  ComPtr<IWICFormatConverter> converter;
  const bool flatten_alpha = !jpeg;
  RK_RETURN_IF_ERROR(Check(factory.CreateFormatConverter(&converter), invalid));
  RK_RETURN_IF_ERROR(Check(
      converter->Initialize(
          frame.Get(), flatten_alpha ? GUID_WICPixelFormat32bppPBGRA : GUID_WICPixelFormat24bppBGR,
          WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom),
      invalid));
  IWICBitmapSource* pixels = converter.Get();
  ComPtr<IWICBitmapScaler> scaler;
  const UINT longest = std::max(width, height);
  if (thumbnail && longest > kThumbnailSide) {
    width = ScaleSide(width, longest, kThumbnailSide);
    height = ScaleSide(height, longest, kThumbnailSide);
    RK_RETURN_IF_ERROR(Check(factory.CreateBitmapScaler(&scaler), invalid));
    RK_RETURN_IF_ERROR(
        Check(scaler->Initialize(pixels, width, height, WICBitmapInterpolationModeFant), invalid));
    pixels = scaler.Get();
  }
  cv::Mat image(static_cast<int>(height), static_cast<int>(width),
                flatten_alpha ? CV_8UC4 : CV_8UC3);
  RK_RETURN_IF_ERROR(
      Check(pixels->CopyPixels(nullptr, static_cast<UINT>(image.step),
                               static_cast<UINT>(image.total() * image.elemSize()), image.data),
            invalid));
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  if (flatten_alpha) {
    cv::Mat opaque(image.size(), CV_8UC3);
    for (int y = 0; y < image.rows; ++y) {
      if (y % 32 == 0)
        RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
      const auto* src = image.ptr<cv::Vec4b>(y);
      auto* dst = opaque.ptr<cv::Vec3b>(y);
      for (int x = 0; x < image.cols; ++x) {
        const int white = 255 - src[x][3];
        for (int channel = 0; channel < 3; ++channel)
          dst[x][channel] = cv::saturate_cast<std::uint8_t>(src[x][channel] + white);
      }
    }
    image = std::move(opaque);
  }
  if (jpeg)
    Orient(image, Orientation(*frame.Get()));
  else
    Orient(image, PngOrientation(compressed));
  return image;
}

Result<cv::Mat> Decode(IWICImagingFactory& factory,
                       const std::filesystem::path& path,
                       const PhotoCancelled& cancelled,
                       bool thumbnail = false) {
  const char* invalid = thumbnail ? "invalid_photo" : "invalid-photo";
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  std::ifstream input(path, std::ios::binary | std::ios::ate);
  if (!input)
    return Error{ErrorCode::kUnavailable, "Cannot open photo input"};
  if (input.tellg() < 8)
    return Error{ErrorCode::kRejected, invalid};
  const std::streamoff bytes = input.tellg();
  if (bytes > kMaxCompressedBytes)
    return Error{ErrorCode::kLimitExceeded, thumbnail ? "photo_too_large" : "photo-too-large"};
  std::vector<BYTE> compressed(static_cast<std::size_t>(bytes));
  input.seekg(0);
  if (!input.read(reinterpret_cast<char*>(compressed.data()), bytes))
    return Error{ErrorCode::kUnavailable, "Cannot read photo input"};
  return DecodeMemory(factory, compressed, cancelled, thumbnail, false);
}

Result<void> EncodeJpeg(IWICImagingFactory& factory,
                        IStream& stream,
                        const cv::Mat& image,
                        float compression_quality,
                        const char* error) {
  ComPtr<IWICBitmapEncoder> encoder;
  ComPtr<IWICBitmapFrameEncode> frame;
  ComPtr<IPropertyBag2> properties;
  RK_RETURN_IF_ERROR(Check(
      factory.CreateEncoder(GUID_ContainerFormatJpeg, &GUID_VendorMicrosoft, &encoder), error));
  RK_RETURN_IF_ERROR(Check(encoder->Initialize(&stream, WICBitmapEncoderNoCache), error));
  RK_RETURN_IF_ERROR(Check(encoder->CreateNewFrame(&frame, &properties), error));
  wchar_t quality_name[] = L"ImageQuality";
  PROPBAG2 option{};
  option.pstrName = quality_name;
  VARIANT quality{};
  quality.vt = VT_R4;
  quality.fltVal = compression_quality;
  RK_RETURN_IF_ERROR(Check(properties->Write(1, &option, &quality), error));
  RK_RETURN_IF_ERROR(Check(frame->Initialize(properties.Get()), error));
  RK_RETURN_IF_ERROR(Check(frame->SetSize(image.cols, image.rows), error));
  WICPixelFormatGUID format = GUID_WICPixelFormat24bppBGR;
  RK_RETURN_IF_ERROR(Check(frame->SetPixelFormat(&format), error));
  if (format != GUID_WICPixelFormat24bppBGR)
    return Error{ErrorCode::kInternal, error};
  RK_RETURN_IF_ERROR(
      Check(frame->WritePixels(image.rows, static_cast<UINT>(image.step),
                               static_cast<UINT>(image.total() * image.elemSize()), image.data),
            error));
  RK_RETURN_IF_ERROR(Check(frame->Commit(), error));
  RK_RETURN_IF_ERROR(Check(encoder->Commit(), error));

  return {};
}

Result<void> EncodePng(IWICImagingFactory& factory,
                       const std::filesystem::path& path,
                       const cv::Mat& image,
                       const PhotoCancelled& cancelled) {
  constexpr char error[] = "photo-output-failed";
  ComPtr<IWICStream> stream;
  RK_RETURN_IF_ERROR(Check(factory.CreateStream(&stream), error));
  RK_RETURN_IF_ERROR(Check(stream->InitializeFromFilename(path.c_str(), GENERIC_WRITE), error));
  ComPtr<IWICBitmapEncoder> encoder;
  ComPtr<IWICBitmapFrameEncode> frame;
  RK_RETURN_IF_ERROR(Check(
      factory.CreateEncoder(GUID_ContainerFormatPng, &GUID_VendorMicrosoft, &encoder), error));
  RK_RETURN_IF_ERROR(Check(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache), error));
  RK_RETURN_IF_ERROR(Check(encoder->CreateNewFrame(&frame, nullptr), error));
  RK_RETURN_IF_ERROR(Check(frame->Initialize(nullptr), error));
  RK_RETURN_IF_ERROR(Check(frame->SetSize(image.cols, image.rows), error));
  auto format = GUID_WICPixelFormat24bppBGR;
  RK_RETURN_IF_ERROR(Check(frame->SetPixelFormat(&format), error));
  if (format != GUID_WICPixelFormat24bppBGR)
    return Error{ErrorCode::kInternal, error};
  const auto stride = static_cast<UINT>(image.step);
  for (int y = 0; y < image.rows; y += 64) {
    RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
    const auto rows = static_cast<UINT>(std::min(64, image.rows - y));
    RK_RETURN_IF_ERROR(Check(
        frame->WritePixels(rows, stride, rows * stride, const_cast<BYTE*>(image.ptr(y))), error));
  }
  RK_RETURN_IF_ERROR(Check(frame->Commit(), error));
  RK_RETURN_IF_ERROR(Check(encoder->Commit(), error));
  STATSTG info{};
  RK_RETURN_IF_ERROR(Check(stream->Stat(&info, STATFLAG_NONAME), error));
  if (info.cbSize.QuadPart > kMaxCompressedBytes)
    return Error{ErrorCode::kLimitExceeded, error, ErrorReason::kFileTooLarge};

  return {};
}

Result<void> EncodeWebp(const std::filesystem::path& path,
                        const cv::Mat& image,
                        const PhotoCancelled& cancelled) {
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  WebPConfig config;
  WebPPicture picture;
  if (!WebPConfigInit(&config) || !WebPPictureInit(&picture))
    return Error{ErrorCode::kUnavailable, "photo-imaging-unavailable"};
  struct PictureCleanup {
    WebPPicture& picture;
    ~PictureCleanup() { WebPPictureFree(&picture); }
  } cleanup{picture};
  config.quality = 85;
  config.method = 2;
  config.use_sharp_yuv = 0;
  config.thread_level = 0;
  picture.width = image.cols;
  picture.height = image.rows;
  picture.use_argb = 1;
  if (!WebPPictureImportBGR(&picture, image.data, static_cast<int>(image.step)))
    return Error{ErrorCode::kUnavailable, "photo-output-failed"};
  struct Output {
    std::ofstream file;
    std::size_t bytes = 0;
    const PhotoCancelled& cancelled;
  } output{std::ofstream(path, std::ios::binary | std::ios::trunc), 0, cancelled};
  if (!output.file)
    return Error{ErrorCode::kUnavailable, "photo-output-failed"};
  picture.custom_ptr = &output;
  picture.writer = [](const std::uint8_t* data, std::size_t size, const WebPPicture* picture) {
    auto& output = *static_cast<Output*>(picture->custom_ptr);
    if ((output.cancelled && output.cancelled()) || size > kMaxCompressedBytes - output.bytes)
      return 0;
    output.file.write(reinterpret_cast<const char*>(data), static_cast<std::streamsize>(size));
    output.bytes += size;
    return output.file ? 1 : 0;
  };
  picture.progress_hook = [](int, const WebPPicture* picture) {
    const auto& output = *static_cast<const Output*>(picture->custom_ptr);
    return output.cancelled && output.cancelled() ? 0 : 1;
  };
  const int encoded = WebPEncode(&config, &picture);
  output.file.close();
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  if (!encoded || !output.file)
    return Error{ErrorCode::kUnavailable, "photo-output-failed"};
  return {};
}

cv::Mat LimitSide(const cv::Mat& image, int side) {
  const int longest = std::max(image.cols, image.rows);
  if (longest <= side)
    return image;
  cv::Mat result;
  cv::resize(image, result,
             {std::max(4, image.cols * side / longest), std::max(4, image.rows * side / longest)},
             0, 0, cv::INTER_AREA);
  return result;
}

Result<void> WriteThumbnail(IWICImagingFactory& factory,
                            const std::filesystem::path& output,
                            cv::Mat& image,
                            const PhotoCancelled& cancelled) {
  for (const int side : {kThumbnailSide, 240, 160}) {
    const int longest = std::max(image.cols, image.rows);
    if (longest > side) {
      const cv::Size size{static_cast<int>(ScaleSide(image.cols, longest, side)),
                          static_cast<int>(ScaleSide(image.rows, longest, side))};
      cv::resize(image, image, size, 0, 0, cv::INTER_AREA);
    }
    for (const float quality : {0.88f, 0.73f}) {
      RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
      ComPtr<IStream> stream;
      RK_RETURN_IF_ERROR(
          Check(CreateStreamOnHGlobal(nullptr, TRUE, &stream), kThumbnailOutputError));
      RK_RETURN_IF_ERROR(EncodeJpeg(factory, *stream.Get(), image, quality, kThumbnailOutputError));
      STATSTG info{};
      RK_RETURN_IF_ERROR(Check(stream->Stat(&info, STATFLAG_NONAME), kThumbnailOutputError));
      if (info.cbSize.QuadPart > kMaxThumbnailBytes)
        continue;
      const auto size = static_cast<ULONG>(info.cbSize.QuadPart);
      if (!size)
        return Error{ErrorCode::kInternal, kThumbnailOutputError};
      std::vector<char> encoded(size);
      RK_RETURN_IF_ERROR(Check(stream->Seek({}, STREAM_SEEK_SET, nullptr), kThumbnailOutputError));
      ULONG read = 0;
      RK_RETURN_IF_ERROR(Check(stream->Read(encoded.data(), size, &read), kThumbnailOutputError));
      if (read != size)
        return Error{ErrorCode::kInternal, kThumbnailOutputError};
      RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
      std::ofstream file(output, std::ios::binary | std::ios::trunc);
      file.write(encoded.data(), size);
      file.close();
      if (!file)
        return Error{ErrorCode::kUnavailable, kThumbnailOutputError};
      return {};
    }
  }
  return Error{ErrorCode::kLimitExceeded, kThumbnailOutputError, ErrorReason::kFileTooLarge};
}

double Median(std::vector<double> values) {
  const auto mid = values.begin() + values.size() / 2;
  std::nth_element(values.begin(), mid, values.end());
  return *mid;
}

struct Detail {
  double strength;
  double fine_ratio;
  double noise;
};

Detail AnalyzeDetail(const cv::Mat& gray) {
  cv::Mat low, dx, dy, fine, broad, residual;
  cv::GaussianBlur(gray, low, {5, 5}, 1.1);
  cv::Sobel(gray, dx, CV_32F, 1, 0, 3, 0.125);
  cv::Sobel(gray, dy, CV_32F, 0, 1, 3, 0.125);
  cv::magnitude(dx, dy, fine);
  cv::Sobel(low, dx, CV_32F, 1, 0, 3, 0.125);
  cv::Sobel(low, dy, CV_32F, 0, 1, 3, 0.125);
  cv::magnitude(dx, dy, broad);
  cv::absdiff(gray, low, residual);

  std::vector<double> detail_regions, fine_ratios, noise_regions;
  for (int row = 0; row < 4; ++row) {
    for (int col = 0; col < 4; ++col) {
      const int x = col * gray.cols / 4, y = row * gray.rows / 4;
      const cv::Rect tile{x, y, (col + 1) * gray.cols / 4 - x, (row + 1) * gray.rows / 4 - y};
      // Coherent edges remain visible after low pass filtering. A flat-region
      // residual estimates the noise floor without counting text edges.
      const cv::Mat edges = broad(tile) > 9.0;
      const int edge_count = cv::countNonZero(edges);
      const cv::Mat flat = broad(tile) < 2.0;
      if (cv::countNonZero(flat) >= tile.area() / 5)
        noise_regions.push_back(cv::mean(residual(tile), flat)[0]);
      const double coverage = static_cast<double>(edge_count) / tile.area();
      if (coverage < 0.006) {
        detail_regions.push_back(0);
        continue;
      }
      const double fine_strength = cv::mean(fine(tile), edges)[0];
      const double broad_strength = cv::mean(broad(tile), edges)[0];
      const double strength = std::sqrt(std::min(coverage, 0.30) / 0.30) * fine_strength;
      detail_regions.push_back(strength);
      // Wide motion or focus blur suppresses this fine/coarse response.
      fine_ratios.push_back(fine_strength / broad_strength);
    }
  }
  std::sort(detail_regions.begin(), detail_regions.end());
  const double upper = std::accumulate(detail_regions.end() - 4, detail_regions.end(), 0.0) / 4;
  const double distributed = (upper + detail_regions[8]) * 0.5;
  return {std::clamp(distributed / 38, 0.0, 1.0),
          fine_ratios.empty() ? 0.0 : std::clamp((Median(fine_ratios) - 1.02) / 0.50, 0.0, 1.0),
          noise_regions.empty() ? 0.0 : Median(noise_regions)};
}

cv::Mat CompositionSignature(const cv::Mat& image) {
  cv::Mat signature;
  cv::resize(image, signature, {kSignatureSize, kSignatureSize}, 0, 0, cv::INTER_AREA);
  cv::cvtColor(signature, signature, cv::COLOR_BGR2YCrCb);
  signature.convertTo(signature, CV_32FC3);
  // A small exposure difference does not make a separate scene.
  signature -= cv::Scalar(cv::mean(signature)[0], 0, 0);
  return signature;
}

double MeasureBurstQuality(const cv::Mat& image) {
  cv::Mat gray;
  cv::cvtColor(image, gray, cv::COLOR_BGR2GRAY);
  const auto detail = AnalyzeDetail(gray);
  const double mean = cv::mean(gray)[0];
  const double clipped_dark = static_cast<double>(cv::countNonZero(gray <= 8)) / gray.total();
  const double clipped_light = static_cast<double>(cv::countNonZero(gray >= 249)) / gray.total();
  const double exposure =
      std::clamp(std::min({mean / 72, (255 - mean) / 32, (1 - clipped_dark) / 0.70,
                           (1 - clipped_light) / 0.55}),
                 0.0, 1.0);
  const double coherent = std::clamp(std::sqrt(detail.strength * 1.35), 0.0, 1.0);
  const double noise_penalty = std::clamp((detail.noise - 1.8) / 13, 0.0, 0.8);
  return coherent * (0.42 + 0.58 * detail.fine_ratio) * exposure * (1 - noise_penalty);
}

bool NearIdentical(const cv::Mat& a, const cv::Mat& b) {
  const cv::Rect center{1, 1, kSignatureSize - 2, kSignatureSize - 2};
  for (int y = 0; y <= 2; ++y) {
    for (int x = 0; x <= 2; ++x) {
      cv::Mat difference;
      cv::absdiff(a(center), b(cv::Rect{x, y, center.width, center.height}), difference);
      const auto mean = cv::mean(difference);
      if (mean[0] >= 12 || mean[1] + mean[2] >= 14)
        continue;
      // A meaningful subject change may occupy just one part of the frame.
      bool local_change = false;
      for (int top = 0; top + 6 <= center.height; top += 4) {
        for (int left = 0; left + 6 <= center.width; left += 4) {
          const auto local = cv::mean(difference(cv::Rect{left, top, 6, 6}));
          local_change |= local[0] >= 30 || local[1] + local[2] >= 30;
        }
      }
      if (!local_change)
        return true;
    }
  }
  return false;
}

}  // namespace

struct PhotoBurstAnalyzer::Impl {
  struct Observation {
    PhotoBurstCandidate candidate;
    cv::Mat signature;
  };

  void Prune(const std::vector<std::string>& available) {
    std::erase_if(observations, [&](const auto& observation) {
      return std::find(available.begin(), available.end(), observation.candidate.frame_id) ==
             available.end();
    });
  }

  Result<PhotoBurstDecision> Decide(bool high_quality_agreement) const {
    if (observations.empty())
      return Error{ErrorCode::kInvalidRequest, "invalid-photo-count"};
    constexpr double kLowQuality = 0.26;
    constexpr double kCloseQuality = 0.095;
    const auto& best = observations.front().candidate;
    PhotoBurstDecision decision;
    decision.selected_frame_id = best.frame_id;
    decision.keep_frame_ids.push_back(best.frame_id);
    decision.candidates.push_back(best);
    if (best.score < kLowQuality) {
      decision.reason = "low-quality";
      return decision;
    }
    if (observations.size() == 2) {
      const auto& alternative = observations.back().candidate;
      if (alternative.score >= kLowQuality && best.score - alternative.score <= kCloseQuality) {
        decision.uncertain = true;
        decision.reason = "close-quality";
        decision.candidates.push_back(alternative);
        decision.keep_frame_ids.push_back(alternative.frame_id);
        return decision;
      }
    }
    decision.stop = high_quality_agreement;
    decision.reason = high_quality_agreement ? "good-quality" : "clear-winner";
    return decision;
  }

  std::vector<std::string> seen;
  std::vector<Observation> observations;
};

PhotoBurstAnalyzer::PhotoBurstAnalyzer() : impl_(std::make_unique<Impl>()) {}
PhotoBurstAnalyzer::~PhotoBurstAnalyzer() = default;

Result<PhotoBurstDecision> PhotoBurstAnalyzer::Observe(const std::string& frame_id,
                                                       std::span<const std::uint8_t> encoded,
                                                       const std::vector<std::string>& available,
                                                       const PhotoCancelled& cancelled) {
  if (impl_->seen.size() >= 20)
    return Error{ErrorCode::kLimitExceeded, "invalid-photo-count"};
  if (frame_id.empty() || frame_id.size() > 128 || available.size() > 3 ||
      std::find(available.begin(), available.end(), frame_id) == available.end() ||
      std::find(impl_->seen.begin(), impl_->seen.end(), frame_id) != impl_->seen.end())
    return Error{ErrorCode::kInvalidRequest, "invalid-photo-frame"};
  if (encoded.size() > kMaxAnalysisBytes)
    return Error{ErrorCode::kLimitExceeded, "Photo sample exceeds byte limit",
                 ErrorReason::kFileTooLarge};
  Imaging imaging;
  RK_RETURN_IF_ERROR(imaging.Open());
  RK_ASSIGN_OR_RETURN(image, DecodeMemory(*imaging.factory.Get(), encoded, cancelled, false, true));
  const double score = MeasureBurstQuality(image);
  const auto signature = CompositionSignature(image);
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  impl_->seen.push_back(frame_id);
  impl_->Prune(available);
  auto& observations = impl_->observations;
  constexpr double kGoodQuality = 0.60;
  const bool agrees_with_best =
      !observations.empty() && observations.front().candidate.score >= kGoodQuality &&
      score >= kGoodQuality && NearIdentical(observations.front().signature, signature);
  auto duplicate = std::find_if(observations.begin(), observations.end(), [&](const auto& prior) {
    return NearIdentical(prior.signature, signature);
  });
  if (duplicate != observations.end()) {
    if (duplicate->candidate.score < score)
      *duplicate = {{frame_id, score}, signature};
  } else if (observations.size() < 2) {
    observations.push_back({{frame_id, score}, signature});
  } else if (observations.back().candidate.score < score) {
    observations.back() = {{frame_id, score}, signature};
  }
  std::stable_sort(observations.begin(), observations.end(), [](const auto& a, const auto& b) {
    return a.candidate.score > b.candidate.score;
  });
  if (observations.size() == 2 &&
      NearIdentical(observations.front().signature, observations.back().signature))
    observations.pop_back();
  // The next availability report acknowledges which originals the client
  // actually retained. Until then a lost response can leave both available.
  return impl_->Decide(agrees_with_best);
}

Result<PhotoBurstDecision> PhotoBurstAnalyzer::Finish(const std::vector<std::string>& available) {
  if (available.size() > 3)
    return Error{ErrorCode::kLimitExceeded, "Too many retained photo frames"};
  impl_->Prune(available);
  return impl_->Decide(false);
}

Result<PhotoProcessResult> ProcessPhoto(const std::filesystem::path& input,
                                        const std::filesystem::path& output,
                                        PhotoMode mode,
                                        std::optional<unsigned> quarter_turns,
                                        const PhotoCancelled& cancelled) {
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  if (quarter_turns && *quarter_turns > 3)
    return Error{ErrorCode::kInvalidRequest, "invalid-photo-quarter-turns"};
  std::error_code equivalent_error;
  if (std::filesystem::equivalent(input, output, equivalent_error))
    return Error{ErrorCode::kInvalidRequest, "Photo input and output refer to the same file"};
  static std::counting_semaphore<2> jobs(2);
  while (!jobs.try_acquire_for(std::chrono::milliseconds(25)))
    RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  struct ReleaseJob {
    ~ReleaseJob() { jobs.release(); }
  } release_job;
  try {
    Imaging imaging;
    RK_RETURN_IF_ERROR(imaging.Open());
    RK_ASSIGN_OR_RETURN(image, Decode(*imaging.factory.Get(), input, cancelled));
    unsigned turns = 0;
    bool text_orientation = false;
    if (quarter_turns) {
      turns = *quarter_turns;
    } else {
      RK_ASSIGN_OR_RETURN(automatic, photo::AutomaticQuarterTurns(image, cancelled));
      turns = automatic.value_or(0);
      text_orientation = automatic.has_value();
    }
    RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
    if (turns)
      cv::rotate(image, image,
                 turns == 1   ? cv::ROTATE_90_CLOCKWISE
                 : turns == 2 ? cv::ROTATE_180
                              : cv::ROTATE_90_COUNTERCLOCKWISE);
    std::string geometry = "unchanged";
    if (mode == PhotoMode::kScan) {
      RK_ASSIGN_OR_RETURN(page, photo::AnalyzeGeometry(image, cancelled));
      RK_ASSIGN_OR_RETURN(rectified,
                          photo::ApplyGeometry(image, page, page.paper_color, cancelled));
      image = std::move(rectified);
      geometry = page.kind;
      RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
      image = LimitSide(image, 2480);
      RK_ASSIGN_OR_RETURN(paper, photo::AnalyzePaper(image, cancelled));
      RK_RETURN_IF_ERROR(photo::EnhanceScan(image, paper, cancelled));
    }
    RK_RETURN_IF_ERROR(EncodeWebp(output, image, cancelled));
    return PhotoProcessResult{static_cast<std::uint32_t>(image.cols),
                              static_cast<std::uint32_t>(image.rows), geometry, turns,
                              quarter_turns      ? "manual"
                              : text_orientation ? "text"
                                                 : "none"};
  } catch (const cv::Exception&) {
    return Error{ErrorCode::kUnavailable, "photo-processing-failed"};
  } catch (const std::bad_alloc&) {
    return Error{ErrorCode::kUnavailable, "photo-processing-failed"};
  }
}

Result<PhotoProcessResult> TranscodePhoto(const std::filesystem::path& input,
                                          const std::filesystem::path& output,
                                          PhotoTranscode format,
                                          const PhotoCancelled& cancelled) {
  std::error_code equivalent_error;
  if (std::filesystem::equivalent(input, output, equivalent_error))
    return Error{ErrorCode::kInvalidRequest, "Photo input and output refer to the same file"};
  Imaging imaging;
  RK_RETURN_IF_ERROR(imaging.Open());
  RK_ASSIGN_OR_RETURN(image, Decode(*imaging.factory.Get(), input, cancelled));
  if (format == PhotoTranscode::kPng) {
    RK_RETURN_IF_ERROR(EncodePng(*imaging.factory.Get(), output, image, cancelled));
  } else {
    ComPtr<IWICStream> stream;
    RK_RETURN_IF_ERROR(Check(imaging.factory->CreateStream(&stream)));
    RK_RETURN_IF_ERROR(Check(stream->InitializeFromFilename(output.c_str(), GENERIC_WRITE)));
    RK_RETURN_IF_ERROR(
        EncodeJpeg(*imaging.factory.Get(), *stream.Get(), image, 0.92f, "photo-output-failed"));
  }
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  return PhotoProcessResult{static_cast<std::uint32_t>(image.cols),
                            static_cast<std::uint32_t>(image.rows), "unchanged"};
}

Result<PhotoProcessResult> CreatePhotoThumbnail(const std::filesystem::path& input,
                                                const std::filesystem::path& output,
                                                const PhotoCancelled& cancelled) {
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  std::error_code equivalent_error;
  if (std::filesystem::equivalent(input, output, equivalent_error))
    return Error{ErrorCode::kInternal, kThumbnailOutputError};
  Imaging imaging;
  RK_RETURN_IF_ERROR(imaging.Open("photo_imaging_unavailable"));
  RK_ASSIGN_OR_RETURN(image, Decode(*imaging.factory.Get(), input, cancelled, true));
  RK_RETURN_IF_ERROR(WriteThumbnail(*imaging.factory.Get(), output, image, cancelled));
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  return PhotoProcessResult{
      static_cast<std::uint32_t>(image.cols), static_cast<std::uint32_t>(image.rows), {}};
}

}  // namespace remotekit
