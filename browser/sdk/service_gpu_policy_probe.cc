#include "remotekit/browser/service_gpu_policy.h"
#include "base/check.h"
#include "base/feature_list.h"
#include "gpu/config/gpu_blocklist.h"
#include "gpu/config/gpu_feature_info.h"
#include "gpu/config/gpu_info.h"
#include "gpu/config/gpu_preferences.h"
#include "gpu/config/gpu_util.h"
#include <cstdio>
#include <algorithm>

int main(int argc, char** argv) {
  base::CommandLine::Init(argc, argv);
  base::FeatureList::InitInstance("", "");
  gpu::GPUInfo info;
  info.gpu.vendor_id = 0x1414;
  info.gpu.device_id = 0x8c;
  info.gpu.active = true;
  info.gpu.device_string = "Microsoft Basic Render Driver";
  auto blocklist = gpu::GpuBlocklist::Create();
  const auto disabled = blocklist->MakeDecision(gpu::GpuControlList::kOsWin, "10.0", info, 0, {});
  const auto entries = blocklist->GetEntryIDsFromIndices(blocklist->GetActiveEntries());
  CHECK(std::ranges::find(entries, 74) != entries.end());
  CHECK(disabled.contains(gpu::GPU_FEATURE_TYPE_ACCELERATED_GL));
  auto command = *base::CommandLine::ForCurrentProcess();
  gpu::GpuPreferences preferences;
  auto before = gpu::ComputeGpuFeatureInfo(info, preferences, &command, nullptr);
  CHECK(!gpu::IsGrContextTypeSupported(gpu::GrContextType::kGL, before));
  command.AppendSwitchASCII("use-adapter-luid", "0,123");
  remotekit::browser::ConfigureServiceGpuPolicy(command);
  // Content's GPU preference construction uses this same command-line switch.
  preferences.ignore_gpu_blocklist = command.HasSwitch(switches::kIgnoreGpuBlocklist);
  auto after = gpu::ComputeGpuFeatureInfo(info, preferences, &command, nullptr);
  CHECK(gpu::IsGrContextTypeSupported(gpu::GrContextType::kGL, after));
  CHECK_EQ(after.status_values[gpu::GPU_FEATURE_TYPE_GPU_TILE_RASTERIZATION],
           gpu::kGpuFeatureStatusEnabled);
  std::printf("primary=1414 entry74=all before: hardware Ganesh OSR unavailable; "
              "service policy: compositing=%d rasterization=%d GL OSR accepted\n",
              after.status_values[gpu::GPU_FEATURE_TYPE_ACCELERATED_GL],
              after.status_values[gpu::GPU_FEATURE_TYPE_GPU_TILE_RASTERIZATION]);
}
