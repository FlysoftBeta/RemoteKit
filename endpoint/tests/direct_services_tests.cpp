#include "rtc/dc_services.hpp"
#include "management/link.hpp"
#include <cstdlib>
#include <cstdio>
#include <iostream>
#include <sstream>
#include <vector>
#include <filesystem>
#include <fstream>
using Json = nlohmann::json;
void Check(bool value, const char* message) {
  if (!value) {
    std::cerr << message << '\n';
    std::exit(1);
  }
}
void ContextMenuTests() {
  using namespace remotekit;
  static_assert(kSharedRenderVersion == 8);
  static_assert(sizeof(SharedAtlasView) == 256);
  static_assert(offsetof(SharedAtlasView, context_menu) == 224);
  static_assert(sizeof(SharedAtlasFrame) == 16440);
  static_assert(offsetof(SharedRenderMapping, slots) == 16512);
  static_assert(offsetof(SharedRenderMapping, clipboard_sequence) == 24);
  static_assert(offsetof(SharedRenderMapping, latest_layout) == 32);
  static_assert(sizeof(SharedRenderMapping) == 82304);
  DirectServices services;
  services.Bind(3);
  SharedAtlasFrame frame{};
  frame.generation = 1;
  frame.status = SharedAtlasStatus::kRunning;
  frame.view_count = 1;
  auto& view = frame.views[0];
  view.session_id = 1;
  view.webview_id = 2;
  view.instance_generation = 3;
  view.document_generation = 4;
  view.context_menu = {UINT64_MAX, 10, 20};
  int fetches = 0;
  auto latest = [&] { return DirectServices::ContextMenuIdentity(frame, false); };
  auto fetch = [&](const Json& identity) {
    ++fetches;
    Check(identity["menu"] == "18446744073709551615", "context menu id preserves uint64");
    // Reenter services to ensure fetching holds no service mutex.
    services.Selection(3, frame, 1);
    return Json{{"id", identity["menu"]}, {"x", 10}, {"y", 20}, {"source", "mouse"}};
  };
  std::vector<Json> sent;
  auto flush = [&] {
    sent.clear();
    services.Flush(3, [&](const std::string& bytes) {
      sent.push_back(Json::parse(bytes));
      return 0;
    });
  };
  services.ContextMenu(3, frame, false, fetch, latest);
  services.ContextMenu(3, frame, false, fetch, latest);
  flush();
  auto message = sent.back();
  Check(fetches == 1 && message["type"] == "input.contextMenu" && message["version"] == 1 &&
            message["revision"] == "1" && message["view"]["id"] == "2" &&
            message["view"]["document"] == "4" && message["menu"]["id"] == "18446744073709551615",
        "context details are fetched and sent once for the current surface");
  view.context_menu.menu_id = 5;
  services.ContextMenu(
      3, frame, false,
      [&](const Json&) {
        ++fetches;
        view.context_menu.menu_id = 6;
        return Json{{"id", "5"}};
      },
      latest);
  flush();
  Check(sent.empty(), "superseded in-flight fetch is never sent");
  services.ContextMenu(
      3, frame, false,
      [&](const Json&) {
        ++fetches;
        return Json{{"id", "6"}};
      },
      latest);
  services.Flush(3, [](const auto&) { return 1; });
  flush();
  Check(sent.size() == 1 && sent[0]["revision"] == "2" && sent[0]["menu"]["id"] == "6",
        "newest menu supersedes old fetch and retries a blocked send");
  view.context_menu.menu_id = 7;
  services.ContextMenu(
      3, frame, false,
      [&](const Json&) {
        ++fetches;
        return Json();
      },
      latest);
  flush();
  Check(sent.empty(), "not_found fetch sends nothing");
  view.context_menu = {};
  services.ContextMenu(3, frame, false, fetch, latest);
  flush();
  Check(sent.size() == 1 && sent[0]["revision"] == "3" && sent[0]["menu"].is_null(),
        "zero menu closes without an RPC");
  view.context_menu.menu_id = 8;
  services.ContextMenu(
      3, frame, false,
      [&](const Json&) {
        view.document_generation = 5;
        return Json{{"id", "8"}};
      },
      latest);
  flush();
  Check(sent.empty(), "document change invalidates fetched details");
  services.ContextMenu(
      3, frame, false,
      [&](const Json&) {
        services.Bind(4);
        return Json{{"id", "8"}};
      },
      latest);
  flush();
  Check(sent.empty(), "peer replacement invalidates fetched details");
  services.Bind(3);
  services.ContextMenu(3, frame, true, fetch,
                       [&] { return DirectServices::ContextMenuIdentity(frame, true); });
  flush();
  Check(sent.size() == 1 && sent[0]["view"].is_null() && sent[0]["menu"].is_null(),
        "suspension closes context menu without fetching");
  Check(fetches == 4, "only new nonzero menu identities cause a fetch");
}
void FocusProvenanceTests() {
  using namespace remotekit;
  DirectServices services;
  services.Bind(1);
  SharedAtlasFrame frame{};
  frame.generation = 1;
  frame.view_count = 1;
  auto& view = frame.views[0];
  view.session_id = view.webview_id = view.instance_generation = view.document_generation = 1;
  view.text_input.flags = kAtlasTextInputActive;
  view.text_input.type = 1;
  view.text_input.target_id = 7;
  view.text_input.focus_source = 3;
  view.text_input.focus_observation = 1;
  Json message;
  auto observe = [&] {
    services.Editable(1, frame);
    services.Flush(1, [&](auto bytes) {
      message = Json::parse(bytes);
      return 0;
    });
  };
  observe();
  Check(
      message["editable"]["focusSource"] == "script" && message["editable"]["focusRevision"] == "1",
      "script focus provenance");
  view.text_input.selection_end = 2;
  ++view.focus_generation;
  observe();
  Check(message["revision"] == "2" && message["editable"]["focusRevision"] == "1",
        "caret and input lease changes are not focus observations");
  view.text_input.focus_source = 1;
  ++view.text_input.focus_observation;
  observe();
  Check(message["editable"]["target"] == "7" && message["editable"]["focusSource"] == "pointer" &&
            message["editable"]["focusRevision"] == "3",
        "same editable pointer refocus is fresh");
  view.text_input.focus_source = 2;
  ++view.text_input.focus_observation;
  observe();
  Check(message["editable"]["focusSource"] == "keyboard" &&
            message["editable"]["focusRevision"] == "4",
        "keyboard traversal provenance");
  view.text_input.flags = 0;
  observe();
  Check(
      message["editable"]["focusSource"] == "other" && message["editable"]["focusRevision"] == "0",
      "blur clears focus provenance");
}
void ViewportTests() {
  remotekit::DirectServices services;
  services.Bind(4);
  remotekit::SharedAtlasFrame frame{};
  frame.generation = 8;
  frame.view_count = 1;
  frame.views[0].webview_id = 7;
  frame.views[0].page_height_dip = 500;
  frame.views[0].occlusion_revision = 2;
  services.Viewports(4, frame);
  services.Flush(4, [](auto) { return 1; });
  std::vector<Json> sent;
  services.Flush(4, [&](auto bytes) {
    sent.push_back(Json::parse(bytes));
    return 0;
  });
  Check(sent.size() == 1 && sent[0]["type"] == "view.viewport" && sent[0]["pageHeight"] == 500 &&
            sent[0]["occlusionRevision"] == "2",
        "viewport feedback retries independently");
  services.Viewports(4, frame);
  services.Flush(4, [&](auto bytes) {
    sent.push_back(Json::parse(bytes));
    return 0;
  });
  Check(sent.size() == 1, "unchanged viewport is not resent");
  services.Bind(5);
  services.Viewports(5, frame);
  services.Flush(5, [&](auto bytes) {
    sent.push_back(Json::parse(bytes));
    return 0;
  });
  Check(sent.size() == 2, "new peer receives current viewport");
}

int main() {
  ViewportTests();
  FocusProvenanceTests();
  ContextMenuTests();
  remotekit::DirectServices services;
  services.Bind(3);
  std::vector<Json> sent;
  remotekit::SharedAtlasFrame frame{};
  frame.generation = 1;
  frame.view_count = 1;
  auto& view = frame.views[0];
  view.session_id = 1;
  view.webview_id = 2;
  view.instance_generation = 3;
  view.document_generation = 4;
  view.focus_generation = 5;
  view.reserved = remotekit::kSharedAtlasViewStale;
  view.text_input.flags = remotekit::kAtlasTextInputActive;
  view.text_input.type = 1;
  view.text_input.selection_end = 4;
  view.text_input.target_id = UINT64_MAX;
  view.text_input.focus_source = 1;
  view.text_input.focus_observation = 10;
  services.Editable(3, frame);
  view.text_input.selection_end = 7;
  services.Editable(3, frame);
  sent.clear();
  services.Flush(3, [&](auto bytes) {
    sent.push_back(Json::parse(bytes));
    return 0;
  });
  Check(sent.size() == 1 && sent[0]["editable"]["selectionEnd"] == 7 && sent[0]["revision"] == "2",
        "latest editable coalesces while advancing the revision");
  Check(sent[0]["editable"]["focusSource"] == "pointer" &&
            sent[0]["editable"]["focusRevision"] == "1",
        "caret changes preserve focus provenance and revision");
  Check(sent[0]["view"]["document"] == "4" && !sent[0].contains("text"),
        "editable identity without contents");
  Check(sent[0]["editable"]["active"] == true &&
            sent[0]["editable"]["target"] == "18446744073709551615",
        "editable authority is available before pixels and preserves uint64 identity");
  services.Editable(3, frame);
  services.Flush(3, [&](auto) {
    Check(false, "unchanged editable not resent");
    return 0;
  });
  services.RefreshEditable();
  services.Editable(3, {});
  auto stopped = frame;
  stopped.status = remotekit::SharedAtlasStatus::kStopped;
  services.Editable(3, stopped);
  services.Flush(3, [&](auto) {
    Check(false, "pending or stopped metadata must not blur");
    return 0;
  });
  frame.generation = 2;
  services.Editable(3, frame);
  sent.clear();
  services.Flush(3, [&](auto bytes) {
    sent.push_back(Json::parse(bytes));
    return 0;
  });
  Check(sent.size() == 1 && sent[0]["editable"]["target"] == "18446744073709551615" &&
            sent[0]["revision"] == "3",
        "replacement republishes unchanged editable authority");
  view.text_input.target_id = 12;
  services.Editable(3, frame);
  sent.clear();
  services.Flush(3, [&](auto bytes) {
    sent.push_back(Json::parse(bytes));
    return 0;
  });
  Check(sent.size() == 1 && sent[0]["editable"]["target"] == "12" && sent[0]["revision"] == "4",
        "same document and selection can change editable target");
  frame.view_count = 0;
  services.Editable(3, frame);
  sent.clear();
  services.Flush(3, [&](auto bytes) {
    sent.push_back(Json::parse(bytes));
    return 0;
  });
  Check(sent.size() == 1 && sent[0]["view"].is_null() && sent[0]["editable"]["active"] == false &&
            sent[0]["editable"]["target"] == "0",
        "no target clears keyboard");
  frame.view_count = 1;
  services.Editable(3, frame);
  services.Editable(3, frame, true);
  sent.clear();
  services.Flush(3, [&](auto bytes) {
    sent.push_back(Json::parse(bytes));
    return 0;
  });
  Check(sent.size() == 1 && sent[0]["editable"]["active"] == false,
        "suspended output clears stale authority");
  services.Bind(3);
  view.selection_menu = {UINT64_MAX,
                         remotekit::kAtlasSelectionMenuVisible | remotekit::kAtlasSelectionCanCopy |
                             remotekit::kAtlasSelectionCanCut |
                             remotekit::kAtlasSelectionCanSelectAll |
                             remotekit::kAtlasSelectionCanContextMenu,
                         0,
                         10,
                         20,
                         30,
                         40,
                         24,
                         0};
  view.selection_menu.start = {10, 60, 40, 1};
  view.selection_menu.end = {40, 60, 40, 1};
  services.Selection(3, frame, 1);
  view.selection_menu.anchor_x = 11;
  services.Selection(3, frame, 1);
  sent.clear();
  services.Flush(3, [&](auto bytes) {
    sent.push_back(Json::parse(bytes));
    return 0;
  });
  Check(sent.size() == 1 && sent[0]["type"] == "input.selection" && sent[0]["revision"] == "2" &&
            sent[0]["view"]["document"] == "4" && !sent[0]["view"].contains("focus") &&
            sent[0]["menu"]["id"] == "18446744073709551615" && sent[0]["menu"]["x"] == 11 &&
            sent[0]["menu"]["commands"] == Json::array({"cut", "copy", "selectAll"}) &&
            sent[0]["menu"]["more"] == true,
        "selection publishes latest anchor, identity, uint64 id and fixed command order");
  Check(sent[0]["handles"]["start"]["x"] == 10 && sent[0]["handles"]["end"]["lineHeight"] == 40 &&
            sent[0]["handles"]["insertion"].is_null() &&
            sent[0]["outputGeneration"] == std::to_string(frame.generation) &&
            sent[0]["layoutEpoch"] == "1",
        "selection publishes root DIP handles and layout identity");
  services.Selection(3, frame, 1);
  services.Flush(3, [&](auto) {
    Check(false, "unchanged selection not resent");
    return 0;
  });
  services.Selection(3, frame, 1, true);
  services.Flush(3, [&](auto) { return 1; });
  sent.clear();
  services.Flush(3, [&](auto bytes) {
    sent.push_back(Json::parse(bytes));
    return 0;
  });
  Check(sent.size() == 1 && sent[0]["view"].is_null() && sent[0]["menu"].is_null() &&
            sent[0]["revision"] == "3",
        "suspension clears selection and failed sends retry");
  services.RefreshEditable();
  services.Selection(3, frame, 1);
  sent.clear();
  services.Flush(3, [&](auto bytes) {
    sent.push_back(Json::parse(bytes));
    return 0;
  });
  Check(sent.size() == 1 && sent[0]["revision"] == "4", "refresh republishes selection");
  view.selection_menu = {};
  services.Selection(3, frame, 1);
  sent.clear();
  services.Flush(3, [&](auto bytes) {
    sent.push_back(Json::parse(bytes));
    return 0;
  });
  Check(sent.size() == 1 && sent[0]["menu"].is_null() && sent[0]["revision"] == "5",
        "closing menu clears selection");
  std::cout << "direct services tests passed\n";
}
