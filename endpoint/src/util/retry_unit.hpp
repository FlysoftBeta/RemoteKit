#pragma once

#include "util/error_policy.hpp"
#include "util/retry_clock.hpp"
#include "util/log.hpp"
#include "util/wire_error.hpp"

namespace remotekit {
class RetryUnit {
 public:
  using Clock = RetryClock;
  enum class State { kIdle, kWaiting, kFaulted, kDropped };
  class Snapshot {
   public:
    Snapshot(const RetryUnit& unit)
        : state_(unit.state_),
          attempt_(unit.attempt_),
          until_(unit.until_),
          input_(unit.input_),
          error_(unit.error_) {}
    State Status() const { return state_; }
    unsigned Attempt() const { return attempt_; }
    Clock::time_point Until() const { return until_; }
    const std::string& Identity() const { return input_; }
    const std::optional<Error>& Failure() const { return error_; }

   private:
    State state_;
    unsigned attempt_;
    Clock::time_point until_;
    std::string input_;
    std::optional<Error> error_;
  };
  explicit RetryUnit(std::string name = "retry") : name_(std::move(name)) {}

  void Input(std::string input) {
    if (input_ == input)
      return;
    input_ = std::move(input);
    Reset();
  }
  bool Ready(Clock::time_point now = Clock::now()) const {
    return state_ == State::kIdle || (state_ == State::kWaiting && now >= until_);
  }
  void Fail(const Error& failure, Clock::time_point now = Clock::now()) {
    if (state_ == State::kFaulted || state_ == State::kDropped)
      return;
    if (state_ == State::kWaiting && now < until_)
      return;
    Error error = failure;
    const auto handling = Handling(error.code);
    if (error_ && error.error_id.empty())
      error.error_id = error_->error_id;
    if (error_ && error.error_id.empty())
      ReportError(error, name_ + "_error", {{"unit", name_}});
    if (!error_ && handling != ErrorHandling::kCanceled) {
      if (error.error_id.empty() &&
          (error.code == ErrorCode::kInternal || error.code == ErrorCode::kOutcomeUnknown ||
           error.code == ErrorCode::kUnavailable))
        error.error_id = NewErrorId();
      LogError(LogLevel::kWarn, name_ + "_failed", error,
               {{"unit", name_}, {"input", std::to_string(std::hash<std::string>{}(input_))}});
    }
    failure.error_id = error.error_id;
    error_ = std::move(error);
    failed_streak_ = handling != ErrorHandling::kCanceled;
    const auto delay = RetryDelay(*error_, attempt_);
    ++attempt_;
    if (delay && !(handling == ErrorHandling::kRetrySoon && attempt_ >= kBusyAttempts)) {
      state_ = State::kWaiting;
      until_ = now + *delay;
    } else {
      state_ = handling == ErrorHandling::kDrop || handling == ErrorHandling::kCanceled
                   ? State::kDropped
                   : State::kFaulted;
    }
  }
  void Success() {
    if (state_ == State::kFaulted || state_ == State::kDropped)
      return;
    if (failed_streak_) {
      LogEvent(LogLevel::kInfo, name_ + "_recovered",
               {{"unit", name_}, {"input", std::to_string(std::hash<std::string>{}(input_))}});
    }
    failed_streak_ = false;
    Reset();
  }
  State Status() const { return state_; }
  const char* StateName() const {
    switch (state_) {
      case State::kIdle:
        return "idle";
      case State::kWaiting:
        return "waiting";
      case State::kFaulted:
        return "faulted";
      case State::kDropped:
        return "dropped";
    }
    std::terminate();
  }
  unsigned Attempt() const { return attempt_; }
  Clock::time_point Until() const { return until_; }
  const std::string& Identity() const { return input_; }
  const std::optional<Error>& Failure() const { return error_; }
  bool Reconcile() const { return error_ && Handling(error_->code) == ErrorHandling::kReconcile; }
  bool Refresh() const { return error_ && Handling(error_->code) == ErrorHandling::kRefresh; }
  Json Save() const {
    const auto remaining =
        std::chrono::duration_cast<std::chrono::milliseconds>(until_ - Clock::now()).count();
    const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
                         std::chrono::system_clock::now().time_since_epoch())
                         .count();
    return {{"state", StateName()},
            {"attempt", attempt_},
            {"retryAt", state_ == State::kWaiting ? now + std::max<int64_t>(0, remaining) : 0},
            {"input", input_},
            {"error", error_ ? WireError(*error_) : Json(nullptr)}};
  }
  Result<void> Restore(const Json& value) {
    try {
      RetryUnit restored(name_);
      const auto name = value.at("state").get<std::string>();
      unsigned state = 0;
      constexpr const char* names[] = {"idle", "waiting", "faulted", "dropped"};
      for (; state < std::size(names) && name != names[state]; ++state) {
      }
      if (state == std::size(names))
        return Error{ErrorCode::kInternal, "invalid persisted retry state"};
      restored.input_ = value.at("input").get<std::string>();
      restored.attempt_ = value.at("attempt").get<unsigned>();
      restored.state_ = static_cast<State>(state);
      if (!value.at("error").is_null())
        restored.error_ = ParseWireError(value.at("error"));
      restored.failed_streak_ =
          restored.error_ && Handling(restored.error_->code) != ErrorHandling::kCanceled;
      const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
                           std::chrono::system_clock::now().time_since_epoch())
                           .count();
      restored.until_ = Clock::now() + std::chrono::milliseconds(std::max<int64_t>(
                                           0, value.at("retryAt").get<int64_t>() - now));
      if (restored.state_ != State::kIdle && !restored.error_)
        return Error{ErrorCode::kInternal, "persisted retry failure missing"};
      if (restored.error_) {
        const auto handling = Handling(restored.error_->code);
        const bool waiting =
            handling == ErrorHandling::kRetrySoon || handling == ErrorHandling::kRetryAfter ||
            handling == ErrorHandling::kBackoff || handling == ErrorHandling::kReconcile ||
            handling == ErrorHandling::kRefresh;
        const bool dropped =
            handling == ErrorHandling::kDrop || handling == ErrorHandling::kCanceled;
        const bool exhausted =
            handling == ErrorHandling::kRetrySoon && restored.attempt_ >= kBusyAttempts;
        if ((restored.state_ == State::kWaiting && (!waiting || !restored.attempt_ || exhausted)) ||
            (restored.state_ == State::kDropped && !dropped) ||
            (restored.state_ == State::kFaulted && (dropped || (waiting && !exhausted))) ||
            restored.state_ == State::kIdle)
          return Error{ErrorCode::kInternal, "persisted retry disposition conflicts with its code"};
      } else if (restored.attempt_ != 0) {
        return Error{ErrorCode::kInternal, "idle retry state has a failure attempt"};
      }
      *this = std::move(restored);
      return {};
    } catch (const std::exception& error) {
      return Error{ErrorCode::kInternal, error.what()};
    }
  }
  static Result<void> Validate(const Json& value) {
    RetryUnit validated;
    return validated.Restore(value);
  }
  static constexpr unsigned kBusyAttempts = 8;

 private:
  void Reset() {
    state_ = State::kIdle;
    attempt_ = 0;
    until_ = {};
    error_.reset();
  }
  std::string name_, input_;
  State state_ = State::kIdle;
  unsigned attempt_ = 0;
  Clock::time_point until_{};
  std::optional<Error> error_;
  bool failed_streak_ = false;
};
}  // namespace remotekit
