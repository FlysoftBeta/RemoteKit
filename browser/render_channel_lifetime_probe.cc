#include "remotekit/browser/render_channel.h"

#include <utility>

#include "base/at_exit.h"
#include "base/check.h"
#include "base/check_op.h"
#include "base/run_loop.h"
#include "base/task/single_thread_task_executor.h"
#include "base/test/bind.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "mojo/core/embedder/embedder.h"

namespace {
using remotekit::browser::RenderChannel;

void CheckOwnerDestruction() {
  int notified = 0;
  bool owner_alive = true;
  mojo::MessagePipe pipe;
  {
    RenderChannel channel(std::move(pipe.handle0), {}, {}, base::BindLambdaForTesting([&] {
                            CHECK(owner_alive);
                            ++notified;
                          }));
    // The owner's destructor body precedes the channel member destructor.
    owner_alive = false;
  }
  base::RunLoop().RunUntilIdle();
  CHECK_EQ(notified, 0);
}

void CheckExplicitClose() {
  int notified = 0;
  mojo::MessagePipe pipe;
  {
    RenderChannel channel(std::move(pipe.handle0), {}, {},
                          base::BindLambdaForTesting([&] { ++notified; }));
    channel.Close();
    channel.Close();
    CHECK_EQ(notified, 1);
  }
  base::RunLoop().RunUntilIdle();
  CHECK_EQ(notified, 1);
}

void CheckRemoteClose() {
  int notified = 0;
  mojo::MessagePipe pipe;
  base::RunLoop loop;
  {
    RenderChannel channel(std::move(pipe.handle0), {}, {}, base::BindLambdaForTesting([&] {
                            ++notified;
                            loop.Quit();
                          }));
    base::OneShotTimer timeout;
    timeout.Start(FROM_HERE, base::Seconds(2), loop.QuitClosure());
    pipe.handle1.reset();
    loop.Run();
    CHECK_EQ(notified, 1);
    channel.Close();
  }
  CHECK_EQ(notified, 1);
}
}  // namespace

int main() {
  base::AtExitManager at_exit;
  base::SingleThreadTaskExecutor task_executor(base::MessagePumpType::IO);
  mojo::core::Init();
  CheckOwnerDestruction();
  CheckExplicitClose();
  CheckRemoteClose();
  return 0;
}
