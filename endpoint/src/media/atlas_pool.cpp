#include "atlas_pool.hpp"
#include <array>
#include <vector>
#include <cstring>
#include <algorithm>
#include <mutex>
#include <cmath>
namespace remotekit::media {
struct AtlasPool::State {
 struct Slot {
  ComPtr<ID3D11Texture2D> texture;
  std::atomic<uint32_t> refs{0};
  std::atomic<uint64_t> cookie{0};
  uint64_t fence=0;
  int64_t observed_qpc=0;
  bool pending=false;
  SharedAtlasFrame metadata{};
 };
 remotekit_sdk_atlas_setup setup{};
 SharedAtlasMapping* mapping=nullptr;
 ComPtr<ID3D11Device5> device;
 ComPtr<ID3D11DeviceContext4> context;
 ComPtr<ID3D11Fence> ready,consumed,done;
 std::array<ComPtr<ID3D11Texture2D>,3> textures;
 std::vector<std::unique_ptr<Slot>> pool;
 uint64_t last_frame=0,last_fence=0,next_cookie=0,copy_sequence=0,dropped=0;
 int64_t frequency=QpcFrequency();double copy_ms=0;bool untracked_read=false;
 SharedAtlasFrame latest{};remotekit_rtc_clock_sample clock{};
 std::optional<double> capture_ready_ms;
 static void Retain(void* context,uint64_t cookie) {
  auto* self=static_cast<State*>(context);
  for(auto& slot:self->pool) if(slot->cookie==cookie){slot->refs.fetch_add(1);return;}
 }
 static void Release(void* context,uint64_t cookie) {
  auto* self=static_cast<State*>(context);
  for(auto& slot:self->pool) if(slot->cookie==cookie){slot->refs.fetch_sub(1);return;}
 }
 ~State() {
  if(mapping)UnmapViewOfFile(mapping);
  auto close=[](uint64_t handle){if(handle)CloseHandle(reinterpret_cast<HANDLE>(static_cast<uintptr_t>(handle)));};
  close(setup.mapping_handle);close(setup.ready_fence_handle);close(setup.consumed_fence_handle);
  for(auto texture:setup.texture_handles)close(texture);
 }
 bool Read(SharedAtlasFrame& frame,std::string& error) {
  auto* sequence=reinterpret_cast<volatile LONG64*>(&mapping->publication_sequence);
  bool stable=false;
  for(int attempt=0;attempt<3;++attempt) {
   auto before=InterlockedCompareExchange64(sequence,0,0);if(before&1)continue;
   std::memcpy(&frame,&mapping->frame,sizeof(frame));MemoryBarrier();
   if(before==InterlockedCompareExchange64(sequence,0,0)){stable=true;break;}
  }
  if(!stable)return false;
  if(frame.status==SharedAtlasStatus::kStarting)return false;
  if(frame.status!=SharedAtlasStatus::kRunning){error="atlas producer stopped/device lost";return false;}
  if(frame.generation!=setup.generation||frame.width_pixels!=setup.width||frame.height_pixels!=setup.height||
     frame.slot>=3||!frame.frame_id||!frame.ready_fence_value||frame.ready_fence_value==UINT64_MAX||
     frame.view_count>kSharedAtlasMaxViews){error="atlas publication mismatch";return false;}
  for(uint32_t i=0;i<frame.view_count;++i) {
   auto& v=frame.views[i];
   if(!std::isfinite(v.atlas_pixels_per_dip)||v.atlas_pixels_per_dip<=0||
      !std::isfinite(v.page_device_scale_factor)||v.page_device_scale_factor<=0||
      v.x_pixels<0||v.y_pixels<0||uint64_t(v.x_pixels)+v.width_pixels>setup.width||
      uint64_t(v.y_pixels)+v.height_pixels>setup.height){error="atlas view bounds mismatch";return false;}
  }
  return true;
 }
};
AtlasPool::AtlasPool()=default;
AtlasPool::~AtlasPool(){std::string error;if(!Close(error)) {
 // Keep the state alive if a live GPU or SDK lease can still read it.
 auto* retained=new std::shared_ptr<State>(std::move(state_));(void)retained;
 auto* retired=new std::vector<std::shared_ptr<State>>(std::move(retired_));(void)retired;
}}
bool AtlasPool::Open(remotekit_sdk_atlas_setup setup,uint32_t count,std::string& error) {
 ReapRetired();
 if(state_) {
  if(retired_.size()>=3){State discard;discard.setup=setup;error="too many outstanding atlas generations";return false;}
  retired_.push_back(std::move(state_));
 }
 state_=std::make_shared<State>();auto& s=*state_;s.setup=setup;s.clock=clock_;
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
 for(uint32_t i=0;i<count;++i) {
  auto slot=std::make_unique<State::Slot>();
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
  for(auto& slot:old.pool)leased|=slot->refs.load()!=0;
  const auto value=old.done?old.done->GetCompletedValue():0;
  const bool removed=old.device && FAILED(old.device->GetDeviceRemovedReason());
  if(!leased && (removed || (!old.untracked_read && value!=UINT64_MAX && value>=old.copy_sequence)))it=retired_.erase(it);
  else ++it;
 }
}
AtlasPool::Result AtlasPool::Poll(remotekit_rtc_frame& output,SharedAtlasFrame& metadata,std::string& error) {
 ReapRetired();
 if(!state_){error="atlas not open";return Result::error;}auto& s=*state_;
 if(FAILED(s.device->GetDeviceRemovedReason())){error="atlas consumer device lost";return Result::error;}
 auto completed=s.done->GetCompletedValue();
 if(completed==UINT64_MAX){error="atlas invalid GPU fence";return Result::error;}
 State::Slot* first=nullptr;
 for(auto& slot:s.pool)if(slot->pending&&slot->fence<=completed&&(!first||slot->fence<first->fence))first=slot.get();
 for(auto& slot:s.pool) {
  if(slot.get()!=first)continue;
  slot->pending=false;slot->refs.store(1);
  output={};output.struct_size=sizeof(output);output.width=s.setup.width;output.height=s.setup.height;
  output.d3d11_texture=slot->texture.Get();output.frame_id=slot->cookie;
  output.capture_qpc=slot->observed_qpc;output.qpc_frequency=s.frequency;
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
  metadata=slot->metadata;return Result::ready;
 }
 SharedAtlasFrame frame{};
 if(!s.Read(frame,error))return error.empty()?Result::idle:Result::error;
 metadata=frame;s.latest=frame;
 if(frame.frame_id<s.last_frame){error="atlas frame regressed";return Result::error;}
 if(frame.frame_id==s.last_frame)return Result::idle;
 if(frame.ready_fence_value<=s.last_fence){error="atlas fence regressed";return Result::error;}
 State::Slot* free=nullptr;
 for(auto& slot:s.pool)if(!slot->pending&&slot->refs.load()==0){free=slot.get();break;}
 if(!free)return Result::idle;
 free->observed_qpc=QpcNow();free->cookie=++s.next_cookie;free->metadata=frame;
 if(FAILED(s.context->Wait(s.ready.Get(),frame.ready_fence_value))){error="atlas GPU ready wait failed";return Result::error;}
 s.untracked_read=true;
 s.context->CopyResource(free->texture.Get(),s.textures[frame.slot].Get());
 if(FAILED(s.context->Signal(s.consumed.Get(),frame.ready_fence_value))){error="atlas GPU consumed signal failed";return Result::error;}
 free->fence=++s.copy_sequence;free->pending=true;
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
uint64_t AtlasPool::copied_frames() const{return state_?state_->copy_sequence:0;}
uint64_t AtlasPool::drops() const{return state_?state_->dropped:0;}
double AtlasPool::last_copy_ms() const{return state_?state_->copy_ms:0;}
bool AtlasPool::Close(std::string& error) {
 std::vector<std::shared_ptr<State>> all=retired_;if(state_)all.push_back(state_);
 for(auto& entry:all) {
  auto& s=*entry;
  if(s.untracked_read && s.device && SUCCEEDED(s.device->GetDeviceRemovedReason())) {
   error="atlas GPU read has no completion fence; resources retained";return false;
  }
  if(s.device&&SUCCEEDED(s.device->GetDeviceRemovedReason())&&s.done&&s.copy_sequence) {
   HANDLE event=CreateEventW(nullptr,FALSE,FALSE,nullptr);
   auto hr=s.done->SetEventOnCompletion(s.copy_sequence,event);s.context->Flush();
   auto wait=SUCCEEDED(hr)?WaitForSingleObject(event,5000):WAIT_FAILED;CloseHandle(event);
   if(wait!=WAIT_OBJECT_0){error="atlas GPU drain timed out";return false;}
  }
  for(auto& slot:s.pool)if(slot->refs.load()){error="atlas pool still leased";return false;}
 }
 state_.reset();retired_.clear();return true;
}
}
