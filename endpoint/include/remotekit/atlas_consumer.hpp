#pragma once

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include "remotekit/shared_render_slots.h"

namespace remotekit {

// Open takes ownership of every non-null handle, including on failure.
struct AtlasConsumerSetup {
  HANDLE mapping = nullptr;
  std::array<HANDLE, kRenderSlotCount> ready_fences{};
  std::array<HANDLE, kRenderSlotCount> consumed_fences{};
  std::array<HANDLE, kRenderSlotCount> textures{};
  LUID adapter_luid{};
  std::uint64_t generation = 0;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
};

struct AtlasContentRect {
  int left = 0;
  int top = 0;
  int right = 0;
  int bottom = 0;
};

enum class AtlasPollResult { idle, presented, error };

class AtlasConsumer {
 public:
  // Call all methods from the HWND-owning thread; the class is not thread-safe.
  AtlasConsumer();
  ~AtlasConsumer();
  AtlasConsumer(const AtlasConsumer&) = delete;
  AtlasConsumer& operator=(const AtlasConsumer&) = delete;

  bool Open(HWND window, AtlasConsumerSetup setup);
  AtlasPollResult PollAndPresent();
  // Demo intentionally uses only slot zero, with one bounded request at a time.
  bool Begin(std::uint64_t value);
  void Reject(std::uint64_t value);
  std::uint64_t ReadyValue() const;
  std::uint64_t ConsumedValue() const;
  bool Resize();
  void RequestRepaint();
  AtlasContentRect GetContentRect() const;
  SharedAtlasFrame GetLastFrame() const;
  const std::wstring& LastError() const;
  // Waits at most 250 ms for outstanding GPU reads. On timeout resources remain
  // owned and further work is rejected; retry Close after tearing down producer.
  bool Close();

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace remotekit
#endif
