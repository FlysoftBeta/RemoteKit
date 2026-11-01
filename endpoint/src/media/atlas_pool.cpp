#include "atlas_pool.hpp"
#include <array>
#include <vector>
#include <cstring>
#include <algorithm>
#include <mutex>
#include <cmath>
#include "remotekit/shared_lease_retirement.hpp"
namespace remotekit::media {
namespace {
std::atomic<uint64_t> next_atlas_pool{0};
}
struct AtlasPool::State {
 struct Slot {
  ComPtr<ID3D11Texture2D> texture;
  std::atomic<uint32_t> refs{0};
  std::atomic<uint64_t> cookie{0};
  uint64_t fence=0;
  int64_t observed_qpc=0;
  bool pending=false,ready_traced=false;
  bool active=false;
  SharedAtlasFrame metadata{};
 };
 remotekit_sdk_atlas_setup setup{};
 const uint64_t identity=++next_atlas_pool;
 SharedAtlasMapping* mapping=nullptr;
 ComPtr<ID3D11Device5> device;
 ComPtr<ID3D11DeviceContext4> context;
 ComPtr<ID3D11Fence> ready,consumed,done;
 std::array<ComPtr<ID3D11Texture2D>,3> textures;
 std::vector<std::unique_ptr<Slot>> pool;
 uint64_t last_frame=0,last_fence=0,next_cookie=0,done_sequence=0,copies=0,dropped=0;
 bool retiring=false,terminal_snapshot=false,producer_exited=false;
 uint64_t terminal_value=0;
 bool shared_input=false;
 remotekit::SharedLeaseRetirement retirement;
 int64_t frequency=QpcFrequency();double copy_ms=0;bool untracked_read=false;
 SharedAtlasFrame latest{};remotekit_rtc_clock_sample clock{};
 std::optional<double> capture_ready_ms;
 std::shared_ptr<ServerTrace> trace;uint64_t observed_frame=0,deferred_frame=0;
 std::vector<std::string> reported_failure_stages;
 TraceIds Ids(const Slot& slot) const {
  TraceIds ids;ids.frame_id=slot.cookie;ids.source_frame_id=slot.metadata.frame_id;
  ids.generation=slot.metadata.generation;ids.capture_time_us=slot.metadata.capture_time_us;ids.atlas_pool=identity;return ids;
 }
 static void Retain(void* context,uint64_t cookie) {
  auto* self=static_cast<State*>(context);
  for(auto& slot:self->pool) if(slot->cookie==cookie){const auto before=slot->refs.fetch_add(1);
   RK_SERVER_TRACE(self->trace,"lease_retain",self->Ids(*slot),rk_record.refs=before+1;);return;}
 }
 static void Release(void* context,uint64_t cookie) {
  auto* self=static_cast<State*>(context);
  for(auto& slot:self->pool) if(slot->cookie==cookie){
   // The last decrement permits the polling owner to destroy State immediately.
   // Keep the sink and all record fields alive independently before that edge.
   const auto trace=self->trace;const auto ids=trace?self->Ids(*slot):TraceIds{};
   const auto before=slot->refs.fetch_sub(1);
   RK_SERVER_TRACE(trace,"lease_release",ids,rk_record.refs=before-1;);
   return;}
 }
 std::string Failure(const char* stage,const std::string& message) {
  SharedAtlasFrame publication{};std::string publication_error;
  if(mapping)AtlasPool::ReadPublication(*mapping,setup,publication,publication_error);
  uint64_t refs=0,leased=0;std::string slot_refs;
  for(const auto& slot:pool){const auto count=slot->refs.load();refs+=count;leased+=count!=0;
   if(!slot_refs.empty())slot_refs+=",";slot_refs+=std::to_string(count);}
  const auto reason=device?device->GetDeviceRemovedReason():E_POINTER;
  const auto diagnostic=message+" [atlas_pool="+std::to_string(identity)+
   " generation="+std::to_string(setup.generation)+" stage="+stage+
   " terminal_observed="+std::to_string(terminal_snapshot)+" terminal_target="+std::to_string(terminal_value)+
   " terminal_ready="+std::to_string(retirement.terminal_ready())+
   " ready_completed="+std::to_string(ready?ready->GetCompletedValue():0)+
   " retired_prefix="+std::to_string(retirement.retired_prefix())+" observed_prefix="+std::to_string(retirement.last_observed())+
   " last_fence="+std::to_string(last_fence)+" active_refs="+std::to_string(refs)+
   " leased_slots="+std::to_string(leased)+" slot_refs="+slot_refs+
   " done_completed="+std::to_string(done?done->GetCompletedValue():0)+" done_target="+std::to_string(done_sequence)+
   " publication_generation="+std::to_string(publication.generation)+
   " publication_status="+std::to_string(static_cast<uint32_t>(publication.status))+
   " publication_frame="+std::to_string(publication.frame_id)+" publication_ready="+std::to_string(publication.ready_fence_value)+
   " producer_exited="+std::to_string(producer_exited)+" untracked_read="+std::to_string(untracked_read)+
   " device_reason="+std::to_string(static_cast<int32_t>(reason))+
   " publication_snapshot="+(publication.generation?"stable":"unavailable")+"]";
  // Retirement is polled often. Emit each failure stage once per imported pool;
  // the returned error always contains a fresh snapshot for its caller.
  if(std::find(reported_failure_stages.begin(),reported_failure_stages.end(),stage)==reported_failure_stages.end()) {
   fprintf(stderr,"%s\n",diagnostic.c_str());reported_failure_stages.emplace_back(stage);
  }
  return diagnostic;
 }
 Slot* Find(uint64_t cookie) {
  for(auto& slot:pool)if(slot->cookie==cookie)return slot.get();return nullptr;
 }
 bool ObserveTerminal(std::string& error) {
  if(!retiring)return true;
  if(!terminal_snapshot) {
   if(!mapping || !ready){error="atlas terminal metadata/fence unavailable; resources retained";return false;}
   SharedAtlasFrame frame{};
   const auto result=AtlasPool::ReadPublication(*mapping,setup,frame,error);
   // A contended seqlock is retried by retirement polling; do not use a torn
   // final fence. Starting cannot be terminal after output.close.
   if(result==Result::idle && !frame.generation){error.clear();return true;}
   if(!AtlasPool::ValidateTerminalPublication(frame,setup.generation,last_fence,error,producer_exited))return false;
   terminal_value=frame.ready_fence_value;terminal_snapshot=true;error.clear();
  }
  if(terminal_value) {
   retirement.ObserveUnborrowedThrough(terminal_value,ready->GetCompletedValue());
  }
  return true;
 }
 bool TerminalRetired() const {
  return retiring && terminal_snapshot && (!terminal_value ||
    (retirement.terminal_ready() && retirement.retired_prefix()>=terminal_value));
 }
 bool BeginRetirement(std::string& error) {
  retiring=true;
  return Retire(error);
 }
 bool Retire(std::string& error) {
  if(!context || untracked_read){error="atlas GPU retirement context/completion unavailable; resources retained";return false;}
  if(!ObserveTerminal(error))return false;
  const auto prefix=retirement.SafePrefix([&](uint64_t cookie){auto* slot=Find(cookie);return slot && slot->refs.load()==0;});
  if(!prefix)return true;
  // No owner of this prefix can submit a future read. Earlier reads have all
  // been submitted before the final release, to this same immediate context.
  // Release callbacks never enter the driver or manipulate this ledger.
  untracked_read=true;
  if(FAILED(context->Signal(consumed.Get(),prefix))){error="atlas consumed retirement signal failed; resources retained";return false;}
  const auto completion=done_sequence+1;
  if(FAILED(context->Signal(done.Get(),completion))){error="atlas local retirement signal failed; resources retained";return false;}
  done_sequence=completion;
  retirement.Commit(prefix,[&](uint64_t cookie){auto* slot=Find(cookie);slot->active=false;slot->fence=completion;
   RK_SERVER_TRACE(trace,"atlas_shared_retire",Ids(*slot),rk_record.fence=prefix;rk_record.cookie=completion;rk_record.completed_fence=consumed->GetCompletedValue(););});
  RK_SERVER_TRACE(trace,"atlas_shared_prefix",(TraceIds{0,0,setup.generation,0,0}),rk_record.ids.atlas_pool=identity;rk_record.fence=prefix;rk_record.cookie=completion;rk_record.completed_fence=consumed->GetCompletedValue(););
  untracked_read=false;context->Flush();return true;
 }
 ~State() {
  if(mapping)UnmapViewOfFile(mapping);
  auto close=[](uint64_t handle){if(handle)CloseHandle(reinterpret_cast<HANDLE>(static_cast<uintptr_t>(handle)));};
  close(setup.mapping_handle);close(setup.ready_fence_handle);close(setup.consumed_fence_handle);
  for(auto texture:setup.texture_handles)close(texture);
 }

};
AtlasPool::Result AtlasPool::ReadPublication(SharedAtlasMapping& mapping,
 const remotekit_sdk_atlas_setup& setup,SharedAtlasFrame& frame,std::string& error) {
 error.clear();
  auto* sequence=reinterpret_cast<volatile LONG64*>(&mapping.publication_sequence);
  bool stable=false;
  for(int attempt=0;attempt<3;++attempt) {
   auto before=InterlockedCompareExchange64(sequence,0,0);if(before&1)continue;
   std::memcpy(&frame,&mapping.frame,sizeof(frame));MemoryBarrier();
   if(before==InterlockedCompareExchange64(sequence,0,0)){stable=true;break;}
  }
  if(!stable){frame={};return Result::idle;}
  if(frame.status==SharedAtlasStatus::kStarting)return Result::idle;
  if(frame.status==SharedAtlasStatus::kReconfigureNeeded)return Result::reconfigure;
  if(frame.status!=SharedAtlasStatus::kRunning){
   const char* status="unknown";
   switch(frame.status){
    case SharedAtlasStatus::kStopped:status="stopped";break;
    case SharedAtlasStatus::kDeviceLost:status="device-lost";break;
    case SharedAtlasStatus::kFailed:status="failed";break;
    default:break;
   }
   error=std::string("atlas producer ")+status+" status="+std::to_string(static_cast<uint32_t>(frame.status))+
     " expected_generation="+std::to_string(setup.generation)+" publication_generation="+std::to_string(frame.generation)+
     " frame="+std::to_string(frame.frame_id);
   return Result::error;
  }
  if(frame.generation!=setup.generation||frame.width_pixels!=setup.width||frame.height_pixels!=setup.height||
     frame.slot>=3||!frame.frame_id||!frame.ready_fence_value||frame.ready_fence_value==UINT64_MAX||
     frame.view_count>kSharedAtlasMaxViews){error="atlas publication mismatch expected_generation="+
       std::to_string(setup.generation)+" publication_generation="+std::to_string(frame.generation)+
       " expected_size="+std::to_string(setup.width)+"x"+std::to_string(setup.height)+
       " publication_size="+std::to_string(frame.width_pixels)+"x"+std::to_string(frame.height_pixels)+
       " slot="+std::to_string(frame.slot)+" frame="+std::to_string(frame.frame_id)+
       " ready_fence="+std::to_string(frame.ready_fence_value)+" views="+std::to_string(frame.view_count);return Result::error;}
  for(uint32_t i=0;i<frame.view_count;++i) {
   auto& v=frame.views[i];
   if(!std::isfinite(v.atlas_pixels_per_dip)||v.atlas_pixels_per_dip<=0||
      !std::isfinite(v.page_device_scale_factor)||v.page_device_scale_factor<=0||
      v.x_pixels<0||v.y_pixels<0||uint64_t(v.x_pixels)+v.width_pixels>setup.width||
      uint64_t(v.y_pixels)+v.height_pixels>setup.height){error="atlas view bounds mismatch";return Result::error;}
  }
  return Result::ready;
}
bool AtlasPool::ValidateTerminalPublication(const SharedAtlasFrame& frame,
 uint64_t generation,uint64_t observed,std::string& error,bool producer_exited) {
 if(frame.generation!=generation || !generation ||
    (frame.status!=SharedAtlasStatus::kStopped && frame.status!=SharedAtlasStatus::kReconfigureNeeded &&
     frame.status!=SharedAtlasStatus::kDeviceLost && frame.status!=SharedAtlasStatus::kFailed &&
     !(producer_exited && frame.status==SharedAtlasStatus::kRunning)) ||
    frame.ready_fence_value==UINT64_MAX || frame.ready_fence_value<observed ||
    (!frame.ready_fence_value != !frame.frame_id)) {
  error="invalid/future atlas terminal publication; resources retained";return false;
 }
 error.clear();return true;
}
AtlasPool::AtlasPool(){wchar_t enabled[2]{};ready_gate_=GetEnvironmentVariableW(L"REMOTEKIT_ATLAS_READY_GATE",enabled,2)==1&&enabled[0]==L'1';}
AtlasPool::~AtlasPool(){std::string error;if(!Close(error)) {
 // Keep the state alive if a live GPU or SDK lease can still read it.
 auto* retained=new std::shared_ptr<State>(std::move(state_));(void)retained;
 auto* retired=new std::vector<std::shared_ptr<State>>(std::move(retired_));(void)retired;
}}
bool AtlasPool::Open(remotekit_sdk_atlas_setup setup,uint32_t count,std::string& error) {
 ReapRetired();
 if(state_) {
  if(retired_.size()>=3){State discard;discard.setup=setup;error="too many outstanding atlas generations";return false;}
  if(!state_->BeginRetirement(error)){error=state_->Failure("replace_retirement",error);State discard;discard.setup=setup;return false;}
  retired_.push_back(std::move(state_));
 }
 state_=std::make_shared<State>();auto& s=*state_;s.setup=setup;s.clock=clock_;s.trace=trace_;s.shared_input=shared_input_;
 held_=0;retired_prefix_=0;
 auto fail=[&](const char* text){error=text;return false;};
 if(!setup.width||!setup.height||!setup.generation||count<2||count>16)return fail("invalid atlas setup/pool size");
 LUID luid{setup.adapter_luid_low,setup.adapter_luid_high};
 if(device_ && FAILED(device_->GetDeviceRemovedReason()))device_.Reset();
 if(device_) {
  if(luid.HighPart!=adapter_.HighPart || luid.LowPart!=adapter_.LowPart){error="atlas adapter changed; peer rebuild required";return false;}
  s.device=device_;
  ComPtr<ID3D11DeviceContext> immediate;device_->GetImmediateContext(&immediate);
  if(FAILED(immediate.As(&s.context))){error="atlas context4 unavailable";return false;}
 } else {
  if(!CreateDevice(&luid,s.device,s.context,error))return false;
  device_=s.device;adapter_=luid;
 }
 if(FAILED(s.device->OpenSharedFence(reinterpret_cast<HANDLE>(setup.ready_fence_handle),IID_PPV_ARGS(&s.ready)))||
    FAILED(s.device->OpenSharedFence(reinterpret_cast<HANDLE>(setup.consumed_fence_handle),IID_PPV_ARGS(&s.consumed))))
  return fail("atlas fence import failed");
 for(size_t i=0;i<3;++i) {
  if(FAILED(s.device->OpenSharedResource1(reinterpret_cast<HANDLE>(setup.texture_handles[i]),IID_PPV_ARGS(&s.textures[i]))))
   return fail("atlas texture import failed");
  D3D11_TEXTURE2D_DESC desc{};s.textures[i]->GetDesc(&desc);
  if(desc.Width!=setup.width||desc.Height!=setup.height||desc.Format!=DXGI_FORMAT_B8G8R8A8_UNORM)
   return fail("atlas texture dimensions mismatch");
 }
 if(FAILED(s.device->CreateFence(0,D3D11_FENCE_FLAG_NONE,IID_PPV_ARGS(&s.done))))return fail("atlas copy fence create failed");
 s.mapping=static_cast<SharedAtlasMapping*>(MapViewOfFile(reinterpret_cast<HANDLE>(setup.mapping_handle),
       FILE_MAP_READ|FILE_MAP_WRITE,0,0,sizeof(SharedAtlasMapping)));
 if(!s.mapping||s.mapping->magic!=kSharedAtlasMagic||s.mapping->version!=kSharedAtlasVersion||
    s.mapping->mapping_size!=sizeof(SharedAtlasMapping))return fail("atlas metadata ABI mismatch");
 for(uint32_t i=0;i<(s.shared_input?3:count);++i) {
  auto slot=std::make_unique<State::Slot>();
  if(s.shared_input){slot->texture=s.textures[i];s.pool.push_back(std::move(slot));continue;}
  D3D11_TEXTURE2D_DESC desc{};desc.Width=setup.width;desc.Height=setup.height;
  desc.MipLevels=desc.ArraySize=1;desc.Format=DXGI_FORMAT_B8G8R8A8_UNORM;
  desc.SampleDesc.Count=1;desc.BindFlags=D3D11_BIND_SHADER_RESOURCE|D3D11_BIND_RENDER_TARGET;
  if(FAILED(s.device->CreateTexture2D(&desc,nullptr,&slot->texture)))return fail("atlas private pool create failed");
  s.pool.push_back(std::move(slot));
 }
 return true;
}
void AtlasPool::ReapRetired() {
 for(auto it=retired_.begin();it!=retired_.end();) {
  auto& old=**it;bool leased=false;
  const bool removed=old.device && FAILED(old.device->GetDeviceRemovedReason());
  std::string error;if(!removed && !old.untracked_read && !old.Retire(error))old.Failure("reap_retire",error);
  for(auto& slot:old.pool)leased|=slot->refs.load()!=0;
  const auto value=old.done?old.done->GetCompletedValue():0;
  if(!leased && (removed || (!old.untracked_read && old.TerminalRetired() && value!=UINT64_MAX && value>=old.done_sequence)))it=retired_.erase(it);
  else ++it;
 }
}
AtlasPool::Result AtlasPool::Poll(remotekit_rtc_frame& output,SharedAtlasFrame& metadata,std::string& error) {
 ReapRetired();
 if(!state_){error="atlas not open";return Result::error;}auto& s=*state_;
 if(FAILED(s.device->GetDeviceRemovedReason())){error=s.Failure("consumer_device","atlas consumer device lost");return Result::error;}
 if(s.shared_input) {
  if(!s.Retire(error)) {if(error.empty())error="atlas shared GPU retirement untracked; resources retained";error=s.Failure("poll_retirement",error);return Result::error;}
  retired_prefix_=s.retirement.retired_prefix();
  uint64_t held=0;for(const auto& slot:s.pool)held+=slot->refs.load()!=0;held_=held;
 }
 auto completed=s.done->GetCompletedValue();
 if(s.trace) {
  const auto ready_completed=s.ready->GetCompletedValue();
  for(auto& slot:s.pool)if(slot->pending&&!slot->ready_traced&&ready_completed!=UINT64_MAX&&ready_completed>=slot->metadata.ready_fence_value) {
   RK_SERVER_TRACE(s.trace,"atlas_ready_observed",s.Ids(*slot),rk_record.fence=slot->metadata.ready_fence_value;rk_record.completed_fence=ready_completed;);
   slot->ready_traced=true;
  }
 }
 if(completed==UINT64_MAX){error="atlas invalid GPU fence";return Result::error;}
 SharedAtlasFrame frame{};
 const auto publication=ReadPublication(*s.mapping,s.setup,frame,error);
 if(publication==Result::reconfigure) {
  if(!s.BeginRetirement(error)){error=s.Failure("reconfigure_retirement",error);return Result::error;}
  return Result::reconfigure;
 }
 if(s.retiring)return Result::reconfigure;
 if(publication!=Result::ready){if(publication==Result::error)error=s.Failure("publication",error);return publication;}
 State::Slot* first=nullptr;
 for(auto& slot:s.pool)if(slot->pending&&slot->fence<=completed&&(!first||slot->fence<first->fence))first=slot.get();
 for(auto& slot:s.pool) {
  if(slot.get()!=first)continue;
  slot->pending=false;slot->refs.store(1);
  output={};output.struct_size=sizeof(output);output.width=s.setup.width;output.height=s.setup.height;
  output.d3d11_texture=slot->texture.Get();output.frame_id=slot->cookie;
  output.capture_qpc=0;output.qpc_frequency=s.frequency;
  if(s.clock.consistent_across_processes && s.clock.high_resolution &&
     s.clock.qpc_frequency==s.frequency && slot->metadata.capture_time_us>0) {
   const int64_t midpoint=s.clock.qpc_before+(s.clock.qpc_after-s.clock.qpc_before)/2;
   const int64_t capture=midpoint+static_cast<int64_t>(
      static_cast<double>(slot->metadata.capture_time_us-s.clock.monotonic_us)*s.frequency/1000000.0);
   if(capture>0 && capture<=slot->observed_qpc) {
    output.capture_qpc=capture;s.capture_ready_ms=1000.0*(QpcNow()-capture)/s.frequency;
   }
  }
  output.release_context=&s;output.retain=&State::Retain;output.release=&State::Release;
  s.copy_ms=1000.0*(QpcNow()-slot->observed_qpc)/s.frequency;
  RK_SERVER_TRACE(s.trace,"atlas_private_copy_complete",s.Ids(*slot),
    rk_record.fence=slot->fence;rk_record.completed_fence=completed;);
  ++delivered_;metadata=slot->metadata;return Result::ready;
 }
 metadata=frame;s.latest=frame;
 if(s.trace && frame.frame_id!=s.observed_frame) {
  TraceRecord record;record.event="atlas_observed";record.ids.source_frame_id=frame.frame_id;
  record.ids.atlas_pool=s.identity;
  record.ids.generation=frame.generation;record.ids.capture_time_us=frame.capture_time_us;
  record.fence=frame.ready_fence_value;record.completed_fence=s.ready->GetCompletedValue();record.slot=frame.slot;
  record.pending=0;record.leased=0;for(const auto& slot:s.pool){record.pending+=slot->pending;record.leased+=slot->refs.load()!=0;}
  s.trace->Add(record);s.observed_frame=frame.frame_id;
 }
 if(frame.frame_id<s.last_frame){error="atlas frame regressed";return Result::error;}
 if(frame.frame_id==s.last_frame)return Result::idle;
 if(frame.ready_fence_value<=s.last_fence){error="atlas fence regressed";return Result::error;}
 if(ready_gate_ || s.shared_input) {
  const auto ready=s.ready->GetCompletedValue();
  if(ready==UINT64_MAX){error="atlas ready fence device removed";return Result::error;}
  if(ready<frame.ready_fence_value) {
   ++gate_polls_;
   if(s.deferred_frame!=frame.frame_id) {
    ++gate_frames_;s.deferred_frame=frame.frame_id;
    RK_SERVER_TRACE(s.trace,"atlas_ready_deferred",(TraceIds{0,frame.frame_id,frame.generation,0,frame.capture_time_us}),
      rk_record.ids.atlas_pool=s.identity;rk_record.fence=frame.ready_fence_value;rk_record.completed_fence=ready;rk_record.reason="ready_gate";);
   }
   // No slot reserved, submitted frame/fence advanced, or consumed signal.
   // Re-read the latest candidate on the next normal polling iteration.
   return Result::idle;
  }
 }
 if(s.shared_input) {
  auto& slot=*s.pool[frame.slot];
  // The browser may reuse this source slot only after our cumulative consumed
  // signal completed. Also observe the following local drain barrier.
  if(slot.active || slot.refs.load() || slot.fence>completed)return Result::idle;
  slot.observed_qpc=QpcNow();slot.cookie=++s.next_cookie;slot.metadata=frame;
  // The shared-input ready gate above supplied this generation's valid CPU
  // observation of GPU completion; the retirement ledger preserves that proof.
  slot.refs=1;slot.active=true;s.retirement.Observe(frame.ready_fence_value,slot.cookie);
  output={};output.struct_size=sizeof(output);output.width=s.setup.width;output.height=s.setup.height;
  output.d3d11_texture=slot.texture.Get();output.frame_id=slot.cookie;
  output.capture_qpc=0;output.qpc_frequency=s.frequency;
  if(s.clock.consistent_across_processes && s.clock.high_resolution && s.clock.qpc_frequency==s.frequency && frame.capture_time_us>0) {
   const int64_t midpoint=s.clock.qpc_before+(s.clock.qpc_after-s.clock.qpc_before)/2;
   const int64_t capture=midpoint+static_cast<int64_t>(double(frame.capture_time_us-s.clock.monotonic_us)*s.frequency/1000000.0);
   if(capture>0 && capture<=slot.observed_qpc){output.capture_qpc=capture;s.capture_ready_ms=1000.0*(QpcNow()-capture)/s.frequency;}
  }
  output.release_context=&s;output.retain=&State::Retain;output.release=&State::Release;
  if(frame.frame_id>s.last_frame+1)s.dropped+=frame.frame_id-s.last_frame-1;
  s.last_frame=frame.frame_id;s.last_fence=frame.ready_fence_value;
  ++borrows_;++delivered_;++held_;
  RK_SERVER_TRACE(s.trace,"atlas_shared_borrow",s.Ids(slot),rk_record.fence=frame.ready_fence_value;rk_record.completed_fence=s.ready->GetCompletedValue();rk_record.slot=frame.slot;);
  metadata=frame;return Result::ready;
 }
 State::Slot* free=nullptr;
 for(auto& slot:s.pool)if(!slot->pending&&slot->refs.load()==0){free=slot.get();break;}
 if(!free)return Result::idle;
 free->observed_qpc=QpcNow();free->cookie=++s.next_cookie;free->metadata=frame;
 free->ready_traced=false;
 RK_SERVER_TRACE(s.trace,"atlas_private_copy_submit",s.Ids(*free),
   rk_record.fence=frame.ready_fence_value;rk_record.completed_fence=s.ready->GetCompletedValue();rk_record.slot=frame.slot;);
 if(FAILED(s.context->Wait(s.ready.Get(),frame.ready_fence_value))){error="atlas GPU ready wait failed";return Result::error;}
 s.untracked_read=true;
 s.context->CopyResource(free->texture.Get(),s.textures[frame.slot].Get());++s.copies;
 if(FAILED(s.context->Signal(s.consumed.Get(),frame.ready_fence_value))){error="atlas GPU consumed signal failed";return Result::error;}
 free->fence=++s.done_sequence;free->pending=true;
 if(FAILED(s.context->Signal(s.done.Get(),free->fence))){error="atlas private copy signal failed";return Result::error;}
 s.untracked_read=false;
 if(frame.frame_id>s.last_frame+1)s.dropped+=frame.frame_id-s.last_frame-1;
 s.context->Flush();s.last_frame=frame.frame_id;s.last_fence=frame.ready_fence_value;
 return Result::idle;
}
void AtlasPool::SetClock(const remotekit_rtc_clock_sample& sample){clock_=sample;}
std::optional<double> AtlasPool::capture_to_ready_ms() const{return state_?state_->capture_ready_ms:std::nullopt;}
double AtlasPool::clock_uncertainty_us() const {
 return clock_.qpc_frequency?500000.0*(clock_.qpc_after-clock_.qpc_before)/clock_.qpc_frequency:0;
}
ID3D11Device5* AtlasPool::Device() const{return state_?state_->device.Get():nullptr;}
SharedAtlasFrame AtlasPool::LatestMetadata() const{return state_?state_->latest:SharedAtlasFrame{};}
uint64_t AtlasPool::copied_frames() const{return state_&&!state_->shared_input?state_->copies:0;}
uint64_t AtlasPool::drops() const{return state_?state_->dropped:0;}
double AtlasPool::last_copy_ms() const{return state_?state_->copy_ms:0;}
bool AtlasPool::Close(std::string& error,bool producer_exited) {
 error.clear();
 std::vector<std::shared_ptr<State>> all=retired_;if(state_)all.push_back(state_);
 // Record the exit proof on every generation before any lease/ready check can
 // return early. Open and retirement polling must retain this termination cause.
 if(producer_exited)for(auto& entry:all)entry->producer_exited=true;
 std::vector<State*> completed;
 for(auto& entry:all) {
  auto& s=*entry;
  auto fail=[&](const char* stage,const std::string& message){
   if(!error.empty())error+="; ";error+=s.Failure(stage,message);return false;
  };
  // Each generation must get an independent chance to drain. An incomplete
  // predecessor must not prevent later generations from releasing resources.
  const auto close_generation=[&]() {
  // Close is a barrier, not permission to retire a still-readable SDK frame.
  for(auto& slot:s.pool)if(slot->refs.load())return fail("leases","atlas pool still leased");
  if(s.device && SUCCEEDED(s.device->GetDeviceRemovedReason()) && !s.untracked_read) {
   std::string retirement_error;
   if(!s.BeginRetirement(retirement_error))return fail("begin_retirement",retirement_error);
   if(!s.terminal_snapshot)return fail("terminal_snapshot","atlas terminal publication not stable; resources retained");
   if(s.terminal_value && !s.retirement.terminal_ready()) {
    HANDLE event=CreateEventW(nullptr,FALSE,FALSE,nullptr);
    auto hr=event?s.ready->SetEventOnCompletion(s.terminal_value,event):HRESULT_FROM_WIN32(GetLastError());
    auto wait=SUCCEEDED(hr)?WaitForSingleObject(event,5000):WAIT_FAILED;CloseHandle(event);
    if(wait!=WAIT_OBJECT_0)return fail("terminal_ready","atlas producer terminal readiness timed out; resources retained hr="+
      std::to_string(static_cast<int32_t>(hr))+" wait="+std::to_string(wait));
    if(!s.Retire(retirement_error))return fail("terminal_retire",retirement_error);
   }
   if(!s.TerminalRetired())return fail("terminal_prefix","atlas terminal retirement incomplete; resources retained");
  }
  if(s.untracked_read && s.device && SUCCEEDED(s.device->GetDeviceRemovedReason())) {
   return fail("untracked_read","atlas GPU read has no completion fence; resources retained");
  }
  if(s.device&&SUCCEEDED(s.device->GetDeviceRemovedReason())&&s.done&&s.done_sequence) {
   HANDLE event=CreateEventW(nullptr,FALSE,FALSE,nullptr);
   auto hr=event?s.done->SetEventOnCompletion(s.done_sequence,event):HRESULT_FROM_WIN32(GetLastError());s.context->Flush();
   auto wait=SUCCEEDED(hr)?WaitForSingleObject(event,5000):WAIT_FAILED;CloseHandle(event);
   if(wait!=WAIT_OBJECT_0)return fail("done_drain","atlas GPU drain timed out hr="+
     std::to_string(static_cast<int32_t>(hr))+" wait="+std::to_string(wait));
  }
  for(auto& slot:s.pool)if(slot->refs.load())return fail("final_leases","atlas pool still leased");
  return true;
  };
  if(close_generation())completed.push_back(&s);
 }
 auto finished=[&](const std::shared_ptr<State>& entry){return std::find(completed.begin(),completed.end(),entry.get())!=completed.end();};
 std::erase_if(retired_,finished);
 if(state_ && finished(state_))state_.reset();
 return error.empty();
}
}
