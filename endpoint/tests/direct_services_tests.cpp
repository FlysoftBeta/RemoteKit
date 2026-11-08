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
Json Action(unsigned n = 0) {
  char id[37];
  std::snprintf(id, sizeof(id), "00000000-0000-4000-8000-%012u", n);
  return {{"type", "product.action"},
          {"version", 1},
          {"operationId", id},
          {"operationGeneration", "generation"},
          {"action", {{"type", "tab.navigate"}, {"url", "https://example.com/"}}}};
}
void ContextMenuTests() {
  using namespace remotekit;
  static_assert(kSharedRenderVersion == 4);
  static_assert(sizeof(SharedAtlasView) == 176);
  static_assert(offsetof(SharedAtlasView, context_menu) == 160);
  static_assert(sizeof(SharedAtlasFrame) == 11320);
  static_assert(offsetof(SharedRenderMapping, slots) == 11392);
  static_assert(sizeof(SharedRenderMapping) == 56704);
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
    services.Selection(3, frame);
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
int main() {
  ContextMenuTests();
  Check(remotekit::ProductActionEnvelope(Action(), 200), "valid action");
  auto invalid = Action();
  invalid["action"]["type"] = "window.open";
  Check(remotekit::ProductActionEnvelope(invalid, 200), "forward workspace action");
  invalid["action"]["type"] = "future.action";
  Check(remotekit::ProductActionEnvelope(invalid, 200), "Control owns action semantics");
  for (const auto& type :
       {Json(), Json(1), Json(""), Json("bad type"), Json(std::string(129, 'a'))}) {
    invalid["action"]["type"] = type;
    Check(!remotekit::ProductActionEnvelope(invalid, 200), "reject malformed action type");
  }
  invalid = Action();
  invalid["operationId"] = "not-uuid";
  Check(!remotekit::ProductActionEnvelope(invalid, 200), "reject invalid operation id");
  Check(!remotekit::ProductActionEnvelope(Action(), 65536), "bounded action");
  remotekit::DirectServices services;
  services.Bind(1, "connection");
  Check(!services.Admit(2, Action(), 0), "old peer admission");
  Check(services.Admit(1, Action(), 0), "admit action");
  Check(services.Admit(1, Action(), 0), "duplicate pending action");
  unsigned dispatched = 0;
  services.DispatchPending(1, 1, [&](auto) {
    ++dispatched;
    return true;
  });
  services.DispatchPending(1, 2, [&](auto) {
    ++dispatched;
    return true;
  });
  Check(dispatched == 1, "never blindly replay");
  auto reply = Action();
  reply.erase("action");
  reply["ok"] = true;
  reply["result"] = {{"status", "committed"}};
  Check(!services.Result(2, reply), "old peer result");
  Check(services.Result(1, reply), "route matching result");
  std::vector<Json> sent;
  services.Flush(1, [](auto) { return 6; });
  services.Flush(1, [&](auto bytes) {
    sent.push_back(Json::parse(bytes));
    return 0;
  });
  Check(sent.size() == 1 && sent[0]["type"] == "product.result", "BUSY retains result");
  services.Admit(1, Action(1), 0);
  services.DispatchPending(1, 1, [](auto) { return false; });
  services.Flush(1, [&](auto bytes) {
    sent.push_back(Json::parse(bytes));
    return 0;
  });
  Check(sent.back()["error"]["code"] == "unavailable" &&
            sent.back()["error"]["message"] == "control_unavailable",
        "explicit management disconnect");
  Check(sent.back()["result"]["status"] == "rejected", "never forwarded is explicitly rejected");
  services.Admit(1, Action(2), 0);
  services.DispatchPending(1, 1, [](auto) { return true; });
  services.DispatchPending(1, 15000, [](auto) { return true; });
  services.Flush(1, [&](auto bytes) {
    sent.push_back(Json::parse(bytes));
    return 0;
  });
  Check(sent.back()["error"]["code"] == "outcome_unknown" &&
            sent.back()["error"]["message"] == "control_result_unknown",
        "ambiguous accepted message expires without replay");
  std::ifstream fixture(std::filesystem::path(__FILE__).parent_path() /
                        "fixtures/product-action-timeout.json");
  Check(fixture.good(), "timeout fixture available");
  Json expected;
  fixture >> expected;
  Check(sent.back() == expected, "native timeout wire matches Client semantic fixture");
  auto late = Action(2);
  late["ok"] = true;
  late["result"] = {{"status", "committed"}};
  Check(!services.Result(1, late),
        "late result cannot overwrite already returned uncertain receipt");
  services.DispatchPending(1, 16000, [&](auto) {
    Check(false, "timeout cannot replay operation");
    return true;
  });
  services.Admit(1, Action(3), 0);
  services.DispatchPending(1, 15000, [](auto) {
    Check(false, "expired undispatched operation cannot forward");
    return true;
  });
  services.Flush(1, [&](auto bytes) {
    sent.push_back(Json::parse(bytes));
    return 0;
  });
  Check(sent.back()["result"]["status"] == "rejected" &&
            sent.back()["error"]["code"] == "unavailable" &&
            sent.back()["error"]["message"] == "control_unavailable",
        "undispatched expiration is known failure");
  for (unsigned n = 0; n < 64; ++n)
    Check(services.Admit(1, Action(n), 0), "bounded capacity admission");
  Check(!services.Admit(1, Action(64), 0), "bounded backpressure");
  services.Bind(3);
  Check(!services.Result(3, reply), "replacement discards routing receipts");
  services.Flush(3, [&](auto) {
    Check(false, "old result cannot migrate");
    return 0;
  });
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
  services.Selection(3, frame);
  view.selection_menu.anchor_x = 11;
  services.Selection(3, frame);
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
  services.Selection(3, frame);
  services.Flush(3, [&](auto) {
    Check(false, "unchanged selection not resent");
    return 0;
  });
  services.Selection(3, frame, true);
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
  services.Selection(3, frame);
  sent.clear();
  services.Flush(3, [&](auto bytes) {
    sent.push_back(Json::parse(bytes));
    return 0;
  });
  Check(sent.size() == 1 && sent[0]["revision"] == "4", "refresh republishes selection");
  view.selection_menu = {};
  services.Selection(3, frame);
  sent.clear();
  services.Flush(3, [&](auto bytes) {
    sent.push_back(Json::parse(bytes));
    return 0;
  });
  Check(sent.size() == 1 && sent[0]["menu"].is_null() && sent[0]["revision"] == "5",
        "closing menu clears selection");
  std::cout << "direct services tests passed\n";
}
