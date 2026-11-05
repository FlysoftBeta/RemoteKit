#pragma once
#include "common.hpp"
#include "remotekit/error.hpp"
#include <functional>
#include <memory>
namespace remotekit {
class ManagementLink {
 public:
  using Disconnect = std::function<void(uint64_t)>;
  virtual ~ManagementLink() = default;
  virtual bool Next(std::string& bytes, uint64_t& generation, bool& eof) = 0;
  virtual bool Current(uint64_t generation) = 0;
  virtual bool SendReply(uint64_t generation, const Json& reply) = 0;
  virtual bool SendEvent(const Json& event, uint64_t generation) = 0;
  virtual void OnDisconnect(Disconnect callback) = 0;
};
std::unique_ptr<ManagementLink> MakeStdioLink();
}  // namespace remotekit
