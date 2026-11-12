#pragma once

#include <array>
#include <cstdint>
#include <map>
#include <mutex>

namespace remotekit::media {

struct RateFrame {
  uint64_t cookie = 0;
  int64_t capture_time_us = 0;
  bool keepalive = false;
  bool idr = false;
};

struct RateTelemetry {
  RateFrame frame;
  double dt = 0;
  double dt_raw = 0;
  double tau = 0;
  bool tau_known = false;
  double budget = 0;
  double target = 0;
  double fullness = 0;
  double fullness_after = 0;
  double predicted_bits = 0;
  double actual_bits = 0;
  double cap = 0;
  uint32_t target_bps = 0;
  uint32_t maximum_bps = 0;
  uint32_t recodes = 0;
  uint32_t cap_hits = 0;
  int qp = 26;
};

class QsvRateController {
 public:
  static constexpr double kBoostUpper = 1.15;
  static constexpr double kPMilliseconds = 33;
  static constexpr double kIMilliseconds = 60;
  struct Rates {
    uint32_t target;
    uint32_t maximum;
  };
  struct Feedback {
    bool recode = false;
    int qp = 26;
    RateTelemetry telemetry;
  };

  QsvRateController(uint32_t target, uint32_t maximum);

  static double Qstep(int qp);

  void SetRates(uint32_t target, uint32_t maximum);

  Rates Snapshot() const;

  void Prepare(uint32_t order, RateFrame frame);

  void Cancel(uint32_t order);

  RateTelemetry GetFrameCtrl(uint32_t order, uint32_t recode, bool idr);

  Feedback Update(uint32_t order, uint32_t recode, uint32_t bytes);

  RateTelemetry Complete(uint32_t order);

 private:
  struct Pending {
    RateTelemetry telemetry;
    double complexity = 0;
  };
  mutable std::mutex rates_mutex_;
  Rates rates_;
  std::array<double, 3> intervals_{};
  size_t interval_count_ = 0;
  size_t interval_cursor_ = 0;
  std::mutex state_mutex_;
  std::map<uint32_t, Pending> frames_;
  double fullness_ = 0;
  double i_complexity_ = 0;
  double p_complexity_ = 0;
  int64_t bucket_time_ = 0;
  int64_t real_time_ = 0;
  bool have_bucket_time_ = false;
  bool have_real_time_ = false;
  bool have_i_history_ = false;
  bool have_p_history_ = false;
  bool lift_p_limit_ = false;
  int last_p_qp_ = 26;
};

}  // namespace remotekit::media
