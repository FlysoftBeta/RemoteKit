#include "browser/clipboard_bridge.h"

#include "base/auto_reset.h"
#include "base/functional/bind.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "browser/control_clipboard.h"
#include "browser/control_response.h"
#include "browser/view_registry.h"
#include "content/public/browser/clipboard_types.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/browser_thread.h"
#include "ui/base/clipboard/clipboard_data.h"
#include "ui/base/clipboard/clipboard_monitor.h"
#include "ui/base/clipboard/clipboard_non_backed.h"
#include "ui/base/clipboard/scoped_clipboard_writer.h"

namespace remotekit::browser {
ClipboardBridge::ClipboardBridge(const ViewRegistry& views,
                                 base::RepeatingCallback<void(uint64_t)> changed)
    : views_(views), changed_(std::move(changed)) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  ui::ClipboardMonitor::GetInstance()->AddObserver(this);
}
ClipboardBridge::~ClipboardBridge() {
  ui::ClipboardMonitor::GetInstance()->RemoveObserver(this);
}
void ClipboardBridge::OnClipboardDataChanged() {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  if (applying_)
    return;
  base_revision_ = applied_revision_;
  view_id_.clear();
  ++sequence_;
  content::GetSourceClipboardEndpoint(
      nullptr, ui::ClipboardBuffer::kCopyPaste,
      base::BindOnce(&ClipboardBridge::SourceChanged, weak_.GetWeakPtr(), sequence_));
}
void ClipboardBridge::SourceChanged(uint64_t sequence, content::ClipboardEndpoint source) {
  if (sequence != sequence_)
    return;
  if (auto* contents = source.web_contents()) {
    for (const auto& [view_id, record] : views_.records) {
      if (record.webview->contents() == contents) {
        view_id_ = base::NumberToString(view_id);
        break;
      }
    }
  }
  changed_.Run(sequence_);
}
base::DictValue ClipboardBridge::Read(int id) const {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  const auto* data = ui::ClipboardNonBacked::GetForCurrentThread()->GetClipboardData(nullptr);
  return ControlResult::Success(
      id, base::DictValue()
              .Set("sequence", base::NumberToString(sequence_))
              .Set("baseRevision", base_revision_)
              .Set("viewId", view_id_)
              .Set("excludeFromHistory",
                   ui::Clipboard::GetForCurrentThread()->IsMarkedByOriginatorAsConfidential())
              .Set("text", data ? data->text() : "")
              .Set("html", data ? data->markup_data() : ""));
}
base::DictValue ClipboardBridge::Write(int id, const base::DictValue& request) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  if (!ValidClipboardWrite(request))
    return ControlResult::Failure(id, protocol::ErrorCode::kInvalidRequest,
                                  "Invalid clipboard value");
  base::AutoReset<bool> applying(&applying_, true);
  weak_.InvalidateWeakPtrs();
  applied_revision_ = *request.FindString("revision");
  base_revision_ = applied_revision_;
  view_id_.clear();
  {
    ui::ScopedClipboardWriter writer(ui::ClipboardBuffer::kCopyPaste);
    writer.WriteText(base::UTF8ToUTF16(*request.FindString("text")));
    writer.WriteHTML(base::UTF8ToUTF16(*request.FindString("html")), "");
  }
  return ControlResult::Success(id, base::DictValue()
                                        .Set("sequence", base::NumberToString(sequence_))
                                        .Set("baseRevision", base_revision_));
}
}  // namespace remotekit::browser
