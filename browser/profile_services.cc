#include "browser/control_response.h"
#include "browser/profile_services.h"
#include "browser/browser_context.h"
#include "browser/page_requests.h"
#include "base/strings/utf_string_conversions.h"
#include "net/base/filename_util.h"
#include "content/public/browser/device_service.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "services/device/public/mojom/geolocation_control.mojom.h"
#include "services/network/public/cpp/is_potentially_trustworthy.h"

#include <algorithm>
#include <limits>
#include <optional>
#include <string_view>
#include <utility>
#include <vector>

#include "base/files/file.h"
#include "base/feature_list.h"
#include "base/files/file_util.h"
#include "base/logging.h"
#include "base/functional/bind.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/task/single_thread_task_runner.h"
#include "base/task/thread_pool.h"
#include "build/build_config.h"
#include "components/services/quarantine/quarantine_impl.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/child_process_security_policy.h"
#include "content/public/browser/permission_request_description.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/permission_status_subscription.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_process_host.h"
#include "content/public/browser/web_contents.h"
#include "mojo/public/cpp/bindings/self_owned_receiver.h"
#include "third_party/blink/public/common/features.h"
#include "third_party/blink/public/mojom/permissions/permission.mojom.h"
#include "url/origin.h"

namespace remotekit::browser {
namespace {
using Type = blink::PermissionType;
using Status = content::PermissionStatus;
using Result = content::PermissionResult;
constexpr std::size_t kStringLimit = 16 * 1024;

base::DictValue Response() {
  return ControlResult::Success(0);
}
base::DictValue Response(protocol::ErrorCode code, const std::string& message) {
  return ControlResult::Failure(0, code, message);
}
std::string Clip(std::string_view value) {
  return std::string(base::TruncateUTF8ToByteSize(value, kStringLimit));
}
bool Eligible(const url::Origin& origin) {
  return !origin.opaque() && origin.GetURL().SchemeIsHTTPOrHTTPS();
}
std::string TypeName(Type type) {
  switch (type) {
    case Type::GEOLOCATION:
      return "geolocation";
    case Type::CLIPBOARD_READ_WRITE:
      return "clipboard_read";
    case Type::LOCAL_FONTS:
      return "local_fonts";
    case Type::WINDOW_MANAGEMENT:
      return "window_management";
    case Type::MIDI_SYSEX:
      return "midi_sysex";
    case Type::IDLE_DETECTION:
      return "idle_detection";
    default:
      return {};
  }
}
Result PermissionResult(Type type, Status status) {
  Result result(status);
  if (type == Type::GEOLOCATION && status == Status::GRANTED)
    result.retrieved_permission_setting = GeolocationSetting{
        .approximate = PermissionOption::kAllowed, .precise = PermissionOption::kAllowed};
  return result;
}
std::optional<Type> DescriptorType(const blink::mojom::PermissionDescriptorPtr& descriptor) {
  auto type =
      descriptor ? blink::MaybePermissionDescriptorToPermissionType(descriptor) : std::nullopt;
  if (type == Type::GEOLOCATION_APPROXIMATE)
    return Type::GEOLOCATION;
  if (type == Type::MIDI && base::FeatureList::IsEnabled(blink::features::kBlockMidiByDefault))
    return Type::MIDI_SYSEX;
  return type;
}
bool LiveDocument(content::RenderFrameHost* frame, content::BrowserContext* context) {
  auto* contents = frame ? content::WebContents::FromRenderFrameHost(frame) : nullptr;
  return frame && frame->IsActive() && !frame->IsNestedWithinFencedFrame() && contents &&
         contents->GetBrowserContext() == context && frame->GetBrowserContext() == context;
}
Result Denied() {
  return Result(Status::DENIED);
}
}  // namespace

ProfilePermissions::ProfilePermissions(content::BrowserContext* context) : context_(context) {}
ProfilePermissions::~ProfilePermissions() = default;
Result ProfilePermissions::Lookup(Type type,
                                  const url::Origin& requesting,
                                  const url::Origin& embedding) const {
  if (!context_ || !Eligible(requesting) || !Eligible(embedding))
    return Denied();
  const auto name = TypeName(type);
  if (!name.empty()) {
    if (!network::IsOriginPotentiallyTrustworthy(requesting))
      return Denied();
    const auto* site = static_cast<BrowserContext*>(context_.get())
                           ->site_preferences()
                           .FindDict(requesting.Serialize());
    const auto* permissions = site ? site->FindDict("permissions") : nullptr;
    const auto* setting = permissions ? permissions->FindString(name) : nullptr;
    return PermissionResult(
        type, setting ? (*setting == "allow" ? Status::GRANTED : Status::DENIED) : Status::ASK);
  }
  if (type == Type::PERSISTENT_STORAGE)
    return Result(Status::ASK);
  return Result(type == Type::BACKGROUND_SYNC || type == Type::SENSORS || type == Type::MIDI ||
                        type == Type::CLIPBOARD_SANITIZED_WRITE || type == Type::WAKE_LOCK_SCREEN ||
                        type == Type::PAYMENT_HANDLER || type == Type::PROTECTED_MEDIA_IDENTIFIER
                    ? Status::GRANTED
                    : Status::DENIED);
}

Status ProfilePermissions::GetPermissionStatus(
    const blink::mojom::PermissionDescriptorPtr& descriptor,
    const GURL& requesting,
    const GURL& embedding) {
  return GetPermissionResultForOriginWithoutContext(descriptor, url::Origin::Create(requesting),
                                                    url::Origin::Create(embedding))
      .status;
}
Result ProfilePermissions::GetPermissionResultForOriginWithoutContext(
    const blink::mojom::PermissionDescriptorPtr& descriptor,
    const url::Origin& requesting,
    const url::Origin& embedding) {
  auto type = DescriptorType(descriptor);
  return type ? Lookup(*type, requesting, embedding) : Denied();
}
Result ProfilePermissions::GetPermissionResultForCurrentDocument(
    const blink::mojom::PermissionDescriptorPtr& descriptor,
    content::RenderFrameHost* frame,
    bool) {
  auto type = DescriptorType(descriptor);
  if (!type || !LiveDocument(frame, context_))
    return Denied();
  auto document = frame->GetWeakDocumentPtr();
  auto* main = frame->GetOutermostMainFrame();
  if (!main || !LiveDocument(main, context_))
    return Denied();
  const auto feature = blink::PermissionTypeToPermissionsPolicyFeature(*type);
  if (feature && !frame->IsFeatureEnabled(*feature))
    return Result(Status::DENIED, content::PermissionStatusSource::FEATURE_POLICY);
  auto result = Lookup(*type, frame->GetLastCommittedOrigin(), main->GetLastCommittedOrigin());
  if (result.status == Status::ASK)
    for (const auto& grant : one_time_)
      if (grant.permission == *type && grant.document.AsRenderFrameHostIfValid() == frame)
        result = PermissionResult(*type, Status::GRANTED);
  if (*type == Type::CLIPBOARD_SANITIZED_WRITE && !frame->IsFocused())
    return Denied();
  return document.AsRenderFrameHostIfValid() == frame && frame->IsActive() ? result : Denied();
}
void ProfilePermissions::RequestPermissionsFromCurrentDocument(
    content::RenderFrameHost* frame,
    const content::PermissionRequestDescription& request,
    base::OnceCallback<void(const std::vector<Result>&)> callback) {
  std::vector<Result> results;
  const bool matching_origin =
      LiveDocument(frame, context_) &&
      (request.requesting_origin.is_empty() ||
       url::Origin::Create(request.requesting_origin) == frame->GetLastCommittedOrigin());
  const auto document = frame ? frame->GetWeakDocumentPtr() : content::WeakDocumentPtr();
  for (const auto& descriptor : request.permissions)
    results.push_back(matching_origin
                          ? GetPermissionResultForCurrentDocument(descriptor, frame, false)
                          : Denied());
  if (document.AsRenderFrameHostIfValid() != frame || !LiveDocument(frame, context_))
    for (auto& result : results)
      result = Denied();
  struct RequestState {
    std::vector<Result> results;
    size_t remaining = 0;
    base::OnceCallback<void(const std::vector<Result>&)> callback;
  };
  auto state = std::make_shared<RequestState>();
  state->results = std::move(results);
  state->callback = std::move(callback);
  std::vector<std::pair<size_t, Type>> pending;
  for (size_t i = 0; i < state->results.size(); ++i) {
    const auto type = DescriptorType(request.permissions[i]);
    if (type == Type::GEOLOCATION && state->results[i].status == Status::GRANTED) {
      mojo::Remote<device::mojom::GeolocationControl> control;
      content::GetDeviceService().BindGeolocationControl(control.BindNewPipeAndPassReceiver());
      control->UserDidOptIntoLocationServices();
    }
    if (state->results[i].status == Status::ASK && type && !TypeName(*type).empty())
      pending.emplace_back(i, *type);
    else if (state->results[i].status == Status::ASK)
      state->results[i] = Denied();
  }
  auto* page =
      PageRequests::ForContents(frame ? content::WebContents::FromRenderFrameHost(frame) : nullptr);
  if (pending.empty() || !page) {
    for (auto& result : state->results)
      if (result.status == Status::ASK)
        result = Denied();
    std::move(state->callback).Run(state->results);
    return;
  }
  state->remaining = pending.size();
  for (const auto [index, type] : pending) {
    page->RequestPermission(
        frame, {TypeName(type)},
        base::BindOnce(
            [](base::WeakPtr<ProfilePermissions> self, content::WeakDocumentPtr document,
               std::shared_ptr<RequestState> state, size_t index, Type type,
               const std::string& decision) {
              auto* frame = document.AsRenderFrameHostIfValid();
              const bool allow = self && LiveDocument(frame, self->context_) &&
                                 (decision == "allow" || decision == "allow_once");
              state->results[index] =
                  PermissionResult(type, allow ? Status::GRANTED : Status::DENIED);
              if (allow && decision == "allow_once")
                self->one_time_.push_back({document, type});
              if (allow && type == Type::GEOLOCATION) {
                mojo::Remote<device::mojom::GeolocationControl> control;
                content::GetDeviceService().BindGeolocationControl(
                    control.BindNewPipeAndPassReceiver());
                control->UserDidOptIntoLocationServices();
              }
              if (self)
                self->NotifyChanged();
              if (--state->remaining == 0)
                std::move(state->callback).Run(state->results);
            },
            weak_factory_.GetWeakPtr(), document, state, index, type));
  }
}

Result ProfilePermissions::GetPermissionResultForWorker(
    const blink::mojom::PermissionDescriptorPtr& descriptor,
    content::RenderProcessHost* process,
    const GURL& worker_origin) {
  if (!process || process->GetBrowserContext() != context_)
    return Denied();
  const auto origin = url::Origin::Create(worker_origin);
  if (!Eligible(origin) ||
      !content::ChildProcessSecurityPolicy::GetInstance()->CanAccessDataForOrigin(
          process->GetDeprecatedID(), origin))
    return Denied();
  return GetPermissionResultForOriginWithoutContext(descriptor, origin, origin);
}
Result ProfilePermissions::GetPermissionResultForEmbeddedRequester(
    const blink::mojom::PermissionDescriptorPtr&,
    content::RenderFrameHost*,
    const url::Origin&) {
  // This entry point is only for TOP_LEVEL_STORAGE_ACCESS, which is unsupported.
  return Denied();
}
void ProfilePermissions::ResetPermission(Type, const GURL&, const GURL&) {}
void ProfilePermissions::SitePreferencesChanged() {
  std::erase_if(one_time_, [](const OneTimeGrant& grant) {
    return !grant.document.AsRenderFrameHostIfValid();
  });
  NotifyChanged();
}
void ProfilePermissions::NavigationCommitted(content::NavigationHandle* navigation) {
  std::erase_if(one_time_, [navigation](const OneTimeGrant& grant) {
    auto* frame = grant.document.AsRenderFrameHostIfValid();
    if (!frame)
      return true;
    if (content::WebContents::FromRenderFrameHost(frame) != navigation->GetWebContents())
      return false;
    if (navigation->IsInPrimaryMainFrame())
      return true;
    for (; frame; frame = frame->GetParent())
      if (frame->GetFrameTreeNodeId() == navigation->GetFrameTreeNodeId())
        return true;
    return false;
  });
  NotifyChanged();
}
void ProfilePermissions::DocumentDestroyed(content::RenderFrameHost* frame) {
  std::erase_if(one_time_, [frame](const OneTimeGrant& grant) {
    auto* document = grant.document.AsRenderFrameHostIfValid();
    return !document || document == frame;
  });
}
bool ProfilePermissions::IsPermissionOverridable(Type,
                                                 base::optional_ref<const url::Origin>,
                                                 base::optional_ref<const url::Origin>) {
  return false;
}

void ProfilePermissions::OnPermissionStatusChangeSubscriptionAdded(
    content::PermissionController::SubscriptionId id) {
  if (!subscriptions())
    return;
  auto* subscription = subscriptions()->Lookup(id);
  if (!subscription)
    return;
  if (subscription->render_frame_id != -1) {
    auto* frame = content::RenderFrameHost::FromID(subscription->render_process_id,
                                                   subscription->render_frame_id);
    documents_[id] = frame ? frame->GetWeakDocumentPtr() : content::WeakDocumentPtr();
    if (LiveDocument(frame, context_))
      subscription->embedding_origin =
          frame->GetOutermostMainFrame()->GetLastCommittedOrigin().GetURL();
  }
  subscription->permission_result = SubscriptionResult(id);
}
Result ProfilePermissions::SubscriptionResult(content::PermissionController::SubscriptionId id) {
  auto* subscription = subscriptions() ? subscriptions()->Lookup(id) : nullptr;
  if (!subscription)
    return Denied();
  if (subscription->render_frame_id != -1) {
    const auto found = documents_.find(id);
    auto* frame = found == documents_.end() ? nullptr : found->second.AsRenderFrameHostIfValid();
    if (!LiveDocument(frame, context_) ||
        url::Origin::Create(subscription->requesting_origin) != frame->GetLastCommittedOrigin())
      return Denied();
    return GetPermissionResultForCurrentDocument(subscription->permission_descriptor, frame,
                                                 subscription->should_include_device_status);
  }
  if (subscription->render_process_id != -1)
    return GetPermissionResultForWorker(
        subscription->permission_descriptor,
        content::RenderProcessHost::FromID(subscription->render_process_id),
        subscription->requesting_origin);
  return GetPermissionResultForOriginWithoutContext(
      subscription->permission_descriptor, url::Origin::Create(subscription->requesting_origin),
      url::Origin::Create(subscription->embedding_origin));
}
void ProfilePermissions::UnsubscribeFromPermissionResultChange(
    content::PermissionController::SubscriptionId id) {
  documents_.erase(id);
}
void ProfilePermissions::NotifyChanged() {
  if (!subscriptions())
    return;
  std::vector<content::PermissionController::SubscriptionId> ids;
  for (content::PermissionController::SubscriptionsMap::iterator it(subscriptions()); !it.IsAtEnd();
       it.Advance())
    ids.push_back(it.GetCurrentKey());
  auto weak = weak_factory_.GetWeakPtr();
  for (auto id : ids) {
    auto* subscription = subscriptions()->Lookup(id);
    if (!subscription)
      continue;
    const auto result = SubscriptionResult(id);
    if (subscription->permission_result && subscription->permission_result->status == result.status)
      continue;
    subscription->permission_result = result;
    const auto callback = subscription->callback;
    if (callback)
      callback.Run(result, false);
    if (!weak)
      return;
  }
}

namespace {
using AllocatedTarget = std::pair<base::FilePath, std::string>;
AllocatedTarget AllocateTarget(const base::FilePath& directory,
                               std::uint32_t id,
                               const base::FilePath& suggested) {
  if (!directory.IsAbsolute() || !base::CreateDirectory(directory))
    return {{}, "download_directory_unavailable"};
  base::FilePath unique;
  const auto prefix = base::FilePath::FromUTF8Unsafe(base::NumberToString(id) + "-").value();
  if (!base::CreateTemporaryDirInDir(directory, prefix, &unique))
    return {{}, "unique_download_directory_failed"};
  const auto path = unique.Append(suggested.BaseName());
  if (base::PathExists(path) ||
      base::PathExists(path.AddExtension(FILE_PATH_LITERAL("crdownload"))))
    return {{}, "download_target_already_exists"};
  // CreateTemporaryDirInDir creates a fresh exclusive namespace; no existing
  // user file is handed to Chromium's overwrite-style target API.
  return {path, {}};
}
bool AllowedDownload(const GURL& url, const std::optional<url::Origin>& initiator) {
  if (!url.is_valid())
    return false;
  if (url.SchemeIs("https"))
    return true;
  return (url.SchemeIsBlob() || url.SchemeIs("data") || url.SchemeIs("filesystem")) && initiator &&
         network::IsOriginPotentiallyTrustworthy(*initiator);
}
const char* DownloadState(download::DownloadItem::DownloadState state) {
  switch (state) {
    case download::DownloadItem::IN_PROGRESS:
      return "in_progress";
    case download::DownloadItem::COMPLETE:
      return "complete";
    case download::DownloadItem::CANCELLED:
      return "cancelled";
    case download::DownloadItem::INTERRUPTED:
      return "interrupted";
    default:
      return "unknown";
  }
}
void ConnectQuarantine(mojo::PendingReceiver<quarantine::mojom::Quarantine> receiver) {
#if BUILDFLAG(IS_WIN)
  auto runner = base::ThreadPool::CreateCOMSTATaskRunner(
      {base::MayBlock(), base::TaskPriority::USER_VISIBLE});
#else
  auto runner = base::ThreadPool::CreateSingleThreadTaskRunner(
      {base::MayBlock(), base::TaskPriority::USER_VISIBLE});
#endif
  // Reuse Chromium's existing quarantine backend on a worker COM apartment.
  // Its real annotation/scan result flows back through the normal download code.
  runner->PostTask(FROM_HERE,
                   base::BindOnce(
                       [](mojo::PendingReceiver<quarantine::mojom::Quarantine> receiver) {
                         mojo::MakeSelfOwnedReceiver(std::make_unique<quarantine::QuarantineImpl>(),
                                                     std::move(receiver));
                       },
                       std::move(receiver)));
}
}  // namespace

ProfileDownloads::ProfileDownloads(content::BrowserContext* context,
                                   const base::FilePath& profile_path)
    : context_(context),
      profile_path_(profile_path),
      downloads_path_(profile_path.Append(FILE_PATH_LITERAL("downloads"))) {
  CHECK(base::CreateDirectory(downloads_path_));
}
ProfileDownloads::~ProfileDownloads() {
  Shutdown();
}
bool ProfileDownloads::Bind(content::DownloadManager* manager) {
  if (shutdown_ || !manager || manager->GetBrowserContext() != context_ ||
      !profile_path_.IsAbsolute() || !context_ || context_->GetPath() != profile_path_)
    return false;
  if (manager_ == manager)
    return true;
  if (manager_)
    return false;
  manager_ = manager;
  manager_->SetDelegate(this);
  manager_->AddObserver(this);
  content::DownloadManager::DownloadVector items;
  manager_->GetAllDownloads(&items);
  for (const auto& item : items)
    OnDownloadCreated(manager_, item.get());
  return true;
}
void ProfileDownloads::Shutdown() {
  if (shutdown_)
    return;
  shutdown_ = true;
  weak_factory_.InvalidateWeakPtrs();
  if (manager_) {
    manager_->RemoveObserver(this);
    if (manager_->GetDelegate() == this)
      manager_->SetDelegate(nullptr);
  }
  manager_ = nullptr;
  for (auto& [guid, record] : records_) {
    if (record.item)
      record.item->RemoveObserver(this);
    record.item = nullptr;
  }
  auto callbacks = std::move(targets_);
  targets_.clear();
  for (auto& [guid, callback] : callbacks) {
    download::DownloadTargetInfo info;
    info.interrupt_reason = download::DOWNLOAD_INTERRUPT_REASON_USER_CANCELED;
    std::move(callback).Run(std::move(info));
  }
}
size_t ProfileDownloads::InProgressCount() const {
  size_t count = 0;
  for (const auto& [guid, record] : records_) {
    if (record.item && record.item->GetState() == download::DownloadItem::IN_PROGRESS)
      ++count;
  }
  return count;
}
void ProfileDownloads::ManagerGoingDown(content::DownloadManager*) {
  Shutdown();
}
void ProfileDownloads::GetNextId(content::DownloadIdCallback callback) {
  if (shutdown_ || next_id_ == std::numeric_limits<std::uint32_t>::max()) {
    std::move(callback).Run(download::DownloadItem::kInvalidId);
    return;
  }
  std::move(callback).Run(next_id_++);
}
std::string ProfileDownloads::BlockReason(download::DownloadItem* item) const {
  if (item && (item->GetReceivedBytes() > 256LL * 1024 * 1024 ||
               item->GetTotalBytes() > 256LL * 1024 * 1024))
    return "file_too_large";
  if (!item || !AllowedDownload(item->GetURL(), item->GetRequestInitiator()))
    return "https_only_policy";
  for (const auto& url : item->GetUrlChain())
    if (!AllowedDownload(url, item->GetRequestInitiator()))
      return "non_https_redirect_blocked";
  if (item->GetDangerType() != download::DOWNLOAD_DANGER_TYPE_NOT_DANGEROUS)
    return "dangerous_download_blocked";
  const auto insecure = item->GetInsecureDownloadStatus();
  if (insecure != download::DownloadItem::InsecureDownloadStatus::UNKNOWN &&
      insecure != download::DownloadItem::InsecureDownloadStatus::SAFE)
    return "insecure_download_blocked";
  return {};
}
bool ProfileDownloads::DetermineDownloadTarget(download::DownloadItem* item,
                                               download::DownloadTargetCallback* callback) {
  // Returning false would enable DownloadManager's forced-path fallback.
  if (!callback || callback->is_null())
    return true;
  if (!item) {
    std::move(*callback).Run(download::DownloadTargetInfo());
    return true;
  }
  const auto guid = item->GetGuid();
  if (manager_ && !records_.contains(guid))
    OnDownloadCreated(manager_, item);
  auto reason = shutdown_   ? "profile_shutdown"
                : !manager_ ? "manager_not_bound"
                            : BlockReason(item);
  if (reason.empty() && targets_.contains(guid))
    reason = "target_request_already_pending";
  if (!reason.empty()) {
    download::DownloadTargetInfo info;
    info.danger_type = item->GetDangerType();
    info.insecure_download_status = item->GetInsecureDownloadStatus();
    info.interrupt_reason = download::DOWNLOAD_INTERRUPT_REASON_FILE_BLOCKED;
    if (auto found = records_.find(guid); found != records_.end())
      found->second.error = reason;
    std::move(*callback).Run(std::move(info));
    return true;
  }
  targets_.emplace(guid, std::move(*callback));
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
      base::BindOnce(
          [](base::FilePath directory, std::uint32_t id, GURL url, std::string disposition,
             std::string suggested, std::string mime) {
            return AllocateTarget(
                directory, id,
                net::GenerateFileName(url, disposition, "", suggested, mime, "download"));
          },
          downloads_path_, item->GetId(), item->GetURL(), item->GetContentDisposition(),
          item->GetSuggestedFilename(), item->GetMimeType()),
      base::BindOnce(
          [](base::WeakPtr<ProfileDownloads> owner, std::string guid, AllocatedTarget target) {
            if (owner)
              owner->TargetAllocated(std::move(guid), std::move(target.first),
                                     std::move(target.second));
          },
          weak_factory_.GetWeakPtr(), guid));
  return true;
}
void ProfileDownloads::TargetAllocated(std::string guid, base::FilePath target, std::string error) {
  const auto pending = targets_.find(guid);
  if (pending == targets_.end())
    return;
  auto callback = std::move(pending->second);
  targets_.erase(pending);
  auto found = records_.find(guid);
  auto* item = found == records_.end() ? nullptr : found->second.item.get();
  if (error.empty() && (!item || item->GetState() != download::DownloadItem::IN_PROGRESS))
    error = "download_no_longer_active";
  if (error.empty())
    error = BlockReason(item);
  download::DownloadTargetInfo info;
  if (item) {
    info.danger_type = item->GetDangerType();
    info.insecure_download_status = item->GetInsecureDownloadStatus();
  }
  if (error.empty()) {
    found->second.target = target;
    found->second.error.clear();
    info.target_path = target;
    info.intermediate_path = target.AddExtension(FILE_PATH_LITERAL("crdownload"));
    info.display_name = target.BaseName();
    // SAFE describes transport policy here, never a file/SafeBrowsing verdict.
    info.insecure_download_status = download::DownloadItem::InsecureDownloadStatus::SAFE;
  } else {
    info.interrupt_reason = download::DOWNLOAD_INTERRUPT_REASON_FILE_BLOCKED;
    if (found != records_.end())
      found->second.error = error;
  }
  if (item)
    Update(item);
  std::move(callback).Run(std::move(info));
}
void ProfileDownloads::OnDownloadCreated(content::DownloadManager* manager,
                                         download::DownloadItem* item) {
  if (shutdown_ || manager != manager_ || !item)
    return;
  auto& record = records_[item->GetGuid()];
  if (!record.item) {
    record.item = item;
    item->AddObserver(this);
  }
  if (item->GetId() >= next_id_ && item->GetId() < std::numeric_limits<std::uint32_t>::max())
    next_id_ = item->GetId() + 1;
  OnDownloadUpdated(item);
}
void ProfileDownloads::Update(download::DownloadItem* item) {
  auto found = records_.find(item->GetGuid());
  if (found == records_.end())
    return;
  auto& record = found->second;
  auto data = base::DictValue();
  data.Set("id", base::NumberToString(item->GetId()));
  data.Set("guid", item->GetGuid());
  data.Set("url", Clip(item->GetURL().spec()));
  data.Set("state", DownloadState(item->GetState()));
  data.Set("paused", item->IsPaused());
  data.Set("can_resume", item->CanResume());
  data.Set("received_bytes", base::NumberToString(item->GetReceivedBytes()));
  data.Set("total_bytes", base::NumberToString(item->GetTotalBytes()));
  data.Set("danger_type", static_cast<int>(item->GetDangerType()));
  data.Set("insecure_status", static_cast<int>(item->GetInsecureDownloadStatus()));
  data.Set("interrupt_reason", download::DownloadInterruptReasonToString(item->GetLastReason()));
  if (!record.error.empty())
    data.Set("error", record.error);
  // Only completed files in our allocated namespace are exposed. No absolute
  // native path is accepted or returned by the remote command surface.
  base::FilePath relative;
  if (item->GetState() == download::DownloadItem::COMPLETE && !record.target.empty() &&
      item->GetTargetFilePath() == record.target &&
      profile_path_.AppendRelativePath(record.target, &relative))
    data.Set("file_reference",
             relative.NormalizePathSeparatorsTo(FILE_PATH_LITERAL('/')).AsUTF8Unsafe());
  if (data.contains("file_reference") && !record.completion_recorded) {
    base::DictValue event;
    const auto event_id = "download-" + item->GetGuid();
    event.Set("type", "download.completed");
    event.Set("eventId", event_id);
    event.Set("guid", item->GetGuid());
    event.Set("fileReference", *data.FindString("file_reference"));
    event.Set("name", item->GetFileNameToReportUser().AsUTF8Unsafe());
    event.Set("mimeType", item->GetMimeType());
    event.Set("size", base::NumberToString(item->GetReceivedBytes()));
    auto origin = url::Origin::Create(item->GetTabUrl());
    if (origin.opaque() && item->GetRequestInitiator())
      origin = *item->GetRequestInitiator();
    event.Set("origin", std::string(base::TruncateUTF8ToByteSize(origin.Serialize(), 2048)));
    events_.emplace(event_id, std::move(event));
    record.completion_recorded = true;
  }
  record.snapshot = std::move(data);
}
void ProfileDownloads::OnDownloadUpdated(download::DownloadItem* item) {
  Update(item);
  const auto reason = BlockReason(item);
  if (!reason.empty() && item->GetState() == download::DownloadItem::IN_PROGRESS) {
    records_[item->GetGuid()].error = reason;
    LOG(WARNING) << "download cancelled: " << reason;
    item->Cancel(false);
  }
}
void ProfileDownloads::OnDownloadDestroyed(download::DownloadItem* item) {
  Update(item);
  const auto guid = item->GetGuid();
  item->RemoveObserver(this);
  auto found = records_.find(guid);
  if (found != records_.end())
    found->second.item = nullptr;
  const auto pending = targets_.find(guid);
  if (pending != targets_.end()) {
    auto callback = std::move(pending->second);
    targets_.erase(pending);
    download::DownloadTargetInfo info;
    info.interrupt_reason = download::DOWNLOAD_INTERRUPT_REASON_USER_CANCELED;
    // The DownloadItem's weak target callback must not re-enter its destructor.
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(std::move(callback), std::move(info)));
  }
}
bool ProfileDownloads::ShouldCompleteDownload(download::DownloadItem* item, base::OnceClosure) {
  const auto reason = BlockReason(item);
  if (!reason.empty()) {
    if (auto found = records_.find(item->GetGuid()); found != records_.end())
      found->second.error = reason;
    item->Cancel(false);
    return false;
  }
  return true;
}
bool ProfileDownloads::ShouldAutomaticallyOpenFile(const GURL&, const base::FilePath&) {
  return false;
}
bool ProfileDownloads::ShouldAutomaticallyOpenFileByPolicy(const GURL&, const base::FilePath&) {
  return false;
}
void ProfileDownloads::GetSaveDir(content::BrowserContext* context,
                                  base::FilePath* website,
                                  base::FilePath* downloads) {
  if (context != context_)
    return;
  if (website)
    *website = downloads_path_;
  if (downloads)
    *downloads = downloads_path_;
}
void ProfileDownloads::ChooseSavePath(content::WebContents*,
                                      const base::FilePath&,
                                      const base::FilePath::StringType&,
                                      bool,
                                      content::SavePackagePathPickedCallback callback) {
  // SavePage's multi-resource directory semantics are outside this file API.
  std::move(callback).Run(content::SavePackagePathPickedParams(), {});
}
download::QuarantineConnectionCallback ProfileDownloads::GetQuarantineConnectionCallback() {
  return base::BindRepeating(&ConnectQuarantine);
}
std::string ProfileDownloads::ApplicationClientIdForFileScanning() {
  // Stable RemoteKit client identity for Windows Attachment Services; this does
  // not register/install an application or assert that a file was scanned.
  return "8a8062e2-c116-46ed-a932-daa7bcb088f2";
}
void ProfileDownloads::CheckDownloadAllowed(const content::WebContents::Getter& getter,
                                            const GURL& url,
                                            const std::string&,
                                            std::optional<url::Origin> initiator,
                                            bool,
                                            bool,
                                            const std::string&,
                                            std::optional<ui::PageTransition>,
                                            content::CheckDownloadAllowedCallback callback) {
  auto* contents = getter.Run();
  auto* frame = contents ? contents->GetPrimaryMainFrame() : nullptr;
  const auto document = frame ? frame->GetWeakDocumentPtr() : content::WeakDocumentPtr();
  const bool allowed = !shutdown_ && AllowedDownload(url, initiator) &&
                       LiveDocument(frame, context_) &&
                       document.AsRenderFrameHostIfValid() == frame;
  std::move(callback).Run(allowed);
}
download::DownloadItem* ProfileDownloads::GetDownloadByGuid(const std::string& guid) {
  const auto found = records_.find(guid);
  return found == records_.end() ? nullptr : found->second.item.get();
}
base::ListValue ProfileDownloads::Events() const {
  base::ListValue events;
  for (const auto& [id, event] : events_)
    events.Append(event.Clone());
  return events;
}
void ProfileDownloads::Acknowledge(const base::ListValue& ids) {
  for (const auto& id : ids)
    events_.erase(id.GetString());
}
void ProfileDownloads::Remove(const std::string& guid,
                              base::OnceCallback<void(base::DictValue)> callback) {
  if (shutdown_) {
    std::move(callback).Run(Response(protocol::ErrorCode::kUnavailable, "profile_shutdown"));
    return;
  }
  const auto found = records_.find(guid);
  if (found == records_.end()) {
    std::move(callback).Run(Response());
    return;
  }
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
      base::BindOnce(
          [](const base::FilePath& target) { return target.empty() || base::DeleteFile(target); },
          found->second.target),
      base::BindOnce(
          [](base::WeakPtr<ProfileDownloads> owner, std::string guid,
             base::OnceCallback<void(base::DictValue)> callback, bool removed) {
            if (!owner)
              return;
            if (!removed) {
              std::move(callback).Run(
                  Response(protocol::ErrorCode::kUnavailable, "download_remove_failed"));
              return;
            }
            const auto found = owner->records_.find(guid);
            if (found != owner->records_.end()) {
              if (found->second.item)
                found->second.item->Remove();
              owner->records_.erase(guid);
            }
            std::move(callback).Run(Response());
          },
          weak_factory_.GetWeakPtr(), guid, std::move(callback)));
}
base::DictValue ProfileDownloads::Command(const base::DictValue& command) {
  const auto* action = command.FindString("action");
  if (!action)
    return Response(protocol::ErrorCode::kInvalidRequest, "action_required");
  if (*action == "snapshot") {
    auto result = Response();
    result.Set("policy", "https_network_trustworthy_local_no_safebrowsing");
    result.Set("quarantine", "chromium_backend");
    result.Set("shutdown", shutdown_);
    base::ListValue items;
    for (const auto& [guid, record] : records_) {
      auto item = record.snapshot.Clone();
      item.Set("observed", record.item != nullptr);
      items.Append(std::move(item));
    }
    result.Set("downloads", std::move(items));
    return result;
  }
  if (shutdown_)
    return Response(protocol::ErrorCode::kUnavailable, "profile_shutdown");
  const auto* key = command.FindString("id");
  std::uint32_t id = 0;
  if (!key || key->size() > 10 || !base::StringToUint(*key, &id) ||
      base::NumberToString(id) != *key)
    return Response(protocol::ErrorCode::kInvalidRequest, "download_id_required");
  download::DownloadItem* item = nullptr;
  for (const auto& [guid, record] : records_)
    if (record.item && record.item->GetId() == id) {
      item = record.item;
      break;
    }
  if (!item)
    return Response(protocol::ErrorCode::kNotFound, "download_not_available");
  if (*action == "cancel") {
    if (item->GetState() == download::DownloadItem::COMPLETE ||
        item->GetState() == download::DownloadItem::CANCELLED)
      return Response(protocol::ErrorCode::kConflict, "download_already_terminal");
    item->Cancel(true);
  } else if (*action == "pause") {
    if (item->GetState() != download::DownloadItem::IN_PROGRESS)
      return Response(protocol::ErrorCode::kConflict, "download_not_in_progress");
    item->Pause();
  } else if (*action == "resume") {
    if (!BlockReason(item).empty())
      return Response(protocol::ErrorCode::kForbidden, "download_blocked_by_policy");
    if (!item->CanResume())
      return Response(protocol::ErrorCode::kRejected, "download_cannot_resume");
    item->Resume(true);
  } else
    return Response(protocol::ErrorCode::kInvalidRequest, "unsupported_action");
  auto result = Response();
  result.Set("state", "submitted");
  return result;
}

}  // namespace remotekit::browser
