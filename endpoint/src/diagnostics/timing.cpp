#include "diagnostics/timing.hpp"

namespace remotekit {
using ConnectionPhase = ConnectionTiming::ConnectionPhase;

void ConnectionTiming::MarkConnection(ConnectionPhase phase) {
  auto& stamp = connection_phases[static_cast<size_t>(phase)];
  if (!stamp.load()) {
    int64_t empty = 0;
    stamp.compare_exchange_strong(empty, QpcNow());
  }
}

Json ConnectionTiming::ConnectionTimings() const {
  constexpr const char* names[] = {
      "answerReady",     "firstCandidate",        "gatherComplete",      "connected",
      "dataChannelOpen", "outputOpenStart",       "outputOpenEnd",       "firstSourceFrame",
      "firstSubmit",     "encoderConfigureStart", "encoderConfigureEnd", "firstEncoded"};
  const auto started = connection_started_qpc.load();
  Json phases = Json::object();
  if (started)
    for (size_t i = 0; i < connection_phases.size(); ++i)
      if (const auto at = connection_phases[i].load(); at >= started)
        phases[names[i]] = 1000.0 * (at - started) / QpcFrequency();
  return phases;
}
}  // namespace remotekit

namespace remotekit {
void ConnectionTiming::Reset() {
  for (auto& phase : connection_phases)
    phase = 0;
  connection_started_qpc = QpcNow();
}
}  // namespace remotekit
