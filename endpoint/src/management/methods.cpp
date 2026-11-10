#include "management/methods.hpp"
#include "session/session.hpp"
#include <map>
namespace remotekit {
ManagementMethods::Handler ManagementMethods::Find(const std::string& name) {
  static const std::map<std::string, Handler> methods{
      {"clipboard.write",
       [](Session& session, const Json& request) { return session.WriteClipboard(request); }},
      {"session.open", [](Session& session, const Json& request) { return session.Open(request); }},
      {"auth.face.begin",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Face().FaceCommand(Required(request, "method"), request,
                                           session.ManagementGeneration(),
                                           [&session] { return session.ManagementCurrent(); });
       }},
      {"auth.face.cancel",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Face().FaceCommand(Required(request, "method"), request,
                                           session.ManagementGeneration(),
                                           [&session] { return session.ManagementCurrent(); });
       }},
      {"auth.face.capabilities",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Face().FaceCapabilities();
       }},
      {"auth.face.status",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Face().FaceCommand(Required(request, "method"), request,
                                           session.ManagementGeneration(),
                                           [&session] { return session.ManagementCurrent(); });
       }},
      {"rtc.actionResult",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Channel().ManageRtcActionResult(request);
       }},
      {"rtc.authorize",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Authorization().Authorize(
             request, session.ManagementGeneration(),
             [&session] { return session.ManagementCurrent(); });
       }},
      {"rtc.close",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Channel().ManageRtcClose(request);
       }},
      {"rtc.ice",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Channel().ManageRtcIce(request);
       }},
      {"rtc.offer",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Channel().ManageRtcOffer(request);
       }},
      {"session.ensure",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Ensure(request);
       }},
      {"session.events.ack",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Views().ManageSessionEventsAck(request);
       }},
      {"session.storage.import",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Views().ManageSessionStorageImport(request);
       }},
      {"session.storage.importStatus",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Views().ManageSessionStorageImportStatus(request);
       }},
      {"session.identity",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Views().ManageSessionIdentity(request);
       }},
      {"session.files.authorize",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Files().AuthorizeFiles(request);
       }},
      {"session.library.describe",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Files().Library().LibraryCommand(Required(request, "method"), request);
       }},
      {"session.library.prepare",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Files().Library().LibraryCommand(Required(request, "method"), request);
       }},
      {"session.library.selectionStatus",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Files().Library().LibraryCommand(Required(request, "method"), request);
       }},
      {"session.mediaPolicy",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Media().ManageSessionMediaPolicy(request);
       }},
      {"session.sitePreferences",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Views().ManageSessionSitePreferences(request);
       }},
      {"session.logs.read",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ReadLog(request);
       }},
      {"session.snapshot",
       [](Session& session, const Json& request) -> Result<Json> {
         if (request.contains("outputDiagnostics") && !request["outputDiagnostics"].is_boolean())
           return Error{ErrorCode::kInvalidRequest, "outputDiagnostics boolean required"};
         return session.Snapshot(request.value("outputDiagnostics", false));
       }},
      {"view.adopt",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Views().ManageViewEnsure(request);
       }},
      {"view.appInfo",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Views().ManageViewAppInfo(request);
       }},
      {"view.close",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Views().ManageViewClose(request);
       }},
      {"view.close.reply",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Views().ManageViewCloseReply(request);
       }},
      {"view.command",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Views().ManageViewCommand(request);
       }},
      {"view.configure",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Views().ManageViewConfigure(request);
       }},
      {"view.ensure",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Views().ManageViewEnsure(request);
       }},
      {"view.lifecycle",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Views().ManageViewLifecycle(request);
       }},
      {"view.navigate",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Views().ManageViewNavigate(request);
       }},
      {"view.navigation.ack",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Views().ManageViewNavigationAck(request);
       }},
      {"view.page.exitFullscreen",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Views().ManageViewPageExitFullscreen(request);
       }},
      {"view.page.reply",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.Views().ManageViewPageReply(request);
       }},
  };
  auto found = methods.find(name);
  return found == methods.end() ? nullptr : found->second;
}
}  // namespace remotekit
