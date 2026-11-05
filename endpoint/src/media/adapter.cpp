#include "media/adapter.hpp"
#include "media/encoder_worker.hpp"
namespace remotekit {
std::string AdapterLuid(LUID luid) {
  return std::to_string(luid.HighPart) + "," + std::to_string(luid.LowPart);
}

Result<StreamingAdapter> SelectStreamingAdapter(Sdk& sdk, const RuntimeOptions& options) {
  ComPtr<IDXGIFactory1> factory;
  if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory))))
    return Error{ErrorCode::kUnavailable, "streaming DXGI factory unavailable"};
  const bool qsv_required =
      (options.encoding.qsv_low_power && options.encoding.qsv_low_power_explicit);
  std::string failures;
  for (std::string_view backend : {"qsv", "nvenc"}) {
    if (options.encoder != "auto" && options.encoder != backend)
      continue;
    if (backend == "nvenc" && qsv_required)
      continue;
    const UINT vendor = backend == "qsv" ? 0x8086 : 0x10de;
    for (UINT index = 0;; ++index) {
      ComPtr<IDXGIAdapter1> adapter;
      const auto enumerated = factory->EnumAdapters1(index, &adapter);
      if (enumerated == DXGI_ERROR_NOT_FOUND)
        break;
      if (FAILED(enumerated))
        return Error{ErrorCode::kUnavailable, "streaming DXGI adapter enumeration failed"};
      DXGI_ADAPTER_DESC1 desc{};
      if (FAILED(adapter->GetDesc1(&desc)))
        return Error{ErrorCode::kUnavailable, "streaming DXGI adapter identity unavailable"};
      if ((desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) || desc.VendorId != vendor)
        continue;
      StreamingAdapter candidate{desc.AdapterLuid, std::string(backend)};
      std::string error;
      if (CreateDevice(&candidate.luid, candidate.device, candidate.context, error)) {
        const auto probe_stats = std::make_shared<EncoderStats>();
        // Exercise the same hardware initialization and input-surface setup as RTC.
        EncoderWorker probe(sdk, 0, candidate.device.Get(), candidate.encoder, options.encoding,
                            probe_stats, {}, {}, 0, {});
        remotekit_rtc_encoder_config config{};
        config.struct_size = sizeof(config);
        config.width = std::min(1280u, options.max_encode_width) & ~1u;
        config.height = std::min(720u, options.max_encode_height) & ~1u;
        config.h264_level_idc = options.encoding.level_idc;
        if (probe.Configure(config))
          return candidate;
        error = probe_stats->error;
      }
      failures += "; " + candidate.encoder + " " + AdapterLuid(candidate.luid) + ": " + error;
    }
  }
  return Error{ErrorCode::kUnavailable,
               "no hardware H264 streaming adapter for " + options.encoder + failures};
}
}  // namespace remotekit
