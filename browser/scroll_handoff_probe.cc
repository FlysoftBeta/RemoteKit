// CPU assertion of the service compositor scroll policy.
#include <cstdio>
#include "base/at_exit.h"
#include "base/check.h"
#include "base/command_line.h"
#include "base/feature_list.h"
#include "browser/service_input_policy.h"
#include "third_party/blink/public/common/features.h"

int main(int argc, char** argv) {
  base::AtExitManager at_exit;
  base::CommandLine::Init(argc, argv);
  auto& command = *base::CommandLine::ForCurrentProcess();
  command.AppendSwitchASCII("disable-features", "CalculateNativeWinOcclusion");
  remotekit::browser::ConfigureServiceScrollPolicy(command);
  CHECK_EQ(command.GetSwitchValueASCII("disable-features"),
           "CalculateNativeWinOcclusion,ResamplingScrollEvents");
  // A caller's enable list must not override the fixed service policy.
  base::FeatureList::InitInstance("ResamplingScrollEvents",
                                  command.GetSwitchValueASCII("disable-features"));
  CHECK(!base::FeatureList::IsEnabled(blink::features::kResamplingScrollEvents));
  std::puts(
      "service policy: resampling disabled; existing disable list preserved; explicit enable "
      "cannot override");
  return 0;
}
