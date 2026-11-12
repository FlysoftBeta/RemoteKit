#include "persistence/snapshot_protocol.hpp"
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
    leases.emplace("three", Lease<Shadow>{std::make_shared<Shadow>(), now, 3, {}});
    std::weak_ptr<Shadow> disconnected = leases.at("three").shadow;
    leases.Disconnect(3);
    Check(disconnected.expired(), "disconnect deletes last caller shadow");
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
