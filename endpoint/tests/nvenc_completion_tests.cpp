#include "media/nvenc_encoder.hpp"
#include "media/encoder_worker.hpp"
#include <cstdlib>
#include <iostream>

#define CHECK(x) do { if (!(x)) { std::cerr << __LINE__ << ": " #x "\n"; std::exit(1); } } while (false)
using namespace remotekit::media;
using namespace std::chrono_literals;
namespace {
// Only COM lifetime is exercised: none of these methods creates or uses a GPU.
struct TrackedTexture final : ID3D11Texture2D {
  ULONG refs = 1;
  unsigned releases = 0;
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, void**) override { return E_NOINTERFACE; }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
  ULONG STDMETHODCALLTYPE Release() override { ++releases; return --refs; }
  void STDMETHODCALLTYPE GetDevice(ID3D11Device** device) override { *device = nullptr; }
  HRESULT STDMETHODCALLTYPE GetPrivateData(REFGUID, UINT*, void*) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE SetPrivateData(REFGUID, UINT, const void*) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE SetPrivateDataInterface(REFGUID, const IUnknown*) override { return E_NOTIMPL; }
  void STDMETHODCALLTYPE GetType(D3D11_RESOURCE_DIMENSION* type) override { *type = D3D11_RESOURCE_DIMENSION_TEXTURE2D; }
  void STDMETHODCALLTYPE SetEvictionPriority(UINT) override {}
  UINT STDMETHODCALLTYPE GetEvictionPriority() override { return 0; }
  void STDMETHODCALLTYPE GetDesc(D3D11_TEXTURE2D_DESC* desc) override { *desc = {}; }
};
// Exercises the production Configure/Run path with only the hardware replaced.
struct RateState {
  std::mutex mutex;std::condition_variable changed;
  EncoderSettings configured;
  unsigned configurations=0;
  std::vector<std::pair<uint32_t,uint32_t>> rates;
  void Wait(size_t count) {
    std::unique_lock lock(mutex);
    CHECK(changed.wait_for(lock,2s,[&]{return rates.size()>=count;}));
  }
};
class RateBackend final : public HardwareEncoder {
  std::shared_ptr<RateState> state_;EncoderSettings settings_;
 public:
  explicit RateBackend(std::shared_ptr<RateState> state):state_(std::move(state)){}
  bool Configure(ID3D11Device*,const EncoderSettings& settings,std::string&) override {
    settings_=settings;
    std::lock_guard lock(state_->mutex);state_->configured=settings;++state_->configurations;return true;
  }
  EncoderInput InputFormat() const override {return EncoderInput::bgra;}
  const char* Name() const override {return "rate-mock";}
  EncoderSettings ActualSettings() const override {return settings_;}
  CodecResult Submit(ID3D11Texture2D*,bool,uint64_t,std::string&) override {return CodecResult::error;}
  CodecResult Poll(uint32_t,AccessUnit&,std::string&) override {return CodecResult::pending;}
  bool SetRates(uint32_t bitrate,uint32_t fps,std::string&,uint32_t maximum) override {
    CHECK(bitrate && fps);settings_.bitrate=bitrate;settings_.fps=fps;settings_.max_bitrate=maximum;
    {std::lock_guard lock(state_->mutex);state_->rates.emplace_back(bitrate,fps);}
    state_->changed.notify_all();return true;
  }
  bool Drain(std::vector<AccessUnit>&,std::string&) override {return true;}
};
struct Driver {
  std::chrono::steady_clock::time_point time{};
  HANDLE completion = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  HANDLE eos = nullptr;
  DWORD completion_wait = WAIT_TIMEOUT;
  bool eos_ready = true, lock_busy = false;
  NVENCSTATUS unlock_status = NV_ENC_SUCCESS;
  unsigned waits = 0, locks = 0, unmaps = 0, unlocks = 0, destroys = 0;
  unsigned unregisters = 0, buffers_destroyed = 0, eos_submits = 0;
  DWORD last_wait = 0;
  static Driver& Get(void* session) { return *static_cast<Driver*>(session); }
  static NVENCSTATUS NVENCAPI Lock(void* session, NV_ENC_LOCK_BITSTREAM* bits) {
    auto& self = Get(session); ++self.locks;
    if (self.lock_busy) return NV_ENC_ERR_LOCK_BUSY;
    static uint8_t payload[] = {0, 0, 1, 0x65};
    bits->bitstreamBufferPtr = payload; bits->bitstreamSizeInBytes = sizeof(payload);
    bits->pictureType = NV_ENC_PIC_TYPE_IDR; bits->frameAvgQP = 21;
    return NV_ENC_SUCCESS;
  }
  static NVENCSTATUS NVENCAPI Unlock(void* session, NV_ENC_OUTPUT_PTR) {
    auto& self = Get(session); ++self.unlocks; return self.unlock_status;
  }
  static NVENCSTATUS NVENCAPI Unmap(void* session, NV_ENC_INPUT_PTR) {
    ++Get(session).unmaps; return NV_ENC_SUCCESS;
  }
  static NVENCSTATUS NVENCAPI Encode(void* session, NV_ENC_PIC_PARAMS* picture) {
    CHECK(picture->encodePicFlags == NV_ENC_PIC_FLAG_EOS);
    auto& self = Get(session); ++self.eos_submits; self.eos = picture->completionEvent;
    CHECK(self.eos); return NV_ENC_SUCCESS;
  }
  static NVENCSTATUS NVENCAPI Unregister(void* session, NV_ENC_EVENT_PARAMS*) {
    ++Get(session).unregisters; return NV_ENC_SUCCESS;
  }
  static NVENCSTATUS NVENCAPI DestroyBuffer(void* session, NV_ENC_OUTPUT_PTR) {
    ++Get(session).buffers_destroyed; return NV_ENC_SUCCESS;
  }
  static NVENCSTATUS NVENCAPI Destroy(void* session) {
    ++Get(session).destroys; return NV_ENC_SUCCESS;
  }
  std::unique_ptr<HardwareEncoder> Make() {
    NV_ENCODE_API_FUNCTION_LIST api{};
    api.nvEncLockBitstream = Lock; api.nvEncUnlockBitstream = Unlock;
    api.nvEncUnmapInputResource = Unmap; api.nvEncEncodePicture = Encode;
    api.nvEncUnregisterAsyncEvent = Unregister; api.nvEncDestroyBitstreamBuffer = DestroyBuffer;
    api.nvEncDestroyEncoder = Destroy;
    NvencTestHooks hooks;
    hooks.now = [this] { return time; };
    hooks.wait = [this](HANDLE event, DWORD timeout) {
      ++waits; last_wait = timeout;
      const DWORD result = event == completion ? completion_wait : (eos_ready ? WAIT_OBJECT_0 : WAIT_TIMEOUT);
      if (result == WAIT_TIMEOUT) time += std::chrono::milliseconds(timeout);
      return result;
    };
    return CreateNvencEncoderForTest(api, this, completion,
        reinterpret_cast<NV_ENC_OUTPUT_PTR>(1), reinterpret_cast<NV_ENC_INPUT_PTR>(2), 73, std::move(hooks));
  }
};
void PendingThenComplete() {
  Driver driver; auto encoder = driver.Make(); AccessUnit unit; std::string error;
  CHECK(encoder->Poll(2, unit, error) == CodecResult::pending);
  CHECK(driver.locks == 0 && driver.unmaps == 0 && error.empty());
  driver.completion_wait = WAIT_OBJECT_0;
  CHECK(encoder->Poll(2, unit, error) == CodecResult::ready);
  CHECK(unit.frame_cookie == 73 && unit.bytes.size() == 4 && unit.keyframe && unit.qp == 21);
  CHECK(driver.unmaps == 1 && driver.unlocks == 1 && encoder->CanReleaseInputs());
  std::vector<AccessUnit> output;
  CHECK(encoder->Drain(output, error)); CHECK(encoder->Drain(output, error));
  CHECK(driver.eos_submits == 1 && output.empty());
  encoder.reset(); CHECK(driver.destroys == 1 && driver.buffers_destroyed == 1 && driver.unregisters == 2);
}
void DrainCompletesOutstanding() {
  Driver driver; driver.completion_wait = WAIT_OBJECT_0;
  auto encoder = driver.Make(); std::vector<AccessUnit> output; std::string error;
  CHECK(encoder->Drain(output, error));
  CHECK(output.size() == 1 && output[0].frame_cookie == 73 && driver.unmaps == 1);
  encoder.reset(); CHECK(driver.destroys == 1);
}
void TimeoutAndLateCompletion() {
  Driver driver; auto encoder = driver.Make(); AccessUnit unit; std::string error;
  driver.time += 4999ms;
  CHECK(encoder->Poll(10000, unit, error) == CodecResult::error);
  CHECK(driver.last_wait == 1 && driver.time.time_since_epoch() == 5s);
  CHECK(error.find("cookie 73") != std::string::npos && !encoder->CanReleaseInputs());
  auto fault = error; auto waits = driver.waits;
  driver.completion_wait = WAIT_OBJECT_0; driver.time += 1s;
  CHECK(encoder->Poll(0, unit, error) == CodecResult::error && error == fault);
  CHECK(encoder->Submit(nullptr, false, 74, error) == CodecResult::error && error == fault);
  CHECK(!encoder->SetRates(1000, 60, error) && error == fault);
  std::vector<AccessUnit> output;
  CHECK(!encoder->Drain(output, error)); CHECK(!encoder->Drain(output, error));
  CHECK(driver.waits == waits && driver.locks == 0 && driver.unmaps == 0 && driver.eos_submits == 0);
  auto owner = std::make_shared<int>(42); std::weak_ptr<int> weak = owner;
  encoder->HoldInputsUntilProcessExit(owner); owner.reset();
  auto before = GetNvencQuarantineInfo().sessions;
  encoder.reset();
  CHECK(!weak.expired() && driver.destroys == 0 && driver.buffers_destroyed == 0 && driver.unregisters == 0);
  CHECK(WaitForSingleObject(driver.completion, 0) == WAIT_TIMEOUT); // HANDLE retained too.
  auto info = GetNvencQuarantineInfo(); CHECK(info.unavailable && info.sessions == before + 1);
  // New production admission is refused before touching a driver/device.
  auto replacement = CreateNvencEncoder(); EncoderSettings settings;
  settings.width = settings.height = 16;
  CHECK(!replacement->Configure(reinterpret_cast<ID3D11Device*>(1), settings, error));
  CHECK(error.find("restart Endpoint") != std::string::npos);
}
void LockBusyHasSameDeadline() {
  Driver driver; driver.completion_wait = WAIT_OBJECT_0; driver.lock_busy = true;
  auto encoder = driver.Make(); AccessUnit unit; std::string error;
  CHECK(encoder->Poll(0, unit, error) == CodecResult::pending && driver.locks == 1);
  driver.time += 5s;
  CHECK(encoder->Poll(0, unit, error) == CodecResult::error);
  CHECK(driver.locks == 1 && driver.unmaps == 0);
  encoder.reset(); CHECK(driver.destroys == 0);
}
void WaitFailureIsSticky() {
  Driver driver; driver.completion_wait = WAIT_FAILED;
  auto encoder = driver.Make(); AccessUnit unit; std::string error;
  CHECK(encoder->Poll(2, unit, error) == CodecResult::error);
  CHECK(error.find("event wait failed") != std::string::npos);
  CHECK(!encoder->CanReleaseInputs());
  encoder.reset(); CHECK(driver.destroys == 0 && driver.unmaps == 0);
}
void DrainAndDestructorTimeout() {
  Driver driver; auto encoder = driver.Make(); std::vector<AccessUnit> output; std::string error;
  CHECK(!encoder->Drain(output, error));
  CHECK(driver.time.time_since_epoch() == 5s && output.empty());
  encoder.reset(); CHECK(driver.destroys == 0 && driver.unmaps == 0);
  Driver direct; auto close = direct.Make(); close.reset();
  CHECK(direct.time.time_since_epoch() == 5s && direct.destroys == 0 && direct.unmaps == 0);
}
void EosMustActuallyComplete() {
  Driver driver; driver.completion_wait = WAIT_OBJECT_0; driver.eos_ready = false;
  auto encoder = driver.Make(); std::vector<AccessUnit> output; std::string error;
  CHECK(!encoder->Drain(output, error));
  CHECK(output.size() == 1 && driver.unmaps == 1 && driver.time.time_since_epoch() == 5s);
  CHECK(error.find("EOS completion timed out") != std::string::npos);
  encoder.reset(); CHECK(driver.destroys == 0 && driver.unregisters == 0);
}
}  // namespace
namespace remotekit::media {
struct EncoderWorkerTestAccess {
  static void H264ConfigureAndGccRates() {
    Sdk sdk;auto stats=std::make_shared<EncoderStats>();auto state=std::make_shared<RateState>();
    EncoderWorker worker(sdk,1,nullptr,"nvenc",{},stats,{});
    worker.hardware_factory_=[state]{return std::make_unique<RateBackend>(state);};
    remotekit_rtc_encoder_config config{};config.struct_size=sizeof(config);
    config.width=4096;config.height=4096;config.h264_level_idc=51;config.fps=120;
    CHECK(!worker.Configure(config));CHECK(state->configurations==0);
    CHECK(stats->Snapshot()["error"]=="encoder dimensions/level have no legal H264 frame rate");
    config.width=1936;config.height=1088;config.h264_level_idc=42;
    CHECK(worker.Configure(config));
    CHECK(state->configurations==1 && state->configured.fps==63);
    CHECK(stats->Snapshot()["appliedFps"]==63);
    worker.Rates(1234567,120);state->Wait(1);
    CHECK(stats->Snapshot()["gccTargetFps"]==120);
    worker.Rates(1234567,60);state->Wait(2);
    worker.keyframe_=false;
    worker.Rates(0,120);CHECK(worker.paused_);
    worker.Rates(1234567,120);CHECK(worker.keyframe_);state->Wait(3);
    worker.Stop();
    std::lock_guard lock(state->mutex);
    CHECK(state->rates.size()==3);
    CHECK(state->rates[0].first==1234567 && state->rates[0].second==63);
    CHECK(state->rates[1].first==1234567 && state->rates[1].second==60);
    CHECK(state->rates[2].first==1234567 && state->rates[2].second==63);
  }
  static void FifoAndGccRates() {
    Sdk sdk;auto stats=std::make_shared<EncoderStats>();
    EncoderWorker worker(sdk,1,nullptr,"nvenc",{},stats,{});
    worker.configured_=true;
    TrackedTexture texture;int leases=0;
    remotekit_rtc_frame frame{};frame.d3d11_texture=&texture;frame.release_context=&leases;
    frame.retain=[](void* context,uint64_t){++*static_cast<int*>(context);};
    frame.release=[](void* context,uint64_t){--*static_cast<int*>(context);};
    for(uint64_t id=1;id<=4;++id){frame.frame_id=id;CHECK(worker.Enqueue(frame,id==2));}
    frame.frame_id=5;CHECK(!worker.Enqueue(frame,false));
    CHECK(worker.queue_.size()==4 && stats->queue_full_drops==1 && stats->dropped==1);
    CHECK(leases==4 && texture.refs==5);
    uint64_t id=1;for(const auto& job:worker.queue_)CHECK(job.frame.frame_id==id++);
    CHECK(worker.queue_[1].key && !worker.queue_[0].key);
    worker.keyframe_=false;
    worker.Rates(0,60);CHECK(worker.paused_ && worker.pending_rates_->bitrate==0);
    CHECK(!worker.Enqueue(frame,false) && stats->paused_drops==1);
    worker.Rates(1234567,27);
    CHECK(!worker.paused_ && worker.keyframe_);
    CHECK(worker.pending_rates_->bitrate==1234567 && worker.pending_rates_->fps==27);
    auto snapshot=stats->Snapshot();
    CHECK(snapshot["gccTargetBitrate"]==1234567 && snapshot["gccTargetFps"]==27);
    // Retire through production Run's never-submitted cleanup, without a GPU.
    worker.stopping_=true;worker.Run();worker.Stop();
    CHECK(leases==0 && texture.refs==1 && stats->pending==0);
  }
  static void Retire(EncoderWorker& worker, std::unique_ptr<HardwareEncoder> encoder, int& releases) {
    worker.hardware_ = std::move(encoder);
    auto* first = new TrackedTexture;
    EncoderWorker::Job job;
    job.frame.release_context = &releases;
    job.frame.release = [](void* context, uint64_t) { ++*static_cast<int*>(context); };
    job.frame.d3d11_texture = first;
    // Submit-error retirement includes the current job outside inflight_. A
    // subsequent empty retirement must not replace this first source owner.
    CHECK(worker.RetainUnsafeInputs(&job));
    CHECK(worker.RetainUnsafeInputs());
    CHECK(first->refs == 1 && first->releases == 0 && releases == 0);
    auto* second = new TrackedTexture;
    job.frame.d3d11_texture = second;
    worker.inflight_.emplace(74, job); worker.stats_->inflight = 1;
    CHECK(worker.RetainUnsafeInputs());
    CHECK(worker.RetainUnsafeInputs());
    CHECK(worker.inflight_.empty() && worker.stats_->inflight == 0);
    CHECK(worker.stats_->error_drops == 1 && worker.stats_->dropped == 1);
    CHECK(first->refs == 1 && first->releases == 0);
    CHECK(second->refs == 1 && second->releases == 0 && releases == 0);
    worker.hardware_.reset();
    CHECK(!worker.RetainUnsafeInputs());
    worker.Stop(); worker.Stop();
    CHECK(first->refs == 1 && first->releases == 0);
    CHECK(second->refs == 1 && second->releases == 0 && releases == 0);
  }
};
}
int main() {
  PendingThenComplete(); DrainCompletesOutstanding(); TimeoutAndLateCompletion();
  LockBusyHasSameDeadline(); WaitFailureIsSticky(); DrainAndDestructorTimeout(); EosMustActuallyComplete();
  // Exercise the production Worker ownership transfer, not a mirror of it.
  Driver driver; auto encoder = driver.Make(); AccessUnit output; std::string error;
  driver.time += 5s; CHECK(encoder->Poll(0, output, error) == CodecResult::error);
  int releases = 0; Sdk sdk; auto stats = std::make_shared<EncoderStats>();
  EncoderWorker worker(sdk, 1, nullptr, "nvenc", {}, stats, {});
  EncoderWorkerTestAccess::Retire(worker, std::move(encoder), releases);
  EncoderWorkerTestAccess::FifoAndGccRates();
  EncoderWorkerTestAccess::H264ConfigureAndGccRates();
  worker.Stop(); worker.Stop();
  CHECK(releases == 0 && driver.destroys == 0);
  std::cout << "NVENC production Poll/Drain/Worker retirement CPU tests passed (no GPU)\n";
}
