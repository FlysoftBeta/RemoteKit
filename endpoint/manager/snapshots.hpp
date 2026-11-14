#pragma once
#include "release/common.hpp"

namespace remotekit::manager {
template <class Table, class Start, class Failed>
void ReconcileSnapshots(const release::Json& nodes,
                        Table& supervisors,
                        Start start,
                        Failed failed) {
  for (const auto& [node_id, node] : nodes.items()) {
    if (!node.contains("local") || supervisors.contains(node_id))
      continue;
    try {
      auto supervisor = start(node_id, node.at("local"));
      if (supervisor)
        supervisors.emplace(node_id, std::move(supervisor));
    } catch (const std::exception& error) {
      failed(node_id, error);
    }
  }
}
}  // namespace remotekit::manager
