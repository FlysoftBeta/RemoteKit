#ifndef REMOTEKIT_BROWSER_NAVIGATION_OPERATIONS_H_
#define REMOTEKIT_BROWSER_NAVIGATION_OPERATIONS_H_
#include <cstdint>
#include <map>
#include <string>
#include <utility>
namespace remotekit::browser {
// UI-sequence state machine, independent of Chromium for direct CPU tests.
class NavigationOperations {
 public:
  struct Identity { std::string id, generation; std::uint64_t sequence = 0; };
  struct Record {
    Identity identity;
    std::string payload, state = "accepted", url, error;
    std::int64_t navigation_id = 0;
    std::map<std::int64_t, std::string> handles;
    bool collecting = true;
    bool admitted = false;
    // Main-frame document commit is independent of the operation outcome:
    // Chromium can commit an error document while the navigation fails.
    bool document_committed = false;
    bool is_error_page = false;
    bool terminal() const { return state != "accepted" && state != "started"; }
  };
  enum class Acceptance { fresh, duplicate, conflict, stale, full, invalid };
  Acceptance Check(const Identity& identity, const std::string& payload) const {
    if (identity.id.empty() || identity.id.size() > 128 || identity.generation.empty() ||
        identity.generation.size() > 128 || !identity.sequence) return Acceptance::invalid;
    auto key = std::make_pair(identity.generation, identity.id);
    auto found = records_.find(key);
    if (found != records_.end())
      return found->second.payload == payload && found->second.identity.sequence == identity.sequence
                 ? Acceptance::duplicate : Acceptance::conflict;
    if (identity.sequence <= high_water_) return Acceptance::stale;
    if (records_.size() >= 128) return Acceptance::full;
    return Acceptance::fresh;
  }
  Acceptance Accept(const Identity& identity, const std::string& payload) {
    const auto checked = Check(identity, payload);
    if (checked != Acceptance::fresh) return checked;
    high_water_ = identity.sequence;
    Record record; record.identity = identity; record.payload = payload;
    records_.emplace(std::make_pair(identity.generation, identity.id), std::move(record));
    return Acceptance::fresh;
  }
  Record* Find(const Identity& identity) {
    auto found = records_.find({identity.generation, identity.id});
    return found == records_.end() ? nullptr : &found->second;
  }
  Record* ByNavigation(std::int64_t id) {
    for (auto& [key, record] : records_)
      if (auto handle = record.handles.find(id); handle != record.handles.end() &&
          handle->second.empty() && !record.terminal()) return &record;
    return nullptr;
  }
  void Finish(Record& record, std::string state, std::string error = {}) {
    if (record.terminal()) return;
    record.state = std::move(state); record.error = std::move(error);
  }
  void Bind(Record& record, std::int64_t id, bool primary, bool started,
            std::string url) {
    if (record.terminal()) return;
    record.handles.try_emplace(id, "");
    if (primary) { record.navigation_id = id; record.url = std::move(url); }
    if (started) record.state = "started";
  }
  void Complete(Record& record, std::int64_t id, std::string state,
                std::string error = {}, bool document_committed = false,
                bool is_error_page = false) {
    if (record.terminal()) return;
    auto found = record.handles.find(id);
    if (found == record.handles.end() || !found->second.empty()) return;
    if (id == record.navigation_id) {
      record.document_committed = document_committed;
      record.is_error_page = document_committed && is_error_page;
    }
    found->second = std::move(state);
    if (!error.empty()) record.error = std::move(error);
    Settle(record);
  }
  void EndCollection(Record& record) { record.collecting = false; Settle(record); }
  void Supersede(const Identity* except = nullptr) {
    for (auto& [key, record] : records_) {
      if (except && record.identity.id == except->id &&
          record.identity.generation == except->generation) continue;
      Finish(record, "superseded", "new_navigation_operation");
    }
  }
  bool Ack(const Identity& identity) {
    auto found = records_.find({identity.generation, identity.id});
    if (found == records_.end()) return true;
    if (!found->second.terminal()) return false;
    records_.erase(found); return true;
  }
  const auto& records() const { return records_; }
 private:
  void Settle(Record& record) {
    if (record.terminal() || record.collecting || record.handles.empty()) return;
    std::string result = "committed";
    for (const auto& [id, state] : record.handles) {
      if (state.empty()) return;
      if (state == "failed") result = "failed";
      else if (state == "cancelled" && result != "failed") result = "cancelled";
    }
    auto error = record.error;
    Finish(record, result, std::move(error));
  }
  std::uint64_t high_water_ = 0;
  std::map<std::pair<std::string, std::string>, Record> records_;
};
}  // namespace remotekit::browser
#endif
