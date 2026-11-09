#define ZSTD_STATIC_LINKING_ONLY
#include "manifest.hpp"
#include "codec.hpp"
#include <zstd.h>
#include <bit>

namespace remotekit::release {
namespace {
void Zstd(size_t result) {
  Require(!ZSTD_isError(result), "invalid release zstd stream");
}
struct Compressor {
  ZSTD_CCtx* value = ZSTD_createCCtx();
  Compressor() { Io(value != nullptr, "cannot allocate zstd compressor"); }
  ~Compressor() { ZSTD_freeCCtx(value); }
};
struct Decoder {
  ZSTD_DCtx* value = ZSTD_createDCtx();
  Decoder() { Io(value != nullptr, "cannot allocate zstd decoder"); }
  ~Decoder() { ZSTD_freeDCtx(value); }
};
}  // namespace
void Compress(const fs::path& payload,
              const fs::path& output,
              const fs::path& base,
              int level,
              unsigned workers) {
  Mapping source(payload);
  std::unique_ptr<Mapping> prefix;
  Compressor compressor;
  Zstd(ZSTD_CCtx_setParameter(compressor.value, ZSTD_c_compressionLevel, level));
  Zstd(ZSTD_CCtx_setParameter(compressor.value, ZSTD_c_checksumFlag, 1));
  Zstd(ZSTD_CCtx_setPledgedSrcSize(compressor.value, source.bytes().size()));
  if (!base.empty()) {
    prefix = std::make_unique<Mapping>(base);
    uint64_t size = std::max(prefix->bytes().size(), source.bytes().size());
    unsigned window = std::max(27u, static_cast<unsigned>(std::bit_width(size ? size - 1 : 0)));
    Require(window <= 31, "patch prefix or payload exceeds windowLog 31");
    Zstd(ZSTD_CCtx_setParameter(compressor.value, ZSTD_c_windowLog, window));
    Zstd(ZSTD_CCtx_setParameter(compressor.value, ZSTD_c_enableLongDistanceMatching, 1));
    Zstd(ZSTD_CCtx_refPrefix(compressor.value, prefix->bytes().data(), prefix->bytes().size()));
  } else {
    Zstd(ZSTD_CCtx_setParameter(compressor.value, ZSTD_c_nbWorkers, workers));
  }
  std::ofstream file(output, std::ios::binary | std::ios::trunc);
  Io(file.is_open(), "cannot open compressed release");
  Bytes buffer(ZSTD_CStreamOutSize());
  ZSTD_inBuffer in{source.bytes().data(), source.bytes().size(), 0};
  size_t remaining;
  do {
    ZSTD_outBuffer out{buffer.data(), buffer.size(), 0};
    remaining = ZSTD_compressStream2(compressor.value, &out, &in, ZSTD_e_end);
    Zstd(remaining);
    Io(static_cast<bool>(file.write(reinterpret_cast<const char*>(buffer.data()), out.pos)),
       "cannot write compressed release");
  } while (remaining);
  file.close();
  Io(!file.fail(), "cannot finish compressed release");
}
void Decode(const Produce& input,
            const fs::path& output,
            const Payload& payload,
            const fs::path& base,
            bool patch) {
  Mapping destination(output, payload.size);
  std::unique_ptr<Mapping> prefix;
  Decoder decoder;
  Zstd(ZSTD_DCtx_setParameter(decoder.value, ZSTD_d_windowLogMax, 31));
  Zstd(ZSTD_DCtx_setParameter(decoder.value, ZSTD_d_stableOutBuffer, 1));
  if (patch) {
    Require(!base.empty(), "patch has no base payload");
    prefix = std::make_unique<Mapping>(base);
    Zstd(ZSTD_DCtx_refPrefix(decoder.value, prefix->bytes().data(), prefix->bytes().size()));
  }
  ZSTD_outBuffer out{destination.bytes().data(), destination.bytes().size(), 0};
  bool seen = false, ended = false, checked = !patch;
  Bytes header;
  size_t remaining = 1;
  auto feed = [&](std::span<const uint8_t> bytes) {
    ZSTD_inBuffer in{bytes.data(), bytes.size(), 0};
    while (in.pos < in.size) {
      Require(!patch || !ended, "input after patch frame");
      auto before = in.pos;
      auto produced = out.pos;
      remaining = ZSTD_decompressStream(decoder.value, &out, &in);
      Zstd(remaining);
      seen = true;
      ended = remaining == 0;
      Require(in.pos != before || out.pos != produced, "release decoder made no progress");
    }
  };
  input([&](std::span<const uint8_t> bytes) {
    if (!checked) {
      size_t n = std::min<size_t>(ZSTD_FRAMEHEADERSIZE_MAX - header.size(), bytes.size());
      header.insert(header.end(), bytes.begin(), bytes.begin() + n);
      bytes = bytes.subspan(n);
      ZSTD_frameHeader frame{};
      size_t result = ZSTD_getFrameHeader(&frame, header.data(), header.size());
      Zstd(result);
      if (result)
        return;
      Require(frame.frameType == ZSTD_frame && frame.checksumFlag == 1,
              "patch frame must have a checksum");
      checked = true;
      feed(header);
    }
    feed(bytes);
  });
  Require(checked && seen && remaining == 0 && out.pos == payload.size,
          "release payload size or frame mismatch");
}
}  // namespace remotekit::release
