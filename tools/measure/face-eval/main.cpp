// Numeric-only evaluation. No pixel, embedding, metadata or image-file output.
#include "auth/face_engine.hpp"
#include "auth/face_policy.hpp"

#include <windows.h>
#include <wincodec.h>
#include <wrl/client.h>
#include <io.h>
#include <fcntl.h>
#include <webp/decode.h>
#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <string_view>
#include <vector>
namespace fs = std::filesystem;
using Microsoft::WRL::ComPtr;
void Check(HRESULT hr) {
  if (FAILED(hr))
    throw std::runtime_error("WIC failure");
}

// Skip APP0..APP15 and COM by segment length without interpreting their payload.
// No metadata/EXIF API is ever called; WIC only receives the stripped JPEG.
std::vector<BYTE> StripMetadata(const std::vector<BYTE>& src) {
  if (src.size() < 4 || src[0] != 255 || src[1] != 216)
    throw std::runtime_error("JPEG required");
  std::vector<BYTE> out{255, 216};
  size_t p = 2;
  while (p < src.size()) {
    size_t start = p;
    if (src[p++] != 255)
      throw std::runtime_error("JPEG marker");
    while (p < src.size() && src[p] == 255)
      ++p;
    if (p == src.size())
      throw std::runtime_error("JPEG truncated");
    BYTE tag = src[p++];
    if (tag == 218 || tag == 217) {
      out.insert(out.end(), src.begin() + start, src.end());
      return out;
    }
    if (tag == 1 || (tag >= 208 && tag <= 215)) {
      out.insert(out.end(), src.begin() + start, src.begin() + p);
      continue;
    }
    if (p + 2 > src.size())
      throw std::runtime_error("JPEG truncated");
    size_t n = size_t(src[p]) * 256 + src[p + 1];
    if (n < 2 || n > src.size() - p)
      throw std::runtime_error("JPEG length");
    if (!((tag >= 224 && tag <= 239) || tag == 254))
      out.insert(out.end(), src.begin() + start, src.begin() + p + n);
    p += n;
  }
  throw std::runtime_error("JPEG scan missing");
}
struct Imaging {
  ComPtr<IWICImagingFactory> factory;
  Imaging() {
    Check(CoInitializeEx(nullptr, COINIT_MULTITHREADED));
    Check(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                           IID_PPV_ARGS(&factory)));
  }
  ~Imaging() {
    factory.Reset();
    CoUninitialize();
  }
  cv::Mat Decode(const std::vector<BYTE>& raw) {
    auto bytes = StripMetadata(raw);
    ComPtr<IWICStream> stream;
    ComPtr<IWICBitmapDecoder> decoder;
    ComPtr<IWICBitmapFrameDecode> frame;
    ComPtr<IWICFormatConverter> converter;
    Check(factory->CreateStream(&stream));
    Check(stream->InitializeFromMemory(bytes.data(), DWORD(bytes.size())));
    Check(factory->CreateDecoderFromStream(stream.Get(), nullptr, WICDecodeMetadataCacheOnDemand,
                                           &decoder));
    Check(decoder->GetFrame(0, &frame));
    UINT w = 0, h = 0;
    Check(frame->GetSize(&w, &h));
    Check(factory->CreateFormatConverter(&converter));
    Check(converter->Initialize(frame.Get(), GUID_WICPixelFormat24bppBGR, WICBitmapDitherTypeNone,
                                nullptr, 0, WICBitmapPaletteTypeCustom));
    cv::Mat image(h, w, CV_8UC3);
    Check(converter->CopyPixels(nullptr, w * 3, w * h * 3, image.data));
    return image;
  }
  cv::Mat JPEG50(const cv::Mat& image) {
    ComPtr<IStream> stream;
    Check(CreateStreamOnHGlobal(nullptr, TRUE, &stream));
    ComPtr<IWICBitmapEncoder> encoder;
    ComPtr<IWICBitmapFrameEncode> frame;
    ComPtr<IPropertyBag2> properties;
    Check(factory->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, &encoder));
    Check(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache));
    Check(encoder->CreateNewFrame(&frame, &properties));
    PROPBAG2 prop{};
    prop.pstrName = const_cast<wchar_t*>(L"ImageQuality");
    VARIANT quality{};
    quality.vt = VT_R4;
    quality.fltVal = .5f;
    Check(properties->Write(1, &prop, &quality));
    Check(frame->Initialize(properties.Get()));
    Check(frame->SetSize(image.cols, image.rows));
    WICPixelFormatGUID format = GUID_WICPixelFormat24bppBGR;
    Check(frame->SetPixelFormat(&format));
    if (format != GUID_WICPixelFormat24bppBGR)
      throw std::runtime_error("JPEG format");
    Check(frame->WritePixels(image.rows, UINT(image.step), UINT(image.step * image.rows),
                             image.data));
    Check(frame->Commit());
    Check(encoder->Commit());
    STATSTG stat{};
    Check(stream->Stat(&stat, STATFLAG_NONAME));
    LARGE_INTEGER zero{};
    Check(stream->Seek(zero, STREAM_SEEK_SET, nullptr));
    std::vector<BYTE> bytes(size_t(stat.cbSize.QuadPart));
    ULONG read = 0;
    Check(stream->Read(bytes.data(), ULONG(bytes.size()), &read));
    return Decode(bytes);
  }
};

// Only structural chunk headers and pixel chunks are read. Metadata payloads are sought past.
cv::Mat ReadPrivateWebP(const fs::path& path) {
  std::ifstream stream(path, std::ios::binary);
  std::array<uint8_t, 12> riff{};
  if (!stream.read(reinterpret_cast<char*>(riff.data()), riff.size()) ||
      std::memcmp(riff.data(), "RIFF", 4) || std::memcmp(riff.data() + 8, "WEBP", 4))
    throw std::runtime_error("WebP input");
  std::vector<uint8_t> pixels;
  std::array<uint8_t, 8> header{};
  while (stream.read(reinterpret_cast<char*>(header.data()), header.size())) {
    uint32_t length = uint32_t(header[4]) | uint32_t(header[5]) << 8 | uint32_t(header[6]) << 16 |
                      uint32_t(header[7]) << 24;
    if (length > 256 * 1024 * 1024)
      throw std::runtime_error("WebP chunk");
    const bool image = !std::memcmp(header.data(), "VP8 ", 4) ||
                       !std::memcmp(header.data(), "VP8L", 4) ||
                       !std::memcmp(header.data(), "ALPH", 4);
    if (image) {
      pixels.insert(pixels.end(), header.begin(), header.end());
      const size_t start = pixels.size();
      pixels.resize(start + length + (length & 1));
      if (!stream.read(reinterpret_cast<char*>(pixels.data() + start), length + (length & 1)))
        throw std::runtime_error("WebP pixels");
    } else {
      stream.seekg(length + (length & 1), std::ios::cur);
    }
  }
  // A simple RIFF containing only the image chunks prevents decoder metadata access.
  std::vector<uint8_t> bytes{'R', 'I', 'F', 'F', 0, 0, 0, 0, 'W', 'E', 'B', 'P'};
  const uint32_t size = uint32_t(pixels.size() + 4);
  for (int i = 0; i < 4; ++i)
    bytes[4 + i] = uint8_t(size >> (i * 8));
  bytes.insert(bytes.end(), pixels.begin(), pixels.end());
  int width = 0, height = 0;
  uint8_t* decoded = WebPDecodeBGR(bytes.data(), bytes.size(), &width, &height);
  if (!decoded)
    throw std::runtime_error("WebP decode");
  cv::Mat result = cv::Mat(height, width, CV_8UC3, decoded).clone();
  WebPFree(decoded);
  return result;
}

using rk::auth::Engine;
using rk::auth::FaceGate;
using rk::auth::FaceInference;
using rk::auth::FacePolicy;
using rk::auth::FaceTemplate;
using rk::auth::Similarity;
using Gallery = std::vector<FaceTemplate>;
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;

struct Sample {
  FaceInference inference;
  uint64_t hash;
};
Sample Infer(Engine& engine, const cv::Mat& bgr) {
  cv::Mat rgb;
  cv::cvtColor(bgr, rgb, cv::COLOR_BGR2RGB);
  auto result = engine.InferRGB24(rgb.cols, rgb.rows, rgb.data);
  if (!result)
    throw std::runtime_error("inference");
  return {std::move(result).value(), rk::auth::Fingerprint({rgb.data, rgb.total() * 3})};
}

cv::Mat Camera(const cv::Mat& image, int width) {
  int crop_width = image.cols, crop_height = image.rows;
  if (crop_width * 3 > crop_height * 4)
    crop_width = crop_height * 4 / 3;
  else
    crop_height = crop_width * 3 / 4;
  cv::Mat result;
  cv::resize(image(cv::Rect((image.cols - crop_width) / 2, (image.rows - crop_height) / 2,
                            crop_width, crop_height)),
             result, {width, width * 3 / 4}, 0, 0, cv::INTER_AREA);
  return result;
}

cv::Mat Noise(const cv::Mat& image, double sigma, cv::RNG& rng) {
  cv::Mat noise(image.size(), CV_16SC3), converted, result;
  rng.fill(noise, cv::RNG::NORMAL, 0, sigma);
  image.convertTo(converted, CV_16SC3);
  cv::add(converted, noise, converted);
  converted.convertTo(result, CV_8UC3);
  return result;
}

cv::Mat Variant(const cv::Mat& image,
                int variant,
                const rk::auth::FaceDetection& face,
                Imaging& imaging) {
  cv::Mat result;
  if (variant == 0)
    return image.clone();
  if (variant <= 5) {
    const double iod = std::hypot(face[4] - face[6], face[5] - face[7]);
    if (iod <= 0)
      throw std::runtime_error("scale geometry unavailable");
    const double scale =
        std::min(1.0, std::array<double, 5>{60, 45, 35, 28, 22}[variant - 1] / iod);
    cv::Mat small;
    cv::resize(image, small, {}, scale, scale, cv::INTER_AREA);
    cv::copyMakeBorder(
        small, result, (image.rows - small.rows) / 2,
        image.rows - small.rows - (image.rows - small.rows) / 2, (image.cols - small.cols) / 2,
        image.cols - small.cols - (image.cols - small.cols) / 2, cv::BORDER_REPLICATE);
    cv::GaussianBlur(result, result, {0, 0}, 18);
    small.copyTo(result(cv::Rect((image.cols - small.cols) / 2, (image.rows - small.rows) / 2,
                                 small.cols, small.rows)));
  } else if (variant <= 9) {
    const double gamma = std::array<double, 4>{0.5, 0.7, 1.4, 2.0}[variant - 6];
    cv::Mat table(1, 256, CV_8U);
    for (int i = 0; i < 256; ++i)
      table.at<uint8_t>(i) = cv::saturate_cast<uint8_t>(255 * std::pow(i / 255.0, gamma));
    cv::LUT(image, table, result);
  } else if (variant <= 11) {
    image.convertTo(result, -1, variant == 10 ? 0.5 : 1.6);
  } else if (variant == 12) {
    result = image.clone();
    const double cx = face[0] + face[2] * 0.5;
    const double cy = std::max(0.0, double(face[1] - face[3] * 0.4));
    const double radius = std::max(image.cols * 0.25, double(face[2]));
    for (int y = 0; y < result.rows; ++y) {
      for (int x = 0; x < result.cols; ++x) {
        auto& pixel = result.at<cv::Vec3b>(y, x);
        const bool interior =
            x >= face[0] && x < face[0] + face[2] && y >= face[1] && y < face[1] + face[3];
        const double halo =
            255 * std::exp(-((x - cx) * (x - cx) + (y - cy) * (y - cy)) / (2 * radius * radius));
        for (int c = 0; c < 3; ++c)
          pixel[c] = cv::saturate_cast<uint8_t>(interior ? pixel[c] * 0.6 : pixel[c] + halo);
      }
    }
  } else if (variant <= 14) {
    cv::GaussianBlur(image, result, {0, 0}, variant - 12.0);
  } else if (variant == 15) {
    result = imaging.JPEG50(image);
  } else {
    cv::RNG rng(8162);
    result = Noise(image, 6, rng);
  }
  return result;
}

std::vector<Sample> Sequence(Engine& engine,
                             const cv::Mat& frame,
                             int count,
                             uint64_t seed,
                             int start = 0) {
  std::vector<Sample> samples;
  for (int i = start; i < start + count; ++i) {
    cv::RNG rng(seed + uint64_t(i) * 7919);
    auto transform = cv::getRotationMatrix2D({frame.cols * 0.5f, frame.rows * 0.5f},
                                             rng.uniform(-2.0, 2.0), rng.uniform(0.97, 1.03));
    transform.at<double>(0, 2) += rng.uniform(-0.03, 0.03) * frame.cols;
    transform.at<double>(1, 2) += rng.uniform(-0.03, 0.03) * frame.rows;
    cv::Mat jittered;
    cv::warpAffine(frame, jittered, transform, frame.size(), cv::INTER_LINEAR,
                   cv::BORDER_REPLICATE);
    samples.push_back(Infer(engine, Noise(jittered, 2, rng)));
  }
  return samples;
}

float Best(const Gallery& gallery, const std::optional<FaceTemplate>& feature) {
  return feature ? rk::auth::BestSimilarity(gallery, *feature) : -1;
}

struct Evaluation {
  Gallery gallery;
  bool matched = false;
  size_t collected = 0;
  int elapsed = -1;
  std::array<int, rk::auth::kFaceGateCount> failures{};
};

Evaluation Evaluate(const std::vector<Sample>& samples, const Gallery& gallery, bool enroll) {
  FacePolicy policy(enroll ? rk::auth::FacePurpose::enroll : rk::auth::FacePurpose::verify,
                    gallery);
  Evaluation result;
  const size_t maximum = enroll ? 300 : 150;
  for (size_t i = 0; i < std::min(samples.size(), maximum); ++i) {
    const auto& sample = samples[i];
    const auto observation =
        policy.Observe(Clock::time_point{} + i * 200ms, sample.inference, sample.hash);
    if (observation.gate != FaceGate::none)
      ++result.failures[static_cast<size_t>(observation.gate)];
    const auto& status = policy.Result();
    result.collected = status.templates.size();
    if ((status.state == rk::auth::FaceState::enrolled ||
         status.state == rk::auth::FaceState::matched) &&
        result.elapsed < 0) {
      result.elapsed = int(i) * 200;
      result.matched = !enroll;
      result.gallery = status.templates;
    }
    if (result.elapsed >= 0 && i >= 14)
      break;
  }
  return result;
}

std::ofstream CSV(const fs::path& path, const char* header) {
  std::ofstream stream(path);
  if (!stream)
    throw std::runtime_error("output unavailable");
  stream << std::setprecision(9) << header << '\n';
  return stream;
}

struct PrivateGallery {
  int id, photo, width, variant;
  Gallery vectors;
};

int Axis(int variant) {
  return variant == 0 ? 0 : variant <= 5 ? 1 : variant <= 12 ? 2 : 3;
}

std::vector<PrivateGallery> Private(Engine& engine,
                                    Imaging& imaging,
                                    const fs::path& input,
                                    const fs::path& out) {
  auto enrollments =
      CSV(out / "enrollments.csv", "id,photo,width,variant,templates,elapsed_ms,collected");
  auto enrollment_gates = CSV(out / "enrollment_gates.csv", "gallery,gate,count");
  auto sequences =
      CSV(out / "sequences.csv",
          "gallery,photo,width,enroll_variant,variant,axis,matched,elapsed_ms,single_best");
  auto gates = CSV(out / "gates.csv", "gallery,photo,width,enroll_variant,variant,gate,count");
  auto frames = CSV(out / "frames.csv",
                    "photo,width,variant,frame,gate,live1,live2,iod,yaw,pitch,sharpness,luma,dark,"
                    "bright,contrast,backlight");
  std::vector<PrivateGallery> galleries;
  for (int width : {480, 640}) {
    struct Photo {
      std::array<cv::Mat, 17> frames;
      std::array<Sample, 17> single;
      std::array<std::vector<Sample>, 17> sequences;
    };
    std::array<Photo, 4> photos;
    for (int p = 0; p < 4; ++p) {
      const auto image = Camera(ReadPrivateWebP(input / (std::to_string(p + 1) + ".webp")), width);
      const auto geometry = Infer(engine, image).inference.face;
      for (int v = 0; v < 17; ++v) {
        const auto frame = Variant(image, v, geometry, imaging);
        photos[p].frames[v] = frame;
        photos[p].single[v] = Infer(engine, frame);
        photos[p].sequences[v] = Sequence(engine, frame, 15, 1000 + p * 100 + v);
        for (size_t i = 0; i < photos[p].sequences[v].size(); ++i) {
          const auto& r = photos[p].sequences[v][i].inference;
          frames << p + 1 << ',' << width << ',' << v << ',' << i << ',' << int(r.gate) << ','
                 << r.live_v1se << ',' << r.live_v2 << ',' << r.quality.inter_ocular << ','
                 << r.quality.yaw << ',' << r.quality.pitch << ',' << r.quality.sharpness << ','
                 << r.quality.mean_luma << ',' << r.quality.dark_fraction << ','
                 << r.quality.bright_fraction << ',' << r.quality.contrast << ','
                 << r.quality.backlight << '\n';
        }
      }
      std::cerr << width << ' ' << p + 1 << '\n';
    }
    const auto evaluate = [&](int p, int v, const Gallery& gallery, bool enroll) {
      auto& cached = photos[p].sequences[v];
      auto result = Evaluate(cached, gallery, enroll);
      const size_t maximum = enroll ? 300 : 150;
      while (result.elapsed < 0 && cached.size() < maximum) {
        auto more =
            Sequence(engine, photos[p].frames[v], 5, 1000 + p * 100 + v, int(cached.size()));
        cached.insert(cached.end(), more.begin(), more.end());
        result = Evaluate(cached, gallery, enroll);
      }
      return result;
    };
    for (int p = 0; p < 4; ++p) {
      for (int enrollment_variant : {0, 10, 12, 3, 14}) {
        auto enrolled = evaluate(p, enrollment_variant, {}, true);
        PrivateGallery gallery{int(galleries.size()), p + 1, width, enrollment_variant,
                               std::move(enrolled.gallery)};
        enrollments << gallery.id << ',' << p + 1 << ',' << width << ',' << enrollment_variant
                    << ',' << gallery.vectors.size() << ',' << enrolled.elapsed << ','
                    << enrolled.collected << '\n';
        enrollments.flush();
        for (size_t gate = 1; gate < enrolled.failures.size(); ++gate)
          enrollment_gates << gallery.id << ',' << gate << ',' << enrolled.failures[gate] << '\n';
        for (int probe = 0; probe < 4; ++probe) {
          if (probe == p)
            continue;
          for (int v = 0; v < 17; ++v) {
            Evaluation verified;
            if (!gallery.vectors.empty())
              verified = evaluate(probe, v, gallery.vectors, false);
            sequences << gallery.id << ',' << probe + 1 << ',' << width << ',' << enrollment_variant
                      << ',' << v << ',' << Axis(v) << ',' << verified.matched << ','
                      << verified.elapsed << ','
                      << Best(gallery.vectors, photos[probe].single[v].inference.feature) << '\n';
            for (size_t gate = 1; gate < verified.failures.size(); ++gate)
              gates << gallery.id << ',' << probe + 1 << ',' << width << ',' << enrollment_variant
                    << ',' << v << ',' << gate << ',' << verified.failures[gate] << '\n';
          }
        }
        galleries.push_back(std::move(gallery));
      }
    }
  }
  return galleries;
}

void LFW(Engine& engine,
         Imaging& imaging,
         const fs::path& out,
         const fs::path& pairfile,
         const std::vector<PrivateGallery>& galleries) {
  _setmode(_fileno(stdin), _O_BINARY);
  std::vector<FaceInference> faces;
  auto images = CSV(out / "lfw_images.csv", "id,gate,detected");
  auto scores = CSV(out / "gallery_lfw.csv", "gallery,id,cosine");
  for (;;) {
    uint32_t id = 0, length = 0;
    std::cin.read(reinterpret_cast<char*>(&id), 4);
    if (std::cin.eof())
      break;
    if (!std::cin || !std::cin.read(reinterpret_cast<char*>(&length), 4) ||
        length > 64 * 1024 * 1024)
      throw std::runtime_error("stream header");
    std::vector<BYTE> bytes(length);
    if (!std::cin.read(reinterpret_cast<char*>(bytes.data()), length))
      throw std::runtime_error("stream body");
    if (id >= faces.size())
      faces.resize(id + 1);
    faces[id] = Infer(engine, imaging.Decode(bytes)).inference;
    const auto& r = faces[id];
    images << id << ',' << int(r.gate) << ',' << r.feature.has_value() << '\n';
    for (const auto& gallery : galleries) {
      if (!gallery.vectors.empty())
        scores << gallery.id << ',' << id << ',' << Best(gallery.vectors, r.feature) << '\n';
    }
    if (id % 1000 == 0)
      std::cerr << id << '\n';
  }
  auto pairs = CSV(out / "lfw_pairs.csv", "same,id1,id2,both_detected,cosine");
  std::ifstream input(pairfile);
  int same = 0, a = 0, b = 0;
  while (input >> same >> a >> b) {
    const auto& x = faces.at(a);
    const auto& y = faces.at(b);
    const bool detected = x.feature && y.feature;
    pairs << same << ',' << a << ',' << b << ',' << detected << ','
          << (detected ? Similarity(*x.feature, *y.feature) : -1) << '\n';
  }
}

int wmain(int argc, wchar_t** argv) {
  try {
    if (argc != 5 && argc != 6)
      return 2;
    Imaging imaging;
    auto engine = rk::auth::GetEngine(argv[1]);
    if (!engine)
      throw std::runtime_error("models unavailable");
    const fs::path out = argv[4];
    fs::create_directories(out);
    auto constants =
        CSV(out / "constants.csv", "match,learn_floor,novelty,diversity,detect,min_face");
    constants << rk::auth::kMatchThreshold << ',' << rk::auth::kLearnFloor << ','
              << rk::auth::kNovelty << ',' << rk::auth::kDiversity << ',' << rk::auth::kDetectScore
              << ',' << rk::auth::kMinFace << '\n';
    const auto galleries = Private(*engine.value(), imaging, argv[2], out);
    if (argc == 6 && std::wstring_view(argv[5]) == L"--private-only")
      return 0;
    LFW(*engine.value(), imaging, out, argv[3], galleries);
    return 0;
  } catch (const std::exception& e) {
    std::cerr << "evaluation_error: " << e.what() << '\n';
    return 1;
  }
}
