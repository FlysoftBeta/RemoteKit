#include "qsv_rate_controller.hpp"
#include <algorithm>
#include <cmath>

namespace remotekit::media {

QsvRateController::QsvRateController(uint32_t target, uint32_t maximum)
    : rates_{std::min(target, maximum), maximum} {}

double QsvRateController::Qstep(int qp) {
  return std::exp2((qp - 4.0) / 6.0);
}

void QsvRateController::SetRates(uint32_t target, uint32_t maximum) {
  std::lock_guard lock(rates_mutex_);
  rates_ = {std::min(target, maximum), maximum};
}

QsvRateController::Rates QsvRateController::Snapshot() const {
  std::lock_guard lock(rates_mutex_);
  return rates_;
}

void QsvRateController::Prepare(uint32_t order, RateFrame frame) {
  std::lock_guard lock(state_mutex_);
  auto& pending = frames_[order];
  pending.telemetry.frame = frame;
}

void QsvRateController::Cancel(uint32_t order) {
  std::lock_guard lock(state_mutex_);
  frames_.erase(order);
}

RateTelemetry QsvRateController::GetFrameCtrl(uint32_t order, uint32_t recode, bool idr) {
  const auto rates = Snapshot();
  std::lock_guard lock(state_mutex_);
  auto& state = frames_.at(order);
  auto& sample = state.telemetry;
  if (recode) {
    sample.recodes = recode;
    sample.predicted_bits = state.complexity / Qstep(sample.qp);
    return sample;
  }
  sample.frame.idr = idr;
  sample.target_bps = rates.target;
  sample.maximum_bps = rates.maximum;
  const auto capture = sample.frame.capture_time_us;
  if (have_bucket_time_) {
    const double elapsed = std::max(0.0, (capture - bucket_time_) / 1000000.0);
    fullness_ = std::max(0.0, fullness_ - rates.target * elapsed);
  }
  bucket_time_ = capture;
  have_bucket_time_ = true;
  const bool first_real_frame = !have_real_time_;
  sample.dt_raw = have_real_time_ ? (capture - real_time_) / 1000000.0 : 1.0 / 60;
  if (have_real_time_ && sample.dt_raw >= 2.5) {
    interval_count_ = 0;
    interval_cursor_ = 0;
  }
  if (!sample.frame.keepalive) {
    if (have_real_time_ && sample.dt_raw < 2.5) {
      intervals_[interval_cursor_] = sample.dt_raw;
      interval_cursor_ = (interval_cursor_ + 1) % intervals_.size();
      interval_count_ = std::min(intervals_.size(), interval_count_ + 1);
    }
    real_time_ = capture;
    have_real_time_ = true;
  }
  sample.tau_known = interval_count_ == intervals_.size();
  if (sample.tau_known) {
    auto sorted = intervals_;
    std::sort(sorted.begin(), sorted.end());
    sample.tau = sorted[1];
  }
  sample.dt =
      std::clamp(sample.tau_known ? std::min(sample.dt_raw, sample.tau) : 1.0 / 60, 1.0 / 60, 0.5);
  sample.budget = rates.target * sample.dt;
  const double size = rates.target * 0.5;
  sample.fullness = fullness_;
  const double upper = sample.tau_known ? kBoostUpper : 1.0;
  sample.target = sample.budget * std::clamp(1 + (size / 4 - fullness_) / size, 0.5, upper);
  if (sample.frame.idr) {
    sample.target = std::min(4 * rates.target * std::max(sample.tau, 1.0 / 60),
                             rates.target * kIMilliseconds / 1000);
    sample.cap = std::max(1.25 * sample.target, 2 * sample.budget);
  } else {
    sample.cap = std::min(std::max(2 * sample.budget, rates.target * kPMilliseconds / 1000),
                          rates.maximum * 0.25);
  }
  auto& model = sample.frame.idr ? i_complexity_ : p_complexity_;
  if (!model)
    model = sample.frame.idr && p_complexity_ ? 4 * p_complexity_ : sample.target * Qstep(26);
  state.complexity = model;
  int qp = 10;
  while (qp < 51 && model / Qstep(qp) > sample.target)
    ++qp;
  if (sample.frame.keepalive) {
    qp = std::min(51, last_p_qp_ + 6);
  } else if (sample.frame.idr && first_real_frame) {
    qp = 26;
  } else if (!sample.frame.idr && have_p_history_ && !lift_p_limit_) {
    qp = std::clamp(qp, std::max(10, last_p_qp_ - 4), std::min(51, last_p_qp_ + 4));
  }
  if (!sample.frame.keepalive && !sample.frame.idr)
    lift_p_limit_ = false;
  sample.qp = qp;
  sample.predicted_bits = model / Qstep(qp);
  return sample;
}

QsvRateController::Feedback QsvRateController::Update(uint32_t order,
                                                      uint32_t recode,
                                                      uint32_t bytes) {
  std::lock_guard lock(state_mutex_);
  auto& state = frames_.at(order);
  auto& sample = state.telemetry;
  sample.actual_bits = double(bytes) * 8;
  sample.recodes = recode;
  if (sample.actual_bits > sample.cap) {
    sample.cap_hits = 1;
    if (recode == 0) {
      const int increase =
          std::max(2, int(std::ceil(6 * std::log2(sample.actual_bits / sample.cap))));
      sample.qp = std::min(51, sample.qp + increase);
      return {true, sample.qp, sample};
    }
  }
  fullness_ += sample.actual_bits;
  sample.fullness_after = fullness_;
  if (!sample.frame.keepalive) {
    auto& model = sample.frame.idr ? i_complexity_ : p_complexity_;
    const double observed = sample.actual_bits * Qstep(sample.qp);
    const bool scene_change = sample.actual_bits > 2 * sample.predicted_bits ||
                              sample.predicted_bits > 2 * sample.actual_bits;
    model = scene_change ? observed : 0.5 * model + 0.5 * observed;
    if (scene_change)
      lift_p_limit_ = true;
    if (sample.frame.idr) {
      if (!have_i_history_ && !have_p_history_)
        p_complexity_ = model / 4;
      have_i_history_ = true;
    } else {
      last_p_qp_ = sample.qp;
      have_p_history_ = true;
    }
  }
  const auto result = Feedback{false, sample.qp, sample};
  return result;
}

RateTelemetry QsvRateController::Complete(uint32_t order) {
  std::lock_guard lock(state_mutex_);
  const auto sample = frames_.at(order).telemetry;
  frames_.erase(order);
  return sample;
}

}  // namespace remotekit::media
