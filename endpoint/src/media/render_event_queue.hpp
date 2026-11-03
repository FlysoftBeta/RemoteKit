#pragma once

#include <windows.h>

#include <deque>
#include <mutex>

#include "remotekit_sdk.h"

namespace remotekit::media {

class RenderEventQueue {
 public:
  ~RenderEventQueue() {
    if (event_) CloseHandle(event_);
  }

  HANDLE handle() const { return event_; }

  void Push(const remotekit_sdk_render_event& event) {
    std::lock_guard lock(mutex_);
    events_.push_back(event);
    SetEvent(event_);
  }

  std::deque<remotekit_sdk_render_event> Drain() {
    std::deque<remotekit_sdk_render_event> incoming;
    std::lock_guard lock(mutex_);
    incoming.swap(events_);
    if (event_) ResetEvent(event_);
    return incoming;
  }

 private:
  HANDLE event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  std::mutex mutex_;
  std::deque<remotekit_sdk_render_event> events_;
};

}  // namespace remotekit::media
