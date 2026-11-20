#include "media/render_slots.hpp"
#include "session/browser_rpc.hpp"
#include "util/file_io.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <thread>
using namespace remotekit;
using namespace remotekit::media;
namespace {
void Check(bool value, const char* message) {
  if (!value)
    throw std::runtime_error(message);
}
template <class T>
T Take(Result<T> value) {
  if (!value)
    throw std::runtime_error(value.error().message);
  return std::move(value).value();
}
void Take(Result<void> value) {
  if (!value)
    throw std::runtime_error(value.error().message);
}
Json View(const char* id, int width, int height) {
  return {{"session", "1"},   {"view", id},          {"width", width},
          {"height", height}, {"device", "desktop"}, {"device_scale_factor", 1},
          {"visible", true},  {"occludedBottom", 0}, {"occlusionRevision", "0"}};
}
class Consumer {
 public:
  Sdk sdk;
  BrowserRpc rpc{sdk};
  FrameAdmission admission;
  RenderSlots slots{admission};
  ComPtr<ID3D11Device5> device;
  ComPtr<ID3D11DeviceContext4> context;
  uint32_t pid;
  Json transcript = Json::array();
  void Open() {
    remotekit_sdk_render_setup setup{};
    setup.struct_size = sizeof(setup);
    Take(rpc.OpenRender(setup));
    LUID luid{setup.adapter_luid_low, setup.adapter_luid_high};
    std::string diagnostic;
    if (!device)
      Check(CreateDevice(&luid, device, context, diagnostic), diagnostic.c_str());
    Take(slots.Open(setup, pid, sdk, luid, device.Get(), context.Get(), diagnostic));
  }
  Json Request(Json command) {
    auto reply = Take(rpc.Request(command));
    transcript.push_back({{"request", std::move(command)}, {"reply", reply}});
    return reply;
  }
  Json Configure(const char* view, int width, int height, int scale = 1) {
    return Request({{"method", "output.configure"},
                    {"width", width + 8},
                    {"height", height + 8},
                    {"device_scale", scale},
                    {"allocation_alignment", 16},
                    {"outputWidthPixels", scale == 1 ? 656 : 1616},
                    {"outputHeightPixels", scale == 1 ? 496 : 1216},
                    {"viewConfigs", Json::array({View(view, width, height)})}});
  }
  bool Pixel(const remotekit_rtc_frame& frame, const SharedAtlasView& view, bool white) {
    auto* source = static_cast<ID3D11Texture2D*>(frame.d3d11_texture);
    D3D11_TEXTURE2D_DESC desc{};
    source->GetDesc(&desc);
    desc.Usage = D3D11_USAGE_STAGING;
    desc.BindFlags = 0;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    desc.MiscFlags = 0;
    ComPtr<ID3D11Texture2D> staging;
    Check(SUCCEEDED(device->CreateTexture2D(&desc, nullptr, &staging)), "readback allocation");
    context->CopyResource(staging.Get(), source);
    D3D11_MAPPED_SUBRESOURCE mapped{};
    Check(SUCCEEDED(context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped)), "readback map");
    const auto x = view.x_pixels + view.width_pixels / 2;
    const auto y = view.y_pixels + view.height_pixels * 9 / 10;
    const auto* pixel = static_cast<const uint8_t*>(mapped.pData) + y * mapped.RowPitch + x * 4;
    const bool matched = white ? pixel[0] == 255 && pixel[1] == 255 && pixel[2] == 255
                               : pixel[0] == 60 && pixel[1] == 40 && pixel[2] == 20;
    context->Unmap(staging.Get(), 0);
    return matched;
  }
  void Frame(uint32_t revision,
             uint64_t view,
             uint64_t occlusion,
             bool white,
             ID3D11Texture2D** retained_texture = nullptr) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(15);
    for (;;) {
      remotekit_rtc_frame frame{};
      SharedAtlasFrame metadata{};
      std::string error;
      const auto result = slots.Poll(frame, metadata, error);
      Check(result != RenderSlots::Result::error, error.c_str());
      if (result == RenderSlots::Result::ready) {
        const bool identity = metadata.layout_revision == revision && metadata.view_count == 1 &&
                              metadata.views[0].webview_id == view &&
                              metadata.views[0].occlusion_revision == occlusion;
        const bool matches = identity && Pixel(frame, metadata.views[0], white);
        if (matches && retained_texture) {
          auto* texture = static_cast<ID3D11Texture2D*>(frame.d3d11_texture);
          Check(!*retained_texture || *retained_texture == texture,
                "shared output texture replaced");
          *retained_texture = texture;
        }
        frame.release(frame.release_context, frame.frame_id);
        if (matches) {
          transcript.push_back({{"frame", metadata.frame_id},
                                {"layoutRevision", revision},
                                {"view", view},
                                {"occlusionRevision", occlusion}});
          return;
        }
      }
      Check(std::chrono::steady_clock::now() < deadline, "matching pixels unavailable");
      Check(slots.Begin(1000000, true, error), error.c_str());
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
  }
  void CloseOutput() {
    std::string error;
    Check(slots.Close(error), error.c_str());
    Request({{"method", "output.close"}});
  }
};
}  // namespace
int wmain(int argc, wchar_t** argv) try {
  Check(argc == 5, "SDK, channel, Browser PID and evidence path required");
  Consumer consumer;
  consumer.pid = std::stoul(argv[3]);
  Take(consumer.sdk.Open(argv[1]));
  const std::string channel_text = Utf8(fs::path(argv[2]));
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(15);
  while (!consumer.rpc.Connect(channel_text)) {
    Check(std::chrono::steady_clock::now() < deadline, "Browser control unavailable");
    std::this_thread::sleep_for(std::chrono::milliseconds(25));
  }
  for (const auto* view : {"1", "2"})
    consumer.Request({{"method", "view.create"},
                      {"session", "1"},
                      {"view", view},
                      {"url", "data:text/html,<style>html{background:rgb(20,40,60)}</style>"},
                      {"width", 640},
                      {"height", 480},
                      {"visible", false},
                      {"device", "desktop"}});
  const auto initial = consumer.Configure("1", 640, 480);
  consumer.Open();
  const auto generation = consumer.slots.Generation();
  ID3D11Texture2D* texture = nullptr;
  consumer.Frame(initial.at("layoutRevision"), 1, 0, false, &texture);
  const auto resized = consumer.Configure("1", 800, 600);
  Check(consumer.slots.Generation() == generation, "resize reopened output");
  consumer.Frame(resized.at("layoutRevision"), 1, 0, false, &texture);
  const auto switched = consumer.Configure("2", 800, 600);
  consumer.Frame(switched.at("layoutRevision"), 2, 0, false, &texture);
  consumer.Request({{"method", "view.configure"},
                    {"session", "1"},
                    {"view", "2"},
                    {"outputGeneration", std::to_string(generation)},
                    {"occludedBottom", 200},
                    {"occlusionRevision", "2"}});
  consumer.Frame(switched.at("layoutRevision"), 2, 2, true, &texture);
  const auto superseded = consumer.Request({{"method", "view.configure"},
                                            {"session", "1"},
                                            {"view", "2"},
                                            {"outputGeneration", std::to_string(generation)},
                                            {"occludedBottom", 100},
                                            {"occlusionRevision", "1"}});
  Check(superseded.at("superseded"), "older viewport revision not classified as superseded");
  auto rejected = consumer.rpc.Request({{"method", "output.configure"},
                                        {"width", 808},
                                        {"height", 608},
                                        {"device_scale", 2},
                                        {"outputWidthPixels", 1616},
                                        {"outputHeightPixels", 1216}});
  Check(!rejected && rejected.error().code == ErrorCode::kConflict, "live extent change accepted");
  consumer.CloseOutput();
  const auto scaled = consumer.Configure("2", 800, 600, 2);
  consumer.Open();
  Check(consumer.slots.Generation() != generation, "extent change retained old generation");
  consumer.Frame(scaled.at("layoutRevision"), 2, 2, true);
  consumer.CloseOutput();
  std::ofstream evidence(fs::path(argv[4]), std::ios::binary);
  evidence << consumer.transcript.dump(2);
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
