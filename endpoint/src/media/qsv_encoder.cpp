#include "hardware_encoder.hpp"
#include "remotekit/sampling.hpp"
#include <vpl/mfxdispatcher.h>
#include <vpl/mfxvideo.h>
#include <wrl/client.h>
#include <d3d10.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <cstdio>
#include <deque>
#include <map>
#include <thread>
namespace remotekit::media {
namespace {
using Microsoft::WRL::ComPtr;
struct Memory { ComPtr<ID3D11Texture2D> texture; UINT index=0; };
class Qsv final : public HardwareEncoder {
  struct Task {
    uint64_t cookie=0;
    Memory memory;
    mfxFrameSurface1 surface{};
    mfxBitstream bitstream{};
    std::vector<mfxU8> storage;
    mfxSyncPoint sync=nullptr;
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
  std::deque<std::unique_ptr<Task>> tasks_;
  std::deque<std::unique_ptr<Task>> held_;
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
    if(request->Info.FourCC!=MFX_FOURCC_NV12) return MFX_ERR_UNSUPPORTED;
    const UINT count=request->NumFrameSuggested;
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width=request->Info.Width;desc.Height=request->Info.Height;
    desc.MipLevels=1;desc.ArraySize=count;desc.Format=DXGI_FORMAT_NV12;
    desc.SampleDesc.Count=1;desc.Usage=D3D11_USAGE_DEFAULT;
    desc.BindFlags=D3D11_BIND_DECODER;
    ComPtr<ID3D11Texture2D> texture;
    if(FAILED(self->device_->CreateTexture2D(&desc,nullptr,&texture))) return MFX_ERR_MEMORY_ALLOC;
    auto* ids=new mfxMemId[count];
    for(UINT i=0;i<count;++i) {
      auto memory=std::make_unique<Memory>();memory->texture=texture;memory->index=i;
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
 public:
  std::optional<QsvLowPowerInfo> LowPowerInfo() const override {return low_power_;}
  ~Qsv() override {
    if(session_) {
      // Close is the hardware cancellation/drain boundary even on device error.
      if(initialized_) MFXVideoENCODE_Close(session_);
      MFXClose(session_);
    }
    tasks_.clear();held_.clear();allocations_.clear();
    if(loader_) MFXUnload(loader_);
  }
  const char* Name() const override {return "qsv";}
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
    if(tasks_.size()+held_.size()>=settings_.async_depth) return CodecResult::busy;
    auto task=std::make_unique<Task>();task->cookie=cookie;task->memory.texture=texture;
    task->surface.Info=params_.mfx.FrameInfo;task->surface.Data.MemId=&task->memory;
    task->surface.Data.TimeStamp=cookie;task->storage.resize(std::max({size_t(4*1024*1024),
        static_cast<size_t>(settings_.width)*settings_.height*2,
        static_cast<size_t>(params_.mfx.BufferSizeInKB)*1000+65536}));
    task->bitstream.Data=task->storage.data();task->bitstream.MaxLength=static_cast<mfxU32>(task->storage.size());
    mfxEncodeCtrl control{};
    if(key) control.FrameType=MFX_FRAMETYPE_I|MFX_FRAMETYPE_IDR|MFX_FRAMETYPE_REF;
    auto status=MFXVideoENCODE_EncodeFrameAsync(session_,&control,&task->surface,&task->bitstream,&task->sync);
    while(status==MFX_ERR_NOT_ENOUGH_BUFFER && task->storage.size()<64*1024*1024) {
      task->storage.resize(std::min<size_t>(64*1024*1024,task->storage.size()*2));
      task->bitstream.Data=task->storage.data();task->bitstream.MaxLength=static_cast<mfxU32>(task->storage.size());
      status=MFXVideoENCODE_EncodeFrameAsync(session_,&control,&task->surface,&task->bitstream,&task->sync);
    }
    if(status==MFX_WRN_DEVICE_BUSY) return CodecResult::busy;
    if(status==MFX_ERR_MORE_DATA) {
      // MORE_DATA accepted the surface. Retain its frame and memory until a
      // later output timestamp completes it; never return its pool lease here.
      held_.push_back(std::move(task));return CodecResult::accepted;
    }
    if(status<0 || !task->sync) {
      Status(status,"MFX EncodeFrameAsync",error);
      if(error.empty())error="QSV returned no synchronization point";
      return CodecResult::error;
    }
    tasks_.push_back(std::move(task));return CodecResult::accepted;
  }
  CodecResult Poll(uint32_t timeout,AccessUnit& output,std::string& error) override {
    if(tasks_.empty() && !held_.empty()) {
      auto task=std::move(held_.front());held_.pop_front();
      task->bitstream.DataOffset=task->bitstream.DataLength=0;
      auto status=MFXVideoENCODE_EncodeFrameAsync(session_,nullptr,nullptr,&task->bitstream,&task->sync);
      if(status==MFX_WRN_DEVICE_BUSY) {
        held_.push_front(std::move(task));return CodecResult::pending;
      }
      if(status<0 || !task->sync) {
        held_.push_front(std::move(task));
        Status(status,"MFX flush delayed input",error);
        if(error.empty())error="QSV flush returned no sync";
        return CodecResult::error;
      }
      tasks_.push_back(std::move(task));
    }
    if(tasks_.empty()) return CodecResult::pending;
    auto& task=*tasks_.front();
    auto status=MFXVideoCORE_SyncOperation(session_,task.sync,timeout);
    if(status==MFX_WRN_IN_EXECUTION) return CodecResult::pending;
    if(!Status(status,"MFX SyncOperation",error)) return CodecResult::error;
    output.frame_cookie=task.bitstream.TimeStamp;
    if(output.frame_cookie==MFX_TIMESTAMP_UNKNOWN) output.frame_cookie=task.cookie;
    output.bytes.assign(task.bitstream.Data+task.bitstream.DataOffset,
                        task.bitstream.Data+task.bitstream.DataOffset+task.bitstream.DataLength);
    output.keyframe=(task.bitstream.FrameType&MFX_FRAMETYPE_IDR)!=0;
    output.qp=-1;
    auto completed=std::move(tasks_.front());tasks_.pop_front();
    for(auto it=held_.begin();it!=held_.end();++it) {
      if((*it)->cookie!=output.frame_cookie) continue;
      if((*it)->surface.Data.Locked) {
        held_.push_back(std::move(completed));
        error="QSV completed output still has a locked input";return CodecResult::error;
      }
      held_.erase(it);break;
    }
    if(completed->cookie==output.frame_cookie && completed->surface.Data.Locked) {
      held_.push_back(std::move(completed));
      error="QSV synchronized output still owns its input surface";return CodecResult::error;
    }
    if(completed->cookie!=output.frame_cookie) {
      completed->sync=nullptr;held_.push_back(std::move(completed));
    }
    return CodecResult::ready;
  }
  bool SetRates(uint32_t bitrate,uint32_t fps,std::string& error) override {
    (void)fps; // WebRTC reports observed input cadence, not a new BRC timebase.
    if(!tasks_.empty()||!held_.empty()) {error="QSV rate reset requires drained queue";return false;}
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
    const auto status=MFXVideoENCODE_Reset(session_,&next);
    // A driver rejecting no-new-sequence Reset must be diagnosed explicitly;
    // silently reinitializing here would turn every BWE change into an IDR.
    if(!Status(status,"MFX bitrate-only Reset StartNewSequence=OFF",error))return false;
    next.ExtParam=extensions_.data();next.NumExtParam=static_cast<mfxU16>(extensions_.size());
    params_=next;settings_.bitrate=bitrate;
    const auto get_status=MFXVideoENCODE_GetVideoParam(session_,&params_);
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
    while(!tasks_.empty()||!held_.empty()) {
      AccessUnit output;auto status=Poll(100,output,error);
      if(status==CodecResult::error)return false;
      if(status==CodecResult::ready) result.push_back(std::move(output));
      if(std::chrono::steady_clock::now()>deadline) {error="QSV drain timed out";return false;}
    }
    return true;
  }
};
} // namespace
std::unique_ptr<HardwareEncoder> CreateQsvEncoder(){return std::make_unique<Qsv>();}
} // namespace remotekit::media
