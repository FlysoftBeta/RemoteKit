#include "remotekit/browser/view_model.h"

#include "base/check.h"
#include "base/check_op.h"
#include "base/command_line.h"
#include "base/files/file_util.h"
#include <sstream>

namespace {
using namespace remotekit;

void CheckDismissal() {
  ViewModel model;
  auto session = model.CreateSession("dismiss").value;
  auto profile = model.AddProfile(session, "default").value;
  auto view = model.CreateWebView(session, profile).value;
  CHECK(model.SetFocus(session, view, true));
  const auto old = model.Token(session, view).value;
  CHECK(model.CommitDocument(session, view));
  CHECK(model.AcceptInput(session, {old, 1, EditingDismiss{1, 1}}));
  CHECK(!model.AcceptInput(session, {old, 1, EditingDismiss{1, 1}}));
  CHECK(!model.AcceptInput(session, {old, 2, KeyInput{}}));
  CHECK(!model.AcceptInput(session, {old, 2, EditingDismiss{0, 1}}));
  CHECK(model.FindWebView(session, view)->focused);
  CHECK(model.AcceptInput(session, {model.Token(session, view).value, 2,
                                    SelectionCommand{1, SelectionCommand::Command::dismiss}}));
}
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
  CHECK(model.CreateWebView(other.value, profile.value).status.error == ErrorCode::kConflict);
  CHECK(model.CreateWebView(session.value, profile.value, view.value).status.error ==
        ErrorCode::kInvalidRequest);

  const auto token = [&] { return model.Token(session.value, view.value).value; };
  const auto state = [&] { return model.FindWebView(session.value, view.value); };
  CHECK(model.AcceptInput(session.value, {token(), 1, MouseInput{}}));
  CHECK(model.AcceptInput(session.value, {token(), 1, MouseInput{}}).error == ErrorCode::kConflict);
  CHECK(model.AcceptInput(other.value, {token(), 2, MouseInput{}}).error == ErrorCode::kConflict);
  KeyInput key;
  CHECK(model.AcceptInput(session.value, {token(), 2, key}).error == ErrorCode::kConflict);
  CHECK(model.SetFocus(session.value, view.value, true));
  const auto focused = token();
  CHECK(model.AcceptInput(session.value, {focused, 2, key}));

  const auto freeze = model.RequestLifecycle(session.value, view.value, Lifecycle::freeze);
  CHECK(freeze);
  CHECK(state()->desired == Residency::frozen && state()->actual == Residency::live);
  CHECK(token().focus != focused.focus);
  CHECK(model.AcceptInput(session.value, {focused, 3, key}).error == ErrorCode::kConflict);
  CHECK(model.RequestLifecycle(session.value, view.value, Lifecycle::unload).status.error ==
        ErrorCode::kBusy);
  CHECK(model.CommitDocument(session.value, view.value));
  CHECK(model.CompleteLifecycle(session.value, freeze.value, false, "refused"));
  CHECK(state()->actual == Residency::live && state()->desired == Residency::frozen);
  CHECK(!state()->pending && !state()->last_lifecycle->succeeded);
  CHECK(state()->last_lifecycle->detail == "refused");

  const auto retry = model.RequestLifecycle(session.value, view.value, Lifecycle::freeze);
  CHECK(retry);
  CHECK(model.CompleteLifecycle(session.value, freeze.value, true).error == ErrorCode::kConflict);
  CHECK(model.CompleteLifecycle(session.value, retry.value, true));
  CHECK(state()->actual == Residency::frozen);
  const auto before_discard = token();
  const auto discard = model.RequestLifecycle(session.value, view.value, Lifecycle::discard);
  CHECK(discard);
  CHECK(model.CompleteLifecycle(session.value, discard.value, true));
  CHECK(token().instance == before_discard.instance + 1);
  CHECK(token().document == before_discard.document + 1);
  CHECK(model.CommitDocument(session.value, view.value).error == ErrorCode::kConflict);

  const auto restore = model.RequestLifecycle(session.value, view.value, Lifecycle::restore);
  CHECK(restore);
  CHECK(model.InvalidateInstance(session.value, view.value));
  CHECK(model.CompleteLifecycle(session.value, restore.value, true).error == ErrorCode::kConflict);
  CHECK(model.ResetWebView(session.value, view.value));
  CHECK(state()->actual == Residency::live && state()->desired == Residency::live);
  CHECK(!state()->last_lifecycle);
  CHECK(model.AcceptInput(session.value, {token(), 2, MouseInput{}}).error == ErrorCode::kConflict);
  CHECK(model.RemoveWebView(session.value, view.value));
  CHECK(model.Token(session.value, view.value).status.error == ErrorCode::kNotFound);
}

void CheckValidationAndPacking() {
  ImeSet selection{u"\U0001f600", 0, 1};
  CHECK(ValidateInput(selection).error == ErrorCode::kInvalidRequest);
  selection.selection_end = 2;
  CHECK(ValidateInput(selection));
  const auto items = protocol::OrderAtlasItems({{1, 10, 10}, {2, 20, 10}, {3, 20, 10}});
  CHECK(items[0].view == 2 && items[1].view == 3 && items[2].view == 1);
  const auto packed = protocol::PackAtlas(64, 64, 4, items);
  CHECK(packed);
  CHECK(packed.value.placements.size() == 3);
  CHECK(packed.value.placements[0].outer == (protocol::PixelRect{0, 0, 28, 18}));
  CHECK(packed.value.placements[0].content == (protocol::PixelRect{4, 4, 20, 10}));
  CHECK(protocol::PackAtlas(16, 16, 4, items).error == ErrorCode::kLimitExceeded);
}
void CheckAtlasFixtures(const base::FilePath& path) {
  std::string contents;
  CHECK(base::ReadFileToString(path, &contents));
  std::istringstream file(contents);
  std::string line;
  while (std::getline(file, line)) {
    if (line.empty() || line[0] == '#')
      continue;
    std::istringstream row(line);
    std::string name, list;
    float scale;
    unsigned alignment;
    int width, height, physical_width, physical_height;
    CHECK(row >> name >> scale >> alignment >> list >> width >> height >> physical_width >>
          physical_height);
    std::vector<protocol::PackItem> items;
    if (list != "-") {
      std::istringstream parts(list);
      std::string item;
      while (std::getline(parts, item, ',')) {
        const auto separator = item.find('x');
        items.push_back({items.size() + 1, std::stoi(item.substr(0, separator)),
                         std::stoi(item.substr(separator + 1)), 1});
      }
    }
    const auto plan = protocol::PlanAtlas(items, scale, alignment);
    CHECK_EQ(width == 0, !plan) << name;
    if (!plan)
      continue;
    CHECK_EQ(plan->width, width) << name;
    CHECK_EQ(plan->height, height) << name;
    CHECK_EQ(plan->physical.width, static_cast<unsigned>(physical_width)) << name;
    CHECK_EQ(plan->physical.height, static_cast<unsigned>(physical_height)) << name;
    CHECK(protocol::PackAtlas(width, height, 4, protocol::OrderAtlasItems(items))) << name;
  }
}
}  // namespace

int main(int argc, char** argv) {
  base::CommandLine::Init(argc, argv);
  const auto arguments = base::CommandLine::ForCurrentProcess()->GetArgs();
  CHECK_EQ(arguments.size(), 1u);
  CheckAtlasFixtures(base::FilePath(arguments.front()));
  CheckDismissal();
  CheckLifecycleAndInput();
  CheckValidationAndPacking();
}
