#include "browser/control_dispatcher.h"
#include "browser/control_requests.h"
#include "browser/control_response.h"
#include "browser/browser_runtime.h"
#include "base/base64.h"

namespace remotekit::browser {
Result<std::optional<NavigationOperations::Identity>> DecodeNavigationOperation(
    const base::DictValue& wire,
    bool acknowledge) {
  if (!wire.contains("operationId") && !wire.contains("operationGeneration") &&
      !wire.contains("operationSequence")) {
    if (acknowledge)
      return {{}, {ErrorCode::kInvalidRequest, "Navigation operation identity required"}};
    return {};
  }
  const auto* id = wire.FindString("operationId");
  const auto* generation = wire.FindString("operationGeneration");
  const auto* sequence = wire.FindString("operationSequence");
  uint64_t parsed = 0;
  if (!id || id->empty() || id->size() > 128 || !generation || generation->empty() ||
      generation->size() > 128 ||
      (!acknowledge && (!sequence || !base::StringToUint64(*sequence, &parsed) || !parsed)))
    return {{}, {ErrorCode::kInvalidRequest, "Invalid navigation operation identity"}};
  return {NavigationOperations::Identity{*id, *generation, parsed}, {}};
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
    return {{}, {ErrorCode::kInvalidRequest, "Session and view required"}};
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
    return {{}, {ErrorCode::kInvalidRequest, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

ControlResult ControlDispatcher::HandleNavigationTransfer(
    const NavigationTransferRequest& request) {
  const int id = request.id;
  const auto* method = &request.method;
  auto reply = ControlResult::Success(id);
  auto error = [&](ErrorCode code, std::string detail) {
    return ControlResult::Failure(id, code, detail, std::move(reply));
  };
  const auto session = request.session.value_or(0);
  const auto view = request.view.value_or(0);
  auto* record = runtime_.views.Find(session, view);
  if (!record || !runtime_.view_model.FindWebView(session, view))
    return ControlResult::Failure(request.id, ErrorCode::kNotFound, "View is not in session");
  auto& adapter = *record->webview;
  if (record->requests->close_state() == "closing")
    return ControlResult::Failure(id, ErrorCode::kConflict, "view_closing");

  if (*method == "navigation.ack") {
    const auto status = adapter.AcknowledgeNavigation(*request.operation);
    if (!status)
      return ControlResult::Failure(id, *status.error, status.message, std::move(reply));
    reply.Set("ok", true);
    return reply;
  }
  auto token = runtime_.view_model.Token(session, view).value;
  if (*method == "navigation.export.begin") {
    auto saved = adapter.ExportNavigation();
    if (!saved)
      return ControlResult::Failure(id, *saved.status.error, saved.status.message,
                                    std::move(reply));
    if (!runtime_.navigation_transfers.CanReserve(view, saved.value.size()))
      return error(ErrorCode::kBusy, "transfer_memory_limit");
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
    if (!Assign(request.size, &size) || !size)
      return error(ErrorCode::kInvalidRequest, "Navigation import size required");
    if (size > 64 * 1024 * 1024)
      return error(ErrorCode::kLimitExceeded, "Navigation import exceeds size bound");
    if (adapter.contents())
      return error(ErrorCode::kConflict, "Navigation import requires an unloaded view");
    if (!runtime_.navigation_transfers.CanReserve(view, size))
      return error(ErrorCode::kBusy, "transfer_memory_limit");
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
    if (found == runtime_.navigation_transfers.records.end() ||
        (*method != "navigation.transfer.status" &&
         (!Assign(request.transfer, &transfer_id) || found->second.id != transfer_id)))
      return error(ErrorCode::kNotFound, "transfer_not_found");
    auto& transfer = found->second;
    if (*method == "navigation.transfer.cancel") {
      runtime_.navigation_transfers.records.erase(found);
      reply.Set("ok", true);
      return reply;
    }
    if (*method == "navigation.transfer.status") {
      reply.Set("committed", transfer.committed);
    } else if (*method == "navigation.export.chunk" && !transfer.importing) {
      const auto* offset_text = Ptr(request.offset);
      uint64_t offset = 0;
      const int length = request.length.value_or(256 * 1024);
      if (!offset_text || !base::StringToUint64(*offset_text, &offset) || offset > transfer.total ||
          length < 1 || length > 256 * 1024)
        return error(ErrorCode::kInvalidRequest, "invalid_export_chunk");
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
        return error(ErrorCode::kInvalidRequest, "invalid_import_chunk");
      transfer.data += chunk;
    } else if (*method == "navigation.import.commit" && transfer.importing) {
      if (transfer.instance != token.instance || transfer.document != token.document ||
          transfer.data.size() != transfer.total)
        return error(ErrorCode::kConflict, "incomplete_or_stale_import");
      auto imported = adapter.ImportNavigation(transfer.data);
      if (!imported)
        return ControlResult::Failure(id, *imported.error, imported.message, std::move(reply));
      transfer.committed = true;
      transfer.data.clear();
    } else
      return error(ErrorCode::kInvalidRequest, "invalid_transfer_method");
  }
  const auto& transfer = runtime_.navigation_transfers.records.at(view);
  reply.Set("ok", true);
  reply.Set("importing", transfer.importing);
  reply.Set("committed", transfer.committed);
  reply.Set("transfer", base::NumberToString(transfer.id));
  reply.Set("size", base::NumberToString(transfer.total));
  reply.Set("received", base::NumberToString(transfer.committed   ? transfer.total
                                             : transfer.importing ? transfer.data.size()
                                                                  : 0));
  return reply;
}

ControlResult ControlDispatcher::HandleNavigate(const NavigateRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](ErrorCode code, std::string detail) {
    return ControlResult::Failure(id, code, detail, std::move(reply));
  };
  const auto session = request.session.value_or(0);
  const auto view = request.view.value_or(0);
  auto* record = runtime_.views.Find(session, view);
  if (!record || !runtime_.view_model.FindWebView(session, view))
    return ControlResult::Failure(request.id, ErrorCode::kNotFound, "View is not in session");
  auto& adapter = *record->webview;
  if (record->requests->close_state() == "closing")
    return ControlResult::Failure(id, ErrorCode::kConflict, "view_closing");

  Status status;

  const auto* url = Ptr(request.url);
  if (!url)
    return error(ErrorCode::kInvalidRequest, "url_required");
  status = adapter.Navigate(GURL(*url), request.operation);

  reply.Set("token", TokenValue(runtime_.view_model.Token(session, view).value));
  runtime_.UpdateOutput();
  if (!status)
    return ControlResult::Failure(id, *status.error, status.message, std::move(reply));
  return reply;
}
}  // namespace remotekit::browser
