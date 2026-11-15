#define _CompressPlugin_zstd
#include <decompress_plugin_demo.h>
#include <libHDiffPatch/HPatch/patch.h>
#include <vector>
#include "hdiff.hpp"

namespace remotekit::release {
bool ApplyDiff(const hpatch_TStreamInput& old_data,
               const hpatch_TStreamInput& diff,
               const hpatch_TStreamOutput& output) {
  hpatch_singleCompressedDiffInfo info{};
  constexpr size_t kCacheSize = 8 * 1024 * 1024;
  if (!getSingleCompressedDiffInfo(&info, &diff, 0) || info.oldDataSize != old_data.streamSize ||
      info.newDataSize != output.streamSize ||
      info.stepMemSize > kCacheSize - hpatch_kStreamCacheSize * 3 ||
      (info.compressedSize && !zstdDecompressPlugin.is_can_open(info.compressType)))
    return false;
  auto size = info.compressedSize ? info.compressedSize : info.uncompressedSize;
  if (info.diffDataPos > diff.streamSize || size != diff.streamSize - info.diffDataPos)
    return false;
  std::vector<unsigned char> cache(kCacheSize);
  return patch_single_compressed_diff(
      &output, &old_data, &diff, info.diffDataPos, info.uncompressedSize, info.compressedSize,
      info.compressedSize ? &zstdDecompressPlugin : nullptr, info.coverCount,
      static_cast<size_t>(info.stepMemSize), cache.data(), cache.data() + cache.size(), nullptr, 1);
}
}  // namespace remotekit::release
