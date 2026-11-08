#pragma once
#include "files/download_imports.hpp"
#include <windows.h>

void DownloadImportTests(const fs::path& root,
                         remotekit::objects::ObjectService& objects,
                         Control& control,
                         const remotekit::objects::Keys& keys) {
  using namespace remotekit;
  const auto directory = root / "download-session";
  const auto profile = directory / "session-1" / "profile-1";
  fs::create_directories(profile / "downloads");
  fs::create_directories(profile / "outside");
  const auto target = profile / "downloads" / "page.txt";
  const auto write = [&] { std::ofstream(target, std::ios::binary) << "download"; };
  write();
  Json event = {{"type", "download.completed"},
                {"eventId", "browser-event"},
                {"guid", "guid"},
                {"fileReference", "downloads/page.txt"},
                {"name", "page.txt"},
                {"mimeType", "text/plain"},
                {"size", "8"},
                {"origin", "https://example.test:8443"}};
  FileLibrary library(directory / "file-library", objects, "tenant", keys);
  Take(library.Initialize());
  const auto imported = Take(library.ImportDownload(profile, event));
  CHECK(imported.size == 8 && imported.type == "text/plain");
  CHECK(control.committed.back()["objectId"] == imported.id);
  for (const auto* path :
       {"C:/outside.txt", "//server/share/file", "/downloads/page.txt",
        "downloads/../outside/page.txt", "outside/page.txt", "../downloads/page.txt",
        "downloads/page.txt:stream", "downloads\\page.txt", "downloads/./page.txt"}) {
    auto invalid = event;
    invalid["fileReference"] = path;
    CHECK(!library.ImportDownload(profile, invalid));
  }
  const auto junction = profile / "downloads" / "junction";
  const auto command = "cmd /d /c mklink /J \"" + junction.string() + "\" \"" +
                       (profile / "outside").string() + "\" >nul";
  CHECK(std::system(command.c_str()) == 0);
  std::ofstream(profile / "outside" / "page.txt") << "download";
  auto linked = event;
  linked["fileReference"] = "downloads/junction/page.txt";
  CHECK(!library.ImportDownload(profile, linked));
  fs::remove(junction);
  CHECK(fs::exists(profile / "outside" / "page.txt"));

  auto huge = event;
  huge["size"] = "268435457";
  CHECK(library.ImportDownload(profile, huge).error().message == "file_too_large");
  auto missing = event;
  missing["fileReference"] = "downloads/missing.txt";
  CHECK(library.ImportDownload(profile, missing).error().code == ErrorCode::kNotFound);
  auto mismatch = event;
  mismatch["size"] = "7";
  CHECK(!library.ImportDownload(profile, mismatch));
  fs::resize_file(target, 256 * 1024 * 1024 + 1);
  CHECK(library.ImportDownload(profile, event).error().message == "file_too_large");
  write();

  SessionStore store(directory);
  unsigned imports = 0;
  std::vector<std::string> order;
  const auto import = [&](const Json& download) -> Result<Json> {
    ++imports;
    auto result = library.ImportDownload(profile, download);
    if (!result)
      return result.error();
    CHECK(control.committed.back()["objectId"] == result.value().id);
    order.push_back("committed");
    return result.value().Json();
  };
  bool fail_remove = true, fail_ack = true;
  const auto rpc = [&](Json command) -> Result<Json> {
    if (command.at("method") == "profile.downloads") {
      CHECK(command.at("command") == Json({{"action", "remove"}, {"guid", "guid"}}));
      if (fail_remove)
        return Error{ErrorCode::kUnavailable, "transport failed"};
      order.push_back("remove");
      fs::remove(target);
    } else {
      CHECK(command.at("method") == "view.closed.ack");
      CHECK(command.at("eventIds") == Json::array({"browser-event"}));
      if (fail_ack)
        return Error{ErrorCode::kUnavailable, "ack reply lost"};
      order.push_back("ack");
    }
    return Json{{"ok", true}};
  };
  {
    DownloadImports downloads(store);
    downloads.Initialize();
    downloads.SetImport(import);
    CHECK(!downloads.Observe("incarnation", Json::array({event}), "1", rpc));
    CHECK(imports == 1 && downloads.Pending() == 1 && downloads.Events().empty());
  }
  fail_remove = false;
  {
    DownloadImports downloads(store);
    downloads.Initialize();
    downloads.SetImport(import);
    CHECK(!downloads.Observe("incarnation", Json::array({event}), "1", rpc));
    CHECK(imports == 1 && downloads.Pending() == 1 && !fs::exists(target));
  }
  fail_ack = false;
  std::string endpoint_event;
  {
    DownloadImports downloads(store);
    downloads.Initialize();
    downloads.SetImport(import);
    Take(downloads.Observe("incarnation", Json::array({event}), "1", rpc));
    CHECK(imports == 1 && downloads.Pending() == 0);
    CHECK(order == std::vector<std::string>({"committed", "remove", "remove", "ack"}));
    const auto result = downloads.Events().at(0);
    CHECK(result.at("type") == "download.imported" && result.at("assetId") == imported.id);
    CHECK(result.at("size") == "8" && result.at("origin") == event.at("origin"));
    endpoint_event = result.at("eventId");
  }
  {
    DownloadImports downloads(store);
    downloads.Initialize();
    CHECK(downloads.Events().size() == 1);
    Take(downloads.Acknowledge({endpoint_event}));
    CHECK(downloads.Events().empty());
  }
  write();
  control.reject_commit = true;
  control.reject_code = ErrorCode::kLimitExceeded;
  {
    DownloadImports downloads(store);
    downloads.Initialize();
    downloads.SetImport(import);
    Take(downloads.Observe("next-incarnation", Json::array({event}), "1", rpc));
    CHECK(imports == 2 && downloads.Events().at(0).at("type") == "download.failed");
    CHECK(downloads.Events().at(0).at("reason") == "quota_exceeded");
    CHECK(downloads.Pending() == 0 && !fs::exists(target));
    Take(downloads.Acknowledge({downloads.Events().at(0).at("eventId").get<std::string>()}));
  }
  control.reject_commit = false;
  control.reject_code = ErrorCode::kUnavailable;
  unsigned serial = 0;
  for (const auto& [download, reason] :
       std::vector<std::pair<Json, std::string>>{{missing, "file_missing"},
                                                 {huge, "file_too_large"},
                                                 {mismatch, "io_error"},
                                                 {linked, "file_missing"}}) {
    write();
    DownloadImports downloads(store);
    downloads.Initialize();
    downloads.SetImport(import);
    Take(downloads.Observe("failure-" + std::to_string(++serial), Json::array({download}), "1",
                           rpc));
    const auto result = downloads.Events().at(0);
    CHECK(result.at("type") == "download.failed" && result.at("reason") == reason);
    CHECK(result.size() == 5 && !result.contains("fileReference"));
    CHECK(!fs::exists(target) && downloads.Pending() == 0);
    Take(downloads.Acknowledge({result.at("eventId").get<std::string>()}));
  }
}
