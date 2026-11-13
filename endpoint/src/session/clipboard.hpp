#pragma once
#include "protocol/limits.hpp"

#include "util/common.hpp"
#include "util/error.hpp"
#include <charconv>
#include <functional>
#include <mutex>
#include <optional>

namespace remotekit {
class PlacementClipboard {
 public:
  Result<void> Deliver(const Json& document) {
    std::lock_guard lock(mutex_);
    const auto revision = std::stoull(document.at("revision").get<std::string>());
    if (revision < revision_ || (revision == revision_ && document.at("value") != value_))
      return Error{ErrorCode::kConflict, "clipboard revision conflicts"};
    revision_ = revision;
    value_ = document.at("value");
    return {};
  }
  Result<Json> Resolve(const Json& revision) const {
    std::lock_guard lock(mutex_);
    if (revision == "0")
      return Json{{"revision", "0"}, {"text", ""}, {"html", ""}};
    if (std::stoull(revision.get<std::string>()) != revision_)
      return Error{ErrorCode::kConflict, "clipboard revision not delivered"};
    auto value = value_;
    value["revision"] = revision;
    return value;
  }

 private:
  mutable std::mutex mutex_;
  uint64_t revision_ = 0;
  Json value_{{"text", ""}, {"html", ""}};
};

class ClipboardController {
 public:
  struct Hooks {
    std::function<bool()> ready;
    std::function<std::string()> incarnation;
    std::function<Result<Json>()> read;
    std::function<Result<Json>(const Json&)> write;
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
  Result<void> Seed(const Json& value) {
    if (!Valid(value))
      return Error{ErrorCode::kInvalidRequest, "invalid clipboard value"};
    std::lock_guard lock(mutex_);
    if (seed_) {
      const auto revision = Sequence(value["revision"]).value();
      const auto previous = Sequence((*seed_)["revision"]).value();
      if (revision < previous || (revision == previous && value != *seed_))
        return Error{ErrorCode::kConflict, "clipboard revision conflicts"};
    }
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
  Result<void> Write(const Json& value) {
    auto seeded = Seed(value);
    if (!seeded)
      return seeded;
    std::lock_guard lock(mutex_);
    return hooks_.ready() ? ApplyLocked() : Result<void>{};
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
    if (!seed_ || (applied_incarnation_ == incarnation &&
                   applied_revision_ == (*seed_)["revision"].get<std::string>()))
      return {};
    return WriteLocked();
  }
  Result<void> WriteLocked() {
    auto polled = PollLocked(true);
    if (!polled)
      return polled;
    auto written = hooks_.write(*seed_);
    if (!written)
      return written.error();
    const auto sequence =
        written.value().contains("sequence") ? Sequence(written.value()["sequence"]) : std::nullopt;
    if (!sequence || written.value().value("baseRevision", Json()) != (*seed_)["revision"])
      return Error{ErrorCode::kOutcomeUnknown, "invalid clipboard write receipt"};
    applied_incarnation_ = hooks_.incarnation();
    applied_revision_ = (*seed_)["revision"].get<std::string>();
    reported_incarnation_ = applied_incarnation_;
    reported_sequence_ = *sequence;
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
      if (!sequence || !value.contains("baseRevision") || !Sequence(value["baseRevision"]) ||
          !value.contains("text") || !value["text"].is_string() || !value.contains("html") ||
          !value["html"].is_string())
        return Error{ErrorCode::kInternal, "invalid clipboard response"};
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
                 {"baseRevision", value["baseRevision"]},
                 {"text", text},
                 {"html", html}};
      if (value.contains("viewId") && value["viewId"].is_string() && value["viewId"] != "")
        event["viewId"] = value["viewId"];
      event["excludeFromHistory"] = value.value("excludeFromHistory", false);
      if (text.size() > limits::textBytes || html.size() > limits::htmlBytes ||
          event.dump().size() > limits::eventBytes) {
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
  const std::string tenant_, session_;
  Hooks hooks_;
  std::mutex mutex_;
  std::optional<Json> seed_;
  std::string applied_incarnation_, applied_revision_, reported_incarnation_;
  uint64_t reported_sequence_ = 0;
};
}  // namespace remotekit
