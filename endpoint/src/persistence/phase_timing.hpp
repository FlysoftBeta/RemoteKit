#pragma once
#include "util/common.hpp"
#include <chrono>
#include <cstdio>

namespace remotekit {
using PhaseClock = std::chrono::steady_clock;
inline double PhaseMs(PhaseClock::time_point start) {
  return std::chrono::duration<double, std::milli>(PhaseClock::now() - start).count();
}
inline Json CheckpointPhases() {
  return {{"scan", {{"ms", 0.0}, {"filesStatted", 0}, {"filesFromWatcher", 0}}},
          {"store",
           {{"ms", 0.0},
            {"filesRead", 0},
            {"bytesRead", 0},
            {"chunksNew", 0},
            {"chunksReused", 0},
            {"bytesStored", 0},
            {"compressEncryptMs", 0.0}}},
          {"commit", {{"ms", 0.0}, {"requests", 0}, {"objects", 0}}},
          {"journal", 0.0}};
}
inline Json RestorePhases() {
  return {
      {"manifest", {{"ms", 0.0}}},
      {"validate", {{"ms", 0.0}, {"files", 0}, {"mismatched", 0}}},
      {"locate", {{"ms", 0.0}, {"requests", 0}, {"ids", 0}}},
      {"fetch",
       {{"ms", 0.0}, {"chunksLocal", 0}, {"chunksRemote", 0}, {"bytes", 0}, {"concurrency", 1}}},
      {"materialize", {{"ms", 0.0}}},
      {"swap", {{"ms", 0.0}}},
      {"replicaCommit", {{"ms", 0.0}, {"requests", 0}, {"objects", 0}}}};
}
inline void AddPhase(Json* phases, const char* phase, const char* field, double value) {
  if (phases)
    (*phases)[phase][field] = (*phases)[phase].value(field, 0.0) + value;
}
struct OperationTiming {
  Json fields;
  PhaseClock::time_point start = PhaseClock::now();
  ~OperationTiming() {
    fields["total"] = PhaseMs(start);
    fprintf(stderr, "%s\n", fields.dump().c_str());
  }
};
}  // namespace remotekit
