#pragma once

#include "util/common.hpp"
#include "util/error.hpp"
#include <charconv>
#include <functional>
#include <mutex>
#include <optional>

namespace remotekit {
class ClipboardController {
 public:
  struct Hooks {
    std::function<bool()> ready;
    std::function<std::string()> incarnation;
    std::function<Result<Json>()> read;
    std::function<Result<void>(const Json&)> write;
    std::function<std::optional<uint64_t>()> sequence;
    std::function<bool(const Json&)> send;
  };
  ClipboardController(std::string tenant, std::string session, Hooks hooks)
      : tenant_(std::move(tenant)), session_(std::move(session)), hooks_(std::move(hooks)) {}

  static bool Valid(const Json& value) {
    if (!value.is_object() || !value.contains("revision") || !value["revision"].is_string() ||
        !value.contains("text") || !value["text"].is_string() || !value.contains("html") ||
        !value["html"].is_string())
      return false;
    return Sequence(value["revision"]).has_value();
  }
  Result<void> Set(const Json& value) {
    if (!Valid(value))
      return Error{ErrorCode::kInvalidRequest, "invalid clipboard value"};
    std::lock_guard lock(mutex_);
    std::optional<uint64_t> superseded;
    if (hooks_.ready()) {
      auto read = hooks_.read();
      if (!read)
        return read.error();
      if (read.value().contains("sequence"))
        superseded = Sequence(read.value()["sequence"]);
      if (!superseded)
        return Error{ErrorCode::kUnavailable, "invalid clipboard response"};
    }
    seed_ = value;
    applied_incarnation_.clear();
    auto applied = hooks_.ready() ? ApplyLocked() : Result<void>{};
    if (applied && superseded) {
      reported_incarnation_ = hooks_.incarnation();
      reported_sequence_ = *superseded;
    }
    return applied;
  }
  Result<void> Seed(const Json& value) {
    if (!Valid(value))
      return Error{ErrorCode::kInvalidRequest, "invalid clipboard value"};
    std::lock_guard lock(mutex_);
    seed_ = value;
    return {};
  }
  Result<void> BeforeViews() {
    std::lock_guard lock(mutex_);
    return ApplyLocked();
  }
  Result<void> Poll(bool force = false) {
    std::lock_guard lock(mutex_);
    return PollLocked(force);
  }

 private:
  static std::optional<uint64_t> Sequence(const Json& value) {
    if (!value.is_string())
      return std::nullopt;
    const auto& text = value.get_ref<const std::string&>();
    uint64_t sequence = 0;
    const auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), sequence);
    if (error != std::errc{} || end != text.data() + text.size() ||
        std::to_string(sequence) != text)
      return std::nullopt;
    return sequence;
  }
  Result<void> ApplyLocked() {
    const auto incarnation = hooks_.incarnation();
    if (!seed_ || applied_incarnation_ == incarnation)
      return {};
    auto written = hooks_.write(*seed_);
    if (!written)
      return written;
    applied_incarnation_ = incarnation;
    return {};
  }
  Result<void> PollLocked(bool force) {
    if (!hooks_.ready())
      return {};
    const auto incarnation = hooks_.incarnation();
    if (reported_incarnation_ != incarnation) {
      reported_incarnation_ = incarnation;
      reported_sequence_ = 0;
    }
    const auto observed = hooks_.sequence();
    if (!force && (!observed || *observed == reported_sequence_))
      return {};
    for (;;) {
      auto read = hooks_.read();
      if (!read)
        return read.error();
      const auto& value = read.value();
      const auto sequence = value.contains("sequence") ? Sequence(value["sequence"]) : std::nullopt;
      if (!sequence || !value.contains("text") || !value["text"].is_string() ||
          !value.contains("html") || !value["html"].is_string())
        return Error{ErrorCode::kUnavailable, "invalid clipboard response"};
      // A later write invalidates this snapshot, including while the RPC was in flight.
      const auto current = hooks_.sequence();
      if (current && *current > *sequence) {
        if (force)
          continue;
        return {};
      }
      if (*sequence == reported_sequence_)
        return {};
      const auto& text = value["text"].get_ref<const std::string&>();
      const auto& html = value["html"].get_ref<const std::string&>();
      Json event{{"type", "clipboard.changed"},
                 {"tenantId", tenant_},
                 {"sessionId", session_},
                 {"browserSequence", std::to_string(*sequence)},
                 {"text", text},
                 {"html", html}};
      if (text.size() + html.size() >= kMaxEventBytes || event.dump().size() >= kMaxEventBytes) {
        event.erase("text");
        event.erase("html");
        event["oversize"] = true;
        event["textBytes"] = text.size();
        event["htmlBytes"] = html.size();
      }
      if (!hooks_.send(event))
        return Error{ErrorCode::kUnavailable, "clipboard event unavailable"};
      reported_sequence_ = *sequence;
      return {};
    }
  }
  static constexpr size_t kMaxEventBytes = 4 * 1024 * 1024;
  const std::string tenant_, session_;
  Hooks hooks_;
  std::mutex mutex_;
  std::optional<Json> seed_;
  std::string applied_incarnation_, reported_incarnation_;
  uint64_t reported_sequence_ = 0;
};
}  // namespace remotekit
