#pragma once
#include "util/common.hpp"
#include <algorithm>
#include <deque>
namespace remotekit {
class FrameMetadata {
 public:
  void Bind(uint64_t peer, uint64_t authorization, uint64_t epoch) {
    if (peer == peer_ && authorization == authorization_ && epoch == epoch_)
      return;
    peer_ = peer;
    authorization_ = authorization;
    epoch_ = epoch;
    messages_.clear();
    pending_.clear();
  }
  void Remember(Json message) {
    const auto rtp = message.at("rtpTimestamp").get<uint32_t>();
    messages_.emplace_back(rtp, std::move(message));
    pending_.push_back(rtp);
    if (messages_.size() > 256) {
      const auto expired = messages_.front().first;
      messages_.pop_front();
      std::erase(pending_, expired);
    }
  }
  void Request(uint32_t rtp) {
    if (std::ranges::any_of(messages_, [rtp](const auto& item) { return item.first == rtp; }) &&
        std::ranges::find(pending_, rtp) == pending_.end())
      pending_.push_back(rtp);
  }
  template <class Send>
  void Flush(Send send) {
    while (!pending_.empty()) {
      const auto rtp = pending_.front();
      const auto found =
          std::ranges::find(messages_, rtp, [](const auto& item) { return item.first; });
      if (found != messages_.end() && !send(found->second))
        return;
      pending_.pop_front();
    }
  }

 private:
  uint64_t peer_ = 0, authorization_ = 0, epoch_ = 0;
  std::deque<std::pair<uint32_t, Json>> messages_;
  std::deque<uint32_t> pending_;
};
}  // namespace remotekit
