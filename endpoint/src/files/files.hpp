#pragma once
#include "files/file_library.hpp"
#include "files/dc_file_services.hpp"
#include "rtc/authorization.hpp"
#include "rtc/peer.hpp"
#include "rtc/event.hpp"
#include "session/context.hpp"
namespace remotekit {
class ViewController;
class FileController;
using FileBinding = FileUploadStore::Binding;
using FileJob = DcFileServices::Job;
using LibrarySelection = FileLibrary::Selection;
using LibraryState = LibrarySelection::State;
class PhotoService : private ControllerContext {
 public:
  PhotoService(ControllerContext context,
               FileLibrary& library,
               FileController& files,
               AuthorizationController& authorization)
      : ControllerContext(context),
        file_library(library),
        files(files),
        authorization(authorization) {}
  Result<Json> Execute(const FileJob&, const std::string&, const Json&);
  void Sweep();

 private:
  FileLibrary& file_library;
  FileController& files;
  AuthorizationController& authorization;
#ifdef RK_FILE_PHOTO
  remotekit::PhotoBurstSessions<remotekit::PhotoBurstAnalyzer> photo_bursts;  // file worker only.
  struct PhotoThumbnail {
    std::string asset_id;
    int64_t refresh_after;
  };
  std::map<std::string, PhotoThumbnail> photo_thumbnails;  // file worker only.
#endif
};
class LibraryController : private ControllerContext {
 public:
  LibraryController(ControllerContext context,
                    AuthorizationController& authorization,
                    ViewController& views,
                    FileController& files)
      : ControllerContext(context),
        authorization(authorization),
        views(views),
        files(files),
        file_uploads(directory / "uploads"),
        file_library(directory / "file-library", objects, tenant, store.Library(), object_access),
        photos(context, file_library, files, authorization) {}
  Result<void> Initialize();
  Result<void> PrepareCheckpoint() { return file_library.PrepareCheckpoint(); }
  Result<Json> ImportDownload(const Json& download) {
    auto imported = file_library.ImportDownload(directory / "session-1" / "profile-1", download);
    if (!imported)
      return imported.error();
    return imported.value().Json();
  }
  Result<void> SweepDirectFiles();
  static uint64_t FileUnsigned(const Json& value);
  Json SelectionBrowserCommand(const FileBinding& binding, const char* method);
  Json SelectionStatusCommand(const LibrarySelection& selection);
  Result<std::string> RetireUnsubmittedSelection(const std::string& selection_id);
  Result<std::string> ObserveSelection(const LibrarySelection& selection, const Json& status);
  Result<Json> DirectSelectionCommit(const FileJob& job, const std::string& selection_id);
  Result<Json> DirectLibraryCommand(const FileJob& job,
                                    const std::string& method,
                                    const Json& params);
  Result<Json> DirectSelectionCancel(const FileJob& job);
  static Result<FileBinding> ParseFileBinding(const Json& value);
  Result<Json> FileBrowserCommand(const FileBinding& binding, const char* method);
  Result<Json> LibraryCommand(const std::string& method, const Json& request);
  Result<void> BrowserStopped(const std::string& incarnation);

  Json Hibernation(const std::function<bool(uint64_t)>& current) const {
    return file_library.Hibernation(current);
  }

 private:
  AuthorizationController& authorization;
  ViewController& views;
  FileController& files;
  std::string last_confirmed_browser_exit;
  remotekit::FileUploadStore file_uploads;
  remotekit::FileLibrary file_library;
  std::mutex file_store_mutex;
  struct SelectionWatch {
    remotekit::FileLibrary::Selection selection;
    uint64_t control;
    int64_t expires;
  };
  std::deque<SelectionWatch> selection_watches;  // file worker only.
  int64_t next_selection_watch = 0;

  PhotoService photos;
};
class FileController : private ControllerContext {
 public:
  ~FileController() { Stop(); }
  FileController(ControllerContext context,
                 AuthorizationController& authorization,
                 ViewController& views,
                 PeerController& peer_controller)
      : ControllerContext(context),
        authorization(authorization),
        views(views),
        peer_controller(peer_controller),
        file_services({{"tenantId", tenant}, {"sessionId", id}}),
        library(context, authorization, views, *this) {}
  Result<void> Initialize() { return library.Initialize(); }
  Result<void> PrepareCheckpoint() { return library.PrepareCheckpoint(); }
  void Start();
  void Stop();
  void Bind(uint64_t peer, const std::string& connection = {});
  void Admit(const RtcEvent&);
  void Flush(uint64_t, const std::function<int(const std::string&)>&);
  Result<void> RequireFileJob(const FileJob&);
  Result<Json> DirectFileRpc(const FileJob&, const char*, Json additions = Json::object());
  Result<Json> DirectFileCommand(const FileJob&);
  Result<Json> AuthorizeFiles(const Json&);
  bool Current(const FileJob& job) const { return file_services.Current(job); }
  bool CurrentLibraryGrant(uint64_t grant) { return file_services.CurrentLibraryGrant(grant); }
  LibraryController& Library() { return library; }
  Json Hibernation() {
    return library.Hibernation(
        [this](uint64_t grant) { return file_services.CurrentLibraryGrant(grant); });
  }
  Result<void> BrowserStopped(const std::string& incarnation);

 private:
  AuthorizationController& authorization;
  ViewController& views;
  PeerController& peer_controller;
  DcFileServices file_services;
  LibraryController library;
};
}  // namespace remotekit
