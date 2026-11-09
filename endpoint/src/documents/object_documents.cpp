#include "documents/object_documents.hpp"

#include "documents/document_types.hpp"
#include "objects/service.hpp"
#include "util/result_macros.hpp"

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

ObjectDocuments::ObjectDocuments(objects::ObjectService& objects, std::filesystem::path data)
    : objects_(objects),
      data_(std::move(data)),
      tools_(DefaultToolsDirectory()),
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
                                                const std::filesystem::path& temporary) {
  std::lock_guard lock(mutex_);
  std::erase_if(jobs_, [](const auto& entry) { return entry.second.expires <= Clock::now(); });
  if (auto found = jobs_.find(source); found != jobs_.end())
    return found->second.future;
  auto promise = std::make_shared<std::promise<Result<std::string>>>();
  auto future = promise->get_future().share();
  jobs_.emplace(source, Job{future});
  if (!workers_.Submit([this, source, tenant, temporary, promise] {
        Result<std::string> result = Error{ErrorCode::kInternal, "document rendition failed"};
        try {
          result = Convert(source, tenant, temporary);
        } catch (const std::filesystem::filesystem_error& error) {
          result = Error{ErrorCode::kUnavailable, error.what()};
        } catch (const std::exception& error) {
          result = Error{ErrorCode::kInternal, error.what()};
        }
        std::lock_guard lock(mutex_);
        const bool conversion_failure =
            !result && (result.error().code == ErrorCode::kRejected ||
                        result.error().code == ErrorCode::kInvalidRequest);
        jobs_.at(source).expires = Clock::now() + (conversion_failure ? std::chrono::minutes(10)
                                                                      : std::chrono::minutes(0));
        promise->set_value(std::move(result));
      })) {
    jobs_.erase(source);
    promise->set_value(Error{ErrorCode::kBusy, "document workers busy"});
  }
  return future;
}

Result<std::string> ObjectDocuments::Convert(const std::string& source,
                                             const std::string& tenant,
                                             const std::filesystem::path& temporary) {
  RK_ASSIGN_OR_RETURN(derivation, objects_.Derivation(source, tenant));
  if (!derivation.is_null())
    return derivation["id"].get<std::string>();
  RK_ASSIGN_OR_RETURN(sources, objects_.Locate(source, Reference(tenant, source)));
  RK_RETURN_IF_ERROR(objects_.Ensure(source, sources));
  TemporaryDirectory staging(temporary);
  const auto plaintext = staging.path() / "input";
  std::ofstream output(plaintext, std::ios::binary);
  RK_RETURN_IF_ERROR(objects_.Store().Read(objects_.ObjectKeys(), source, output));
  output.close();
  if (!output)
    return Error{ErrorCode::kUnavailable, "cannot stage document"};
  RK_ASSIGN_OR_RETURN(format, DetectDocumentFile(plaintext));
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
                                   const std::filesystem::path& temporary) {
  RK_RETURN_IF_ERROR(Available());
  // Control answers busy while a conversion it requested runs on some node.
  auto lookup = objects_.Derivation(source, tenant);
  if (!lookup && lookup.error().code == ErrorCode::kBusy)
    return Json{{"state", "converting"}};
  RK_ASSIGN_OR_RETURN(derivation, std::move(lookup));
  if (!derivation.is_null())
    return Ready(derivation["id"].get<std::string>(), tenant, source);
  auto future = Submit(source, tenant, temporary);
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
  return Submit(source, {}, data_ / "documents/staging").get();
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
