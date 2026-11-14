#pragma once

#include <array>
#include <deque>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/memory/weak_ptr.h"
#include "base/values.h"
#include "browser/view_model.h"
#include "net/cookies/cookie_constants.h"
#include "url/gurl.h"

namespace content {
class StoragePartition;
}

namespace remotekit::browser {
struct ImportedCookie {
  std::string name, value, domain, path;
  bool host_only = false, secure = false, http_only = false;
  net::CookieSameSite same_site = net::CookieSameSite::UNSPECIFIED;
  std::optional<int64_t> expires;
};

struct ImportedLocalStorage {
  GURL origin;
  std::vector<std::pair<std::u16string, std::u16string>> items;
};

struct StorageImportData {
  std::array<uint8_t, 32> fingerprint{};
  std::vector<ImportedCookie> cookies;
  std::vector<ImportedLocalStorage> local_storage;
};

class StorageImportJobs {
 public:
  StorageImportJobs();
  ~StorageImportJobs();
  Result<base::DictValue> Begin(content::StoragePartition*,
                                const std::string& import_id,
                                const StorageImportData&,
                                uint64_t view = 0);
  Result<base::DictValue> Poll(const std::string& import_id);
  void Cancel(const std::string& import_id);
  void Clear();

 private:
  friend class StorageImportJobsProbe;
  struct Job;
  void Start(std::string import_id, uint64_t serial, StorageImportData data);
  void OnItem(std::string import_id, uint64_t serial, bool cookie, bool applied);
  void MaybeFlush(const std::string& import_id);
  void OnFlushed(const std::string& import_id, uint64_t serial);
  void OnDropped(const std::string& import_id, uint64_t serial, bool item);
  void OnTimeout(const std::string& import_id, uint64_t serial, bool flushing);
  uint64_t Serial(const std::string& import_id) const;
  uint64_t next_serial_ = 0;

  std::map<std::string, std::unique_ptr<Job>> jobs_;
  std::deque<std::string> completed_;
  base::WeakPtrFactory<StorageImportJobs> weak_factory_{this};
};
}  // namespace remotekit::browser
