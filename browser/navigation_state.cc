#include "browser/navigation_state.h"

#include <limits>
#include <utility>

#include "base/containers/span.h"
#include "base/pickle.h"
#include "components/sessions/content/content_serialized_navigation_builder.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/dom_storage_context.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/restore_type.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/storage_partition.h"
#include "third_party/blink/public/common/dom_storage/session_storage_namespace_id.h"
#include "third_party/blink/public/common/page_state/page_state.h"
#include "third_party/blink/public/common/page_state/page_state_serialization.h"

namespace remotekit::browser {
namespace {
constexpr int kMaxEntries = 1024;
constexpr std::size_t kMaxEntryBytes = 16 * 1024 * 1024;
constexpr std::size_t kMaxStateBytes = 64 * 1024 * 1024;
constexpr int kMaxRedirects = 1024;
constexpr int kMaxExtendedFields = 1024;
constexpr int kFormatVersion = 2;
constexpr int kMaxStoragePartitions = 128;
constexpr std::size_t kMaxPartitionFieldBytes = 4096;
Status Fail(ErrorCode error, const char* message) {
  return {error, message};
}

bool ValidSessionStorageId(std::string_view id) {
  return id.size() == blink::kSessionStorageNamespaceIdLength &&
         id.find_first_not_of("0123456789abcdef_") == std::string_view::npos;
}

bool InspectFrame(const blink::ExplodedFrameState& frame,
                  int depth,
                  std::size_t* frames,
                  bool* has_post) {
  if (depth > 128 || ++*frames > 4096)
    return false;
  *has_post |= static_cast<bool>(frame.http_body.request_body);
  for (const auto& child : frame.children)
    if (!InspectFrame(child, depth + 1, frames, has_post))
      return false;
  return true;
}

Status DecodeEntry(const sessions::SerializedNavigationEntry& entry, bool* has_post) {
  blink::ExplodedPageState page;
  if (entry.encoded_page_state().empty() ||
      !blink::DecodePageState(entry.encoded_page_state(), &page) || !page.top.url_string ||
      !GURL(*page.top.url_string).is_valid())
    return Fail(ErrorCode::kInvalidRequest, "Invalid encoded navigation PageState");
  std::size_t frames = 0;
  *has_post = entry.has_post_data();
  if (!InspectFrame(page.top, 0, &frames, has_post))
    return Fail(ErrorCode::kLimitExceeded, "PageState frame depth/count exceeds bounds");
  return {};
}

// ReadFromPickle supports legacy truncation and has count-driven loops. Check
// this format's full, bounded record before passing anything to that parser.
bool ValidateEntryPickle(std::string_view bytes) {
  if (bytes.size() > kMaxEntryBytes)
    return false;
  auto in = base::PickleIterator::WithData(base::as_byte_span(bytes));
  if (bytes.size() < sizeof(std::uint32_t) ||
      in.RemainingBytes() != bytes.size() - sizeof(std::uint32_t))
    return false;
  int index, transition, mask, obsolete_policy, status, policy, count, children;
  bool ua;
  std::int64_t time, task, parent, root;
  std::string url, state, referrer, original, key, value;
  std::u16string title, obsolete_terms;
  if (!in.ReadInt(&index) || !in.ReadString(&url) || !in.ReadString16(&title) ||
      !in.ReadString(&state) || !in.ReadInt(&transition) || !in.ReadInt(&mask) ||
      (mask & ~1) != 0 || !in.ReadString(&referrer) || !in.ReadInt(&obsolete_policy) ||
      !in.ReadString(&original) || !in.ReadBool(&ua) || !in.ReadInt64(&time) ||
      !in.ReadString16(&obsolete_terms) || !in.ReadInt(&status) || !in.ReadInt(&policy) ||
      !in.ReadInt(&count) || count < 0 || count > kMaxExtendedFields ||
      !ui::IsValidPageTransitionType(transition) || policy < 0 ||
      policy > static_cast<int>(network::mojom::ReferrerPolicy::kMaxValue))
    return false;
  for (int i = 0; i < count; ++i)
    if (!in.ReadString(&key) || !in.ReadString(&value))
      return false;
  return in.ReadInt64(&task) && in.ReadInt64(&parent) && in.ReadInt64(&root) &&
         in.ReadInt(&children) && children == 0 && in.ReachedEnd();
}
}  // namespace

NavigationState::NavigationState() = default;
NavigationState::~NavigationState() = default;
NavigationState::NavigationState(NavigationState&&) noexcept = default;
NavigationState& NavigationState::operator=(NavigationState&&) noexcept = default;
int NavigationState::entry_count() const {
  return static_cast<int>(entries_.size());
}
void NavigationState::SetSessionStorageShouldPersist(bool persist) {
  for (const auto& [config, handle] : namespaces_)
    handle->SetShouldPersist(persist);
}

Status ValidateNavigationState(const NavigationState& state) {
  if (state.entries_.size() > kMaxEntries)
    return Fail(ErrorCode::kLimitExceeded, "Navigation entry count exceeds bound");
  if (state.entries_.empty() || state.selected_index_ < 0 ||
      state.selected_index_ >= state.entry_count() ||
      state.redirect_chains_.size() != state.entries_.size())
    return Fail(ErrorCode::kInvalidRequest, "Invalid navigation entry count or selected index");
  std::size_t total = 0;
  for (std::size_t i = 0; i < state.entries_.size(); ++i) {
    const auto& entry = state.entries_[i];
    const auto bytes = entry.EstimateMemoryUsage();
    if (entry.index() != static_cast<int>(i) || !entry.virtual_url().is_valid())
      return Fail(ErrorCode::kInvalidRequest, "Invalid navigation entry index or URL");
    if (bytes > kMaxEntryBytes || total > kMaxStateBytes - bytes ||
        entry.extended_info_map().size() > kMaxExtendedFields ||
        state.redirect_chains_[i].size() > kMaxRedirects)
      return Fail(ErrorCode::kLimitExceeded, "Navigation entry encoding/metadata exceeds bounds");
    total += bytes;
    for (const auto& url : state.redirect_chains_[i]) {
      if (!url.is_valid())
        return Fail(ErrorCode::kInvalidRequest, "Invalid redirect URL");
      if (url.spec().size() > kMaxEntryBytes || total > kMaxStateBytes - url.spec().size())
        return Fail(ErrorCode::kLimitExceeded, "Redirect chain exceeds size bound");
      total += url.spec().size();
    }
    bool post = false;
    auto decoded = DecodeEntry(entry, &post);
    if (!decoded)
      return decoded;
  }
  return {};
}

Status CheckAutomaticNavigationRestore(const NavigationState& state) {
  auto valid = ValidateNavigationState(state);
  if (!valid)
    return valid;
  for (const auto& entry : state.entries_) {
    bool post = false;
    auto decoded = DecodeEntry(entry, &post);
    if (!decoded)
      return decoded;
    if (post)
      return Fail(
          ErrorCode::kRejected,
          "Navigation history contains POST data; repost confirmation is required and unsupported");
  }
  return {};
}

Result<NavigationState> CaptureNavigationState(content::WebContents& contents) {
  auto& controller = contents.GetController();
  if (contents.HasUncommittedNavigationInPrimaryMainFrame() || controller.GetPendingEntry())
    return {{},
            Fail(ErrorCode::kBusy, "Cannot snapshot navigation history with a pending navigation")};
  NavigationState state;
  const int count = controller.GetEntryCount();
  if (count < 1 || count > kMaxEntries)
    return {{}, Fail(ErrorCode::kLimitExceeded, "Navigation history count exceeds bounds")};
  state.selected_index_ = controller.GetCurrentEntryIndex();
  std::size_t captured_bytes = 0;
  for (int i = 0; i < count; ++i) {
    auto* entry = controller.GetEntryAtIndex(i);
    if (!entry)
      return {{}, Fail(ErrorCode::kInternal, "Navigation history contains a missing entry")};
    auto saved = sessions::ContentSerializedNavigationBuilder::FromNavigationEntry(i, entry);
    if (count == 1 && entry->IsInitialEntry()) {
      // An unused controller's initial empty entry has no committed PageState.
      // It represents only about:blank, not a history item that may be dropped.
      saved.set_virtual_url(GURL("about:blank"));
      saved.set_encoded_page_state(
          blink::PageState::CreateFromURL(GURL("about:blank")).ToEncodedData());
      state.selected_index_ = 0;
    }
    const auto entry_bytes = saved.EstimateMemoryUsage();
    if (entry_bytes > kMaxEntryBytes || captured_bytes > kMaxStateBytes - entry_bytes)
      return {{},
              Fail(ErrorCode::kLimitExceeded, "Captured navigation encoding exceeds size bounds")};
    captured_bytes += entry_bytes;
    state.redirect_chains_.push_back(saved.redirect_chain());
    state.entries_.push_back(std::move(saved));
  }
  auto valid = ValidateNavigationState(state);
  if (!valid)
    return {{}, valid};
  state.namespaces_ = controller.GetSessionStorageNamespaceMap();
  state.namespace_context_ = contents.GetBrowserContext();
  state.namespace_owner_ = contents.GetWeakPtr();
  return {std::move(state), {}};
}

Result<std::string> ExportNavigationState(const NavigationState& state) {
  auto valid = ValidateNavigationState(state);
  if (!valid)
    return {{}, valid};
  base::Pickle out;
  out.WriteString("RemoteKit.NavigationState");
  out.WriteInt(kFormatVersion);
  if (state.namespaces_.size() > kMaxStoragePartitions)
    return {{}, Fail(ErrorCode::kLimitExceeded, "Too many sessionStorage partitions")};
  out.WriteInt(static_cast<int>(state.namespaces_.size()));
  for (const auto& [config, handle] : state.namespaces_) {
    if (config.partition_domain().size() > kMaxPartitionFieldBytes ||
        config.partition_name().size() > kMaxPartitionFieldBytes ||
        !ValidSessionStorageId(handle->id()))
      return {{}, Fail(ErrorCode::kInvalidRequest, "Invalid sessionStorage namespace metadata")};
    out.WriteString(config.partition_domain());
    out.WriteString(config.partition_name());
    out.WriteBool(config.in_memory());
    out.WriteInt(static_cast<int>(config.fallback_to_partition_domain_for_blob_urls()));
    out.WriteString(handle->id());
  }
  out.WriteInt(state.selected_index_);
  out.WriteInt(state.entry_count());
  for (std::size_t i = 0; i < state.entries_.size(); ++i) {
    const auto& entry = state.entries_[i];
    base::Pickle record;
    // Fields were bounded before writing. INT_MAX avoids silent truncation in
    // Chromium's session pickle writer. Preserve the original opaque PageState
    // separately because its normal POST serializer strips password form data.
    entry.WriteToPickle(std::numeric_limits<int>::max(), &record);
    if (record.AsBytes().size() > kMaxEntryBytes)
      return {{}, Fail(ErrorCode::kLimitExceeded, "Serialized entry exceeds bound")};
    out.WriteString(record.AsStringView());
    out.WriteString(entry.encoded_page_state());
    out.WriteString(entry.favicon_url().spec());
    out.WriteInt(static_cast<int>(state.redirect_chains_[i].size()));
    for (const auto& url : state.redirect_chains_[i])
      out.WriteString(url.spec());
    if (out.AsBytes().size() > kMaxStateBytes)
      return {{}, Fail(ErrorCode::kLimitExceeded, "Serialized navigation state exceeds 64 MiB")};
  }
  return {std::string(out.AsStringView()), {}};
}

Result<NavigationState> ImportNavigationState(std::string_view bytes,
                                              content::BrowserContext* context) {
  if (!context)
    return {{}, Fail(ErrorCode::kInvalidRequest, "BrowserContext required")};
  if (bytes.size() > kMaxStateBytes)
    return {{}, Fail(ErrorCode::kLimitExceeded, "Navigation state exceeds 64 MiB")};
  auto in = base::PickleIterator::WithData(base::as_byte_span(bytes));
  if (bytes.size() < sizeof(std::uint32_t) ||
      in.RemainingBytes() != bytes.size() - sizeof(std::uint32_t))
    return {{}, Fail(ErrorCode::kInvalidRequest, "Invalid navigation-state pickle header")};
  NavigationState state;
  std::string magic;
  int version, count, partitions;
  if (!in.ReadString(&magic) || magic != "RemoteKit.NavigationState" || !in.ReadInt(&version) ||
      version != kFormatVersion || !in.ReadInt(&partitions) || partitions < 0)
    return {{}, Fail(ErrorCode::kInvalidRequest, "Invalid navigation-state header/version")};
  if (partitions > kMaxStoragePartitions)
    return {{}, Fail(ErrorCode::kLimitExceeded, "Too many sessionStorage partitions")};
  std::map<content::StoragePartitionConfig, std::string> namespaces;
  for (int i = 0; i < partitions; ++i) {
    std::string domain, name, id;
    bool in_memory;
    int fallback;
    using Fallback = content::StoragePartitionConfig::FallbackMode;
    if (!in.ReadString(&domain) ||
        domain.find_first_not_of("abcdefghijklmnopqrstuvwxyz") != std::string::npos ||
        !in.ReadString(&name) || !in.ReadBool(&in_memory) || !in.ReadInt(&fallback) ||
        fallback < static_cast<int>(Fallback::kNone) ||
        fallback > static_cast<int>(Fallback::kFallbackPartitionInMemory) || !in.ReadString(&id) ||
        !ValidSessionStorageId(id) ||
        (domain.empty() && (!name.empty() || in_memory != context->IsOffTheRecord() ||
                            fallback != static_cast<int>(Fallback::kNone))))
      return {{}, Fail(ErrorCode::kInvalidRequest, "Invalid sessionStorage partition metadata")};
    if (domain.size() > kMaxPartitionFieldBytes || name.size() > kMaxPartitionFieldBytes)
      return {{}, Fail(ErrorCode::kLimitExceeded, "SessionStorage metadata exceeds bound")};
    auto config = domain.empty()
                      ? content::StoragePartitionConfig::CreateDefault(context)
                      : content::StoragePartitionConfig::Create(context, domain, name, in_memory);
    config.set_fallback_to_partition_domain_for_blob_urls(static_cast<Fallback>(fallback));
    if (!namespaces.emplace(std::move(config), std::move(id)).second)
      return {{}, Fail(ErrorCode::kInvalidRequest, "Duplicate sessionStorage partition")};
  }
  if (!in.ReadInt(&state.selected_index_) || !in.ReadInt(&count) || count < 1 ||
      state.selected_index_ < 0 || state.selected_index_ >= count)
    return {{}, Fail(ErrorCode::kInvalidRequest, "Invalid navigation-state header/version/index")};
  if (count > kMaxEntries)
    return {{}, Fail(ErrorCode::kLimitExceeded, "Too many navigation entries")};
  for (int i = 0; i < count; ++i) {
    std::string record, page_state, favicon;
    int redirects;
    if (!in.ReadString(&record) || !in.ReadString(&page_state) || !in.ReadString(&favicon) ||
        !in.ReadInt(&redirects) || redirects < 0)
      return {{}, Fail(ErrorCode::kInvalidRequest, "Invalid encoded navigation entry")};
    if (record.size() > kMaxEntryBytes || page_state.size() > kMaxEntryBytes ||
        redirects > kMaxRedirects)
      return {{}, Fail(ErrorCode::kLimitExceeded, "Navigation entry exceeds bounds")};
    if (!ValidateEntryPickle(record))
      return {{}, Fail(ErrorCode::kInvalidRequest, "Invalid serialized navigation entry")};
    auto record_in = base::PickleIterator::WithData(base::as_byte_span(record));
    sessions::SerializedNavigationEntry entry;
    if (!entry.ReadFromPickle(&record_in) || !record_in.ReachedEnd() || entry.index() != i)
      return {{}, Fail(ErrorCode::kInvalidRequest, "Invalid serialized navigation entry index")};
    entry.set_encoded_page_state(std::move(page_state));
    entry.set_favicon_url(GURL(favicon));
    std::vector<GURL> chain;
    for (int j = 0; j < redirects; ++j) {
      std::string url;
      if (!in.ReadString(&url) || !GURL(url).is_valid())
        return {{}, Fail(ErrorCode::kInvalidRequest, "Invalid redirect URL")};
      chain.emplace_back(url);
    }
    state.entries_.push_back(std::move(entry));
    state.redirect_chains_.push_back(std::move(chain));
  }
  if (!in.ReachedEnd())
    return {{}, Fail(ErrorCode::kInvalidRequest, "Trailing navigation-state payload")};
  auto valid = ValidateNavigationState(state);
  if (!valid)
    return {{}, valid};
  // Recreate now, before the caller signals that all imports are ready for
  // scavenging. An imported view can remain unloaded until it is needed.
  for (const auto& [config, id] : namespaces) {
    auto* partition = context->GetStoragePartition(config);
    state.namespaces_.emplace(config,
                              partition->GetDOMStorageContext()->RecreateSessionStorage(id));
  }
  state.namespace_context_ = context;
  return {std::move(state), {}};
}

Result<std::unique_ptr<content::WebContents>> CreateRestoredWebContents(
    content::BrowserContext* context,
    NavigationState& state,
    bool initially_hidden) {
  if (!context)
    return {{}, Fail(ErrorCode::kInvalidRequest, "BrowserContext required")};
  auto valid = CheckAutomaticNavigationRestore(state);
  if (!valid)
    return {{}, valid};
  if (state.namespace_owner_)
    return {{},
            Fail(ErrorCode::kBusy,
                 "Previous WebContents namespace owner must be destroyed before restore")};
  if (state.namespace_context_ && state.namespace_context_ != context)
    return {{},
            Fail(ErrorCode::kConflict,
                 "Retained sessionStorage belongs to a different BrowserContext")};
  auto entries =
      sessions::ContentSerializedNavigationBuilder::ToNavigationEntries(state.entries_, context);
  if (entries.size() != state.entries_.size())
    return {{}, Fail(ErrorCode::kInternal, "Navigation conversion failed")};
  for (std::size_t i = 0; i < entries.size(); ++i) {
    if (!entries[i])
      return {{}, Fail(ErrorCode::kInternal, "Navigation conversion returned an empty entry")};
    entries[i]->SetRedirectChain(state.redirect_chains_[i]);
  }
  content::WebContents::CreateParams params(context);
  params.initially_hidden = initially_hidden;
  auto contents = content::WebContents::CreateWithSessionStorage(params, state.namespaces_);
  if (!contents)
    return {{}, Fail(ErrorCode::kUnavailable, "WebContents creation failed")};
  state.namespace_owner_ = contents->GetWeakPtr();
  contents->GetController().Restore(state.selected_index_, content::RestoreType::kRestored,
                                    &entries);
  state.namespace_context_ = context;
  state.namespaces_ = contents->GetController().GetSessionStorageNamespaceMap();
  return {std::move(contents), {}};
}
}  // namespace remotekit::browser
