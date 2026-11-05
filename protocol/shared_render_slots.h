#pragma once

#include <cstddef>
#include <cstdint>
#include <type_traits>

namespace remotekit {

// Windows cross-process mapping ABI. Neither STL objects nor pointers occur in
// the mapping. Interlocked operations, not C++ process-local atomics, publish it.
inline constexpr std::uint32_t kSharedAtlasSlotCount = 4;
inline constexpr std::uint32_t kSharedAtlasMaxViews = 64;
inline constexpr std::uint32_t kSharedAtlasViewStale = 1;
inline constexpr std::uint32_t kAtlasTextInputActive = 1;
inline constexpr std::uint32_t kAtlasTextInputCaretValid = 2;
inline constexpr std::uint32_t kAtlasTextInputSelectionValid = 4;
inline constexpr std::uint32_t kAtlasTextInputCompositionValid = 8;

struct SharedAtlasTextInput {
  std::uint64_t target_id;
  std::uint32_t type;
  std::uint32_t flags;
  float caret_x, caret_y, caret_width, caret_height;
  std::uint32_t selection_start, selection_end;
  std::uint32_t composition_start, composition_end;
};

enum class SharedAtlasStatus : std::uint32_t {
  kStarting = 0,
  kRunning = 1,
  kStopped = 2,
  kFailed = 4,
};

struct SharedAtlasView {
  std::uint64_t session_id;
  std::uint64_t webview_id;
  std::uint64_t instance_generation;
  std::uint64_t document_generation;
  std::uint64_t focus_generation;
  std::int32_t x_pixels;
  std::int32_t y_pixels;
  std::uint32_t width_pixels;
  std::uint32_t height_pixels;
  // Atlas physical pixels per viewport DIP; used for input/caret conversion.
  float atlas_pixels_per_dip;
  // Actual per-WebView emulated window.devicePixelRatio, independent of atlas.
  float page_device_scale_factor;
  std::uint32_t reserved;
  SharedAtlasTextInput text_input;
};

struct SharedAtlasFrame {
  std::uint64_t generation;
  std::uint64_t frame_id;
  // Producer's actual GPU-copy completion point, also used on consumed fence.
  std::uint64_t ready_fence_value;
  // OSR producer timestamp in Chromium TimeTicks microseconds. This is not a
  // physical presentation time or proof of GPU completion.
  std::int64_t capture_time_us;
  std::uint32_t slot;
  std::uint32_t width_pixels;
  std::uint32_t height_pixels;
  SharedAtlasStatus status;
  std::uint32_t view_count;
  std::uint32_t reserved;
  SharedAtlasView views[kSharedAtlasMaxViews];
};

// Each slot has its own frame snapshot and GPU fence timeline. Metadata is
// descriptive only: reading an even sequence never proves GPU completion.
struct alignas(64) SharedRenderSlot {
  alignas(8) std::int64_t publication_sequence;
  SharedAtlasFrame frame;
};
struct alignas(64) SharedRenderMapping {
  std::uint32_t magic;
  std::uint32_t version;
  std::uint32_t mapping_size;
  std::uint32_t reserved;
  // Global snapshot publishes generation, dimensions, status and latest layout.
  alignas(8) std::int64_t publication_sequence;
  SharedAtlasFrame latest_layout;
  SharedRenderSlot slots[kSharedAtlasSlotCount];
};
inline constexpr std::uint32_t kSharedRenderMagic = 0x524B5253;  // RKRS
inline constexpr std::uint32_t kSharedRenderVersion = 2;
inline constexpr std::uint32_t kRenderSlotCount = kSharedAtlasSlotCount;
using RenderView = SharedAtlasView;
using RenderFrame = SharedAtlasFrame;
static_assert(std::is_trivially_copyable_v<SharedRenderMapping>);
static_assert(offsetof(SharedRenderSlot, publication_sequence) % 8 == 0);
static_assert(offsetof(SharedRenderMapping, publication_sequence) % 8 == 0);
static_assert(offsetof(SharedRenderSlot, frame) == 8);
static_assert(sizeof(SharedAtlasTextInput) == 48);
static_assert(sizeof(SharedAtlasView) == 120);
static_assert(sizeof(SharedAtlasFrame) == 7736);
static_assert(sizeof(SharedRenderSlot) == 7744);
static_assert(offsetof(SharedRenderMapping, latest_layout) == 24);
static_assert(offsetof(SharedRenderMapping, slots) == 7808);
static_assert(sizeof(SharedRenderMapping) == 38784);
// Only consumed_fences[slot] >= value releases that slot. UINT64_MAX means
// device loss, never completion. No other slot's fence value releases it.
}  // namespace remotekit
