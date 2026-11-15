#include "codec.hpp"
#include <zstd.h>
#include "codec_streams.hpp"
#include "manifest.hpp"

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
void Compress(const fs::path& payload, const fs::path& output, int level, unsigned workers) {
  std::ifstream source(payload, std::ios::binary);
  Io(source.is_open(), "cannot open release payload");
  Compressor compressor;
  Zstd(ZSTD_CCtx_setParameter(compressor.value, ZSTD_c_compressionLevel, level));
  Zstd(ZSTD_CCtx_setParameter(compressor.value, ZSTD_c_checksumFlag, 1));
  Zstd(ZSTD_CCtx_setPledgedSrcSize(compressor.value, fs::file_size(payload)));
  Zstd(ZSTD_CCtx_setParameter(compressor.value, ZSTD_c_nbWorkers, workers));
  std::ofstream file(output, std::ios::binary | std::ios::trunc);
  Io(file.is_open(), "cannot open compressed release");
  Bytes input(ZSTD_CStreamInSize()), buffer(ZSTD_CStreamOutSize());
  do {
    source.read(reinterpret_cast<char*>(input.data()), input.size());
    Io(!source.bad(), "cannot read release payload");
    bool ended = source.eof();
    ZSTD_inBuffer in{input.data(), static_cast<size_t>(source.gcount()), 0};
    size_t remaining;
    do {
      ZSTD_outBuffer out{buffer.data(), buffer.size(), 0};
      remaining =
          ZSTD_compressStream2(compressor.value, &out, &in, ended ? ZSTD_e_end : ZSTD_e_continue);
      Zstd(remaining);
      Io(static_cast<bool>(file.write(reinterpret_cast<const char*>(buffer.data()), out.pos)),
         "cannot write compressed release");
    } while (in.pos != in.size || (ended && remaining));
    if (ended)
      break;
  } while (true);
  file.close();
  Io(!file.fail(), "cannot finish compressed release");
}
void Decode(const Produce& input,
            const fs::path& output,
            const Payload& payload,
            const fs::path& base,
            const fs::path& patch) {
  if (!patch.empty()) {
    struct TemporaryDiff {
      fs::path path;
      ~TemporaryDiff() {
        std::error_code ignored;
        fs::remove(path, ignored);
      }
    } temporary{patch};
    Require(!base.empty(), "patch has no base payload");
    {
      std::ofstream file(patch, std::ios::binary | std::ios::trunc);
      Io(file.is_open(), "cannot open release diff");
      input([&](std::span<const uint8_t> bytes) {
        Io(static_cast<bool>(file.write(reinterpret_cast<const char*>(bytes.data()), bytes.size())),
           "cannot write release diff");
      });
      file.close();
      Io(!file.fail(), "cannot finish release diff");
    }
    FileInput old_data(base), diff(patch);
    FileOutput destination(output, payload.size);
    bool applied = ApplyDiff(old_data.stream, diff.stream, destination.stream);
    Io(!old_data.file.bad() && !diff.file.bad() && !destination.file.bad(),
       "cannot access release diff files");
    Require(applied && destination.position == payload.size, "invalid release diff");
    destination.Finish();
    return;
  }
  std::ofstream destination(output, std::ios::binary | std::ios::trunc);
  Io(destination.is_open(), "cannot open release payload output");
  Decoder decoder;
  Bytes buffer(ZSTD_DStreamOutSize());
  uint64_t produced = 0;
  bool seen = false;
  size_t remaining = 1;
  input([&](std::span<const uint8_t> bytes) {
    ZSTD_inBuffer in{bytes.data(), bytes.size(), 0};
    while (in.pos < in.size) {
      auto before = in.pos;
      ZSTD_outBuffer out{buffer.data(), buffer.size(), 0};
      remaining = ZSTD_decompressStream(decoder.value, &out, &in);
      Zstd(remaining);
      Require(out.pos <= payload.size - produced, "release payload exceeds expected size");
      Io(static_cast<bool>(
             destination.write(reinterpret_cast<const char*>(buffer.data()), out.pos)),
         "cannot write release payload");
      produced += out.pos;
      seen = true;
      Require(in.pos != before || out.pos, "release decoder made no progress");
    }
  });
  Require(seen && remaining == 0 && produced == payload.size,
          "release payload size or frame mismatch");
  destination.close();
  Io(!destination.fail(), "cannot finish release payload");
}
}  // namespace remotekit::release
