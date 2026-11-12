#pragma once
#include "objects/peer.hpp"
inline remotekit::cluster::Key TestPrivateKey(uint8_t seed) {
  remotekit::cluster::Key key;
  key.fill(seed);
  return key;
}
inline std::string EncodeKey(const remotekit::cluster::Key& key) {
  constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  uint32_t bits = 0;
  int count = 0;
  for (auto byte : key) {
    bits = (bits << 8) | byte;
    count += 8;
    while (count >= 6) {
      count -= 6;
      out += alphabet[(bits >> count) & 63];
    }
  }
  if (count)
    out += alphabet[(bits << (6 - count)) & 63];
  while (out.size() % 4)
    out += '=';
  return out;
}
inline remotekit::cluster::Json TestPeer(const std::string& node,
                                         const std::string& address,
                                         const remotekit::cluster::Key& private_key) {
  return {{"nodeId", node},
          {"address", address},
          {"publicKey", EncodeKey(remotekit::cluster::PublicKey(private_key))}};
}
