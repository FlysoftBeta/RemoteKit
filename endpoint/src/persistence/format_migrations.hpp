#pragma once
#include "persistence/strict_json.hpp"
#include <array>
#include <span>

namespace remotekit::persisted {
struct FormatMigration {
  uint64_t version;
  Json (*up)(const Json&);
};
enum class Store { kControl, kNode, kManager, kOwner, kCopy, kChanges, kManifest };
inline Json MigrateFormat(Store store, Json value) {
  static constexpr std::array<FormatMigration, 0> control{}, node{}, manager{}, owner{}, copy{},
      changes{}, manifest{};
  std::span<const FormatMigration> steps;
  switch (store) {
    case Store::kControl:
      steps = control;
      break;
    case Store::kNode:
      steps = node;
      break;
    case Store::kManager:
      steps = manager;
      break;
    case Store::kOwner:
      steps = owner;
      break;
    case Store::kCopy:
      steps = copy;
      break;
    case Store::kChanges:
      steps = changes;
      break;
    case Store::kManifest:
      steps = manifest;
      break;
  }
  for (const auto& step : steps)
    if (value.is_object() && value.contains("version") && value["version"].is_number_integer() &&
        value["version"] == step.version - 1)
      value = step.up(value);
  return value;
}
}  // namespace remotekit::persisted
