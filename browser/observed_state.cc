#include "browser/observed_state.h"

#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/task/single_thread_task_runner.h"

namespace remotekit::browser {
namespace {
struct Data {
  ObservedState::Notifier notifier;
  std::uint64_t revision = 0;
  bool pending = false;
};
Data& State() {
  static base::NoDestructor<Data> data;
  return *data;
}
void Flush() {
  auto& state = State();
  if (!state.pending)
    return;
  state.pending = false;
  if (state.notifier)
    state.notifier.Run(state.revision);
}
}  // namespace

void ObservedState::SetNotifier(Notifier notifier) {
  State().notifier = std::move(notifier);
  State().pending = false;
}

void ObservedState::Changed() {
  auto& state = State();
  ++state.revision;
  if (state.pending || !state.notifier)
    return;
  state.pending = true;
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(FROM_HERE,
                                                              base::BindOnce([] { Flush(); }));
}

std::uint64_t ObservedState::revision() {
  return State().revision;
}

}  // namespace remotekit::browser
