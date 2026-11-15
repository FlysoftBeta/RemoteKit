#define _CompressPlugin_zstd
#include <compress_plugin_demo.h>
#include <libHDiffPatch/HDiff/diff.h>
#include "hdiff.hpp"

namespace remotekit::release {
// Block matching streams both payloads from disk with a few hundred MiB of index. Suffix-array
// matching made diffs about 4x smaller but passed 17 GiB on 2.9 GB payloads before finishing
// (64-bit indices above 2 GiB), close to exhausting the 32 GiB release machine.
void CreateDiff(const hpatch_TStreamInput& old_data,
                const hpatch_TStreamInput& new_data,
                const hpatch_TStreamOutput& output) {
  constexpr size_t kMatchBlockSize = 64;
  auto plugin = zstdCompressPlugin;
  plugin.compress_level = 19;
  plugin.dict_bits = 24;
  plugin.thread_num = 1;
  create_single_compressed_diff_stream(&new_data, &old_data, &output, &plugin.base,
                                       kPatchStepMemory, kMatchBlockSize);
}
}  // namespace remotekit::release
