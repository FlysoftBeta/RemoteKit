#include "session/presentation.hpp"
#include "rtc/data_router.hpp"
#include <cmath>
namespace remotekit {
void PresentationController::QueueLayout(const Json& mode) {
  std::lock_guard lock(mutex_);
  const Json selected_mode =
      mode.is_null() && video_requested_
          ? Json{{"type", "presentation.mode"}, {"version", 1}, {"backend", "video"}}
          : mode;
  Json prepare;
  if (layout_prepare && !layout.empty()) {
    const auto& key = *layout_prepare;
    prepare = {{"type", "presentation.prepare"},
               {"version", 1},
               {"barrierId", std::to_string(key.barrier)},
               {"outputGeneration", std::to_string(key.generation)},
               {"layoutEpoch", std::to_string(key.epoch)}};
  }
  hooks_.outbox().Replace(hooks_.scope(),
                          selected_mode.is_null() ? std::string() : selected_mode.dump(),
                          layout.empty() ? std::string() : layout.dump(),
                          prepare.is_null() ? std::string() : prepare.dump());
  hooks_.flush();
}

bool PresentationController::PresentationMessage(const Event& event) {
  std::lock_guard lock(mutex_);
  const auto message = event.message;
  if (!message.is_object())
    return false;
  const auto type = message.value("type", Json());
  if (type != "media.presentation" && type != "presentation.ready")
    return false;
  if (event.bytes.size() > 512 || message.value("version", Json()) != 1)
    return true;
  if (type == "media.presentation") {
    if (message.value("backend", Json()) != "video")
      return true;
    video_requested_ = true;
    const bool restart = hooks_.admitted(event) && message.value("restart", Json()) == true;
    layout_prepare = barrier_.Video(event.peer, restart);
    if (restart) {
      hooks_.reset_input();
      hooks_.outbox().Bind(hooks_.scope());
      hooks_.refresh();
    }
    // Mode() installs the gate before any video support confirmation leaves.
    QueueLayout({{"type", "presentation.mode"}, {"version", 1}, {"backend", "video"}});
  } else {
    remotekit::PresentationBarrier::Key key;
    if (DataRouter::Number(message, "barrierId", key.barrier) &&
        DataRouter::Number(message, "outputGeneration", key.generation) &&
        DataRouter::Number(message, "layoutEpoch", key.epoch) && barrier_.Ready(event.peer, key)) {
      layout_prepare.reset();
      hooks_.refresh();
    }
  }
  return true;
}

void PresentationController::PublishLayout(Json next, uint64_t epoch) {
  std::lock_guard lock(mutex_);
  // Serialize replacement with the last encoded publication, including old
  // hardware jobs already in flight. Metadata is sent only after gate closure.
  const auto prepare =
      barrier_.Layout(std::stoull(next.at("generation").get<std::string>()), epoch);
  std::map<std::string, bool> ready;
  std::set<std::string> feedback_views;
  for (const auto& view : next.at("views"))
    feedback_views.insert(view.at("id").get<std::string>());
  media_feedback.Bind(hooks_.peer(), next.at("epoch").get<std::string>(),
                      next.at("generation").get<std::string>(), std::move(feedback_views));
  for (const auto& view : next.at("views"))
    ready[view.at("id").get<std::string>()] = !view.value("stale", false);
  coordinate_readiness.Set(epoch, std::move(ready));
  // Layout() returns no new key for an identical epoch. Preserve the current
  // key so a repeated transaction retries the same idempotent barrier.
  if (prepare)
    layout_prepare = prepare;
  if (next.at("generation") != "0" && !layout.empty() && layout.value("reconfiguring", false))
    hooks_.refresh_editable();
  layout = std::move(next);
  QueueLayout();
}

void PresentationController::InvalidateLayout(const char* reason) {
  std::lock_guard lock(mutex_);
  current_geometry = std::string("invalid:") + reason;
  const auto epoch = layout_epoch.fetch_add(1) + 1;
  Json invalid = {{"type", "layout"},
                  {"generation", "0"},
                  {"width", 16},
                  {"height", 16},
                  {"mediaScale", 1},
                  {"views", Json::array()},
                  {"epoch", std::to_string(epoch)}};
  if (std::string_view(reason) == "reconfigure")
    invalid["reconfiguring"] = true;
  hooks_.refresh_editable();
  PublishLayout(std::move(invalid), epoch);
}

Json PresentationController::Layout(const remotekit::SharedAtlasFrame& frame) {
  std::lock_guard lock(mutex_);
  auto fit = hooks_.sampling();
  if (!fit.width)
    fit = {frame.width_pixels, frame.height_pixels, 1};
  const double sx = double(fit.width) / frame.width_pixels,
               sy = double(fit.height) / frame.height_pixels;
  Json views = Json::array();
  for (uint32_t i = 0; i < frame.view_count; ++i) {
    auto& v = frame.views[i];
    views.push_back(
        {{"id", std::to_string(v.webview_id)},
         {"session", std::to_string(v.session_id)},
         {"instance", std::to_string(v.instance_generation)},
         {"document", std::to_string(v.document_generation)},
         {"focus", std::to_string(v.focus_generation)},
         {"x", std::lround(v.x_pixels * sx)},
         {"y", std::lround(v.y_pixels * sy)},
         {"width", std::lround((v.x_pixels + v.width_pixels) * sx) - std::lround(v.x_pixels * sx)},
         {"height",
          std::lround((v.y_pixels + v.height_pixels) * sy) - std::lround(v.y_pixels * sy)},
         {"deviceScaleFactor", v.page_device_scale_factor},
         {"mediaScale", fit.scale * v.atlas_pixels_per_dip / v.page_device_scale_factor},
         {"mediaScaleX", sx * v.atlas_pixels_per_dip / v.page_device_scale_factor},
         {"mediaScaleY", sy * v.atlas_pixels_per_dip / v.page_device_scale_factor},
         {"stale", (v.reserved & remotekit::kSharedAtlasViewStale) != 0}});
  }
  return {{"type", "layout"},        {"generation", std::to_string(frame.generation)},
          {"width", fit.width},      {"height", fit.height},
          {"mediaScale", fit.scale}, {"mediaScaleX", sx},
          {"mediaScaleY", sy},       {"views", views}};
}

std::string PresentationController::GeometryKey(const remotekit::SharedAtlasFrame& frame) {
  std::lock_guard lock(mutex_);
  auto value = Layout(frame);
  for (auto& view : value["views"])
    view.erase("focus");
  return value.dump();
}

uint64_t PresentationController::ObserveLayout(const remotekit::SharedAtlasFrame& frame) {
  std::lock_guard lock(mutex_);
  const auto key = GeometryKey(frame);
  if (key != current_geometry) {
    current_geometry = key;
    layout_epoch.fetch_add(1);
  }
  return layout_epoch.load();
}

void PresentationController::Bind(uint64_t peer) {
  std::lock_guard lock(mutex_);
  barrier_.Bind(peer);
  layout_prepare.reset();
  layout = Json();
  video_requested_ = false;
  current_geometry.clear();
  media_feedback.Bind(0, "", "");
  coordinate_readiness.Set(layout_epoch.load(), {});
}
Json PresentationController::Snapshot() const {
  std::lock_guard lock(mutex_);
  return layout;
}
bool PresentationController::IsInvalid(std::string_view reason) const {
  std::lock_guard lock(mutex_);
  return current_geometry == std::string("invalid:") + std::string(reason);
}
}  // namespace remotekit
