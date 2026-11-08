#pragma once
#include "util/error.hpp"
#include "files/file_upload.hpp"
#include "objects/service.hpp"
#include "rtc/dc_services.hpp"
#include <filesystem>
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <set>

namespace remotekit {
// Drafts, selections and plaintext staging belong to this session.
class FileLibrary {
 public:
  using Check = std::function<Result<void>()>;
  struct Asset {
    std::string id, type;
    std::uint64_t size{};
    std::uint32_t width{}, height{};
    ServiceJson Json() const;
  };
  struct SelectionFile {
    std::string asset_id, name, type;
    bool operator==(const SelectionFile&) const = default;
  };
  struct Selection {
    std::string id, request_id;
    FileUploadStore::Binding binding;
    std::vector<SelectionFile> files;
    enum class State { pending, submitted, selected, cancelled } state = State::pending;
  };
  struct Derivative {
    std::uint32_t width, height;
  };
  enum class DerivativeFormat { jpeg, png };
  using Render = std::function<Result<Derivative>(const std::filesystem::path&)>;

  FileLibrary(std::filesystem::path root,
              objects::ObjectService& objects,
              std::string tenant,
              const objects::Keys& keys);
  Result<void> Initialize();
  Result<ServiceJson> Begin(std::uint64_t grant,
                            const std::string& operation,
                            const FileUploadStore::Spec&,
                            const Check&);
  Result<std::uint64_t> Chunk(std::uint64_t grant,
                              const std::string& upload,
                              std::uint64_t offset,
                              const std::vector<std::uint8_t>&,
                              const Check&);
  Result<Asset> Seal(std::uint64_t grant, const std::string& upload, const Check&);
  Result<Asset> ImportDownload(const std::filesystem::path& profile, const ServiceJson& download);
  Result<void> Cancel(std::uint64_t grant, const std::string& upload, const Check&);
  Result<Asset> Describe(const std::string& asset) const;
  Result<std::filesystem::path> Path(const std::string& asset) const;
  Result<std::pair<Asset, std::vector<std::uint8_t>>> Read(const std::string& asset,
                                                           std::uint64_t offset) const;
  Result<Asset> CreateDerivative(const Render&,
                                 const Check&,
                                 DerivativeFormat = DerivativeFormat::jpeg,
                                 const std::string& derived_from = {});
  Result<void> Sweep();
  ServiceJson Hibernation(const std::function<bool(uint64_t)>& current) const;

  Result<void> Prepare(const Selection&);
  std::optional<Selection> FindSelection(const std::string& id) const;
  Result<std::optional<Selection::State>> CancelPendingSelections(const FileUploadStore::Binding&,
                                                                  const Check&);
  Result<bool> Claim(const std::string& id, const Check&);
  Result<Selection::State> Finish(const std::string& id,
                                  Selection::State,
                                  std::optional<Selection::State> expected = std::nullopt);

 private:
  struct Entry {
    Asset asset;
  };
  struct Draft {
    std::string id, operation, sealed;
    FileUploadStore::Spec spec;
    std::int64_t expires;
    std::uint64_t grant{};  // Runtime only. A new grant must explicitly Begin.
  };
  std::filesystem::path root_;
  objects::ObjectService& objects_;
  const std::string tenant_;
  const objects::Keys& keys_;
  mutable std::mutex mutex_;
  mutable std::map<std::string, Entry> entries_;
  std::map<std::string, Draft> drafts_;
  std::map<std::string, Selection> selections_;
  std::uint64_t draft_bytes_{};
  std::int64_t sweep_after_{};

  std::filesystem::path DraftData(const std::string& id) const;
  Result<const Entry*> RequireAsset(const std::string& id) const;
  Result<Draft*> RequireDraft(std::uint64_t grant, const std::string& id);
  Result<void> SaveDraft(const Draft&, const Check&) const;
  Result<void> SaveEntry(const Entry&, const Check& = {}) const;
  Result<void> SaveSelection(const Selection&, const Check& = {}) const;
  bool EraseDraft(std::map<std::string, Draft>::iterator);
  Result<Asset> Publish(const std::filesystem::path&,
                        Asset,
                        const Check&,
                        const std::string& derived_from = {});
};
}  // namespace remotekit
