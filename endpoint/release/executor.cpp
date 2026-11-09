#include "executor.hpp"
#include "asset.hpp"
#include "codec.hpp"

namespace remotekit::release {
fs::path Execute(const Plan& plan,
                 const fs::path& base,
                 const fs::path& work,
                 const Key& key,
                 const Http& http) {
  auto assets = work / L"assets";
  fs::create_directories(assets);
  std::set<std::string> used;
  for (auto& step : plan.steps)
    used.insert(step.asset.salt);
  for (auto& entry : fs::directory_iterator(assets))
    if (!used.contains(entry.path().filename().string()))
      fs::remove_all(entry.path());
  fs::path previous = base;
  for (auto& step : plan.steps) {
    auto directory = assets / step.asset.salt;
    fs::create_directories(directory);
    auto output = work / ("payload-" + step.manifest.build_id + ".tar");
    auto input = [&](const Consume& consume) {
      for (uint32_t i = 0; i < step.asset.slices.size(); ++i) {
        auto complete = directory / std::to_string(i);
        auto partial = fs::path(complete.wstring() + L".partial");
        auto& slice = step.asset.slices[i];
        if (fs::exists(complete) && fs::file_size(complete) != slice.size)
          fs::remove(complete);
        try {
          if (!fs::exists(complete)) {
            http.Download(slice.url, partial, slice.size);
            fs::rename(partial, complete);
          }
        } catch (const Failure& failure) {
          if (failure.error.code != ErrorCode::kNotFound)
            throw;
          fs::remove(complete);
          fs::remove(partial);
          throw Replan(failure.error, step.asset.salt, false);
        }
        Bytes plaintext;
        try {
          plaintext = DecryptSlice(key, step.asset, i, Read(complete, slice.size));
        } catch (const Failure& failure) {
          if (failure.error.code != ErrorCode::kRejected)
            throw;
          fs::remove(complete);
          throw Replan(failure.error, step.asset.salt, false);
        }
        consume(plaintext);
      }
    };
    try {
      Decode(input, output, step.manifest.payload, previous, !step.full);
      Require(HashFile(output) == step.manifest.payload.sha256, "release payload SHA-256 mismatch");
    } catch (const Replan&) {
      throw;
    } catch (const Failure& failure) {
      if (failure.error.code != ErrorCode::kRejected)
        throw;
      throw Replan(failure.error, step.asset.salt, !step.full && previous == base);
    }
    if (!previous.empty() && previous != base && previous != output)
      fs::remove(previous);
    previous = output;
  }
  return previous;
}
Fetched Fetch(const std::string& url,
              State& state,
              const fs::path& base,
              const fs::path& work,
              const Key& key,
              const Http& http) {
  auto fetch = [&](const std::string& address) { return DecryptManifest(http.Get(address), key); };
  bool replanned = false;
  while (true) {
    auto plan = MakePlan(url, state, fetch);
    if (plan.steps.empty())
      return {plan.build_id, {}, base};
    try {
      auto path = Execute(plan, base, work, key, http);
      return {plan.build_id, plan.steps.back().manifest.payload, path};
    } catch (const Replan& failure) {
      http.LogFailure(failure.error);
      if (failure.base)
        state.base_usable = false;
      else
        state.excluded.insert(failure.salt);
      if (replanned)
        throw;
      replanned = true;
    }
  }
}
}  // namespace remotekit::release
