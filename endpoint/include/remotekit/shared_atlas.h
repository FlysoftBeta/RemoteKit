#pragma once

#include <cstddef>
#include <cstdint>
#include <type_traits>

namespace remotekit {

// Windows cross-process mapping ABI. Neither STL objects nor pointers occur in
// the mapping. Interlocked operations, not C++ process-local atomics, publish it.
inline constexpr std::uint32_t kSharedAtlasMagic = 0x524B4154;  // RKAT
inline constexpr std::uint32_t kSharedAtlasVersion = 2;
inline constexpr std::uint32_t kSharedAtlasSlotCount = 3;
inline constexpr std::uint32_t kSharedAtlasMaxViews = 64;
inline constexpr std::uint32_t kSharedAtlasViewStale = 1;
inline constexpr std::uint32_t kAtlasTextInputActive = 1;
inline constexpr std::uint32_t kAtlasTextInputCaretValid = 2;
inline constexpr std::uint32_t kAtlasTextInputSelectionValid = 4;
inline constexpr std::uint32_t kAtlasTextInputCompositionValid = 8;

struct SharedAtlasTextInput {
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
  kDeviceLost = 3,
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
  std::int64_t capture_time_us;
  std::uint32_t slot;
  std::uint32_t width_pixels;
  std::uint32_t height_pixels;
  SharedAtlasStatus status;
  std::uint32_t view_count;
  std::uint32_t reserved;
  SharedAtlasView views[kSharedAtlasMaxViews];
};

struct alignas(64) SharedAtlasMapping {
  std::uint32_t magic;
  std::uint32_t version;
  std::uint32_t mapping_size;
  std::uint32_t reserved;
  // One producer writer: InterlockedIncrement64 -> write -> increment.
  // Reader: Interlocked read (even), copy frame, barrier, reread same value.
  alignas(8) std::int64_t publication_sequence;
  SharedAtlasFrame frame;
};

static_assert(std::is_trivially_copyable_v<SharedAtlasMapping>);
static_assert(sizeof(SharedAtlasTextInput) == 40);
static_assert(sizeof(SharedAtlasView) == 112);
static_assert(offsetof(SharedAtlasView, atlas_pixels_per_dip) == 56);
static_assert(offsetof(SharedAtlasView, page_device_scale_factor) == 60);
static_assert(offsetof(SharedAtlasView, text_input) == 68);
static_assert(offsetof(SharedAtlasFrame, views) == 56);
static_assert(offsetof(SharedAtlasMapping, frame) == 24);
static_assert(sizeof(SharedAtlasMapping) == 7296);
static_assert(offsetof(SharedAtlasMapping, publication_sequence) % 8 == 0);
static_assert(sizeof(SharedAtlasMapping) < 8192);

// Consumer is single-sequence and only consumes monotonically newer frames.
// Signal consumed fence after copying to a consumer-owned texture, never after
// merely submitting Wait or reading metadata. A completed value releases all
// older slots: the consumer promises never to read their producer textures again.
// Producer reuses a slot only when GetCompletedValue() >= its last published
// ready_fence_value. Device removal (UINT64_MAX) is failure, never completion.
// Handles are exchanged once per generation via control messages, and are
// already duplicated into the consumer process. No frame notification is sent.

}  // namespace remotekit
