#pragma once
#include "manifest.hpp"
namespace remotekit::release {
using FetchManifest = std::function<Manifest(const std::string&)>;
struct State {
  std::string current;
  bool base_usable = false;
  std::set<std::string> excluded;
};
struct Step {
  Manifest manifest;
  Asset asset;
  bool full;
};
struct Plan {
  std::string build_id;
  uint64_t cost = 0;
  std::vector<Step> steps;
};
Plan MakePlan(const std::string& url, const State& state, const FetchManifest& fetch);
}  // namespace remotekit::release
