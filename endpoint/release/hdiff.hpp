#pragma once
#include <libHDiffPatch/HPatch/patch_types.h>

namespace remotekit::release {
inline constexpr size_t kPatchStepMemory = 256 * 1024;
bool ApplyDiff(const hpatch_TStreamInput& old_data,
               const hpatch_TStreamInput& diff,
               const hpatch_TStreamOutput& output);
void CreateDiff(const hpatch_TStreamInput& old_data,
                const hpatch_TStreamInput& new_data,
                const hpatch_TStreamOutput& output);
}  // namespace remotekit::release
