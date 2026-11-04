// Explicit capability probe. No frames are encoded and no latency is measured.
#include <windows.h>
#include <d3d11_4.h>
#include <d3d10.h>
#include <dxgi.h>
#include <wrl/client.h>
#include <vpl/mfxdispatcher.h>
#include <vpl/mfxvideo.h>
#include <json.hpp>
#include <array>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
using Microsoft::WRL::ComPtr;
using Json = nlohmann::json;
static void Check(mfxStatus status,const char* action) {
  if(status<0)throw std::runtime_error(std::string(action)+" MFX "+std::to_string(status));
}
static void Hr(HRESULT status,const char* action) {
  if(FAILED(status))throw std::runtime_error(std::string(action)+" HRESULT "+std::to_string(status));
}
struct Memory { ComPtr<ID3D11Texture2D> texture; };
struct Session {
  ComPtr<ID3D11Device> device;
  mfxLoader loader=nullptr;
  mfxSession session=nullptr;
  mfxFrameAllocator allocator{};
  bool initialized=false;
  ~Session() {
    if(session){if(initialized)MFXVideoENCODE_Close(session);MFXClose(session);}
    if(loader)MFXUnload(loader);
  }
  static mfxStatus MFX_CDECL Alloc(mfxHDL self,mfxFrameAllocRequest* request,mfxFrameAllocResponse* response) {
    if(request->Info.FourCC!=MFX_FOURCC_NV12)return MFX_ERR_UNSUPPORTED;
    auto& s=*static_cast<Session*>(self);
    auto ids=std::make_unique<mfxMemId[]>(request->NumFrameSuggested);
    for(unsigned i=0;i<request->NumFrameSuggested;++i) {
      auto memory=std::make_unique<Memory>();
      D3D11_TEXTURE2D_DESC desc{};
      desc.Width=request->Info.Width;desc.Height=request->Info.Height;
      desc.MipLevels=desc.ArraySize=1;desc.Format=DXGI_FORMAT_NV12;desc.SampleDesc.Count=1;
      desc.BindFlags=D3D11_BIND_DECODER;
      if((request->Type&MFX_MEMTYPE_VIDEO_MEMORY_ENCODER_TARGET)&&(request->Type&MFX_MEMTYPE_INTERNAL_FRAME))
        desc.BindFlags|=D3D11_BIND_VIDEO_ENCODER;
      if(FAILED(s.device->CreateTexture2D(&desc,nullptr,&memory->texture))) {
        for(unsigned j=0;j<i;++j)delete static_cast<Memory*>(ids[j]);
        return MFX_ERR_MEMORY_ALLOC;
      }
      ids[i]=memory.release();
    }
    response->mids=ids.release();response->NumFrameActual=request->NumFrameSuggested;
    return MFX_ERR_NONE;
  }
  static mfxStatus MFX_CDECL Free(mfxHDL,mfxFrameAllocResponse* response) {
    for(unsigned i=0;i<response->NumFrameActual;++i)delete static_cast<Memory*>(response->mids[i]);
    delete[] response->mids;response->mids=nullptr;response->NumFrameActual=0;return MFX_ERR_NONE;
  }
  static mfxStatus MFX_CDECL Lock(mfxHDL,mfxMemId,mfxFrameData*) {return MFX_ERR_LOCK_MEMORY;}
  static mfxStatus MFX_CDECL Unlock(mfxHDL,mfxMemId,mfxFrameData*) {return MFX_ERR_NONE;}
  static mfxStatus MFX_CDECL Handle(mfxHDL,mfxMemId id,mfxHDL* output) {
    if(!id||!output)return MFX_ERR_NULL_PTR;
    auto* pair=reinterpret_cast<mfxHDLPair*>(output);
    pair->first=static_cast<Memory*>(id)->texture.Get();pair->second=nullptr;return MFX_ERR_NONE;
  }
  void Open(Json& result) {
    ComPtr<IDXGIFactory> factory;Hr(CreateDXGIFactory(IID_PPV_ARGS(&factory)),"DXGI factory");
    ComPtr<IDXGIAdapter> adapter;DXGI_ADAPTER_DESC description{};
    for(UINT index=0;;++index) {
      adapter.Reset();
      const auto status=factory->EnumAdapters(index,&adapter);
      if(status==DXGI_ERROR_NOT_FOUND)throw std::runtime_error("No Intel hardware adapter");
      Hr(status,"enumerate adapter");
      Hr(adapter->GetDesc(&description),"adapter description");
      if(description.VendorId==0x8086)break;
    }
    result["adapter"]={{"vendor",description.VendorId},{"device",description.DeviceId},
      {"luidHigh",description.AdapterLuid.HighPart},{"luidLow",description.AdapterLuid.LowPart}};
    Hr(D3D11CreateDevice(adapter.Get(),D3D_DRIVER_TYPE_UNKNOWN,nullptr,
      D3D11_CREATE_DEVICE_BGRA_SUPPORT|D3D11_CREATE_DEVICE_VIDEO_SUPPORT,nullptr,0,D3D11_SDK_VERSION,&device,nullptr,nullptr),"D3D11 device");
    ComPtr<ID3D10Multithread> multithread;Hr(device.As(&multithread),"multithread protection");
    multithread->SetMultithreadProtected(TRUE);
    loader=MFXLoad();if(!loader)throw std::runtime_error("MFXLoad");
    for(const auto& [name,value]:std::array<std::pair<const char*,mfxU32>,2>{{
      {"mfxImplDescription.Impl",MFX_IMPL_TYPE_HARDWARE},
      {"mfxImplDescription.AccelerationMode",MFX_ACCEL_MODE_VIA_D3D11}}}) {
      auto config=MFXCreateConfig(loader);mfxVariant property{};property.Type=MFX_VARIANT_TYPE_U32;property.Data.U32=value;
      Check(MFXSetConfigFilterProperty(config,reinterpret_cast<const mfxU8*>(name),property),"filter");
    }
    auto config=MFXCreateConfig(loader);mfxVariant identity{};identity.Type=MFX_VARIANT_TYPE_PTR;identity.Data.Ptr=&description.AdapterLuid;
    Check(MFXSetConfigFilterProperty(config,reinterpret_cast<const mfxU8*>("mfxExtendedDeviceId.DeviceLUID"),identity),"LUID filter");
    Check(MFXCreateSession(loader,0,&session),"create session");
    mfxVersion version{};mfxIMPL implementation{};
    Check(MFXQueryVersion(session,&version),"version");Check(MFXQueryIMPL(session,&implementation),"implementation");
    if(MFX_IMPL_BASETYPE(implementation)==MFX_IMPL_SOFTWARE)throw std::runtime_error("Software implementation");
    result["runtime"]={{"major",version.Major},{"minor",version.Minor},{"implementation",implementation}};
    Check(MFXVideoCORE_SetHandle(session,MFX_HANDLE_D3D11_DEVICE,device.Get()),"device handle");
    allocator.pthis=this;allocator.Alloc=Alloc;allocator.Free=Free;allocator.Lock=Lock;allocator.Unlock=Unlock;allocator.GetHDL=Handle;
    Check(MFXVideoCORE_SetFrameAllocator(session,&allocator),"allocator");
  }
};
static Json Probe(unsigned fps,bool limits,bool low_delay) {
  Json result={{"fps",fps},{"limits",limits},{"lowDelay",low_delay},{"scope","Query/Init/GetVideoParam only; no encoded AU or latency claim"}};
  Session session;
  try {
    session.Open(result);
    mfxVideoParam param{};param.AsyncDepth=1;param.IOPattern=MFX_IOPATTERN_IN_VIDEO_MEMORY;
    auto& info=param.mfx;info.CodecId=MFX_CODEC_AVC;info.CodecProfile=MFX_PROFILE_AVC_CONSTRAINED_BASELINE;
    info.CodecLevel=52;info.TargetUsage=4;info.RateControlMethod=MFX_RATECONTROL_VBR;
    info.TargetKbps=18000;info.MaxKbps=48000;info.BufferSizeInKB=6000;
    info.GopPicSize=120;info.GopRefDist=1;info.NumRefFrame=1;
    auto& frame=info.FrameInfo;frame.FourCC=MFX_FOURCC_NV12;frame.ChromaFormat=MFX_CHROMAFORMAT_YUV420;
    frame.Width=frame.CropW=1936;frame.Height=frame.CropH=816;frame.PicStruct=MFX_PICSTRUCT_PROGRESSIVE;
    frame.FrameRateExtN=fps;frame.FrameRateExtD=1;
    mfxExtCodingOption2 option2{};option2.Header={MFX_EXTBUFF_CODING_OPTION2,sizeof(option2)};
    option2.ExtBRC=option2.MBBRC=MFX_CODINGOPTION_OFF;option2.RepeatPPS=MFX_CODINGOPTION_ON;
    mfxExtCodingOption3 option3{};option3.Header={MFX_EXTBUFF_CODING_OPTION3,sizeof(option3)};
    option3.LowDelayBRC=static_cast<mfxU16>(low_delay?MFX_CODINGOPTION_ON:MFX_CODINGOPTION_OFF);
    option3.MaxFrameSizeI=limits?150000:0;option3.MaxFrameSizeP=limits?100000:0;
    mfxExtCodingOption hrd{};hrd.Header={MFX_EXTBUFF_CODING_OPTION,sizeof(hrd)};
    hrd.NalHrdConformance=hrd.VuiNalHrdParameters=hrd.VuiVclHrdParameters=MFX_CODINGOPTION_OFF;
    mfxExtVideoSignalInfo signal{};signal.Header={MFX_EXTBUFF_VIDEO_SIGNAL_INFO,sizeof(signal)};
    signal.VideoFormat=5;signal.ColourDescriptionPresent=1;signal.ColourPrimaries=signal.TransferCharacteristics=signal.MatrixCoefficients=1;
    mfxExtBuffer* extensions[]={reinterpret_cast<mfxExtBuffer*>(&option2),reinterpret_cast<mfxExtBuffer*>(&option3),
      reinterpret_cast<mfxExtBuffer*>(&hrd),reinterpret_cast<mfxExtBuffer*>(&signal)};
    param.ExtParam=extensions;param.NumExtParam=4;
    auto state=[&] {return Json{{"lowDelayBRC",option3.LowDelayBRC},{"maxFrameSizeI",option3.MaxFrameSizeI},
      {"maxFrameSizeP",option3.MaxFrameSizeP},{"fpsN",info.FrameInfo.FrameRateExtN},{"fpsD",info.FrameInfo.FrameRateExtD},
      {"targetKbps",info.TargetKbps},{"maxKbps",info.MaxKbps},{"lowPower",info.LowPower},{"level",info.CodecLevel}};};
    const auto requested=state();result["requested"]=requested;
    auto status=MFXVideoENCODE_Query(session.session,&param,&param);result["queryStatus"]=status;result["queried"]=state();Check(status,"Query");
    status=MFXVideoENCODE_Init(session.session,&param);result["initStatus"]=status;
    if(status>=0)session.initialized=true;Check(status,"Init");
    status=MFXVideoENCODE_GetVideoParam(session.session,&param);result["readbackStatus"]=status;Check(status,"GetVideoParam");
    result["actual"]=state();result["requestedLimitsRetained"]=
      requested["lowDelayBRC"]==option3.LowDelayBRC && requested["maxFrameSizeI"]==option3.MaxFrameSizeI &&
      requested["maxFrameSizeP"]==option3.MaxFrameSizeP;
  } catch(const std::exception& error) {result["error"]=error.what();}
  return result;
}
int main() {
  Json results=Json::array();
  results.push_back(Probe(60,false,false));
  results.push_back(Probe(60,true,false));
  results.push_back(Probe(60,true,true));
  results.push_back(Probe(2,true,false));
  results.push_back(Probe(2,false,true));
  results.push_back(Probe(2,true,true));
  std::cout<<results.dump(2)<<'\n';
  return results[0].contains("error")?1:0;
}
