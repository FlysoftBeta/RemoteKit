#pragma once
#include "common.hpp"
#include "hdiff.hpp"

namespace remotekit::release {
struct FileInput {
  std::ifstream file;
  hpatch_TStreamInput stream{};
  explicit FileInput(const fs::path& path) : file(path, std::ios::binary) {
    Io(file.is_open(), "cannot open diff input");
    stream.streamImport = this;
    stream.streamSize = fs::file_size(path);
    stream.read = [](const hpatch_TStreamInput* input, hpatch_StreamPos_t position,
                     unsigned char* begin, unsigned char* end) -> hpatch_BOOL {
      if (position > input->streamSize ||
          static_cast<uint64_t>(end - begin) > input->streamSize - position)
        return hpatch_FALSE;
      auto& self = *static_cast<FileInput*>(input->streamImport);
      self.file.seekg(static_cast<std::streamoff>(position));
      self.file.read(reinterpret_cast<char*>(begin), end - begin);
      return static_cast<bool>(self.file);
    };
  }
};
struct FileOutput {
  std::ofstream file;
  hpatch_TStreamOutput stream{};
  uint64_t position = 0;
  bool sequential;
  FileOutput(const fs::path& path, std::optional<uint64_t> size = {})
      : file(path, std::ios::binary | std::ios::trunc), sequential(size.has_value()) {
    Io(file.is_open(), "cannot open diff output");
    if (size)
      fs::resize_file(path, *size);
    stream.streamImport = this;
    stream.streamSize = size.value_or(INT64_MAX);
    stream.write = [](const hpatch_TStreamOutput* output, hpatch_StreamPos_t position,
                      const unsigned char* begin, const unsigned char* end) -> hpatch_BOOL {
      if (position > output->streamSize ||
          static_cast<uint64_t>(end - begin) > output->streamSize - position)
        return hpatch_FALSE;
      auto& self = *static_cast<FileOutput*>(output->streamImport);
      if (self.sequential && position != self.position)
        return hpatch_FALSE;
      if (position != self.position)
        self.file.seekp(static_cast<std::streamoff>(position));
      self.file.write(reinterpret_cast<const char*>(begin), end - begin);
      self.position = position + (end - begin);
      return static_cast<bool>(self.file);
    };
  }
  void Finish() {
    file.close();
    Io(!file.fail(), "cannot finish diff output");
  }
};
}  // namespace remotekit::release
