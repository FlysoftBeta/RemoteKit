#pragma once

#include <cstdint>
#include <string>

#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/values.h"
#include "ui/base/clipboard/clipboard_observer.h"

namespace content {
class ClipboardEndpoint;
}

namespace remotekit::browser {
class ViewRegistry;
class ClipboardBridge final : public ui::ClipboardObserver {
 public:
  ClipboardBridge(const ViewRegistry& views, base::RepeatingCallback<void(uint64_t)> changed);
  ~ClipboardBridge() override;
  base::DictValue Read(int id) const;
  base::DictValue Write(int id, const base::DictValue& request);
  void OnClipboardDataChanged() override;
  uint64_t sequence() const { return sequence_; }

 private:
  void SourceChanged(uint64_t sequence, content::ClipboardEndpoint source);
  const ViewRegistry& views_;
  std::string view_id_;
  const base::RepeatingCallback<void(uint64_t)> changed_;
  uint64_t sequence_ = 0;
  bool applying_ = false;
  base::WeakPtrFactory<ClipboardBridge> weak_{this};
};
}  // namespace remotekit::browser
