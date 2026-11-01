#include "hardware_encoder.hpp"
#include "server_trace.hpp"
#include "remotekit/sampling.hpp"
#include <vpl/mfxdispatcher.h>
#include <vpl/mfxvideo.h>
#include <wrl/client.h>
#include <d3d10.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <deque>
#include <map>
#include <thread>
namespace remotekit::media {
namespace {
using Microsoft::WRL::ComPtr;
struct Memory { ComPtr<ID3D11Texture2D> texture; UINT index=0; };
class Qsv final : public HardwareEncoder {
  struct VppOutput { Memory memory; mfxFrameSurface1 surface{}; bool used=false; };
  enum class Stage { vpp_delayed, encode_pending, encode_held };
  struct Packet {
    uint64_t submit_cookie=0;
    mfxBitstream bitstream{};
    std::vector<mfxU8> storage;
    mfxSyncPoint sync=nullptr;
  };
  struct Task {
    uint64_t cookie=0;
    Memory memory;
    mfxFrameSurface1 surface{};
    mfxEncodeCtrl control{};
    VppOutput* converted=nullptr;
    mfxSyncPoint vpp_sync=nullptr;
    Stage stage=Stage::encode_pending;
    std::chrono::steady_clock::time_point accepted=std::chrono::steady_clock::now();
    std::unique_ptr<Packet> pending_packet;
    mfxFrameSurface1* EncodeSurface() { return converted?&converted->surface:&surface; }
  };
  ComPtr<ID3D11Device> device_;
  mfxLoader loader_=nullptr;
  mfxSession session_=nullptr;
  mfxVideoParam params_{};
  mfxExtCodingOption2 options_{};
  mfxExtVideoSignalInfo signal_{};
  mfxExtCodingOption hrd_options_{};
  std::array<mfxExtBuffer*,3> extensions_{};
  mfxFrameAllocator allocator_{};
  std::map<mfxMemId,std::unique_ptr<Memory>> allocations_;
  std::map<uint64_t,std::unique_ptr<Task>> jobs_;
  std::deque<std::unique_ptr<Packet>> packets_;
  std::vector<std::unique_ptr<Packet>> failed_packets_;
  std::unique_ptr<Packet> flush_packet_;
  std::vector<std::unique_ptr<VppOutput>> vpp_outputs_;
  mfxVideoParam vpp_params_{};
  mfxExtVPPVideoSignalInfo vpp_color_{};
  mfxExtVPPComposite vpp_composite_{};
  mfxVPPCompInputStream vpp_stream_{};
  std::array<mfxExtBuffer*,2> vpp_extensions_{};
  bool vpp_initialized_=false;
  std::string deferred_error_;
  EncoderSettings settings_;
  QsvLowPowerInfo low_power_;
  bool initialized_=false;
  mfxU16 allocated_buffer_kb_=0;
  static bool Status(mfxStatus status,const char* operation,std::string& error) {
    if (status>=0) return true;
    error=std::string(operation)+" (MFX "+std::to_string(status)+")"; return false;
  }
  bool CheckSignal(std::string& error) const {
    if(signal_.VideoFullRange || !signal_.ColourDescriptionPresent || signal_.ColourPrimaries!=1 ||
       signal_.TransferCharacteristics!=1 || signal_.MatrixCoefficients!=1) {
      error="QSV did not accept BT.709 limited-range color metadata";return false;
    }
    return true;
  }
  static mfxStatus MFX_CDECL Allocate(mfxHDL context,mfxFrameAllocRequest* request,
                                     mfxFrameAllocResponse* response) {
    auto* self=static_cast<Qsv*>(context);
    const auto format=request->Info.FourCC==MFX_FOURCC_NV12?DXGI_FORMAT_NV12:
      request->Info.FourCC==MFX_FOURCC_RGB4?DXGI_FORMAT_B8G8R8A8_UNORM:DXGI_FORMAT_UNKNOWN;
    if(format==DXGI_FORMAT_UNKNOWN) return MFX_ERR_UNSUPPORTED;
    const UINT count=request->NumFrameSuggested;
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width=request->Info.Width;desc.Height=request->Info.Height;
    desc.MipLevels=1;desc.ArraySize=self->settings_.qsv_async_vpp?1:count;desc.Format=format;
    desc.SampleDesc.Count=1;desc.Usage=D3D11_USAGE_DEFAULT;
    desc.BindFlags=(format==DXGI_FORMAT_B8G8R8A8_UNORM || (request->Type&MFX_MEMTYPE_FROM_VPPOUT) ||
      (request->Type&MFX_MEMTYPE_VIDEO_MEMORY_PROCESSOR_TARGET))?D3D11_BIND_RENDER_TARGET:D3D11_BIND_DECODER;
    if(!self->settings_.qsv_async_vpp)desc.BindFlags=D3D11_BIND_DECODER;
    if(self->settings_.qsv_async_vpp && (request->Type&MFX_MEMTYPE_VIDEO_MEMORY_ENCODER_TARGET) && (request->Type&MFX_MEMTYPE_INTERNAL_FRAME))
      desc.BindFlags|=D3D11_BIND_VIDEO_ENCODER;
    ComPtr<ID3D11Texture2D> array;
    if(!self->settings_.qsv_async_vpp && FAILED(self->device_->CreateTexture2D(&desc,nullptr,&array)))return MFX_ERR_MEMORY_ALLOC;
    auto* ids=new mfxMemId[count];
    for(UINT i=0;i<count;++i) {
      auto memory=std::make_unique<Memory>();
      if(array) {memory->texture=array;memory->index=i;}
      else if(FAILED(self->device_->CreateTexture2D(&desc,nullptr,&memory->texture))) {
        for(UINT j=0;j<i;++j)self->allocations_.erase(ids[j]);delete[] ids;return MFX_ERR_MEMORY_ALLOC;
      }
      ids[i]=memory.get(); self->allocations_.emplace(ids[i],std::move(memory));
    }
    response->mids=ids;response->NumFrameActual=static_cast<mfxU16>(count);
    return MFX_ERR_NONE;
  }
  static mfxStatus MFX_CDECL Free(mfxHDL context,mfxFrameAllocResponse* response) {
    auto* self=static_cast<Qsv*>(context);
    for(UINT i=0;i<response->NumFrameActual;++i) self->allocations_.erase(response->mids[i]);
    delete[] response->mids;response->mids=nullptr;response->NumFrameActual=0;
    return MFX_ERR_NONE;
  }
  static mfxStatus MFX_CDECL Lock(mfxHDL,mfxMemId,mfxFrameData*) {return MFX_ERR_LOCK_MEMORY;}
  static mfxStatus MFX_CDECL Unlock(mfxHDL,mfxMemId,mfxFrameData*) {return MFX_ERR_NONE;}
  static mfxStatus MFX_CDECL Handle(mfxHDL,mfxMemId id,mfxHDL* output) {
    if(!id || !output) return MFX_ERR_NULL_PTR;
    auto* memory=static_cast<Memory*>(id);
    auto* pair=reinterpret_cast<mfxHDLPair*>(output);
    pair->first=memory->texture.Get();
    pair->second=reinterpret_cast<mfxHDL>(static_cast<uintptr_t>(memory->index));
    // D3D11 allocator ABI returns a borrowed texture/index pair. The session and
    // task each retain the owning COM reference through hardware completion.
    return MFX_ERR_NONE;
  }
  static bool Exact(mfxStatus status,const char* operation,std::string& error) {
    if(status==MFX_ERR_NONE)return true;
    error=std::string(operation)+" (MFX "+std::to_string(status)+")";return false;
  }
  static bool SameGeometry(const mfxFrameInfo& a,const mfxFrameInfo& b) {
    return a.FourCC==b.FourCC && a.Width==b.Width && a.Height==b.Height &&
      a.CropX==b.CropX && a.CropY==b.CropY && a.CropW==b.CropW && a.CropH==b.CropH &&
      a.ChromaFormat==b.ChromaFormat && a.PicStruct==b.PicStruct;
  }
  bool VppEmpty(std::string& error) {
    if(!vpp_initialized_ || vpp_outputs_.empty())return true;
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(5);
    mfxStatus status;mfxSyncPoint sync=nullptr;
    do {
      status=MFXVideoVPP_RunFrameVPPAsync(session_,nullptr,&vpp_outputs_.front()->surface,nullptr,&sync);
      if(status!=MFX_WRN_DEVICE_BUSY)break;
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    } while(std::chrono::steady_clock::now()<deadline);
    if(status==MFX_ERR_MORE_DATA && !sync)return true;
    error="QSV VPP drain returned an unexpected buffered output/status (MFX "+std::to_string(status)+")";
    return false; // Output surfaces remain alive until component/session Close.
  }
  bool OpenVpp(const D3D11_TEXTURE2D_DESC& source,std::string& error) {
    if(source.Format!=DXGI_FORMAT_B8G8R8A8_UNORM || source.ArraySize!=1 || source.MipLevels!=1 ||
       source.SampleDesc.Count!=1 || !source.Width || !source.Height || source.Width%16 || source.Height%16 ||
       source.Width>65535 || source.Height>65535) {
      error="QSV async VPP requires a real 16-aligned single BGRA texture";return false;
    }
    if(vpp_initialized_) {
      if(!VppEmpty(error))return false;
      if(!Exact(MFXVideoVPP_Close(session_),"MFX VPP Close for source resize",error))return false;
      vpp_initialized_=false;vpp_outputs_.clear();
    }
    vpp_params_={};vpp_params_.AsyncDepth=static_cast<mfxU16>(settings_.async_depth);
    vpp_params_.IOPattern=MFX_IOPATTERN_IN_VIDEO_MEMORY|MFX_IOPATTERN_OUT_VIDEO_MEMORY;
    auto& input=vpp_params_.vpp.In;input=params_.mfx.FrameInfo;
    input.FourCC=MFX_FOURCC_RGB4;input.ChromaFormat=MFX_CHROMAFORMAT_YUV444;
    input.Width=input.CropW=static_cast<mfxU16>(source.Width);
    input.Height=input.CropH=static_cast<mfxU16>(source.Height);input.CropX=input.CropY=0;
    vpp_params_.vpp.Out=params_.mfx.FrameInfo;
    const double scale=std::min(double(settings_.width)/source.Width,double(settings_.height)/source.Height);
    const auto fit_w=std::min(settings_.width,static_cast<uint32_t>(std::lround(source.Width*scale/2))*2);
    const auto fit_h=std::min(settings_.height,static_cast<uint32_t>(std::lround(source.Height*scale/2))*2);
    const bool letterbox=fit_w!=settings_.width || fit_h!=settings_.height;
    vpp_color_={};vpp_color_.Header={MFX_EXTBUFF_VPP_VIDEO_SIGNAL_INFO,sizeof(vpp_color_)};
    vpp_color_.In.NominalRange=MFX_NOMINALRANGE_0_255;vpp_color_.In.TransferMatrix=MFX_TRANSFERMATRIX_BT709;
    vpp_color_.Out.NominalRange=MFX_NOMINALRANGE_16_235;vpp_color_.Out.TransferMatrix=MFX_TRANSFERMATRIX_BT709;
    vpp_extensions_[0]=reinterpret_cast<mfxExtBuffer*>(&vpp_color_);
    vpp_composite_={};vpp_stream_={};
    if(letterbox) {
      vpp_composite_.Header={MFX_EXTBUFF_VPP_COMPOSITE,sizeof(vpp_composite_)};
      vpp_composite_.Y=16;vpp_composite_.U=vpp_composite_.V=128;
      vpp_stream_.DstW=fit_w;vpp_stream_.DstH=fit_h;
      vpp_composite_.NumInputStream=1;vpp_composite_.InputStream=&vpp_stream_;
    }
    vpp_extensions_[1]=reinterpret_cast<mfxExtBuffer*>(&vpp_composite_);
    vpp_params_.ExtParam=vpp_extensions_.data();vpp_params_.NumExtParam=letterbox?2:1;
    auto queried=vpp_params_;
    if(!Exact(MFXVideoVPP_Query(session_,&vpp_params_,&queried),"MFX VPP Query",error))return false;
    if(!SameGeometry(queried.vpp.In,vpp_params_.vpp.In)||!SameGeometry(queried.vpp.Out,vpp_params_.vpp.Out)) {
      error="QSV VPP Query changed required geometry";return false;
    }
    mfxFrameAllocRequest vpp_request[2]{},encode_request{};
    if(!Exact(MFXVideoVPP_QueryIOSurf(session_,&vpp_params_,vpp_request),"MFX VPP QueryIOSurf",error) ||
       !Status(MFXVideoENCODE_QueryIOSurf(session_,&params_,&encode_request),"MFX Encode QueryIOSurf",error))return false;
    const auto status=MFXVideoVPP_Init(session_,&vpp_params_);
    if(status>=0)vpp_initialized_=true;
    if(!Exact(status,"MFX VPP Init",error))return false;
    auto actual=vpp_params_;
    if(!Exact(MFXVideoVPP_GetVideoParam(session_,&actual),"MFX VPP GetVideoParam",error))return false;
    if(!SameGeometry(actual.vpp.In,vpp_params_.vpp.In)||!SameGeometry(actual.vpp.Out,vpp_params_.vpp.Out)||
       vpp_color_.In.NominalRange!=MFX_NOMINALRANGE_0_255 || vpp_color_.In.TransferMatrix!=MFX_TRANSFERMATRIX_BT709 ||
       vpp_color_.Out.NominalRange!=MFX_NOMINALRANGE_16_235 || vpp_color_.Out.TransferMatrix!=MFX_TRANSFERMATRIX_BT709) {
      error="QSV VPP changed required geometry or BT.709 full-to-limited conversion";return false;
    }
    if(letterbox && (vpp_composite_.NumInputStream!=1 || vpp_composite_.InputStream!=&vpp_stream_ ||
       vpp_composite_.Y!=16 || vpp_composite_.U!=128 || vpp_composite_.V!=128 ||
       vpp_stream_.DstX || vpp_stream_.DstY || vpp_stream_.DstW!=fit_w || vpp_stream_.DstH!=fit_h ||
       vpp_stream_.GlobalAlphaEnable || vpp_stream_.PixelAlphaEnable || vpp_stream_.LumaKeyEnable)) {
      error="QSV VPP changed required letterbox composition";return false;
    }
    const auto suggested=unsigned(vpp_request[1].NumFrameSuggested)+encode_request.NumFrameSuggested;
    const auto count=std::max({unsigned(settings_.async_depth),unsigned(vpp_request[1].NumFrameMin),
      unsigned(encode_request.NumFrameMin),suggested>settings_.async_depth?suggested-settings_.async_depth:1u});
    for(unsigned i=0;i<count;++i) {
      auto output=std::make_unique<VppOutput>();D3D11_TEXTURE2D_DESC desc{};
      desc.Width=actual.vpp.Out.Width;desc.Height=actual.vpp.Out.Height;desc.ArraySize=desc.MipLevels=1;
      desc.Format=DXGI_FORMAT_NV12;desc.SampleDesc.Count=1;
      desc.BindFlags=D3D11_BIND_RENDER_TARGET|D3D11_BIND_VIDEO_ENCODER;
      if(FAILED(device_->CreateTexture2D(&desc,nullptr,&output->memory.texture))) {
        error="QSV VPP NV12 pool allocation failed";return false;
      }
      output->surface.Info=actual.vpp.Out;output->surface.Data.MemId=&output->memory;
      vpp_outputs_.push_back(std::move(output));
    }
    fprintf(stderr,"QSV async VPP: BGRA %ux%u -> NV12 %ux%u fit=%ux%u composite=%u pool=%u depth=%u\n",
      source.Width,source.Height,settings_.width,settings_.height,fit_w,fit_h,letterbox,count,settings_.async_depth);
    return true;
  }
  std::unique_ptr<Packet> NewPacket() const {
    auto packet=std::make_unique<Packet>();packet->storage.resize(std::max({size_t(4*1024*1024),
      size_t(settings_.width)*settings_.height*2,size_t(params_.mfx.BufferSizeInKB)*1000+65536}));
    packet->bitstream.Data=packet->storage.data();packet->bitstream.MaxLength=static_cast<mfxU32>(packet->storage.size());
    return packet;
  }
  mfxStatus Encode(Task* task,Packet& packet) {
    mfxStatus status;
    do {
      status=MFXVideoENCODE_EncodeFrameAsync(session_,task?&task->control:nullptr,
        task?task->EncodeSurface():nullptr,&packet.bitstream,&packet.sync);
      if(status!=MFX_ERR_NOT_ENOUGH_BUFFER || packet.storage.size()>=64*1024*1024)break;
      packet.storage.resize(std::min<size_t>(64*1024*1024,packet.storage.size()*2));
      packet.bitstream.Data=packet.storage.data();packet.bitstream.MaxLength=static_cast<mfxU32>(packet.storage.size());
    } while(true);
    return status;
  }
  bool SubmitEncode(Task& task,std::string& error) {
    if(!task.pending_packet)task.pending_packet=NewPacket();
    auto& packet=task.pending_packet;
    packet->submit_cookie=task.cookie;
    RK_SERVER_TRACE(trace_,"mfx_submit_begin",TraceIds{},rk_record.cookie=task.cookie;rk_record.encoder=trace_encoder_;);
    const auto status=Encode(&task,*packet);
    RK_SERVER_TRACE(trace_,"mfx_submit_return",TraceIds{},rk_record.cookie=task.cookie;rk_record.encoder=trace_encoder_;rk_record.status=status;);
    if(status==MFX_WRN_DEVICE_BUSY)return true; // task remains encode_pending
    if(status==MFX_ERR_MORE_DATA) {task.stage=Stage::encode_held;packet.reset();return true;}
    if(status<0 || !packet->sync) {
      Status(status,"MFX EncodeFrameAsync",error);
      if(error.empty())error="QSV accepted encoding without a synchronization point";
      failed_packets_.push_back(std::move(packet));
      return false;
    }
    // Input ownership and output packets are independent: a returned packet
    // may encode an older cookie. Every accepted input remains held until its
    // own timestamp completes, including inputs whose call returned a sync.
    task.stage=Stage::encode_held;packets_.push_back(std::move(packet));return true;
  }
 public:
  std::optional<QsvLowPowerInfo> LowPowerInfo() const override {return low_power_;}
  ~Qsv() override {
    if(session_) {
      // Close is the hardware cancellation/drain boundary even on device error.
      if(initialized_) MFXVideoENCODE_Close(session_);
      if(vpp_initialized_) MFXVideoVPP_Close(session_);
      MFXClose(session_);
    }
    packets_.clear();failed_packets_.clear();flush_packet_.reset();jobs_.clear();vpp_outputs_.clear();allocations_.clear();
    if(loader_) MFXUnload(loader_);
  }
  const char* Name() const override {return "qsv";}
  EncoderInput InputFormat() const override {return settings_.qsv_async_vpp?EncoderInput::bgra:EncoderInput::nv12;}
  EncoderSettings ActualSettings() const override {
    auto value=settings_;value.width=params_.mfx.FrameInfo.CropW;value.height=params_.mfx.FrameInfo.CropH;
    value.fps=params_.mfx.FrameInfo.FrameRateExtD ? params_.mfx.FrameInfo.FrameRateExtN/params_.mfx.FrameInfo.FrameRateExtD : 0;
    value.bitrate=params_.mfx.TargetKbps*1000u;value.max_bitrate=params_.mfx.MaxKbps*1000u;
    value.async_depth=params_.AsyncDepth;value.gop=params_.mfx.GopPicSize;value.target_usage=params_.mfx.TargetUsage;
    value.level_idc=params_.mfx.CodecLevel;
    value.qsv_low_power=static_cast<uint32_t>(low_power_.initialized.value_or(0));return value;
  }
  bool Configure(ID3D11Device* device,const EncoderSettings& requested,std::string& error) override {
    EncoderSettings settings=requested;
    if(!device || !settings.width || !settings.height || !settings.fps || !settings.async_depth) {
      error="QSV requires a device, nonzero dimensions, fps and async depth";return false;
    }
    const auto level_budget=remotekit::H264RateLimits(settings.level_idc);
    if(level_budget.bitrate_bps) {
      settings.max_bitrate=std::min(settings.max_bitrate,level_budget.bitrate_bps);
      settings.bitrate=std::min(settings.bitrate,settings.max_bitrate);
    }
    if(session_) {error="QSV already configured";return false;}
    device_=device;settings_=settings;low_power_.requested=static_cast<int>(settings.qsv_low_power);
    ComPtr<ID3D10Multithread> multithread;
    if(SUCCEEDED(device_.As(&multithread))) multithread->SetMultithreadProtected(TRUE);
    loader_=MFXLoad();
    if(!loader_) {error="oneVPL dispatcher unavailable";return false;}
    auto filter=[&](const char* name,mfxU32 value) {
      auto config=MFXCreateConfig(loader_);mfxVariant property{};
      property.Type=MFX_VARIANT_TYPE_U32;property.Data.U32=value;
      return MFXSetConfigFilterProperty(config,reinterpret_cast<const mfxU8*>(name),property);
    };
    if(!Status(filter("mfxImplDescription.Impl",MFX_IMPL_TYPE_HARDWARE),"oneVPL hardware filter",error) ||
       !Status(filter("mfxImplDescription.AccelerationMode",MFX_ACCEL_MODE_VIA_D3D11),"oneVPL D3D11 filter",error))return false;
    if(!Status(MFXCreateSession(loader_,0,&session_),"MFXCreateSession hardware D3D11",error)) return false;
    mfxVersion version{};mfxIMPL implementation{};
    if(!Status(MFXQueryVersion(session_,&version),"MFX version",error) ||
       !Status(MFXQueryIMPL(session_,&implementation),"MFX implementation",error))return false;
    if(MFX_IMPL_BASETYPE(implementation)==MFX_IMPL_SOFTWARE){error="software MFX implementation rejected";return false;}
    fprintf(stderr,"QSV runtime API %u.%u implementation=0x%x\n",version.Major,version.Minor,implementation);
    if(!Status(MFXVideoCORE_SetHandle(session_,MFX_HANDLE_D3D11_DEVICE,device_.Get()),"MFX SetHandle",error)) return false;
    allocator_.pthis=this;allocator_.Alloc=Allocate;allocator_.Free=Free;
    allocator_.Lock=Lock;allocator_.Unlock=Unlock;allocator_.GetHDL=Handle;
    if(!Status(MFXVideoCORE_SetFrameAllocator(session_,&allocator_),"MFX allocator",error)) return false;
    params_.AsyncDepth=static_cast<mfxU16>(settings.async_depth);
    params_.IOPattern=MFX_IOPATTERN_IN_VIDEO_MEMORY;
    auto& info=params_.mfx;
    info.LowPower=static_cast<mfxU16>(settings.qsv_low_power);
    info.CodecId=MFX_CODEC_AVC;info.CodecProfile=MFX_PROFILE_AVC_CONSTRAINED_BASELINE;
    info.CodecLevel=static_cast<mfxU16>(settings.level_idc);
    info.TargetUsage=static_cast<mfxU16>(settings.target_usage);
    info.RateControlMethod=settings.vbr?MFX_RATECONTROL_VBR:MFX_RATECONTROL_CBR;
    info.TargetKbps=static_cast<mfxU16>(std::max(1u,settings.bitrate/1000));
    info.MaxKbps=static_cast<mfxU16>(std::max(1u,(settings.vbr?settings.max_bitrate:settings.bitrate)/1000));
    info.BufferSizeInKB=static_cast<mfxU16>(std::min<uint64_t>(level_budget.cpb_kb?level_budget.cpb_kb:65535,
        uint64_t(std::max(settings.bitrate,settings.max_bitrate))*settings.buffer_ms/8000000));
    info.GopPicSize=static_cast<mfxU16>(settings.gop);info.GopRefDist=1;
    info.IdrInterval=0;info.NumRefFrame=1;info.EncodedOrder=0;
    auto& frame=info.FrameInfo;
    frame.FourCC=MFX_FOURCC_NV12;frame.ChromaFormat=MFX_CHROMAFORMAT_YUV420;
    frame.Width=static_cast<mfxU16>((settings.width+15)&~15u);
    frame.Height=static_cast<mfxU16>((settings.height+15)&~15u);
    frame.CropW=static_cast<mfxU16>(settings.width);frame.CropH=static_cast<mfxU16>(settings.height);
    frame.FrameRateExtN=settings.fps;frame.FrameRateExtD=1;frame.PicStruct=MFX_PICSTRUCT_PROGRESSIVE;
    options_.Header.BufferId=MFX_EXTBUFF_CODING_OPTION2;options_.Header.BufferSz=sizeof(options_);
    options_.LookAheadDepth=0;options_.ExtBRC=MFX_CODINGOPTION_OFF;options_.MBBRC=MFX_CODINGOPTION_OFF;
    options_.RepeatPPS=MFX_CODINGOPTION_ON;
    signal_.Header.BufferId=MFX_EXTBUFF_VIDEO_SIGNAL_INFO;signal_.Header.BufferSz=sizeof(signal_);
    signal_.VideoFormat=5;signal_.VideoFullRange=0;signal_.ColourDescriptionPresent=1;
    signal_.ColourPrimaries=1;signal_.TransferCharacteristics=1;signal_.MatrixCoefficients=1;
    extensions_[0]=reinterpret_cast<mfxExtBuffer*>(&options_);
    extensions_[1]=reinterpret_cast<mfxExtBuffer*>(&signal_);
    hrd_options_.Header.BufferId=MFX_EXTBUFF_CODING_OPTION;hrd_options_.Header.BufferSz=sizeof(hrd_options_);
    hrd_options_.NalHrdConformance=MFX_CODINGOPTION_OFF;
    hrd_options_.VuiNalHrdParameters=MFX_CODINGOPTION_OFF;
    hrd_options_.VuiVclHrdParameters=MFX_CODINGOPTION_OFF;
    extensions_[2]=reinterpret_cast<mfxExtBuffer*>(&hrd_options_);
    params_.ExtParam=extensions_.data();params_.NumExtParam=static_cast<mfxU16>(extensions_.size());
    const auto query_status=MFXVideoENCODE_Query(session_,&params_,&params_);
    low_power_.query_status=query_status;
    if(query_status>=0)low_power_.queried=params_.mfx.LowPower;
    fprintf(stderr,"QSV LowPower: requested=%u queried=%d queryStatus=%d\n",
      settings.qsv_low_power,low_power_.queried.value_or(-1),query_status);
    if(!Status(query_status,"MFX H264 Query",error)) return false;
    if(settings.qsv_low_power&&params_.mfx.LowPower!=settings.qsv_low_power) {
      error="QSV Query changed explicit LowPower request to "+std::to_string(params_.mfx.LowPower);return false;
    }
    if(params_.mfx.GopRefDist!=1) {error="QSV unexpectedly enabled B frames";return false;}
    const auto init_status=MFXVideoENCODE_Init(session_,&params_);
    low_power_.init_status=init_status;
    fprintf(stderr,"QSV LowPower: initStatus=%d\n",init_status);
    if(!Status(init_status,"MFX H264 Init",error)) return false;
    initialized_=true;
    const auto get_status=MFXVideoENCODE_GetVideoParam(session_,&params_);
    low_power_.get_video_param_status=get_status;
    if(get_status>=0)low_power_.initialized=params_.mfx.LowPower;
    fprintf(stderr,"QSV LowPower: initialized=%d getVideoParamStatus=%d\n",
      low_power_.initialized.value_or(-1),get_status);
    if(!Status(get_status,"MFX GetVideoParam",error))return false;
    if(settings.qsv_low_power&&params_.mfx.LowPower!=settings.qsv_low_power) {
      error="QSV initialized with a different LowPower value: "+std::to_string(params_.mfx.LowPower);return false;
    }
    if(!CheckSignal(error))return false;
    fprintf(stderr,"QSV actual VUI: fullRange=%u description=%u primaries=%u transfer=%u matrix=%u\n",
      signal_.VideoFullRange,signal_.ColourDescriptionPresent,signal_.ColourPrimaries,
      signal_.TransferCharacteristics,signal_.MatrixCoefficients);
    fprintf(stderr,"QSV actual HRD: nalConformance=%u nalVui=%u vclVui=%u\n",
      hrd_options_.NalHrdConformance,hrd_options_.VuiNalHrdParameters,hrd_options_.VuiVclHrdParameters);
    allocated_buffer_kb_=params_.mfx.BufferSizeInKB;
    if(params_.mfx.CodecLevel>settings.level_idc) {
      error="QSV actual H264 level "+std::to_string(params_.mfx.CodecLevel)+
            " exceeds negotiated level "+std::to_string(settings.level_idc);return false;
    }
    fprintf(stderr,"QSV negotiated level=%u\n",settings.level_idc);
    fprintf(stderr,"QSV actual: %ux%u %u/%u fps TU=%u RC=%u TargetKbps=%u MaxKbps=%u VBV_KB=%u AsyncDepth=%u Gop=%u RefDist=%u Profile=%u Level=%u\n",
      params_.mfx.FrameInfo.CropW,params_.mfx.FrameInfo.CropH,params_.mfx.FrameInfo.FrameRateExtN,
      params_.mfx.FrameInfo.FrameRateExtD,params_.mfx.TargetUsage,params_.mfx.RateControlMethod,
      params_.mfx.TargetKbps,params_.mfx.MaxKbps,params_.mfx.BufferSizeInKB,params_.AsyncDepth,
      params_.mfx.GopPicSize,params_.mfx.GopRefDist,params_.mfx.CodecProfile,params_.mfx.CodecLevel);
    return true;
  }
  CodecResult Submit(ID3D11Texture2D* texture,bool key,uint64_t cookie,std::string& error) override {
    if(!deferred_error_.empty()) {error=deferred_error_;return CodecResult::error;}
    if(jobs_.size()>=settings_.async_depth)return CodecResult::busy;
    for(auto& [id,earlier]:jobs_)if(earlier->stage==Stage::vpp_delayed)return CodecResult::busy;
    if(!texture || jobs_.contains(cookie)) {error="invalid QSV input/cookie";return CodecResult::error;}
    D3D11_TEXTURE2D_DESC desc{};texture->GetDesc(&desc);
    if(settings_.qsv_async_vpp && (desc.Format!=DXGI_FORMAT_B8G8R8A8_UNORM || desc.ArraySize!=1 ||
       desc.MipLevels!=1 || desc.SampleDesc.Count!=1 || desc.Width%16 || desc.Height%16)) {
      error="QSV async VPP input must be a real 16-aligned single BGRA texture";return CodecResult::error;
    }
    if(settings_.qsv_async_vpp && (!vpp_initialized_ || desc.Width!=vpp_params_.vpp.In.Width || desc.Height!=vpp_params_.vpp.In.Height)) {
      // Source geometry belongs to each immutable texture, not the latest atlas.
      // No component/surface may be reconfigured while any input is outstanding.
      if(!jobs_.empty())return CodecResult::busy;
      if(!OpenVpp(desc,error))return CodecResult::error;
    }
    auto task=std::make_unique<Task>();task->cookie=cookie;task->memory.texture=texture;
    task->surface.Info=settings_.qsv_async_vpp?vpp_params_.vpp.In:params_.mfx.FrameInfo;
    task->surface.Data.MemId=&task->memory;task->surface.Data.TimeStamp=cookie;
    if(key)task->control.FrameType=MFX_FRAMETYPE_I|MFX_FRAMETYPE_IDR|MFX_FRAMETYPE_REF;
    if(settings_.qsv_async_vpp) {
      for(auto& output:vpp_outputs_)if(!output->used && !output->surface.Data.Locked) {task->converted=output.get();break;}
      if(!task->converted)return CodecResult::busy;
      auto& converted=*task->converted;converted.used=true;converted.surface.Data.TimeStamp=cookie;
      RK_SERVER_TRACE(trace_,"mfx_vpp_submit_begin",TraceIds{},rk_record.cookie=cookie;rk_record.encoder=trace_encoder_;);
      const auto status=MFXVideoVPP_RunFrameVPPAsync(session_,&task->surface,&converted.surface,nullptr,&task->vpp_sync);
      RK_SERVER_TRACE(trace_,"mfx_vpp_submit_return",TraceIds{},rk_record.cookie=cookie;rk_record.encoder=trace_encoder_;rk_record.status=status;);
      if(status==MFX_WRN_DEVICE_BUSY) {converted.used=false;return CodecResult::busy;}
      if(status==MFX_ERR_MORE_DATA)task->stage=Stage::vpp_delayed;
      else if(status!=MFX_ERR_NONE || !task->vpp_sync) {
        // The runtime may have retained either surface even on an unexpected
        // status. Accept ownership and report from Poll; Close precedes release.
        deferred_error_="QSV VPP requires one output per input; MFX "+std::to_string(status);
      }
    }
    bool earlier_pending=false;
    for(auto& [id,earlier]:jobs_)earlier_pending|=earlier->stage==Stage::encode_pending || earlier->stage==Stage::vpp_delayed;
    auto* accepted=task.get();jobs_.emplace(cookie,std::move(task));
    if(!earlier_pending && deferred_error_.empty() && accepted->stage==Stage::encode_pending && !SubmitEncode(*accepted,error)) {
      deferred_error_=error;
    }
    if(!settings_.qsv_async_vpp && deferred_error_.empty() && accepted->stage==Stage::encode_pending) {
      // External NV12 was not accepted by MFX; preserve the worker's existing
      // busy/replacement behavior. Async VPP already owns a GPU dependency.
      jobs_.erase(cookie);return CodecResult::busy;
    }
    // Once VPP/Encode was called the job remains owned until final Sync/Close.
    // Even an encoder-busy stage is accepted and retried without repeating VPP.
    return CodecResult::accepted;
  }
  CodecResult Poll(uint32_t timeout,AccessUnit& output,std::string& error) override {
    if(!deferred_error_.empty()) {error=deferred_error_;return CodecResult::error;}
    for(auto& [cookie,task]:jobs_) {
      if(std::chrono::steady_clock::now()-task->accepted>std::chrono::seconds(5)) {
        error="QSV frame completion timed out";deferred_error_=error;return CodecResult::error;
      }
      if(task->stage==Stage::vpp_delayed) {
        const auto status=MFXVideoVPP_RunFrameVPPAsync(session_,nullptr,&task->converted->surface,nullptr,&task->vpp_sync);
        if(status==MFX_WRN_DEVICE_BUSY)break; // Still poll older encode work below.
        if(status!=MFX_ERR_NONE || !task->vpp_sync) {
          error="QSV VPP delayed input did not produce exactly one output during drain; MFX "+std::to_string(status);
          deferred_error_=error;return CodecResult::error;
        }
        task->stage=Stage::encode_pending;
      }
      if(task->stage==Stage::encode_pending && !SubmitEncode(*task,error)) {
        deferred_error_=error;return CodecResult::error;
      }
      if(task->stage==Stage::encode_pending)break; // Keep submission order on busy.
    }
    if(packets_.empty() && !jobs_.empty()) {
      // Pure held input preserves the existing low-delay MORE_DATA handling.
      // NULL means end-of-sequence: never flush past a newer input whose VPP
      // or Encode submission is still pending/busy. Retry that input first.
      bool held=false,pending=false;
      for(auto& [cookie,task]:jobs_) {
        held|=task->stage==Stage::encode_held;
        pending|=task->stage==Stage::encode_pending || task->stage==Stage::vpp_delayed;
      }
      if(held && !pending) {
        if(!flush_packet_)flush_packet_=NewPacket();
        for(auto& [cookie,task]:jobs_)if(task->stage==Stage::encode_held) {flush_packet_->submit_cookie=cookie;break;}
        const auto status=Encode(nullptr,*flush_packet_);
        if(status==MFX_WRN_DEVICE_BUSY) {
          if(timeout)std::this_thread::sleep_for(std::chrono::milliseconds(1));
          return CodecResult::pending;
        }
        if(status<0 || !flush_packet_->sync) {
          error="QSV flush has outstanding input without output; MFX "+std::to_string(status);
          deferred_error_=error;return CodecResult::error;
        }
        packets_.push_back(std::move(flush_packet_));
      }
    }
    if(packets_.empty()) {
      if(timeout)std::this_thread::sleep_for(std::chrono::milliseconds(1));
      return CodecResult::pending;
    }
    auto& packet=*packets_.front();
    RK_SERVER_TRACE(trace_,"mfx_sync_begin",TraceIds{},rk_record.cookie=packet.submit_cookie;rk_record.encoder=trace_encoder_;);
    const auto status=MFXVideoCORE_SyncOperation(session_,packet.sync,timeout);
    RK_SERVER_TRACE(trace_,"mfx_sync_return",TraceIds{},rk_record.cookie=packet.submit_cookie;rk_record.encoder=trace_encoder_;rk_record.status=status;);
    if(status==MFX_WRN_IN_EXECUTION)return CodecResult::pending;
    if(!Exact(status,"MFX SyncOperation",error)) {deferred_error_=error;return CodecResult::error;}
    const uint64_t cookie=packet.bitstream.TimeStamp;
    const auto found=jobs_.find(cookie);
    if(cookie==MFX_TIMESTAMP_UNKNOWN || found==jobs_.end()) {
      error="QSV output timestamp does not identify an outstanding input";deferred_error_=error;return CodecResult::error;
    }
    auto& task=*found->second;
    if(task.surface.Data.Locked || (task.converted && task.converted->surface.Data.Locked)) {
      error="QSV final encode Sync still owns the input or VPP output surface";deferred_error_=error;return CodecResult::error;
    }
    if(packet.bitstream.DataOffset>packet.bitstream.MaxLength ||
       packet.bitstream.DataLength>packet.bitstream.MaxLength-packet.bitstream.DataOffset || !packet.bitstream.DataLength) {
      error="QSV returned an invalid or empty bitstream";deferred_error_=error;return CodecResult::error;
    }
    output.frame_cookie=cookie;
    output.bytes.assign(packet.bitstream.Data+packet.bitstream.DataOffset,
      packet.bitstream.Data+packet.bitstream.DataOffset+packet.bitstream.DataLength);
    output.keyframe=(packet.bitstream.FrameType&MFX_FRAMETYPE_IDR)!=0;output.qp=-1;
    if(task.converted)task.converted->used=false;
    jobs_.erase(found);packets_.pop_front();return CodecResult::ready;
  }
  bool SetRates(uint32_t bitrate,uint32_t fps,std::string& error) override {
    (void)fps; // WebRTC reports observed input cadence, not a new BRC timebase.
    if(!jobs_.empty()||!packets_.empty()) {error="QSV rate reset requires drained queue";return false;}
    bitrate=std::min(bitrate,settings_.max_bitrate);
    if(bitrate/1000==settings_.bitrate/1000)return true;
    auto next=params_;
    next.mfx.TargetKbps=static_cast<mfxU16>(std::max(1u,bitrate/1000));
    next.mfx.MaxKbps=static_cast<mfxU16>(std::max(1u,(settings_.vbr?settings_.max_bitrate:bitrate)/1000));
    next.mfx.BufferSizeInKB=allocated_buffer_kb_;
    mfxExtEncoderResetOption reset{};
    reset.Header.BufferId=MFX_EXTBUFF_ENCODER_RESET_OPTION;reset.Header.BufferSz=sizeof(reset);
    reset.StartNewSequence=MFX_CODINGOPTION_OFF;
    std::array<mfxExtBuffer*,4> reset_extensions={extensions_[0],extensions_[1],extensions_[2],reinterpret_cast<mfxExtBuffer*>(&reset)};
    next.ExtParam=reset_extensions.data();next.NumExtParam=static_cast<mfxU16>(reset_extensions.size());
    RK_SERVER_TRACE(trace_,"mfx_reset_begin",TraceIds{},rk_record.encoder=trace_encoder_;);
    const auto status=MFXVideoENCODE_Reset(session_,&next);
    RK_SERVER_TRACE(trace_,"mfx_reset_return",TraceIds{},rk_record.encoder=trace_encoder_;rk_record.status=status;);
    // A driver rejecting no-new-sequence Reset must be diagnosed explicitly;
    // silently reinitializing here would turn every BWE change into an IDR.
    if(!Status(status,"MFX bitrate-only Reset StartNewSequence=OFF",error))return false;
    next.ExtParam=extensions_.data();next.NumExtParam=static_cast<mfxU16>(extensions_.size());
    params_=next;settings_.bitrate=bitrate;
    RK_SERVER_TRACE(trace_,"mfx_get_params_begin",TraceIds{},rk_record.encoder=trace_encoder_;);
    const auto get_status=MFXVideoENCODE_GetVideoParam(session_,&params_);
    RK_SERVER_TRACE(trace_,"mfx_get_params_return",TraceIds{},rk_record.encoder=trace_encoder_;rk_record.status=get_status;);
    low_power_.get_video_param_status=get_status;low_power_.initialized.reset();
    if(get_status>=0)low_power_.initialized=params_.mfx.LowPower;
    if(!Status(get_status,"MFX GetVideoParam after rate update",error))return false;
    if(settings_.qsv_low_power&&params_.mfx.LowPower!=settings_.qsv_low_power) {
      error="QSV rate update changed explicit LowPower value";return false;
    }
    if(!CheckSignal(error))return false;
    if(params_.mfx.CodecLevel>settings_.level_idc) {
      error="QSV rate update exceeded negotiated H264 level";return false;
    }
    fprintf(stderr,"QSV bitrate Reset: requested=%u actual=%u nominalFps=%u/%u newSequence=OFF status=%d\n",
      bitrate,params_.mfx.TargetKbps*1000u,params_.mfx.FrameInfo.FrameRateExtN,params_.mfx.FrameInfo.FrameRateExtD,status);
    return true;
  }
  bool Drain(std::vector<AccessUnit>& result,std::string& error) override {
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(5);
    while(!jobs_.empty()||!packets_.empty()) {
      AccessUnit output;auto status=Poll(100,output,error);
      if(status==CodecResult::error)return false;
      if(status==CodecResult::ready) result.push_back(std::move(output));
      if(std::chrono::steady_clock::now()>deadline) {error="QSV drain timed out";return false;}
      if(status==CodecResult::pending)std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    if(!deferred_error_.empty()) {error=deferred_error_;return false;}
    if(!VppEmpty(error))return false;
    if(!flush_packet_)flush_packet_=NewPacket();
    mfxStatus status;
    do {
      status=Encode(nullptr,*flush_packet_);
      if(status!=MFX_WRN_DEVICE_BUSY)break;
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    } while(std::chrono::steady_clock::now()<deadline);
    if(status==MFX_ERR_MORE_DATA && !flush_packet_->sync) {flush_packet_.reset();return true;}
    error="QSV encode drain returned an unaccounted output/status (MFX "+std::to_string(status)+")";
    return false;
  }
};
} // namespace
std::unique_ptr<HardwareEncoder> CreateQsvEncoder(){return std::make_unique<Qsv>();}
} // namespace remotekit::media
