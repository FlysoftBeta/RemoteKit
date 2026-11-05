#include "browser/control_dispatcher.h"
#include "browser/browser_runtime.h"
#include "browser/control_input_codec.h"
#include "browser/control_response.h"
#include "base/strings/utf_string_conversions.h"
#include "base/base64.h"
#include "base/command_line.h"
#include "base/functional/bind.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_process_host.h"
#include "browser/audio_target.h"
#include "browser/offscreen_host.h"
#include <algorithm>
#include <cmath>
#include <type_traits>
namespace remotekit::browser {
struct RequestEnvelope {
  int id = 0;
  std::string_view method;
};
struct ShutdownRequest : RequestEnvelope {};
struct ViewConfiguration {
  SessionId session = 0;
  WebViewId view = 0;
  int width = 0, height = 0;
  float scale = 1;
  bool visible = false;
};
struct OutputConfigureRequest : RequestEnvelope {
  std::optional<std::vector<ViewConfiguration>> viewConfigs;
  std::optional<double> device_scale;
  std::optional<int> allocation_alignment;
  std::optional<bool> enabled;
  std::optional<int> width;
  std::optional<int> height;
};
struct OutputOpenRequest : RequestEnvelope {
  std::optional<uint64_t> consumer_pid;
};
struct OutputStatusRequest : RequestEnvelope {};
struct OutputCloseRequest : RequestEnvelope {};
struct AudioOpenRequest : RequestEnvelope {
  std::optional<std::string> mapping;
  std::optional<uint64_t> generation;
  std::optional<uint64_t> session;
};
struct AudioCloseRequest : RequestEnvelope {};
struct ClosedAckRequest : RequestEnvelope {
  std::optional<std::string> browserIncarnation;
  std::optional<std::vector<WebViewId>> views;
  std::optional<uint64_t> session;
};
struct SnapshotRequest : RequestEnvelope {};
struct SitePreferencesRequest : RequestEnvelope {
  std::optional<base::DictValue> sites;
  std::optional<uint64_t> session;
};
struct CreateViewRequest : RequestEnvelope {
  std::optional<std::string> provisionalId;
  std::optional<int> width;
  std::optional<int> height;
  std::optional<std::string> url;
  std::optional<std::string> device;
  std::optional<bool> visible;
  std::optional<double> device_scale_factor;
  std::optional<uint64_t> session;
  std::optional<uint64_t> view;

  std::optional<NavigationOperations::Identity> operation;
};
struct CloseViewRequest : RequestEnvelope {
  std::optional<bool> force;
  std::optional<uint64_t> session;
  std::optional<uint64_t> view;
};
struct RecreateViewRequest : RequestEnvelope {
  std::optional<std::string> url;
  std::optional<uint64_t> session;
  std::optional<uint64_t> view;

  std::optional<NavigationOperations::Identity> operation;
};
struct ConfigureViewRequest : RequestEnvelope {
  std::optional<bool> visible;
  std::optional<int> width;
  std::optional<int> height;
  std::optional<std::string> device;
  std::optional<double> device_scale_factor;
  std::optional<uint64_t> session;
  std::optional<uint64_t> view;
};
struct ProfileCommandRequest : RequestEnvelope {
  std::optional<base::DictValue> command;
  std::optional<uint64_t> session;
  std::optional<uint64_t> view;
};
struct PageControlRequest : RequestEnvelope {
  std::optional<std::string> request;
  std::optional<std::string> action;
  std::optional<std::string> selection_id;
  std::optional<uint64_t> session;
  std::optional<uint64_t> view;
  std::optional<uint64_t> instance;
  std::optional<uint64_t> document;
  base::DictValue payload;
  std::optional<NavigationOperations::Identity> operation;
};
struct ExitFullscreenRequest : RequestEnvelope {
  std::optional<uint64_t> instance;
  std::optional<uint64_t> document;
  std::optional<uint64_t> session;
  std::optional<uint64_t> view;
};
struct NavigationTransferRequest : RequestEnvelope {
  std::optional<std::string> offset;
  std::optional<int> length;
  std::optional<std::string> data;
  std::optional<uint64_t> size;
  std::optional<uint64_t> transfer;
  std::optional<uint64_t> session;
  std::optional<uint64_t> view;

  std::optional<NavigationOperations::Identity> operation;
};
struct TouchStatusRequest : RequestEnvelope {
  std::optional<std::string> sequenceId;
  std::optional<uint64_t> instance;
  std::optional<uint64_t> document;
  std::optional<uint64_t> focus;
  std::optional<uint64_t> session;
  std::optional<uint64_t> view;
};
struct FocusRequest : RequestEnvelope {
  std::optional<bool> focused;
  std::optional<uint64_t> focus;
  std::optional<uint64_t> session;
  std::optional<uint64_t> view;
  std::optional<uint64_t> instance;
  std::optional<uint64_t> document;
};
struct VisibleRequest : RequestEnvelope {
  std::optional<bool> visible;
  std::optional<uint64_t> session;
  std::optional<uint64_t> view;
};
struct NavigateRequest : RequestEnvelope {
  std::optional<std::string> url;
  std::optional<uint64_t> session;
  std::optional<uint64_t> view;

  std::optional<NavigationOperations::Identity> operation;
};
struct LifecycleControlRequest : RequestEnvelope {
  std::optional<std::string> action;
  std::optional<uint64_t> expected_lifecycle_generation;
  std::optional<uint64_t> session;
  std::optional<uint64_t> view;
};
struct InputRequest : RequestEnvelope {
  std::optional<uint64_t> output_generation;
  std::optional<uint64_t> session;
  std::optional<uint64_t> view;
  InputEvent input;
};
namespace {
base::DictValue TokenValue(const InputToken& token) {
  base::DictValue value;
  value.Set("session", base::NumberToString(token.session));
  value.Set("view", base::NumberToString(token.view));
  value.Set("instance", base::NumberToString(token.instance));
  value.Set("document", base::NumberToString(token.document));
  value.Set("focus", base::NumberToString(token.focus));
  return value;
}
}  // namespace
namespace {
template <class T>
const T* Ptr(const std::optional<T>& value) {
  return value ? &*value : nullptr;
}
bool Assign(const std::optional<uint64_t>& value, uint64_t* result) {
  if (!value)
    return false;
  *result = *value;
  return true;
}
class RequestDecoder {
 public:
  explicit RequestDecoder(const base::DictValue& wire) : wire_(wire) {}
  template <class T>
  std::optional<T> Optional(std::string_view field) {
    const auto* value = wire_.Find(field);
    if (!value)
      return std::nullopt;
    if constexpr (std::is_same_v<T, uint64_t>) {
      uint64_t parsed = 0;
      if (value->is_string() && base::StringToUint64(value->GetString(), &parsed) && parsed)
        return parsed;
    } else if constexpr (std::is_same_v<T, double>) {
      if (value->is_int())
        return value->GetInt();
      if (value->is_double())
        return value->GetDouble();
    } else if constexpr (std::is_same_v<T, int>) {
      if (value->is_int())
        return value->GetInt();
    } else if constexpr (std::is_same_v<T, bool>) {
      if (value->is_bool())
        return value->GetBool();
    } else if constexpr (std::is_same_v<T, std::string>) {
      if (value->is_string())
        return value->GetString();
    } else if constexpr (std::is_same_v<T, base::DictValue>) {
      if (value->is_dict())
        return value->GetDict().Clone();
    } else if constexpr (std::is_same_v<T, base::ListValue>) {
      if (value->is_list())
        return value->GetList().Clone();
    }
    status_ = {ErrorCode::invalid_request, "Invalid " + std::string(field)};
    return std::nullopt;
  }
  template <class T>
  Result<T> Finish(T request) const {
    if (!status_)
      return {{}, status_};
    return {std::move(request), {}};
  }

 private:
  const base::DictValue& wire_;
  Status status_;
};
Result<std::optional<NavigationOperations::Identity>> DecodeNavigationOperation(
    const base::DictValue& wire,
    bool acknowledge) {
  if (!wire.contains("operationId") && !wire.contains("operationGeneration") &&
      !wire.contains("operationSequence")) {
    if (acknowledge)
      return {{}, {ErrorCode::invalid_request, "Navigation operation identity required"}};
    return {};
  }
  const auto* id = wire.FindString("operationId");
  const auto* generation = wire.FindString("operationGeneration");
  const auto* sequence = wire.FindString("operationSequence");
  uint64_t parsed = 0;
  if (!id || id->empty() || id->size() > 128 || !generation || generation->empty() ||
      generation->size() > 128 ||
      (!acknowledge && (!sequence || !base::StringToUint64(*sequence, &parsed) || !parsed)))
    return {{}, {ErrorCode::invalid_request, "Invalid navigation operation identity"}};
  return {NavigationOperations::Identity{*id, *generation, parsed}, {}};
}
Result<ShutdownRequest> DecodeShutdown(const base::DictValue& wire, RequestEnvelope envelope) {
  ShutdownRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  return decoder.Finish(std::move(request));
}

Result<OutputConfigureRequest> DecodeOutputConfigure(const base::DictValue& wire,
                                                     RequestEnvelope envelope) {
  OutputConfigureRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  if (const auto* value = wire.Find("viewConfigs")) {
    if (!value->is_list() || value->GetList().size() > kSharedAtlasMaxViews)
      return {{}, {ErrorCode::invalid_request, "Invalid view configurations"}};
    request.viewConfigs.emplace();
    std::set<WebViewId> identities;
    for (const auto& item : value->GetList()) {
      const auto* config = item.GetIfDict();
      if (!config)
        return {{}, {ErrorCode::invalid_request, "View configuration must be an object"}};
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
        return {{}, {ErrorCode::invalid_request, "Invalid view configuration"}};
      decoded.width = *width;
      decoded.height = *height;
      decoded.scale = scale->is_int() ? scale->GetInt() : scale->GetDouble();
      decoded.visible = *visible;
      if (!std::isfinite(decoded.scale) || decoded.scale < .5 || decoded.scale > 4)
        return {{}, {ErrorCode::invalid_request, "Invalid page device scale"}};
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

Result<ClosedAckRequest> DecodeClosedAck(const base::DictValue& wire, RequestEnvelope envelope) {
  ClosedAckRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.browserIncarnation = decoder.Optional<std::string>("browserIncarnation");
  const auto ids = decoder.Optional<base::ListValue>("views");
  if (!ids || ids->size() > 256)
    return {{}, {ErrorCode::invalid_request, "Closed view IDs required"}};
  request.views.emplace();
  for (const auto& value : *ids) {
    WebViewId view = 0;
    if (!value.is_string() || !base::StringToUint64(value.GetString(), &view) || !view)
      return {{}, {ErrorCode::invalid_request, "Invalid closed view ID"}};
    request.views->push_back(view);
  }
  request.session = decoder.Optional<uint64_t>("session");
  return decoder.Finish(std::move(request));
}

Result<SnapshotRequest> DecodeSnapshot(const base::DictValue& wire, RequestEnvelope envelope) {
  SnapshotRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  return decoder.Finish(std::move(request));
}

Result<SitePreferencesRequest> DecodeSitePreferences(const base::DictValue& wire,
                                                     RequestEnvelope envelope) {
  SitePreferencesRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.sites = decoder.Optional<base::DictValue>("sites");
  request.session = decoder.Optional<uint64_t>("session");
  return decoder.Finish(std::move(request));
}

Result<CreateViewRequest> DecodeCreateView(const base::DictValue& wire, RequestEnvelope envelope) {
  CreateViewRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.provisionalId = decoder.Optional<std::string>("provisionalId");
  request.width = decoder.Optional<int>("width");
  request.height = decoder.Optional<int>("height");
  request.url = decoder.Optional<std::string>("url");
  request.device = decoder.Optional<std::string>("device");
  request.visible = decoder.Optional<bool>("visible");
  request.device_scale_factor = decoder.Optional<double>("device_scale_factor");
  request.session = decoder.Optional<uint64_t>("session");
  request.view = decoder.Optional<uint64_t>("view");
  auto operation = DecodeNavigationOperation(wire, envelope.method == "navigation.ack");
  if (!operation)
    return {{}, operation.status};
  request.operation = std::move(operation.value);
  if (!request.session || !request.view)
    return {{}, {ErrorCode::invalid_request, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

Result<CloseViewRequest> DecodeCloseView(const base::DictValue& wire, RequestEnvelope envelope) {
  CloseViewRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.force = decoder.Optional<bool>("force");
  request.session = decoder.Optional<uint64_t>("session");
  request.view = decoder.Optional<uint64_t>("view");
  if (!request.session || !request.view)
    return {{}, {ErrorCode::invalid_request, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

Result<RecreateViewRequest> DecodeRecreateView(const base::DictValue& wire,
                                               RequestEnvelope envelope) {
  RecreateViewRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.url = decoder.Optional<std::string>("url");
  request.session = decoder.Optional<uint64_t>("session");
  request.view = decoder.Optional<uint64_t>("view");
  auto operation = DecodeNavigationOperation(wire, envelope.method == "navigation.ack");
  if (!operation)
    return {{}, operation.status};
  request.operation = std::move(operation.value);
  if (!request.session || !request.view)
    return {{}, {ErrorCode::invalid_request, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

Result<ConfigureViewRequest> DecodeConfigureView(const base::DictValue& wire,
                                                 RequestEnvelope envelope) {
  ConfigureViewRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.visible = decoder.Optional<bool>("visible");
  request.width = decoder.Optional<int>("width");
  request.height = decoder.Optional<int>("height");
  request.device = decoder.Optional<std::string>("device");
  request.device_scale_factor = decoder.Optional<double>("device_scale_factor");
  request.session = decoder.Optional<uint64_t>("session");
  request.view = decoder.Optional<uint64_t>("view");
  if (!request.session || !request.view)
    return {{}, {ErrorCode::invalid_request, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

Result<ProfileCommandRequest> DecodeProfileCommand(const base::DictValue& wire,
                                                   RequestEnvelope envelope) {
  ProfileCommandRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.command = decoder.Optional<base::DictValue>("command");
  request.session = decoder.Optional<uint64_t>("session");
  request.view = decoder.Optional<uint64_t>("view");
  if (!request.session || !request.view)
    return {{}, {ErrorCode::invalid_request, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

Result<PageControlRequest> DecodePageRequest(const base::DictValue& wire,
                                             RequestEnvelope envelope) {
  PageControlRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.request = decoder.Optional<std::string>("request");
  request.action = decoder.Optional<std::string>("action");
  request.selection_id = decoder.Optional<std::string>("selection_id");
  request.session = decoder.Optional<uint64_t>("session");
  request.view = decoder.Optional<uint64_t>("view");
  request.instance = decoder.Optional<uint64_t>("instance");
  request.document = decoder.Optional<uint64_t>("document");
  request.payload = wire.Clone();
  auto operation = DecodeNavigationOperation(wire, envelope.method == "navigation.ack");
  if (!operation)
    return {{}, operation.status};
  request.operation = std::move(operation.value);
  if (!request.session || !request.view)
    return {{}, {ErrorCode::invalid_request, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

Result<ExitFullscreenRequest> DecodeExitFullscreen(const base::DictValue& wire,
                                                   RequestEnvelope envelope) {
  ExitFullscreenRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.instance = decoder.Optional<uint64_t>("instance");
  request.document = decoder.Optional<uint64_t>("document");
  request.session = decoder.Optional<uint64_t>("session");
  request.view = decoder.Optional<uint64_t>("view");
  if (!request.session || !request.view)
    return {{}, {ErrorCode::invalid_request, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

Result<NavigationTransferRequest> DecodeNavigationTransfer(const base::DictValue& wire,
                                                           RequestEnvelope envelope) {
  NavigationTransferRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.offset = decoder.Optional<std::string>("offset");
  request.length = decoder.Optional<int>("length");
  request.data = decoder.Optional<std::string>("data");
  request.size = decoder.Optional<uint64_t>("size");
  request.transfer = decoder.Optional<uint64_t>("transfer");
  request.session = decoder.Optional<uint64_t>("session");
  request.view = decoder.Optional<uint64_t>("view");
  auto operation = DecodeNavigationOperation(wire, envelope.method == "navigation.ack");
  if (!operation)
    return {{}, operation.status};
  request.operation = std::move(operation.value);
  if (!request.session || !request.view)
    return {{}, {ErrorCode::invalid_request, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

Result<TouchStatusRequest> DecodeTouchStatus(const base::DictValue& wire,
                                             RequestEnvelope envelope) {
  TouchStatusRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.sequenceId = decoder.Optional<std::string>("sequenceId");
  request.instance = decoder.Optional<uint64_t>("instance");
  request.document = decoder.Optional<uint64_t>("document");
  request.focus = decoder.Optional<uint64_t>("focus");
  request.session = decoder.Optional<uint64_t>("session");
  request.view = decoder.Optional<uint64_t>("view");
  if (!request.session || !request.view)
    return {{}, {ErrorCode::invalid_request, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

Result<FocusRequest> DecodeFocus(const base::DictValue& wire, RequestEnvelope envelope) {
  FocusRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.focused = decoder.Optional<bool>("focused");
  request.focus = decoder.Optional<uint64_t>("focus");
  request.session = decoder.Optional<uint64_t>("session");
  request.view = decoder.Optional<uint64_t>("view");
  request.instance = decoder.Optional<uint64_t>("instance");
  request.document = decoder.Optional<uint64_t>("document");
  if (!request.session || !request.view)
    return {{}, {ErrorCode::invalid_request, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

Result<VisibleRequest> DecodeVisible(const base::DictValue& wire, RequestEnvelope envelope) {
  VisibleRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.visible = decoder.Optional<bool>("visible");
  request.session = decoder.Optional<uint64_t>("session");
  request.view = decoder.Optional<uint64_t>("view");
  if (!request.session || !request.view)
    return {{}, {ErrorCode::invalid_request, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

Result<NavigateRequest> DecodeNavigate(const base::DictValue& wire, RequestEnvelope envelope) {
  NavigateRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.url = decoder.Optional<std::string>("url");
  request.session = decoder.Optional<uint64_t>("session");
  request.view = decoder.Optional<uint64_t>("view");
  auto operation = DecodeNavigationOperation(wire, envelope.method == "navigation.ack");
  if (!operation)
    return {{}, operation.status};
  request.operation = std::move(operation.value);
  if (!request.session || !request.view)
    return {{}, {ErrorCode::invalid_request, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

Result<LifecycleControlRequest> DecodeLifecycle(const base::DictValue& wire,
                                                RequestEnvelope envelope) {
  LifecycleControlRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.action = decoder.Optional<std::string>("action");
  request.expected_lifecycle_generation =
      decoder.Optional<uint64_t>("expected_lifecycle_generation");
  request.session = decoder.Optional<uint64_t>("session");
  request.view = decoder.Optional<uint64_t>("view");
  if (!request.session || !request.view)
    return {{}, {ErrorCode::invalid_request, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

Result<InputRequest> DecodeInput(const base::DictValue& wire, RequestEnvelope envelope) {
  InputRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.output_generation = decoder.Optional<uint64_t>("output_generation");
  request.session = decoder.Optional<uint64_t>("session");
  request.view = decoder.Optional<uint64_t>("view");
  auto input = DecodeControlInput(wire, request.session.value_or(0), request.view.value_or(0));
  if (!input)
    return {{}, input.status};
  request.input = std::move(input.value);
  if (!request.session || !request.view)
    return {{}, {ErrorCode::invalid_request, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

template <class Request,
          Result<Request> (*Decode)(const base::DictValue&, RequestEnvelope),
          base::DictValue (ControlDispatcher::*Handle)(const Request&)>
base::DictValue Invoke(ControlDispatcher& dispatcher,
                       const base::DictValue& wire,
                       RequestEnvelope envelope) {
  auto decoded = Decode(wire, envelope);
  if (!decoded)
    return ControlResult::Failure(envelope.id, decoded.status.error, decoded.status.message);
  return ControlResult::FromFields(envelope.id, (dispatcher.*Handle)(decoded.value));
}
}  // namespace
base::DictValue ControlDispatcher::Dispatch(const base::DictValue& request) {
  const auto id = request.FindInt("id").value_or(0);
  const auto* name = request.FindString("method");
  if (id <= 0 || request.FindInt("version") != protocol::kControlVersion || !name)
    return ControlResult::Failure(id, ErrorCode::invalid_request, "Invalid control envelope");
  struct Method {
    std::string_view name;
    base::DictValue (*handler)(ControlDispatcher&, const base::DictValue&, RequestEnvelope);
  };
  static constexpr Method methods[] = {
      {"shutdown", &Invoke<ShutdownRequest, DecodeShutdown, &ControlDispatcher::HandleShutdown>},
      {"output.configure", &Invoke<OutputConfigureRequest, DecodeOutputConfigure,
                                   &ControlDispatcher::HandleOutputConfigure>},
      {"output.open",
       &Invoke<OutputOpenRequest, DecodeOutputOpen, &ControlDispatcher::HandleOutputOpen>},
      {"output.describe",
       &Invoke<OutputOpenRequest, DecodeOutputOpen, &ControlDispatcher::HandleOutputOpen>},
      {"output.status",
       &Invoke<OutputStatusRequest, DecodeOutputStatus, &ControlDispatcher::HandleOutputStatus>},
      {"output.close",
       &Invoke<OutputCloseRequest, DecodeOutputClose, &ControlDispatcher::HandleOutputClose>},
      {"audio.open",
       &Invoke<AudioOpenRequest, DecodeAudioOpen, &ControlDispatcher::HandleAudioOpen>},
      {"audio.close",
       &Invoke<AudioCloseRequest, DecodeAudioClose, &ControlDispatcher::HandleAudioClose>},
      {"view.closed.ack",
       &Invoke<ClosedAckRequest, DecodeClosedAck, &ControlDispatcher::HandleClosedAck>},
      {"snapshot", &Invoke<SnapshotRequest, DecodeSnapshot, &ControlDispatcher::HandleSnapshot>},
      {"session.sitePreferences", &Invoke<SitePreferencesRequest, DecodeSitePreferences,
                                          &ControlDispatcher::HandleSitePreferences>},
      {"view.create",
       &Invoke<CreateViewRequest, DecodeCreateView, &ControlDispatcher::HandleCreateView>},
      {"view.adopt",
       &Invoke<CreateViewRequest, DecodeCreateView, &ControlDispatcher::HandleCreateView>},
      {"view.close",
       &Invoke<CloseViewRequest, DecodeCloseView, &ControlDispatcher::HandleCloseView>},
      {"view.recreate",
       &Invoke<RecreateViewRequest, DecodeRecreateView, &ControlDispatcher::HandleRecreateView>},
      {"view.configure",
       &Invoke<ConfigureViewRequest, DecodeConfigureView, &ControlDispatcher::HandleConfigureView>},
      {"profile.permissions", &Invoke<ProfileCommandRequest, DecodeProfileCommand,
                                      &ControlDispatcher::HandleProfileCommand>},
      {"profile.downloads", &Invoke<ProfileCommandRequest, DecodeProfileCommand,
                                    &ControlDispatcher::HandleProfileCommand>},
      {"page.requests",
       &Invoke<PageControlRequest, DecodePageRequest, &ControlDispatcher::HandlePageRequest>},
      {"page.reply",
       &Invoke<PageControlRequest, DecodePageRequest, &ControlDispatcher::HandlePageRequest>},
      {"page.command",
       &Invoke<PageControlRequest, DecodePageRequest, &ControlDispatcher::HandlePageRequest>},
      {"page.fileStatus",
       &Invoke<PageControlRequest, DecodePageRequest, &ControlDispatcher::HandlePageRequest>},
      {"page.exitFullscreen", &Invoke<ExitFullscreenRequest, DecodeExitFullscreen,
                                      &ControlDispatcher::HandleExitFullscreen>},
      {"navigation.ack", &Invoke<NavigationTransferRequest, DecodeNavigationTransfer,
                                 &ControlDispatcher::HandleNavigationTransfer>},
      {"navigation.export.begin", &Invoke<NavigationTransferRequest, DecodeNavigationTransfer,
                                          &ControlDispatcher::HandleNavigationTransfer>},
      {"navigation.import.begin", &Invoke<NavigationTransferRequest, DecodeNavigationTransfer,
                                          &ControlDispatcher::HandleNavigationTransfer>},
      {"navigation.transfer.cancel", &Invoke<NavigationTransferRequest, DecodeNavigationTransfer,
                                             &ControlDispatcher::HandleNavigationTransfer>},
      {"navigation.export.chunk", &Invoke<NavigationTransferRequest, DecodeNavigationTransfer,
                                          &ControlDispatcher::HandleNavigationTransfer>},
      {"navigation.import.chunk", &Invoke<NavigationTransferRequest, DecodeNavigationTransfer,
                                          &ControlDispatcher::HandleNavigationTransfer>},
      {"navigation.import.commit", &Invoke<NavigationTransferRequest, DecodeNavigationTransfer,
                                           &ControlDispatcher::HandleNavigationTransfer>},
      {"input.touchStatus",
       &Invoke<TouchStatusRequest, DecodeTouchStatus, &ControlDispatcher::HandleTouchStatus>},
      {"input.touchRetire",
       &Invoke<TouchStatusRequest, DecodeTouchStatus, &ControlDispatcher::HandleTouchStatus>},
      {"focus", &Invoke<FocusRequest, DecodeFocus, &ControlDispatcher::HandleFocus>},
      {"visible", &Invoke<VisibleRequest, DecodeVisible, &ControlDispatcher::HandleVisible>},
      {"navigate", &Invoke<NavigateRequest, DecodeNavigate, &ControlDispatcher::HandleNavigate>},
      {"lifecycle",
       &Invoke<LifecycleControlRequest, DecodeLifecycle, &ControlDispatcher::HandleLifecycle>},
      {"input", &Invoke<InputRequest, DecodeInput, &ControlDispatcher::HandleInput>},
  };
  for (const auto& method : methods)
    if (method.name == *name)
      return method.handler(*this, request, {id, method.name});
  return ControlResult::Failure(id, ErrorCode::unsupported, "Unknown control method");
}
base::DictValue ControlDispatcher::HandleShutdown(const ShutdownRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);

  reply.Set("ok", true);
  reply.Set("accepted", true);
  if (runtime_.quit)
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(FROM_HERE, runtime_.quit);
  return reply;
}

base::DictValue ControlDispatcher::HandleOutputConfigure(const OutputConfigureRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](std::string detail) {
    return ControlResult::Failure(id, detail, std::move(reply));
  };

  auto scale = request.device_scale;
  int next_width = runtime_.layout_transaction.logical_width,
      next_height = runtime_.layout_transaction.logical_height;
  if (request.width)
    next_width = *request.width;
  if (request.height)
    next_height = *request.height;
  if (next_width < 16 || next_width > 16384 || next_height < 16 || next_height > 16384)
    return error("invalid_atlas_dimensions");
  if (runtime_.output && (next_width != runtime_.layout_transaction.logical_width ||
                          next_height != runtime_.layout_transaction.logical_height))
    return error("close_output_before_size_change");
  // Source geometry and output extent are one transaction. In particular,
  // neither the old nor new layout must fit a max(old,new) intermediate atlas.
  auto next_specs = runtime_.views.Specs();
  if (Ptr(request.viewConfigs)) {
    if (runtime_.output)
      return error("close_output_before_view_transaction");
    for (const auto& config : *request.viewConfigs) {
      if (!runtime_.views.Find(config.session, config.view))
        return error("view_transaction_identity_mismatch");
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
      return error("invalid_device_scale");
    if (runtime_.output)
      return error("close_output_before_scale_change");
    next_scale = static_cast<float>(*scale);
  }
  if (const auto* value = Ptr(request.allocation_alignment)) {
    if ((*value != 1 && *value != 16))
      return error("invalid_allocation_alignment");
    next_alignment = *value;
    if (runtime_.output && next_alignment != runtime_.layout_transaction.allocation_alignment)
      return error("close_output_before_alignment_change");
  }
  if (const auto* value = Ptr(request.enabled)) {
    next_enabled = *value;
  }
  auto next_layout = runtime_.layout_transaction.Prepare(std::move(next_specs), next_width,
                                                         next_height, next_scale, next_alignment);
  if (!next_layout)
    return ControlResult::Failure(id, next_layout.status.error, next_layout.status.message);
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

base::DictValue ControlDispatcher::HandleOutputOpen(const OutputOpenRequest& request) {
  const int id = request.id;
  const auto* method = &request.method;
  auto reply = ControlResult::Success(id);
  auto error = [&](std::string detail) {
    return ControlResult::Failure(id, detail, std::move(reply));
  };

  uint64_t pid = 0;
  if (!Assign(request.consumer_pid, &pid) || pid > UINT32_MAX)
    return error("consumer_pid_required");
  if (*method == "output.open") {
    if (OsrRenderer::IsGpuFaultSealed())
      return error("output_gpu_fault_sealed");
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
    return error("output_not_open");
  auto result = runtime_.output->DescribeForConsumer(static_cast<uint32_t>(pid));
  if (result.FindBool("pending") == true) {
    if (const auto* detail = result.FindString("error"))
      result.Set("detail", *detail);
    return ControlResult::Failure(id, ErrorCode::busy, "Output is pending", std::move(result));
  }
  result.Set("version", protocol::kControlVersion);
  result.Set("id", id);
  return result;
}

base::DictValue ControlDispatcher::HandleOutputStatus(const OutputStatusRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](std::string detail) {
    return ControlResult::Failure(id, detail, std::move(reply));
  };

  if (!runtime_.output)
    return error("output_not_open");
  reply.Set("ok", true);
  auto status = runtime_.output->Status();
  status.Set("allocation_alignment",
             static_cast<int>(runtime_.layout_transaction.allocation_alignment));
  reply.Set("output", std::move(status));
  return reply;
}

base::DictValue ControlDispatcher::HandleOutputClose(const OutputCloseRequest& request) {
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

base::DictValue ControlDispatcher::HandleAudioOpen(const AudioOpenRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](std::string detail) {
    return ControlResult::Failure(id, detail, std::move(reply));
  };

  uint64_t generation = 0, session = 0;
  const auto* name = Ptr(request.mapping);
  if (!name || !Assign(request.generation, &generation) || !Assign(request.session, &session) ||
      runtime_.session_id != session || !OpenAudioTarget(*name, generation, session))
    return error("invalid_audio_target");
  reply.Set("ok", true);
  return reply;
}

base::DictValue ControlDispatcher::HandleAudioClose(const AudioCloseRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);

  CloseAudioTarget();
  reply.Set("ok", true);
  return reply;
}

base::DictValue ControlDispatcher::HandleClosedAck(const ClosedAckRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](std::string detail) {
    return ControlResult::Failure(id, detail, std::move(reply));
  };

  uint64_t session = 0;
  const auto* incarnation = Ptr(request.browserIncarnation);
  const auto* ids = Ptr(request.views);
  const auto current =
      base::CommandLine::ForCurrentProcess()->GetSwitchValueASCII("browser-incarnation");
  if (!Assign(request.session, &session) || !runtime_.view_model.FindSession(session) ||
      !incarnation || current.empty() || *incarnation != current || !ids || ids->size() > 256)
    return error("invalid_closed_ack_target");
  const auto acknowledged = runtime_.closed.Acknowledge(session, *ids);
  if (!acknowledged)
    return ControlResult::Failure(id, acknowledged.error, acknowledged.message);
  reply.Set("ok", true);
  reply.Set("accepted", true);
  return reply;
}

base::DictValue ControlDispatcher::HandleSnapshot(const SnapshotRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);

  base::ListValue list;
  const auto* session = runtime_.view_model.FindSession(runtime_.session_id);
  base::ListValue view_values;
  for (const auto& [view_id, model] : session->views) {
    auto value = TokenValue(runtime_.view_model.Token(runtime_.session_id, view_id).value);
    value.Set("profile", base::NumberToString(model.profile));
    value.Set("actual", static_cast<int>(model.actual));
    value.Set("desired", static_cast<int>(model.desired));
    value.Set("pending", model.pending.has_value());
    value.Set("focused", model.focused);
    value.Set("lifecycle_generation", base::NumberToString(model.lifecycle_generation));
    if (model.last_lifecycle) {
      base::DictValue result;
      result.Set("generation", base::NumberToString(model.last_lifecycle->generation));
      result.Set("action", static_cast<int>(model.last_lifecycle->action));
      result.Set("succeeded", model.last_lifecycle->succeeded);
      result.Set("detail", model.last_lifecycle->detail);
      value.Set("last_lifecycle", std::move(result));
    }
    for (auto& [i, record] : runtime_.views.records) {
      const auto& adapter = runtime_.views.records.at(i).webview;
      if (adapter->view_id() != view_id)
        continue;
      value.Set("close_state", runtime_.views.records.at(i).requests->close_state());
      value.Set("close_reason", runtime_.views.records.at(i).requests->close_reason());
      value.Set("width", runtime_.views.records.at(i).spec.width);
      value.Set("height", runtime_.views.records.at(i).spec.height);
      value.Set("device", "desktop");
      value.Set("deviceScaleFactor",
                runtime_.layout_transaction.PageScale(runtime_.views.records.at(i).spec));
      auto compositor = adapter->CompositorDiagnostics();
      if (runtime_.output)
        compositor.Set("osr", runtime_.output->RenderStatus(view_id));
      value.Set("compositor", std::move(compositor));
      value.Set("navigationRevision", base::NumberToString(adapter->navigation_revision()));
      value.Set("navigationOperations", adapter->NavigationOperationSnapshot());
      value.Set("visible", runtime_.views.records.at(i).spec.visible);
      value.Set("lifecycle_uncertain", adapter->lifecycle_uncertain());
      auto discard = runtime_.CanDiscard(i);
      value.Set("canDiscard", static_cast<bool>(discard));
      value.Set("discardBlockReason", discard.message);
      auto touch = adapter->TouchInjectionStatus();
      value.Set("touch_code", static_cast<int>(touch.error));
      value.Set("touch_detail", touch.message);
      value.Set("pending_page_requests",
                static_cast<int>(runtime_.views.records.at(i).requests->pending_count()));
      if (auto* page = adapter->contents()) {
        value.Set("url", page->GetLastCommittedURL().spec());
        value.Set("title", base::UTF16ToUTF8(page->GetTitle()));
        value.Set("loading", page->IsLoading());
        value.Set("canGoBack", page->GetController().CanGoBack());
        value.Set("canGoForward", page->GetController().CanGoForward());
        value.Set("audible", page->IsCurrentlyAudible());
        value.Set("captured", page->IsBeingCaptured());
        value.Set("crashed", page->IsCrashed());
        value.Set("fullscreen",
                  runtime_.views.records.at(i).requests->fullscreen() && !page->IsCrashed());
        std::set<base::ProcessId> pids;
        page->GetPrimaryMainFrame()->ForEachRenderFrameHost([&](content::RenderFrameHost* frame) {
          const auto& process = frame->GetProcess()->GetProcess();
          if (process.IsValid())
            pids.insert(process.Pid());
        });
        base::ListValue processes;
        for (auto pid : pids)
          processes.Append(base::NumberToString(pid));
        value.Set("renderer_pids", std::move(processes));
      }
    }
    view_values.Append(std::move(value));
  }
  for (const auto& [closed_view_id, tombstone] : runtime_.closed.tombstones)
    if (*tombstone.FindString("session") == base::NumberToString(runtime_.session_id))
      view_values.Append(tombstone.Clone());
  base::DictValue session_value;
  session_value.Set("session", base::NumberToString(runtime_.session_id));
  session_value.Set("tenant", session->tenant);
  session_value.Set("views", std::move(view_values));
  base::ListValue popup_values;
  for (const auto& [key, popup] : runtime_.popups.pending) {
    if (popup.session != runtime_.session_id)
      continue;
    base::DictValue item;
    item.Set("provisionalId", key);
    item.Set("openerViewId", base::NumberToString(popup.opener));
    item.Set("url", popup.contents && !popup.contents->GetLastCommittedURL().is_empty()
                        ? popup.contents->GetLastCommittedURL().spec()
                        : popup.url.spec());
    item.Set("disposition", static_cast<int>(popup.disposition));
    item.Set("userGesture", popup.user_gesture);
    item.Set("status", popup.status);
    popup_values.Append(std::move(item));
  }
  session_value.Set("pendingPopups", std::move(popup_values));
  list.Append(std::move(session_value));
  reply.Set("ok", true);
  reply.Set("sessions", std::move(list));
  reply.Set("clientGestures", 1);
  return reply;
}

base::DictValue ControlDispatcher::HandleSitePreferences(const SitePreferencesRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](std::string detail) {
    return ControlResult::Failure(id, detail, std::move(reply));
  };

  uint64_t session = 0;
  const auto* sites = Ptr(request.sites);
  if (!Assign(request.session, &session) || !sites)
    return error("session_and_sites_required");
  if (session != runtime_.session_id)
    return error("session_not_found");
  std::string detail;
  if (!runtime_.contexts.front()->SetSitePreferences(*sites, &detail))
    return error(detail);
  reply.Set("ok", true);
  reply.Set("accepted", true);
  reply.Set("applied", true);
  return reply;
}

base::DictValue ControlDispatcher::HandleCreateView(const CreateViewRequest& request) {
  const int id = request.id;
  const auto* method = &request.method;
  auto reply = ControlResult::Success(id);
  auto error = [&](std::string detail) {
    return ControlResult::Failure(id, detail, std::move(reply));
  };

  uint64_t session = 0, view = 0;
  if (!Assign(request.session, &session) || !Assign(request.view, &view) ||
      !runtime_.view_model.FindSession(session) || session != runtime_.session_id)
    return error("invalid_session_or_view");
  if (runtime_.closed.retired.contains(view))
    return error("view_id_closed");
  const bool adopting = *method == "view.adopt";
  const auto* provisional = Ptr(request.provisionalId);
  if (adopting && !provisional)
    return error("provisional_id_required");
  if (adopting && runtime_.popups.adopted.contains(*provisional)) {
    if (runtime_.popups.adopted.at(*provisional) != view)
      return error("popup_already_adopted_elsewhere");
    reply.Set("ok", true);
    reply.Set("accepted", true);
    reply.Set("completed", true);
    reply.Set("token", TokenValue(runtime_.view_model.Token(session, view).value));
    return reply;
  }
  runtime_.popups.Prune();
  if (adopting) {
    const auto allowed = runtime_.popups.CanAdopt(*provisional, session);
    if (!allowed)
      return ControlResult::Failure(id, allowed.error, allowed.message);
  }
  ViewSpec spec;
  spec.width = request.width.value_or(0);
  spec.height = request.height.value_or(0);
  const auto* url = Ptr(request.url);
  const auto* device = Ptr(request.device);
  if (!url || !GURL(*url).is_valid() || spec.width < 1 || spec.height < 1 || spec.width > 8192 ||
      spec.height > 8192 || (device && *device != "desktop" && *device != "tablet") ||
      (Ptr(request.device) && !device))
    return error("invalid_view_configuration");
  spec.visible = request.visible.value_or(true);
  if (Ptr(request.device_scale_factor)) {
    const auto scale = request.device_scale_factor;
    if (!scale || !std::isfinite(*scale) || *scale < 0.5 || *scale > 4)
      return error("invalid_page_device_scale_factor");
    spec.page_dsf = static_cast<float>(*scale);
  }
  spec.url = *url;
  for (auto& [i, record] : runtime_.views.records) {
    if (runtime_.views.records.at(i).webview->view_id() != view)
      continue;
    if (adopting)
      return error("view_id_already_exists");
    if (runtime_.views.records.at(i).webview->session_id() != session ||
        runtime_.views.records.at(i).spec != spec)
      return error("view_id_configuration_conflict");
    if (request.operation) {
      const auto status =
          runtime_.views.records.at(i).webview->Navigate(GURL(spec.url), request.operation);
      if (!status)
        return ControlResult::Failure(id, status.error, status.message, std::move(reply));
    }
    reply.Set("ok", true);
    reply.Set("accepted", true);
    reply.Set("completed", true);
    reply.Set("token", TokenValue(runtime_.view_model.Token(session, view).value));
    if (request.operation)
      reply.Set("completed", false);
    return reply;
  }
  if (runtime_.views.records.size() >= kSharedAtlasMaxViews)
    return error("view_limit_reached");
  auto next = runtime_.views.Specs();
  next.emplace(view, spec);
  auto layout = runtime_.layout_transaction.Prepare(next);
  if (!layout)
    return ControlResult::Failure(id, layout.status.error, layout.status.message);
  auto created = runtime_.view_model.CreateWebView(session, runtime_.profiles.front(), view);
  if (!created)
    return ControlResult::Failure(id, created.status.error, created.status.message,
                                  std::move(reply));
  std::unique_ptr<content::WebContents> adopted;
  if (adopting)
    adopted = runtime_.popups.TakeContents(*provisional);
  auto& record = runtime_.views.Create(runtime_.contexts.front().get(), runtime_.view_model,
                                       session, view, spec, std::move(adopted));
  runtime_.popups.Wire(record.requests.get(), session, view);
  runtime_.layout_transaction.Commit(std::move(layout.value));
  runtime_.UpdateOutput();
  auto navigated =
      adopting ? Status{} : record.webview->Navigate(GURL(spec.url), request.operation);
  if (!navigated) {
    runtime_.RemoveView(view);
    return ControlResult::Failure(id, navigated.error, navigated.message, std::move(reply));
  }
  if (adopting) {
    runtime_.popups.CompleteAdoption(*provisional, view);
  }
  reply.Set("ok", true);
  reply.Set("accepted", true);
  reply.Set("completed", true);
  reply.Set("token", TokenValue(runtime_.view_model.Token(session, view).value));
  if (request.operation)
    reply.Set("completed", false);
  return reply;
}

base::DictValue ControlDispatcher::HandleCloseView(const CloseViewRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](std::string detail) {
    return ControlResult::Failure(id, detail, std::move(reply));
  };

  uint64_t session = 0, view = 0;
  if (!Assign(request.session, &session) || !Assign(request.view, &view) ||
      !runtime_.view_model.FindSession(session))
    return error("invalid_session_or_view");
  if (runtime_.closed.retired.contains(view)) {
    reply.Set("ok", true);
    reply.Set("accepted", true);
    reply.Set("completed", true);
    return reply;
  }
  auto* record = runtime_.views.Find(session, view);
  if (!record)
    return error("view_not_in_session");
  bool force = request.force.value_or(false);
  if (force)
    runtime_.RemoveView(view);
  else
    record->requests->RequestClose();
  reply.Set("ok", true);
  reply.Set("accepted", true);
  reply.Set("completed", force);
  return reply;
}

base::DictValue ControlDispatcher::HandleRecreateView(const RecreateViewRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](std::string detail) {
    return ControlResult::Failure(id, detail, std::move(reply));
  };
  const auto session = request.session.value_or(0);
  const auto view = request.view.value_or(0);
  auto* record = runtime_.views.Find(session, view);
  if (!record || !runtime_.view_model.FindWebView(session, view))
    return ControlResult::Failure(request.id, ErrorCode::not_found, "View is not in session");
  auto& adapter = *record->webview;

  if (record->requests->close_state() == "closing" || record->requests->close_state() == "closed")
    return error("view_closing");
  const auto* url = Ptr(request.url);
  if (!url || !GURL(*url).is_valid())
    return error("invalid_url");
  if (const auto existing = adapter.ExistingNavigationOperation(GURL(*url), request.operation)) {
    if (!*existing)
      return ControlResult::Failure(id, existing->error, existing->message);
    reply.Set("ok", true);
    reply.Set("accepted", true);
    reply.Set("token", TokenValue(runtime_.view_model.Token(session, view).value));
    return reply;
  }
  runtime_.navigation_transfers.records.erase(view);
  if (runtime_.output)
    runtime_.output->StopView(view);
  runtime_.paused_output.insert(view);
  runtime_.UpdateOutput();
  record->requests->Bind(nullptr);
  const auto profile = runtime_.view_model.FindWebView(session, view)->profile;
  const auto owner = std::ranges::find(runtime_.profiles, profile);
  if (owner == runtime_.profiles.end())
    return error("profile_missing");
  runtime_.views.Recreate(runtime_.views.records.at(view),
                          runtime_.contexts[owner - runtime_.profiles.begin()].get(),
                          runtime_.view_model);
  runtime_.popups.Wire(record->requests.get(), session, view);
  auto plan = runtime_.layout_transaction.Prepare(runtime_.views.Specs());
  CHECK(plan);
  runtime_.layout_transaction.Commit(std::move(plan.value));
  const auto status = record->webview->Navigate(GURL(*url), request.operation);
  runtime_.paused_output.erase(view);
  runtime_.UpdateOutput();
  if (!status)
    return ControlResult::Failure(id, status.error, status.message);
  reply.Set("ok", true);
  reply.Set("accepted", true);
  reply.Set("token", TokenValue(runtime_.view_model.Token(session, view).value));
  return reply;
}

base::DictValue ControlDispatcher::HandleConfigureView(const ConfigureViewRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](std::string detail) {
    return ControlResult::Failure(id, detail, std::move(reply));
  };
  const auto session = request.session.value_or(0);
  const auto view = request.view.value_or(0);
  auto* record = runtime_.views.Find(session, view);
  if (!record || !runtime_.view_model.FindWebView(session, view))
    return ControlResult::Failure(request.id, ErrorCode::not_found, "View is not in session");

  auto spec = record->spec;
  if (record->requests->close_state() == "closing")
    return error("view_closing");
  if (Ptr(request.visible)) {
    spec.visible = *request.visible;
  }
  if (Ptr(request.width))
    spec.width = request.width.value_or(0);
  if (Ptr(request.height))
    spec.height = request.height.value_or(0);
  if (const auto* device = Ptr(request.device)) {
    if (*device != "desktop" && *device != "tablet")
      return error("invalid_device");
  } else if (Ptr(request.device))
    return error("invalid_device");
  if (Ptr(request.device_scale_factor)) {
    const auto scale = request.device_scale_factor;
    if (!scale || !std::isfinite(*scale) || *scale < 0.5 || *scale > 4)
      return error("invalid_page_device_scale_factor");
    spec.page_dsf = static_cast<float>(*scale);
  }
  if (spec.width < 1 || spec.height < 1 || spec.width > 8192 || spec.height > 8192)
    return error("invalid_viewport");
  if (spec == record->spec) {
    reply.Set("ok", true);
    reply.Set("accepted", true);
    reply.Set("completed", true);
    reply.Set("token", TokenValue(runtime_.view_model.Token(session, view).value));
    return reply;
  }
  auto next = runtime_.views.Specs();
  next[view] = spec;
  auto layout = runtime_.layout_transaction.Prepare(next);
  if (!layout)
    return ControlResult::Failure(id, layout.status.error, layout.status.message);
  runtime_.layout_transaction.Commit(std::move(layout.value));
  runtime_.UpdateOutput();
  reply.Set("ok", true);
  reply.Set("accepted", true);
  reply.Set("completed", true);
  reply.Set("token", TokenValue(runtime_.view_model.Token(session, view).value));
  return reply;
}

base::DictValue ControlDispatcher::HandleProfileCommand(const ProfileCommandRequest& request) {
  const int id = request.id;
  const auto* method = &request.method;
  auto reply = ControlResult::Success(id);
  auto error = [&](std::string detail) {
    return ControlResult::Failure(id, detail, std::move(reply));
  };
  const auto session = request.session.value_or(0);
  const auto view = request.view.value_or(0);
  auto* record = runtime_.views.Find(session, view);
  if (!record || !runtime_.view_model.FindWebView(session, view))
    return ControlResult::Failure(request.id, ErrorCode::not_found, "View is not in session");

  const auto* command = Ptr(request.command);
  if (!command)
    return error("profile_command_required");
  auto profile = runtime_.view_model.FindWebView(session, view)->profile;
  auto found = std::find(runtime_.profiles.begin(), runtime_.profiles.end(), profile);
  if (found == runtime_.profiles.end())
    return error("profile_missing");
  auto* context = runtime_.contexts[static_cast<size_t>(found - runtime_.profiles.begin())].get();
  auto result = *method == "profile.permissions" ? context->PermissionsCommand(*command)
                                                 : context->DownloadsCommand(*command);
  result.Set("version", protocol::kControlVersion);
  result.Set("id", id);
  return result;
}

base::DictValue ControlDispatcher::HandlePageRequest(const PageControlRequest& request) {
  const int id = request.id;
  const auto* method = &request.method;
  auto reply = ControlResult::Success(id);
  auto error = [&](std::string detail) {
    return ControlResult::Failure(id, detail, std::move(reply));
  };
  const auto session = request.session.value_or(0);
  const auto view = request.view.value_or(0);
  auto* record = runtime_.views.Find(session, view);
  if (!record || !runtime_.view_model.FindWebView(session, view))
    return ControlResult::Failure(request.id, ErrorCode::not_found, "View is not in session");
  auto& adapter = *record->webview;

  const auto token = runtime_.view_model.Token(session, view).value;
  PageRequests::SelectionBinding binding{token.instance, token.document};
  bool terminal_only = false;
  if (*method == "page.reply" || *method == "page.fileStatus") {
    if (request.instance && *request.instance != token.instance)
      return error("stale_page_request_target");
    if (request.document && *request.document != token.document) {
      if (*method != "page.fileStatus" || !request.instance || !request.selection_id)
        return error("stale_page_request_target");
      binding.document = *request.document;
      terminal_only = true;
    }
  }

  if (*method == "page.fileStatus") {
    const auto* key = Ptr(request.request);
    if (!key)
      return error("file_request_required");
    auto result =
        record->requests->FileStatus(*key, Ptr(request.selection_id), binding, terminal_only);
    result.Set("version", 1);
    result.Set("id", id);
    return result;
  }
  if (*method == "page.command") {
    const auto* action = Ptr(request.action);
    if (action &&
        (*action == "back" || *action == "forward" || *action == "reload" || *action == "stop")) {
      auto status = adapter.NavigationCommand(*action, request.operation);
      auto result = reply.Clone();
      result.Set("ok", static_cast<bool>(status));
      result.Set("accepted", static_cast<bool>(status));
      result.Set("state", "submitted");
      if (!status)
        return ControlResult::Failure(id, status.error, status.message, std::move(result));
      return result;
    }
  }
  base::DictValue result;
  if (*method == "page.requests") {
    const auto& spec = record->spec;
    const PageRequests::AnchorLayout layout{
        spec.width,     spec.height,    runtime_.layout_transaction.PageScale(spec),
        token.instance, token.document, runtime_.output_generation};
    result = record->requests->Snapshot(
        runtime_.output && spec.visible && token.instance && token.document ? &layout : nullptr);
  } else {
    result = *method == "page.reply" ? record->requests->Reply(request.payload, binding)
                                     : record->requests->Command(request.payload);
  }
  result.Set("version", protocol::kControlVersion);
  result.Set("id", id);
  if (*method == "page.requests" && !result.contains("ok"))
    result.Set("ok", true);
  return result;
}

base::DictValue ControlDispatcher::HandleExitFullscreen(const ExitFullscreenRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](std::string detail) {
    return ControlResult::Failure(id, detail, std::move(reply));
  };
  const auto session = request.session.value_or(0);
  const auto view = request.view.value_or(0);
  auto* record = runtime_.views.Find(session, view);
  if (!record || !runtime_.view_model.FindWebView(session, view))
    return ControlResult::Failure(request.id, ErrorCode::not_found, "View is not in session");
  auto& adapter = *record->webview;
  if (record->requests->close_state() == "closing")
    return ControlResult::Failure(id, "view_closing");

  const auto token = runtime_.view_model.Token(session, view).value;
  uint64_t instance = 0, document = 0;
  if (!Assign(request.instance, &instance) || !Assign(request.document, &document) ||
      instance != token.instance || document != token.document || !adapter.contents())
    return error("stale_page_request_target");
  if (record->requests->fullscreen())
    adapter.contents()->ExitFullscreen(/*will_cause_resize=*/false);
  reply.Set("ok", true);
  return reply;
}

base::DictValue ControlDispatcher::HandleNavigationTransfer(
    const NavigationTransferRequest& request) {
  const int id = request.id;
  const auto* method = &request.method;
  auto reply = ControlResult::Success(id);
  auto error = [&](std::string detail) {
    return ControlResult::Failure(id, detail, std::move(reply));
  };
  const auto session = request.session.value_or(0);
  const auto view = request.view.value_or(0);
  auto* record = runtime_.views.Find(session, view);
  if (!record || !runtime_.view_model.FindWebView(session, view))
    return ControlResult::Failure(request.id, ErrorCode::not_found, "View is not in session");
  auto& adapter = *record->webview;
  if (record->requests->close_state() == "closing")
    return ControlResult::Failure(id, "view_closing");

  if (*method == "navigation.ack") {
    const auto status = adapter.AcknowledgeNavigation(*request.operation);
    if (!status)
      return ControlResult::Failure(id, status.error, status.message, std::move(reply));
    reply.Set("ok", true);
    return reply;
  }
  auto token = runtime_.view_model.Token(session, view).value;
  if (*method == "navigation.export.begin") {
    auto saved = adapter.ExportNavigation();
    if (!saved)
      return ControlResult::Failure(id, saved.status.error, saved.status.message, std::move(reply));
    if (!runtime_.navigation_transfers.CanReserve(view, saved.value.size()))
      return error("transfer_memory_limit");
    NavigationTransfer::Transfer transfer;
    transfer.id = runtime_.navigation_transfers.NextId();
    transfer.instance = token.instance;
    transfer.document = token.document;
    transfer.total = saved.value.size();
    transfer.data = std::move(saved.value);
    reply.Set("navigationRevision", base::NumberToString(adapter.navigation_revision()));
    runtime_.navigation_transfers.records[view] = std::move(transfer);
  } else if (*method == "navigation.import.begin") {
    uint64_t size = 0;
    if (!Assign(request.size, &size) || size > 64 * 1024 * 1024 || adapter.contents())
      return error("import_requires_unloaded_view_and_bounded_size");
    if (!runtime_.navigation_transfers.CanReserve(view, size))
      return error("transfer_memory_limit");
    NavigationTransfer::Transfer transfer;
    transfer.id = runtime_.navigation_transfers.NextId();
    transfer.instance = token.instance;
    transfer.document = token.document;
    transfer.total = static_cast<size_t>(size);
    transfer.importing = true;
    runtime_.navigation_transfers.records[view] = std::move(transfer);
  } else {
    uint64_t transfer_id = 0;
    auto found = runtime_.navigation_transfers.records.find(view);
    if (!Assign(request.transfer, &transfer_id) ||
        found == runtime_.navigation_transfers.records.end() || found->second.id != transfer_id)
      return error("transfer_not_found");
    auto& transfer = found->second;
    if (*method == "navigation.transfer.cancel") {
      runtime_.navigation_transfers.records.erase(found);
      reply.Set("ok", true);
      return reply;
    }
    if (*method == "navigation.export.chunk" && !transfer.importing) {
      const auto* offset_text = Ptr(request.offset);
      uint64_t offset = 0;
      const int length = request.length.value_or(256 * 1024);
      if (!offset_text || !base::StringToUint64(*offset_text, &offset) || offset > transfer.total ||
          length < 1 || length > 256 * 1024)
        return error("invalid_export_chunk");
      auto chunk = std::string_view(transfer.data).substr(static_cast<size_t>(offset), length);
      reply.Set("data", base::Base64Encode(chunk));
      reply.Set("offset", base::NumberToString(offset));
    } else if (*method == "navigation.import.chunk" && transfer.importing) {
      const auto* offset_text = Ptr(request.offset);
      const auto* data = Ptr(request.data);
      uint64_t offset = 0;
      std::string chunk;
      if (!offset_text || !base::StringToUint64(*offset_text, &offset) ||
          offset != transfer.data.size() || !data || data->size() > 350000 ||
          !base::Base64Decode(*data, &chunk) || chunk.empty() || chunk.size() > 256 * 1024 ||
          chunk.size() > transfer.total - transfer.data.size())
        return error("invalid_import_chunk");
      transfer.data += chunk;
    } else if (*method == "navigation.import.commit" && transfer.importing) {
      if (transfer.instance != token.instance || transfer.document != token.document ||
          transfer.data.size() != transfer.total)
        return error("incomplete_or_stale_import");
      auto imported = adapter.ImportNavigation(transfer.data);
      if (!imported)
        return ControlResult::Failure(id, imported.error, imported.message, std::move(reply));
      runtime_.navigation_transfers.records.erase(found);
      reply.Set("ok", true);
      return reply;
    } else
      return error("invalid_transfer_method");
  }
  const auto& transfer = runtime_.navigation_transfers.records.at(view);
  reply.Set("ok", true);
  reply.Set("transfer", base::NumberToString(transfer.id));
  reply.Set("size", base::NumberToString(transfer.total));
  reply.Set("received", base::NumberToString(transfer.importing ? transfer.data.size() : 0));
  return reply;
}

base::DictValue ControlDispatcher::HandleTouchStatus(const TouchStatusRequest& request) {
  const int id = request.id;
  const auto* method = &request.method;
  auto reply = ControlResult::Success(id);
  auto error = [&](std::string detail) {
    return ControlResult::Failure(id, detail, std::move(reply));
  };
  const auto session = request.session.value_or(0);
  const auto view = request.view.value_or(0);
  auto* record = runtime_.views.Find(session, view);
  if (!record || !runtime_.view_model.FindWebView(session, view))
    return ControlResult::Failure(request.id, ErrorCode::not_found, "View is not in session");
  auto& adapter = *record->webview;
  if (record->requests->close_state() == "closing")
    return ControlResult::Failure(id, "view_closing");

  const auto* sequence = Ptr(request.sequenceId);
  InputToken owner{session, view};
  reply.Set("state", "terminal-unconfirmed");
  reply.Set("pending", false);
  if (!sequence || sequence->empty() || sequence->size() > 128 ||
      !Assign(request.instance, &owner.instance) || !Assign(request.document, &owner.document) ||
      !Assign(request.focus, &owner.focus))
    return error("invalid_touch_status_identity");
  reply.Set("sequenceId", *sequence);
  adapter.RefreshClientTouchOwner();
  using State = ClientTouchRetirement::State;
  const auto completion = *method == "input.touchRetire"
                              ? adapter.RetireClientTouch(owner, *sequence)
                              : adapter.ClientTouchStatus(owner, *sequence);
  if (completion == State::invalidated) {
    reply.Set("state", "terminal-invalidated");
    return error("touch_owner_invalidated");
  }
  if (completion == State::pending) {
    reply.Set("state", "pending");
    reply.Set("pending", true);
    return error("touch_terminal_pending");
  }
  if (completion != State::processed)
    return error("touch_terminal_unconfirmed");
  reply.Set("state", "processed");
  reply.Set("ok", true);
  return reply;
}

base::DictValue ControlDispatcher::HandleFocus(const FocusRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](std::string detail) {
    return ControlResult::Failure(id, detail, std::move(reply));
  };
  const auto session = request.session.value_or(0);
  const auto view = request.view.value_or(0);
  auto* record = runtime_.views.Find(session, view);
  if (!record || !runtime_.view_model.FindWebView(session, view))
    return ControlResult::Failure(request.id, ErrorCode::not_found, "View is not in session");
  auto& adapter = *record->webview;
  if (record->requests->close_state() == "closing")
    return ControlResult::Failure(id, "view_closing");

  Status status;

  if (!Ptr(request.focus))
    return error("focus_token_required");
  const auto current = runtime_.view_model.Token(session, view).value;
  for (const auto& [supplied, expected] :
       {std::pair{request.instance, current.instance},
        std::pair{request.document, current.document}, std::pair{request.focus, current.focus}}) {
    if (supplied && *supplied != expected)
      return error("stale_focus_target");
  }
  auto focused = request.focused;
  if (!focused)
    return error("focused_boolean_required");
  if (*focused) {
    for (auto& [other_id, other_record] : runtime_.views.records)
      if (other_record.webview->session_id() == session && other_id != view)
        other_record.webview->Focus(false);
  }
  status = adapter.Focus(*focused);

  reply.Set("token", TokenValue(runtime_.view_model.Token(session, view).value));
  runtime_.UpdateOutput();
  if (!status)
    return ControlResult::Failure(id, status.error, status.message, std::move(reply));
  return reply;
}

base::DictValue ControlDispatcher::HandleVisible(const VisibleRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](std::string detail) {
    return ControlResult::Failure(id, detail, std::move(reply));
  };
  const auto session = request.session.value_or(0);
  const auto view = request.view.value_or(0);
  auto* record = runtime_.views.Find(session, view);
  if (!record || !runtime_.view_model.FindWebView(session, view))
    return ControlResult::Failure(request.id, ErrorCode::not_found, "View is not in session");
  if (record->requests->close_state() == "closing")
    return ControlResult::Failure(id, "view_closing");

  Status status;

  auto visible = request.visible;
  if (!visible)
    return error("visible_boolean_required");
  auto next = runtime_.views.Specs();
  next[view].visible = *visible;
  auto layout = runtime_.layout_transaction.Prepare(next);
  if (!layout)
    return ControlResult::Failure(id, layout.status.error, layout.status.message);
  {
    runtime_.layout_transaction.Commit(std::move(layout.value));
    runtime_.UpdateOutput();
  }

  reply.Set("token", TokenValue(runtime_.view_model.Token(session, view).value));
  runtime_.UpdateOutput();
  if (!status)
    return ControlResult::Failure(id, status.error, status.message, std::move(reply));
  return reply;
}

base::DictValue ControlDispatcher::HandleNavigate(const NavigateRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](std::string detail) {
    return ControlResult::Failure(id, detail, std::move(reply));
  };
  const auto session = request.session.value_or(0);
  const auto view = request.view.value_or(0);
  auto* record = runtime_.views.Find(session, view);
  if (!record || !runtime_.view_model.FindWebView(session, view))
    return ControlResult::Failure(request.id, ErrorCode::not_found, "View is not in session");
  auto& adapter = *record->webview;
  if (record->requests->close_state() == "closing")
    return ControlResult::Failure(id, "view_closing");

  Status status;

  const auto* url = Ptr(request.url);
  if (!url)
    return error("url_required");
  status = adapter.Navigate(GURL(*url), request.operation);

  reply.Set("token", TokenValue(runtime_.view_model.Token(session, view).value));
  runtime_.UpdateOutput();
  if (!status)
    return ControlResult::Failure(id, status.error, status.message, std::move(reply));
  return reply;
}

base::DictValue ControlDispatcher::HandleLifecycle(const LifecycleControlRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](std::string detail) {
    return ControlResult::Failure(id, detail, std::move(reply));
  };
  const auto session = request.session.value_or(0);
  const auto view = request.view.value_or(0);
  auto* record = runtime_.views.Find(session, view);
  if (!record || !runtime_.view_model.FindWebView(session, view))
    return ControlResult::Failure(request.id, ErrorCode::not_found, "View is not in session");
  auto& adapter = *record->webview;
  if (record->requests->close_state() == "closing")
    return ControlResult::Failure(id, "view_closing");

  Status status;

  const auto* action = Ptr(request.action);
  if (!action)
    return error("action_required");
  std::optional<Lifecycle> operation;
  if (*action == "unload")
    operation = Lifecycle::unload;
  if (*action == "restore")
    operation = Lifecycle::restore;
  if (*action == "freeze")
    operation = Lifecycle::freeze;
  if (*action == "discard")
    operation = Lifecycle::discard;
  if (!operation)
    return error("unknown_lifecycle_action");
  const bool guarded = request.expected_lifecycle_generation.has_value();
  const bool recover_uncertain = guarded && *operation == Lifecycle::unload;
  if (guarded) {
    uint64_t generation = 0;
    const auto* model = runtime_.view_model.FindWebView(session, view);
    if (!Assign(request.expected_lifecycle_generation, &generation) || !model ||
        model->lifecycle_generation != generation || model->pending ||
        record->requests->close_state() == "closing" || record->requests->close_state() == "closed")
      return error("stale_lifecycle_recovery");
    if (recover_uncertain) {
      const auto allowed = adapter.CanRecoverLifecycle();
      if (!allowed)
        return ControlResult::Failure(id, allowed.error, allowed.message, std::move(reply));
    } else if (*operation != Lifecycle::restore || model->actual != Residency::unloaded ||
               adapter.lifecycle_uncertain()) {
      return error("stale_lifecycle_recovery");
    }
  }
  if (*operation == Lifecycle::discard || *operation == Lifecycle::freeze) {
    const auto allowed = runtime_.CanDiscard(view);
    if (!allowed)
      return ControlResult::Failure(id, allowed.error, allowed.message, std::move(reply));
  }
  if (runtime_.output) {
    runtime_.paused_output.insert(view);
    runtime_.output->StopView(view);
    runtime_.UpdateOutput();
  }
  record->requests->CancelAll("lifecycle_transition");
  record->requests->Bind(nullptr);
  status = adapter.RequestLifecycle(*operation, {}, recover_uncertain);
  record->requests->Bind(adapter.contents());
  runtime_.paused_output.erase(view);
  runtime_.UpdateOutput();
  reply.Set("accepted", static_cast<bool>(status));
  const auto* lifecycle = runtime_.view_model.FindWebView(session, view);
  reply.Set("pending", lifecycle->pending.has_value());
  reply.Set("completed", static_cast<bool>(status) && !lifecycle->pending);
  reply.Set("lifecycleGeneration", base::NumberToString(lifecycle->lifecycle_generation));

  reply.Set("token", TokenValue(runtime_.view_model.Token(session, view).value));
  runtime_.UpdateOutput();
  if (!status)
    return ControlResult::Failure(id, status.error, status.message, std::move(reply));
  return reply;
}

base::DictValue ControlDispatcher::HandleInput(const InputRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](std::string detail) {
    return ControlResult::Failure(id, detail, std::move(reply));
  };
  const auto session = request.session.value_or(0);
  const auto view = request.view.value_or(0);
  auto* record = runtime_.views.Find(session, view);
  if (!record || !runtime_.view_model.FindWebView(session, view))
    return ControlResult::Failure(request.id, ErrorCode::not_found, "View is not in session");
  auto& adapter = *record->webview;
  if (record->requests->close_state() == "closing")
    return ControlResult::Failure(id, "view_closing");

  Status status;

  if (Ptr(request.output_generation)) {
    uint64_t generation = 0;
    if (!Assign(request.output_generation, &generation) || !runtime_.output ||
        generation != runtime_.output_generation)
      return error("stale_output_generation");
  }
  const auto& input = request.input;
  bool input_admitted = false;
  if (runtime_.output)
    runtime_.output->TraceInput("input_browser_dispatch", input);
  status = adapter.DispatchInput(input, &input_admitted);
  if (runtime_.output)
    runtime_.output->TraceInput("input_browser_dispatch_return", input,
                                static_cast<int>(status.error));
  if (const auto* touch = std::get_if<TouchInput>(&input.payload)) {
    reply.Set("touchPending", adapter.TouchProcessingPending());
    reply.Set("touchSequenceId", touch->clock ? touch->clock->sequence_id : std::string());
    reply.Set("inputAdmitted", input_admitted);
    if (touch->clock &&
        (touch->action == TouchInput::Action::end || touch->action == TouchInput::Action::cancel))
      reply.Set("touchTerminal",
                adapter.ClientTouchStatus(input.token, touch->clock->sequence_id) !=
                    ClientTouchRetirement::State::unknown);
    if (!status && touch->clock &&
        (input_admitted || (status.error == ErrorCode::stale_identity &&
                            status.message == "Client touch owner explicitly invalidated")) &&
        adapter.ClientTouchRetired(input.token, touch->clock->sequence_id)) {
      reply.Set("touchState", "terminal-invalidated");
      reply.Set("touchPending", false);
    }
  }

  reply.Set("token", TokenValue(runtime_.view_model.Token(session, view).value));
  runtime_.UpdateOutput();
  if (!status)
    return ControlResult::Failure(id, status.error, status.message, std::move(reply));
  return reply;
}

}  // namespace remotekit::browser
