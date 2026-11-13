#include "video.hpp"
#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <strmif.h>
#include <codecapi.h>
#include <wrl/client.h>
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <vector>

namespace schedlab {
namespace {
using Microsoft::WRL::ComPtr;
constexpr int width = 1920, height = 1080, fps = 60, seconds = 60, panorama_width = 4096;
void Check(HRESULT status, const char* operation) {
  if (FAILED(status))
    throw std::runtime_error(std::string(operation) + " HRESULT " + std::to_string(status));
}
uint32_t Hash(uint32_t x, uint32_t y) {
  uint32_t value = x * 0x9e3779b9u + y * 0x85ebca6bu + 0x31415926u;
  value ^= value >> 16;
  value *= 0x7feb352du;
  value ^= value >> 15;
  value *= 0x846ca68bu;
  return value ^ (value >> 16);
}
int Noise(int x, int y, int cell) {
  const int a = x / cell, b = y / cell;
  const int dx = x % cell, dy = y % cell;
  auto at = [](int px, int py) { return int(Hash(px, py) & 255); };
  const int top = at(a, b) * (cell - dx) + at(a + 1, b) * dx;
  const int bottom = at(a, b + 1) * (cell - dx) + at(a + 1, b + 1) * dx;
  return (top * (cell - dy) + bottom * dy) / (cell * cell);
}
uint32_t Color(int r, int g, int b) {
  return uint32_t(std::clamp(r, 0, 255) << 16 | std::clamp(g, 0, 255) << 8 | std::clamp(b, 0, 255));
}
std::vector<uint32_t> Landscape() {
  std::vector<uint32_t> image(panorama_width * height);
  for (int y = 0; y < height; ++y) {
    for (int x = 0; x < panorama_width; ++x) {
      const int broad = Noise(x, y, 256), medium = Noise(x, y, 64);
      const int fine = Noise(x, y, 16), grain = int(Hash(x, y) & 15) - 7;
      int r = 95 + y / 6, g = 157 + y / 14, b = 216 - y / 20;
      const int cloud = std::max(0, broad + medium / 3 - 175);
      r += cloud;
      g += cloud;
      b += cloud / 2;
      for (int layer = 0; layer < 4; ++layer) {
        const int ridge =
            380 + layer * 120 + (Noise(x + layer * 457, 27, 256) - 128) * (4 - layer) / 2;
        if (y < ridge)
          continue;
        const int texture = broad / 8 + medium / 5 + fine / 4 + grain;
        r = 35 + layer * 9 + texture;
        g = 67 + layer * 12 + texture;
        b = 63 - layer * 8 + texture / 2;
        if (layer == 3 && std::abs(x % 1400 - 620 - (height - y) / 2) < 45 + (y - ridge) / 4) {
          r = 95 + fine / 5;
          g = 146 + medium / 5;
          b = 180 + fine / 6;
        }
      }
      image[(height - 1 - y) * panorama_width + x] = Color(r, g, b);
    }
  }
  return image;
}
void Blend(uint32_t& pixel, uint32_t color, int alpha) {
  const int inverse = 256 - alpha;
  const auto rb = (((pixel & 0xff00ff) * inverse + (color & 0xff00ff) * alpha) >> 8) & 0xff00ff;
  const auto g = (((pixel & 0x00ff00) * inverse + (color & 0x00ff00) * alpha) >> 8) & 0x00ff00;
  pixel = rb | g;
}
void Frame(std::vector<uint32_t>& pixels, const std::vector<uint32_t>& landscape, int index) {
  const int pan = index / 3;
  for (int y = 0; y < height; ++y)
    std::memcpy(pixels.data() + y * width, landscape.data() + y * panorama_width + pan,
                width * sizeof(uint32_t));
  for (int object = 0; object < 6; ++object) {
    for (int exposure = 0; exposure < 5; ++exposure) {
      const int x = (index * (4 + object) + object * 337 - exposure * 2 + 20000) % 2200 - 140;
      const int y = 180 + object * 115 + Noise(index + object * 80, 22, 64) / 3;
      const auto color = object % 2 ? Color(240, 225, 190) : Color(32, 35, 43);
      for (int dy = -28; dy < 28; ++dy) {
        for (int dx = -70; dx < 70; ++dx) {
          if (dx * dx / 5 + dy * dy > 1000 || x + dx < 0 || x + dx >= width)
            continue;
          Blend(pixels[(height - 1 - y - dy) * width + x + dx], color, 75);
        }
      }
    }
  }
  const int band = (index * 3) % height;
  for (int dy = 0; dy < 50; ++dy) {
    const int y = (band + dy) % height;
    for (int x = 0; x < width; ++x) {
      const int detail = ((x + index) % 7 < 3) ^ (dy % 5 < 2);
      Blend(pixels[(height - 1 - y) * width + x], detail ? 0xf8f1e0 : 0x182631, 90);
    }
  }
  constexpr std::array<int, 10> digits{0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f};
  constexpr int segments[7][4]{{6, 0, 30, 6},  {30, 6, 36, 30}, {30, 36, 36, 60}, {6, 60, 30, 66},
                               {0, 36, 6, 60}, {0, 6, 6, 30},   {6, 30, 30, 36}};
  int number = index;
  for (int digit = 3; digit >= 0; --digit) {
    const int mask = digits[number % 10];
    number /= 10;
    for (int segment = 0; segment < 7; ++segment) {
      if (!(mask & (1 << segment)))
        continue;
      const auto& box = segments[segment];
      for (int y = box[1]; y < box[3]; ++y)
        for (int x = box[0]; x < box[2]; ++x)
          pixels[(height - 31 - y) * width + 30 + digit * 48 + x] = 0xffffff;
    }
  }
}
}  // namespace
void MakeVideo(const std::filesystem::path& output) {
  Check(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "COM startup");
  struct ComCleanup {
    ~ComCleanup() { CoUninitialize(); }
  } com_cleanup;
  Check(MFStartup(MF_VERSION), "Media Foundation startup");
  struct MfCleanup {
    ~MfCleanup() { MFShutdown(); }
  } mf_cleanup;
  if (!output.parent_path().empty())
    std::filesystem::create_directories(output.parent_path());
  ComPtr<IMFAttributes> attributes;
  Check(MFCreateAttributes(&attributes, 2), "writer attributes");
  Check(attributes->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, FALSE), "system encoder");
  Check(attributes->SetUINT32(MF_SINK_WRITER_DISABLE_THROTTLING, TRUE), "writer throttling");
  ComPtr<IMFSinkWriter> writer;
  Check(MFCreateSinkWriterFromURL(output.c_str(), nullptr, attributes.Get(), &writer),
        "MP4 writer");
  ComPtr<IMFMediaType> encoded;
  Check(MFCreateMediaType(&encoded), "encoded type");
  Check(encoded->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video), "major type");
  Check(encoded->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264), "H264 type");
  Check(encoded->SetUINT32(MF_MT_AVG_BITRATE, 20000000), "bitrate");
  Check(encoded->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High), "High profile");
  Check(encoded->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive), "interlace mode");
  Check(MFSetAttributeSize(encoded.Get(), MF_MT_FRAME_SIZE, width, height), "encoded size");
  Check(MFSetAttributeRatio(encoded.Get(), MF_MT_FRAME_RATE, fps, 1), "encoded rate");
  Check(MFSetAttributeRatio(encoded.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1), "pixel aspect");
  DWORD stream = 0;
  Check(writer->AddStream(encoded.Get(), &stream), "video stream");
  ComPtr<IMFMediaType> raw;
  Check(MFCreateMediaType(&raw), "raw type");
  Check(raw->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video), "raw major type");
  Check(raw->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32), "RGB32 type");
  Check(raw->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive), "raw interlace");
  Check(MFSetAttributeSize(raw.Get(), MF_MT_FRAME_SIZE, width, height), "raw size");
  Check(MFSetAttributeRatio(raw.Get(), MF_MT_FRAME_RATE, fps, 1), "raw rate");
  Check(MFSetAttributeRatio(raw.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1), "raw pixel aspect");
  ComPtr<IMFAttributes> encoding;
  Check(MFCreateAttributes(&encoding, 1), "encoding parameters");
  Check(encoding->SetUINT32(CODECAPI_AVEncMPVGOPSize, fps * 2), "GOP parameter");
  Check(writer->SetInputMediaType(stream, raw.Get(), encoding.Get()), "writer input");
  ComPtr<ICodecAPI> codec;
  Check(writer->GetServiceForStream(stream, GUID_NULL, IID_PPV_ARGS(&codec)), "encoder codec API");
  Check(writer->BeginWriting(), "begin MP4");
  VARIANT actual;
  VariantInit(&actual);
  Check(codec->GetValue(&CODECAPI_AVEncMPVGOPSize, &actual), "read GOP");
  if (actual.vt != VT_UI4 || actual.ulVal != fps * 2)
    throw std::runtime_error("system encoder did not apply the 2 second GOP");
  VariantClear(&actual);
  const auto landscape = Landscape();
  std::vector<uint32_t> pixels(width * height);
  for (int index = 0; index < fps * seconds; ++index) {
    Frame(pixels, landscape, index);
    ComPtr<IMFMediaBuffer> buffer;
    Check(MFCreateMemoryBuffer(width * height * 4, &buffer), "frame buffer");
    BYTE* bytes = nullptr;
    Check(buffer->Lock(&bytes, nullptr, nullptr), "lock frame");
    std::memcpy(bytes, pixels.data(), width * height * 4);
    Check(buffer->Unlock(), "unlock frame");
    Check(buffer->SetCurrentLength(width * height * 4), "frame length");
    ComPtr<IMFSample> sample;
    Check(MFCreateSample(&sample), "frame sample");
    Check(sample->AddBuffer(buffer.Get()), "sample buffer");
    Check(sample->SetSampleTime(int64_t(index) * 10000000 / fps), "frame time");
    Check(sample->SetSampleDuration(int64_t(index + 1) * 10000000 / fps -
                                    int64_t(index) * 10000000 / fps),
          "frame duration");
    Check(writer->WriteSample(stream, sample.Get()), "write video frame");
    if (index % fps == 0)
      std::cerr << "make-video " << index / fps << "/" << seconds << " seconds\n";
  }
  Check(writer->Finalize(), "finalize MP4");
}
}  // namespace schedlab
