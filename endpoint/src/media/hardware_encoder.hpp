#pragma once
#include <d3d11_4.h>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>
namespace remotekit::media {
struct EncoderSettings {
  uint32_t width=0,height=0,fps=60,bitrate=24000000,max_bitrate=48000000;
  uint32_t level_idc=51,async_depth=1,gop=120,target_usage=4,buffer_ms=1000;
  bool vbr=false;
  bool target_usage_explicit=false,rate_control_explicit=false;
  uint32_t qsv_low_power=0; // mfxCodingOption: auto=0, on=0x10, off=0x20.
};
struct QsvLowPowerInfo {
  int requested=0;
  std::optional<int> queried,initialized,query_status,init_status,get_video_param_status;
};
struct AccessUnit {
  uint64_t frame_cookie=0;
  std::vector<uint8_t> bytes;
  bool keyframe=false;
  int qp=-1;
};
enum class CodecResult { accepted, busy, ready, pending, error };
// One worker owns each backend. Input NV12 texture is immutable and GPU-ready.
// accepted Submit retains the texture until matching Poll completion or Drain.
// Caller keeps its pool lease through completion; COM AddRef alone is not lease.
// Worker fills up to async_depth, then polls. Never sync immediately per Submit.
class HardwareEncoder {
 public:
  virtual ~HardwareEncoder() = default;
  virtual bool Configure(ID3D11Device*, const EncoderSettings&, std::string& error)=0;
  virtual CodecResult Submit(ID3D11Texture2D*, bool keyframe,uint64_t frame_cookie,
                             std::string& error)=0;
  virtual CodecResult Poll(uint32_t timeout_ms,AccessUnit&,std::string& error)=0;
  virtual bool SetRates(uint32_t bitrate,uint32_t fps,std::string& error)=0;
  virtual bool Drain(std::vector<AccessUnit>&,std::string& error)=0;
  virtual const char* Name() const=0;
  virtual std::optional<QsvLowPowerInfo> LowPowerInfo() const { return {}; }
  virtual bool TakeKeyframeRequest() { return false; }
  virtual EncoderSettings ActualSettings() const {
    EncoderSettings value;value.bitrate=value.max_bitrate=value.fps=value.level_idc=0;return value;
  }
};
std::unique_ptr<HardwareEncoder> CreateQsvEncoder();
std::unique_ptr<HardwareEncoder> CreateNvencEncoder();
} // namespace remotekit::media
