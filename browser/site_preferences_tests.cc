#include "browser/site_preferences.h"

#include <cstdlib>
#include "base/json/json_reader.h"

namespace {
void Check(bool value) {
  if (!value)
    std::abort();
}
bool Valid(const char* json) {
  auto value = base::JSONReader::ReadDict(json, base::JSON_PARSE_RFC);
  return value && remotekit::browser::ValidSitePreferences(*value);
}
}  // namespace
int main() {
  using remotekit::browser::ValidProtocolHandler;
  Check(Valid("{}"));
  Check(Valid(
      R"({"https://example.test":{"tabletUa":true,"permissions":{"geolocation":"allow","clipboard_read":"block","local_fonts":"allow","window_management":"block","midi_sysex":"allow","idle_detection":"block"},"protocolHandlers":[{"protocol":"web+rk","url":"https://example.test/?uri=%s","allowed":false}]}})"));
  for (
      const auto* invalid :
      {R"({"https://example.test/":{"tabletUa":true}})", R"({"https://example.test":{}})",
       R"({"https://example.test":{"tabletUa":false}})",
       R"({"https://example.test":{"permissions":{}}})",
       R"({"https://example.test":{"permissions":{"notifications":"allow"}}})",
       R"({"https://example.test":{"permissions":{"geolocation":"ask"}}})",
       R"({"https://example.test":{"protocolHandlers":[]}})",
       R"({"https://example.test":{"manualKeyboard":true}})",
       R"({"https://example.test":{"protocolHandlers":[{"protocol":"web+rk","url":"https://example.test/%s","allowed":true,"extra":true}]}})"})
    Check(!Valid(invalid));
  Check(ValidProtocolHandler("https://example.test", "mailto", "https://example.test/?to=%s"));
  Check(ValidProtocolHandler("http://localhost:8080", "web+rk", "http://localhost:8080/%s"));
  Check(!ValidProtocolHandler("http://example.test", "web+rk", "http://example.test/%s"));
  Check(!ValidProtocolHandler("https://example.test", "web+RK", "https://example.test/%s"));
  Check(!ValidProtocolHandler("https://example.test", "web+rk", "https://other.test/%s"));
  Check(!ValidProtocolHandler("https://example.test", "web+rk",
                              "https://example.test/no-placeholder"));
}
