#pragma once
#include "management/link.hpp"
namespace remotekit {
class RemoteLink final : public ManagementLink {
 public:
  static Result<std::unique_ptr<RemoteLink>> Create(std::string url,
                                                    std::string node_id,
                                                    std::string token);
  ~RemoteLink() override;
  bool Next(std::string& bytes, uint64_t& generation, bool& eof) override;
  bool Current(uint64_t generation) override;
  bool SendReply(uint64_t generation, const Json& reply) override;
  bool SendEvent(const Json& event, uint64_t generation) override;
  void OnDisconnect(Disconnect callback) override;

 private:
  bool TrySend(std::string bytes, uint64_t generation);
  struct Impl;
  explicit RemoteLink(std::unique_ptr<Impl> impl);
  std::unique_ptr<Impl> impl_;
};
}  // namespace remotekit
