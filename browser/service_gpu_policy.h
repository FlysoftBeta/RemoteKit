#pragma once
#include <dxgi1_2.h>
#include <wrl/client.h>
#include "base/command_line.h"
#include "base/strings/utf_string_conversions.h"
#include "gpu/config/gpu_switches.h"
#include "remotekit/browser/osr/device.h"

namespace remotekit::browser {
// Endpoint selects and probes the encoder/D3D adapter. Session-default DXGI
// enumeration (notably RDP's Microsoft Basic Render Driver) is not that choice.
inline void ConfigureServiceGpuPolicy(base::CommandLine& command) {
  if (!command.HasSwitch("use-adapter-luid"))
    return;
  command.AppendSwitch(switches::kIgnoreGpuBlocklist);
  command.AppendSwitchASCII("use-angle", "d3d11");
  command.AppendSwitch("disable-software-rasterizer");
}
inline std::string ValidateServiceGpuAdapter(const base::CommandLine& command) {
  if (!command.HasSwitch("use-adapter-luid"))
    return {};
  const auto requested = osr::ParseAdapterLuid(command.GetSwitchValueASCII("use-adapter-luid"));
  if (!requested)
    return "invalid requested GPU adapter LUID";
  Microsoft::WRL::ComPtr<IDXGIFactory1> factory;
  if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory))))
    return "GPU adapter enumeration failed";
  for (UINT i = 0;; ++i) {
    Microsoft::WRL::ComPtr<IDXGIAdapter1> adapter;
    const auto status = factory->EnumAdapters1(i, &adapter);
    if (status == DXGI_ERROR_NOT_FOUND)
      break;
    if (FAILED(status))
      return "GPU adapter enumeration failed";
    DXGI_ADAPTER_DESC1 desc{};
    if (FAILED(adapter->GetDesc1(&desc)))
      return "GPU adapter description failed";
    if (desc.AdapterLuid.HighPart != requested->HighPart ||
        desc.AdapterLuid.LowPart != requested->LowPart)
      continue;
    if (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE)
      return "requested GPU adapter is software (Microsoft Basic Render Driver)";
    return {};
  }
  return "requested hardware GPU adapter LUID is not present; ANGLE fallback refused";
}
}  // namespace remotekit::browser
