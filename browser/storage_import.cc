#include "browser/storage_import.h"

#include <algorithm>

#include "base/functional/bind.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "base/time/time.h"
#include "base/values.h"
#include "components/services/storage/public/mojom/local_storage_control.mojom.h"
#include "content/public/browser/storage_partition.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "net/cookies/canonical_cookie.h"
#include "net/cookies/cookie_access_result.h"
#include "net/cookies/cookie_options.h"
#include "services/network/public/mojom/cookie_manager.mojom.h"
#include "third_party/blink/public/common/storage_key/storage_key.h"
#include "third_party/blink/public/mojom/dom_storage/storage_area.mojom.h"
#include "url/origin.h"

namespace remotekit::browser {
namespace {
std::vector<uint8_t> EncodeLocalStorage(const std::u16string& text) {
  const bool latin1 = std::ranges::all_of(text, [](char16_t unit) { return unit <= 0xff; });
  std::vector<uint8_t> bytes;
  bytes.reserve(1 + text.size() * (latin1 ? 1 : 2));
  bytes.push_back(latin1 ? 1 : 0);
  for (char16_t unit : text) {
    bytes.push_back(static_cast<uint8_t>(unit));
    if (!latin1)
      bytes.push_back(static_cast<uint8_t>(unit >> 8));
  }
  return bytes;
}
}  // namespace

struct StorageImportJobs::Job {
  struct Counts {
    int applied = 0, rejected = 0;
    base::DictValue Value() const {
      return base::DictValue().Set("applied", applied).Set("rejected", rejected);
    }
  } cookies, local_storage;
  content::StoragePartition* partition = nullptr;
  std::vector<mojo::Remote<blink::mojom::StorageArea>> areas;
  size_t pending = 0;
  bool flushing = false, done = false;
};

StorageImportJobs::StorageImportJobs() = default;
StorageImportJobs::~StorageImportJobs() = default;

Result<uint64_t> StorageImportJobs::Begin(content::StoragePartition* partition,
                                          const StorageImportData& data) {
  if (jobs_.size() >= 16)
    return {0, {ErrorCode::resource_limit, "Too many storage import jobs"}};
  const auto id = next_job_++;
  auto job = std::make_unique<Job>();
  job->partition = partition;
  jobs_.emplace(id, std::move(job));
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&StorageImportJobs::Start, weak_factory_.GetWeakPtr(), id, data));
  return {id, {}};
}

void StorageImportJobs::Start(uint64_t id, StorageImportData data) {
  auto& job = *jobs_.at(id);
  job.pending = data.cookies.size();
  for (const auto& origin : data.local_storage)
    job.pending += origin.items.size();
  auto* manager = job.partition->GetCookieManagerForBrowserProcess();
  const auto now = base::Time::Now();
  for (const auto& input : data.cookies) {
    const auto host = input.domain.starts_with('.') ? input.domain.substr(1) : input.domain;
    const GURL url(std::string(input.secure ? "https://" : "http://") + host + input.path);
    net::CookieInclusionStatus status;
    auto cookie = net::CanonicalCookie::CreateSanitizedCookie(
        url, input.name, input.value, input.host_only ? "" : input.domain, input.path, now,
        input.expires ? base::Time::FromMillisecondsSinceUnixEpoch(*input.expires) : base::Time(),
        now, input.secure, input.http_only, input.same_site, net::COOKIE_PRIORITY_DEFAULT,
        std::nullopt, &status);
    if (!cookie) {
      OnItem(id, true, false);
      continue;
    }
    manager->SetCanonicalCookie(
        *cookie, url, net::CookieOptions::MakeAllInclusive(),
        base::BindOnce(
            [](base::WeakPtr<StorageImportJobs> jobs, uint64_t id, net::CookieAccessResult result) {
              if (jobs)
                jobs->OnItem(id, true, result.status.IsInclude());
            },
            weak_factory_.GetWeakPtr(), id));
  }
  for (const auto& origin : data.local_storage) {
    mojo::Remote<blink::mojom::StorageArea> area;
    job.partition->GetLocalStorageControl()->BindStorageArea(
        blink::StorageKey::CreateFirstParty(url::Origin::Create(origin.origin)),
        area.BindNewPipeAndPassReceiver());
    for (const auto& [key, value] : origin.items)
      area->Put(EncodeLocalStorage(key), EncodeLocalStorage(value), std::nullopt, nullptr,
                base::BindOnce(&StorageImportJobs::OnItem, weak_factory_.GetWeakPtr(), id, false));
    job.areas.push_back(std::move(area));
  }
  MaybeFlush(id);
}

void StorageImportJobs::OnItem(uint64_t id, bool cookie, bool applied) {
  auto& job = *jobs_.at(id);
  auto& counts = cookie ? job.cookies : job.local_storage;
  if (applied)
    ++counts.applied;
  else
    ++counts.rejected;
  --job.pending;
  MaybeFlush(id);
}

void StorageImportJobs::MaybeFlush(uint64_t id) {
  auto& job = *jobs_.at(id);
  if (job.pending || job.flushing)
    return;
  job.flushing = true;
  // LocalStorageControl::Flush is one-way; issue it before awaiting the cookie flush.
  job.partition->GetLocalStorageControl()->Flush();
  job.partition->GetCookieManagerForBrowserProcess()->FlushCookieStore(
      base::BindOnce(&StorageImportJobs::OnFlushed, weak_factory_.GetWeakPtr(), id));
}

void StorageImportJobs::OnFlushed(uint64_t id) {
  auto& job = *jobs_.at(id);
  job.areas.clear();
  job.done = true;
}

Result<base::DictValue> StorageImportJobs::Poll(uint64_t id) {
  const auto found = jobs_.find(id);
  if (found == jobs_.end())
    return {{}, {ErrorCode::stale_identity, "Unknown storage import job"}};
  const auto& job = *found->second;
  base::DictValue value;
  value.Set("state", job.done ? "done" : "pending");
  if (job.done) {
    value.Set("cookies", job.cookies.Value());
    value.Set("localStorage", job.local_storage.Value());
    jobs_.erase(found);
  }
  return {std::move(value), {}};
}

void StorageImportJobs::Clear() {
  weak_factory_.InvalidateWeakPtrs();
  jobs_.clear();
}
}  // namespace remotekit::browser
