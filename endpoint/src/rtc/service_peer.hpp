#pragma once
#include "auth/face.hpp"
#include "files/object_files.hpp"
#include "rtc/peer.hpp"

namespace remotekit {
class ServicePeer {
 public:
  ServicePeer(media::Sdk&,
              const RuntimeOptions&,
              ManagementLink&,
              objects::ObjectService&,
              std::string tenant,
              std::string lease);
  ~ServicePeer();
  Result<Json> Command(const std::string&, const Json&, uint64_t generation);
  void ManagementLost(uint64_t generation);

 private:
  void Receive(const RtcEvent&);
  void Flush();
  media::Sdk& sdk_;
  ManagementLink& management_;
  const std::string tenant_, lease_;
  AuthorizationController authorization_;
  ObjectFiles files_;
  FaceController face_;
  PeerController peer_;
  std::mutex mutex_;
  std::atomic<bool> stop_{false};
  std::thread worker_;
};
}  // namespace remotekit
