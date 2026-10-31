#include "encoder_worker.hpp"
#include "remotekit/sampling.hpp"
#include <chrono>
namespace remotekit::media {
nlohmann::json EncoderStats::Snapshot() {
 std::lock_guard lock(mutex);
 return {{"senderRtcStats",sender_rtc_stats},{"encoder",backend},{"encodeSubmitted",submitted.load()},{"encodeCompleted",completed.load()},
         {"encodedBytes",bytes.load()},{"encodeDropped",dropped.load()},
         {"rateUpdates",rate_updates.load()},{"keyframeRequests",keyframe_requests.load()},
         {"keyframesSubmitted",keyframes_submitted.load()},{"keyframesEncoded",keyframes_encoded.load()},
         {"lastEncodeMs",completed.load()?nlohmann::json(last_encode_ms.load()):nlohmann::json(nullptr)},
         {"lastRequestedBitrate",requested_bitrate},{"lastRequestedFps",requested_fps},
         {"appliedBitrate",applied_bitrate? nlohmann::json(applied_bitrate):nlohmann::json(nullptr)},
         {"appliedFps",applied_fps? nlohmann::json(applied_fps):nlohmann::json(nullptr)},
         {"actualLevel",actual_level},{"error",error.empty()?nlohmann::json(nullptr):nlohmann::json(error)}};
}
EncoderWorker::EncoderWorker(Sdk& sdk,uint64_t encoder,ID3D11Device* device,std::string mode,
       EncoderSettings defaults,std::shared_ptr<EncoderStats> stats,std::function<void(uint32_t,uint64_t,size_t,bool)> completed):sdk_(sdk),encoder_(encoder),device_(device),
       mode_(std::move(mode)),settings_(defaults),stats_(std::move(stats)),completed_(std::move(completed)){}
EncoderWorker::~EncoderWorker(){Stop();}
void EncoderWorker::Error(const std::string& error) {
 failed_=true;std::lock_guard lock(stats_->mutex);stats_->error=error;
 fprintf(stderr,"encoder %llu: %s\n",encoder_,error.c_str());
}
bool EncoderWorker::Configure(const remotekit_rtc_encoder_config& config) {
 Stop(); // WebRTC may configure an existing encoder after a size transition.
 settings_.width=config.width;settings_.height=config.height;
 settings_.fps=config.fps?config.fps:settings_.fps;
 settings_.bitrate=config.bitrate_bps?config.bitrate_bps:settings_.bitrate;
 settings_.max_bitrate=config.max_bitrate_bps?config.max_bitrate_bps:settings_.max_bitrate;
 settings_.level_idc=config.h264_level_idc;
 const auto level_budget=remotekit::H264RateLimits(settings_.level_idc);
 if(level_budget.bitrate_bps) {
  settings_.max_bitrate=std::min(settings_.max_bitrate,level_budget.bitrate_bps);
  settings_.bitrate=std::min(settings_.bitrate,settings_.max_bitrate);
 }
 const auto requested_usage=settings_.target_usage;const bool requested_vbr=settings_.vbr;
 auto defaults=[&](bool qsv) {
  settings_.target_usage=settings_.target_usage_explicit?requested_usage:(qsv?1u:4u);
  settings_.vbr=settings_.rate_control_explicit?requested_vbr:qsv;
 };
 defaults(mode_!="nvenc");
 std::string error;
 hardware_=mode_=="nvenc"?CreateNvencEncoder():CreateQsvEncoder();
 if(!hardware_->Configure(device_.Get(),settings_,error)) {
  hardware_.reset();
  if(mode_!="auto"){Error(error);return false;}
  const std::string qsv_error=error;
  defaults(false);hardware_=CreateNvencEncoder();
  if(!hardware_->Configure(device_.Get(),settings_,error)){Error("QSV: "+qsv_error+"; NVENC: "+error);hardware_.reset();return false;}
 }
 if(!converter_.Open(device_.Get(),settings_.width,settings_.height,settings_.fps,error)){Error(error);return false;}
 for(uint32_t i=0;i<settings_.async_depth;++i) {
  ComPtr<ID3D11Texture2D> surface;
  if(!converter_.CreateSurface(surface,error)){Error(error);return false;}
  surfaces_.push_back(std::move(surface));free_.push_back(i);
 }
 {std::lock_guard lock(stats_->mutex);stats_->backend=hardware_->Name();stats_->error.clear();
  auto actual=hardware_->ActualSettings();stats_->applied_bitrate=actual.bitrate;stats_->applied_fps=actual.fps;
  stats_->actual_level=actual.level_idc;stats_->requested_bitrate=settings_.bitrate;stats_->requested_fps=settings_.fps;}
 nominal_fps_=settings_.fps;fixed_rate_fps_=std::string(hardware_->Name())=="qsv";
 applied_bitrate_=settings_.bitrate;applied_fps_=settings_.fps;bitrate_=0;fps_=0;paused_=false;
 stopping_=false;failed_=false;configured_=true;
 thread_=std::thread([this]{Run();});return true;
}
bool EncoderWorker::Enqueue(const remotekit_rtc_frame& frame,bool keyframe) {
 std::lock_guard lock(mutex_);
 if(!configured_||stopping_||failed_||paused_) {
  ++stats_->dropped;return false;
 }
 if(!queue_.empty()) {
  auto previous=queue_.front();queue_.pop_front();
  keyframe=keyframe||previous.key;
  previous.frame.release(previous.frame.release_context,previous.frame.frame_id);
  static_cast<ID3D11Texture2D*>(previous.frame.d3d11_texture)->Release();
  if(sdk_.encoder_drop)sdk_.encoder_drop(encoder_,previous.frame.rtp_timestamp);
  ++stats_->dropped;
 }
 Job job;job.frame=frame;job.key=keyframe;job.cookie=++cookie_;
 // Hold both COM lifetime and the distinct atlas-pool slot lease.
 static_cast<ID3D11Texture2D*>(frame.d3d11_texture)->AddRef();
 frame.retain(frame.release_context,frame.frame_id);
 queue_.push_back(job);wake_.notify_one();return true;
}
void EncoderWorker::Rates(uint32_t bitrate,uint32_t fps){
 {std::lock_guard lock(stats_->mutex);stats_->requested_bitrate=bitrate;stats_->requested_fps=fps;}
 if(!bitrate){paused_=true;return;}
 paused_=false;
 // oneVPL consumes integer kbps; identical effective rates need no reset.
 bitrate=std::max(1000u,std::min(settings_.max_bitrate,bitrate)/1000*1000);
 fps=fixed_rate_fps_?nominal_fps_:std::max(1u,fps);
 if(bitrate==applied_bitrate_.load()/1000*1000 && fps==applied_fps_.load())return;
 bitrate_=bitrate;fps_=fps;wake_.notify_one();
}
void EncoderWorker::Keyframe(){++stats_->keyframe_requests;keyframe_=true;wake_.notify_one();}
void EncoderWorker::Complete(AccessUnit& unit) {
 auto found=inflight_.find(unit.frame_cookie);
 if(found==inflight_.end()){Error("unknown hardware frame completion cookie");return;}
 auto job=found->second;inflight_.erase(found);free_.push_back(job.surface);
 remotekit_rtc_encoded_frame result{};result.struct_size=sizeof(result);
 result.annex_b=unit.bytes.data();result.size=unit.bytes.size();result.width=settings_.width;result.height=settings_.height;
 result.rtp_timestamp=job.frame.rtp_timestamp;result.capture_time_us=job.frame.capture_time_us;
 result.keyframe=unit.keyframe;result.qp=unit.qp;
 uint32_t wire_timestamp=0;
 auto status=sdk_.remotekit_rtc_encoded(encoder_,&result,&wire_timestamp);
 if(status==0 && completed_)completed_(wire_timestamp,job.frame.layout_epoch,unit.bytes.size(),unit.keyframe);
 if(status!=0 && status!=REMOTEKIT_SDK_INVALID_STATE)Error("RTC encoded completion failed "+std::to_string(status));
 ++stats_->completed;stats_->bytes+=unit.bytes.size();if(unit.keyframe)++stats_->keyframes_encoded;
 stats_->last_encode_ms=1000.0*(QpcNow()-job.submitted_qpc)/QpcFrequency();
 job.frame.release(job.frame.release_context,job.frame.frame_id);
 static_cast<ID3D11Texture2D*>(job.frame.d3d11_texture)->Release();
}
void EncoderWorker::Run() {
 while(true) {
  {
   std::unique_lock lock(mutex_);
   if(!stopping_ && queue_.empty() && inflight_.empty())wake_.wait_for(lock,std::chrono::milliseconds(5));
   if(stopping_||failed_)break;
  }
  const auto rate=inflight_.empty()?bitrate_.exchange(0):0;
  const auto fps=rate?fps_.exchange(0):0;
  if(rate && inflight_.empty()) {
   std::string error;
   if(!hardware_->SetRates(rate,fps?fps:settings_.fps,error)){Error(error);break;}
   ++stats_->rate_updates;
   if(hardware_->TakeKeyframeRequest())keyframe_=true;
   settings_.bitrate=rate;if(fps)settings_.fps=fps;
   applied_bitrate_=rate;applied_fps_=settings_.fps;
   {std::lock_guard lock(stats_->mutex);auto actual=hardware_->ActualSettings();
    stats_->applied_bitrate=actual.bitrate;stats_->applied_fps=actual.fps;stats_->actual_level=actual.level_idc;}
  }
  // Fill the hardware queue before waiting for completion, preserving real
  // async_depth 2/4 behavior. A bounded host queue drops rather than growing.
  while(!free_.empty() && !bitrate_.load()) {
   Job job;
   {std::lock_guard lock(mutex_);if(queue_.empty()||stopping_)break;job=queue_.front();queue_.pop_front();}
   job.surface=free_.front();std::string error;
   if(!converter_.Convert(static_cast<ID3D11Texture2D*>(job.frame.d3d11_texture),surfaces_[job.surface].Get(),error)) {
    if(sdk_.encoder_drop)sdk_.encoder_drop(encoder_,job.frame.rtp_timestamp);
    ++stats_->dropped;
    if(!converter_.SafeToRelease()) {
      // An unconfirmed VP read cannot return a surface lease to the producer.
      // AtlasPool then retains its state until process/device teardown.
      auto* retained=new Job(job);(void)retained;
      surfaces_[job.surface]->AddRef();
      error+="; GPU leases retained until process exit";
    } else {
      job.frame.release(job.frame.release_context,job.frame.frame_id);
      static_cast<ID3D11Texture2D*>(job.frame.d3d11_texture)->Release();
    }
    Error(error);break;
   }
   job.submitted_qpc=QpcNow();const bool requested_key=keyframe_.exchange(false);
   const bool key=job.key||requested_key;
   auto status=hardware_->Submit(surfaces_[job.surface].Get(),key,job.cookie,error);
   if(status==CodecResult::busy) {
    if(key)keyframe_=true;
    bool replaced=false;
    {std::lock_guard lock(mutex_);
     if(queue_.empty())queue_.push_back(job);
     else {queue_.front().key=queue_.front().key||key;replaced=true;}}
    if(replaced) {
     if(sdk_.encoder_drop)sdk_.encoder_drop(encoder_,job.frame.rtp_timestamp);
     ++stats_->dropped;job.frame.release(job.frame.release_context,job.frame.frame_id);
     static_cast<ID3D11Texture2D*>(job.frame.d3d11_texture)->Release();
    }
    break;
   }
   if(status!=CodecResult::accepted) {
    if(sdk_.encoder_drop)sdk_.encoder_drop(encoder_,job.frame.rtp_timestamp);
    ++stats_->dropped;
    job.frame.release(job.frame.release_context,job.frame.frame_id);
    static_cast<ID3D11Texture2D*>(job.frame.d3d11_texture)->Release();Error(error);break;
   }
   free_.pop_front();inflight_.emplace(job.cookie,job);++stats_->submitted;if(key)++stats_->keyframes_submitted;
  }
  if(failed_)break;
  if(!inflight_.empty()) {
   AccessUnit unit;std::string error;auto status=hardware_->Poll(2,unit,error);
   if(status==CodecResult::ready)Complete(unit);
   else if(status==CodecResult::error){Error(error);break;}
  }
 }
 std::vector<AccessUnit> completed;std::string error;
 if(hardware_->Drain(completed,error))for(auto& unit:completed)Complete(unit);
 else if(!error.empty())Error(error);
 // Destroy is the hardware cancellation boundary before returning every held
 // lease, including error paths and queued jobs never submitted to hardware.
 hardware_.reset();
 for(auto& [cookie,job]:inflight_) {
  if(sdk_.encoder_drop)sdk_.encoder_drop(encoder_,job.frame.rtp_timestamp);
  ++stats_->dropped;
  job.frame.release(job.frame.release_context,job.frame.frame_id);
  static_cast<ID3D11Texture2D*>(job.frame.d3d11_texture)->Release();
 }
 inflight_.clear();
 std::lock_guard lock(mutex_);
 for(auto& job:queue_) {
  if(sdk_.encoder_drop)sdk_.encoder_drop(encoder_,job.frame.rtp_timestamp);
  ++stats_->dropped;
  job.frame.release(job.frame.release_context,job.frame.frame_id);
  static_cast<ID3D11Texture2D*>(job.frame.d3d11_texture)->Release();
 }
 queue_.clear();
}
void EncoderWorker::Stop() {
 {std::lock_guard lock(mutex_);stopping_=true;}
 wake_.notify_all();if(thread_.joinable())thread_.join();
 configured_=false;hardware_.reset();surfaces_.clear();free_.clear();
}
}
