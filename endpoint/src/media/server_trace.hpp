#pragma once
#include "util/file_io.hpp"
#include "qsv_rate_controller.hpp"
#include "remotekit_rtc.h"
#include <windows.h>
#include <json.hpp>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <vector>
#include <algorithm>
#include <cstdio>

namespace remotekit::media {
struct TraceIds {
  uint64_t frame_id = 0, source_frame_id = 0, generation = 0, layout_epoch = 0;
  int64_t capture_time_us = 0, capture_qpc = 0;
  uint32_t rtp_timestamp = 0, wire_rtp_timestamp = 0;
  bool rtp_known = false, wire_known = false;
  uint64_t atlas_pool = 0;
  static TraceIds Frame(const remotekit_rtc_frame& f, bool has_rtp = false) {
    TraceIds ids;
    ids.frame_id = f.frame_id;
    ids.capture_time_us = f.capture_time_us;
    ids.capture_qpc = f.capture_qpc;
    ids.layout_epoch = f.layout_epoch;
    ids.rtp_timestamp = f.rtp_timestamp;
    ids.rtp_known = has_rtp;
    return ids;
  }
};
struct TraceRecord {
  RateTelemetry brc;
  const char *event = "", *reason = nullptr;
  const char* admission_class = nullptr;
  uint64_t admission_wait_us = 0;
  TraceIds ids;
  int64_t qpc = 0, qpc_before = 0, qpc_after = 0, clock_frequency = 0;
  uint64_t peer = 0, encoder = 0, cookie = 0, fence = 0, completed_fence = 0, bytes = 0,
           wall_filetime = 0;
  uint64_t client_sequence = 0, browser_sequence = 0, view = 0, instance = 0, document = 0,
           focus = 0;
  uint32_t producer_pid = 0, bitrate_bps = 0, fps = 0;
  int status = 0, pending = -1, leased = -1, queue = -1, inflight = -1, slot = -1, refs = -1;
  int consistent = -1, high_resolution = -1;
};
// Opt-in diagnostics. The ring is fixed-size; frame-path records contain only
// numbers/literal strings. JSON serialization and disk I/O happen on Flush.
class ServerTrace {
 public:
  static std::shared_ptr<ServerTrace> Create(const std::string& tenant,
                                             const std::string& session) {
    wchar_t path[32768]{};
    const DWORD count = GetEnvironmentVariableW(L"REMOTEKIT_SERVER_TRACE", path, 32768);
    if (!count || count >= 32768)
      return {};
    auto root = std::filesystem::path(path);
    if (root == L"1")
      root = std::filesystem::path(L"develop/tmp/server-trace");
    auto created = CreateDirectories(root);
    if (!created) {
      fprintf(stderr, "server trace: %s\n", created.error().message.c_str());
      return {};
    }
    return std::shared_ptr<ServerTrace>(new ServerTrace(root, tenant, session));
  }
  ~ServerTrace() {
    auto flushed = Flush();
    if (!flushed)
      fprintf(stderr, "server trace: %s\n", flushed.error().message.c_str());
  }
  void Add(TraceRecord record) {
    if (!record.qpc) {
      LARGE_INTEGER now;
      QueryPerformanceCounter(&now);
      record.qpc = now.QuadPart;
    }
    std::lock_guard lock(mutex_);
    records_[written_ % records_.size()] = record;
    ++written_;
  }
  void WallClock() {
    TraceRecord record;
    record.event = "clock_wall";
    FILETIME time;
    LARGE_INTEGER before, after;
    QueryPerformanceCounter(&before);
    GetSystemTimePreciseAsFileTime(&time);
    QueryPerformanceCounter(&after);
    record.qpc_before = before.QuadPart;
    record.qpc_after = after.QuadPart;
    record.qpc = before.QuadPart + (after.QuadPart - before.QuadPart) / 2;
    record.wall_filetime = (uint64_t(time.dwHighDateTime) << 32) | time.dwLowDateTime;
    Add(record);
  }
  void SdkClock(const remotekit_rtc_clock_sample& sample) {
    TraceRecord record;
    record.event = "clock_sdk";
    record.ids.capture_time_us = sample.monotonic_us;
    record.qpc_before = sample.qpc_before;
    record.qpc_after = sample.qpc_after;
    record.clock_frequency = sample.qpc_frequency;
    record.consistent = sample.consistent_across_processes;
    record.high_resolution = sample.high_resolution;
    Add(record);
  }
  Result<void> Flush() {
    std::vector<TraceRecord> copy;
    uint64_t total;
    {
      std::lock_guard lock(mutex_);
      total = written_;
      const auto count = std::min<uint64_t>(total, records_.size());
      copy.reserve(static_cast<size_t>(count));
      for (uint64_t i = total - count; i < total; ++i)
        copy.push_back(records_[i % records_.size()]);
    }
    std::lock_guard file_lock(file_mutex_);
    std::ofstream out(path_, std::ios::trunc);
    if (!out)
      return Error{ErrorCode::kUnavailable, "cannot open trace output"};
    out << nlohmann::json{{"event", "trace_header"},
                          {"schema", "trace-v1"},
                          {"pid", GetCurrentProcessId()},
                          {"tenant", tenant_},
                          {"session", session_},
                          {"qpc_frequency", frequency_},
                          {"records_total", total},
                          {"records_overwritten", total - copy.size()},
                          {"capacity", records_.size()},
                          {"gpu_completion_semantics",
                           "CPU observation after real fence/SyncOperation; not GPU timestamp"}}
               .dump()
        << '\n';
    for (const auto& r : copy) {
      nlohmann::json value = {{"event", r.event},  {"pid", GetCurrentProcessId()},
                              {"tenant", tenant_}, {"session", session_},
                              {"qpc", r.qpc},      {"qpc_frequency", frequency_},
                              {"status", r.status}};
      const auto& i = r.ids;
      auto add = [&](const char* name, auto number) {
        if (number)
          value[name] = number;
      };
      add("frame_id", i.frame_id);
      add("source_frame_id", i.source_frame_id);
      add("generation", i.generation);
      add("atlas_pool", i.atlas_pool);
      add("capture_time_us", i.capture_time_us);
      add("capture_qpc", i.capture_qpc);
      add("layout_epoch", i.layout_epoch);
      // Zero is a valid RTP timestamp; include both on relevant encode records.
      if (i.rtp_known)
        value["rtp_timestamp"] = i.rtp_timestamp;
      if (i.wire_known)
        value["wire_rtp_timestamp"] = i.wire_rtp_timestamp;
      add("producer_pid", r.producer_pid);
      add("bitrate_bps", r.bitrate_bps);
      add("fps", r.fps);
      add("client_sequence", r.client_sequence);
      add("browser_sequence", r.browser_sequence);
      add("view", r.view);
      add("instance", r.instance);
      add("document", r.document);
      add("focus", r.focus);
      add("peer", r.peer);
      add("encoder", r.encoder);
      add("cookie", r.cookie);
      add("fence", r.fence);
      add("completed_fence", r.completed_fence);
      add("bytes", r.bytes);
      if (r.reason)
        value["reason"] = r.reason;
      if (r.admission_class) {
        value["admission_class"] = r.admission_class;
        value["permit_wait_us"] = r.admission_wait_us;
      }
      for (auto [name, number] : {std::pair{"pool_pending", r.pending},
                                  {"pool_leased", r.leased},
                                  {"queue", r.queue},
                                  {"inflight", r.inflight},
                                  {"slot", r.slot},
                                  {"slot_refs", r.refs}})
        if (number >= 0)
          value[name] = number;
      if (r.qpc_before) {
        value["qpc_before"] = r.qpc_before;
        value["qpc_after"] = r.qpc_after;
        value["bracket_uncertainty_us"] = 500000.0 * (r.qpc_after - r.qpc_before) / frequency_;
      }
      if (r.wall_filetime) {
        value["filetime_100ns"] = std::to_string(r.wall_filetime);
        value["unix_time_us"] =
            static_cast<int64_t>((r.wall_filetime - 116444736000000000ULL) / 10);
      }
      if (r.clock_frequency)
        value["sample_qpc_frequency"] = r.clock_frequency;
      if (r.consistent >= 0)
        value["consistent_across_processes"] = r.consistent;
      if (r.high_resolution >= 0)
        value["high_resolution"] = r.high_resolution;
      if (r.brc.target_bps) {
        const auto& b = r.brc;
        value["brc"] = {{"dt_eff", b.dt},
                        {"dt_raw", b.dt_raw},
                        {"tau", b.tau},
                        {"tau_known", b.tau_known},
                        {"B", b.budget},
                        {"T", b.target},
                        {"fullness", b.fullness},
                        {"fullness_after", b.fullness_after},
                        {"qp", b.qp},
                        {"predicted_bits", b.predicted_bits},
                        {"actual_bits", b.actual_bits},
                        {"cap", b.cap},
                        {"recode", b.recodes},
                        {"cap_hits", b.cap_hits},
                        {"target_bps", b.target_bps},
                        {"maximum_bps", b.maximum_bps},
                        {"keepalive", b.frame.keepalive},
                        {"idr", b.frame.idr}};
      }
      out << value.dump() << '\n';
    }
    out.flush();
    if (!out)
      return Error{ErrorCode::kUnavailable, "cannot write trace output"};
    return {};
  }

 private:
  ServerTrace(const std::filesystem::path& root, std::string tenant, std::string session)
      : tenant_(std::move(tenant)), session_(std::move(session)), records_(65536) {
    LARGE_INTEGER frequency;
    QueryPerformanceFrequency(&frequency);
    frequency_ = frequency.QuadPart;
    path_ = root /
            ("server-" + std::to_string(GetCurrentProcessId()) + "-session-" + session_ + ".jsonl");
    WallClock();
  }
  std::string tenant_, session_;
  std::filesystem::path path_;
  int64_t frequency_ = 0;
  std::mutex mutex_, file_mutex_;
  std::vector<TraceRecord> records_;
  uint64_t written_ = 0;
};
}  // namespace remotekit::media
#define RK_SERVER_TRACE(sink, trace_event, trace_ids, ...) \
  do {                                                     \
    if (sink) {                                            \
      ::remotekit::media::TraceRecord rk_record;           \
      rk_record.event = trace_event;                       \
      rk_record.ids = trace_ids;                           \
      __VA_ARGS__;                                         \
      (sink)->Add(rk_record);                              \
    }                                                      \
  } while (false)
