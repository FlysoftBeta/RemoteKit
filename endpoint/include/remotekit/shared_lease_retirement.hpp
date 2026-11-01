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
  // Caller must first observe a valid producer GPU completed value >= value
  // on the CPU. This proof belongs to this imported generation and remains
  // valid if a later fence query reports device removal.
  void Observe(uint64_t value,uint64_t cookie) {
    if(terminal_requested_)throw std::logic_error("shared generation already retiring");
    if(!value || value==UINT64_MAX || value<=last_observed_)throw std::logic_error("shared lease fence regressed");
    entries_.push_back({value,cookie});last_observed_=value;
  }
  // Seal a stopped generation without inventing a pixel lease for its final
  // unborrowed publications. An equal watermark reuses this generation's
  // existing CPU-ready observation. A higher terminal still needs a valid
  // current GPU completion observation before it can enlarge the prefix.
  bool ObserveUnborrowedThrough(uint64_t value,uint64_t producer_completed) {
    if(!value || value==UINT64_MAX || value<last_observed_ ||
       (terminal_requested_ && terminal_value_!=value))
      throw std::logic_error("invalid shared terminal watermark");
    terminal_requested_=true;terminal_value_=value;
    if(value!=last_observed_ &&
       (producer_completed==UINT64_MAX || producer_completed<value))return false;
    terminal_ready_=true;last_observed_=value;return true;
  }
  bool terminal_ready() const {return terminal_ready_;}
  uint64_t terminal_value() const {return terminal_value_;}
  uint64_t last_observed() const {return last_observed_;}
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
  uint64_t last_observed_=0,retired_prefix_=0,terminal_value_=0;
  bool terminal_requested_=false,terminal_ready_=false;
};
}
