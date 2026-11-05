#include "sdk/include/remotekit_sdk.h"
#include "protocol/render_slots.h"
#include "protocol/shared_render_slots.h"
#include <cstddef>
#include <type_traits>
static_assert(REMOTEKIT_SDK_ABI_VERSION == 2);
static_assert(REMOTEKIT_SDK_RENDER_SLOT_COUNT == remotekit::kRenderSlotCount);
static_assert(sizeof(remotekit_sdk_render_identity) == 24);
static_assert(sizeof(remotekit_sdk_render_request) == 32);
static_assert(offsetof(remotekit_sdk_render_request, slot) == 16);
static_assert(sizeof(remotekit_sdk_render_event) == 40);
static_assert(sizeof(remotekit_sdk_render_setup) == 272);
static_assert(offsetof(remotekit_sdk_render_setup, render_channel) == 136);
static_assert(std::is_standard_layout_v<remotekit_sdk_render_setup>);
static_assert(std::is_same_v<decltype(&remotekit_sdk_render_begin),
                             int (*)(uint64_t, const remotekit_sdk_render_request*)>);

static_assert(static_cast<uint32_t>(REMOTEKIT_SDK_RENDER_STOPPED) !=
              static_cast<uint32_t>(REMOTEKIT_SDK_RENDER_REJECT_STOPPED));
static_assert(std::is_same_v<decltype(&remotekit_sdk_render_stop), int (*)(uint64_t, uint64_t)>);
