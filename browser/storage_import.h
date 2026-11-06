#pragma once

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
  std::vector<ImportedCookie> cookies;
  std::vector<ImportedLocalStorage> local_storage;
};

class StorageImportJobs {
 public:
  StorageImportJobs();
  ~StorageImportJobs();
  Result<uint64_t> Begin(content::StoragePartition*, const StorageImportData&);
  Result<base::DictValue> Poll(uint64_t job);
  void Clear();

 private:
  struct Job;
  void Start(uint64_t job, StorageImportData data);
  void OnItem(uint64_t job, bool cookie, bool applied);
  void MaybeFlush(uint64_t job);
  void OnFlushed(uint64_t job);

  uint64_t next_job_ = 1;
  std::map<uint64_t, std::unique_ptr<Job>> jobs_;
  base::WeakPtrFactory<StorageImportJobs> weak_factory_{this};
};
}  // namespace remotekit::browser
