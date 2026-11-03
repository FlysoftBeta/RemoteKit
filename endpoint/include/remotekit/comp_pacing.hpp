#pragma once
#include <algorithm>
#include <array>
#include <cstdint>
#include <optional>
namespace remotekit {
class CompBeginSchedule {
 public:
  void Reset() { deadline_ = 0; wake_pending_ = false; }
  void Wake() { deadline_ = 0; wake_pending_ = true; }
  bool Due(int64_t now) const { return now >= deadline_; }
  int64_t deadline() const { return deadline_; }

  void Attempted(int64_t now, int64_t interval, bool sent) {
    if (wake_pending_ && !sent) return;
    deadline_ = now + interval;
    wake_pending_ = false;
  }

 private:
  int64_t deadline_ = 0;
  bool wake_pending_ = false;
};

// Owner-thread ledger. A sent Begin remains occupied until Reject, or until
// ready and the final consumer lease and consumed GPU signal have completed.
class CompCadence {
 public:
 uint32_t Update(uint32_t bitrate,uint32_t observed_fps,uint32_t client_max,uint32_t official_max,bool capacity,int64_t now_us){
  const auto ceiling=std::min(client_max,official_max);
  if(!bitrate||!observed_fps){target_=0;return 0;}
  if(!target_){target_=std::min(ceiling,observed_fps);next_ramp_=now_us+250000;}
  else if(capacity&&now_us>=next_ramp_){target_=std::min(ceiling,std::max(target_+1,target_*2));next_ramp_=now_us+250000;}
  target_=std::min(target_,ceiling);return target_;
 }
 private:uint32_t target_=0;int64_t next_ramp_=0;
};
class CompPacing {
 public:
 enum class Phase { free, rendering, leased, consuming };
 struct Identity {uint64_t generation=0,value=0;uint32_t slot=0;};
 struct Slot {Phase phase=Phase::free;Identity id{};bool force=false;};
 void Reset(uint64_t generation){generation_=generation;next_=0;depth_=1;slots_={};idle_=false;stopped_=false;last_idle_={};wake_barrier_=0;last_wake_=0;}
 std::optional<Identity> Reserve(bool force=false){
  if(stopped_||(idle_&&!force)||occupied()>=depth_)return {};
  for(uint32_t i=0;i<4;++i)if(slots_[i].phase==Phase::free){
   auto id=Identity{generation_,++next_,i};slots_[i]={Phase::rendering,id,force};return id;}
  return {};
 }
 bool Reject(Identity id){if(!Matches(id,Phase::rendering))return false;slots_[id.slot].phase=Phase::free;return true;}
 // Wake records every Begin already issued, so an old outstanding request's
 // later Idle cannot suspend the newly awakened demand.
 bool IdleRejected(Identity id){
  if(stopped_||id.generation!=generation_||id.value<last_idle_.value)return false;
  const bool was_idle=idle_;last_idle_=id;if(id.value>wake_barrier_)idle_=true;return !was_idle&&idle_;
 }
 bool Wake(Identity id){
  if(stopped_||id.generation!=generation_||id.value!=last_idle_.value||id.slot!=last_idle_.slot||id.value<=last_wake_)return false;
  last_wake_=id.value;wake_barrier_=next_;idle_=false;return true;
 }
 void Stop(){stopped_=true;}
 bool idle()const{return idle_;}
 bool Ready(Identity id){if(!Matches(id,Phase::rendering))return false;slots_[id.slot].phase=Phase::leased;return true;}
 bool Consume(Identity id){if(!Matches(id,Phase::leased))return false;slots_[id.slot].phase=Phase::consuming;return true;}
 bool Reusable(Identity id){if(!Matches(id,Phase::consuming))return false;slots_[id.slot].phase=Phase::free;return true;}
 void Pressure(bool encoder_backlog,bool saturated){
  if(encoder_backlog)depth_=std::max(1u,depth_-1);
  else if(saturated)depth_=std::min(4u,depth_+1);
 }
 std::optional<Identity> EarliestRendering()const{
  std::optional<Identity> first;
  for(const auto& record:slots_)if(record.phase==Phase::rendering&&(!first||record.id.value<first->value))first=record.id;
  return first;
 }
 uint32_t occupied()const{uint32_t count=0;for(auto& s:slots_)count+=s.phase!=Phase::free;return count;}
 uint32_t depth()const{return depth_;}
 const std::array<Slot,4>& slots()const{return slots_;}
 private:
 bool Matches(Identity id,Phase phase)const{return id.slot<4&&id.generation==generation_&&slots_[id.slot].id.value==id.value&&slots_[id.slot].phase==phase;}
 uint64_t generation_=0,next_=0,wake_barrier_=0,last_wake_=0;Identity last_idle_{};bool idle_=false,stopped_=false;uint32_t depth_=1;std::array<Slot,4> slots_{};
};
}
