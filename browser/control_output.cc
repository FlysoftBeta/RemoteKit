#include "browser/control_dispatcher.h"
#include "browser/control_requests.h"
#include "browser/control_response.h"
#include "browser/browser_runtime.h"
#include <cmath>
#include <set>
#include "browser/audio_target.h"

namespace remotekit::browser {
Result<OutputConfigureRequest> DecodeOutputConfigure(const base::DictValue& wire,
                                                     RequestEnvelope envelope) {
  OutputConfigureRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  decoder.Consume({"viewConfigs"});
  if (const auto* value = wire.Find("viewConfigs")) {
    if (!value->is_list() || value->GetList().size() > kSharedAtlasMaxViews)
      return {{}, {ErrorCode::kInvalidRequest, "Invalid view configurations"}};
    request.viewConfigs.emplace();
    std::set<WebViewId> identities;
    for (const auto& item : value->GetList()) {
      const auto* config = item.GetIfDict();
      if (!config)
        return {{}, {ErrorCode::kInvalidRequest, "View configuration must be an object"}};
      for (const auto [key, field] : *config)
        if (key != "session" && key != "view" && key != "width" && key != "height" &&
            key != "device" && key != "device_scale_factor" && key != "visible" &&
            key != "occludedBottom" && key != "occlusionRevision")
          return {{}, {ErrorCode::kInvalidRequest, "Unknown view configuration field " + key}};
      ViewConfiguration decoded;
      const auto* session = config->FindString("session");
      const auto* view = config->FindString("view");
      const auto width = config->FindInt("width"), height = config->FindInt("height");
      const auto* device = config->FindString("device");
      const auto* scale = config->Find("device_scale_factor");
      const auto visible = config->FindBool("visible");
      if (!session || !view || !base::StringToUint64(*session, &decoded.session) ||
          !decoded.session || !base::StringToUint64(*view, &decoded.view) || !decoded.view ||
          !identities.insert(decoded.view).second || !width || !height || !device ||
          (*device != "desktop" && *device != "tablet") || !scale ||
          (!scale->is_double() && !scale->is_int()) || !visible)
        return {{}, {ErrorCode::kInvalidRequest, "Invalid view configuration"}};
      const auto occlusion = config->FindInt("occludedBottom");
      const auto* revision = config->FindString("occlusionRevision");
      if (config->contains("occludedBottom") || config->contains("occlusionRevision")) {
        if (!occlusion || *occlusion < 0 || !revision ||
            !base::StringToUint64(*revision, &decoded.viewport.revision))
          return {{}, {ErrorCode::kInvalidRequest, "Invalid page viewport"}};
        decoded.viewport.occluded_bottom = *occlusion;
      }
      decoded.width = *width;
      decoded.height = *height;
      decoded.scale = scale->is_int() ? scale->GetInt() : scale->GetDouble();
      decoded.visible = *visible;
      if (!std::isfinite(decoded.scale) || decoded.scale < .5 || decoded.scale > 4)
        return {{}, {ErrorCode::kInvalidRequest, "Invalid page device scale"}};
      request.viewConfigs->push_back(decoded);
    }
  }
  request.device_scale = decoder.Optional<double>("device_scale");
  request.allocation_alignment = decoder.Optional<int>("allocation_alignment");
  request.enabled = decoder.Optional<bool>("enabled");
  request.width = decoder.Optional<int>("width");
  request.height = decoder.Optional<int>("height");
  return decoder.Finish(std::move(request));
}

Result<OutputOpenRequest> DecodeOutputOpen(const base::DictValue& wire, RequestEnvelope envelope) {
  OutputOpenRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.consumer_pid = decoder.Optional<uint64_t>("consumer_pid");
  return decoder.Finish(std::move(request));
}

Result<OutputStatusRequest> DecodeOutputStatus(const base::DictValue& wire,
                                               RequestEnvelope envelope) {
  OutputStatusRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  return decoder.Finish(std::move(request));
}

Result<OutputCloseRequest> DecodeOutputClose(const base::DictValue& wire,
                                             RequestEnvelope envelope) {
  OutputCloseRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  return decoder.Finish(std::move(request));
}

Result<AudioOpenRequest> DecodeAudioOpen(const base::DictValue& wire, RequestEnvelope envelope) {
  AudioOpenRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.mapping = decoder.Optional<std::string>("mapping");
  request.generation = decoder.Optional<uint64_t>("generation");
  request.session = decoder.Optional<uint64_t>("session");
  return decoder.Finish(std::move(request));
}

Result<AudioCloseRequest> DecodeAudioClose(const base::DictValue& wire, RequestEnvelope envelope) {
  AudioCloseRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  return decoder.Finish(std::move(request));
}

ControlResult ControlDispatcher::HandleOutputConfigure(const OutputConfigureRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](ErrorCode code, std::string detail) {
    return ControlResult::Failure(id, code, detail, std::move(reply));
  };

  auto scale = request.device_scale;
  int next_width = runtime_.layout_transaction.logical_width,
      next_height = runtime_.layout_transaction.logical_height;
  if (request.width)
    next_width = *request.width;
  if (request.height)
    next_height = *request.height;
  if (next_width > 16384 || next_height > 16384)
    return error(ErrorCode::kLimitExceeded, "Atlas dimensions exceed supported bounds");
  if (next_width < 16 || next_height < 16)
    return error(ErrorCode::kInvalidRequest, "invalid_atlas_dimensions");
  if (runtime_.output && (next_width != runtime_.layout_transaction.logical_width ||
                          next_height != runtime_.layout_transaction.logical_height))
    return error(ErrorCode::kConflict, "close_output_before_size_change");
  // Source geometry and output extent are one transaction. In particular,
  // neither the old nor new layout must fit a max(old,new) intermediate atlas.
  auto next_specs = runtime_.views.Specs();
  if (Ptr(request.viewConfigs)) {
    if (runtime_.output)
      return error(ErrorCode::kConflict, "close_output_before_view_transaction");
    for (const auto& config : *request.viewConfigs) {
      if (!runtime_.views.Find(config.session, config.view))
        return error(ErrorCode::kConflict, "view_transaction_identity_mismatch");
      auto& spec = next_specs.at(config.view);
      spec.width = config.width;
      spec.height = config.height;
      spec.page_dsf = config.scale;
      spec.visible = config.visible;
    }
  }
  auto next_scale = runtime_.layout_transaction.output_scale;
  auto next_alignment = runtime_.layout_transaction.allocation_alignment;
  auto next_enabled = runtime_.output_enabled;
  if (Ptr(request.device_scale)) {
    if (!scale || !std::isfinite(*scale) || *scale < 0.5 || *scale > 4)
      return error(ErrorCode::kInvalidRequest, "invalid_device_scale");
    if (runtime_.output)
      return error(ErrorCode::kConflict, "close_output_before_scale_change");
    next_scale = static_cast<float>(*scale);
  }
  if (const auto* value = Ptr(request.allocation_alignment)) {
    if ((*value != 1 && *value != 16))
      return error(ErrorCode::kInvalidRequest, "invalid_allocation_alignment");
    next_alignment = *value;
    if (runtime_.output && next_alignment != runtime_.layout_transaction.allocation_alignment)
      return error(ErrorCode::kConflict, "close_output_before_alignment_change");
  }
  if (const auto* value = Ptr(request.enabled)) {
    next_enabled = *value;
  }
  auto next_layout = runtime_.layout_transaction.Prepare(std::move(next_specs), next_width,
                                                         next_height, next_scale, next_alignment);
  if (!next_layout)
    return ControlResult::Failure(id, *next_layout.status.error, next_layout.status.message);
  if (request.viewConfigs) {
    for (const auto& config : *request.viewConfigs) {
      auto* record = runtime_.views.Find(config.session, config.view);
      if (config.viewport.revision >= record->viewport.revision)
        record->viewport = config.viewport;
    }
  }
  runtime_.layout_transaction.Commit(std::move(next_layout.value));
  runtime_.output_enabled = next_enabled;
  runtime_.UpdateOutput();
  reply.Set("ok", true);
  reply.Set("allocation_alignment",
            static_cast<int>(runtime_.layout_transaction.allocation_alignment));
  reply.Set("width_pixels", static_cast<int>(runtime_.layout_transaction.output_width));
  reply.Set("height_pixels", static_cast<int>(runtime_.layout_transaction.output_height));
  return reply;
}

ControlResult ControlDispatcher::HandleOutputOpen(const OutputOpenRequest& request) {
  const int id = request.id;
  const auto* method = &request.method;
  auto reply = ControlResult::Success(id);
  auto error = [&](ErrorCode code, std::string detail) {
    return ControlResult::Failure(id, code, detail, std::move(reply));
  };

  uint64_t pid = 0;
  if (!Assign(request.consumer_pid, &pid) || pid > UINT32_MAX)
    return error(ErrorCode::kInvalidRequest, "consumer_pid_required");
  if (*method == "output.open") {
    if (OsrRenderer::IsGpuFaultSealed())
      return error(ErrorCode::kUnavailable, "output_gpu_fault_sealed");
    if (!runtime_.output)
      runtime_.output = std::make_unique<OsrRenderer>(runtime_.layout_transaction.output_width,
                                                      runtime_.layout_transaction.output_height,
                                                      ++runtime_.output_generation);
    runtime_.UpdateOutput();
    reply.Set("ok", true);
    reply.Set("accepted", true);
    return reply;
  }
  if (!runtime_.output)
    return error(ErrorCode::kConflict, "output_not_open");
  auto result = runtime_.output->DescribeForConsumer(static_cast<uint32_t>(pid));
  if (result.FindBool("pending") == true) {
    if (const auto* detail = result.FindString("error"))
      result.Set("detail", *detail);
    return ControlResult::Failure(id, ErrorCode::kBusy, "Output is pending", std::move(result));
  }
  result.Set("version", protocol::kControlVersion);
  result.Set("id", id);
  return result;
}

ControlResult ControlDispatcher::HandleOutputStatus(const OutputStatusRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](ErrorCode code, std::string detail) {
    return ControlResult::Failure(id, code, detail, std::move(reply));
  };

  if (!runtime_.output)
    return error(ErrorCode::kConflict, "output_not_open");
  reply.Set("ok", true);
  auto status = runtime_.output->Status();
  status.Set("allocation_alignment",
             static_cast<int>(runtime_.layout_transaction.allocation_alignment));
  reply.Set("output", std::move(status));
  return reply;
}

ControlResult ControlDispatcher::HandleOutputClose(const OutputCloseRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);

  if (runtime_.output) {
    runtime_.output->Stop();
  }
  runtime_.output.reset();
  runtime_.UpdateOutput();
  reply.Set("ok", true);
  return reply;
}

ControlResult ControlDispatcher::HandleAudioOpen(const AudioOpenRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](ErrorCode code, std::string detail) {
    return ControlResult::Failure(id, code, detail, std::move(reply));
  };

  uint64_t generation = 0, session = 0;
  const auto* name = Ptr(request.mapping);
  if (!name || !Assign(request.generation, &generation) || !Assign(request.session, &session) ||
      runtime_.session_id != session || !OpenAudioTarget(*name, generation, session))
    return error(ErrorCode::kInvalidRequest, "invalid_audio_target");
  reply.Set("ok", true);
  return reply;
}

ControlResult ControlDispatcher::HandleAudioClose(const AudioCloseRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);

  CloseAudioTarget();
  reply.Set("ok", true);
  return reply;
}
}  // namespace remotekit::browser
