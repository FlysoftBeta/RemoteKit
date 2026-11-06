#include "cluster/noise.hpp"
#include <json.hpp>
#include <fstream>
#include <iostream>
#include <stdexcept>
using namespace remotekit::cluster;
Bytes Unhex(const std::string& hex) {
  Bytes out;
  for (size_t i = 0; i < hex.size(); i += 2)
    out.push_back(static_cast<uint8_t>(std::stoul(hex.substr(i, 2), nullptr, 16)));
  return out;
}
Key KeyHex(const std::string& hex) {
  auto bytes = Unhex(hex);
  Key key;
  std::copy_n(bytes.begin(), 32, key.begin());
  return key;
}
template <class T>
T Take(remotekit::Result<T> result) {
  if (!result)
    throw std::runtime_error(result.error().message);
  return std::move(result).value();
}
void Require(bool b) {
  if (!b)
    throw std::runtime_error("Noise vector mismatch");
}
int main(int argc, char** argv) {
  try {
    nlohmann::json doc;
    std::ifstream(argv[1]) >> doc;
    auto v = doc["vectors"][0];
    Key psk = KeyHex(v["init_psks"][0]);
    TestEphemeral ie{KeyHex(v["init_ephemeral"])}, re{KeyHex(v["resp_ephemeral"])};
    auto prologue = Unhex(v["init_prologue"]);
    std::string text(prologue.begin(), prologue.end());
    Noise init(Role::kInitiator, psk, text, &ie), resp(Role::kResponder, psk, text, &re);
    for (int i = 0; i < 2; ++i) {
      auto payload = Unhex(v["messages"][i]["payload"]);
      auto wire = Take((i == 0 ? init : resp).Write(payload));
      Require(Hex(wire) == v["messages"][i]["ciphertext"].get<std::string>());
      Require(Take((i == 0 ? resp : init).Read(wire)) == payload);
    }
    Require(Hex(init.handshake_hash()) == v["handshake_hash"].get<std::string>());
    auto ik = Take(init.Split()), rk = Take(resp.Split());
    CipherState is(ik.send), ir(ik.receive), rs(rk.send), rr(rk.receive);
    for (int i = 2; i < 6; ++i) {
      auto payload = Unhex(v["messages"][i]["payload"]);
      auto wire = Take((i % 2 == 0 ? is : rs).Encrypt(payload));
      Require(Hex(wire) == v["messages"][i]["ciphertext"].get<std::string>());
      Require(Take((i % 2 == 0 ? rr : ir).Decrypt(wire)) == payload);
    }
    return 0;
  } catch (const std::exception& e) {
    std::cerr << e.what() << '\n';
    return 1;
  }
}
