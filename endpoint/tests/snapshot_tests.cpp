#include "persistence/snapshot_protocol.hpp"
#include "../snapshot/request.hpp"
#include "../snapshot/workers.hpp"
#include "persistence/snapshot_leases.hpp"
#include <iostream>
#include <stdexcept>

using namespace remotekit;
using namespace remotekit::snapshot;
void Check(bool value, const char* message) {
  if (!value)
    throw std::runtime_error(message);
}
int main() {
  try {
    for (const auto* path : {L"../secret", L"a/../secret", L"C:/secret", L"/secret", L"\\secret",
                             L"\\\\server\\share", L"file:stream", L"a/./b", L"a./b", L"a /b"})
      Check(!SafePath(path), "snapshot path escapes or aliases data root");
    Check(!SafePath(fs::path(std::wstring(L"a\0b", 3))), "embedded null rejected");
    Check(SafePath(L"sessions/abc/Profile/Default/Cookies-wal"), "valid snapshot path");
    for (
        const auto& text :
        {R"({"method":"snapshot.take","root":"C:/data","paths":["a"],"extra":1})",
         R"({"method":"snapshot.release","snapshotId":"one","extra":1})",
         R"({"method":"snapshot.read","snapshotId":"one","path":"a","offset":0,"length":4294967296})",
         R"({"method":"snapshot.read","snapshotId":"one","path":"a","offset":0})",
         R"({"method":"snapshot.release","snapshotId":"one","snapshotId":"two"})"}) {
      try {
        DecodeRequest(text);
        Check(false, "invalid snapshot request accepted");
      } catch (const release::Failure&) {
      }
    }
    Check(ReadLength(Json(uint64_t(kMaxRead))) == kMaxRead, "read boundary accepted");
    std::atomic<unsigned> finished = 0;
    updater::Handle input, output;
    try {
      Workers workers([&](std::stop_token stop) {
        while (!stop.stop_requested())
          Sleep(1);
        ++finished;
      });
      Check(CreatePipe(&input.value, &output.value, nullptr, 0), "create worker test pipe");
      workers.Connect(std::move(input), [&](std::stop_token stop, HANDLE pipe) {
        char byte;
        DWORD count;
        while (!stop.stop_requested() && ReadFile(pipe, &byte, 1, &count, nullptr) && count) {
        }
        ++finished;
      });
      Sleep(50);
      throw std::runtime_error("listener failure");
    } catch (const std::runtime_error&) {
    }
    Check(finished == 2, "owner joins maintenance and blocked connection");
    const auto journal = fs::path(__FILE__).parent_path().parent_path().parent_path() /
                         L"develop/tmp" / (L"rk-owner-" + std::to_wstring(GetCurrentProcessId()));
    release::AtomicText(journal, "complete owner");
    {
      updater::Handle blocked(CreateFileW((journal.wstring() + L".tmp").c_str(), GENERIC_WRITE, 0,
                                          nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
      try {
        release::AtomicText(journal, "new owner");
        Check(false, "locked owner temporary accepted");
      } catch (const release::Failure&) {
      }
      std::ifstream input(journal);
      std::string text((std::istreambuf_iterator<char>(input)), {});
      Check(text == "complete owner", "failed owner write preserves journal");
    }
    fs::remove(journal);
    fs::remove(journal.wstring() + L".tmp");
    const auto now = LeaseClock::now();
    Check(CanMerge(now, now + std::chrono::seconds(2)), "concurrent takes share shadow");
    Check(!CanMerge(now, now + std::chrono::seconds(2) + std::chrono::milliseconds(1)),
          "takes outside merge window cannot share shadow");
    struct Shadow {};
    Leases<Shadow> leases;
    auto shadow = std::make_shared<Shadow>();
    std::weak_ptr<Shadow> retained = shadow;
    leases.emplace("one", Lease<Shadow>{shadow, now, 1, {"one"}});
    leases.emplace("two", Lease<Shadow>{shadow, now, 2, {"two"}});
    shadow.reset();
    leases.Disconnect(1);
    Check(!retained.expired() && leases.size() == 1, "disconnect preserves another caller lease");
    leases.at("two").renewed += std::chrono::seconds(30);
    leases.Expire(now + std::chrono::seconds(120));
    Check(!retained.expired(), "requests renew the snapshot lease");
    leases.Expire(now + std::chrono::seconds(150));
    Check(retained.expired() && leases.empty(), "last expired lease deletes shadow");
    PublishLease(leases, "prepared",
                 Lease<Shadow>{std::make_shared<Shadow>(), now - std::chrono::minutes(3), 4, {}});
    leases.Expire(LeaseClock::now());
    Check(leases.contains("prepared"), "enumeration time excluded from lease lifetime");
    leases.clear();
    leases.emplace("three", Lease<Shadow>{std::make_shared<Shadow>(), now, 3, {}});
    std::weak_ptr<Shadow> disconnected = leases.at("three").shadow;
    leases.Disconnect(3);
    Check(disconnected.expired(), "disconnect deletes last caller shadow");
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
