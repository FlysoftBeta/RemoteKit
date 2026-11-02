#include "navigation_operations.h"
#include <cstdlib>
#include <iostream>
using remotekit::browser::NavigationOperations;
using Acceptance = NavigationOperations::Acceptance;
void Check(bool value) { if (!value) std::abort(); }
int main() {
  NavigationOperations ledger;
  NavigationOperations::Identity a{"a", "generation", 1}, b{"b", "generation", 2};
  Check(ledger.Accept(a, "navigate\nhttps://one/") == Acceptance::fresh);
  auto* first = ledger.Find(a);
  Check(first->state == "accepted");
  Check(!ledger.Ack(a));
  ledger.Bind(*first, 71, true, true, "https://redirect/");
  Check(first->state == "started" && first->navigation_id == 71);
  Check(ledger.Accept(b, "back\n") == Acceptance::fresh);
  // A newer high water mark does not invalidate a duplicate pending request.
  Check(ledger.Accept(a, "navigate\nhttps://one/") == Acceptance::duplicate);
  Check(ledger.Accept(a, "navigate\nhttps://different/") == Acceptance::conflict);
  Check(ledger.Accept({"a", "generation", 3}, "navigate\nhttps://one/") == Acceptance::conflict);
  ledger.Supersede(&b);
  Check(first->state == "superseded" && ledger.Find(b)->state == "accepted");
  ledger.Complete(*first, 71, "committed");
  Check(first->state == "superseded" && !first->document_committed);
  auto* second = ledger.Find(b);
  // History traversal may affect only subframes. Every returned handle must
  // finish; synchronous completions cannot settle during handle collection.
  ledger.Bind(*second, 81, false, true, "https://iframe/1");
  ledger.Complete(*second, 81, "committed");
  Check(!second->terminal());
  ledger.Bind(*second, 82, false, false, "https://iframe/2");
  ledger.EndCollection(*second);
  Check(!second->terminal() && second->navigation_id == 0);
  Check(ledger.ByNavigation(81) == nullptr);
  ledger.Complete(*second, 82, "committed", {}, true);
  Check(second->state == "committed" && !second->document_committed);
  Check(ledger.Ack(a) && ledger.Ack(a));
  Check(ledger.Accept(a, "navigate\nhttps://one/") == Acceptance::stale);
  Check(ledger.Accept({"new", "another-generation", 1}, "reload\n") == Acceptance::stale);
  NavigationOperations::Identity c{"c", "generation", 3};
  Check(ledger.Accept(c, "navigate\nslow") == Acceptance::fresh);
  auto* third = ledger.Find(c);
  ledger.Bind(*third, 91, true, false, "slow");
  ledger.EndCollection(*third);
  ledger.Complete(*third, 91, "cancelled", "beforeunload_cancelled");
  Check(third->state == "cancelled");
  ledger.Complete(*third, 91, "committed", {}, true);
  Check(third->state == "cancelled" && !third->document_committed);
  NavigationOperations::Identity d{"d", "generation", 4};
  Check(ledger.Accept(d, "navigate\nerror") == Acceptance::fresh);
  auto* error_page = ledger.Find(d);
  ledger.Bind(*error_page, 101, true, true, "https://unreachable/");
  ledger.EndCollection(*error_page);
  ledger.Complete(*error_page, 101, "failed", "ERR_CONNECTION_REFUSED", true, true);
  Check(error_page->state == "failed" && error_page->document_committed && error_page->is_error_page);
  ledger.Complete(*error_page, 101, "committed", {}, false, false);
  Check(error_page->state == "failed" && error_page->document_committed && error_page->is_error_page);
  NavigationOperations::Identity e{"e", "generation", 5};
  Check(ledger.Accept(e, "navigate\nprovisional") == Acceptance::fresh);
  auto* provisional = ledger.Find(e);
  ledger.Bind(*provisional, 111, true, true, "https://provisional/");
  ledger.EndCollection(*provisional);
  ledger.Complete(*provisional, 111, "failed", "ERR_FAILED");
  Check(provisional->state == "failed" && !provisional->document_committed && !provisional->is_error_page);
  NavigationOperations::Identity f{"f", "generation", 6};
  Check(ledger.Accept(f, "back\n") == Acceptance::fresh);
  auto* mixed = ledger.Find(f);
  // A primary finish can be synchronous, before controller return finishes
  // collecting the history traversal's iframe handles.
  ledger.Bind(*mixed, 121, true, true, "https://primary/");
  ledger.Complete(*mixed, 121, "committed", {}, true);
  Check(!mixed->terminal() && mixed->document_committed);
  ledger.Bind(*mixed, 121, true, false, "https://primary/");
  ledger.Bind(*mixed, 122, false, true, "https://iframe/");
  ledger.EndCollection(*mixed);
  ledger.Complete(*mixed, 122, "failed", "ERR_CONNECTION_REFUSED", true, true);
  Check(mixed->state == "failed" && mixed->document_committed && !mixed->is_error_page);
  // Preserve deduplication/high water while replacing a WebContents adapter.
  auto moved = std::move(ledger);
  Check(moved.Accept(c, "navigate\nslow") == Acceptance::duplicate);
  Check(moved.Ack(c));
  Check(moved.Accept(c, "navigate\nslow") == Acceptance::stale);
  NavigationOperations bounded;
  for (std::uint64_t n = 1; n <= 128; ++n)
    Check(bounded.Accept({std::to_string(n), "g", n}, "navigate") == Acceptance::fresh);
  Check(bounded.Accept({"129", "g", 129}, "navigate") == Acceptance::full);
  Check(!bounded.Ack({"1", "g", 1}));
  auto* oldest = bounded.Find({"1", "g", 1});
  bounded.Finish(*oldest, "failed", "network_error");
  Check(bounded.Ack({"1", "g", 1}));
  Check(bounded.Accept({"129", "g", 129}, "navigate") == Acceptance::fresh);
  Check(bounded.Accept({"1", "g", 1}, "navigate") == Acceptance::stale);
  std::cout << "navigation operations state machine passed\n";
}
