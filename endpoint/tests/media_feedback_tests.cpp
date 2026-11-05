#include "remotekit/media_feedback.hpp"
#include <cstdlib>
#include <iostream>
#include <limits>

#define CHECK(x)                                    \
  do {                                              \
    if (!(x)) {                                     \
      std::cerr << __LINE__ << " failed: " #x "\n"; \
      std::exit(1);                                 \
    }                                               \
  } while (false)
using Json = nlohmann::json;
static Json Sample(uint64_t seq = 1) {
  return {{"type", "media.feedback"},
          {"version", 1},
          {"seq", seq},
          {"layoutEpoch", "7"},
          {"outputGeneration", "3"},
          {"visible", true},
          {"windowMs", 1500},
          {"rafSamples", 90},
          {"displayHzEstimate", 60},
          {"decodedFrames", 90},
          {"videoFrames", 89},
          {"planes", Json::array({{{"view", "a"}, {"frames", 89}}, {{"view", "b"}}})}};
}
int main() {
  remotekit::MediaFeedback feedback;
  CHECK(!feedback.Receive(1, Sample(), 100));
  feedback.Bind(1, "7", "3", {"a", "b"});
  auto unknown = feedback.Snapshot(100, 1000);
  CHECK(!unknown.contains("feedbackAgeMs") && !unknown.contains("feedbackSeq"));
  CHECK(!feedback.Receive(2, Sample(), 100));
  CHECK(feedback.Receive(1, Sample(), 100));
  auto stats = feedback.Snapshot(125, 1000);
  CHECK(stats["feedbackAgeMs"] == 25 && stats["feedbackSeq"] == 1);
  CHECK(stats["feedbackPlanes"].size() == 2 && !stats["feedbackPlanes"][1].contains("frames"));
  CHECK(!stats.contains("feedbackPacketsLost") && !stats.contains("feedbackRoundTripTimeMs"));
  CHECK(!feedback.Receive(1, Sample(), 200));  // Sequence cannot replay.
  for (const char* field :
       {"seq", "version", "windowMs", "rafSamples", "decodedFrames", "videoFrames"}) {
    auto bad = Sample(2);
    bad[field] = -1;
    CHECK(!feedback.Receive(1, bad, 200));
    if (std::string(field) != "windowMs") {
      bad = Sample(2);
      bad[field] = 1.5;
      CHECK(!feedback.Receive(1, bad, 200));
    }
  }
  auto fractional_window = Sample(2);
  fractional_window["windowMs"] = 1500.5;
  CHECK(feedback.Receive(1, fractional_window, 200));
  feedback.Bind(2, "7", "3", {"a", "b"});
  auto invalid = [&](const char* field, Json value) {
    auto bad = Sample(2);
    bad[field] = std::move(value);
    CHECK(!feedback.Receive(2, bad, 200));
  };
  invalid("version", 2);
  invalid("seq", 9007199254740992ull);
  invalid("seq", true);
  invalid("layoutEpoch", "6");
  invalid("outputGeneration", "4");
  invalid("visible", 1);
  invalid("windowMs", 0);
  invalid("windowMs", 600001);
  invalid("windowMs", std::numeric_limits<double>::infinity());
  invalid("displayHzEstimate", std::numeric_limits<double>::quiet_NaN());
  invalid("displayHzEstimate", 251);
  invalid("rafSamples", 513);
  invalid("roundTripTimeMs", -1);
  invalid("packetsLost", 1000000001ull);
  invalid("framesDropped", 1.1);
  invalid("planes", Json::array({{{"view", "a"}}, {{"view", "a"}}}));
  invalid("planes", Json::array({{{"view", "not-mounted"}}}));
  invalid("planes", Json::array({{{"view", "a"}, {"frames", -1}}}));
  auto hidden = Sample(2);
  hidden["visible"] = false;
  CHECK(!feedback.Receive(2, hidden, 200));
  hidden.erase("displayHzEstimate");
  hidden.erase("decodedFrames");
  hidden.erase("videoFrames");
  CHECK(feedback.Receive(2, hidden, 200));
  stats = feedback.Snapshot(250, 1000);
  CHECK(stats["feedbackAgeMs"] == 50 && stats["feedbackVisible"] == false);
  CHECK(!stats.contains("feedbackDisplayHzEstimate") && !stats.contains("feedbackDecodedFrames"));
  CHECK(!feedback.Receive(2, Sample(3), 300, 16385));
  CHECK(feedback.Receive(2, Sample(3), 300));  // Invalid sequence 3 did not poison its retry.
  for (uint64_t seq = 4; seq < 104; ++seq)
    CHECK(feedback.Receive(2, Sample(seq), seq * 100));
  stats = feedback.Snapshot(10400, 1000);
  CHECK(stats["feedbackSeq"] == 103 && stats["feedbackAgeMs"] == 100);
  CHECK(stats["feedbackPlanes"].size() == 2);  // Flood retains one latest payload.
  const auto accepted = stats["feedbackAccepted"].get<uint64_t>();
  feedback.Bind(2, "8", "3", {"a"});
  CHECK(!feedback.Snapshot(11000, 1000).contains("feedbackSeq"));
  auto next = Sample(104);
  next["layoutEpoch"] = "8";
  next["planes"] = Json::array({{{"view", "a"}}});
  next["seq"] = 1;
  CHECK(!feedback.Receive(2, next, 11000));  // Layout epoch alone keeps connection sequence.
  next["seq"] = 104;
  CHECK(feedback.Receive(2, next, 11000));
  feedback.Bind(2, "", "");  // Output close/reopen pauses feedback without replacing the peer.
  CHECK(!feedback.Receive(2, next, 11500));
  feedback.Bind(2, "8", "4", {"a"});
  next["outputGeneration"] = "4";
  next["seq"] = 1;
  CHECK(!feedback.Receive(2, next,
                          12000));  // Output generation preserves this connection's sequence.
  next["seq"] = 105;
  CHECK(feedback.Receive(2, next, 12000));
  feedback.Bind(0, "", "");
  CHECK(!feedback.Receive(2, next, 13000));
  CHECK(!feedback.Snapshot(13000, 1000).contains("feedbackAgeMs"));
  feedback.Bind(3, "8", "4", {"a"});
  next["seq"] = 1;
  CHECK(feedback.Receive(3, next, 14000));
  stats = feedback.Snapshot(14005, 1000);
  CHECK(stats["feedbackAgeMs"] == 5 && stats["feedbackAccepted"].get<uint64_t>() == accepted + 3);
  std::cout << "media feedback tests passed\n";
}
