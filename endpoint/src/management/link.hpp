#pragma once
#include "util/common.hpp"
#include "util/error.hpp"
#include <functional>
#include <memory>
#include <optional>
#include <span>
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
  using Binary = std::function<void(const Json&, std::span<const uint8_t>)>;
  virtual void OnBinary(Binary) {}
  virtual Result<Json> Request(const std::string& name, Json fields) = 0;
  struct ReadyState {
    uint64_t generation;
    Json sessions;
    Json object_keys;
  };
  virtual std::optional<ReadyState> ReadySessions() { return {}; }
};
}  // namespace remotekit
