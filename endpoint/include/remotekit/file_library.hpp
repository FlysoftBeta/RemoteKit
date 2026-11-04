#pragma once
#include "remotekit/file_upload.hpp"
#include "remotekit/dc_services.hpp"
#include <filesystem>
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <set>

namespace remotekit {
// Session-private content store. The RTC worker is the only draft and
// derivative writer. Control may read/retain assets and prepare selections.
class FileLibrary {
 public:
  using Check = std::function<void()>;
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
  struct Derivative { std::uint32_t width, height; };
  enum class DerivativeFormat { jpeg, png };
  using Render = std::function<Derivative(const std::filesystem::path&)>;

  explicit FileLibrary(std::filesystem::path root);
  ServiceJson Begin(std::uint64_t grant, const std::string& operation, const FileUploadStore::Spec&, const Check&);
  std::uint64_t Chunk(std::uint64_t grant, const std::string& upload, std::uint64_t offset,
                      const std::vector<std::uint8_t>&, const Check&);
  Asset Seal(std::uint64_t grant, const std::string& upload, const Check&);
  void Cancel(std::uint64_t grant, const std::string& upload, const Check&);
  Asset Describe(const std::string& asset) const;
  std::filesystem::path Path(const std::string& asset) const;
  std::pair<Asset, std::vector<std::uint8_t>> Read(const std::string& asset, std::uint64_t offset) const;
  void Retain(const std::vector<std::string>& assets);
  void References(std::uint64_t revision, const std::vector<std::string>& assets);
  Asset CreateDerivative(const Render&, const Check&, DerivativeFormat = DerivativeFormat::jpeg);
  void Sweep();

  void Prepare(const Selection&);
  std::optional<Selection> FindSelection(const std::string& id) const;
  bool Claim(const std::string& id, const Check&);
  Selection::State Finish(const std::string& id, Selection::State,
                          std::optional<Selection::State> expected = std::nullopt);

 private:
  struct Entry { Asset asset; std::int64_t expires; };
  struct Draft {
    std::string id, operation, sealed;
    FileUploadStore::Spec spec;
    std::int64_t expires;
    std::uint64_t grant{};  // Runtime only. A new grant must explicitly Begin.
  };
  std::filesystem::path root_;
  mutable std::mutex mutex_;
  std::map<std::string,Entry> entries_;
  std::map<std::string,Draft> drafts_;
  std::map<std::string,Selection> selections_;
  std::set<std::string> references_;
  std::optional<std::uint64_t> reference_revision_;
  std::uint64_t asset_bytes_{}, draft_bytes_{};
  std::int64_t sweep_after_{};

  std::filesystem::path Payload(const std::string& id) const;
  std::filesystem::path DraftData(const std::string& id) const;
  const Entry& RequireAsset(const std::string& id) const;
  Draft& RequireDraft(std::uint64_t grant, const std::string& id);
  void SaveDraft(const Draft&, const Check&) const;
  void SaveEntry(const Entry&, const Check& = {}) const;
  void SaveSelection(const Selection&, const Check& = {}) const;
  bool EraseDraft(std::map<std::string,Draft>::iterator);
  Asset Publish(const std::filesystem::path&, Asset, const Check&);
};
}
