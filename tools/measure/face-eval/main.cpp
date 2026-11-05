// Numeric-only evaluation. No pixel, embedding, metadata or image-file output.
#include "auth/face_engine.hpp"
#include "auth/face_policy.hpp"

#include <windows.h>
#include <wincodec.h>
#include <wrl/client.h>
#include <io.h>
#include <fcntl.h>
#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>
#include <algorithm>
#include <array>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <stdexcept>
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
  cv::Mat JPEG60(const cv::Mat& image) {
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
    quality.fltVal = .6f;
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
// Private file path: seek past metadata payloads without reading them into memory.
std::vector<BYTE> ReadPrivateJPEG(const fs::path& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f)
    throw std::runtime_error("input missing");
  auto byte = [&]() {
    int c = f.get();
    if (c < 0)
      throw std::runtime_error("JPEG truncated");
    return BYTE(c);
  };
  if (byte() != 255 || byte() != 216)
    throw std::runtime_error("JPEG required");
  std::vector<BYTE> out{255, 216};
  for (;;) {
    if (byte() != 255)
      throw std::runtime_error("JPEG marker");
    BYTE tag = byte();
    while (tag == 255)
      tag = byte();
    if (tag == 217) {
      out.insert(out.end(), {255, tag});
      return out;
    }
    if (tag == 1 || (tag >= 208 && tag <= 215)) {
      out.insert(out.end(), {255, tag});
      continue;
    }
    BYTE hi = byte(), lo = byte();
    int length = int(hi) * 256 + lo;
    if (length < 2)
      throw std::runtime_error("JPEG length");
    if ((tag >= 224 && tag <= 239) || tag == 254) {
      f.seekg(length - 2, std::ios::cur);
      if (!f)
        throw std::runtime_error("JPEG seek");
    } else {
      out.insert(out.end(), {255, tag, hi, lo});
      size_t offset = out.size();
      out.resize(offset + length - 2);
      if (!f.read(reinterpret_cast<char*>(out.data() + offset), length - 2))
        throw std::runtime_error("JPEG segment");
    }
    if (tag == 218) {  // Entropy-coded scan: handle stuffed bytes and subsequent scans.
      for (;;) {
        BYTE c = byte();
        if (c != 255) {
          out.push_back(c);
          continue;
        }
        BYTE next = byte();
        if (next == 0 || (next >= 208 && next <= 215)) {
          out.insert(out.end(), {255, next});
          continue;
        }
        f.seekg(-2, std::ios::cur);
        break;
      }
    }
  }
}
using rk::auth::Engine;
using rk::auth::FaceGate;
using rk::auth::FaceInference;
using rk::auth::FaceTemplate;
using rk::auth::FaceWindow;
using rk::auth::Similarity;

struct Result {
  FaceInference inference;
  uint64_t hash = 0;
};

Result Infer(Engine& engine, const cv::Mat& bgr) {
  cv::Mat rgb;
  cv::cvtColor(bgr, rgb, cv::COLOR_BGR2RGB);
  auto inferred = engine.InferRGB24(rgb.cols, rgb.rows, rgb.data);
  if (!inferred)
    throw std::runtime_error("inference failure");
  return {std::move(inferred).value(), rk::auth::Fingerprint({rgb.data, rgb.total() * 3})};
}

cv::Mat Camera(const cv::Mat& image, int width) {
  int height = width * 3 / 4;
  double scale = std::max(double(width) / image.cols, double(height) / image.rows);
  cv::Mat resized;
  cv::resize(image, resized,
             {int(std::ceil(image.cols * scale)), int(std::ceil(image.rows * scale))}, 0, 0,
             cv::INTER_LINEAR);
  return resized(cv::Rect((resized.cols - width) / 2, (resized.rows - height) / 2, width, height))
      .clone();
}
std::ofstream CSV(const fs::path& path, const char* header) {
  std::ofstream f(path);
  if (!f)
    throw std::runtime_error("output unavailable");
  f << std::setprecision(9) << header << '\n';
  return f;
}
void Private(Engine& engine, Imaging& imaging, const fs::path& input, const fs::path& out) {
  std::vector<fs::path> photos;
  for (const auto& entry : fs::directory_iterator(input)) {
    if (entry.is_regular_file() &&
        (entry.path().extension() == ".jpg" || entry.path().extension() == ".jpeg"))
      photos.push_back(entry.path());
  }
  std::sort(photos.begin(), photos.end());
  auto frames =
      CSV(out / "frames.csv", "photo,width,height,variant,detections,qualified,gate,live1,live2");
  auto sequences = CSV(out / "sequences.csv", "width,enrollments,verification_sequences,matched");
  const std::array<int, 3> widths{640, 480, 320};
  std::vector<std::array<std::array<Result, 5>, 3>> variants(photos.size());
  for (size_t p = 0; p < photos.size(); ++p) {
    const auto image = imaging.Decode(ReadPrivateJPEG(photos[p]));
    for (size_t s = 0; s < widths.size(); ++s) {
      const int width = widths[s];
      const auto camera = Camera(image, width);
      for (int v = 0; v < 5; ++v) {
        cv::Mat frame;
        if (v == 0)
          frame = camera;
        else if (v == 1)
          cv::GaussianBlur(camera, frame, {0, 0}, 1.0);
        else if (v == 2 || v == 3)
          camera.convertTo(frame, -1, v == 2 ? 0.7 : 1.3);
        else
          frame = imaging.JPEG60(camera);
        auto result = Infer(engine, frame);
        const auto& r = result.inference;
        frames << p + 1 << ',' << width << ',' << width * 3 / 4 << ',' << v << ',' << r.detections
               << ',' << r.qualified << ',' << int(r.gate) << ',' << r.live_v1se << ',' << r.live_v2
               << '\n';
        variants[p][s][v] = std::move(result);
      }
    }
  }
  using namespace std::chrono_literals;
  const auto epoch = FaceWindow::Clock::time_point{};
  for (size_t s = 0; s < widths.size(); ++s) {
    int enrollments = 0, total = 0, matched = 0;
    for (size_t a = 0; a < photos.size(); ++a) {
      for (size_t b = a + 1; b < photos.size(); ++b) {
        for (size_t c = b + 1; c < photos.size(); ++c) {
          FaceWindow enrollment;
          std::optional<FaceTemplate> reference;
          int time = 0;
          for (size_t p : {a, b, c}) {
            const auto& r = variants[p][s][0];
            reference = enrollment.Observe(
                epoch + time * 200ms,
                r.inference.gate == FaceGate::none ? r.inference.feature : std::nullopt, r.hash,
                std::nullopt);
            ++time;
          }
          if (!reference)
            continue;
          ++enrollments;
          for (size_t p = 0; p < photos.size(); ++p) {
            if (p == a || p == b || p == c)
              continue;
            ++total;
            FaceWindow verification;
            for (int v = 0; v < 5; ++v) {
              const auto& r = variants[p][s][v];
              if (verification.Observe(
                      epoch + v * 200ms,
                      r.inference.gate == FaceGate::none ? r.inference.feature : std::nullopt,
                      r.hash, reference)) {
                ++matched;
                break;
              }
            }
          }
        }
      }
    }
    sequences << widths[s] << ',' << enrollments << ',' << total << ',' << matched << '\n';
  }
}

void LFW(Engine& engine, Imaging& imaging, const fs::path& out, const fs::path& pairfile) {
  _setmode(_fileno(stdin), _O_BINARY);
  std::vector<FaceInference> faces;
  auto images = CSV(out / "lfw_images.csv", "id,detections,qualified,gate,detected,accepted");
  for (;;) {
    uint32_t id = 0, n = 0;
    std::cin.read(reinterpret_cast<char*>(&id), 4);
    if (std::cin.eof())
      break;
    if (!std::cin || !std::cin.read(reinterpret_cast<char*>(&n), 4) || n > 64 * 1024 * 1024)
      throw std::runtime_error("stream header");
    std::vector<BYTE> bytes(n);
    if (!std::cin.read(reinterpret_cast<char*>(bytes.data()), n))
      throw std::runtime_error("stream body");
    if (id >= faces.size())
      faces.resize(id + 1);
    faces[id] = Infer(engine, imaging.Decode(bytes)).inference;
    const auto& r = faces[id];
    images << id << ',' << r.detections << ',' << r.qualified << ',' << int(r.gate) << ','
           << r.feature.has_value() << ',' << (r.gate == FaceGate::none) << '\n';
    if (id % 500 == 0)
      std::cerr << id << '\n';
  }
  auto pairs = CSV(out / "lfw_pairs.csv", "same,id1,id2,both_detected,cosine,both_accepted");
  std::ifstream input(pairfile);
  int same = 0, a = 0, b = 0;
  while (input >> same >> a >> b) {
    const auto& x = faces.at(a);
    const auto& y = faces.at(b);
    const bool detected = x.feature && y.feature;
    pairs << same << ',' << a << ',' << b << ',' << detected << ','
          << (detected ? Similarity(*x.feature, *y.feature) : -1) << ','
          << (x.gate == FaceGate::none && y.gate == FaceGate::none) << '\n';
  }
}

int wmain(int argc, wchar_t** argv) {
  try {
    if (argc != 5)
      return 2;
    Imaging imaging;
    auto engine = rk::auth::GetEngine(argv[2]);
    if (!engine)
      throw std::runtime_error("models unavailable");
    const fs::path out = argv[4];
    fs::create_directories(out);
    if (std::wstring(argv[1]) == L"--photos")
      Private(*engine.value(), imaging, argv[3], out);
    else if (std::wstring(argv[1]) == L"--lfw")
      LFW(*engine.value(), imaging, out, argv[3]);
    else
      return 2;
    return 0;
  } catch (const std::exception&) {
    std::cerr << "evaluation_error\n";
    return 1;
  }
}
