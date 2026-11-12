#pragma once
#include "management/link.hpp"
#include "cluster/channel.hpp"
namespace remotekit {
class ClusterLink final : public ManagementLink {
 public:
  using Connector = std::function<Result<cluster::Established>()>;
  using ValidateConfig = std::function<Result<void>(const Json&)>;
  ClusterLink(Connector connect,
              bool local,
              std::string build_id,
              ValidateConfig validate,
              bool watch_stdin = false);
  ~ClusterLink() override;
  Result<Json> WaitReady();
  int ExitCode();
  void Flush();
  bool Next(std::string& bytes, uint64_t& generation, bool& eof) override;
  bool Current(uint64_t generation) override;
  bool SendReply(uint64_t generation, const Json& reply) override;
  bool SendEvent(const Json& event, uint64_t generation, DeliveryFlag delivery = {}) override;
  void OnDisconnect(Disconnect callback) override;
  void OnBinary(Binary callback) override;
  void OnPeers(Peers callback) override;
  Result<Json> Request(const std::string& name, Json fields) override;
  std::optional<ReadyState> ReadySessions() override;
  Result<Json> RequestUntil(const std::string& name,
                            Json fields,
                            std::chrono::steady_clock::time_point deadline) override;

 private:
  bool Queue(const Json& message, uint64_t generation, DeliveryFlag delivery = {});
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
}  // namespace remotekit
