#include "browser/storage_import.h"
#include "base/check.h"
#include "base/at_exit.h"
#include "base/command_line.h"
#include "base/test/test_timeouts.h"
#include "base/test/task_environment.h"
namespace remotekit::browser {
class StorageImportJobsProbe {
 public:
  static void Run() {
    base::test::SingleThreadTaskEnvironment environment;
    StorageImportJobs jobs;
    const auto first = jobs.Begin(nullptr, {}, 1);
    CHECK(first);
    CHECK(!jobs.Begin(nullptr, {}, 1));
    jobs.OnFlushed(first.value);
    const auto poll = jobs.Poll(first.value);
    CHECK(poll && *poll.value.FindString("state") == "done");
    CHECK(jobs.Poll(first.value).value == poll.value);
    CHECK(jobs.Latest(1).value == poll.value);
    const auto other = jobs.Begin(nullptr, {}, 2);
    CHECK(other && jobs.Poll(first.value));
    const auto replacement = jobs.Begin(nullptr, {}, 1);
    CHECK(replacement && !jobs.Poll(first.value));
    jobs.Cancel(replacement.value);
    CHECK(!jobs.Poll(replacement.value));
    jobs.Clear();
    CHECK(!jobs.Poll(other.value));
  }
};
}  // namespace remotekit::browser
int main(int argc, char** argv) {
  base::AtExitManager at_exit;
  base::CommandLine::Init(argc, argv);
  TestTimeouts::Initialize();
  remotekit::browser::StorageImportJobsProbe::Run();
}
