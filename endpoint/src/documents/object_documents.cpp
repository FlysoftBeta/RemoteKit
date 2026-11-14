#include "documents/object_documents.hpp"

#include "documents/document_types.hpp"
#include "objects/service.hpp"
#include "util/result_macros.hpp"
#include "util/file_io.hpp"
#include "persistence/durable_json.hpp"
#include "persistence/document_job_formats.hpp"

#include <fstream>

namespace remotekit::documents {
namespace {
Json Reference(const std::string& tenant, const std::string& source) {
  Json reference{{"tenantId", tenant}};
  if (tenant.empty())
    reference["renderSource"] = source;
  return reference;
}
}  // namespace

ObjectDocuments::ObjectDocuments(objects::ObjectService& objects,
                                 std::filesystem::path data,
                                 std::string build,
                                 WriteRecord write_record)
    : objects_(objects),
      data_(std::move(data)),
      tools_(DefaultToolsDirectory()),
      build_(std::move(build)),
      write_record_(std::move(write_record)),
      renders_(data_, tools_) {}

ObjectDocuments::~ObjectDocuments() {
  workers_.Stop();
}

Result<void> ObjectDocuments::Available() const {
  if (!std::filesystem::is_regular_file(tools_ / "libreoffice/program/soffice.com") ||
      !std::filesystem::is_regular_file(tools_ / "pdfrender/pdfrender.exe"))
    return Error{ErrorCode::kUnavailable, "document tools unavailable"};
  return {};
}

ObjectDocuments::Future ObjectDocuments::Submit(const std::string& source,
                                                const std::string& tenant,
                                                const std::filesystem::path& temporary,
                                                const std::string& media_type) {
  std::lock_guard lock(mutex_);
  std::erase_if(jobs_, [](const auto& entry) { return entry.second.expires <= Clock::now(); });
  const auto identity = Json::array({source, tenant}).dump();
  const auto key =
      Sha256Hex(std::span(reinterpret_cast<const uint8_t*>(identity.data()), identity.size()));
  const auto input =
      Json::array({source, tenant, media_type, build_, objects_.ConnectionEpoch()}).dump();
  const auto path = data_ / "documents/jobs" / (key + ".json");
  auto& job = jobs_[key];
  if (job.future.valid() &&
      job.future.wait_for(std::chrono::seconds(0)) != std::future_status::ready)
    return job.future;
  const bool same_input = job.retry.Identity() == input;
  job.retry.Input(input);
  job.persistence.Input(input);
  if (!same_input) {
    job.pending_result.reset();
    job.pending_retry.reset();
    job.pending_record.reset();
  }
  const auto completed = [&](Result<std::string> result) {
    std::promise<Result<std::string>> ready;
    ready.set_value(std::move(result));
    job.future = ready.get_future().share();
    return job.future;
  };
  if (job.pending_result)
    return completed(Publish(job, path));
  if (!job.retry.Ready())
    return job.future.valid() ? job.future : completed(*job.retry.Failure());
  if (!job.loaded) {
    const auto load = [&]() -> Result<void> {
      RK_ASSIGN_OR_RETURN(bytes, ReadFileIfExists(path));
      if (!bytes)
        return {};
      RK_ASSIGN_OR_RETURN(record, document_job_formats::Decode(*bytes));
      RK_RETURN_IF_ERROR(job.retry.Restore(record.at("retry")));
      job.retry.Input(input);
      return {};
    };
    auto loaded = load();
    if (!loaded) {
      job.retry.Fail(loaded.error());
      return completed(loaded.error());
    }
    job.loaded = true;
    if (!job.retry.Ready())
      return completed(*job.retry.Failure());
  }
  if (same_input && job.future.valid() && job.future.get())
    return job.future;
  auto promise = std::make_shared<std::promise<Result<std::string>>>();
  auto future = promise->get_future().share();
  job.future = future;
  job.expires = Clock::time_point::max();
  const auto finish = [this, key, path, promise](Result<std::string> result) {
    auto& job = jobs_.at(key);
    job.pending_retry = job.retry;
    if (result)
      job.pending_retry->Success();
    else
      job.pending_retry->Fail(result.error());
    job.pending_record = {
        {"version", 1}, {"buildId", build_}, {"retry", job.pending_retry->Save()}};
    job.pending_result = std::move(result);
    promise->set_value(Publish(job, path));
  };
  if (!workers_.Submit([this, source, tenant, temporary, media_type, finish] {
        Result<std::string> result = Error{ErrorCode::kInternal, "document rendition failed"};
        try {
          result = Convert(source, tenant, temporary, media_type);
        } catch (const std::filesystem::filesystem_error& error) {
          result = WithOsError(ErrorCode::kUnavailable, error.what(), OsError::Kind::kWin32,
                               error.code().value());
        } catch (const std::exception& error) {
          result = Error{ErrorCode::kInternal, error.what()};
        } catch (...) {
          result = Error{ErrorCode::kInternal, "document rendition failed"};
        }
        std::lock_guard lock(mutex_);
        finish(std::move(result));
      })) {
    finish(Error{ErrorCode::kBusy, "document workers busy"});
  }
  return future;
}

Result<std::string> ObjectDocuments::Publish(Job& job, const std::filesystem::path& path) {
  if (!job.persistence.Ready())
    return *job.persistence.Failure();
  auto saved = write_record_(path, *job.pending_record);
  if (!saved) {
    job.persistence.Fail(saved.error());
    return saved.error();
  }
  job.persistence.Success();
  job.retry = std::move(*job.pending_retry);
  auto result = std::move(*job.pending_result);
  job.pending_result.reset();
  job.pending_retry.reset();
  job.pending_record.reset();
  if (result)
    job.expires = Clock::now() + std::chrono::minutes(10);
  return result;
}

Result<std::string> ObjectDocuments::Convert(const std::string& source,
                                             const std::string& tenant,
                                             const std::filesystem::path& temporary,
                                             const std::string& media_type) {
  RK_ASSIGN_OR_RETURN(derivation, objects_.Derivation(source, tenant));
  if (!derivation.is_null())
    return derivation["id"].get<std::string>();
  RK_RETURN_IF_ERROR(Available());
  RK_ASSIGN_OR_RETURN(sources, objects_.Locate(source, Reference(tenant, source)));
  RK_RETURN_IF_ERROR(objects_.Ensure(source, sources));
  TemporaryDirectory staging(temporary);
  const auto plaintext = staging.path() / "input";
  std::ofstream output(plaintext, std::ios::binary);
  RK_RETURN_IF_ERROR(objects_.Store().Read(objects_.ObjectKeys(), source, output));
  output.close();
  if (!output)
    return Error{ErrorCode::kUnavailable, "cannot stage document"};
  RK_ASSIGN_OR_RETURN(format, DetectDocumentFile(plaintext, media_type));
  if (format.type == DocumentType::kUnsupported)
    return Error{ErrorCode::kRejected, "Unsupported document type",
                 ErrorReason::kDocumentUnsupported};
  auto rendered_result = renders_.Render(source, plaintext, "input" + format.extension);
  if (!rendered_result)
    return rendered_result.error();
  auto rendered = std::move(rendered_result).value();
  struct Cleanup {
    std::filesystem::path path;
    ~Cleanup() {
      std::error_code error;
      std::filesystem::remove(path, error);
    }
  } cleanup{rendered.archive};
  Json claim{{"derivedFrom", source}, {"kind", "document"}};
  if (!tenant.empty())
    claim["tenantId"] = tenant;
  RK_ASSIGN_OR_RETURN(info, objects_.Write(rendered.archive, {}, claim));
  return info.id;
}

Result<Json> ObjectDocuments::Open(const std::string& source,
                                   const std::string& tenant,
                                   const std::filesystem::path& temporary,
                                   const std::string& media_type) {
  RK_RETURN_IF_ERROR(Available());
  // Control answers busy while a conversion it requested runs on some node.
  auto lookup = objects_.Derivation(source, tenant);
  if (!lookup && lookup.error().code == ErrorCode::kBusy)
    return Json{{"state", "converting"}};
  RK_ASSIGN_OR_RETURN(derivation, std::move(lookup));
  if (!derivation.is_null())
    return Ready(derivation["id"].get<std::string>(), tenant, source);
  auto future = Submit(source, tenant, temporary, media_type);
  if (future.wait_for(std::chrono::seconds(0)) != std::future_status::ready)
    return Json{{"state", "converting"}};
  auto converted = future.get();
  if (!converted && converted.error().code == ErrorCode::kBusy)
    return Json{{"state", "converting"}};
  RK_ASSIGN_OR_RETURN(document, std::move(converted));
  return Ready(document, tenant, source);
}

Result<std::string> ObjectDocuments::Render(const std::string& source) {
  RK_RETURN_IF_ERROR(Available());
  return Submit(source, {}, data_ / "documents/staging", {}).get();
}

Result<Json> ObjectDocuments::Ready(const std::string& document,
                                    const std::string& tenant,
                                    const std::string& source) {
  RK_ASSIGN_OR_RETURN(sources, objects_.Locate(document, Reference(tenant, source)));
  RK_RETURN_IF_ERROR(objects_.Ensure(document, sources));
  RK_ASSIGN_OR_RETURN(archive, Archive(document));
  RK_ASSIGN_OR_RETURN(info, archive.Info());
  Json pages = Json::array();
  for (const auto& page : info.pages)
    pages.push_back({{"id", page.id},
                     {"ordinal", page.ordinal},
                     {"width", page.width},
                     {"height", page.height},
                     {"document", page.document},
                     {"dependencies", page.dependencies}});
  return Json{
      {"state", "ready"}, {"documentId", document}, {"pages", pages}, {"shared", info.shared}};
}

Result<RenderArchive> ObjectDocuments::Archive(const std::string& document) {
  std::lock_guard lock(mutex_);
  auto found = std::find_if(archives_.begin(), archives_.end(),
                            [&](const auto& entry) { return entry.first == document; });
  if (found != archives_.end()) {
    archives_.splice(archives_.begin(), archives_, found);
    return archives_.front().second;
  }
  RK_ASSIGN_OR_RETURN(info, objects_.Store().Inspect(document));
  RK_ASSIGN_OR_RETURN(archive, RenderArchive::Open(
                                   [this, document](uint64_t offset, size_t length) {
                                     return objects_.Store().ReadRange(objects_.ObjectKeys(),
                                                                       document, offset, length);
                                   },
                                   info.size));
  archives_.emplace_front(document, archive);
  if (archives_.size() > 8)
    archives_.pop_back();
  return archive;
}

Result<ObjectDocuments::ResourceChunk> ObjectDocuments::Resource(const std::string& document,
                                                                 const std::string& content,
                                                                 uint64_t offset) {
  RK_RETURN_IF_ERROR(Available());
  RK_ASSIGN_OR_RETURN(archive, Archive(document));
  RK_ASSIGN_OR_RETURN(resource, archive.Resource(content));
  auto& [mime, bytes] = resource;
  if (offset > bytes.size())
    return Error{ErrorCode::kInvalidRequest, "invalid document resource offset"};
  const auto total = bytes.size();
  const auto length = std::min<uint64_t>(16384, total - offset);
  Bytes chunk(bytes.begin() + offset, bytes.begin() + offset + length);
  return ResourceChunk{std::move(mime), std::move(chunk), total};
}
}  // namespace remotekit::documents
