#include "render_slots.hpp"
#include "render_event_queue.hpp"
#include "remotekit/comp_pacing.hpp"
#include <atomic>
#include <cstring>
#include <cmath>
namespace remotekit::media {
namespace {
bool Snapshot(int64_t& sequence,const SharedAtlasFrame& source,SharedAtlasFrame& out){
 auto* seq=reinterpret_cast<volatile LONG64*>(&sequence);
 for(int i=0;i<4;++i){auto before=InterlockedCompareExchange64(seq,0,0);if(before&1)continue;
  std::memcpy(&out,&source,sizeof(out));MemoryBarrier();if(before==InterlockedCompareExchange64(seq,0,0))return true;}return false;
}
}
struct RenderSlots::State {
 struct Slot {ComPtr<ID3D11Texture2D> texture;ComPtr<ID3D11Fence> ready,consumed;std::atomic<uint32_t> refs{0};uint64_t cookie=0;SharedAtlasFrame metadata{};};
 remotekit_sdk_render_setup setup{};Sdk* sdk=nullptr;uint64_t channel=0;
 SharedRenderMapping* mapping=nullptr;ComPtr<ID3D11Device5> device;ComPtr<ID3D11DeviceContext4> context;
 std::array<Slot,4> slots;CompPacing pacing;uint32_t producer_pid=0;
 RenderEventQueue events;
 StatsSnapshot* counters=nullptr;bool unknown_counted=false;
 bool fatal=false,untracked=false,closing=false,producer_exited=false,stop_requested=false,stop_confirmed=false;std::string failure;SharedAtlasFrame latest{};
 std::shared_ptr<ServerTrace> trace;
 TraceIds Ids(const Slot& slot)const{TraceIds ids;ids.frame_id=slot.cookie;ids.source_frame_id=slot.metadata.frame_id;ids.generation=setup.generation;ids.capture_time_us=slot.metadata.capture_time_us;return ids;}
 std::optional<double> capture_ready_ms;remotekit_rtc_clock_sample clock{};
 static void Event(void* ptr,const remotekit_sdk_render_event* event){static_cast<State*>(ptr)->events.Push(*event);}
 static void Retain(void* ptr,uint64_t cookie){auto* slot=static_cast<Slot*>(ptr);if(slot->cookie==cookie)slot->refs.fetch_add(1);}
 static void Release(void* ptr,uint64_t cookie){auto* slot=static_cast<Slot*>(ptr);if(slot->cookie==cookie)slot->refs.fetch_sub(1);}
 void CloseChannel(){if(channel){sdk->remotekit_sdk_render_close(channel);channel=0;}}
 void RequestStop(){
  closing=true;pacing.Stop();if(!channel||stop_requested)return;
  const auto status=sdk->remotekit_sdk_render_stop(channel,setup.generation);
  if(status==0){stop_requested=true;++counters->stopSent;RK_SERVER_TRACE(trace,"render_stop",(TraceIds{0,0,setup.generation,0,0}),);}
  else {fatal=true;failure="render Stop send failed; unresolved requests retained";CloseChannel();}
 }
 bool Advance(std::string& error){
  auto incoming=events.Drain();
  for(auto& e:incoming){if(e.type!=REMOTEKIT_SDK_RENDER_FATAL && e.generation!=setup.generation)continue;
   if(e.type==REMOTEKIT_SDK_RENDER_REJECT){if(!pacing.Reject({e.generation,e.value,e.slot})){fatal=true;failure="render Reject identity mismatch";}
    else {if(e.reason==REMOTEKIT_SDK_RENDER_IDLE){++counters->rejectIdle;if(pacing.IdleRejected({e.generation,e.value,e.slot}))++counters->idleEntries;}else if(e.reason==REMOTEKIT_SDK_RENDER_NOT_READY)++counters->rejectNotReady;else if(e.reason==REMOTEKIT_SDK_RENDER_REJECT_STOPPED)++counters->rejectStopped;
     RK_SERVER_TRACE(trace,"render_reject",(TraceIds{0,0,e.generation,0,0}),rk_record.slot=e.slot;rk_record.fence=e.value;rk_record.status=e.reason;rk_record.producer_pid=producer_pid;);}}
   else if(e.type==REMOTEKIT_SDK_RENDER_WAKE){if(pacing.Wake({e.generation,e.value,e.slot})){++counters->wakes;
    RK_SERVER_TRACE(trace,"render_wake",(TraceIds{0,0,e.generation,0,0}),rk_record.slot=e.slot;rk_record.fence=e.value;rk_record.producer_pid=producer_pid;);}}
   else if(e.type==REMOTEKIT_SDK_RENDER_STOPPED){stop_confirmed=true;++counters->stopConfirmed;RK_SERVER_TRACE(trace,"render_stopped",(TraceIds{0,0,e.generation,0,0}),);CloseChannel();}
   else if(e.type==REMOTEKIT_SDK_RENDER_FATAL){fatal=true;failure="render channel fatal reason="+std::to_string(e.reason);}}
  if(!device || FAILED(device->GetDeviceRemovedReason())){error="render consumer GPU device lost; resources retained";return false;}
  for(uint32_t i=0;i<4;++i){const auto record=pacing.slots()[i];auto& slot=slots[i];
   if(record.phase==CompPacing::Phase::leased && !slot.refs.load()){
    // Every texture read is queued on this immediate context before its lease
    // releases. Signal on that same context; only its actual completion frees.
    untracked=true;if(FAILED(context->Signal(slot.consumed.Get(),record.id.value))){error="slot consumed GPU signal failed; resources retained";return false;}
    untracked=false;pacing.Consume(record.id);context->Flush();
    RK_SERVER_TRACE(trace,"slot_consumed_submit",Ids(slot),rk_record.slot=i;rk_record.fence=record.id.value;);
   }else if(record.phase==CompPacing::Phase::consuming){auto done=slot.consumed->GetCompletedValue();
    if(done==UINT64_MAX){error="slot consumed GPU fence lost; resources retained";return false;}
    if(done>=record.id.value){pacing.Reusable(record.id);++counters->consumedCompleted;RK_SERVER_TRACE(trace,"slot_reusable",Ids(slot),rk_record.slot=i;rk_record.fence=record.id.value;rk_record.completed_fence=done;);}
   }
  }
  return true;
 }
 bool Drained()const{return !channel && !untracked && pacing.occupied()==0;}
 ~State(){CloseChannel();if(mapping)UnmapViewOfFile(mapping);auto close=[](uint64_t h){if(h)CloseHandle(reinterpret_cast<HANDLE>(h));};
  close(setup.mapping_handle);for(int i=0;i<4;++i){close(setup.texture_handles[i]);close(setup.ready_fence_handles[i]);close(setup.consumed_fence_handles[i]);}}
};
RenderSlots::RenderSlots()=default;
RenderSlots::~RenderSlots(){std::string error;Close(error);if(state_)new std::shared_ptr<State>(std::move(state_));if(!retired_.empty())new std::vector<std::shared_ptr<State>>(std::move(retired_));}
RenderSlots::StatsSnapshot RenderSlots::Stats()const{std::lock_guard lock(stats_mutex_);return published_;}
void RenderSlots::PublishStats(){
 auto value=counters_;value.idle=state_?state_->pacing.idle():false;value.occupied=state_?state_->pacing.occupied():0;value.retiredOccupied=0;value.heldSlots=0;value.activeDepth=state_?state_->pacing.depth():0;
 value.retiredGenerations=retired_.size();value.unknownGpuRetainedGenerations=0;
 auto observe=[&](State& s){for(auto& slot:s.slots)value.heldSlots+=slot.refs.load()!=0;
  const bool unknown=s.untracked||((s.fatal||s.unknown_counted)&&s.pacing.occupied());
  if(unknown){++value.unknownGpuRetainedGenerations;if(!s.unknown_counted){s.unknown_counted=true;++counters_.unknownGpuRetentions;}}
 };
 if(state_)observe(*state_);for(auto& old:retired_){value.retiredOccupied+=old->pacing.occupied();observe(*old);}
 counters_.peakOccupied=std::max(counters_.peakOccupied,value.occupied);value.peakOccupied=counters_.peakOccupied;value.unknownGpuRetentions=counters_.unknownGpuRetentions;
 std::lock_guard lock(stats_mutex_);published_=value;
}
void RenderSlots::Reap(){PublishGuard publish{*this};for(auto it=retired_.begin();it!=retired_.end();){std::string error;auto& s=**it;s.Advance(error);
 // A ready render with no delivered lease still needs an independent fence
 // observation, then a consumed signal. Retired generations are never skipped.
 for(auto record:s.pacing.slots())if(record.phase==CompPacing::Phase::rendering){auto value=s.slots[record.id.slot].ready?s.slots[record.id.slot].ready->GetCompletedValue():UINT64_MAX;if(value!=UINT64_MAX&&value>=record.id.value){s.pacing.Ready(record.id);++counters_.readyObserved;}}
 s.Advance(error);if(s.Drained()){++counters_.retiredGenerationsCompleted;RK_SERVER_TRACE(s.trace,"render_generation_retired",(TraceIds{0,0,s.setup.generation,0,0}),);it=retired_.erase(it);}else ++it;}}
bool RenderSlots::Open(remotekit_sdk_render_setup setup,uint32_t producer_pid,Sdk& sdk,LUID adapter,ID3D11Device5* device,
                       ID3D11DeviceContext4* context,std::string& error){PublishGuard publish{*this};
 Reap();if(state_){state_->RequestStop();retired_.push_back(std::move(state_));}
 auto s=std::make_shared<State>();s->setup=setup;s->producer_pid=producer_pid;s->sdk=&sdk;s->counters=&counters_;s->clock=clock_;s->trace=trace_;state_=s;
 if(!s->events.handle()){error="render event creation failed";return false;}
 if(setup.struct_size!=sizeof(setup)||!setup.generation||!setup.width||!setup.height||setup.mapping_size!=sizeof(SharedRenderMapping)){error="render setup ABI mismatch";return false;}
 if(adapter.LowPart!=setup.adapter_luid_low || adapter.HighPart!=setup.adapter_luid_high) {
  error="render adapter differs from selected streaming adapter";return false;
 }
 s->device=device;s->context=context;
 for(uint32_t i=0;i<4;++i){auto& slot=s->slots[i];if(FAILED(s->device->OpenSharedResource1(reinterpret_cast<HANDLE>(setup.texture_handles[i]),IID_PPV_ARGS(&slot.texture)))||
  FAILED(s->device->OpenSharedFence(reinterpret_cast<HANDLE>(setup.ready_fence_handles[i]),IID_PPV_ARGS(&slot.ready)))||
  FAILED(s->device->OpenSharedFence(reinterpret_cast<HANDLE>(setup.consumed_fence_handles[i]),IID_PPV_ARGS(&slot.consumed)))){error="render slot import failed";return false;}
  D3D11_TEXTURE2D_DESC desc{};slot.texture->GetDesc(&desc);if(desc.Width!=setup.width||desc.Height!=setup.height||desc.Format!=DXGI_FORMAT_B8G8R8A8_UNORM){error="render slot texture mismatch";return false;}}
 s->mapping=static_cast<SharedRenderMapping*>(MapViewOfFile(reinterpret_cast<HANDLE>(setup.mapping_handle),FILE_MAP_READ|FILE_MAP_WRITE,0,0,sizeof(SharedRenderMapping)));
 if(!s->mapping||s->mapping->magic!=kSharedRenderMagic||s->mapping->version!=kSharedRenderVersion||s->mapping->mapping_size!=sizeof(SharedRenderMapping)){error="render mapping ABI mismatch";return false;}
 s->pacing.Reset(setup.generation);if(sdk.remotekit_sdk_render_connect(setup.render_channel,State::Event,s.get(),&s->channel)!=0){error="render channel connect failed";return false;}return true;
}
bool RenderSlots::Begin(uint32_t interval,bool force,std::string& error,bool* sent){PublishGuard publish{*this};if(sent)*sent=false;if(!state_||state_->closing)return true;auto& s=*state_;
 if(!s.Advance(error))return false;if(s.fatal){error=s.failure;return false;}auto id=s.pacing.Reserve(force);if(!id)return true;
 remotekit_sdk_render_request begin{id->generation,id->value,id->slot,interval,force?1u:0u};const auto begin_qpc=s.trace?QpcNow():0;auto result=s.sdk->remotekit_sdk_render_begin(s.channel,&begin);
 if(result!=0){s.pacing.Reject(*id);if(result!=REMOTEKIT_SDK_BUSY){error="render Begin send failed "+std::to_string(result);return false;}}else {++counters_.begins;if(sent)*sent=true;RK_SERVER_TRACE(s.trace,"render_begin",(TraceIds{0,0,id->generation,0,0}),rk_record.slot=id->slot;rk_record.fence=id->value;rk_record.reason=force?"force":"cadence";rk_record.qpc=begin_qpc;rk_record.producer_pid=s.producer_pid;rk_record.leased=static_cast<int>(s.pacing.occupied()););}return true;
}
bool RenderSlots::HasCapacity()const{return state_&&state_->pacing.occupied()<state_->pacing.depth();}
HANDLE RenderSlots::EventHandle()const{return state_?state_->events.handle():nullptr;}
void RenderSlots::Pressure(bool backlog){PublishGuard publish{*this};if(state_)state_->pacing.Pressure(backlog,state_->pacing.occupied()>=state_->pacing.depth());}
RenderSlots::Result RenderSlots::Poll(remotekit_rtc_frame& frame,SharedAtlasFrame& metadata,std::string& error){PublishGuard publish{*this};Reap();if(!state_)return Result::idle;auto& s=*state_;
 if(!s.Advance(error))return Result::error;
 SharedAtlasFrame layout{};if(Snapshot(s.mapping->publication_sequence,s.mapping->latest_layout,layout)){
  if(layout.status==SharedAtlasStatus::kReconfigureNeeded)return Result::reconfigure;
  if(layout.status==SharedAtlasStatus::kFailed||layout.status==SharedAtlasStatus::kDeviceLost){error="render producer GPU failure; resources retained";return Result::error;}
  if(layout.generation==s.setup.generation)s.latest=layout;
 }
 if(s.fatal){error=s.failure;return Result::error;}
 const auto first=s.pacing.EarliestRendering();
 const auto first_value=first?first->value:UINT64_MAX;
 for(auto record:s.pacing.slots())if(record.phase==CompPacing::Phase::rendering&&record.id.value==first_value){auto& slot=s.slots[record.id.slot];auto ready=slot.ready->GetCompletedValue();
  if(ready==UINT64_MAX){error="slot ready GPU fence lost; resources retained";return Result::error;}if(ready<record.id.value)continue;
  SharedAtlasFrame value{};auto& publication=s.mapping->slots[record.id.slot];if(!Snapshot(publication.publication_sequence,publication.frame,value))continue;
  if(value.status!=SharedAtlasStatus::kRunning||value.generation!=record.id.generation||value.slot!=record.id.slot||value.ready_fence_value!=record.id.value||!value.frame_id||value.width_pixels!=s.setup.width||value.height_pixels!=s.setup.height||value.view_count>kSharedAtlasMaxViews){error="render slot identity mismatch; resources retained";return Result::error;}
  for(uint32_t i=0;i<value.view_count;++i){auto& v=value.views[i];if(!std::isfinite(v.atlas_pixels_per_dip)||v.atlas_pixels_per_dip<=0||!std::isfinite(v.page_device_scale_factor)||v.page_device_scale_factor<=0||v.x_pixels<0||v.y_pixels<0||uint64_t(v.x_pixels)+v.width_pixels>s.setup.width||uint64_t(v.y_pixels)+v.height_pixels>s.setup.height){error="render slot layout invalid";return Result::error;}}
  remotekit_sdk_render_identity observed{record.id.generation,record.id.value,record.id.slot,0};
  if(s.sdk->remotekit_sdk_render_observe_signal(s.channel,&observed)!=0){error="render signal identity acknowledgement failed";return Result::error;}
  slot.cookie=++next_cookie_;slot.metadata=value;slot.refs=1;s.pacing.Ready(record.id);++counters_.readyObserved;
  frame={};frame.struct_size=sizeof(frame);frame.width=s.setup.width;frame.height=s.setup.height;frame.frame_id=slot.cookie;frame.d3d11_texture=slot.texture.Get();frame.qpc_frequency=QpcFrequency();
  if(s.clock.consistent_across_processes&&s.clock.high_resolution&&s.clock.qpc_frequency==QpcFrequency()&&value.capture_time_us>0){const auto midpoint=s.clock.qpc_before+(s.clock.qpc_after-s.clock.qpc_before)/2;auto capture=midpoint+int64_t(double(value.capture_time_us-s.clock.monotonic_us)*QpcFrequency()/1000000.0);if(capture>0&&capture<=QpcNow()){frame.capture_qpc=capture;s.capture_ready_ms=1000.0*(QpcNow()-capture)/QpcFrequency();}}
  frame.release_context=&slot;frame.retain=State::Retain;frame.release=State::Release;metadata=value;++delivered_;RK_SERVER_TRACE(s.trace,"slot_ready_observed",s.Ids(slot),rk_record.slot=record.id.slot;rk_record.fence=record.id.value;rk_record.completed_fence=ready;rk_record.producer_pid=s.producer_pid;);return Result::ready;
 }return Result::idle;
}
SharedAtlasFrame RenderSlots::LatestMetadata()const{return state_?state_->latest:SharedAtlasFrame{};}
bool RenderSlots::Close(std::string& error,bool producer_exited){PublishGuard publish{*this};
 if(producer_exited){if(state_)state_->producer_exited=true;for(auto& old:retired_)old->producer_exited=true;}
 if(state_){state_->RequestStop();retired_.push_back(std::move(state_));}
 const auto deadline=QpcNow()+5*QpcFrequency();
 HANDLE completion=CreateEventW(nullptr,FALSE,FALSE,nullptr);
 do {
  Reap();if(retired_.empty()){if(completion)CloseHandle(completion);error.clear();return true;}
  bool waited=false;
  if(completion)for(auto& old:retired_){
   for(auto record:old->pacing.slots()){
    ID3D11Fence* fence=nullptr;
    if(record.phase==CompPacing::Phase::rendering)fence=old->slots[record.id.slot].ready.Get();
    else if(record.phase==CompPacing::Phase::consuming)fence=old->slots[record.id.slot].consumed.Get();
    if(!fence)continue;const auto done=fence->GetCompletedValue();
    if(done==UINT64_MAX||done>=record.id.value)continue;
    if(SUCCEEDED(fence->SetEventOnCompletion(record.id.value,completion))){WaitForSingleObject(completion,10);waited=true;}break;
   }
   if(waited)break;
  }
  // An SDK lease can finish without a GPU event. Yield with a finite deadline.
  if(!waited)Sleep(1);
 }while(QpcNow()<deadline);
 if(completion)CloseHandle(completion);
 for(auto& old:retired_){bool pending_render=false;for(const auto& record:old->pacing.slots())pending_render|=record.phase==CompPacing::Phase::rendering;
  if((pending_render||old->untracked||old->fatal)&&!old->unknown_counted){old->unknown_counted=true;++counters_.unknownGpuRetentions;}}
 error="render generations have unresolved GPU work or leases; retained";return false;
}
int64_t RenderSlots::MonotonicMicros()const{if(!clock_.qpc_frequency)return 0;const auto midpoint=clock_.qpc_before+(clock_.qpc_after-clock_.qpc_before)/2;return clock_.monotonic_us+int64_t(double(QpcNow()-midpoint)*1000000.0/clock_.qpc_frequency);}
std::optional<double> RenderSlots::capture_to_ready_ms()const{return state_?state_->capture_ready_ms:std::nullopt;}
double RenderSlots::clock_uncertainty_us()const{return clock_.qpc_frequency?500000.0*(clock_.qpc_after-clock_.qpc_before)/clock_.qpc_frequency:0;}
uint64_t RenderSlots::shared_held_slots()const{return Stats().heldSlots;}
}
