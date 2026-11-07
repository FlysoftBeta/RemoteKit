#pragma once
#include "cluster/frames.hpp"
namespace remotekit::cluster {
struct NodeFiles {
  std::string control, node_id;
  Key key{};
  ~NodeFiles();
};
bool ValidNodeId(std::string_view value);
bool ValidBuildId(std::string_view value);
Result<NodeFiles> LoadNodeFiles(const std::filesystem::path& root);
Result<std::string> ReadBuildId(const std::filesystem::path& runtime_root);
Result<Key> DecodeKey(std::string_view base64);
struct ControlAddress {
  std::wstring host;
  uint16_t port;
  bool secure;
};
Result<ControlAddress> ParseControlUrl(const std::string& url);
}  // namespace remotekit::cluster
