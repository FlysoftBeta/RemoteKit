#include "remotekit/photo_processing.hpp"

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
#include <stdexcept>
#include <utility>

namespace remotekit {
namespace {

using Microsoft::WRL::ComPtr;
using Quad = std::array<cv::Point2f, 4>;

constexpr int kMaxPixels = 4 * 1024 * 1024;
constexpr int kMaxDimension = 8192;
constexpr std::streamoff kMaxCompressedBytes = 24 * 1024 * 1024;
constexpr int kThumbnailSide = 320;
constexpr ULONG kMaxThumbnailBytes = 64 * 1024;
constexpr char kThumbnailOutputError[] = "photo_output_failed";
constexpr int kSignatureSize = 24;

void Check(HRESULT result, const char* error = "invalid-photo") {
  if (FAILED(result))
    throw std::runtime_error(error);
}

void CheckCancelled(const PhotoCancelled& cancelled) {
  if (cancelled && cancelled())
    throw std::runtime_error("cancelled");
}

class Imaging {
 public:
  explicit Imaging(const char* error = "photo-imaging-unavailable") {
    const auto result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (result != RPC_E_CHANGED_MODE)
      Check(result, error);
    initialized_ = SUCCEEDED(result);
    const auto factory_result =
        CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                         IID_PPV_ARGS(&factory));
    if (FAILED(factory_result)) {
      if (initialized_)
        CoUninitialize();
      Check(factory_result, error);
    }
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

unsigned PngOrientation(std::span<const BYTE> png) {
  // WIC's PNG metadata readers do not expose TIFF tags consistently. Read
  // only the inline orientation short from IFD0 in a bounded eXIf chunk.
  for (std::size_t offset = 8; png.size() - offset >= 12;) {
    std::size_t length = 0;
    for (std::size_t i = 0; i < 4; ++i)
      length = length * 256 + png[offset + i];
    if (length > png.size() - offset - 12)
      break;
    const auto* tag = png.data() + offset + 4;
    if (tag[0] == 'e' && tag[1] == 'X' && tag[2] == 'I' && tag[3] == 'f') {
      const auto tiff = png.subspan(offset + 8, length);
      if (tiff.size() < 8)
        break;
      const bool little = tiff[0] == 'I' && tiff[1] == 'I';
      if (!little && !(tiff[0] == 'M' && tiff[1] == 'M'))
        break;
      const auto number = [&](std::size_t start, std::size_t bytes) {
        std::uint32_t value = 0;
        for (std::size_t i = 0; i < bytes; ++i)
          value = value * 256 + tiff[start + (little ? bytes - i - 1 : i)];
        return value;
      };
      if (number(2, 2) != 42)
        break;
      const std::size_t ifd = number(4, 4);
      if (ifd < 8 || ifd > tiff.size() - 2)
        break;
      const auto count = number(ifd, 2);
      if (count > (tiff.size() - ifd - 2) / 12)
        break;
      for (std::size_t i = 0; i < count; ++i) {
        const auto entry = ifd + 2 + i * 12;
        if (number(entry, 2) == 274 && number(entry + 2, 2) == 3 && number(entry + 4, 4) == 1)
          return number(entry + 8, 2);
      }
      break;
    }
    offset += length + 12;
  }
  return 1;
}

UINT ScaleSide(UINT dimension, UINT longest, UINT target) {
  return std::max(1u, (dimension * target + longest / 2) / longest);
}

void Orient(cv::Mat& image, unsigned orientation) {
  switch (orientation) {
    case 2: cv::flip(image, image, 1); break;
    case 3: cv::rotate(image, image, cv::ROTATE_180); break;
    case 4: cv::flip(image, image, 0); break;
    case 5: cv::transpose(image, image); break;
    case 6: cv::rotate(image, image, cv::ROTATE_90_CLOCKWISE); break;
    case 7:
      cv::transpose(image, image);
      cv::flip(image, image, -1);
      break;
    case 8: cv::rotate(image, image, cv::ROTATE_90_COUNTERCLOCKWISE); break;
    default: break;
  }
}

cv::Mat Decode(IWICImagingFactory& factory, const std::filesystem::path& path,
               const PhotoCancelled& cancelled, bool thumbnail = false) {
  const char* invalid = thumbnail ? "invalid_photo" : "invalid-photo";
  const char* too_large = thumbnail ? "photo_too_large" : "photo-too-large";
  CheckCancelled(cancelled);
  std::ifstream input(path, std::ios::binary | std::ios::ate);
  if (!input)
    throw std::runtime_error(invalid);
  const std::streamoff bytes = input.tellg();
  if (bytes > kMaxCompressedBytes)
    throw std::runtime_error(too_large);
  if (bytes < 8)
    throw std::runtime_error(invalid);
  constexpr std::array<BYTE, 8> png_signature{137, 80, 78, 71, 13, 10, 26, 10};
  std::array<BYTE, 8> signature{};
  input.seekg(0);
  if (!input.read(reinterpret_cast<char*>(signature.data()), signature.size()))
    throw std::runtime_error(invalid);
  const bool jpeg = signature[0] == 0xff && signature[1] == 0xd8 && signature[2] == 0xff;
  if (!jpeg && signature != png_signature)
    throw std::runtime_error(invalid);
  std::vector<BYTE> compressed(static_cast<std::size_t>(bytes));
  input.seekg(0);
  if (!input.read(reinterpret_cast<char*>(compressed.data()), bytes))
    throw std::runtime_error(invalid);

  ComPtr<IWICStream> stream;
  ComPtr<IWICBitmapDecoder> decoder;
  ComPtr<IWICBitmapFrameDecode> frame;
  Check(factory.CreateStream(&stream), invalid);
  Check(stream->InitializeFromMemory(compressed.data(), static_cast<DWORD>(compressed.size())), invalid);
  Check(factory.CreateDecoder(jpeg ? GUID_ContainerFormatJpeg : GUID_ContainerFormatPng,
                              &GUID_VendorMicrosoft, &decoder), invalid);
  Check(decoder->Initialize(stream.Get(), WICDecodeMetadataCacheOnDemand), invalid);
  UINT frame_count = 0;
  Check(decoder->GetFrameCount(&frame_count), invalid);
  if (frame_count != 1)
    throw std::runtime_error(invalid);
  Check(decoder->GetFrame(0, &frame), invalid);
  UINT width = 0, height = 0;
  Check(frame->GetSize(&width, &height), invalid);
  const UINT max_dimension = thumbnail ? 16384 : kMaxDimension;
  const auto max_pixels = thumbnail ? 32 * 1024 * 1024 : kMaxPixels;
  if (width > max_dimension || height > max_dimension ||
      static_cast<std::uint64_t>(width) * height > max_pixels)
    throw std::runtime_error(too_large);
  const UINT min_dimension = thumbnail ? 1 : 32;
  if (width < min_dimension || height < min_dimension)
    throw std::runtime_error(invalid);
  CheckCancelled(cancelled);
  ComPtr<IWICFormatConverter> converter;
  const bool flatten_alpha = thumbnail && !jpeg;
  Check(factory.CreateFormatConverter(&converter), invalid);
  Check(converter->Initialize(frame.Get(), flatten_alpha ? GUID_WICPixelFormat32bppPBGRA
                                                         : GUID_WICPixelFormat24bppBGR,
                              WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom), invalid);
  IWICBitmapSource* pixels = converter.Get();
  ComPtr<IWICBitmapScaler> scaler;
  const UINT longest = std::max(width, height);
  if (thumbnail && longest > kThumbnailSide) {
    width = ScaleSide(width, longest, kThumbnailSide);
    height = ScaleSide(height, longest, kThumbnailSide);
    Check(factory.CreateBitmapScaler(&scaler), invalid);
    Check(scaler->Initialize(pixels, width, height, WICBitmapInterpolationModeFant), invalid);
    pixels = scaler.Get();
  }
  cv::Mat image(static_cast<int>(height), static_cast<int>(width), flatten_alpha ? CV_8UC4 : CV_8UC3);
  Check(pixels->CopyPixels(nullptr, static_cast<UINT>(image.step),
                           static_cast<UINT>(image.total() * image.elemSize()), image.data), invalid);
  CheckCancelled(cancelled);
  if (flatten_alpha) {
    cv::Mat opaque(image.size(), CV_8UC3);
    for (int y = 0; y < image.rows; ++y) {
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
  else if (thumbnail)
    Orient(image, PngOrientation(compressed));
  return image;
}

void EncodeJpeg(IWICImagingFactory& factory, IStream& stream, const cv::Mat& image,
                float compression_quality, const char* error) {
  ComPtr<IWICBitmapEncoder> encoder;
  ComPtr<IWICBitmapFrameEncode> frame;
  ComPtr<IPropertyBag2> properties;
  Check(factory.CreateEncoder(GUID_ContainerFormatJpeg, &GUID_VendorMicrosoft, &encoder), error);
  Check(encoder->Initialize(&stream, WICBitmapEncoderNoCache), error);
  Check(encoder->CreateNewFrame(&frame, &properties), error);
  wchar_t quality_name[] = L"ImageQuality";
  PROPBAG2 option{};
  option.pstrName = quality_name;
  VARIANT quality{};
  quality.vt = VT_R4;
  quality.fltVal = compression_quality;
  Check(properties->Write(1, &option, &quality), error);
  Check(frame->Initialize(properties.Get()), error);
  Check(frame->SetSize(image.cols, image.rows), error);
  WICPixelFormatGUID format = GUID_WICPixelFormat24bppBGR;
  Check(frame->SetPixelFormat(&format), error);
  if (format != GUID_WICPixelFormat24bppBGR)
    throw std::runtime_error(error);
  Check(frame->WritePixels(image.rows, static_cast<UINT>(image.step),
                           static_cast<UINT>(image.total() * image.elemSize()), image.data), error);
  Check(frame->Commit(), error);
  Check(encoder->Commit(), error);
}

void EncodeJpeg(IWICImagingFactory& factory, const std::filesystem::path& path,
                const cv::Mat& image) {
  constexpr char error[] = "photo-output-failed";
  ComPtr<IWICStream> stream;
  Check(factory.CreateStream(&stream), error);
  Check(stream->InitializeFromFilename(path.c_str(), GENERIC_WRITE), error);
  EncodeJpeg(factory, *stream.Get(), image, 0.92f, error);
}

cv::Mat LimitSide(const cv::Mat& image, int side) {
  const int longest = std::max(image.cols, image.rows);
  if (longest <= side)
    return image;
  cv::Mat result;
  cv::resize(image, result, {std::max(4, image.cols * side / longest),
                             std::max(4, image.rows * side / longest)}, 0, 0, cv::INTER_AREA);
  return result;
}

void WriteThumbnail(IWICImagingFactory& factory, const std::filesystem::path& output,
                    cv::Mat& image, const PhotoCancelled& cancelled) {
  for (const int side : {kThumbnailSide, 240, 160}) {
    const int longest = std::max(image.cols, image.rows);
    if (longest > side) {
      const cv::Size size{static_cast<int>(ScaleSide(image.cols, longest, side)),
                          static_cast<int>(ScaleSide(image.rows, longest, side))};
      cv::resize(image, image, size, 0, 0, cv::INTER_AREA);
    }
    for (const float quality : {0.88f, 0.73f}) {
      CheckCancelled(cancelled);
      ComPtr<IStream> stream;
      Check(CreateStreamOnHGlobal(nullptr, TRUE, &stream), kThumbnailOutputError);
      EncodeJpeg(factory, *stream.Get(), image, quality, kThumbnailOutputError);
      STATSTG info{};
      Check(stream->Stat(&info, STATFLAG_NONAME), kThumbnailOutputError);
      if (info.cbSize.QuadPart > kMaxThumbnailBytes)
        continue;
      const auto size = static_cast<ULONG>(info.cbSize.QuadPart);
      if (!size)
        throw std::runtime_error(kThumbnailOutputError);
      std::vector<char> encoded(size);
      Check(stream->Seek({}, STREAM_SEEK_SET, nullptr), kThumbnailOutputError);
      ULONG read = 0;
      Check(stream->Read(encoded.data(), size, &read), kThumbnailOutputError);
      if (read != size)
        throw std::runtime_error(kThumbnailOutputError);
      CheckCancelled(cancelled);
      std::ofstream file(output, std::ios::binary | std::ios::trunc);
      file.write(encoded.data(), size);
      file.close();
      if (!file)
        throw std::runtime_error(kThumbnailOutputError);
      return;
    }
  }
  throw std::runtime_error(kThumbnailOutputError);
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

struct Quality {
  PhotoRankCandidate rank;
  cv::Mat signature;
};

Quality Measure(const cv::Mat& image, std::size_t index) {
  cv::Mat gray;
  cv::cvtColor(LimitSide(image, 768), gray, cv::COLOR_BGR2GRAY);
  const auto detail = AnalyzeDetail(gray);
  const auto coarse = AnalyzeDetail(LimitSide(gray, 384));
  const double black = static_cast<double>(cv::countNonZero(gray <= 5)) / gray.total();
  const double white = static_cast<double>(cv::countNonZero(gray >= 250)) / gray.total();
  const double midtone = cv::mean(gray)[0];
  const double exposure_loss = std::max({(black - 0.15) / 0.85, (white - 0.35) / 0.65,
                                         (48 - midtone) / 48, (midtone - 225) / 30, 0.0});
  const double noise_loss = std::clamp((detail.noise - 2.5) / 11, 0.0, 1.0);
  const double structure = 0.6 * detail.strength + 0.4 * coarse.strength;
  const double crispness = std::sqrt(structure) * (0.7 * detail.fine_ratio + 0.3 * coarse.fine_ratio);
  const double score = std::clamp(0.64 * std::sqrt(structure) + 0.36 * crispness -
                                  0.23 * exposure_loss - 0.24 * noise_loss, 0.0, 1.0);
  cv::Mat signature;
  cv::resize(image, signature, {kSignatureSize, kSignatureSize}, 0, 0, cv::INTER_AREA);
  cv::cvtColor(signature, signature, cv::COLOR_BGR2YCrCb);
  signature.convertTo(signature, CV_32FC3);
  // Compare composition and color without treating a small exposure change
  // as an alternate scene.
  const double luminance = cv::mean(signature)[0];
  signature -= cv::Scalar(luminance, 0, 0);
  return {{index, score}, std::move(signature)};
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

float Length(cv::Point2f vector) {
  return std::hypot(vector.x, vector.y);
}

bool ValidQuad(const Quad& quad, double minimum_area, double minimum_side) {
  double area = 0;
  for (std::size_t i = 0; i < quad.size(); ++i) {
    const auto& a = quad[i];
    const auto& b = quad[(i + 1) % 4];
    const auto& c = quad[(i + 2) % 4];
    const auto edge = b - a;
    const auto next = c - b;
    const double lengths = Length(edge) * Length(next);
    // A clockwise screen-space quad has positive cross products. Reject
    // self-intersections, pinched corners and extremely acute angles.
    if (Length(edge) < minimum_side || edge.cross(next) <= 0.26 * lengths)
      return false;
    area += a.cross(b);
  }
  return area * 0.5 >= minimum_area;
}

void StartAtTopLeft(Quad& quad) {
  const auto first = std::min_element(quad.begin(), quad.end(), [](auto a, auto b) {
    return a.x + a.y < b.x + b.y;
  });
  std::rotate(quad.begin(), first, quad.end());
}

double BoundaryScore(const cv::Mat& gray, const Quad& quad) {
  double weakest = 1;
  double mean_contrast = 0;
  for (std::size_t i = 0; i < quad.size(); ++i) {
    const auto a = quad[i], edge = quad[(i + 1) % 4] - a;
    const auto normal = cv::Point2f{-edge.y, edge.x} * (4.0f / Length(edge));
    int supporting = 0;
    for (int sample = 1; sample <= 19; ++sample) {
      const auto point = a + edge * (sample / 20.0f);
      const auto inside = point + normal, outside = point - normal;
      const int difference = std::abs(
          gray.at<std::uint8_t>(cvRound(inside.y), cvRound(inside.x)) -
          gray.at<std::uint8_t>(cvRound(outside.y), cvRound(outside.x)));
      supporting += difference >= 14;
      mean_contrast += std::min(difference, 65) / 65.0;
    }
    weakest = std::min(weakest, supporting / 19.0);
  }
  if (weakest < 0.58)
    return 0;
  return 0.6 * weakest + 0.4 * mean_contrast / 76;
}

struct DocumentCandidate {
  Quad quad;
  double score;
};

void CollectDocuments(const cv::Mat& gray, cv::Mat mask,
                      std::vector<DocumentCandidate>& candidates) {
  std::vector<std::vector<cv::Point>> contours;
  cv::findContours(mask, contours, cv::RETR_LIST, cv::CHAIN_APPROX_SIMPLE);
  const double frame_area = gray.total();
  for (const auto& contour : contours) {
    const double coverage = std::abs(cv::contourArea(contour)) / frame_area;
    if (coverage < 0.16 || coverage > 0.94)
      continue;
    std::vector<cv::Point> polygon;
    cv::approxPolyDP(contour, polygon, 0.018 * cv::arcLength(contour, true), true);
    if (polygon.size() != 4 || !cv::isContourConvex(polygon))
      continue;
    if (cv::contourArea(polygon, true) < 0)
      std::reverse(polygon.begin(), polygon.end());
    Quad quad;
    std::copy(polygon.begin(), polygon.end(), quad.begin());
    if (!ValidQuad(quad, 0.15 * frame_area, 0.12 * std::min(gray.cols, gray.rows)) ||
        std::any_of(quad.begin(), quad.end(), [&](auto p) {
          return p.x < 5 || p.y < 5 || p.x >= gray.cols - 5 || p.y >= gray.rows - 5;
        }))
      continue;
    const auto boundary = BoundaryScore(gray, quad);
    if (boundary < 0.58)
      continue;
    StartAtTopLeft(quad);
    candidates.push_back({quad, boundary + 0.25 * coverage});
  }
}

Quad DetectDocument(const cv::Mat& image) {
  cv::Mat gray, mask;
  cv::cvtColor(LimitSide(image, 800), gray, cv::COLOR_BGR2GRAY);
  cv::GaussianBlur(gray, gray, {5, 5}, 1.0);
  std::vector<DocumentCandidate> candidates;
  cv::Canny(gray, mask, 32, 96);
  cv::morphologyEx(mask, mask, cv::MORPH_CLOSE, cv::getStructuringElement(cv::MORPH_RECT, {5, 5}));
  CollectDocuments(gray, mask, candidates);
  cv::threshold(gray, mask, 0, 255, cv::THRESH_BINARY | cv::THRESH_OTSU);
  CollectDocuments(gray, mask, candidates);
  if (candidates.empty())
    throw std::runtime_error("no-document");
  std::sort(candidates.begin(), candidates.end(), [](const auto& a, const auto& b) {
    return a.score > b.score;
  });
  auto quad = candidates.front().quad;
  for (std::size_t i = 1; i < candidates.size() &&
                         candidates.front().score - candidates[i].score < 0.12; ++i) {
    const auto& other = candidates[i].quad;
    const std::vector<cv::Point2f> a(quad.begin(), quad.end()), b(other.begin(), other.end());
    std::vector<cv::Point2f> overlap;
    const double intersection = cv::intersectConvexConvex(a, b, overlap);
    const double union_area = cv::contourArea(a) + cv::contourArea(b) - intersection;
    if (intersection < 0.84 * union_area)
      throw std::runtime_error("no-document");
  }
  for (auto& point : quad) {
    point.x *= static_cast<float>(image.cols - 1) / (gray.cols - 1);
    point.y *= static_cast<float>(image.rows - 1) / (gray.rows - 1);
  }
  return quad;
}

Quad ManualQuad(const cv::Mat& image, const std::array<PhotoPoint, 4>& corners) {
  Quad quad;
  for (std::size_t i = 0; i < quad.size(); ++i) {
    const auto [x, y] = corners[i];
    if (!std::isfinite(x) || !std::isfinite(y) || x < 0 || x > 1 || y < 0 || y > 1)
      throw std::runtime_error("invalid-corners");
    quad[i] = {static_cast<float>(x * (image.cols - 1)), static_cast<float>(y * (image.rows - 1))};
  }
  if (!ValidQuad(quad, 32 * 32, 24))
    throw std::runtime_error("invalid-corners");
  StartAtTopLeft(quad);
  return quad;
}

cv::Mat Rectify(const cv::Mat& image, const Quad& quad) {
  const int width = cvRound(std::max(Length(quad[1] - quad[0]), Length(quad[2] - quad[3])));
  const int height = cvRound(std::max(Length(quad[3] - quad[0]), Length(quad[2] - quad[1])));
  const double scale = std::min({1.0, std::sqrt(static_cast<double>(kMaxPixels) / (width * height)),
                                static_cast<double>(kMaxDimension) / std::max(width, height)});
  const int out_width = static_cast<int>(width * scale);
  const int out_height = static_cast<int>(height * scale);
  if (out_width < 32 || out_height < 32)
    throw std::runtime_error("invalid-corners");
  const float x = static_cast<float>(out_width - 1), y = static_cast<float>(out_height - 1);
  const Quad destination{{{0, 0}, {x, 0}, {x, y}, {0, y}}};
  cv::Mat result;
  cv::warpPerspective(image, result, cv::getPerspectiveTransform(quad.data(), destination.data()),
                      {out_width, out_height}, cv::INTER_LINEAR, cv::BORDER_REPLICATE);
  return result;
}

cv::Mat Scan(const cv::Mat& image) {
  cv::Mat gray;
  cv::cvtColor(image, gray, cv::COLOR_BGR2GRAY);
  cv::Mat paper = LimitSide(gray, 256).clone();
  const int neighborhood = std::clamp(std::min(paper.cols, paper.rows) / 10, 7, 25) | 1;
  cv::morphologyEx(paper, paper, cv::MORPH_CLOSE,
                   cv::getStructuringElement(cv::MORPH_RECT, {neighborhood, neighborhood}));
  cv::GaussianBlur(paper, paper, {neighborhood, neighborhood}, 0);
  cv::resize(paper, paper, gray.size(), 0, 0, cv::INTER_LINEAR);
  for (int y = 0; y < gray.rows; ++y) {
    auto* pixels = gray.ptr<std::uint8_t>(y);
    const auto* white = paper.ptr<std::uint8_t>(y);
    for (int x = 0; x < gray.cols; ++x) {
      const float relative = static_cast<float>(pixels[x]) / std::max<int>(white[x], 45);
      // Soft local threshold: preserve antialiasing and faint markings.
      pixels[x] = cv::saturate_cast<std::uint8_t>((relative - 0.37f) * (255.0f / 0.58f));
    }
  }
  cv::Mat result;
  cv::cvtColor(gray, result, cv::COLOR_GRAY2BGR);
  return result;
}

}  // namespace

PhotoRankResult RankPhotos(std::span<const std::filesystem::path> inputs,
                          const PhotoCancelled& cancelled) {
  if (inputs.empty() || inputs.size() > 6)
    throw std::runtime_error("invalid-photo-count");
  CheckCancelled(cancelled);
  Imaging imaging;
  std::vector<Quality> qualities;
  qualities.reserve(inputs.size());
  for (std::size_t i = 0; i < inputs.size(); ++i) {
    const auto image = Decode(*imaging.factory.Get(), inputs[i], cancelled);
    CheckCancelled(cancelled);
    qualities.push_back(Measure(image, i));
  }
  CheckCancelled(cancelled);
  std::stable_sort(qualities.begin(), qualities.end(), [](const Quality& a, const Quality& b) {
    return a.rank.score > b.rank.score;
  });
  const auto& best = qualities.front().rank;
  PhotoRankResult result{best.index, false, {best}, "clear-winner"};
  if (best.score < 0.23) {
    result.reason = "low-quality";
    return result;
  }
  std::vector<std::size_t> selected{0};
  for (std::size_t i = 1; i < qualities.size() && selected.size() < 3; ++i) {
    const auto& candidate = qualities[i];
    if (candidate.rank.score < 0.23 || best.score - candidate.rank.score > 0.085)
      break;
    const bool duplicate = std::any_of(selected.begin(), selected.end(), [&](auto j) {
      return NearIdentical(candidate.signature, qualities[j].signature);
    });
    if (duplicate) {
      result.reason = "near-identical";
      continue;
    }
    selected.push_back(i);
    result.candidates.push_back(candidate.rank);
  }
  if (result.candidates.size() > 1) {
    result.uncertain = true;
    result.reason = "close-quality";
  }
  return result;
}

PhotoProcessResult ProcessPhoto(
    const std::filesystem::path& input, const std::filesystem::path& output, PhotoMode mode,
    const std::optional<std::array<PhotoPoint, 4>>& corners, const PhotoCancelled& cancelled) {
  CheckCancelled(cancelled);
  std::error_code equivalent_error;
  if (std::filesystem::equivalent(input, output, equivalent_error))
    throw std::runtime_error("photo-output-failed");
  Imaging imaging;
  auto image = Decode(*imaging.factory.Get(), input, cancelled);
  CheckCancelled(cancelled);
  const auto quad = corners ? ManualQuad(image, *corners) : DetectDocument(image);
  CheckCancelled(cancelled);
  image = Rectify(image, quad);
  CheckCancelled(cancelled);
  if (mode == PhotoMode::kScan)
    image = Scan(image);
  CheckCancelled(cancelled);
  EncodeJpeg(*imaging.factory.Get(), output, image);
  CheckCancelled(cancelled);
  return {static_cast<std::uint32_t>(image.cols), static_cast<std::uint32_t>(image.rows)};
}

PhotoProcessResult CreatePhotoThumbnail(const std::filesystem::path& input,
                                       const std::filesystem::path& output,
                                       const PhotoCancelled& cancelled) {
  CheckCancelled(cancelled);
  std::error_code equivalent_error;
  if (std::filesystem::equivalent(input, output, equivalent_error))
    throw std::runtime_error(kThumbnailOutputError);
  Imaging imaging("photo_imaging_unavailable");
  auto image = Decode(*imaging.factory.Get(), input, cancelled, true);
  WriteThumbnail(*imaging.factory.Get(), output, image, cancelled);
  CheckCancelled(cancelled);
  return {static_cast<std::uint32_t>(image.cols), static_cast<std::uint32_t>(image.rows)};
}

}  // namespace remotekit
