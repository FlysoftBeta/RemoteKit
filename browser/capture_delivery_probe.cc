// Exercises the production host and delivery receivers without a GPU.
#include <iostream>
#include <memory>
#include <vector>

#include "base/at_exit.h"
#include "base/check.h"
#include "base/check_op.h"
#include "base/command_line.h"
#include "base/functional/bind.h"
#include "base/memory/read_only_shared_memory_region.h"
#include "base/run_loop.h"
#include "base/task/single_thread_task_executor.h"
#include "components/viz/host/client_frame_sink_video_capturer.h"
#include "components/viz/service/frame_sinks/video_capture/in_flight_frame_delivery.h"
#include "media/base/capture_version.h"
#include "media/capture/mojom/video_capture_buffer.mojom.h"
#include "mojo/core/embedder/embedder.h"
#include "mojo/public/cpp/bindings/self_owned_receiver.h"

namespace {
class Capturer final : public viz::mojom::FrameSinkVideoCapturer {
 public:
  void Bind(mojo::PendingReceiver<viz::mojom::FrameSinkVideoCapturer> receiver) {
    receiver_.Bind(std::move(receiver));
    receiver_.set_disconnect_handler(base::BindOnce(
        [](Capturer* self) { self->Stop(); }, base::Unretained(this)));
  }
  void SetFormat(media::VideoPixelFormat) override {}
  void ConfigureCaptureToAtlas(uint64_t, const gfx::Size&, const gfx::Rect&,
      std::vector<gfx::GpuMemoryBufferHandle>,
      ConfigureCaptureToAtlasCallback callback) override {
    std::move(callback).Run(true, "");
  }
  void SetMinCapturePeriod(base::TimeDelta) override {}
  void SetMinSizeChangePeriod(base::TimeDelta) override {}
  void SetResolutionConstraints(const gfx::Size&, const gfx::Size&, bool) override {}
  void SetAutoThrottlingEnabled(bool) override {}
  void SetAnimationFpsLockIn(bool, float) override {}
  void SetIsSecure(bool) override {}
  void ChangeTarget(const std::optional<viz::VideoCaptureTarget>&, uint32_t) override {}
  void Start(mojo::PendingRemote<viz::mojom::FrameSinkVideoConsumer> consumer,
             viz::mojom::BufferFormatPreference) override {
    consumer_.Bind(std::move(consumer));
  }
  void Stop() override {
    if (consumer_) {
      consumer_->OnStopped();
      consumer_.reset();
    }
  }
  void RequestRefreshFrame() override {}
  void InvalidateBuffers() override {}
  void CreateOverlay(int32_t,
      mojo::PendingReceiver<viz::mojom::FrameSinkVideoCaptureOverlay>) override {}

  void QueueFrame(int& done, int& unexpected) {
    mojo::PendingRemote<viz::mojom::FrameSinkVideoConsumerFrameCallbacks> callback;
    mojo::MakeSelfOwnedReceiver(
        std::make_unique<viz::InFlightFrameDelivery>(
            base::BindOnce([](int* count) { ++*count; }, &done),
            base::OnceCallback<void(const media::VideoCaptureFeedback&)>(),
            base::BindOnce([](int* count) { ++*count; }, &unexpected)),
        callback.InitWithNewPipeAndPassReceiver());
    auto region = base::ReadOnlySharedMemoryRegion::Create(16);
    CHECK(region.IsValid());
    auto info = media::mojom::VideoFrameInfo::New();
    info->pixel_format = media::PIXEL_FORMAT_ARGB;
    info->coded_size = gfx::Size(2, 2);
    info->visible_rect = gfx::Rect(2, 2);
    info->natural_size = gfx::Size(2, 2);
    consumer_->OnFrameCaptured(
        media::mojom::VideoBufferHandle::NewReadOnlyShmemRegion(
            std::move(region.region)),
        std::move(info), gfx::Rect(2, 2), std::move(callback));
    consumer_->OnFrameWithEmptyRegionCapture();
    consumer_->OnNewCaptureVersion(media::CaptureVersion());
    consumer_->OnLog("queued notification");
  }
  void FlushDelivery() { consumer_.FlushForTesting(); }
  bool connected() const { return consumer_.is_bound(); }

 private:
  mojo::Receiver<viz::mojom::FrameSinkVideoCapturer> receiver_{this};
  mojo::Remote<viz::mojom::FrameSinkVideoConsumer> consumer_;
};

class Consumer final : public viz::mojom::FrameSinkVideoConsumer {
 public:
  void OnFrameCaptured(media::mojom::VideoBufferHandlePtr,
      media::mojom::VideoFrameInfoPtr, const gfx::Rect&,
      mojo::PendingRemote<viz::mojom::FrameSinkVideoConsumerFrameCallbacks>
          callbacks) override {
    ++forwarded;
    frames.emplace_back(std::move(callbacks));
  }
  void OnNewCaptureVersion(const media::CaptureVersion&) override { ++notifications; }
  void OnFrameWithEmptyRegionCapture() override { ++notifications; }
  void OnStopped() override { ++notifications; }
  void OnLog(const std::string&) override { ++notifications; }
  int forwarded = 0;
  int notifications = 0;
  std::vector<mojo::Remote<viz::mojom::FrameSinkVideoConsumerFrameCallbacks>> frames;
};

std::unique_ptr<viz::ClientFrameSinkVideoCapturer> Start(
    Capturer& producer, Consumer& consumer) {
  auto client = std::make_unique<viz::ClientFrameSinkVideoCapturer>(
      base::BindRepeating(&Capturer::Bind, base::Unretained(&producer)));
  client->ConfigureCaptureToAtlas(1, gfx::Size(2, 2), gfx::Rect(2, 2), {},
      base::BindOnce([](bool ok, const std::string&) { CHECK(ok); }),
      base::BindOnce([](bool, const std::string&) { CHECK(false); }));
  client->Start(&consumer, viz::mojom::BufferFormatPreference::kPreferMappableSharedImage);
  base::RunLoop().RunUntilIdle();
  CHECK(producer.connected());
  return client;
}

void QueuedDelivery(bool explicit_stop) {
  Capturer producer;
  Consumer consumer;
  int done = 0, unexpected = 0;
  auto client = Start(producer, consumer);
  producer.QueueFrame(done, unexpected);
  if (explicit_stop) {
    client->StopAndResetConsumer();
    client->StopAndResetConsumer();
  }
  client.reset();
  base::RunLoop().RunUntilIdle();
  CHECK_EQ(done, 1);
  CHECK_EQ(unexpected, 0);
  CHECK_EQ(consumer.forwarded, 0);
  CHECK_EQ(consumer.notifications, 0);
  CHECK(!producer.connected());
}

void ForwardedDelivery(bool explicit_done) {
  Capturer producer;
  Consumer consumer;
  int done = 0, unexpected = 0;
  auto client = Start(producer, consumer);
  producer.QueueFrame(done, unexpected);
  producer.FlushDelivery();
  CHECK_EQ(consumer.forwarded, 1);
  client->StopAndResetConsumer();
  client.reset();
  base::RunLoop().RunUntilIdle();
  CHECK_EQ(done, 0);  // Retirement cannot settle an already published read.
  CHECK_EQ(unexpected, 0);
  if (explicit_done) {
    consumer.frames[0]->Done();
  }
  consumer.frames.clear();
  base::RunLoop().RunUntilIdle();
  CHECK_EQ(done, 1);
  CHECK_EQ(unexpected, explicit_done ? 0 : 1);
}

void NormalStop() {
  Capturer producer;
  Consumer consumer;
  auto client = Start(producer, consumer);
  client->Stop();
  base::RunLoop().RunUntilIdle();
  CHECK_EQ(consumer.notifications, 1);  // Normal Stop still forwards OnStopped.
  CHECK_EQ(consumer.forwarded, 0);
  CHECK(!producer.connected());
  client.reset();
  base::RunLoop().RunUntilIdle();
}
}  // namespace

int main(int argc, char** argv) {
  base::AtExitManager at_exit;
  base::CommandLine::Init(argc, argv);
  base::SingleThreadTaskExecutor tasks;
  mojo::core::Init();
  QueuedDelivery(true);
  QueuedDelivery(false);
  ForwardedDelivery(true);
  ForwardedDelivery(false);
  NormalStop();
  std::cout << "capture delivery retirement: 5 CPU cases passed\n";
}
