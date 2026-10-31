#include <cstdlib>
#include <iostream>
#include <limits>
#include "remotekit/core.hpp"
using namespace remotekit;
#define CHECK(x)                                                       \
  do {                                                                 \
    if (!(x)) {                                                        \
      std::cerr << __FILE__ << ':' << __LINE__ << " failed: " #x "\n"; \
      std::exit(1);                                                    \
    }                                                                  \
  } while (false)
static bool Overlap(const PixelRect& a, const PixelRect& b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
int main() {
  Endpoint e;
  auto s = e.CreateSession("tenant-a");
  auto b = e.CreateSession("tenant-b");
  CHECK(s && b);
  CHECK(!e.CreateSession("tenant-a"));
  CHECK(!e.CreateSession(""));
  auto p = e.AddProfile(s.value, "default");
  auto pb = e.AddProfile(b.value, "default");
  CHECK(p && pb);
  CHECK(e.AddProfile(s.value, "second").status.error == Error::unsupported);
  CHECK(e.CreateWebView(b.value, p.value).status.error == Error::wrong_session);
  auto v = e.CreateWebView(s.value, p.value);
  auto v2 = e.CreateWebView(s.value, p.value);
  CHECK(v && v2);
  CHECK(!e.FindWebView(b.value, v.value));
  CHECK(!e.SetFocus(b.value, v.value, true));
  CHECK(e.SetFocus(s.value, v.value, true));
  InputEvent input{e.Token(s.value, v.value).value, 1, KeyInput{}};
  CHECK(e.AcceptInput(b.value, input).error == Error::wrong_session);
  CHECK(e.AcceptInput(s.value, input));
  CHECK(e.AcceptInput(s.value, input).error == Error::stale);
  ++input.sequence;
  CHECK(e.CommitDocument(s.value, v.value));
  CHECK(e.AcceptInput(s.value, input).error == Error::stale);
  input.token = e.Token(s.value, v.value).value;
  CHECK(e.AcceptInput(s.value, input));
  CHECK(e.SetFocus(s.value, v2.value, true));
  ++input.sequence;
  CHECK(e.AcceptInput(s.value, input).error == Error::stale);
  CHECK(e.SetFocus(s.value, v.value, true));
  auto freeze = e.RequestLifecycle(s.value, v.value, Lifecycle::freeze);
  CHECK(freeze);
  auto state = e.FindWebView(s.value, v.value);
  CHECK(state->actual == Residency::live && state->desired == Residency::frozen && state->pending);
  CHECK(e.RequestLifecycle(s.value, v.value, Lifecycle::unload).status.error == Error::busy);
  CHECK(!e.AcceptInput(s.value, {e.Token(s.value, v.value).value, 4, KeyInput{}}));
  CHECK(!e.CompleteLifecycle(b.value, freeze.value, true));
  CHECK(e.CompleteLifecycle(s.value, freeze.value, true));
  CHECK(e.FindWebView(s.value, v.value)->actual == Residency::frozen);
  CHECK(e.CompleteLifecycle(s.value, freeze.value, true).error == Error::stale);
  auto restore = e.RequestLifecycle(s.value, v.value, Lifecycle::restore);
  CHECK(restore);
  CHECK(e.CompleteLifecycle(s.value, restore.value, false));
  CHECK(e.FindWebView(s.value, v.value)->desired == Residency::live &&
        e.FindWebView(s.value, v.value)->actual == Residency::frozen);
  restore = e.RequestLifecycle(s.value, v.value, Lifecycle::restore);
  CHECK(e.CompleteLifecycle(s.value, restore.value, true));
  auto before = e.Token(s.value, v.value).value;
  auto discard = e.RequestLifecycle(s.value, v.value, Lifecycle::discard);
  CHECK(discard);
  CHECK(e.CompleteLifecycle(s.value, discard.value, true));
  CHECK(e.FindWebView(s.value, v.value)->profile == p.value);
  CHECK(e.Token(s.value, v.value).value.instance > before.instance);
  restore = e.RequestLifecycle(s.value, v.value, Lifecycle::restore);
  CHECK(e.CompleteLifecycle(s.value, restore.value, true));
  auto unload = e.RequestLifecycle(s.value, v.value, Lifecycle::unload);
  CHECK(unload);
  CHECK(e.CompleteLifecycle(s.value, unload.value, true));
  CHECK(e.FindWebView(s.value, v.value)->actual == Residency::unloaded);
  const auto first_unload_token = e.Token(s.value, v.value).value;
  auto repeated_unload = e.RequestLifecycle(s.value, v.value, Lifecycle::unload);
  CHECK(repeated_unload);
  CHECK(e.CompleteLifecycle(s.value, repeated_unload.value, true));
  CHECK(e.FindWebView(s.value, v.value)->desired == Residency::unloaded);
  CHECK(e.Token(s.value, v.value).value.instance > first_unload_token.instance);
  CHECK(e.AcceptInput(s.value, {first_unload_token, 99, KeyInput{}}).error == Error::stale);
  const auto unloaded_token = e.Token(s.value, v.value).value;
  CHECK(e.InvalidateInstance(s.value, v.value));
  CHECK(e.Token(s.value, v.value).value.instance > unloaded_token.instance);
  CHECK(e.FindWebView(s.value, v.value)->actual == Residency::unloaded);
  CHECK(!e.RequestLifecycle(s.value, v.value, Lifecycle::freeze));
  restore = e.RequestLifecycle(s.value, v.value, Lifecycle::restore);
  CHECK(e.CompleteLifecycle(s.value, restore.value, true));
  CHECK(e.SetFocus(s.value, v.value, true));
  CHECK(e.AcceptInput(s.value, {before, 8, KeyInput{}}).error == Error::stale);
  auto pending_crash = e.RequestLifecycle(s.value, v.value, Lifecycle::freeze);
  CHECK(pending_crash);
  const auto crash_token = e.Token(s.value, v.value).value;
  CHECK(e.InvalidateInstance(s.value, v.value));
  CHECK(e.Token(s.value, v.value).value.instance > crash_token.instance);
  CHECK(!e.FindWebView(s.value, v.value)->pending && !e.FindWebView(s.value, v.value)->focused);
  CHECK(e.CompleteLifecycle(s.value, pending_crash.value, true).error == Error::stale);
  CHECK(e.SetFocus(s.value, v.value, true));
  KeyInput unicode_key;
  unicode_key.text = u"\U0001f600";
  CHECK(ValidateInput(unicode_key));
  unicode_key.text = u"abcde";
  CHECK(!ValidateInput(unicode_key));
  unicode_key.text = std::u16string(1, 0xd800);
  CHECK(!ValidateInput(unicode_key));

  CHECK(ValidateInput(ImeSet{u"A\U0001f600中", 1, 3}));
  CHECK(!ValidateInput(ImeSet{u"A\U0001f600中", 2, 3}));
  CHECK(!ValidateInput(ImeSet{u"abc", 3, 2}));
  CHECK(!ValidateInput(ImeSet{u"abc", 0, 4}));
  CHECK(!ValidateInput(ImeCommit{std::u16string(1, 0xd800)}));
  CHECK(!ValidateInput(ImeCommit{std::u16string(1, 0xdc00)}));
  CHECK(ValidateInput(ImeCommit{u"你好\U0001f600"}));
  CHECK(ValidateInput(ImeCancel{}));
  CHECK(ValidateInput(ImeFinish{}));
  CHECK(!ValidateInput(TouchInput{TouchInput::Action::start, {{1, 1, 1, .5}, {1, 2, 2, .5}}}));
  CHECK(!ValidateInput(WheelInput{0, 0, std::numeric_limits<double>::infinity(), 0, 0}));
  auto fresh = e.Token(s.value, v.value).value;
  CHECK(!e.AcceptInput(s.value, {fresh, 20, ImeSet{u"abc", 0, 9}}));
  CHECK(e.AcceptInput(s.value,
                      {fresh, 20, ImeCommit{u"abc"}}));  // Invalid input did not consume sequence.

  std::vector<PackItem> items{{1, 60, 40, 2}, {2, 40, 70, 1}, {3, 20, 20, 1.5}, {4, 12, 18, 1}};
  auto atlas = PackAtlas(160, 128, 2, items);
  CHECK(atlas);
  auto again = PackAtlas(160, 128, 2, items);
  CHECK(again && again.value.placements.size() == items.size());
  for (std::size_t i = 0; i < atlas.value.placements.size(); ++i) {
    auto a = atlas.value.placements[i];
    CHECK(a.outer == again.value.placements[i].outer);
    CHECK(a.outer.x >= 0 && a.outer.y >= 0 && a.outer.x + a.outer.width <= 160 &&
          a.outer.y + a.outer.height <= 128);
    for (std::size_t j = 0; j < i; ++j)
      CHECK(!Overlap(a.outer, atlas.value.placements[j].outer));
    auto pixel = atlas.value.DipToPixel(a.view, 2, 3);
    CHECK(pixel);
    auto hit = atlas.value.HitTest(pixel.value.first, pixel.value.second);
    CHECK(hit && hit->view == a.view && hit->dip_x == 2 && hit->dip_y == 3);
    CHECK(!atlas.value.HitTest(a.outer.x, a.outer.y));
  }
  CHECK(!atlas.value.HitTest(-1, 2));
  CHECK(!atlas.value.DipToPixel(1, 30, 0));
  CHECK(PackAtlas(10, 10, 0, {{1, 11, 1, 1}}).status.error == Error::no_space);
  CHECK(PackAtlas(10, 10, 1, {{1, 9, 9, 1}}).status.error == Error::no_space);
  CHECK(!PackAtlas(10, 10, 0, {{1, 6, 10, 1}, {2, 6, 10, 1}}));
  CHECK(!PackAtlas(10, 10, 0, {{1, 1, 1, 1}, {1, 1, 1, 1}}));
  CHECK(!PackAtlas(10, 10, 0, {{1, 1, 1, 0}}));
  CHECK(!PackAtlas(10, 10, std::numeric_limits<int>::max(), {{1, 1, 1, 1}}));
  // Many deterministic layouts exercise MaxRects splitting and pruning.
  for (int n = 1; n <= 40; ++n) {
    std::vector<PackItem> small;
    for (int i = 0; i < n; ++i)
      small.push_back({static_cast<WebViewId>(i + 1), 3 + (i * 7) % 19, 3 + (i * 11) % 17, 1});
    auto packed = PackAtlas(256, 256, 1, small);
    CHECK(packed);
    for (std::size_t i = 0; i < packed.value.placements.size(); ++i)
      for (std::size_t j = 0; j < i; ++j)
        CHECK(!Overlap(packed.value.placements[i].outer, packed.value.placements[j].outer));
  }
  std::cout << "endpoint core tests passed\n";
}
