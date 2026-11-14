#pragma once
#include "retry_owner_drivers.hpp"
#include "util/file_io.hpp"

namespace remotekit::retry_test {
inline OwnerDriver CleanupDriver(const fs::path& root, std::string loop) {
  struct Fixture {
    SessionFixture session;
    Boundary boundary;
    std::string loop, id;
    fs::path path;
    uint64_t input = 1;
    std::optional<Error> failure;
    Fixture(const fs::path& root, std::string name)
        : session(root, "cleanup"), loop(std::move(name)) {
      if (loop == "browser.exit_cleanup") {
        NativeRetryOwnerProbe::Exited(session.owner, "exited-1");
      } else if (loop == "selection.watch") {
        NativeRetryOwnerProbe::Selection(session.owner, input);
      } else if (loop == "upload.cleanup") {
        const auto source = root / "source";
        std::ofstream(source, std::ios::binary) << "x";
        auto& owner = NativeRetryOwnerProbe::Uploads(session.owner);
        const auto batch = Take(owner.Stage({"browser", "1", "instance", "document", "request"},
                                            {{{"file.txt", "text/plain", 1}, source}},
                                            []() -> Result<void> { return {}; }));
        id = batch.id;
        path = batch.files.front().path.parent_path();
        NativeRetryOwnerProbe::RemoveUploads(owner, [&](const fs::path& target) -> Result<void> {
          auto result = boundary.Call({{"path", Utf8(target)}});
          if (!result)
            return result.error();
          return RemoveTree(target);
        });
      } else {
        auto& owner = NativeRetryOwnerProbe::Library(session.owner);
        if (loop == "files.draft_cleanup") {
          const auto draft = Take(owner.Begin(input, "operation", {"file.txt", "text/plain", 1},
                                              []() -> Result<void> { return {}; }));
          id = draft.at("uploadId").get<std::string>();
        } else {
          path = NativeRetryOwnerProbe::StagingPath(owner);
          fs::create_directories(path.parent_path());
          std::ofstream(path) << "stale";
          id = path.string();
        }
        NativeRetryOwnerProbe::RemoveLibrary(owner, [&](const fs::path& target) -> Result<void> {
          auto result = boundary.Call({{"path", Utf8(target)}});
          if (!result)
            return result.error();
          return RemoveFile(target);
        });
      }
    }
    void Tick() {
      if (loop == "files.staging_cleanup" && !fs::exists(path))
        return;
      Result<void> result;
      if (loop == "browser.exit_cleanup")
        result = NativeRetryOwnerProbe::ExitCleanup(
            session.owner, [&](const std::string& incarnation) -> Result<void> {
              auto call = boundary.Call({{"incarnation", incarnation}});
              return call ? Result<void>{} : Result<void>{call.error()};
            });
      else if (loop == "selection.watch") {
        browser_dispatch = [&](Json request) -> Result<Json> {
          request.erase("id");
          return boundary.Call(request, {{"state", "unknown"}});
        };
        auto watched = NativeRetryOwnerProbe::Watch(session.owner);
        if (!watched)
          result = watched.error();
      } else if (loop == "upload.cleanup") {
        auto& owner = NativeRetryOwnerProbe::Uploads(session.owner);
        result = input == 1 ? owner.AbortSubmission(id) : owner.ConfirmBrowserStopped("browser");
        if (!result && !fs::exists(path))
          throw std::runtime_error("failed upload cleanup released its files");
      } else {
        auto& owner = NativeRetryOwnerProbe::Library(session.owner);
        result = loop == "files.draft_cleanup"
                     ? owner.Cancel(input, id, []() -> Result<void> { return {}; })
                     : NativeRetryOwnerProbe::Staging(owner, path);
      }
      if (!result)
        failure = result.error();
    }
    void Change() {
      ++input;
      if (loop == "browser.exit_cleanup")
        NativeRetryOwnerProbe::Exited(session.owner, "exited-" + std::to_string(input));
      if (loop == "selection.watch")
        NativeRetryOwnerProbe::Selection(session.owner, input);
      if (loop == "files.staging_cleanup")
        fs::last_write_time(path, fs::last_write_time(path) + std::chrono::seconds(1));
    }
    bool Retired() const {
      return loop == "upload.cleanup" &&
             NativeRetryOwnerProbe::UploadRetired(
                 NativeRetryOwnerProbe::Uploads(const_cast<Session&>(session.owner)), id);
    }
    RetryUnit::Snapshot State() const {
      if (loop == "browser.exit_cleanup")
        return NativeRetryOwnerProbe::ExitState(session.owner);
      if (loop == "selection.watch")
        return NativeRetryOwnerProbe::WatchState(session.owner);
      if (loop == "upload.cleanup")
        return NativeRetryOwnerProbe::UploadState(
            NativeRetryOwnerProbe::Uploads(const_cast<Session&>(session.owner)), id);
      return NativeRetryOwnerProbe::LibraryState(
          NativeRetryOwnerProbe::Library(const_cast<Session&>(session.owner)), id);
    }
  };
  auto f = std::make_shared<Fixture>(root, std::move(loop));
  return {f,
          std::shared_ptr<Boundary>(f, &f->boundary),
          [f] { f->Tick(); },
          [f] { f->Change(); },
          [f] { return f->State(); },
          [f] { return f->failure.has_value(); },
          [f] { return f->Retired(); }};
}
}  // namespace remotekit::retry_test
