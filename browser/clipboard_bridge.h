#pragma once

#include <cstdint>

#include "base/functional/callback.h"
#include "base/values.h"
#include "ui/base/clipboard/clipboard_observer.h"

namespace remotekit::browser {
class ClipboardBridge final : public ui::ClipboardObserver {
 public:
  explicit ClipboardBridge(base::RepeatingCallback<void(uint64_t)> changed);
  ~ClipboardBridge() override;
  base::DictValue Read(int id) const;
  base::DictValue Write(int id, const base::DictValue& request);
  void OnClipboardDataChanged() override;
  uint64_t sequence() const { return sequence_; }

 private:
  const base::RepeatingCallback<void(uint64_t)> changed_;
  uint64_t sequence_ = 0;
  bool applying_ = false;
};
}  // namespace remotekit::browser
