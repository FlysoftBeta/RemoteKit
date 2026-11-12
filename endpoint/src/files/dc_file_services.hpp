#pragma once
#include "util/log.hpp"
#include "util/result_macros.hpp"
#include "util/thread.hpp"
#include "util/error.hpp"
#include "util/wire_error.hpp"
#include "rtc/dc_services.hpp"
#include "files/file_upload.hpp"
#include "files/photo_processing.hpp"
#include <chrono>
#include <condition_variable>
#include <cctype>
#include <functional>
#include <set>
#include <thread>
#include <vector>

namespace remotekit {
inline bool PhotoBurstMethod(const ServiceJson& method) {
  return method == "photo.burst.begin" || method == "photo.burst.sample" ||
         method == "photo.burst.end" || method == "photo.burst.cancel";
}
inline bool LibraryFileMethod(const ServiceJson& method) {
  return method == "asset.begin" || method == "asset.chunk" || method == "asset.seal" ||
         method == "asset.cancel" || method == "asset.read" || method == "asset.describe" ||
         method == "document.open" || method == "document.resource" || method == "photo.process" ||
         method == "photo.thumbnail" || PhotoBurstMethod(method);
}
inline std::string EncodeFileChunk(const std::vector<std::uint8_t>& bytes) {
  constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string result;
  result.reserve((bytes.size() + 2) / 3 * 4);
  for (size_t i = 0; i < bytes.size(); i += 3) {
    const unsigned a = bytes[i], b = i + 1 < bytes.size() ? bytes[i + 1] : 0,
                   c = i + 2 < bytes.size() ? bytes[i + 2] : 0;
    result += alphabet[a >> 2];
    result += alphabet[((a & 3) << 4) | (b >> 4)];
    result += i + 1 < bytes.size() ? alphabet[((b & 15) << 2) | (c >> 6)] : '=';
    result += i + 2 < bytes.size() ? alphabet[c & 63] : '=';
  }
  return result;
}
inline Result<std::vector<std::uint8_t>> DecodeFileChunk(const ServiceJson& value,
                                                         size_t max_bytes = 16384) {
  if (!value.is_string())
    return Error{ErrorCode::kInvalidRequest, "invalid_file_chunk_encoding"};
  const auto& text = value.get_ref<const std::string&>();
  if (text.empty() || text.size() > (max_bytes + 2) / 3 * 4 || text.size() % 4)
    return Error{ErrorCode::kInvalidRequest, "invalid_file_chunk_encoding"};
  auto digit = [](unsigned char c) -> int {
    if (c >= 'A' && c <= 'Z')
      return c - 'A';
    if (c >= 'a' && c <= 'z')
      return c - 'a' + 26;
    if (c >= '0' && c <= '9')
      return c - '0' + 52;
    if (c == '+')
      return 62;
    if (c == '/')
      return 63;
    return -1;
  };
  std::vector<std::uint8_t> bytes;
  bytes.reserve(text.size() / 4 * 3);
  for (size_t i = 0; i < text.size(); i += 4) {
    const int a = digit(text[i]), b = digit(text[i + 1]);
    const bool last = i + 4 == text.size(), pad2 = text[i + 2] == '=', pad3 = text[i + 3] == '=';
    const int c = pad2 ? 0 : digit(text[i + 2]), d = pad3 ? 0 : digit(text[i + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0 || ((pad2 || pad3) && !last) || (pad2 && !pad3) ||
        (pad2 && (b & 15)) || (pad3 && !pad2 && (c & 3)))
      return Error{ErrorCode::kInvalidRequest, "invalid_file_chunk_encoding"};
    bytes.push_back(static_cast<std::uint8_t>((a << 2) | (b >> 4)));
    if (!pad2)
      bytes.push_back(static_cast<std::uint8_t>((b << 4) | (c >> 2)));
    if (!pad3)
      bytes.push_back(static_cast<std::uint8_t>((c << 6) | d));
  }
  if (bytes.size() > max_bytes)
    return Error{ErrorCode::kLimitExceeded, "file_chunk_too_large"};
  return bytes;
}
inline bool FileRequestEnvelope(const ServiceJson& message, size_t bytes) {
  if (bytes > 61440 || !message.is_object() || message.value("version", ServiceJson()) != 1 ||
      !message.contains("requestId") || !BoundedServiceId(message["requestId"], 36) ||
      message["requestId"].get_ref<const std::string&>().size() != 36 ||
      !message.contains("params") || !message["params"].is_object() ||
      !message["params"].contains("requestId") || !BoundedServiceId(message["params"]["requestId"]))
    return false;
  const auto& id = message["requestId"].get_ref<const std::string&>();
  for (size_t i = 0; i < id.size(); ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (id[i] != '-')
        return false;
    } else if (!std::isxdigit(static_cast<unsigned char>(id[i])))
      return false;
  }
  const auto method = message.value("method", ServiceJson());
  if (method != "photo.burst.sample" && bytes > 24576)
    return false;
  return method == "selection.commit" || method == "selection.cancel" || LibraryFileMethod(method);
}

// Session disk-worker state. The library grant serial is unique across
// authorization and peer changes, even when a new peer reuses the same IDs.
template <class Analyzer>
class PhotoBurstSessions {
 public:
  using Clock = std::chrono::steady_clock;
  static constexpr size_t kMaxSampleBytes = 44 * 1024;

  void Sweep(const std::function<bool(uint64_t)>& current, Clock::time_point now = Clock::now()) {
    const auto expired = [&](const auto& item) {
      return now >= item.second.deadline || !current(item.second.grant);
    };
    std::erase_if(active_, expired);
    std::erase_if(terminal_, expired);
  }

  Result<ServiceJson> Execute(uint64_t grant,
                              const std::string& method,
                              const ServiceJson& params,
                              const PhotoCancelled& cancelled) {
    if (cancelled())
      return Error{ErrorCode::kOutcomeUnknown, "file_transfer_interrupted"};
    const auto now = Clock::now();
    if (method == "photo.burst.begin") {
      if (active_.size() >= 2)
        return Error{ErrorCode::kBusy, "photo_burst_busy"};
      const auto id = std::to_string(++sequence_);
      active_.try_emplace(id, grant, now + std::chrono::seconds(5));
      return ServiceJson{{"burstId", id}};
    }
    RK_ASSIGN_OR_RETURN(id, ReadId(params.value("burstId", ServiceJson())));
    auto active = active_.find(id);
    if (method == "photo.burst.cancel") {
      if (active != active_.end() && active->second.grant == grant)
        active_.erase(active);
      return ServiceJson{{"cancelled", true}};
    }
    RK_ASSIGN_OR_RETURN(available, ReadPool(params.value("availableFrameIds", ServiceJson())));
    const bool ending = method == "photo.burst.end";
    if (ending) {
      const auto terminal = terminal_.find(id);
      if (terminal != terminal_.end() && terminal->second.grant == grant &&
          now < terminal->second.deadline) {
        if (terminal->second.available != available)
          return Error{ErrorCode::kConflict, "photo_burst_end_conflict"};
        return Replay(terminal->second);
      }
    }
    if (active == active_.end() || active->second.grant != grant || now >= active->second.deadline)
      return Error{ErrorCode::kNotFound, "unknown_photo_burst"};
    auto& burst = active->second;
    if (ending) {
      RK_RETURN_IF_ERROR(ValidatePool(burst, available, {}));
      Terminal terminal{grant, now + std::chrono::seconds(30), available, {}, {}};
      Result<ServiceJson> result = Error{ErrorCode::kInvalidRequest, "photo_burst_no_samples"};
      if (!available.empty()) {
        auto decision = burst.analyzer.Finish(available);
        result = decision ? WireDecision(decision.value(), available)
                          : Result<ServiceJson>(decision.error());
      }
      if (result)
        terminal.result = std::move(result).value();
      else
        terminal.error = result.error();
      active_.erase(active);
      if (cancelled())
        return Error{ErrorCode::kOutcomeUnknown, "file_transfer_interrupted"};
      if (terminal_.size() >= 32) {
        const auto oldest = std::min_element(
            terminal_.begin(), terminal_.end(),
            [](const auto& a, const auto& b) { return a.second.deadline < b.second.deadline; });
        terminal_.erase(oldest);
      }
      return Replay(terminal_.emplace(id, std::move(terminal)).first->second);
    }
    if (burst.seen.size() >= 20 || burst.stopped)
      return Error{ErrorCode::kLimitExceeded, "photo_burst_sample_limit"};
    RK_ASSIGN_OR_RETURN(frame, ReadId(params.value("frameId", ServiceJson())));
    if (burst.seen.contains(frame))
      return Error{ErrorCode::kConflict, "photo_burst_frame_replay"};
    if (std::find(available.begin(), available.end(), frame) == available.end())
      return Error{ErrorCode::kInvalidRequest, "invalid_photo_burst_pool"};
    RK_RETURN_IF_ERROR(ValidatePool(burst, available, frame));
    burst.seen.insert(frame);
    RK_ASSIGN_OR_RETURN(data,
                        DecodeFileChunk(params.value("data", ServiceJson()), kMaxSampleBytes));
    RK_ASSIGN_OR_RETURN(decision, burst.analyzer.Observe(frame, data, available, [&] {
      return Clock::now() >= burst.deadline || cancelled();
    }));
    if (cancelled())
      return Error{ErrorCode::kOutcomeUnknown, "file_transfer_interrupted"};
    if (Clock::now() >= burst.deadline)
      return Error{ErrorCode::kNotFound, "unknown_photo_burst"};
    auto result = WireDecision(decision, available);
    burst.available = available;
    burst.stopped = decision.stop;
    return result;
  }

 private:
  struct Burst {
    uint64_t grant;
    Clock::time_point deadline;
    Analyzer analyzer;
    std::set<std::string> seen;
    std::vector<std::string> available;
    bool stopped = false;
    Burst(uint64_t grant, Clock::time_point deadline) : grant(grant), deadline(deadline) {}
  };
  struct Terminal {
    uint64_t grant;
    Clock::time_point deadline;
    std::vector<std::string> available;
    ServiceJson result;
    std::optional<Error> error;
  };
  uint64_t sequence_{};
  std::map<std::string, Burst> active_;
  std::map<std::string, Terminal> terminal_;

  static Result<std::string> ReadId(const ServiceJson& value) {
    if (!BoundedServiceId(value, 64))
      return Error{ErrorCode::kInvalidRequest, "invalid_photo_burst_id"};
    return value.get<std::string>();
  }
  static Result<std::vector<std::string>> ReadPool(const ServiceJson& value) {
    if (!value.is_array() || value.size() > 3)
      return Error{ErrorCode::kInvalidRequest, "invalid_photo_burst_pool"};
    std::vector<std::string> pool;
    for (const auto& item : value) {
      RK_ASSIGN_OR_RETURN(id, ReadId(item));
      if (std::find(pool.begin(), pool.end(), id) != pool.end())
        return Error{ErrorCode::kInvalidRequest, "invalid_photo_burst_pool"};
      pool.push_back(id);
    }
    return pool;
  }
  static Result<void> ValidatePool(const Burst& burst,
                                   const std::vector<std::string>& pool,
                                   const std::string& current) {
    for (const auto& id : pool)
      if (id != current &&
          std::find(burst.available.begin(), burst.available.end(), id) == burst.available.end())
        return Error{ErrorCode::kInvalidRequest, "invalid_photo_burst_pool"};

    return {};
  }
  static Result<ServiceJson> Replay(const Terminal& terminal) {
    if (terminal.error)
      return *terminal.error;
    return terminal.result;
  }
  static Result<ServiceJson> WireDecision(const PhotoBurstDecision& decision,
                                          const std::vector<std::string>& available) {
    const auto present = [&](const std::string& id) {
      return std::find(available.begin(), available.end(), id) != available.end();
    };
    if (!present(decision.selected_frame_id) || decision.keep_frame_ids.size() > 2 ||
        decision.candidates.size() > 2 ||
        !std::all_of(decision.keep_frame_ids.begin(), decision.keep_frame_ids.end(), present))
      return Error{ErrorCode::kInvalidRequest, "invalid_photo_burst_decision"};
    ServiceJson candidates = ServiceJson::array();
    for (const auto& candidate : decision.candidates) {
      if (!present(candidate.frame_id))
        return Error{ErrorCode::kInvalidRequest, "invalid_photo_burst_decision"};
      candidates.push_back({{"frameId", candidate.frame_id}, {"score", candidate.score}});
    }
    return ServiceJson{{"selectedFrameId", decision.selected_frame_id},
                       {"keepFrameIds", decision.keep_frame_ids},
                       {"candidates", std::move(candidates)},
                       {"uncertain", decision.uncertain},
                       {"stop", decision.stop},
                       {"reason", decision.reason}};
  }
};

// One Session-lifetime disk worker. No caller waits for it while holding a
// Session/Browser lock. Admission, receipts and replay history are bounded.
class DcFileServices {
  const Json log_fields_;

 public:
  explicit DcFileServices(Json log_fields = Json::object()) : log_fields_(std::move(log_fields)) {}
  struct Job {
    uint64_t peer{}, epoch{}, control{};
    ServiceJson message;
    FileUploadStore::Binding binding;
    uint64_t grant{};
  };
  using Execute = std::function<Result<ServiceJson>(const Job&)>;
  using Sweep = std::function<void()>;

 private:
  struct Receipt {
    std::string fingerprint;
    ServiceJson reply;
    bool chunk = false;
    uint64_t grant{};
  };
  mutable std::mutex mutex_;
  std::mutex flush_mutex_;
  std::condition_variable wake_;
  std::thread worker_;
  bool stop_ = false, sweep_requested_ = false;
  uint64_t peer_ = 0, epoch_ = 0, control_ = 0;
  std::string connection_;
  struct Grant {
    FileUploadStore::Binding binding;
    uint64_t serial;
  };
  std::map<std::string, Grant> authorized_;
  uint64_t grant_serial_ = 0, delivery_serial_ = 0;
  struct Delivery {
    uint64_t serial, grant;
    std::string wire;
  };
  std::deque<Job> jobs_;
  std::map<std::string, Receipt> receipts_;
  std::deque<std::string> history_;
  std::deque<Delivery> outbox_;
  void QueueReply(const ServiceJson& reply, uint64_t grant) {
    if (outbox_.size() < 32)
      outbox_.push_back({++delivery_serial_, grant, reply.dump()});
  }
  bool CurrentLocked(const Job& job) const {
    if (!peer_ || job.peer != peer_ || job.epoch != epoch_ || job.control != control_)
      return false;
    const auto& id = job.message["params"]["requestId"].get_ref<const std::string&>();
    const auto found = authorized_.find(id);
    return found != authorized_.end() && found->second.serial == job.grant;
  }
  ServiceJson Reply(const ServiceJson& request, bool ok, const ServiceJson& value) {
    ServiceJson result = {
        {"type", "files.result"}, {"version", 1}, {"requestId", request["requestId"]}, {"ok", ok}};
    result[ok ? "result" : "error"] = value;
    return result;
  }

 public:
  ~DcFileServices() { Stop(); }
  void Start(Execute execute, Sweep sweep) {
    worker_ = std::thread([this, execute = std::move(execute), sweep = std::move(sweep)] {
      RunThread(
          "disk",
          [&] {
            for (;;) {
              Job job;
              {
                std::unique_lock lock(mutex_);
                wake_.wait_for(lock, std::chrono::seconds(1),
                               [&] { return stop_ || sweep_requested_ || !jobs_.empty(); });
                if (stop_)
                  return;
                sweep_requested_ = false;
                if (!jobs_.empty()) {
                  job = std::move(jobs_.front());
                  jobs_.pop_front();
                }
              }
              sweep();
              if (!job.peer)
                continue;
              ServiceJson reply;
              try {
                Result<ServiceJson> executed =
                    Error{ErrorCode::kConflict, "file_transfer_interrupted"};
                if (Current(job))
                  executed = execute(job);
                reply = executed ? Reply(job.message, true, executed.value())
                                 : Reply(job.message, false,
                                         WireError(executed.error(), "dc.request_failed",
                                                   RequestLogFields(job.message, log_fields_)));
              } catch (const InvalidRequest& error) {
                reply =
                    Reply(job.message, false,
                          WireError({ErrorCode::kInvalidRequest, error.what()}, "dc.request_failed",
                                    RequestLogFields(job.message, log_fields_)));
              } catch (const ServiceJson::exception& error) {
                LogError(LogLevel::kWarn, "files.invalid_request",
                         Error{ErrorCode::kInvalidRequest, error.what()});
                reply = Reply(
                    job.message, false,
                    WireError({ErrorCode::kInternal, "Invalid file worker state"},
                              "dc.request_failed", RequestLogFields(job.message, log_fields_)));
              } catch (const std::filesystem::filesystem_error& error) {
                reply = Reply(
                    job.message, false,
                    WireError(WithOsError(ErrorCode::kUnavailable, error.what(),
                                          OsError::Kind::kWin32, error.code().value()),
                              "dc.request_failed", RequestLogFields(job.message, log_fields_)));
              } catch (const std::exception& error) {
                LogError(LogLevel::kWarn, "files.worker_failed",
                         Error{ErrorCode::kInternal, error.what()});
                reply = Reply(job.message, false,
                              WireError({ErrorCode::kInternal, "internal"}, "dc.request_failed",
                                        RequestLogFields(job.message, log_fields_)));
              } catch (...) {
                LogError(LogLevel::kWarn, "files.worker_failed",
                         Error{ErrorCode::kInternal, "unknown exception"});
                reply = Reply(job.message, false,
                              WireError({ErrorCode::kInternal, "internal"}, "dc.request_failed",
                                        RequestLogFields(job.message, log_fields_)));
              }
              std::lock_guard lock(mutex_);
              if (!CurrentLocked(job))
                continue;
              const auto key = job.message["requestId"].get<std::string>();
              auto found = receipts_.find(key);
              if (found == receipts_.end())
                continue;
              found->second.reply = reply;
              history_.push_back(key);
              QueueReply(reply, job.grant);
              while (history_.size() > 128) {
                receipts_.erase(history_.front());
                history_.pop_front();
              }
            }
          },
          [this] {
            std::lock_guard lock(mutex_);
            stop_ = true;
            jobs_.clear();
            authorized_.clear();
            outbox_.clear();
          });
    });
  }
  void Stop() {
    {
      std::lock_guard lock(mutex_);
      stop_ = true;
      jobs_.clear();
    }
    wake_.notify_all();
    if (worker_.joinable())
      worker_.join();
  }
  void Bind(uint64_t peer, std::string connection = {}) {
    std::lock_guard lock(mutex_);
    peer_ = peer;
    ++epoch_;
    connection_ = std::move(connection);
    authorized_.clear();
    jobs_.clear();
    receipts_.clear();
    history_.clear();
    outbox_.clear();
    sweep_requested_ = true;
    wake_.notify_all();
  }
  Result<void> Authorize(const std::string& connection,
                         uint64_t control,
                         const std::map<std::string, FileUploadStore::Binding>& requests,
                         bool library = false) {
    std::lock_guard lock(mutex_);
    if (connection != connection_ || !peer_)
      return Error{ErrorCode::kConflict, "stale_file_authorization"};
    std::map<std::string, Grant> next;
    const auto add = [&](const std::string& id, const FileUploadStore::Binding& binding) {
      const auto previous = authorized_.find(id);
      if (control == control_ && previous != authorized_.end() &&
          previous->second.binding == binding)
        next.emplace(id, previous->second);
      else
        next.emplace(id, Grant{binding, ++grant_serial_});
    };
    for (const auto& [id, binding] : requests)
      if (id != "library")
        add(id, binding);
    if (library)
      add("library", {});
    const auto retained = [&](uint64_t grant) {
      return std::any_of(next.begin(), next.end(),
                         [&](const auto& item) { return item.second.serial == grant; });
    };
    const bool retired = std::any_of(authorized_.begin(), authorized_.end(), [&](const auto& item) {
      return !retained(item.second.serial);
    });
    if (retired) {
      sweep_requested_ = true;
      std::erase_if(jobs_, [&](const auto& job) { return !retained(job.grant); });
      std::erase_if(receipts_, [&](const auto& item) { return !retained(item.second.grant); });
      std::erase_if(history_, [&](const auto& key) { return !receipts_.contains(key); });
      std::erase_if(outbox_, [&](const auto& delivery) {
        return delivery.grant && !retained(delivery.grant);
      });
    }
    control_ = control;
    authorized_ = std::move(next);
    wake_.notify_all();
    return {};
  }
  bool Current(const Job& job) const {
    std::lock_guard lock(mutex_);
    return CurrentLocked(job);
  }
  bool CurrentLibraryGrant(uint64_t grant) const {
    std::lock_guard lock(mutex_);
    const auto found = authorized_.find("library");
    return peer_ && found != authorized_.end() && found->second.serial == grant;
  }
  void Admit(uint64_t peer, const ServiceJson& message) {
    std::lock_guard lock(mutex_);
    if (peer != peer_ || !peer_)
      return;
    const auto key = message["requestId"].get<std::string>(), fingerprint = message.dump();
    auto failure = [&](ErrorCode code, const char* error) {
      QueueReply(Reply(message, false,
                       WireError({code, error}, "dc.request_failed",
                                 RequestLogFields(message, log_fields_))),
                 0);
    };
    const auto id = message["params"].value("requestId", std::string());
    const auto found = authorized_.find(id);
    if (found == authorized_.end() || ((id == "library") != LibraryFileMethod(message["method"]))) {
      failure(ErrorCode::kConflict, "stale_file_request");
      return;
    }
    if (const auto found = receipts_.find(key); found != receipts_.end()) {
      if (found->second.fingerprint != fingerprint)
        failure(ErrorCode::kConflict, "file_request_id_conflict");
      else if (!found->second.reply.is_null())
        QueueReply(found->second.reply, found->second.grant);
      return;
    }
    const bool chunk = message["method"] == "asset.chunk";
    if (jobs_.size() >= 8 || outbox_.size() >= 24 ||
        (chunk && std::count_if(receipts_.begin(), receipts_.end(), [](const auto& item) {
                    return item.second.chunk && item.second.reply.is_null();
                  }) >= 4)) {
      failure(ErrorCode::kBusy, "file_transfer_busy");
      return;
    }
    receipts_.emplace(key, Receipt{fingerprint, nullptr, chunk, found->second.serial});
    jobs_.push_back({peer, epoch_, control_, message, found->second.binding, found->second.serial});
    wake_.notify_one();
  }
  template <class Send>
  void Flush(uint64_t peer, Send send) {
    // SDK send synchronously marshals to its signaling thread. That thread can
    // concurrently call Admit: never hold the admission lock across SDK calls.
    std::unique_lock delivery(flush_mutex_, std::try_to_lock);
    if (!delivery.owns_lock())
      return;
    for (unsigned i = 0; i < 2; ++i) {
      Delivery next;
      uint64_t epoch;
      {
        std::lock_guard lock(mutex_);
        if (!peer || peer != peer_ || outbox_.empty())
          return;
        epoch = epoch_;
        next = outbox_.front();
      }
      if (send(next.wire) != 0)
        return;
      {
        std::lock_guard lock(mutex_);
        if (peer != peer_ || epoch != epoch_)
          return;
        if (!outbox_.empty() && outbox_.front().serial == next.serial)
          outbox_.pop_front();
      }
    }
  }
};
}  // namespace remotekit
