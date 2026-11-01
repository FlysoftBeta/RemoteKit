#pragma once
#include <cstdint>
#include <cstddef>
#include <deque>
#include <stdexcept>

namespace remotekit {
// One instance per imported generation. Only the polling owner mutates it.
// Values are observed producer publications, not a contiguous integer sequence.
class SharedLeaseRetirement {
 public:
  struct Entry { uint64_t value, cookie; };
  void Observe(uint64_t value,uint64_t cookie) {
    if(!value || value<=last_observed_)throw std::logic_error("shared lease fence regressed");
    entries_.push_back({value,cookie});last_observed_=value;
  }
  template<class Released> uint64_t SafePrefix(Released released) const {
    uint64_t prefix=last_observed_;
    // Every skipped value is older than a CPU-ready observed publication and
    // was never exposed by this consumer. It needs no pixel lease. The first
    // still-readable record is the strict upper bound for cumulative ack.
    for(const auto& entry:entries_) {if(!released(entry.cookie)){prefix=entry.value-1;break;}}
    return prefix>retired_prefix_?prefix:0;
  }
  // Commit only after both GPU consumed and local completion signals succeed.
  template<class Retired> void Commit(uint64_t prefix,Retired retired) {
    if(prefix<=retired_prefix_ || prefix>last_observed_)throw std::logic_error("invalid shared retirement prefix");
    while(!entries_.empty() && entries_.front().value<=prefix) {
      retired(entries_.front().cookie);entries_.pop_front();
    }
    retired_prefix_=prefix;
  }
  uint64_t retired_prefix() const {return retired_prefix_;}
  std::size_t size() const {return entries_.size();}
 private:
  std::deque<Entry> entries_;
  uint64_t last_observed_=0,retired_prefix_=0;
};
}
