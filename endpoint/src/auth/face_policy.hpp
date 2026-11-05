#pragma once

#include "auth/face_engine.hpp"

#include <chrono>
#include <deque>
#include <vector>

namespace rk::auth {

class FaceWindow {
 public:
  using Clock = std::chrono::steady_clock;

  std::optional<FaceTemplate> Observe(Clock::time_point received,
                                      const std::optional<FaceTemplate>& value,
                                      uint64_t hash,
                                      const std::optional<FaceTemplate>& reference) {
    using namespace std::chrono_literals;
    observations_.push_back({received, value, hash});
    while (observations_.size() > 5 || received - observations_.front().received > 1000ms)
      observations_.pop_front();

    const FaceTemplate* anchor = reference ? &*reference : nullptr;
    std::vector<const Observation*> matches;
    for (const auto& observation : observations_) {
      if (!observation.value)
        continue;
      if (!anchor)
        anchor = &*observation.value;
      if (Similarity(*anchor, *observation.value) < kMatchThreshold)
        continue;
      matches.push_back(&observation);
    }
    for (size_t a = 0; a < matches.size(); ++a) {
      for (size_t b = a + 1; b < matches.size(); ++b) {
        for (size_t c = b + 1; c < matches.size(); ++c) {
          const auto* first = matches[a];
          const auto* middle = matches[b];
          const auto* last = matches[c];
          if (first->hash == middle->hash || first->hash == last->hash ||
              middle->hash == last->hash || last->received - first->received < 400ms)
            continue;
          FaceTemplate mean{};
          for (const auto* sample : {first, middle, last}) {
            for (size_t i = 0; i < mean.size(); ++i)
              mean[i] += (*sample->value)[i];
          }
          return Normalize(mean) ? std::optional(mean) : std::nullopt;
        }
      }
    }
    return std::nullopt;
  }

 private:
  struct Observation {
    Clock::time_point received;
    std::optional<FaceTemplate> value;
    uint64_t hash;
  };
  std::deque<Observation> observations_;
};

}  // namespace rk::auth
