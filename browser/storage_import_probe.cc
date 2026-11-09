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
    StorageImportData data;
    const auto first = jobs.Begin(nullptr, "record:0", data, 1);
    CHECK(first);
    CHECK(jobs.Begin(nullptr, "record:0", data, 1).value == first.value);
    CHECK(!jobs.Begin(nullptr, "other:0", data, 1));
    data.fingerprint[0] = 1;
    CHECK(!jobs.Begin(nullptr, "record:0", data, 1));
    data.fingerprint[0] = 0;
    jobs.OnFlushed("record:0");
    const auto poll = jobs.Poll("record:0");
    CHECK(poll && *poll.value.FindString("state") == "done");
    CHECK(jobs.Poll("record:0").value == poll.value);
    CHECK(jobs.Begin(nullptr, "record:0", data, 1).value == poll.value);
    for (int i = 1; i <= 64; ++i) {
      const auto id = "record:" + std::to_string(i);
      CHECK(jobs.Begin(nullptr, id, data, 1));
      jobs.OnFlushed(id);
    }
    CHECK(!jobs.Poll("record:0"));
    CHECK(jobs.Poll("record:1"));
    CHECK(jobs.Poll("record:64"));
    CHECK(!jobs.Begin(nullptr, "", data));
    CHECK(!jobs.Begin(nullptr, std::string(129, 'a'), data));
    jobs.Cancel("record:64");
    CHECK(!jobs.Poll("record:64"));
    jobs.Clear();
    CHECK(!jobs.Poll("record:1"));
  }
};
}  // namespace remotekit::browser
int main(int argc, char** argv) {
  base::AtExitManager at_exit;
  base::CommandLine::Init(argc, argv);
  TestTimeouts::Initialize();
  remotekit::browser::StorageImportJobsProbe::Run();
}
