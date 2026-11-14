#pragma once
#include "retry_owner_drivers.hpp"
#include "util/file_io.hpp"

namespace remotekit::retry_test {
inline OwnerDriver ColdDriver(const fs::path& root, bool items) {
  struct Fixture {
    Boundary boundary;
    ObjectLink link;
    media::Sdk sdk = BrowserSdk();
    RuntimeOptions options;
    Service owner;
    bool items;
    uint64_t generation = 1;
    fs::path directory;
    std::optional<Result<Json>> result;
    Fixture(const fs::path& root, bool per_item)
        : options(Take(RuntimeOptions::FromConfig(TestConfig(), root, "dev", "test"))),
          owner(sdk, options, link, {}, "endpoint"),
          items(per_item),
          directory(options.data / "sessions" / std::string(32, 'a')) {
      fs::create_directories(directory);
    }
    void Tick() {
      if (items)
        result = NativeRetryOwnerProbe::ColdDelete(
            owner, generation, [&](const std::string& id) -> Result<bool> {
              auto removed = boundary.Call({{"sessionId", id}});
              if (!removed)
                return removed.error();
              Take(RemoveTree(directory));
              return true;
            });
      else
        result = NativeRetryOwnerProbe::ColdSweep(owner, generation, [&] {
          return boundary.Call({{"generation", generation}},
                               {{"deleted", 0}, {"items", Json::array()}});
        });
    }
    bool Surfaced() const {
      if (!result)
        return false;
      if (!*result)
        return true;
      return items && !result->value().at("items").empty() &&
             result->value().at("items").at(0).contains("error");
    }
  };
  auto f = std::make_shared<Fixture>(root, items);
  return {f,
          std::shared_ptr<Boundary>(f, &f->boundary),
          [f] { f->Tick(); },
          [f] { ++f->generation; },
          [f] { return NativeRetryOwnerProbe::ColdState(f->owner, f->items); },
          [f] { return f->Surfaced(); }};
}
}  // namespace remotekit::retry_test
