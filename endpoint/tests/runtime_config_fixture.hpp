#pragma once
#include "options.hpp"
inline remotekit::Json TestConfig() {
  return {{"nodeId", "test"},
          {"media",
           {{"encoder", "auto"},
            {"fps", 60},
            {"bitrate", 36000000},
            {"maxBitrate", 48000000},
            {"asyncDepth", nullptr},
            {"gop", nullptr},
            {"targetUsage", nullptr},
            {"qsvLowPower", "auto"},
            {"bufferMs", nullptr},
            {"rateControl", nullptr},
            {"idleIdrMs", 150},
            {"maxEncodeWidth", 4096},
            {"maxEncodeHeight", 4096}}},
          {"peer", {{"listen", "127.0.0.1:0"}, {"address", "127.0.0.1:3101"}}},
          {"rtc", {{"ports", nullptr}, {"address", nullptr}}}};
}

inline remotekit::Json TestView(const std::string& id = "1",
                                const std::string& url = "about:blank") {
  return {{"viewId", id},
          {"presence", "ensure"},
          {"url", url},
          {"width", 1440},
          {"height", 900},
          {"visible", false},
          {"device", {{"mode", "desktop"}, {"deviceScaleFactor", 1}}},
          {"occludedBottom", 0},
          {"occlusionRevision", "0"}};
}
