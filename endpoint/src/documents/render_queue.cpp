#include "documents/render_queue.hpp"

#include "documents/office_converter.hpp"
#include "documents/pdf_renderer.hpp"
#include "documents/render_archive.hpp"

#include <fstream>

namespace remotekit::documents {
namespace {
class Engine {
 public:
  Engine(const std::filesystem::path& data, const std::filesystem::path& tools)
      : data_(std::filesystem::absolute(data) / "documents"),
        converter_(data, tools),
        renderer_(tools) {}

  Result<RenditionResult> Render(size_t slot,
                                 const std::string& source_id,
                                 const std::filesystem::path& plaintext,
                                 const std::string& name) {
    std::ifstream input(plaintext, std::ios::binary);
    if (!input)
      return Error{ErrorCode::kUnavailable, "Cannot open staged source document"};
    Bytes prefix(4096);
    input.read(reinterpret_cast<char*>(prefix.data()), prefix.size());
    prefix.resize(static_cast<size_t>(input.gcount()));
    input.close();
    auto format = DetectDocument(name, prefix);
    if (format.type == DocumentType::kUnsupported)
      return Error{ErrorCode::kRejected, "Unsupported document type",
                   ErrorReason::kDocumentUnsupported};
    TemporaryDirectory temporary(data_ / "work");
    auto pdf = temporary.path() / "input.pdf";
    if (format.type == DocumentType::kPdf) {
      std::filesystem::copy_file(plaintext, pdf);
    } else {
      auto converted = converter_.Convert(plaintext, format, slot, pdf);
      if (!converted)
        return converted.error();
    }
    auto archive = temporary.path() / "render.zip";
    auto rendered = renderer_.Render(pdf, archive);
    if (!rendered)
      return rendered.error();
    auto checked = RenderArchive::OpenFile(archive);
    if (!checked)
      return checked.error();
    std::filesystem::create_directories(data_ / "archives");
    auto id =
        Sha256Hex(std::span(reinterpret_cast<const uint8_t*>(source_id.data()), source_id.size()));
    auto destination =
        data_ / "archives" / (id + "-" + temporary.path().filename().string() + ".zip");
    uint64_t size = std::filesystem::file_size(archive);
    std::filesystem::rename(archive, destination);
    return RenditionResult{destination, size};
  }

 private:
  std::filesystem::path data_;
  OfficeConverter converter_;
  PdfRenderer renderer_;
};

RenderQueue::Future Ready(Error error) {
  std::promise<Result<RenditionResult>> promise;
  promise.set_value(std::move(error));
  return promise.get_future().share();
}
}  // namespace

RenderQueue::RenderQueue(const std::filesystem::path& data_directory,
                         const std::filesystem::path& tools_directory)
    : RenderQueue(
          [engine = std::make_shared<Engine>(data_directory, tools_directory)](
              size_t slot,
              const std::string& id,
              const std::filesystem::path& plaintext,
              const std::string& name) { return engine->Render(slot, id, plaintext, name); }) {}

RenderQueue::RenderQueue(Worker worker) : worker_(std::move(worker)) {
  try {
    for (size_t slot = 0; slot < threads_.size(); ++slot)
      threads_[slot] = std::thread([this, slot] { Work(slot); });
  } catch (...) {
    {
      std::lock_guard lock(mutex_);
      stopping_ = true;
    }
    ready_.notify_all();
    for (auto& thread : threads_) {
      if (thread.joinable())
        thread.join();
    }
    throw;
  }
}

RenderQueue::~RenderQueue() {
  {
    std::lock_guard lock(mutex_);
    stopping_ = true;
  }
  ready_.notify_all();
  for (auto& thread : threads_)
    thread.join();
}

RenderQueue::Future RenderQueue::Submit(const std::string& source_id,
                                        const std::filesystem::path& plaintext,
                                        std::string_view name) {
  std::lock_guard lock(mutex_);
  if (auto found = active_.find(source_id); found != active_.end())
    return found->second;
  if (source_id.empty())
    return Ready({ErrorCode::kInvalidRequest, "source ID missing"});
  if (stopping_)
    return Ready({ErrorCode::kUnavailable, "document queue stopping"});
  if (pending_.size() >= 64)
    return Ready({ErrorCode::kBusy, "document queue full"});
  auto job = std::make_shared<Job>();
  job->source_id = source_id;
  job->plaintext = plaintext;
  job->name = name;
  auto future = job->promise.get_future().share();
  active_.emplace(source_id, future);
  pending_.push_back(std::move(job));
  ready_.notify_one();
  return future;
}

Result<RenditionResult> RenderQueue::Render(const std::string& source_id,
                                            const std::filesystem::path& plaintext,
                                            std::string_view name) {
  return Submit(source_id, plaintext, name).get();
}

void RenderQueue::Work(size_t slot) {
  for (;;) {
    std::shared_ptr<Job> job;
    {
      std::unique_lock lock(mutex_);
      ready_.wait(lock, [this] { return stopping_ || !pending_.empty(); });
      if (pending_.empty())
        return;
      job = std::move(pending_.front());
      pending_.pop_front();
    }
    Result<RenditionResult> result = Error{ErrorCode::kInternal, "document rendition failed"};
    try {
      result = worker_(slot, job->source_id, job->plaintext, job->name);
    } catch (const std::filesystem::filesystem_error& error) {
      result = Error{ErrorCode::kUnavailable, error.what()};
    } catch (const std::exception& error) {
      result = Error{ErrorCode::kInternal, error.what()};
    }
    {
      std::lock_guard lock(mutex_);
      job->promise.set_value(std::move(result));
      active_.erase(job->source_id);
    }
  }
}
}  // namespace remotekit::documents
