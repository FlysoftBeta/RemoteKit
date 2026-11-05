#include "management/methods.hpp"
#include "session/session.hpp"
#include <map>
namespace remotekit {
ManagementMethods::Handler ManagementMethods::Find(const std::string& name) {
  static const std::map<std::string, Handler> methods{
      {"session.library.references",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.LibraryCommand("session.library.references", request);
       }},
      {"auth.face.begin",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageAuthFaceBegin(request);
       }},
      {"auth.face.cancel",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageAuthFaceCancel(request);
       }},
      {"auth.face.capabilities",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageAuthFaceCapabilities(request);
       }},
      {"auth.face.status",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageAuthFaceStatus(request);
       }},
      {"rtc.actionResult",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageRtcActionResult(request);
       }},
      {"rtc.authorize",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageRtcAuthorize(request);
       }},
      {"rtc.close",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageRtcClose(request);
       }},
      {"rtc.ice",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageRtcIce(request);
       }},
      {"rtc.offer",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageRtcOffer(request);
       }},
      {"session.ensure",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageSessionEnsure(request);
       }},
      {"session.events.ack",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageSessionEventsAck(request);
       }},
      {"session.files.authorize",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageSessionFilesAuthorize(request);
       }},
      {"session.library.describe",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageSessionLibraryDescribe(request);
       }},
      {"session.library.prepare",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageSessionLibraryPrepare(request);
       }},
      {"session.library.retain",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageSessionLibraryRetain(request);
       }},
      {"session.library.selectionStatus",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageSessionLibrarySelectionStatus(request);
       }},
      {"session.mediaPolicy",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageSessionMediaPolicy(request);
       }},
      {"session.sitePreferences",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageSessionSitePreferences(request);
       }},
      {"session.snapshot",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageSessionSnapshot(request);
       }},
      {"view.adopt",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageViewEnsure(request);
       }},
      {"view.close",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageViewClose(request);
       }},
      {"view.close.reply",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageViewCloseReply(request);
       }},
      {"view.command",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageViewCommand(request);
       }},
      {"view.configure",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageViewConfigure(request);
       }},
      {"view.ensure",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageViewEnsure(request);
       }},
      {"view.lifecycle",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageViewLifecycle(request);
       }},
      {"view.navigate",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageViewNavigate(request);
       }},
      {"view.navigation.ack",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageViewNavigationAck(request);
       }},
      {"view.page.exitFullscreen",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageViewPageExitFullscreen(request);
       }},
      {"view.page.reply",
       [](Session& session, const Json& request) -> Result<Json> {
         return session.ManageViewPageReply(request);
       }},
  };
  auto found = methods.find(name);
  return found == methods.end() ? nullptr : found->second;
}
}  // namespace remotekit
