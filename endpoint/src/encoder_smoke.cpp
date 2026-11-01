#include "media/gpu_device.hpp"
#include "media/hardware_encoder.hpp"
#include <d3d11_4.h>
#include <cstdio>
#include <fstream>
#include <deque>
#include <map>
int main(int argc,char** argv) {
 using namespace remotekit::media;
 std::string error;
 ComPtr<ID3D11Device5> device;ComPtr<ID3D11DeviceContext4> context;
 if(!CreateDevice(nullptr,device,context,error)){fprintf(stderr,"%s\n",error.c_str());return 1;}
 EncoderSettings settings;settings.width=1280;settings.height=720;
 const bool steps=argc>3&&std::string(argv[3])=="steps";
 if(steps){settings.bitrate=2000000;settings.max_bitrate=40000000;}
 if(argc>4)settings.width=std::stoul(argv[4]);
 if(argc>5)settings.height=std::stoul(argv[5]);
 if(argc>6)settings.level_idc=std::stoul(argv[6]);
 // Optional trailing QSV mode, retaining all previous positional arguments.
 if(argc>7){const std::string low_power=argv[7];
  if(low_power!="auto"&&low_power!="on"&&low_power!="off"){fprintf(stderr,"QSV LowPower must be auto, on or off\n");return 1;}
  settings.qsv_low_power=low_power=="on"?0x10u:(low_power=="off"?0x20u:0u);
  if(argc>1&&std::string(argv[1])=="nvenc"&&settings.qsv_low_power){fprintf(stderr,"LowPower is QSV-only\n");return 1;}
 }
 if(argc>8){settings.target_usage=std::stoul(argv[8]);
  if(settings.target_usage<1||settings.target_usage>7){fprintf(stderr,"Target usage must be 1..7\n");return 1;}}
 if(argc>9){const std::string rate_control=argv[9];
  if(rate_control!="cbr"&&rate_control!="vbr"){fprintf(stderr,"Rate control must be cbr or vbr\n");return 1;}
  settings.vbr=rate_control=="vbr";
 }
 if(argc>2)settings.async_depth=static_cast<uint32_t>(std::stoul(argv[2]));
 auto encoder=(argc>1&&std::string(argv[1])=="nvenc")?CreateNvencEncoder():CreateQsvEncoder();
 if(!encoder->Configure(device.Get(),settings,error)){fprintf(stderr,"%s\n",error.c_str());return 2;}
 Nv12Converter converter;
 if(!converter.Open(device.Get(),settings.width,settings.height,settings.fps,error)){
  fprintf(stderr,"%s\n",error.c_str());return 3;
 }
 ComPtr<ID3D11Texture2D> bgra;
 D3D11_TEXTURE2D_DESC desc{};desc.Width=settings.width;desc.Height=settings.height;
 desc.MipLevels=desc.ArraySize=1;desc.Format=DXGI_FORMAT_B8G8R8A8_UNORM;
 desc.SampleDesc.Count=1;desc.BindFlags=D3D11_BIND_RENDER_TARGET;
 if(FAILED(device->CreateTexture2D(&desc,nullptr,&bgra)))return 4;
 ComPtr<ID3D11RenderTargetView> rtv;device->CreateRenderTargetView(bgra.Get(),nullptr,&rtv);
 std::vector<ComPtr<ID3D11Texture2D>> surfaces(settings.async_depth);
 for(auto& surface:surfaces)if(!converter.CreateSurface(surface,error)){
  fprintf(stderr,"%s\n",error.c_str());return 5;
 }
 std::ofstream output("hardware-smoke.h264",std::ios::binary);
 std::deque<uint32_t> free;
 for(uint32_t i=0;i<settings.async_depth;++i)free.push_back(i);
 std::map<uint64_t,uint32_t> inflight;
 uint64_t submitted=0,completed=0,bytes=0;auto started=QpcNow();
 const uint64_t total=steps?240:120;uint64_t phase_end=steps?60:total;bool force_key=true;
 while(completed<total) {
  if(steps && completed==phase_end && inflight.empty() && phase_end<total) {
   const uint32_t rate=completed==120?500000:18000000;
   const uint32_t step_fps=completed==60?22:(completed==120?29:60);
   const auto maximum=completed==120?36000000u:24000000u;
   if(!encoder->SetRates(rate,step_fps,error,maximum)){fprintf(stderr,"%s\n",error.c_str());return 12;}
   force_key|=encoder->TakeKeyframeRequest();auto actual=encoder->ActualSettings();
   fprintf(stderr,"rate step requested=%u actual=%u max=%u fps=%u\n",rate,actual.bitrate,actual.max_bitrate,actual.fps);
   phase_end+=60;
  }
  while(submitted<phase_end&&!free.empty()) {
   auto index=free.front();
   const float color[]={float(submitted%60)/60.f,0.2f,0.4f,1};
   context->ClearRenderTargetView(rtv.Get(),color);
   if(!converter.Convert(bgra.Get(),surfaces[index].Get(),error)){
    fprintf(stderr,"%s\n",error.c_str());return 6;
   }
   auto result=encoder->Submit(surfaces[index].Get(),force_key,submitted+1,error);
   if(result==CodecResult::busy)break;
   if(result!=CodecResult::accepted){fprintf(stderr,"%s\n",error.c_str());return 7;}
   force_key=false;free.pop_front();inflight[++submitted]=index;
  }
  AccessUnit unit;auto result=encoder->Poll(100,unit,error);
  if(result==CodecResult::error){fprintf(stderr,"%s\n",error.c_str());return 8;}
  if(result==CodecResult::ready) {
   output.write(reinterpret_cast<const char*>(unit.bytes.data()),unit.bytes.size());bytes+=unit.bytes.size();
   auto found=inflight.find(unit.frame_cookie);
   if(found==inflight.end()){fprintf(stderr,"unknown completion cookie\n");return 9;}
   free.push_back(found->second);inflight.erase(found);++completed;
  }
  if(QpcNow()-started>QpcFrequency()*30){fprintf(stderr,"encoding timed out\n");return 10;}
 }
 std::vector<AccessUnit> drain;
 if(!encoder->Drain(drain,error)){fprintf(stderr,"%s\n",error.c_str());return 11;}
 printf("{\"encoder\":\"%s\",\"frames\":%llu,\"bytes\":%llu,\"asyncDepth\":%u,\"elapsedMs\":%.2f}\n",
  encoder->Name(),completed,bytes,settings.async_depth,1000.0*(QpcNow()-started)/QpcFrequency());
}
