// Explicit hardware probe; never linked into endpoint_service.
#include <windows.h>
#include <d3d11_4.h>
#include <d3d10.h>
#include <dxgi1_4.h>
#include <pdh.h>
#include <pdhmsg.h>
#include <wrl/client.h>
#include <vpl/mfxdispatcher.h>
#include <vpl/mfxvideo.h>
#include <json.hpp>
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
using Microsoft::WRL::ComPtr;
using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;
static double Ms(Clock::time_point begin) { return std::chrono::duration<double,std::milli>(Clock::now()-begin).count(); }
static void Hr(HRESULT value,const char* name) { if(FAILED(value))throw std::runtime_error(std::string(name)+" HRESULT "+std::to_string(value)); }
static void Mfx(mfxStatus value,const char* name) { if(value!=MFX_ERR_NONE)throw std::runtime_error(std::string(name)+" MFX "+std::to_string(value)); }
static unsigned Align(unsigned value) { return (value+15)&~15u; }
static std::string Utf8(const std::wstring& value) { int size=WideCharToMultiByte(CP_UTF8,0,value.data(),static_cast<int>(value.size()),nullptr,0,nullptr,nullptr);std::string output(size,'\0');WideCharToMultiByte(CP_UTF8,0,value.data(),static_cast<int>(value.size()),output.data(),size,nullptr,nullptr);return output; }
static Json Info(const mfxFrameInfo& i) { return {{"fourcc",i.FourCC},{"width",i.Width},{"height",i.Height},{"cropX",i.CropX},{"cropY",i.CropY},{"cropW",i.CropW},{"cropH",i.CropH},{"chroma",i.ChromaFormat}}; }
struct Memory { ComPtr<ID3D11Texture2D> texture; unsigned index=0; };
struct Allocator {
 ComPtr<ID3D11Device> device; Json requests=Json::array();
 static mfxStatus MFX_CDECL Alloc(mfxHDL self,mfxFrameAllocRequest* r,mfxFrameAllocResponse* out) {
  auto& a=*static_cast<Allocator*>(self);
  a.requests.push_back({{"type",r->Type},{"min",r->NumFrameMin},{"suggested",r->NumFrameSuggested},{"info",Info(r->Info)}});
  auto format=r->Info.FourCC==MFX_FOURCC_NV12?DXGI_FORMAT_NV12:r->Info.FourCC==MFX_FOURCC_RGB4?DXGI_FORMAT_B8G8R8A8_UNORM:DXGI_FORMAT_UNKNOWN;
  if(format==DXGI_FORMAT_UNKNOWN)return MFX_ERR_UNSUPPORTED;
  auto ids=std::make_unique<mfxMemId[]>(r->NumFrameSuggested);
  unsigned made=0;
  for(;made<r->NumFrameSuggested;++made) {
   D3D11_TEXTURE2D_DESC d{}; d.Width=r->Info.Width;d.Height=r->Info.Height;d.MipLevels=d.ArraySize=1;d.Format=format;d.SampleDesc.Count=1;
   d.BindFlags=(format==DXGI_FORMAT_B8G8R8A8_UNORM||(r->Type&MFX_MEMTYPE_FROM_VPPOUT)||(r->Type&MFX_MEMTYPE_VIDEO_MEMORY_PROCESSOR_TARGET))?D3D11_BIND_RENDER_TARGET:D3D11_BIND_DECODER;
   if((r->Type&MFX_MEMTYPE_VIDEO_MEMORY_ENCODER_TARGET)&&(r->Type&MFX_MEMTYPE_INTERNAL_FRAME))d.BindFlags|=D3D11_BIND_VIDEO_ENCODER;
   auto memory=std::make_unique<Memory>();
   if(FAILED(a.device->CreateTexture2D(&d,nullptr,&memory->texture)))break;
   ids[made]=memory.release();
  }
  if(made!=r->NumFrameSuggested) { for(unsigned i=0;i<made;++i)delete static_cast<Memory*>(ids[i]);return MFX_ERR_MEMORY_ALLOC; }
  out->mids=ids.release();out->NumFrameActual=r->NumFrameSuggested;return MFX_ERR_NONE;
 }
 static mfxStatus MFX_CDECL Free(mfxHDL,mfxFrameAllocResponse* r) { for(unsigned i=0;i<r->NumFrameActual;++i)delete static_cast<Memory*>(r->mids[i]);delete[] r->mids;r->mids=nullptr;r->NumFrameActual=0;return MFX_ERR_NONE; }
 static mfxStatus MFX_CDECL Lock(mfxHDL,mfxMemId,mfxFrameData*) { return MFX_ERR_LOCK_MEMORY; }
 static mfxStatus MFX_CDECL Unlock(mfxHDL,mfxMemId,mfxFrameData*) { return MFX_ERR_NONE; }
 static mfxStatus MFX_CDECL Handle(mfxHDL,mfxMemId id,mfxHDL* result) { if(!id||!result)return MFX_ERR_NULL_PTR;auto& m=*static_cast<Memory*>(id);auto* pair=reinterpret_cast<mfxHDLPair*>(result);pair->first=m.texture.Get();pair->second=reinterpret_cast<mfxHDL>(static_cast<uintptr_t>(m.index));return MFX_ERR_NONE; }
};
// Keep driver references alive through component/session close, including throws.
struct Session {
 mfxLoader loader=nullptr;mfxSession session=nullptr;bool vpp=false,encode=false;
 Allocator allocator;mfxFrameAllocator callbacks{};
 std::vector<std::unique_ptr<Memory>> inputs,outputs;
 std::vector<mfxFrameSurface1> input_surfaces,output_surfaces;
 mfxBitstream bitstream{};mfxEncodeCtrl control{};std::vector<unsigned char> storage;
 ~Session() { if(session){if(encode)MFXVideoENCODE_Close(session);if(vpp)MFXVideoVPP_Close(session);MFXClose(session);}if(loader)MFXUnload(loader); }
};
class Engines {
 PDH_HQUERY query_=nullptr;PDH_HCOUNTER counter_=nullptr;
 std::jthread thread_;
 public:
 Json samples=Json::array();
 bool Open() {
  if(PdhOpenQueryW(nullptr,0,&query_)!=ERROR_SUCCESS)return false;
  if(PdhAddEnglishCounterW(query_,L"\\GPU Engine(*)\\Utilization Percentage",0,&counter_)!=ERROR_SUCCESS)return false;
  PdhCollectQueryData(query_);
  thread_=std::jthread([this](std::stop_token stop){auto started=Clock::now();const auto token=L"pid_"+std::to_wstring(GetCurrentProcessId())+L"_";
   while(!stop.stop_requested()) {
    std::this_thread::sleep_for(std::chrono::milliseconds(200));PdhCollectQueryData(query_);
    DWORD bytes=0,count=0;auto status=PdhGetFormattedCounterArrayW(counter_,PDH_FMT_DOUBLE|PDH_FMT_NOCAP100,&bytes,&count,nullptr);
    if(status!=PDH_MORE_DATA||!bytes)continue;
    std::vector<unsigned char> buffer(bytes);auto* items=reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(buffer.data());
    if(PdhGetFormattedCounterArrayW(counter_,PDH_FMT_DOUBLE|PDH_FMT_NOCAP100,&bytes,&count,items)!=ERROR_SUCCESS)continue;
    for(DWORD i=0;i<count;++i)if(items[i].szName&&std::wstring(items[i].szName).find(token)!=std::wstring::npos&&items[i].FmtValue.CStatus==PDH_CSTATUS_VALID_DATA) {
     std::wstring wide(items[i].szName);samples.push_back({{"atMs",Ms(started)},{"instance",Utf8(wide)},{"percent",items[i].FmtValue.doubleValue}});
    }
   }
  });return true;
 }
 void Stop() { if(thread_.joinable()){thread_.request_stop();thread_.join();} }
 ~Engines() { Stop();if(query_)PdhCloseQuery(query_); }
};
struct Gpu {
 ComPtr<ID3D11Device5> device;ComPtr<ID3D11DeviceContext4> context;ComPtr<ID3D11Fence> fence;
 HANDLE event=nullptr;uint64_t sequence=0;
 ~Gpu(){if(event)CloseHandle(event);}
 void Open(Json& report) {
  ComPtr<ID3D11Device> basic;ComPtr<ID3D11DeviceContext> immediate;
  const D3D_FEATURE_LEVEL levels[]={D3D_FEATURE_LEVEL_11_1,D3D_FEATURE_LEVEL_11_0};
  Hr(D3D11CreateDevice(nullptr,D3D_DRIVER_TYPE_HARDWARE,nullptr,D3D11_CREATE_DEVICE_BGRA_SUPPORT|D3D11_CREATE_DEVICE_VIDEO_SUPPORT,levels,2,D3D11_SDK_VERSION,&basic,nullptr,&immediate),"create device");
  Hr(basic.As(&device),"device5");Hr(immediate.As(&context),"context4");
  ComPtr<ID3D10Multithread> mt;Hr(immediate.As(&mt),"multithread");mt->SetMultithreadProtected(TRUE);
  ComPtr<IDXGIDevice> dxgi;Hr(device.As(&dxgi),"dxgi device");ComPtr<IDXGIAdapter> adapter;Hr(dxgi->GetAdapter(&adapter),"adapter");DXGI_ADAPTER_DESC desc{};Hr(adapter->GetDesc(&desc),"adapter desc");
  std::wstring name(desc.Description);report["adapter"]={{"description",Utf8(name)},{"vendorId",desc.VendorId},{"deviceId",desc.DeviceId},{"luidLow",desc.AdapterLuid.LowPart},{"luidHigh",desc.AdapterLuid.HighPart}};
  Hr(device->CreateFence(0,D3D11_FENCE_FLAG_NONE,IID_PPV_ARGS(&fence)),"fence");event=CreateEventW(nullptr,FALSE,FALSE,nullptr);if(!event)throw std::runtime_error("fence event");
 }
 void FinishExternalWrite() { auto value=++sequence;Hr(context->Signal(fence.Get(),value),"external source fence");context->Flush();Hr(fence->SetEventOnCompletion(value,event),"source completion");if(WaitForSingleObject(event,5000)!=WAIT_OBJECT_0||fence->GetCompletedValue()==UINT64_MAX)throw std::runtime_error("external source readiness timed out"); }
};
static void Prepare(mfxFrameInfo& i,unsigned fourcc,unsigned width,unsigned height,unsigned cropw,unsigned croph) {
 i={};i.FourCC=fourcc;i.Width=static_cast<mfxU16>(width);i.Height=static_cast<mfxU16>(height);i.CropW=static_cast<mfxU16>(cropw);i.CropH=static_cast<mfxU16>(croph);i.PicStruct=MFX_PICSTRUCT_PROGRESSIVE;i.ChromaFormat=static_cast<mfxU16>(fourcc==MFX_FOURCC_NV12?MFX_CHROMAFORMAT_YUV420:MFX_CHROMAFORMAT_YUV444);i.FrameRateExtN=60;i.FrameRateExtD=1;
}
static constexpr std::array<std::array<unsigned,3>,7> colors={{{0,0,0},{255,255,255},{255,0,0},{0,255,0},{0,0,255},{128,128,128},{255,255,0}}};
static void Pattern(std::vector<unsigned char>& pixels,unsigned width,unsigned height,unsigned cropw,unsigned cookie) {
 pixels.assign(static_cast<size_t>(width)*height*4,0);
 for(unsigned y=0;y<height;++y)for(unsigned x=0;x<width;++x) {
  auto rgb=x<cropw?colors[std::min(6u,x*7/cropw)]:std::array<unsigned,3>{255,0,255};
  if(x<cropw&&(x>=cropw-16||y<16))rgb={255,255,255};
  if(y>=height-64&&x<cropw){auto bit=std::min(7u,x*8/cropw);unsigned value=(cookie>>bit)&1?255u:0u;rgb={value,value,value};}
  auto offset=(static_cast<size_t>(y)*width+x)*4;pixels[offset]=static_cast<unsigned char>(rgb[2]);pixels[offset+1]=static_cast<unsigned char>(rgb[1]);pixels[offset+2]=static_cast<unsigned char>(rgb[0]);pixels[offset+3]=255;
 }
}
static Json Verify(Gpu& gpu,ID3D11Texture2D* nv12,unsigned cropw,unsigned croph,unsigned cookie,ComPtr<ID3D11Texture2D>& staging) {
 D3D11_TEXTURE2D_DESC desc{};nv12->GetDesc(&desc);
 if(!staging){desc.Usage=D3D11_USAGE_STAGING;desc.BindFlags=desc.MiscFlags=0;desc.CPUAccessFlags=D3D11_CPU_ACCESS_READ;Hr(gpu.device->CreateTexture2D(&desc,nullptr,&staging),"readback staging");}
 gpu.context->CopyResource(staging.Get(),nv12);gpu.FinishExternalWrite();
 D3D11_MAPPED_SUBRESOURCE mapped{};Hr(gpu.context->Map(staging.Get(),0,D3D11_MAP_READ,0,&mapped),"map NV12");
 struct Unmap { ID3D11DeviceContext* context;ID3D11Texture2D* texture;~Unmap(){context->Unmap(texture,0);} } unmap{gpu.context.Get(),staging.Get()};
 auto* data=static_cast<unsigned char*>(mapped.pData);Json samples=Json::array();unsigned max_error=0,observed_cookie=0;
 for(unsigned sample=0;sample<8;++sample) {
  const unsigned c=sample==7?1:sample;unsigned x=sample==7?cropw-4:(2*c+1)*cropw/14;x&=~1u;const unsigned y=(croph/3)&~1u;const auto& rgb=colors[c];double r=rgb[0],g=rgb[1],b=rgb[2];
  std::array<int,3> expected={static_cast<int>(std::lround(16+(.2126*r+.7152*g+.0722*b)*219/255)),static_cast<int>(std::lround(128+(-.114572*r-.385428*g+.5*b)*224/255)),static_cast<int>(std::lround(128+(.5*r-.454153*g-.045847*b)*224/255))};
  const auto uv=static_cast<size_t>(mapped.RowPitch)*desc.Height+(y/2)*mapped.RowPitch+x;
  std::array<unsigned,3> actual={data[static_cast<size_t>(y)*mapped.RowPitch+x],data[uv],data[uv+1]};
  for(unsigned k=0;k<3;++k)max_error=std::max(max_error,static_cast<unsigned>(std::abs(static_cast<int>(actual[k])-expected[k])));
  samples.push_back({{"x",x},{"rgb",rgb},{"expectedYuv709Limited",expected},{"actualYuv",actual}});
 }
 for(unsigned bit=0;bit<8;++bit){const unsigned x=(2*bit+1)*cropw/16;const unsigned y=croph-std::max(1u,32*croph/1088);if(data[static_cast<size_t>(y)*mapped.RowPitch+x]>128)observed_cookie|=1u<<bit;}
 Json edge=Json::array();const unsigned y=(croph/3)&~1u;
 for(unsigned x=cropw-std::min(16u,cropw);x<desc.Width;++x){unsigned chroma=x&~1u;size_t uv=static_cast<size_t>(mapped.RowPitch)*desc.Height+(y/2)*mapped.RowPitch+chroma;edge.push_back({{"x",x},{"insideCrop",x<cropw},{"yuv",{data[static_cast<size_t>(y)*mapped.RowPitch+x],data[uv],data[uv+1]}}});}
 return {{"colors",samples},{"rightCodedAndCropEdge",edge},{"codedPaddingExpected","unspecified: recorded to diagnose bleed, not claimed initialized"},{"maxColorError",max_error},{"cookie",observed_cookie},{"expectedCookie",cookie&255},{"ok",max_error<=4&&observed_cookie==(cookie&255)}};
}
static Json RunCase(const std::string& name,unsigned frames,unsigned scaling_mode,bool verify,bool vpp_only,unsigned midstream_drain_at) {
 Json report={{"case",name},{"pid",GetCurrentProcessId()},{"framesRequested",frames},{"stage",vpp_only?"vpp-only":"same-session-vpp-encode"},{"scalingModeRequested",scaling_mode},{"geometryPolicy","full input crop to full output crop; not production letterbox"},{"verificationReadback",verify},{"midstreamDrainAt",midstream_drain_at},{"events",Json::array()}};
 if(midstream_drain_at)report["midstreamDrainScope"]="after final Sync of all prior frames; no Close/Reset before resuming; not held/busy/B-frame coverage";
 Gpu gpu;Session s;Engines engines;auto started=Clock::now();
 try {
  gpu.Open(report);s.allocator.device=gpu.device;report["engineCollectionAvailable"]=engines.Open();
  s.loader=MFXLoad();if(!s.loader)throw std::runtime_error("MFXLoad");
  for(auto property:std::array<std::pair<const char*,mfxU32>,2>{{{"mfxImplDescription.Impl",MFX_IMPL_TYPE_HARDWARE},{"mfxImplDescription.AccelerationMode",MFX_ACCEL_MODE_VIA_D3D11}}}) {auto config=MFXCreateConfig(s.loader);mfxVariant value{};value.Type=MFX_VARIANT_TYPE_U32;value.Data.U32=property.second;Mfx(MFXSetConfigFilterProperty(config,reinterpret_cast<const mfxU8*>(property.first),value),"filter");}
  Mfx(MFXCreateSession(s.loader,0,&s.session),"create hardware session");mfxVersion version{};Mfx(MFXQueryVersion(s.session,&version),"version");report["runtimeApi"]={{"major",version.Major},{"minor",version.Minor}};
  Mfx(MFXVideoCORE_SetHandle(s.session,MFX_HANDLE_D3D11_DEVICE,gpu.device.Get()),"SetHandle");
  s.callbacks.pthis=&s.allocator;s.callbacks.Alloc=Allocator::Alloc;s.callbacks.Free=Allocator::Free;s.callbacks.Lock=Allocator::Lock;s.callbacks.Unlock=Allocator::Unlock;s.callbacks.GetHDL=Allocator::Handle;Mfx(MFXVideoCORE_SetFrameAllocator(s.session,&s.callbacks),"allocator");
  const unsigned sourcew=1936,sourceh=1088,cropw=name=="full"?1936:1928,outw=name=="scale"?1280:cropw,outh=name=="scale"?720:sourceh;
  mfxVideoParam vp{};vp.AsyncDepth=1;vp.IOPattern=MFX_IOPATTERN_IN_VIDEO_MEMORY|MFX_IOPATTERN_OUT_VIDEO_MEMORY;
  Prepare(vp.vpp.In,MFX_FOURCC_RGB4,sourcew,sourceh,cropw,sourceh);Prepare(vp.vpp.Out,MFX_FOURCC_NV12,Align(outw),Align(outh),outw,outh);
  mfxExtVPPVideoSignalInfo color{};color.Header={MFX_EXTBUFF_VPP_VIDEO_SIGNAL_INFO,sizeof(color)};color.In.NominalRange=MFX_NOMINALRANGE_0_255;color.In.TransferMatrix=MFX_TRANSFERMATRIX_BT709;color.Out.NominalRange=MFX_NOMINALRANGE_16_235;color.Out.TransferMatrix=MFX_TRANSFERMATRIX_BT709;
  mfxExtVPPScaling scaling{};scaling.Header={MFX_EXTBUFF_VPP_SCALING,sizeof(scaling)};scaling.ScalingMode=static_cast<mfxU16>(scaling_mode);
  mfxExtBuffer* extensions[]={reinterpret_cast<mfxExtBuffer*>(&color),reinterpret_cast<mfxExtBuffer*>(&scaling)};vp.ExtParam=extensions;vp.NumExtParam=name=="scale"?2:1;
  report["requestedInput"]=Info(vp.vpp.In);report["requestedOutput"]=Info(vp.vpp.Out);
  auto query=vp;const auto qs=MFXVideoVPP_Query(s.session,&vp,&query);report["vppQuery"]={{"status",qs},{"input",Info(query.vpp.In)},{"output",Info(query.vpp.Out)},{"colorOutRange",color.Out.NominalRange},{"colorOutMatrix",color.Out.TransferMatrix},{"scalingMode",scaling.ScalingMode}};
  Mfx(qs,"VPP Query (warnings are explicit failures in this probe)");if(Info(query.vpp.In)!=Info(vp.vpp.In)||Info(query.vpp.Out)!=Info(vp.vpp.Out))throw std::runtime_error("VPP Query changed format/geometry");
  mfxFrameAllocRequest requests[2]{};Mfx(MFXVideoVPP_QueryIOSurf(s.session,&vp,requests),"VPP QueryIOSurf");report["vppSurfaceNeeds"]={{{"min",requests[0].NumFrameMin},{"suggested",requests[0].NumFrameSuggested},{"type",requests[0].Type}},{{"min",requests[1].NumFrameMin},{"suggested",requests[1].NumFrameSuggested},{"type",requests[1].Type}}};
  auto init=MFXVideoVPP_Init(s.session,&vp);report["vppInit"]=init;if(init>=0)s.vpp=true;Mfx(init,"VPP Init");
  mfxVideoParam actual=vp;Mfx(MFXVideoVPP_GetVideoParam(s.session,&actual),"VPP GetVideoParam");report["vppActual"]={{"input",Info(actual.vpp.In)},{"output",Info(actual.vpp.Out)},{"range",color.Out.NominalRange},{"matrix",color.Out.TransferMatrix},{"scalingMode",scaling.ScalingMode}};
  if(Info(actual.vpp.In)!=Info(vp.vpp.In)||Info(actual.vpp.Out)!=Info(vp.vpp.Out)||color.Out.NominalRange!=MFX_NOMINALRANGE_16_235||color.Out.TransferMatrix!=MFX_TRANSFERMATRIX_BT709)throw std::runtime_error("VPP actual changed required geometry/color");
  mfxVideoParam enc{};enc.AsyncDepth=1;enc.IOPattern=MFX_IOPATTERN_IN_VIDEO_MEMORY;enc.mfx.CodecId=MFX_CODEC_AVC;enc.mfx.CodecProfile=MFX_PROFILE_AVC_CONSTRAINED_BASELINE;enc.mfx.TargetUsage=1;enc.mfx.RateControlMethod=MFX_RATECONTROL_VBR;enc.mfx.TargetKbps=18000;enc.mfx.MaxKbps=40000;enc.mfx.GopPicSize=120;enc.mfx.GopRefDist=1;enc.mfx.NumRefFrame=1;enc.mfx.FrameInfo=vp.vpp.Out;
  mfxExtVideoSignalInfo vui{};vui.Header={MFX_EXTBUFF_VIDEO_SIGNAL_INFO,sizeof(vui)};vui.VideoFormat=5;vui.ColourDescriptionPresent=1;vui.ColourPrimaries=vui.TransferCharacteristics=vui.MatrixCoefficients=1;
  mfxExtBuffer* ee[]={reinterpret_cast<mfxExtBuffer*>(&vui)};enc.ExtParam=ee;enc.NumExtParam=1;mfxFrameAllocRequest er{};
  if(!vpp_only) {auto status=MFXVideoENCODE_Query(s.session,&enc,&enc);report["encodeQuery"]=status;if(status<0)Mfx(status,"Encode Query");Mfx(MFXVideoENCODE_QueryIOSurf(s.session,&enc,&er),"Encode QueryIOSurf");status=MFXVideoENCODE_Init(s.session,&enc);report["encodeInit"]=status;if(status>=0)s.encode=true;if(status<0)Mfx(status,"Encode Init");Mfx(MFXVideoENCODE_GetVideoParam(s.session,&enc),"Encode GetVideoParam");report["encodeActual"]={{"frame",Info(enc.mfx.FrameInfo)},{"range",vui.VideoFullRange},{"matrix",vui.MatrixCoefficients},{"primaries",vui.ColourPrimaries},{"transfer",vui.TransferCharacteristics},{"bufferSizeKB",enc.mfx.BufferSizeInKB},{"brcMultiplier",enc.mfx.BRCParamMultiplier},{"targetKBps",enc.mfx.TargetKbps},{"maxKBps",enc.mfx.MaxKbps}};if(Info(enc.mfx.FrameInfo)!=Info(vp.vpp.Out)||vui.VideoFullRange||vui.MatrixCoefficients!=1)throw std::runtime_error("encoder changed output geometry or BT709 limited VUI");}
  const unsigned input_count=std::max<unsigned>(1,requests[0].NumFrameSuggested),output_count=std::max<unsigned>(1,requests[1].NumFrameSuggested+(vpp_only?0:er.NumFrameSuggested)-(!vpp_only?1:0));report["allocatedInputSurfaces"]=input_count;report["allocatedOutputSurfaces"]=output_count;
  auto allocate=[&](unsigned count,const mfxFrameInfo& info,bool input){auto& memories=input?s.inputs:s.outputs;auto& surfaces=input?s.input_surfaces:s.output_surfaces;surfaces.resize(count);
   for(unsigned i=0;i<count;++i){auto memory=std::make_unique<Memory>();D3D11_TEXTURE2D_DESC d{};d.Width=info.Width;d.Height=info.Height;d.MipLevels=d.ArraySize=1;d.Format=input?DXGI_FORMAT_B8G8R8A8_UNORM:DXGI_FORMAT_NV12;d.SampleDesc.Count=1;d.BindFlags=D3D11_BIND_RENDER_TARGET|(input?D3D11_BIND_SHADER_RESOURCE:D3D11_BIND_VIDEO_ENCODER);Hr(gpu.device->CreateTexture2D(&d,nullptr,&memory->texture),"external surface");surfaces[i].Info=info;surfaces[i].Data.MemId=memory.get();memories.push_back(std::move(memory));}
  };allocate(input_count,vp.vpp.In,true);allocate(output_count,vp.vpp.Out,false);
  std::ofstream bitstream;if(!vpp_only){auto filename=name+"-qsv-vpp.h264";if(std::filesystem::exists(filename))throw std::runtime_error("bitstream already exists; use a new output directory");bitstream.open(filename,std::ios::binary);if(!bitstream)throw std::runtime_error("open bitstream");report["bitstreamFile"]=filename;}
  std::ofstream segment;
  auto open_segment=[&](const char* phase){if(!midstream_drain_at)return;if(segment.is_open()){segment.flush();if(!segment)throw std::runtime_error("write H264 segment failed");segment.close();}auto filename=name+"-"+phase+"-drain.h264";if(std::filesystem::exists(filename))throw std::runtime_error("segment already exists; use a new output directory");segment.open(filename,std::ios::binary);if(!segment)throw std::runtime_error("open H264 segment");report[std::string(phase)+"DrainBitstreamFile"]=filename;};
  open_segment("before");
  auto write_packet=[&](const mfxBitstream& packet){if(packet.DataOffset>packet.MaxLength||packet.DataLength>packet.MaxLength-packet.DataOffset)throw std::runtime_error("invalid bitstream bounds");bitstream.write(reinterpret_cast<const char*>(packet.Data+packet.DataOffset),packet.DataLength);if(segment.is_open())segment.write(reinterpret_cast<const char*>(packet.Data+packet.DataOffset),packet.DataLength);if(!bitstream||(segment.is_open()&&!segment))throw std::runtime_error("write H264 packet failed");};
  std::vector<unsigned char> pixels;s.storage.resize(8*1024*1024);ComPtr<ID3D11Texture2D> staging;unsigned completed=0;auto runstart=Clock::now();
  auto sync=[&](mfxSyncPoint point,const char* stage){auto begin=Clock::now();mfxStatus status;do {status=MFXVideoCORE_SyncOperation(s.session,point,100);if(Ms(begin)>5000)throw std::runtime_error(std::string(stage)+" timeout");}while(status==MFX_WRN_IN_EXECUTION);Mfx(status,stage);return Ms(begin);};
  for(unsigned cookie=1;cookie<=frames;++cookie) {
   if(Ms(started)>60000)throw std::runtime_error("probe case deadline");
   auto& input=s.input_surfaces[(cookie-1)%input_count];auto& output=s.output_surfaces[(cookie-1)%output_count];if(input.Data.Locked||output.Data.Locked)throw std::runtime_error("selected surface still Locked");
   Pattern(pixels,sourcew,sourceh,cropw,cookie);auto source_begin=Clock::now();gpu.context->UpdateSubresource(s.inputs[(cookie-1)%input_count]->texture.Get(),0,nullptr,pixels.data(),sourcew*4,0);gpu.FinishExternalWrite();double source_ms=Ms(source_begin);input.Data.TimeStamp=cookie;output.Data.TimeStamp=cookie;
   mfxSyncPoint vs=nullptr,es=nullptr;auto begin=Clock::now();mfxStatus status;unsigned vbusy=0,ebusy=0;
   do {status=MFXVideoVPP_RunFrameVPPAsync(s.session,&input,&output,nullptr,&vs);if(status==MFX_WRN_DEVICE_BUSY){++vbusy;std::this_thread::sleep_for(std::chrono::milliseconds(1));}if(Ms(begin)>5000)throw std::runtime_error("VPP submit timeout");}while(status==MFX_WRN_DEVICE_BUSY);
   if(status!=MFX_ERR_NONE||!vs)throw std::runtime_error("VPP non-1:1 status "+std::to_string(status)+" (surface owners kept until Close)");
   Json row={{"cookie",cookie},{"externalSourceUploadAndReadyMs",source_ms},{"vppInputLockedAfterSubmit",input.Data.Locked},{"vppOutputLockedAfterSubmit",output.Data.Locked},{"vppBusy",vbusy},{"vppSubmitMs",Ms(begin)}};if(midstream_drain_at)row["afterMidstreamDrain"]=cookie>midstream_drain_at;auto& bs=s.bitstream;bs={};bs.Data=s.storage.data();bs.MaxLength=static_cast<mfxU32>(s.storage.size());
   if(vpp_only)row["finalVppSyncMs"]=sync(vs,"VPP Sync");
   else {s.control={};if(cookie==1)s.control.FrameType=MFX_FRAMETYPE_I|MFX_FRAMETYPE_IDR|MFX_FRAMETYPE_REF;
    row["encodeBufferAttempts"]=Json::array();auto encode_begin=Clock::now();while(true){if(Ms(encode_begin)>5000)throw std::runtime_error("Encode submit timeout");status=MFXVideoENCODE_EncodeFrameAsync(s.session,&s.control,&output,&bs,&es);row["encodeBufferAttempts"].push_back({{"status",status},{"maxLength",bs.MaxLength},{"dataOffset",bs.DataOffset},{"dataLength",bs.DataLength}});if(status==MFX_ERR_NOT_ENOUGH_BUFFER&&s.storage.size()<64*1024*1024){s.storage.resize(s.storage.size()*2);bs.Data=s.storage.data();bs.MaxLength=static_cast<mfxU32>(s.storage.size());report["bitstreamBufferGrewToBytes"]=s.storage.size();continue;}if(status==MFX_WRN_DEVICE_BUSY){++ebusy;std::this_thread::sleep_for(std::chrono::milliseconds(1));continue;}break;}
    row["encodeSubmitStatus"]=status;row["encodeInputIsExactVppOutputObject"]=true;if(midstream_drain_at&&cookie==midstream_drain_at+1)report["firstResumedEncodeStatus"]=status;
    if(status==MFX_ERR_MORE_DATA){do {status=MFXVideoENCODE_EncodeFrameAsync(s.session,nullptr,nullptr,&bs,&es);if(status==MFX_WRN_DEVICE_BUSY)std::this_thread::sleep_for(std::chrono::milliseconds(1));if(Ms(encode_begin)>5000)throw std::runtime_error("Encode delayed output timeout");}while(status==MFX_WRN_DEVICE_BUSY);row["encodeFlushStatus"]=status;}
    if(status!=MFX_ERR_NONE){report["events"].push_back(row);Mfx(status,"Encode submit");}if(!es)throw std::runtime_error("Encode accepted without sync");row["finalEncodeSyncMs"]=sync(es,"Encode Sync");row["encodeBusy"]=ebusy;row["bitstreamTimestamp"]=bs.TimeStamp;row["frameType"]=bs.FrameType;row["finalBitstream"]={{"maxLength",bs.MaxLength},{"dataOffset",bs.DataOffset},{"dataLength",bs.DataLength}};if(bs.TimeStamp!=cookie)throw std::runtime_error("bitstream timestamp mismatch");write_packet(bs);row["bytes"]=bs.DataLength;
   }
   row["inputLockedAfterFinalSync"]=input.Data.Locked;row["outputLockedAfterFinalSync"]=output.Data.Locked;if(input.Data.Locked||output.Data.Locked)throw std::runtime_error("surface still Locked after final sync");
   if(verify){row["verify"]=Verify(gpu,s.outputs[(cookie-1)%output_count]->texture.Get(),outw,outh,cookie,staging);if(!row["verify"]["ok"].get<bool>()){report["events"].push_back(row);throw std::runtime_error("NV12 color/crop/continuity verification failed");}}
   report["events"].push_back(std::move(row));++completed;report["framesCompleted"]=completed;
   if(midstream_drain_at&&cookie>midstream_drain_at)report["resumedFramesCompleted"]=cookie-midstream_drain_at;
   if(midstream_drain_at && cookie==midstream_drain_at) {
    report["midstreamDrainCalls"]=Json::array();report["midstreamDrainCompleted"]=false;
    auto drain_begin=Clock::now();unsigned packets=0;bool drained=false;
    for(unsigned call=1;call<=64;++call) {
     if(Ms(drain_begin)>5000)throw std::runtime_error("midstream NULL drain deadline");
     bs={};bs.Data=s.storage.data();bs.MaxLength=static_cast<mfxU32>(s.storage.size());mfxSyncPoint point=nullptr;
     auto status=MFXVideoENCODE_EncodeFrameAsync(s.session,nullptr,nullptr,&bs,&point);
     Json drain_row={{"call",call},{"status",status},{"hasSync",point!=nullptr},{"maxLength",bs.MaxLength},{"dataOffset",bs.DataOffset},{"dataLength",bs.DataLength},{"timestampBeforeSync",bs.TimeStamp}};
     if(status==MFX_WRN_DEVICE_BUSY){report["midstreamDrainCalls"].push_back(std::move(drain_row));std::this_thread::sleep_for(std::chrono::milliseconds(1));continue;}
     if(status==MFX_ERR_NOT_ENOUGH_BUFFER && s.storage.size()<64*1024*1024){report["midstreamDrainCalls"].push_back(std::move(drain_row));s.storage.resize(s.storage.size()*2);continue;}
     if(status==MFX_ERR_MORE_DATA && !point){report["midstreamDrainCalls"].push_back(std::move(drain_row));drained=true;break;}
     if(status!=MFX_ERR_NONE || !point){report["midstreamDrainCalls"].push_back(std::move(drain_row));throw std::runtime_error("midstream NULL drain rejected/unexpected status "+std::to_string(status));}
     report["midstreamDrainCalls"].push_back(std::move(drain_row));auto& recorded=report["midstreamDrainCalls"].back();
     recorded["finalEncodeSyncMs"]=sync(point,"midstream drain Encode Sync");recorded["timestampAfterSync"]=bs.TimeStamp;recorded["dataOffsetAfterSync"]=bs.DataOffset;recorded["dataLengthAfterSync"]=bs.DataLength;recorded["frameType"]=bs.FrameType;
     write_packet(bs);++packets;
    }
    if(!drained)throw std::runtime_error("midstream NULL drain call budget exhausted");
    unsigned locked=0;for(auto& surface:s.input_surfaces)locked+=surface.Data.Locked;for(auto& surface:s.output_surfaces)locked+=surface.Data.Locked;
    report["midstreamDrainRemainingLocked"]=locked;report["midstreamDrainOutputPackets"]=packets;
    if(locked)throw std::runtime_error("surface still Locked after midstream drain");
    report["midstreamDrainCompleted"]=true;report["midstreamDrainMs"]=Ms(drain_begin);report["resumeWithoutCloseOrReset"]=true;
    open_segment("after");
   }
   std::this_thread::sleep_until(runstart+std::chrono::microseconds(static_cast<int64_t>(cookie)*1000000/60));
  }
  if(!vpp_only){s.bitstream={};s.bitstream.Data=s.storage.data();s.bitstream.MaxLength=static_cast<mfxU32>(s.storage.size());mfxSyncPoint point=nullptr;auto status=MFXVideoENCODE_EncodeFrameAsync(s.session,nullptr,nullptr,&s.bitstream,&point);report["encodeDrainStatus"]=status;if(status!=MFX_ERR_MORE_DATA)throw std::runtime_error("unexpected extra encode drain output");}
  mfxSyncPoint tail=nullptr;auto status=MFXVideoVPP_RunFrameVPPAsync(s.session,nullptr,&s.output_surfaces[0],nullptr,&tail);report["vppDrainStatus"]=status;if(status!=MFX_ERR_MORE_DATA)throw std::runtime_error("unexpected extra VPP drain output");
  report["success"]=true;
 }catch(const std::exception& error){report["success"]=false;report["error"]=error.what();}
 engines.Stop();report["engineSamples"]=engines.samples;report["allocatorRequests"]=s.allocator.requests;report["elapsedMs"]=Ms(started);return report;
}
int main(int argc,char** argv) {
 try {
  std::string selected="noscale",output;unsigned frames=120,mode=0,midstream_drain_at=0;bool verify=true,vpp_only=false;
  for(int i=1;i<argc;++i){std::string arg=argv[i];if(arg=="--help"){puts("qsv_vpp_probe --output=NEW.json [--case=noscale|full|scale|all] [--frames=120] [--scaling-mode=0|1|2] [--verify=none] [--stage=vpp] [--midstream-drain-at=30]\nGPU runs only when --output is supplied. Input texture is always real 1936x1088; noscale/scale valid crop 1928, full valid crop 1936. H264 files are placed beside JSON. verification adds explicit post-chain NV12 readback; disable only for engine attribution after correctness passes. Midstream drain is opt-in, requires a single chain case with verification and 0<drain-at<frames, and resumes without Close/Reset; it does not simulate held/busy/B-frame reordering.");return 0;}else if(arg.starts_with("--output="))output=arg.substr(9);else if(arg.starts_with("--case="))selected=arg.substr(7);else if(arg.starts_with("--frames="))frames=std::stoul(arg.substr(9));else if(arg.starts_with("--scaling-mode="))mode=std::stoul(arg.substr(15));else if(arg.starts_with("--midstream-drain-at="))midstream_drain_at=std::stoul(arg.substr(21));else if(arg=="--verify=none")verify=false;else if(arg=="--stage=vpp")vpp_only=true;else throw std::runtime_error("unknown argument "+arg);}
  if(output.empty()||!frames||frames>600||mode>2||(selected!="noscale"&&selected!="full"&&selected!="scale"&&selected!="all"))throw std::runtime_error("invalid options; use --help");
  if(midstream_drain_at && (midstream_drain_at>=frames || vpp_only || !verify || selected=="all"))throw std::runtime_error("midstream drain requires one chain case with verification and drain-at<frames");
  auto path=std::filesystem::absolute(output);if(std::filesystem::exists(path))throw std::runtime_error("output already exists");std::filesystem::create_directories(path.parent_path());std::filesystem::current_path(path.parent_path());Json result={{"schema","remotekit-qsv-vpp-probe-v1"},{"cases",Json::array()}};bool success=true;
  for(auto name:std::array<std::string,3>{"noscale","full","scale"})if(selected==name||selected=="all"){auto row=RunCase(name,frames,mode,verify,vpp_only,midstream_drain_at);bool okay=row["success"].get<bool>();result["cases"].push_back(std::move(row));success&=okay;if(!okay)break;}
  result["success"]=success;std::ofstream file(path);file<<result.dump(2)<<'\n';if(!file)throw std::runtime_error("write report failed");printf("%s\n",success?"probe passed":"probe failed; see JSON");return success?0:1;
 }catch(const std::exception& error){fprintf(stderr,"%s\n",error.what());return 2;}
}
