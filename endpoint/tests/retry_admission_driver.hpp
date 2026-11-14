#pragma once
#include "retry_owner_drivers.hpp"

namespace remotekit::retry_test {
inline void ReceiptOwnerCase(bool files, ErrorCode code) {
  NativeRetryClock clock;
  Boundary boundary;
  Error injected{code, "injected admission failure"};
  injected.error_id = "e-0123456789";
  boundary.Inject(injected);
  RpcResults rpc;
  DcFileServices service;
  const Json request =
      files ? Json{{"type", "files.request"},
                   {"version", 1},
                   {"requestId", "00000000-0000-4000-8000-000000000001"},
                   {"method", "asset.describe"},
                   {"params", {{"requestId", "library"}}}}
            : Json{{"opId", "operation"}, {"replay", false}, {"method", "lifecycle"}};
  if (files) {
    service.Bind(1, "connection");
    Take(service.Authorize("connection", 1, {}, true));
    service.Start(
        [&](const DcFileServices::Job& job) {
          return boundary.Call(job.message, {{"accepted", true}});
        },
        []() -> Result<void> { return {}; });
  }
  const auto invoke = [&](const Json& value) {
    if (files) {
      service.Admit(1, value);
      const auto id = value.at("requestId").get<std::string>();
      const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
      while (!NativeRetryOwnerProbe::FileReceipt(service, id)) {
        if (std::chrono::steady_clock::now() >= deadline)
          throw std::runtime_error("file admission owner did not complete");
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
      }
      service.Flush(1, [](const std::string&) { return 0; });
    } else
      rpc.Execute(value, [&] { return boundary.Call(value, {{"accepted", true}}); });
  };
  const auto status = [&]() -> RetryUnit::Snapshot {
    if (files)
      return *NativeRetryOwnerProbe::FileReceipt(service, request.at("requestId"));
    return NativeRetryOwnerProbe::RpcReceipt(rpc, "operation");
  };
  const auto require = [](bool valid, const char* message) {
    if (!valid)
      throw std::runtime_error(message);
  };
  invoke(request);
  require(boundary.Attempts().size() == 1, "first admission attempt reaches executor");
  require(status().Failure() && status().Failure()->code == code,
          "receipt exposes the exact failure");
  invoke(request);
  require(boundary.Attempts().size() == 1, "an unchanged receipt does not execute before backoff");
  const bool retryable = code == ErrorCode::kBusy || code == ErrorCode::kRateLimited ||
                         code == ErrorCode::kUnavailable;
  if (retryable) {
    auto until = status().Until();
    const auto delay = until - RetryClock::now();
    clock.Set(until - std::chrono::milliseconds(1));
    invoke(request);
    require(boundary.Attempts().size() == 1, "admission respects retry deadline");
    clock.Set(until);
    invoke(request);
    require(boundary.Attempts().size() == 2, "admission retries at its deadline");
    require(status().Until() - until >= delay, "admission delay grows");
    require(boundary.Attempts()[0].identity == boundary.Attempts()[1].identity,
            "admission identity is unchanged");
    clock.Set(status().Until());
    boundary.Inject({});
    invoke(request);
    require(boundary.Attempts().size() == 3 && status().Attempt() == 0,
            "admission recovery resets attempts");
  } else {
    const bool waiting = code == ErrorCode::kConflict || code == ErrorCode::kOutcomeUnknown;
    const bool dropped = code == ErrorCode::kNotFound || code == ErrorCode::kCanceled;
    require(status().Status() == (waiting   ? RetryUnit::State::kWaiting
                                  : dropped ? RetryUnit::State::kDropped
                                            : RetryUnit::State::kFaulted),
            "receipt retains its disposition");
    clock.Advance(std::chrono::hours(24));
    invoke(request);
    require(boundary.Attempts().size() == 1,
            "possibly executed/final receipt never repeats its action");
    boundary.Inject({});
    auto changed = request;
    changed[files ? "requestId" : "opId"] =
        files ? "00000000-0000-4000-8000-000000000002" : "next-operation";
    invoke(changed);
    require(boundary.Attempts().size() == 2,
            "new operation identity is admitted after a final receipt");
  }
  service.Stop();
}
}  // namespace remotekit::retry_test
