#include "files/dc_file_services.hpp"
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <thread>
using namespace remotekit;
#define CHECK(value)                             \
  do {                                           \
    if (!(value)) {                              \
      std::cerr << __LINE__ << ": " #value "\n"; \
      std::exit(1);                              \
    }                                            \
  } while (false)
template <class F>
bool Fails(F operation) {
  return !operation();
}

template <class T>
T Take(remotekit::Result<T> result) {
  if (!result) {
    std::cerr << result.error().message << '\n';
    std::exit(1);
  }
  return std::move(result).value();
}
inline void Take(remotekit::Result<void> result) {
  if (!result) {
    std::cerr << result.error().message << '\n';
    std::exit(1);
  }
}

template <class F>
void Until(F ready) {
  const auto end = std::chrono::steady_clock::now() + std::chrono::seconds(3);
  while (!ready()) {
    CHECK(std::chrono::steady_clock::now() < end);
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
}
ServiceJson Request(const char* id, const char* method = "selection.commit") {
  return {{"type", "files.request"},
          {"version", 1},
          {"requestId", id},
          {"method", method},
          {"params", {{"requestId", "opaque"}}}};
}
void CheckSelectionCancellationGrant() {
  const auto request = Request("00000000-0000-4000-8000-000000000099", "selection.cancel");
  CHECK(FileRequestEnvelope(request, request.dump().size()));
  DcFileServices services;
  std::atomic<bool> entered = false, hold = true, current_after_revoke = true;
  std::atomic<unsigned> executed = 0;
  services.Start(
      [&](const DcFileServices::Job& job) {
        ++executed;
        CHECK(job.grant != 0);
        entered = true;
        while (hold)
          std::this_thread::sleep_for(std::chrono::milliseconds(1));
        current_after_revoke = services.Current(job);
        return ServiceJson{{"state", "cancelled"}};
      },
      [] {});
  services.Bind(7, "connection");
  const FileUploadStore::Binding binding{"browser", "1", "1", "1", "1"};
  services.Authorize("connection", 99, {{"opaque", binding}}, false);
  services.Admit(7, request);
  Until([&] { return entered.load(); });
  services.Authorize("connection", 99, {}, false);
  hold = false;
  Until([&] { return !current_after_revoke.load(); });
  std::vector<ServiceJson> replies;
  const auto flush = [&] {
    services.Flush(7, [&](const std::string& wire) {
      replies.push_back(ServiceJson::parse(wire));
      return 0;
    });
  };
  flush();
  CHECK(replies.empty());
  services.Admit(7, request);
  flush();
  CHECK(replies.size() == 1 && replies.back()["error"]["message"] == "stale_file_request" &&
        replies.back()["error"]["code"] == "conflict");
  services.Authorize("connection", 99, {{"opaque", binding}}, false);
  services.Admit(7, request);
  Until([&] {
    flush();
    return replies.size() == 2;
  });
  CHECK(executed == 2 && replies.back()["result"]["state"] == "cancelled");
  services.Admit(7, request);
  flush();
  CHECK(executed == 2 && replies.size() == 3);
  services.Stop();
}
struct TestBurstAnalyzer {
  Result<PhotoBurstDecision> Observe(const std::string& frame,
                                     std::span<const std::uint8_t>,
                                     const std::vector<std::string>&,
                                     const PhotoCancelled& cancelled) {
    CHECK(!cancelled());
    return Decide(frame);
  }
  Result<PhotoBurstDecision> Finish(const std::vector<std::string>& available) {
    return Decide(available.front());
  }
  static PhotoBurstDecision Decide(const std::string& frame) {
    return {frame, {frame}, {{frame, 0.75}}, false, false, "test"};
  }
};
void CheckBursts() {
  PhotoBurstSessions<TestBurstAnalyzer> bursts;
  const auto live = [] { return false; };
  auto begin = [&]() -> Result<std::string> {
    auto result = bursts.Execute(11, "photo.burst.begin", ServiceJson::object(), live);
    if (!result)
      return result.error();
    return result.value().at("burstId").get<std::string>();
  };
  const auto first = Take(begin()), second = Take(begin());
  CHECK(first != second);
  CHECK(Fails(begin));
  auto sample = [&](const std::string& frame, const std::vector<std::string>& available,
                    const std::string& data = "YWJj") {
    return bursts.Execute(
        11, "photo.burst.sample",
        {{"burstId", first}, {"frameId", frame}, {"availableFrameIds", available}, {"data", data}},
        live);
  };
  CHECK(Fails([&] { return sample("1", {"1", "future"}); }));
  CHECK(Fails([&] { return sample("1", {"1", "1"}); }));
  CHECK(Fails([&] { return sample("1", {"1", "2", "3", "4"}); }));
  CHECK(Fails([&] { return sample("invalid\n", {"invalid\n"}); }));
  const auto decision = Take(sample("1", {"1"}));
  CHECK(decision["selectedFrameId"] == "1" && decision["keepFrameIds"].size() == 1 &&
        decision["candidates"][0]["score"] == 0.75);
  CHECK(Fails([&] { return sample("1", {"1"}, "ZGVm"); }));
  CHECK(Take(sample("2", {"1", "2"}))["selectedFrameId"] == "2");
  CHECK(Take(sample("3", {"2", "3"}))["selectedFrameId"] == "3");
  CHECK(Fails([&] { return sample("4", {"1", "4"}); }));
  for (unsigned i = 4; i <= 20; ++i) {
    const auto id = std::to_string(i);
    CHECK(Take(sample(id, {id}))["selectedFrameId"] == id);
  }
  CHECK(Fails([&] { return sample("21", {"21"}); }));
  const ServiceJson end = {{"burstId", first}, {"availableFrameIds", {"20"}}};
  const auto result = Take(bursts.Execute(11, "photo.burst.end", end, live));
  CHECK(result["selectedFrameId"] == "20");
  CHECK(Take(bursts.Execute(11, "photo.burst.end", end, live)) == result);
  CHECK(Fails([&] { return bursts.Execute(12, "photo.burst.end", end, live); }));
  auto conflict = end;
  conflict["availableFrameIds"] = {"19"};
  CHECK(Fails([&] { return bursts.Execute(11, "photo.burst.end", conflict, live); }));
  const ServiceJson cancel = {{"burstId", second}};
  CHECK(Take(bursts.Execute(12, "photo.burst.cancel", cancel, live))["cancelled"] == true);
  const auto third = Take(begin());
  CHECK(Fails(begin));
  CHECK(Take(bursts.Execute(11, "photo.burst.cancel", cancel, live))["cancelled"] == true);
  CHECK(Take(bursts.Execute(11, "photo.burst.cancel", cancel, live))["cancelled"] == true);
  const ServiceJson empty_end = {{"burstId", third}, {"availableFrameIds", ServiceJson::array()}};
  for (int i = 0; i < 2; ++i) {
    const auto failed = bursts.Execute(11, "photo.burst.end", empty_end, live);
    CHECK(!failed && failed.error().message == "photo_burst_no_samples");
  }
  const auto expiring = Take(begin());
  bursts.Sweep([](uint64_t) { return true; },
               decltype(bursts)::Clock::now() + std::chrono::seconds(6));
  CHECK(Fails([&] {
    return bursts.Execute(11, "photo.burst.end",
                          {{"burstId", expiring}, {"availableFrameIds", ServiceJson::array()}},
                          live);
  }));
  bursts.Sweep([](uint64_t) { return false; });
  CHECK(Fails([&] { return bursts.Execute(11, "photo.burst.end", end, live); }));
}
void CheckDocumentErrorReplies() {
  DcFileServices services;
  std::atomic<unsigned> count = 0;
  const std::array reasons{ErrorReason::kDocumentEncrypted, ErrorReason::kDocumentCorrupt,
                           ErrorReason::kDocumentUnsupported, ErrorReason::kDocumentTooComplex};
  services.Start(
      [&](const DcFileServices::Job&) -> Result<ServiceJson> {
        return Error{ErrorCode::kRejected, "Native conversion diagnosis", reasons.at(count++)};
      },
      [] {});
  services.Bind(7, "connection");
  services.Authorize("connection", 99, {}, true);
  for (size_t i = 0; i < reasons.size(); ++i) {
    auto request = Request("00000000-0000-4000-8000-000000000001",
                           i % 2 == 0 ? "document.open" : "document.resource");
    request["requestId"] = "00000000-0000-4000-8000-00000000000" + std::to_string(i + 1);
    request["params"]["requestId"] = "library";
    services.Admit(7, request);
    ServiceJson reply;
    Until([&] {
      services.Flush(7, [&](const std::string& wire) {
        reply = ServiceJson::parse(wire);
        return 0;
      });
      return !reply.is_null();
    });
    CHECK(reply["type"] == "files.result" && reply["ok"] == false);
    CHECK(reply["error"] ==
          WireError({ErrorCode::kRejected, "Native conversion diagnosis", reasons[i]}));
  }
  services.Stop();
}
void CheckValidationErrorReply() {
  DcFileServices services;
  services.Start(
      [](const DcFileServices::Job&) -> Result<ServiceJson> {
        throw InvalidRequest("invalid_file_integer");
      },
      [] {});
  services.Bind(7, "connection");
  Take(services.Authorize("connection", 99, {}, true));
  auto request = Request("00000000-0000-4000-8000-000000000001", "asset.read");
  request["params"]["requestId"] = "library";
  services.Admit(7, request);
  ServiceJson reply;
  Until([&] {
    services.Flush(7, [&](const std::string& wire) {
      reply = ServiceJson::parse(wire);
      return 0;
    });
    return !reply.is_null();
  });
  CHECK(reply["ok"] == false);
  CHECK(reply["error"] == WireError({ErrorCode::kInvalidRequest, "invalid_file_integer"}));
  services.Stop();
}

int main() {
  CheckValidationErrorReply();
  CheckDocumentErrorReplies();
  CheckSelectionCancellationGrant();
  CheckBursts();
  CHECK(Take(DecodeFileChunk("YWJj")) == std::vector<std::uint8_t>({'a', 'b', 'c'}));
  CHECK(Take(DecodeFileChunk("YQ==")) == std::vector<std::uint8_t>({'a'}));
  CHECK(Take(DecodeFileChunk("YWI=")) == std::vector<std::uint8_t>({'a', 'b'}));
  CHECK(EncodeFileChunk({}) == "");
  CHECK(EncodeFileChunk({'a', 'b'}) == "YWI=");
  for (const auto* text : {"", "a", "====", "YQ=+", "YQ==YQ==", "YR==", "YWJ=", " YQ=", "!!!!"})
    CHECK(Fails([&] { return DecodeFileChunk(text); }));
  CHECK(Fails([] { return DecodeFileChunk(std::string(21848, 'A')); }));
  const auto a = Request("00000000-0000-4000-8000-000000000001");
  CHECK(FileRequestEnvelope(a, a.dump().size()));
  CHECK(!FileRequestEnvelope(a, 24577));
  auto burst_request = a;
  burst_request["params"]["requestId"] = "library";
  burst_request["method"] = "photo.burst.sample";
  CHECK(FileRequestEnvelope(burst_request, 61440));
  CHECK(!FileRequestEnvelope(burst_request, 61441));
  for (const auto method : {"photo.burst.begin", "photo.burst.end", "photo.burst.cancel",
                            "photo.process", "asset.chunk", "asset.describe"}) {
    auto small = burst_request;
    small["method"] = method;
    CHECK(FileRequestEnvelope(small, 24576));
    CHECK(!FileRequestEnvelope(small, 24577));
  }
  constexpr auto sample_bytes = PhotoBurstSessions<TestBurstAnalyzer>::kMaxSampleBytes;
  CHECK(
      Take(DecodeFileChunk(EncodeFileChunk(std::vector<std::uint8_t>(sample_bytes)), sample_bytes))
          .size() == sample_bytes);
  CHECK(Fails([&] {
    return DecodeFileChunk(EncodeFileChunk(std::vector<std::uint8_t>(sample_bytes + 1)),
                           sample_bytes);
  }));
  auto malformed = a;
  malformed["requestId"] = "g0000000-0000-4000-8000-000000000001";
  CHECK(!FileRequestEnvelope(malformed, 512));
  DcFileServices services;
  std::atomic<unsigned> executions = 0, sweeps = 0;
  std::atomic<bool> hold = false, entered = false;
  services.Start(
      [&](const DcFileServices::Job& job) {
        ++executions;
        entered = true;
        while (hold)
          std::this_thread::sleep_for(std::chrono::milliseconds(1));
        CHECK(job.control == 99);
        return ServiceJson{{"state", "selected"}};
      },
      [&] { ++sweeps; });
  services.Bind(7, "connection");
  FileUploadStore::Binding binding{"browser", "1", "1", "1", "1"};
  services.Authorize("connection", 99, {{"opaque", binding}});
  std::vector<ServiceJson> replies;
  auto flush = [&](bool busy = false) {
    services.Flush(7, [&](const std::string& text) {
      if (busy)
        return 1;
      replies.push_back(ServiceJson::parse(text));
      return 0;
    });
  };
  services.Admit(7, a);
  Until([&] {
    flush(true);
    return executions.load() == 1;
  });
  Until([&] {
    flush();
    return !replies.empty();
  });
  CHECK(replies.back()["ok"] == true);
  services.Admit(7, a);
  Until([&] {
    flush();
    return replies.size() == 2;
  });
  CHECK(executions == 1);
  // SDK signaling can reenter admission while a synchronous send is active.
  // This must not require the lock held by Flush's caller.
  services.Admit(7, a);
  services.Flush(7, [&](const std::string& text) {
    services.Admit(7, a);
    replies.push_back(ServiceJson::parse(text));
    return 0;
  });
  CHECK(executions == 1);
  auto conflict = a;
  conflict["params"]["selectionId"] = "conflict";
  services.Admit(7, conflict);
  flush();
  CHECK(replies.back()["error"]["message"] == "file_request_id_conflict" &&
        replies.back()["error"]["code"] == "conflict");
  // Document/navigation authorization changes invalidate queued work and sweep
  // independently of media. An old peer cannot discover a new peer's receipts.
  services.Authorize("connection", 99, {});
  auto b = Request("00000000-0000-4000-8000-000000000002");
  services.Admit(7, b);
  flush();
  CHECK(replies.back()["error"]["message"] == "stale_file_request" &&
        replies.back()["error"]["code"] == "conflict");
  services.Authorize("connection", 99, {{"opaque", binding}});
  hold = true;
  entered = false;
  services.Admit(7, b);
  Until([&] { return entered.load(); });
  const auto count = replies.size();
  services.Bind(8, "replacement");
  hold = false;
  Until([&] { return sweeps.load() >= 2; });
  services.Flush(8, [&](const std::string& text) {
    replies.push_back(ServiceJson::parse(text));
    return 0;
  });
  CHECK(replies.size() == count);
  CHECK(Fails([&] { return services.Authorize("connection", 99, {{"opaque", binding}}); }));
  services.Admit(7, a);
  services.Flush(8, [&](const std::string&) {
    CHECK(false);
    return 0;
  });
  services.Stop();
  DcFileServices library;
  entered = false;
  hold = false;
  executions = 0;
  library.Start(
      [&](const DcFileServices::Job& job) {
        const auto n = ++executions;
        entered = true;
        while (hold)
          std::this_thread::sleep_for(std::chrono::milliseconds(1));
        return ServiceJson{{"sequence", n}, {"current", library.Current(job)}};
      },
      [] {});
  library.Bind(9, "library-peer");
  auto asset = Request("00000000-0000-4000-8000-000000000003", "photo.burst.sample");
  asset["params"]["requestId"] = "library";
  asset["params"]["burstId"] = "test-burst";
  CHECK(FileRequestEnvelope(asset, asset.dump().size()));
  auto chooser_asset = asset;
  chooser_asset["params"]["requestId"] = "opaque";
  auto chooser_describe = chooser_asset;
  chooser_describe["method"] = "asset.describe";
  auto library_commit = asset;
  library_commit["method"] = "selection.commit";
  replies.clear();
  const auto drain = [&] {
    library.Flush(9, [&](const std::string& wire) {
      replies.push_back(ServiceJson::parse(wire));
      return 0;
    });
  };
  library.Authorize("library-peer", 99, {{"opaque", binding}});
  library.Admit(9, asset);
  drain();
  CHECK(replies.back()["error"]["message"] == "stale_file_request" &&
        replies.back()["error"]["code"] == "conflict");
  library.Authorize("library-peer", 99, {{"opaque", binding}}, true);
  library.Admit(9, chooser_asset);
  library.Admit(9, library_commit);
  drain();
  CHECK(replies.size() == 3 && replies.back()["error"]["message"] == "stale_file_request" &&
        replies.back()["error"]["code"] == "conflict");
  hold = true;
  library.Admit(9, asset);
  Until([&] { return entered.load(); });
  library.Authorize("library-peer", 99, {}, true);  // Retire chooser only.
  hold = false;
  Until([&] {
    drain();
    return replies.size() == 4;
  });
  CHECK(replies.back()["result"]["current"] == true);
  asset["requestId"] = "00000000-0000-4000-8000-000000000004";
  hold = true;
  entered = false;
  library.Admit(9, asset);
  Until([&] { return entered.load(); });
  library.Authorize("library-peer", 99, {}, false);
  library.Authorize("library-peer", 99, {}, true);
  library.Admit(9, asset);
  hold = false;
  Until([&] {
    drain();
    return replies.size() == 5;
  });
  CHECK(replies.back()["result"]["sequence"] == 3 && replies.back()["result"]["current"] == true);
  library.Authorize("library-peer", 99, {{"opaque", binding}}, true);
  chooser_describe["requestId"] = "00000000-0000-4000-8000-000000000005";
  library.Admit(9, chooser_describe);
  drain();
  CHECK(replies.size() == 6 && replies.back()["error"]["message"] == "stale_file_request" &&
        replies.back()["error"]["code"] == "conflict");
  chooser_describe["params"]["requestId"] = "library";
  library.Admit(9, chooser_describe);
  Until([&] {
    drain();
    return replies.size() == 7;
  });
  CHECK(replies.back()["ok"] == true);
  for (const auto* method : {"document.open", "document.resource"}) {
    auto document =
        Request(method == std::string("document.open") ? "00000000-0000-4000-8000-000000000006"
                                                       : "00000000-0000-4000-8000-000000000007",
                method);
    CHECK(FileRequestEnvelope(document, document.dump().size()));
    library.Admit(9, document);
    drain();
    CHECK(replies.back()["error"]["code"] == "conflict");
    document["params"]["requestId"] = "library";
    library.Admit(9, document);
    const auto count = replies.size();
    Until([&] {
      drain();
      return replies.size() > count;
    });
    CHECK(replies.back()["ok"] == true);
  }
  library.Stop();
  std::cout << "DC file admission, strict base64, receipts and peer retirement passed\n";
}
