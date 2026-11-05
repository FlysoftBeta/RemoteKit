#include "remotekit/browser/view_model.h"

#include "base/check.h"

namespace {
using namespace remotekit;

void CheckLifecycleAndInput() {
  ViewModel model;
  const auto session = model.CreateSession("tenant", 42);
  CHECK(session);
  const auto profile = model.AddProfile(session.value, "default");
  CHECK(profile);
  const auto view = model.CreateWebView(session.value, profile.value, 99);
  CHECK(view);
  const auto other = model.CreateSession("other");
  CHECK(other);
  CHECK(model.CreateWebView(other.value, profile.value).status.error == ErrorCode::stale_identity);
  CHECK(model.CreateWebView(session.value, profile.value, view.value).status.error ==
        ErrorCode::invalid_request);

  const auto token = [&] { return model.Token(session.value, view.value).value; };
  const auto state = [&] { return model.FindWebView(session.value, view.value); };
  CHECK(model.AcceptInput(session.value, {token(), 1, MouseInput{}}));
  CHECK(model.AcceptInput(session.value, {token(), 1, MouseInput{}}).error ==
        ErrorCode::stale_identity);
  CHECK(model.AcceptInput(other.value, {token(), 2, MouseInput{}}).error ==
        ErrorCode::stale_identity);
  KeyInput key;
  CHECK(model.AcceptInput(session.value, {token(), 2, key}).error == ErrorCode::unavailable);
  CHECK(model.SetFocus(session.value, view.value, true));
  const auto focused = token();
  CHECK(model.AcceptInput(session.value, {focused, 2, key}));

  const auto freeze = model.RequestLifecycle(session.value, view.value, Lifecycle::freeze);
  CHECK(freeze);
  CHECK(state()->desired == Residency::frozen && state()->actual == Residency::live);
  CHECK(token().focus != focused.focus);
  CHECK(model.AcceptInput(session.value, {focused, 3, key}).error == ErrorCode::stale_identity);
  CHECK(model.RequestLifecycle(session.value, view.value, Lifecycle::unload).status.error ==
        ErrorCode::busy);
  CHECK(model.CommitDocument(session.value, view.value));
  CHECK(model.CompleteLifecycle(session.value, freeze.value, false, "refused"));
  CHECK(state()->actual == Residency::live && state()->desired == Residency::frozen);
  CHECK(!state()->pending && !state()->last_lifecycle->succeeded);
  CHECK(state()->last_lifecycle->detail == "refused");

  const auto retry = model.RequestLifecycle(session.value, view.value, Lifecycle::freeze);
  CHECK(retry);
  CHECK(model.CompleteLifecycle(session.value, freeze.value, true).error ==
        ErrorCode::stale_identity);
  CHECK(model.CompleteLifecycle(session.value, retry.value, true));
  CHECK(state()->actual == Residency::frozen);
  const auto before_discard = token();
  const auto discard = model.RequestLifecycle(session.value, view.value, Lifecycle::discard);
  CHECK(discard);
  CHECK(model.CompleteLifecycle(session.value, discard.value, true));
  CHECK(token().instance == before_discard.instance + 1);
  CHECK(token().document == before_discard.document + 1);
  CHECK(model.CommitDocument(session.value, view.value).error == ErrorCode::unavailable);

  const auto restore = model.RequestLifecycle(session.value, view.value, Lifecycle::restore);
  CHECK(restore);
  CHECK(model.InvalidateInstance(session.value, view.value));
  CHECK(model.CompleteLifecycle(session.value, restore.value, true).error ==
        ErrorCode::stale_identity);
  CHECK(model.ResetWebView(session.value, view.value));
  CHECK(state()->actual == Residency::live && state()->desired == Residency::live);
  CHECK(!state()->last_lifecycle);
  CHECK(model.AcceptInput(session.value, {token(), 2, MouseInput{}}).error ==
        ErrorCode::stale_identity);
  CHECK(model.RemoveWebView(session.value, view.value));
  CHECK(model.Token(session.value, view.value).status.error == ErrorCode::not_found);
}

void CheckValidationAndPacking() {
  ImeSet selection{u"\U0001f600", 0, 1};
  CHECK(ValidateInput(selection).error == ErrorCode::invalid_request);
  selection.selection_end = 2;
  CHECK(ValidateInput(selection));
  const auto items = OrderAtlasItems({{1, 10, 10}, {2, 20, 10}, {3, 20, 10}});
  CHECK(items[0].view == 2 && items[1].view == 3 && items[2].view == 1);
  const auto packed = PackAtlas(64, 64, 4, items);
  CHECK(packed);
  CHECK(packed.value.placements.size() == 3);
  CHECK(packed.value.placements[0].outer == (PixelRect{0, 0, 28, 18}));
  CHECK(packed.value.placements[0].content == (PixelRect{4, 4, 20, 10}));
  CHECK(PackAtlas(16, 16, 4, items).status.error == ErrorCode::resource_limit);
}
}  // namespace

int main() {
  CheckLifecycleAndInput();
  CheckValidationAndPacking();
}
