#ifndef REMOTEKIT_BROWSER_SERVICE_INPUT_POLICY_H_
#define REMOTEKIT_BROWSER_SERVICE_INPUT_POLICY_H_

#include "base/command_line.h"
#include "third_party/blink/public/common/features.h"

namespace remotekit::browser {
// The service receives Client-computed scroll displacement and momentum.
// Renderer resampling would predict these deltas a second time, then discard
// its pending correction on the direct-to-momentum transition. This policy is
// installed only by the service executable, before child feature propagation.
inline void ConfigureServiceScrollPolicy(base::CommandLine& command) {
  std::string disabled = command.GetSwitchValueASCII("disable-features");
  if (!disabled.empty()) disabled += ",";
  disabled += blink::features::kResamplingScrollEvents.name;
  command.AppendSwitchASCII("disable-features", disabled);
}
}  // namespace remotekit::browser

#endif
