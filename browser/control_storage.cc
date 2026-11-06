#include "browser/control_dispatcher.h"

#include <cmath>
#include <map>

#include "base/strings/utf_string_conversions.h"
#include "browser/browser_runtime.h"
#include "browser/compat.h"
#include "browser/control_requests.h"
#include "browser/control_response.h"
#include "content/public/browser/storage_partition.h"
#include "url/origin.h"

namespace remotekit::browser {
namespace {
Status InvalidStorageImport() {
  return {ErrorCode::invalid_request, "Invalid storage import payload"};
}

Result<ImportedCookie> DecodeCookie(const base::Value& wire) {
  if (!wire.is_dict())
    return {{}, InvalidStorageImport()};
  const auto& value = wire.GetDict();
  RequestDecoder decoder(value);
  auto name = decoder.Optional<std::string>("name");
  auto content = decoder.Optional<std::string>("value");
  auto domain = decoder.Optional<std::string>("domain");
  auto path = decoder.Optional<std::string>("path");
  auto host_only = decoder.Optional<bool>("hostOnly");
  auto secure = decoder.Optional<bool>("secure");
  auto http_only = decoder.Optional<bool>("httpOnly");
  auto same_site = decoder.Optional<std::string>("sameSite");
  const auto* expires = value.Find("expires");
  if (!name || !content || !domain || !path || !host_only || !secure || !http_only || !same_site ||
      !expires || name->size() + content->size() > 4096 || domain->empty() ||
      (*host_only && domain->starts_with('.')))
    return {{}, InvalidStorageImport()};
  ImportedCookie cookie;
  cookie.name = std::move(*name);
  cookie.value = std::move(*content);
  cookie.domain = std::move(*domain);
  cookie.path = std::move(*path);
  cookie.host_only = *host_only;
  cookie.secure = *secure;
  cookie.http_only = *http_only;
  if (*same_site == "unspecified")
    cookie.same_site = net::CookieSameSite::UNSPECIFIED;
  else if (*same_site == "none")
    cookie.same_site = net::CookieSameSite::NO_RESTRICTION;
  else if (*same_site == "lax")
    cookie.same_site = net::CookieSameSite::LAX_MODE;
  else if (*same_site == "strict")
    cookie.same_site = net::CookieSameSite::STRICT_MODE;
  else
    return {{}, InvalidStorageImport()};
  if (!expires->is_none()) {
    if (!expires->is_int() && !expires->is_double())
      return {{}, InvalidStorageImport()};
    const double milliseconds = expires->GetDouble();
    if (!std::isfinite(milliseconds) || std::trunc(milliseconds) != milliseconds ||
        milliseconds < -9223372036854775808.0 || milliseconds >= 9223372036854775808.0)
      return {{}, InvalidStorageImport()};
    cookie.expires = static_cast<int64_t>(milliseconds);
  }
  return decoder.Finish(std::move(cookie));
}

base::ListValue Brands(const blink::UserAgentBrandList& brands) {
  base::ListValue values;
  for (const auto& brand : brands)
    values.Append(base::DictValue().Set("brand", brand.brand).Set("version", brand.version));
  return values;
}
}  // namespace

Result<IdentityRequest> DecodeIdentity(const base::DictValue& wire, RequestEnvelope envelope) {
  IdentityRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  return RequestDecoder(wire).Finish(std::move(request));
}

Result<StorageImportRequest> DecodeStorageImport(const base::DictValue& wire,
                                                 RequestEnvelope envelope) {
  StorageImportRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  auto cookies = decoder.Optional<base::ListValue>("cookies");
  auto local_storage = decoder.Optional<base::ListValue>("localStorage");
  if (!cookies || !local_storage || cookies->size() > 4096 || local_storage->size() > 256)
    return {{}, InvalidStorageImport()};
  for (const auto& value : *cookies) {
    auto cookie = DecodeCookie(value);
    if (!cookie)
      return {{}, cookie.status};
    request.data.cookies.push_back(std::move(cookie.value));
  }
  std::map<std::string, size_t> origin_bytes;
  for (const auto& value : *local_storage) {
    if (!value.is_dict())
      return {{}, InvalidStorageImport()};
    const auto* origin = value.GetDict().FindString("origin");
    const auto* items = value.GetDict().FindList("items");
    if (!origin || !items)
      return {{}, InvalidStorageImport()};
    const GURL url(*origin);
    if (!url.is_valid() || !url.SchemeIsHTTPOrHTTPS() ||
        url::Origin::Create(url).Serialize() != *origin)
      return {{}, InvalidStorageImport()};
    ImportedLocalStorage storage;
    storage.origin = url;
    auto& total = origin_bytes[*origin];
    for (const auto& item : *items) {
      if (!item.is_list() || item.GetList().size() != 2 || !item.GetList()[0].is_string() ||
          !item.GetList()[1].is_string())
        return {{}, InvalidStorageImport()};
      const auto& key = item.GetList()[0].GetString();
      const auto& content = item.GetList()[1].GetString();
      const auto bytes = key.size() + content.size();
      total += bytes;
      if (bytes > 256 * 1024 || total > 10 * 1024 * 1024)
        return {{}, InvalidStorageImport()};
      storage.items.emplace_back(base::UTF8ToUTF16(key), base::UTF8ToUTF16(content));
    }
    request.data.local_storage.push_back(std::move(storage));
  }
  return decoder.Finish(std::move(request));
}

Result<StorageImportStatusRequest> DecodeStorageImportStatus(const base::DictValue& wire,
                                                             RequestEnvelope envelope) {
  StorageImportStatusRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  const auto job = decoder.Optional<uint64_t>("job");
  if (!job)
    return {{}, {ErrorCode::invalid_request, "Invalid storage import job"}};
  request.job = *job;
  return decoder.Finish(std::move(request));
}

ControlResult ControlDispatcher::HandleIdentity(const IdentityRequest& request) {
  const auto metadata = ChromeUserAgentMetadata();
  base::DictValue value;
  value.Set("brands", Brands(metadata.brand_version_list));
  value.Set("fullVersionList", Brands(metadata.brand_full_version_list));
  value.Set("platform", metadata.platform);
  value.Set("platformVersion", metadata.platform_version);
  value.Set("architecture", metadata.architecture);
  value.Set("bitness", metadata.bitness);
  value.Set("wow64", metadata.wow64);
  value.Set("model", metadata.model);
  value.Set("mobile", metadata.mobile);
  return ControlResult::Success(
      request.id,
      base::DictValue().Set("userAgent", ChromeUserAgent()).Set("metadata", std::move(value)));
}

ControlResult ControlDispatcher::HandleStorageImport(const StorageImportRequest& request) {
  auto job = runtime_.storage_import_jobs.Begin(
      runtime_.contexts.front()->GetDefaultStoragePartition(), request.data);
  if (!job)
    return ControlResult::Failure(request.id, job.status.error, job.status.message);
  return ControlResult::Success(request.id,
                                base::DictValue().Set("job", base::NumberToString(job.value)));
}

ControlResult ControlDispatcher::HandleStorageImportStatus(
    const StorageImportStatusRequest& request) {
  auto status = runtime_.storage_import_jobs.Poll(request.job);
  if (!status)
    return ControlResult::Failure(request.id, status.status.error, status.status.message);
  return ControlResult::Success(request.id, std::move(status.value));
}
}  // namespace remotekit::browser
