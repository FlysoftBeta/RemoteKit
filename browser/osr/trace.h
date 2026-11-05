#pragma once

#include <utility>
#include <vector>
#include "remotekit/browser/view_model.h"
#include "remotekit/protocol/render_slots.h"
#include "base/environment.h"
#include "base/files/file_util.h"
#include "base/json/json_writer.h"
#include "base/process/process_handle.h"
#include "base/task/thread_pool.h"
#include "base/strings/string_number_conversions.h"
#include "base/functional/bind.h"
#include "base/logging.h"
#include <windows.h>
namespace remotekit::browser::osr {
inline std::string Number(uint64_t value) {
  return base::NumberToString(value);
}
// The writer owns only diagnostic samples, never generation state or GPU resources.
class OsrTrace {
 public:
  explicit OsrTrace(uint64_t generation) : generation_(generation) {
    auto path = base::Environment::Create()->GetVar("REMOTEKIT_MEDIA_TRACE");
    if (!path || path->empty())
      return;
    LARGE_INTEGER frequency{};
    if (!QueryPerformanceFrequency(&frequency))
      return;
    frequency_ = frequency.QuadPart;
    directory_ = base::FilePath::FromUTF8Unsafe(*path);
    events_.reserve(kCapacity);
  }

  void Add(const char* stage,
           const RenderIdentity& id,
           uint64_t view = 0,
           int detail = 0,
           const InputEvent* input = nullptr) {
    if (directory_.empty())
      return;
    LARGE_INTEGER now{};
    QueryPerformanceCounter(&now);
    Event event{stage, now.QuadPart, id.value, id.slot, view, detail};
    if (input) {
      event.browser_sequence = input->sequence;
      event.token = input->token;
    }
    if (written_ < kCapacity) {
      events_.push_back(event);
    } else {
      events_[written_ % kCapacity] = event;
    }
    ++written_;
  }

  void Save() {
    if (directory_.empty() || !written_)
      return;
    base::ThreadPool::PostTask(
        FROM_HERE, {base::MayBlock(), base::TaskShutdownBehavior::BLOCK_SHUTDOWN},
        base::BindOnce(&Write, std::exchange(directory_, base::FilePath()), std::move(events_),
                       written_, generation_, frequency_));
  }

 private:
  static constexpr size_t kCapacity = 32768;
  struct Event {
    const char* stage;
    int64_t qpc;
    uint64_t value;
    uint32_t slot;
    uint64_t view;
    int detail;
    uint64_t browser_sequence = 0;
    InputToken token{};
  };

  static void Write(base::FilePath directory,
                    std::vector<Event> events,
                    uint64_t written,
                    uint64_t generation,
                    int64_t frequency) {
    const auto pid = base::GetCurrentProcId();
    base::ListValue rows;
    for (uint64_t index = written - events.size(); index < written; ++index) {
      const auto& event = events[index % kCapacity];
      auto row = base::DictValue()
                     .Set("stage", event.stage)
                     .Set("qpc", base::NumberToString(event.qpc))
                     .Set("fence", Number(event.value))
                     .Set("slot", static_cast<int>(event.slot))
                     .Set("view", Number(event.view))
                     .Set("detail", event.detail);
      if (event.browser_sequence) {
        row.Set("browser_sequence", Number(event.browser_sequence));
        row.Set("view", Number(event.token.view));
        row.Set("instance", Number(event.token.instance));
        row.Set("document", Number(event.token.document));
        row.Set("focus", Number(event.token.focus));
      }
      rows.Append(std::move(row));
    }
    auto document = base::DictValue()
                        .Set("schema", "remotekit-osr-trace-v1")
                        .Set("pid", static_cast<int>(pid))
                        .Set("generation", Number(generation))
                        .Set("qpc_frequency", base::NumberToString(frequency))
                        .Set("records_overwritten", Number(written - events.size()))
                        .Set("events", std::move(rows));
    auto bytes = base::WriteJson(document);
    if (!bytes || !base::CreateDirectory(directory) ||
        !base::WriteFile(
            directory.AppendASCII("osr-" + Number(pid) + "-" + Number(generation) + ".json"),
            *bytes)) {
      LOG(ERROR) << "Cannot save RemoteKit OSR trace";
    }
  }

  const uint64_t generation_;
  base::FilePath directory_;
  int64_t frequency_ = 0;
  uint64_t written_ = 0;
  std::vector<Event> events_;
};

}  // namespace remotekit::browser::osr
