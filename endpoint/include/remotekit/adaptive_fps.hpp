#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <deque>
#include <optional>
#include <string>

namespace remotekit {
// Pure policy: monotonic milliseconds and cumulative encoder counters enter;
// callers serialize configuration and acknowledge the actual applied budget.
class AdaptiveFps {
 public:
  struct Counters {uint64_t completed=0,replaced=0,wait_us=0,wait_samples=0;};
  struct Feedback {
    uint64_t seq=0;std::optional<double> age_ms,display_hz,rtt_ms;
    std::optional<uint64_t> lost;bool visible=false;
  };
  AdaptiveFps(bool enabled,uint32_t requested):enabled_(enabled),requested_(std::max(1u,requested)),
    ceiling_(requested_),target_(requested_),applied_(requested_) {}
  void Reset(double now,Counters counters) {
    sources_.clear();generation_=0;capture_=0;have_source_=false;window_sources_=0;
    pressure_=healthy_=network_pressure_=0;last_decision_=now;last_reduction_=now-2000;
    previous_=counters;feedback_seq_=0;baseline_rtt_.reset();window_latency_.reset();ceiling_=requested_;
    target_=requested_;reason_="reset";error_.clear();
  }
  void ObserveSource(uint64_t generation,int64_t capture_us,double now,std::optional<double> latency) {
    // A publication ID changes on tail copies; only capture identity is content activity.
    if(!generation || capture_us<=0)return;
    if(have_source_ && generation==generation_ && capture_us==capture_)return;
    generation_=generation;capture_=capture_us;have_source_=true;
    sources_.push_back(now);++window_sources_;
    if(latency && std::isfinite(*latency) && *latency>=0)
      window_latency_=window_latency_?std::max(*window_latency_,*latency):*latency;
  }
  bool Step(double now,Counters counters,const Feedback& feedback) {
    if(!enabled_ || now-last_decision_<500)return false;
    last_decision_=now;
    while(!sources_.empty() && now-sources_.front()>2000)sources_.pop_front();
    const bool reset=counters.completed<previous_.completed || counters.replaced<previous_.replaced ||
      counters.wait_us<previous_.wait_us || counters.wait_samples<previous_.wait_samples;
    const uint64_t replaced=reset?0:counters.replaced-previous_.replaced;
    const uint64_t samples=reset?0:counters.wait_samples-previous_.wait_samples;
    const double wait=samples?double(counters.wait_us-previous_.wait_us)/samples/1000.0:0;
    previous_=counters;
    const bool active=window_sources_>0 && sources_.size()>=3 && !reset;
    const bool valid=feedback.seq && feedback.age_ms && *feedback.age_ms<=5000 && *feedback.age_ms>=0;
    ceiling_=requested_;
    if(valid && feedback.visible && feedback.display_hz && std::isfinite(*feedback.display_hz))
      ceiling_=std::min(requested_,static_cast<uint32_t>(std::max(1.0,std::ceil(*feedback.display_hz))));
    bool network=false;
    if(!valid)network_pressure_=0;
    if(valid && feedback.seq!=feedback_seq_) {
      feedback_seq_=feedback.seq;
      if(feedback.rtt_ms) {
        baseline_rtt_=baseline_rtt_?std::min(*baseline_rtt_,*feedback.rtt_ms):*feedback.rtt_ms;
        network=feedback.lost && *feedback.lost>0 && *feedback.rtt_ms>*baseline_rtt_+20 &&
          *feedback.rtt_ms>*baseline_rtt_*1.5;
      }
      if(!feedback.rtt_ms || !feedback.lost)network_pressure_=0;
      else if(!network)network_pressure_=0;
      else if(active)++network_pressure_;
    }
    const auto latency=window_latency_;
    const double replacement_fraction=window_sources_?double(replaced)/window_sources_:0;
    window_sources_=0;window_latency_.reset();
    const uint32_t minimum=std::min(10u,ceiling_);
    if(target_>ceiling_) {target_=ceiling_;reason_="display_limit";}
    if(!active) {pressure_=healthy_=0;reason_=reset?"counter_reset":"inactive";return target_!=applied_;}
    const bool pressure=(latency && *latency>40) || replacement_fraction>.05 ||
      (replaced && wait>8) || network;
    const bool healthy=(!latency || *latency<25) && samples>0 && wait<5 && replaced==0 && !network;
    if(pressure) {
      ++pressure_;healthy_=0;
      if(pressure_>=2 || network_pressure_>=2 || (latency && *latency>100)) {
        target_=std::max(minimum,std::min(ceiling_,static_cast<uint32_t>(std::floor(applied_*.8))));
        last_reduction_=now;pressure_=0;network_pressure_=0;reason_=network?"network_pressure":"pipeline_pressure";
      }
    } else {pressure_=0;healthy_=healthy?healthy_+1:0;
      if(healthy_>=3 && now-last_reduction_>=2000) {
        target_=std::min(ceiling_,applied_+2);healthy_=0;reason_="healthy_recovery";
      }
    }
    return target_!=applied_;
  }
  void Applied(uint32_t value) {applied_=value;error_.clear();}
  void Failed(std::string error) {error_=std::move(error);}
  bool enabled() const{return enabled_;}
  uint32_t requested() const{return requested_;}
  uint32_t ceiling() const{return ceiling_;}
  uint32_t target() const{return target_;}
  uint32_t applied() const{return applied_;}
  const std::string& reason() const{return reason_;}
  const std::string& error() const{return error_;}
 private:
  bool enabled_,have_source_=false;
  uint32_t requested_,ceiling_,target_,applied_,pressure_=0,healthy_=0,network_pressure_=0;
  uint64_t generation_=0,feedback_seq_=0,window_sources_=0;int64_t capture_=0;
  double last_decision_=-1e30,last_reduction_=-1e30;
  Counters previous_;std::deque<double> sources_;std::optional<double> window_latency_,baseline_rtt_;
  std::string reason_="initial",error_;
};
} // namespace remotekit
