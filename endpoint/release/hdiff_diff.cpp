#define _CompressPlugin_zstd
#include <compress_plugin_demo.h>
#include <libHDiffPatch/HDiff/diff.h>
#include <stdexcept>
#include <vector>
#include "hdiff.hpp"

namespace remotekit::release {
void CreateDiff(const hpatch_TStreamInput& old_data,
                const hpatch_TStreamInput& new_data,
                const hpatch_TStreamOutput& output) {
  constexpr int kMatchScore = 4;
  auto plugin = zstdCompressPlugin;
  plugin.compress_level = 19;
  plugin.dict_bits = 24;
  plugin.thread_num = 1;
  std::vector<unsigned char> old_bytes(static_cast<size_t>(old_data.streamSize));
  std::vector<unsigned char> new_bytes(static_cast<size_t>(new_data.streamSize));
  if (!old_data.read(&old_data, 0, old_bytes.data(), old_bytes.data() + old_bytes.size()) ||
      !new_data.read(&new_data, 0, new_bytes.data(), new_bytes.data() + new_bytes.size()))
    throw std::runtime_error("cannot read diff payloads");
  create_single_compressed_diff(new_bytes.data(), new_bytes.data() + new_bytes.size(),
                                old_bytes.data(), old_bytes.data() + old_bytes.size(), &output,
                                &plugin.base, kPatchStepMemory, kMatchScore, false, 1);
}
}  // namespace remotekit::release
