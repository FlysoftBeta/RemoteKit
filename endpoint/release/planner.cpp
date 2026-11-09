#include "planner.hpp"
namespace remotekit::release {
Plan MakePlan(const std::string& url, const State& state, const FetchManifest& fetch) {
  auto manifest = fetch(url);
  if (manifest.build_id == state.current)
    return {manifest.build_id, 0, {}};
  std::string latest = manifest.build_id;
  std::vector<Manifest> chain;
  std::set<std::string> visited;
  std::optional<Plan> best;
  uint64_t patches = 0;
  auto usable = [&](const Asset& asset) { return !state.excluded.contains(asset.salt); };
  auto candidate = [&](const Asset& asset, bool full) {
    if (asset.size > UINT64_MAX - patches)
      return;
    auto cost = patches + asset.size;
    if (best && cost >= best->cost)
      return;
    Plan plan{latest, cost, {{manifest, asset, full}}};
    for (auto it = chain.rbegin(); it != chain.rend(); ++it)
      plan.steps.push_back({*it, it->patch->asset, false});
    best = std::move(plan);
  };
  for (unsigned count = 0; count < 64; ++count) {
    if (!visited.insert(manifest.build_id).second)
      break;
    if (manifest.full && usable(*manifest.full))
      candidate(*manifest.full, true);
    if (!manifest.patch || !usable(manifest.patch->asset))
      break;
    if (manifest.patch->from == state.current && state.base_usable) {
      candidate(manifest.patch->asset, false);
      break;
    }
    if (manifest.patch->asset.size > UINT64_MAX - patches)
      break;
    patches += manifest.patch->asset.size;
    if (best && patches >= best->cost)
      break;
    if (count + 1 == 64)
      break;
    auto previous_url = manifest.patch->manifest;
    auto expected = manifest.patch->from;
    chain.push_back(std::move(manifest));
    try {
      manifest = fetch(previous_url);
    } catch (const Failure& failure) {
      if (failure.error.code == ErrorCode::kNotFound ||
          failure.error.code == ErrorCode::kRejected ||
          failure.error.code == ErrorCode::kInvalidRequest)
        break;
      throw;
    }
    if (manifest.build_id != expected)
      break;
  }
  if (!best)
    Fail(ErrorCode::kNotFound, "no update path");
  return std::move(*best);
}
}  // namespace remotekit::release
