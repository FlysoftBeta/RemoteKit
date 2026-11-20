#pragma once

#include "auth/face_engine.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <deque>
#include <set>
#include <utility>
#include <vector>

namespace rk::auth {

inline constexpr float kMinInterOcular = 18;
inline constexpr float kMinSharpness = 12;
inline constexpr float kMinLuma = 15;
inline constexpr float kMaxLuma = 235;

inline FaceGate QualityGate(const FaceInference& inference) {
  if (inference.gate != FaceGate::none)
    return inference.gate;
  if (!inference.feature)
    return FaceGate::embedding;
  const auto live_gate = PerFrameLiveGate(inference.live_v1se, inference.live_v2);
  if (live_gate != FaceGate::none)
    return live_gate;
  const auto& quality = inference.quality;
  if (quality.inter_ocular < kMinInterOcular)
    return FaceGate::too_far;
  if (quality.mean_luma < kMinLuma || quality.dark_fraction > 0.65f)
    return FaceGate::too_dark;
  if (quality.mean_luma > kMaxLuma || quality.bright_fraction > 0.65f)
    return FaceGate::too_bright;
  if (quality.mean_luma < 20 && quality.backlight > 120)
    return FaceGate::backlit;
  if (quality.sharpness < kMinSharpness)
    return FaceGate::blurry;
  return FaceGate::none;
}

inline FaceGate AggregateLiveGate(float first, float second) {
  if (first < 0.70f)
    return FaceGate::live_set_v1se;
  if (second < 0.70f)
    return FaceGate::live_set_v2;
  return (first + second) * 0.5f < 0.90f ? FaceGate::live_mean : FaceGate::none;
}

struct FaceCluster {
  FaceTemplate value{};
  FaceQuality quality;
  std::array<FaceTemplate, 3> frames;
  uint64_t last_hash = 0;
  float live1 = 0;
  float live2 = 0;
};

class FaceWindow {
 public:
  using Clock = std::chrono::steady_clock;

  void Observe(Clock::time_point received,
               const FaceInference& inference,
               uint64_t hash,
               bool eligible) {
    using namespace std::chrono_literals;
    observations_.push_back({received, eligible ? std::optional(inference) : std::nullopt, hash});
    while (observations_.size() > 5 || received - observations_.front().received > 1000ms)
      observations_.pop_front();
  }

  std::vector<FaceCluster> Clusters() const {
    using namespace std::chrono_literals;
    std::vector<FaceCluster> result;
    for (size_t a = 0; a < observations_.size(); ++a) {
      for (size_t b = a + 1; b < observations_.size(); ++b) {
        for (size_t c = b + 1; c < observations_.size(); ++c) {
          const auto& first = observations_[a];
          const auto& middle = observations_[b];
          const auto& last = observations_[c];
          if (!first.inference || !middle.inference || !last.inference ||
              first.hash == middle.hash || first.hash == last.hash || middle.hash == last.hash ||
              last.received - first.received < 400ms)
            continue;
          const auto& x = *first.inference->feature;
          const auto& y = *middle.inference->feature;
          const auto& z = *last.inference->feature;
          if (Similarity(x, y) < kMatchThreshold || Similarity(x, z) < kMatchThreshold ||
              Similarity(y, z) < kMatchThreshold)
            continue;
          FaceCluster cluster;
          cluster.frames = {x, y, z};
          cluster.last_hash = last.hash;
          for (const auto* observation : {&first, &middle, &last}) {
            const auto& inference = *observation->inference;
            for (size_t i = 0; i < cluster.value.size(); ++i)
              cluster.value[i] += (*inference.feature)[i];
            cluster.live1 += inference.live_v1se / 3;
            cluster.live2 += inference.live_v2 / 3;
            cluster.quality.yaw += inference.quality.yaw / 3;
            cluster.quality.pitch += inference.quality.pitch / 3;
          }
          if (Normalize(cluster.value))
            result.push_back(std::move(cluster));
        }
      }
    }
    return result;
  }

 private:
  struct Observation {
    Clock::time_point received;
    std::optional<FaceInference> inference;
    uint64_t hash;
  };
  std::deque<Observation> observations_;
};

class FacePolicy {
 public:
  using Clock = FaceWindow::Clock;
  struct Observation {
    FaceGate gate = FaceGate::none;
    bool presence_match = false;
  };

  FacePolicy(FacePurpose purpose = FacePurpose::verify, FaceGallery gallery = {})
      : purpose_(purpose), gallery_(std::move(gallery)) {
    if (purpose == FacePurpose::enroll)
      result_.progress = 0;
  }

  const FaceResult& Result() const { return result_; }

  Observation Observe(Clock::time_point received, const FaceInference& inference, uint64_t hash) {
    using namespace std::chrono_literals;
    if (result_.state != FaceState::pending)
      return {};
    Observation observation{QualityGate(inference)};
    if (observation.gate == FaceGate::none && purpose_ == FacePurpose::enroll && medoid_ &&
        Similarity(*inference.feature, *medoid_) < kMatchThreshold)
      observation.gate = FaceGate::inconsistent;
    window_.Observe(received, inference, hash, observation.gate == FaceGate::none);
    bool added = false;
    for (const auto& cluster : window_.Clusters()) {
      if (purpose_ == FacePurpose::presence && cluster.last_hash != hash)
        continue;
      const auto live_gate = AggregateLiveGate(cluster.live1, cluster.live2);
      if (live_gate != FaceGate::none) {
        if (observation.gate == FaceGate::none)
          observation.gate = live_gate;
        continue;
      }
      if (purpose_ == FacePurpose::enroll) {
        const auto bin = std::pair(int(std::round(cluster.quality.yaw / 0.15f)),
                                   int(std::round((cluster.quality.pitch - 0.5f) / 0.12f)));
        // Three templates can come from one pose; the rest must widen pose coverage.
        const bool known_pose = pose_bins_.contains(bin);
        if (known_pose && (result_.templates.size() >= 3 ||
                           BestSimilarity(result_.templates, cluster.value) >= kDiversity)) {
          if (observation.gate == FaceGate::none)
            observation.gate = FaceGate::not_diverse;
          continue;
        }
        result_.templates.push_back(cluster.value);
        pose_bins_.insert(bin);
        UpdateMedoid(cluster);
        if (!first_template_)
          first_template_ = received;
        result_.progress = float(result_.templates.size()) / 5;
        window_ = {};
        added = true;
        observation.gate = FaceGate::none;
        break;
      }
      const float score = BestSimilarity(gallery_, cluster.value);
      const bool matches = std::all_of(
          cluster.frames.begin(), cluster.frames.end(),
          [&](const auto& value) { return BestSimilarity(gallery_, value) >= kMatchThreshold; });
      if (matches) {
        if (purpose_ == FacePurpose::presence) {
          if (cluster.last_hash == hash && last_presence_hash_ != hash) {
            last_presence_hash_ = hash;
            observation.presence_match = true;
          }
        } else {
          result_.state = FaceState::matched;
          result_.learn = score < kNovelty ? std::optional(cluster.value) : std::nullopt;
        }
        observation.gate = FaceGate::none;
        break;
      }
      if (purpose_ == FacePurpose::verify && score >= kLearnFloor && score < kMatchThreshold &&
          score > near_miss_score_) {
        near_miss_score_ = score;
        result_.learn = cluster.value;
      }
      if (observation.gate == FaceGate::none)
        observation.gate = FaceGate::identity;
    }
    if (purpose_ == FacePurpose::enroll) {
      UpdateHint(received, observation.gate, added);
      Advance(received);
    }
    return observation;
  }

  std::optional<Clock::time_point> CompletionTime() const {
    using namespace std::chrono_literals;
    if (purpose_ == FacePurpose::enroll && result_.templates.size() >= 3)
      return *first_template_ + 6s;
    return std::nullopt;
  }

  void Advance(Clock::time_point now) {
    if (purpose_ == FacePurpose::enroll && result_.state == FaceState::pending &&
        (result_.templates.size() == 5 || (CompletionTime() && now >= *CompletionTime()))) {
      result_.state = FaceState::enrolled;
      result_.progress.reset();
      result_.hint.reset();
    }
  }

 private:
  void UpdateMedoid(const FaceCluster& cluster) {
    for (const auto& value : cluster.frames)
      identities_.push_back(value);
    float best = -1;
    for (const auto& candidate : identities_) {
      float sum = 0;
      bool consistent = true;
      for (const auto& sample : identities_) {
        const float score = Similarity(candidate, sample);
        if (score < kMatchThreshold) {
          consistent = false;
          break;
        }
        sum += score;
      }
      if (consistent && sum > best) {
        best = sum;
        medoid_ = candidate;
      }
    }
  }

  static std::optional<std::string> Hint(FaceGate gate) {
    switch (gate) {
      case FaceGate::no_qualified_face:
      case FaceGate::boundary:
        return "no_face";
      case FaceGate::multiple_faces:
        return "multiple_faces";
      case FaceGate::too_far:
        return "too_far";
      case FaceGate::too_dark:
        return "too_dark";
      case FaceGate::too_bright:
        return "too_bright";
      case FaceGate::backlit:
        return "backlit";
      case FaceGate::blurry:
        return "blurry";
      case FaceGate::not_diverse:
        return "turn_head";
      default:
        return std::nullopt;
    }
  }

  void UpdateHint(Clock::time_point received, FaceGate gate, bool added) {
    using namespace std::chrono_literals;
    reasons_.push_back({received, Hint(gate)});
    while (reasons_.size() > 5 || received - reasons_.front().first > 1000ms)
      reasons_.pop_front();
    result_.hint.reset();
    if (added || gate == FaceGate::none)
      return;
    size_t largest = 0;
    for (auto it = reasons_.rbegin(); it != reasons_.rend(); ++it) {
      if (!it->second)
        continue;
      const size_t count = std::count_if(reasons_.begin(), reasons_.end(), [&](const auto& item) {
        return item.second == it->second;
      });
      if (count > largest) {
        largest = count;
        result_.hint = it->second;
      }
    }
  }

  FacePurpose purpose_;
  FaceGallery gallery_;
  FaceResult result_;
  FaceWindow window_;
  std::vector<FaceTemplate> identities_;
  std::optional<FaceTemplate> medoid_;
  std::set<std::pair<int, int>> pose_bins_;
  std::optional<Clock::time_point> first_template_;
  std::optional<uint64_t> last_presence_hash_;
  float near_miss_score_ = -1;
  std::deque<std::pair<Clock::time_point, std::optional<std::string>>> reasons_;
};

}  // namespace rk::auth
