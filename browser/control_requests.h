#pragma once

#include "browser/view_model.h"
#include "browser/navigation_operations.h"
#include "browser/storage_import.h"
#include "base/containers/flat_map.h"
#include "base/values.h"
#include "base/strings/string_number_conversions.h"
#include <type_traits>

namespace remotekit::browser {
struct RequestEnvelope {
  int id = 0;
  std::string_view method;
};
struct ShutdownRequest : RequestEnvelope {};
struct StorageScavengeRequest : RequestEnvelope {};
struct IdentityRequest : RequestEnvelope {};
struct AppInfoRequest : RequestEnvelope {
  SessionId session = 0;
  WebViewId view = 0;
};
struct StorageImportRequest : RequestEnvelope {
  std::string import_id;
  uint64_t view = 0;
  StorageImportData data;
};
struct StorageImportStatusRequest : RequestEnvelope {
  std::string import_id;
};
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
  std::optional<base::ListValue> eventIds;
  std::optional<uint64_t> session;
};
struct SnapshotRequest : RequestEnvelope {};
struct SitePreferencesRequest : RequestEnvelope {
  std::optional<base::DictValue> sites;
  std::optional<uint64_t> session;
};
struct CreateViewRequest : RequestEnvelope {
  std::optional<std::string> signIn;
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
};
struct PageControlRequest : RequestEnvelope {
  PageControlRequest() = default;
  PageControlRequest(PageControlRequest&&) = default;
  PageControlRequest& operator=(PageControlRequest&&) = default;
  ~PageControlRequest() {
    for (const char* field : {"username", "password"}) {
      auto* value = payload.FindString(field);
      if (value)
        for (auto& character : *value)
          static_cast<volatile char&>(character) = 0;
    }
  }
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
  using KeyboardLayout = base::flat_map<std::string, std::string>;
  std::optional<uint64_t> output_generation;
  std::optional<uint64_t> session;
  std::optional<uint64_t> view;
  std::variant<InputEvent, KeyboardLayout> input;
};
inline base::DictValue TokenValue(const InputToken& token) {
  base::DictValue value;
  value.Set("session", base::NumberToString(token.session));
  value.Set("view", base::NumberToString(token.view));
  value.Set("instance", base::NumberToString(token.instance));
  value.Set("document", base::NumberToString(token.document));
  value.Set("focus", base::NumberToString(token.focus));
  return value;
}

template <class T>
const T* Ptr(const std::optional<T>& value) {
  return value ? &*value : nullptr;
}
inline bool Assign(const std::optional<uint64_t>& value, uint64_t* result) {
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
    status_ = {ErrorCode::kInvalidRequest, "Invalid " + std::string(field)};
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
    bool acknowledge);

Result<ShutdownRequest> DecodeShutdown(const base::DictValue& wire, RequestEnvelope envelope);
Result<IdentityRequest> DecodeIdentity(const base::DictValue& wire, RequestEnvelope envelope);
Result<AppInfoRequest> DecodeAppInfo(const base::DictValue& wire, RequestEnvelope envelope);
Result<StorageImportRequest> DecodeStorageImport(const base::DictValue& wire,
                                                 RequestEnvelope envelope);
Result<StorageImportStatusRequest> DecodeStorageImportStatus(const base::DictValue& wire,
                                                             RequestEnvelope envelope);
Result<StorageScavengeRequest> DecodeStorageScavenge(const base::DictValue& wire,
                                                     RequestEnvelope envelope);
Result<OutputConfigureRequest> DecodeOutputConfigure(const base::DictValue& wire,
                                                     RequestEnvelope envelope);
Result<OutputOpenRequest> DecodeOutputOpen(const base::DictValue& wire, RequestEnvelope envelope);
Result<OutputStatusRequest> DecodeOutputStatus(const base::DictValue& wire,
                                               RequestEnvelope envelope);
Result<OutputCloseRequest> DecodeOutputClose(const base::DictValue& wire, RequestEnvelope envelope);
Result<AudioOpenRequest> DecodeAudioOpen(const base::DictValue& wire, RequestEnvelope envelope);
Result<AudioCloseRequest> DecodeAudioClose(const base::DictValue& wire, RequestEnvelope envelope);
Result<ClosedAckRequest> DecodeClosedAck(const base::DictValue& wire, RequestEnvelope envelope);
Result<SnapshotRequest> DecodeSnapshot(const base::DictValue& wire, RequestEnvelope envelope);
Result<SitePreferencesRequest> DecodeSitePreferences(const base::DictValue& wire,
                                                     RequestEnvelope envelope);
Result<CreateViewRequest> DecodeCreateView(const base::DictValue& wire, RequestEnvelope envelope);
Result<CloseViewRequest> DecodeCloseView(const base::DictValue& wire, RequestEnvelope envelope);
Result<RecreateViewRequest> DecodeRecreateView(const base::DictValue& wire,
                                               RequestEnvelope envelope);
Result<ConfigureViewRequest> DecodeConfigureView(const base::DictValue& wire,
                                                 RequestEnvelope envelope);
Result<ProfileCommandRequest> DecodeProfileCommand(const base::DictValue& wire,
                                                   RequestEnvelope envelope);
Result<PageControlRequest> DecodePageRequest(const base::DictValue& wire, RequestEnvelope envelope);
Result<ExitFullscreenRequest> DecodeExitFullscreen(const base::DictValue& wire,
                                                   RequestEnvelope envelope);
Result<NavigationTransferRequest> DecodeNavigationTransfer(const base::DictValue& wire,
                                                           RequestEnvelope envelope);
Result<FocusRequest> DecodeFocus(const base::DictValue& wire, RequestEnvelope envelope);
Result<VisibleRequest> DecodeVisible(const base::DictValue& wire, RequestEnvelope envelope);
Result<NavigateRequest> DecodeNavigate(const base::DictValue& wire, RequestEnvelope envelope);
Result<LifecycleControlRequest> DecodeLifecycle(const base::DictValue& wire,
                                                RequestEnvelope envelope);
Result<InputRequest> DecodeInput(const base::DictValue& wire, RequestEnvelope envelope);
}  // namespace remotekit::browser
