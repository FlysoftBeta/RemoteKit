#pragma once
#include <d3d11_4.h>
#include <dxgi1_4.h>
#include <wrl/client.h>
#include <string>
#include "server_trace.hpp"
namespace remotekit::media {
using Microsoft::WRL::ComPtr;
int64_t QpcNow();
int64_t QpcFrequency();
bool CreateDevice(const LUID* adapter,ComPtr<ID3D11Device5>&,ComPtr<ID3D11DeviceContext4>&,
                  std::string& error);
class Nv12Converter {
 public:
  void SetTrace(std::shared_ptr<ServerTrace> trace){trace_=std::move(trace);}
  void SetTraceFrame(TraceIds ids){trace_ids_=ids;}
  bool Open(ID3D11Device*,uint32_t width,uint32_t height,uint32_t fps,std::string& error,
            uint32_t source_width=0,uint32_t source_height=0);
  bool CreateSurface(ComPtr<ID3D11Texture2D>&,std::string& error);
  bool SafeToRelease() const { return safe_to_release_; }
  bool Convert(ID3D11Texture2D* bgra,ID3D11Texture2D* nv12,std::string& error);
 private:
  ComPtr<ID3D11Device5> device_;
  ComPtr<ID3D11DeviceContext4> context_;
  ComPtr<ID3D11VideoDevice> video_;
  ComPtr<ID3D11VideoContext> video_context_;
  ComPtr<ID3D11VideoProcessorEnumerator> enumerator_;
  ComPtr<ID3D11VideoProcessor> processor_;
  ComPtr<ID3D11Fence> fence_;
  uint64_t sequence_=0;
  uint32_t width_=0,height_=0,source_width_=0,source_height_=0,fps_=0;bool safe_to_release_=true;
  std::shared_ptr<ServerTrace> trace_;TraceIds trace_ids_;
};
}
