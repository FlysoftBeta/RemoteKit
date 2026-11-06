#include "browser/browser_runtime.h"

#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/task/single_thread_task_runner.h"
#include "content/browser/dom_storage/dom_storage_context_wrapper.h"  // nogncheck
#include "content/public/browser/browser_main_runner.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/storage_partition.h"
#include "mojo/public/cpp/bindings/callback_helpers.h"
#include "protocol/control.h"
#include "services/network/public/mojom/cookie_manager.mojom.h"

namespace remotekit::browser {

void BrowserRuntime::VerifyShutdownComplete() {
  if (shutdown_finished_)
    return;
  LOG(ERROR) << "Browser shutdown failed step main loop: exited before storage flush completed";
  content::BrowserMainRunner::SetOverrideResultCode(protocol::kBrowserShutdownFailureExitCode);
}

void BrowserRuntime::BeginShutdown() {
  if (shutting_down)
    return;
  shutting_down = true;
  // Dispatch must write the acceptance reply before pages or services go away.
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&BrowserRuntime::RunShutdown, weak_factory_.GetWeakPtr()));
}

void BrowserRuntime::RunShutdown() {
  output_timer.Stop();
  DrainClosed();
  output.reset();
  for (auto& [id, record] : views.records)
    record.webview->SetSessionStorageShouldPersist(true);
  for (auto& [id, popup] : popups.pending) {
    if (!popup.contents)
      continue;
    for (const auto& [config, handle] :
         popup.contents->GetController().GetSessionStorageNamespaceMap())
      handle->SetShouldPersist(true);
  }
  // Direct destruction bypasses beforeunload, including for frozen pages.
  views.Clear();
  popups.Clear();
  navigation_transfers.records.clear();

  std::vector<std::pair<content::StoragePartition*, std::string>> partitions;
  for (const auto& context : contexts) {
    context->PrepareForShutdown();
    context->ForEachLoadedStoragePartition([&](content::StoragePartition* partition) {
      partitions.emplace_back(partition, std::to_string(partitions.size()) + ": " +
                                             partition->GetPath().AsUTF8Unsafe());
    });
  }
  for (const auto& [partition, path] : partitions) {
    shutdown_flushes_.insert("cookies: " + path);
    shutdown_flushes_.insert("localStorage: " + path);
    shutdown_flushes_.insert("sessionStorage: " + path);
  }
  if (shutdown_flushes_.empty()) {
    FinishShutdown();
    return;
  }
  shutdown_timer_.Start(
      FROM_HERE, base::Seconds(10),
      base::BindOnce(&BrowserRuntime::OnShutdownTimeout, weak_factory_.GetWeakPtr()));
  for (const auto& [partition, path] : partitions) {
    auto completion = [&](const char* storage) {
      const auto step = std::string(storage) + ": " + path;
      return mojo::WrapCallbackWithDropHandler(
          base::BindOnce(&BrowserRuntime::OnShutdownFlushed, weak_factory_.GetWeakPtr(), step,
                         true),
          base::BindOnce(&BrowserRuntime::OnShutdownFlushed, weak_factory_.GetWeakPtr(), step,
                         false));
    };
    partition->GetCookieManagerForBrowserProcess()->FlushCookieStore(completion("cookies"));
    partition->Flush();
    // Flush is one-way. Cleanup commits pending data and replies after the
    // database sequence has processed it, on the same storage control pipe.
    auto* storage =
        static_cast<content::DOMStorageContextWrapper*>(partition->GetDOMStorageContext());
    storage->PerformLocalStorageCleanup(completion("localStorage"));
    storage->PerformSessionStorageCleanup(completion("sessionStorage"));
  }
}

void BrowserRuntime::OnShutdownFlushed(const std::string& step, bool succeeded) {
  if (shutdown_finished_)
    return;
  if (!succeeded) {
    shutdown_failed_ = true;
    LOG(ERROR) << "Browser shutdown failed step " << step << ": disconnected";
  }
  shutdown_flushes_.erase(step);
  if (shutdown_flushes_.empty())
    FinishShutdown();
}

void BrowserRuntime::OnShutdownTimeout() {
  shutdown_failed_ = true;
  for (const auto& step : shutdown_flushes_)
    LOG(ERROR) << "Browser shutdown failed step " << step << ": timed out after 10 seconds";
  FinishShutdown();
}

void BrowserRuntime::FinishShutdown() {
  shutdown_finished_ = true;
  shutdown_timer_.Stop();
  if (shutdown_failed_)
    content::BrowserMainRunner::SetOverrideResultCode(protocol::kBrowserShutdownFailureExitCode);
  CHECK(quit);
  quit.Run();
}

}  // namespace remotekit::browser
