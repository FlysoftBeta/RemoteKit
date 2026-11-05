#include "remotekit/browser/sdk/rtc_internal.h"
using namespace remotekit::rtc;
namespace remotekit::rtc {
template <typename T>
void PutStat(base::DictValue& destination, const char* key, const std::optional<T>& value) {
  if (!value)
    return;
  if constexpr (std::is_floating_point_v<T>)
    if (!std::isfinite(*value))
      return;
  if constexpr (std::is_same_v<T, std::string> || std::is_same_v<T, bool>)
    destination.Set(key, *value);
  else
    destination.Set(key, static_cast<double>(*value));
}
base::DictValue CandidateStats(const webrtc::RTCIceCandidateStats& candidate) {
  auto result = base::DictValue().Set("id", candidate.id());
  PutStat(result, "address", candidate.address);
  PutStat(result, "ip", candidate.ip);
  PutStat(result, "port", candidate.port);
  PutStat(result, "protocol", candidate.protocol);
  PutStat(result, "candidateType", candidate.candidate_type);
  PutStat(result, "relayProtocol", candidate.relay_protocol);
  return result;
}
class StatsObserver : public webrtc::RTCStatsCollectorCallback {
 public:
  explicit StatsObserver(std::weak_ptr<Peer> peer) : peer_(std::move(peer)) {}
  void OnStatsDelivered(const scoped_refptr<const webrtc::RTCStatsReport>& report) override {
    auto peer = peer_.lock();
    if (!peer)
      return;
    if (peer->closing.load()) {
      peer->stats_pending = false;
      return;
    }
    auto result =
        base::DictValue()
            .Set("type", "sender-rtc-stats")
            .Set("sampleTimeUs", static_cast<double>(report->timestamp().us()))
            .Set("callbackMonotonicUs",
                 static_cast<double>(base::TimeTicks::Now().since_origin().InMicroseconds()));
    const uint64_t requested = peer->playout_delay->packed.load();
    result.Set(
        "requestedPlayoutDelay",
        base::DictValue()
            .Set("minMs", requested == UINT64_MAX ? -1 : static_cast<int>(requested >> 32))
            .Set("maxMs", requested == UINT64_MAX ? -1 : static_cast<int>(requested & UINT32_MAX)));
    result.Set("audioTimeline",
               base::DictValue()
                   .Set("silenceBlocks", static_cast<double>(peer->audio_silence_blocks.load()))
                   .Set("gapRestarts", static_cast<double>(peer->audio_restarts_gap.load()))
                   .Set("epochRestarts", static_cast<double>(peer->audio_restarts_epoch.load()))
                   .Set("discontinuityRestarts",
                        static_cast<double>(peer->audio_restarts_discontinuity.load()))
                   .Set("lastRestartReason",
                        peer->audio_last_restart.load() == 1   ? "source-gap"
                        : peer->audio_last_restart.load() == 2 ? "source-generation"
                        : peer->audio_last_restart.load() == 3 ? "source-discontinuity"
                                                               : "none"));
    base::ListValue outbound;
    std::string transport_id;
    for (const auto* stream : report->GetStatsOfType<webrtc::RTCOutboundRtpStreamStats>()) {
      const auto kind = stream->kind.value_or("");
      if (kind != "video" && kind != "audio")
        continue;
      if (transport_id.empty() || kind == "video")
        transport_id = stream->transport_id.value_or("");
      auto row = base::DictValue().Set("id", stream->id());
      PutStat(row, "ssrc", stream->ssrc);
      PutStat(row, "kind", stream->kind);
      PutStat(row, "mid", stream->mid);
      PutStat(row, "transportId", stream->transport_id);
      PutStat(row, "codecId", stream->codec_id);
      PutStat(row, "bytesSent", stream->bytes_sent);
      PutStat(row, "packetsSent", stream->packets_sent);
      PutStat(row, "retransmittedBytesSent", stream->retransmitted_bytes_sent);
      PutStat(row, "retransmittedPacketsSent", stream->retransmitted_packets_sent);
      PutStat(row, "framesEncoded", stream->frames_encoded);
      PutStat(row, "keyFramesEncoded", stream->key_frames_encoded);
      PutStat(row, "framesSent", stream->frames_sent);
      PutStat(row, "framesPerSecond", stream->frames_per_second);
      PutStat(row, "frameWidth", stream->frame_width);
      PutStat(row, "frameHeight", stream->frame_height);
      PutStat(row, "totalEncodeTime", stream->total_encode_time);
      PutStat(row, "totalPacketSendDelay", stream->total_packet_send_delay);
      PutStat(row, "targetBitrate", stream->target_bitrate);
      PutStat(row, "qualityLimitationReason", stream->quality_limitation_reason);
      PutStat(row, "nackCount", stream->nack_count);
      PutStat(row, "pliCount", stream->pli_count);
      PutStat(row, "firCount", stream->fir_count);
      if (stream->quality_limitation_durations) {
        base::DictValue durations;
        for (const auto& [reason, seconds] : *stream->quality_limitation_durations)
          if (std::isfinite(seconds))
            durations.Set(reason, seconds);
        row.Set("qualityLimitationDurations", std::move(durations));
      }
      outbound.Append(std::move(row));
    }
    result.Set("outbound", std::move(outbound));
    const auto* transport = report->GetAs<webrtc::RTCTransportStats>(transport_id);
    if (!transport) {
      for (const auto* candidate : report->GetStatsOfType<webrtc::RTCTransportStats>())
        if (candidate->selected_candidate_pair_id) {
          transport = candidate;
          break;
        }
    }
    const auto* pair = transport && transport->selected_candidate_pair_id
                           ? report->GetAs<webrtc::RTCIceCandidatePairStats>(
                                 *transport->selected_candidate_pair_id)
                           : nullptr;
    if (pair) {
      auto row = base::DictValue().Set("id", pair->id());
      PutStat(row, "state", pair->state);
      PutStat(row, "nominated", pair->nominated);
      PutStat(row, "currentRoundTripTime", pair->current_round_trip_time);
      PutStat(row, "totalRoundTripTime", pair->total_round_trip_time);
      PutStat(row, "availableOutgoingBitrate", pair->available_outgoing_bitrate);
      PutStat(row, "bytesSent", pair->bytes_sent);
      PutStat(row, "bytesReceived", pair->bytes_received);
      PutStat(row, "packetsSent", pair->packets_sent);
      PutStat(row, "packetsReceived", pair->packets_received);
      result.Set("selectedPair", std::move(row));
      if (pair->local_candidate_id) {
        if (const auto* candidate =
                report->GetAs<webrtc::RTCLocalIceCandidateStats>(*pair->local_candidate_id))
          result.Set("localCandidate", CandidateStats(*candidate));
      }
      if (pair->remote_candidate_id) {
        if (const auto* candidate =
                report->GetAs<webrtc::RTCRemoteIceCandidateStats>(*pair->remote_candidate_id))
          result.Set("remoteCandidate", CandidateStats(*candidate));
      }
    }
    if (auto json = base::WriteJson(result))
      peer->Event(REMOTEKIT_RTC_STATS, json->data(), json->size());
    peer->stats_pending = false;
  }

 private:
  std::weak_ptr<Peer> peer_;
};

}  // namespace remotekit::rtc
int remotekit_rtc_request_stats(uint64_t id) {
  return WithPeer(id, [](Peer& peer) {
    if (peer.stats_pending.exchange(true))
      return REMOTEKIT_SDK_BUSY;
    auto callback = webrtc::make_ref_counted<StatsObserver>(peer.weak_from_this());
    peer.pc->GetStats(callback.get());
    return REMOTEKIT_SDK_OK;
  });
}
