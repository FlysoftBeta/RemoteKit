#include "media/gpu_device.hpp"
#include "media/hardware_encoder.hpp"
#include <d3d11_4.h>
#include <chrono>
#include <cstdio>
#include <fstream>
#include <deque>
#include <map>
#include <thread>
int main(int argc,char** argv) {
 using namespace remotekit::media;
 std::string error;
 ComPtr<ID3D11Device5> device;ComPtr<ID3D11DeviceContext4> context;
 if(!CreateDevice(nullptr,device,context,error)){fprintf(stderr,"%s\n",error.c_str());return 1;}
 EncoderSettings settings;settings.width=1280;settings.height=720;
 const std::string scenario=argc>3?argv[3]:"";
 const bool steps=scenario=="steps";
 const bool low_fps=scenario=="qsv-low-fps";
 const bool nvenc=argc>1&&std::string(argv[1])=="nvenc";
 if(low_fps&&nvenc){fprintf(stderr,"qsv-low-fps requires QSV\n");return 1;}
 if(steps){settings.bitrate=2000000;settings.max_bitrate=40000000;}
 if(argc>4)settings.width=std::stoul(argv[4]);
 if(argc>5)settings.height=std::stoul(argv[5]);
 if(argc>6)settings.level_idc=std::stoul(argv[6]);
 // Optional trailing QSV mode, retaining all previous positional arguments.
 if(argc>7){const std::string low_power=argv[7];
  if(low_power!="auto"&&low_power!="on"&&low_power!="off"){fprintf(stderr,"QSV LowPower must be auto, on or off\n");return 1;}
  settings.qsv_low_power=low_power=="on"?0x10u:(low_power=="off"?0x20u:0u);
  if(nvenc&&settings.qsv_low_power){fprintf(stderr,"LowPower is QSV-only\n");return 1;}
 }
 if(argc>8){settings.target_usage=std::stoul(argv[8]);
  if(settings.target_usage<1||settings.target_usage>7){fprintf(stderr,"Target usage must be 1..7\n");return 1;}}
 if(argc>9){const std::string rate_control=argv[9];
  if(rate_control!="cbr"&&rate_control!="vbr"){fprintf(stderr,"Rate control must be cbr or vbr\n");return 1;}
  settings.vbr=rate_control=="vbr";
 }
 if(argc>2)settings.async_depth=static_cast<uint32_t>(std::stoul(argv[2]));
 if(low_fps) {
  settings.width=1168;settings.height=752;settings.level_idc=52;
  settings.bitrate=45535000;settings.target_usage=7;settings.qsv_low_power=0x10;settings.vbr=true;
 }
 auto encoder=nvenc?CreateNvencEncoder():CreateQsvEncoder();
 if(!encoder->Configure(device.Get(),settings,error)){fprintf(stderr,"%s\n",error.c_str());return 2;}
 if(low_fps) {
  const auto actual=encoder->ActualSettings();
  if(actual.fps!=settings.fps || !actual.level_idc || actual.level_idc>settings.level_idc) {
   fprintf(stderr,"unexpected initial QSV fps=%u level=%u\n",actual.fps,actual.level_idc);return 13;
  }
 }
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
 const uint64_t total=low_fps?7:(steps?240:120);
 uint64_t phase_end=low_fps?1:(steps?60:total);bool force_key=true;
 bool expect_idr=true;
 auto last_input=std::chrono::steady_clock::now();
 auto first_low_report=last_input;
 uint32_t input_fps=settings.fps;
 while(completed<total) {
  if(low_fps && completed==phase_end && inflight.empty()) {
   // Report 2 FPS across two half-second input intervals before allowing the
   // timebase to fall. Recovery starts at 6 FPS and must jump directly to 60.
   const uint32_t rates[]={settings.bitrate,38015000,38015000,38015000,38015000,38171667};
   const uint32_t cadences[]={2,2,2,2,6,60};
   const uint32_t expected_fps[]={settings.fps,settings.fps,2,2,settings.fps,settings.fps};
   const auto step=completed-1;
   if(step==2)std::this_thread::sleep_until(first_low_report+std::chrono::seconds(1));
   const auto previous_fps=encoder->ActualSettings().fps;
   input_fps=cadences[step];
   if(!encoder->SetRates(rates[step],input_fps,error,settings.max_bitrate)) {
    fprintf(stderr,"%s\n",error.c_str());return 12;
   }
   if(step==0)first_low_report=std::chrono::steady_clock::now();
   const auto actual=encoder->ActualSettings();
   const bool bitrate_changed=rates[step]!=(step?rates[step-1]:settings.bitrate);
   const bool cadence_changed=expected_fps[step]!=previous_fps;
   force_key=encoder->TakeKeyframeRequest();
   expect_idr=force_key;
   fprintf(stderr,"QSV low-fps frame=%llu inputFps=%u appliedFps=%u level=%u requestedBps=%u appliedBps=%u recoveryIdr=%d\n",
    completed+1,input_fps,actual.fps,actual.level_idc,rates[step],actual.bitrate,expect_idr);
   if(actual.fps!=expected_fps[step] || !actual.level_idc || actual.level_idc>settings.level_idc ||
      (cadence_changed && !expect_idr) || (!cadence_changed && !bitrate_changed && expect_idr)) {
    fprintf(stderr,"unexpected QSV timebase, level, or IDR request\n");return 13;
   }
   ++phase_end;
  }
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
   if(low_fps && submitted)std::this_thread::sleep_until(last_input+std::chrono::microseconds(1000000/input_fps));
   auto index=free.front();
   const float color[]={float(submitted%60)/60.f,0.2f,0.4f,1};
   context->ClearRenderTargetView(rtv.Get(),color);
   if(!converter.Convert(bgra.Get(),surfaces[index].Get(),error)){
    fprintf(stderr,"%s\n",error.c_str());return 6;
   }
   auto result=encoder->Submit(surfaces[index].Get(),force_key,submitted+1,error);
   if(result==CodecResult::busy)break;
   if(result!=CodecResult::accepted){fprintf(stderr,"%s\n",error.c_str());return 7;}
   if(low_fps)last_input=std::chrono::steady_clock::now();
   force_key=false;free.pop_front();inflight[++submitted]=index;
  }
  AccessUnit unit;auto result=encoder->Poll(100,unit,error);
  if(result==CodecResult::error){fprintf(stderr,"%s\n",error.c_str());return 8;}
  if(result==CodecResult::ready) {
   if(low_fps) {
    fprintf(stderr,"QSV low-fps output frame=%llu idr=%d bytes=%zu\n",unit.frame_cookie,unit.keyframe,unit.bytes.size());
    if(unit.keyframe!=expect_idr || unit.bytes.empty()) {
     fprintf(stderr,"unexpected QSV access unit after rate update\n");return 14;
    }
   }
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
