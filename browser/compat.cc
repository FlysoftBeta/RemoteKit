#include "browser/compat.h"
#include "browser/profile_file.h"

#include <map>
#include <vector>
#include "base/files/file_util.h"
#include "base/files/important_file_writer.h"
#include "base/logging.h"
#include "base/task/thread_pool.h"
#include "base/task/sequenced_task_runner.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"

#include "base/functional/bind.h"
#include "base/strings/string_number_conversions.h"
#include "base/version_info/version_info.h"
#include "components/embedder_support/user_agent_utils.h"
#include "content/public/browser/client_hints_controller_delegate.h"
#include "content/public/browser/network_service_instance.h"
#include "services/network/public/cpp/network_quality_tracker.h"
#include "ui/gfx/geometry/size.h"
#include "url/origin.h"

namespace remotekit::browser {
namespace {
using Hint = network::mojom::WebClientHintsType;

class ProfileClientHintsDelegate final : public content::ClientHintsControllerDelegate {
 public:
  explicit ProfileClientHintsDelegate(const base::FilePath& profile)
      : tracker_(base::BindRepeating(&content::GetNetworkService)),
        file_(profile.AppendASCII("ClientHints.json")) {
    const auto file = ReadProfileFile(file_);
    if (file.state == ProfileFileState::kMissing)
      return;
    if (file.state == ProfileFileState::kReadFailed) {
      persistence_ = Persistence::kMemoryOnly;
      return;
    }
    auto data = base::JSONReader::ReadDict(file.text, base::JSON_PARSE_RFC);
    auto hints = data ? ParseClientHints(*data) : std::nullopt;
    if (!hints) {
      persistence_ = Persistence::kMemoryOnly;
      LOG(ERROR) << "Invalid ClientHints.json in " << file_;
      return;
    }
    hints_ = std::move(*hints);
  }
  network::NetworkQualityTracker* GetNetworkQualityTracker() override { return &tracker_; }
  void GetAllowedClientHintsFromSource(const url::Origin& origin,
                                       blink::EnabledClientHints* hints) override {
    auto it = hints_.find(origin);
    if (it != hints_.end()) {
      for (Hint hint : it->second)
        hints->SetIsEnabled(hint, true);
    }
    for (Hint hint : additional_)
      hints->SetIsEnabled(hint, true);
  }
  bool IsJavaScriptAllowed(const GURL&, content::RenderFrameHost*) override { return true; }
  blink::UserAgentMetadata GetUserAgentMetadata() override { return ChromeUserAgentMetadata(); }
  void PersistClientHints(const url::Origin& origin,
                          content::RenderFrameHost*,
                          const std::vector<Hint>& hints) override {
    if (origin.opaque())
      return;
    const auto found = hints_.find(origin);
    if (found != hints_.end() && found->second == hints)
      return;
    hints_[origin] = hints;
    Save();
  }
  void ResetForTesting() override {
    hints_.clear();
    Save();
    additional_.clear();
  }
  void SetAdditionalClientHints(const std::vector<Hint>& hints) override { additional_ = hints; }
  void ClearAdditionalClientHints() override { additional_.clear(); }
  void SetMostRecentMainFrameViewportSize(const gfx::Size& size) override { viewport_ = size; }
  gfx::Size GetMostRecentMainFrameViewportSize() override {
    return force_empty_ ? gfx::Size() : viewport_;
  }
  void ForceEmptyViewportSizeForTesting(bool force) override { force_empty_ = force; }
  bool ShouldForceEmptyViewportSize() override { return force_empty_; }

 private:
  void Save() {
    if (persistence_ == Persistence::kMemoryOnly)
      return;
    base::DictValue data;
    for (const auto& [origin, hints] : hints_) {
      base::ListValue values;
      for (auto hint : hints)
        values.Append(static_cast<int>(hint));
      data.Set(origin.Serialize(), std::move(values));
    }
    std::string text;
    CHECK(base::JSONWriter::Write(data, &text));
    writer_->PostTask(FROM_HERE,
                      base::BindOnce(
                          [](base::FilePath file, std::string json) {
                            if (!base::ImportantFileWriter::WriteFileAtomically(file, json))
                              LOG(ERROR) << "Cannot persist client hints in " << file;
                          },
                          file_, std::move(text)));
  }
  network::NetworkQualityTracker tracker_;
  base::FilePath file_;
  scoped_refptr<base::SequencedTaskRunner> writer_ = base::ThreadPool::CreateSequencedTaskRunner(
      {base::MayBlock(), base::TaskShutdownBehavior::BLOCK_SHUTDOWN});
  enum class Persistence { kWritable, kMemoryOnly };
  Persistence persistence_ = Persistence::kWritable;
  ClientHints hints_;
  std::vector<Hint> additional_;
  gfx::Size viewport_;
  bool force_empty_ = false;
};
}  // namespace

std::string ChromeUserAgent() {
  return embedder_support::GetUserAgent();
}

blink::UserAgentMetadata ChromeUserAgentMetadata() {
  auto metadata = embedder_support::GetUserAgentMetadata();
  if (metadata.brand_version_list.empty()) {
    return metadata;
  }
  const std::string major = version_info::GetMajorVersionNumber();
  int seed = 0;
  base::StringToInt(major, &seed);
  metadata.brand_version_list = embedder_support::GenerateBrandVersionList(
      seed, "Google Chrome", major, blink::UserAgentBrandVersionType::kMajorVersion);
  if (!metadata.brand_full_version_list.empty()) {
    metadata.brand_full_version_list = embedder_support::GenerateBrandVersionList(
        seed, "Google Chrome", std::string(version_info::GetVersionNumber()),
        blink::UserAgentBrandVersionType::kFullVersion);
  }
  return metadata;
}

blink::UserAgentOverride ChromeUserAgentOverride(bool tablet) {
  blink::UserAgentOverride ua;
  ua.ua_string_override = ChromeUserAgent();
  auto metadata = ChromeUserAgentMetadata();
  if (tablet) {
    ua.ua_string_override = embedder_support::BuildUserAgentFromOSAndProduct(
        "Linux; Android 10; K", "Chrome/" + version_info::GetMajorVersionNumber() + ".0.0.0");
    metadata.platform = "Android";
    metadata.platform_version = "13.0.0";
    metadata.architecture = "arm";
    metadata.bitness = "64";
    metadata.model.clear();
    metadata.mobile = false;
    metadata.wow64 = false;
    metadata.form_factors = {"Tablet"};
  }
  ua.ua_metadata_override = std::move(metadata);
  return ua;
}

std::unique_ptr<content::ClientHintsControllerDelegate> CreateClientHintsDelegate(
    const base::FilePath& profile) {
  return std::make_unique<ProfileClientHintsDelegate>(profile);
}
}  // namespace remotekit::browser
