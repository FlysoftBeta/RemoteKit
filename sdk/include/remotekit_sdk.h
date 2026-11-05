#ifndef REMOTEKIT_SDK_H_
#define REMOTEKIT_SDK_H_

#include <stddef.h>
#include <stdint.h>

#if defined(_WIN32)
#if defined(REMOTEKIT_SDK_IMPLEMENTATION)
#define REMOTEKIT_SDK_API __declspec(dllexport)
#else
#define REMOTEKIT_SDK_API __declspec(dllimport)
#endif
#else
#define REMOTEKIT_SDK_API __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

enum remotekit_sdk_status {
  REMOTEKIT_SDK_OK = 0,
  REMOTEKIT_SDK_INVALID_ARGUMENT = 1,
  REMOTEKIT_SDK_INVALID_STATE = 2,
  REMOTEKIT_SDK_MOJO_ERROR = 3,
  REMOTEKIT_SDK_DATA_MISMATCH = 4,
  REMOTEKIT_SDK_TIMEOUT = 5,
  REMOTEKIT_SDK_BUFFER_TOO_SMALL = 6,
  REMOTEKIT_SDK_CHANNEL_CLOSED = 7,
  REMOTEKIT_SDK_BUSY = 8
};

REMOTEKIT_SDK_API uint32_t remotekit_sdk_abi_version(void);
/* Standalone process only: do not initialize inside a Chromium ContentMain
 * process. Calls are serialized. Shutdown is terminal; initialize is idempotent
 * before shutdown. No C++ types or owned allocations cross this ABI. */
REMOTEKIT_SDK_API int remotekit_sdk_initialize(void);
REMOTEKIT_SDK_API int remotekit_sdk_shutdown(void);
/* Sends bytes through a local Mojo message pipe and back through its peer.
 * Capacity must be at least size. Maximum message: 1 MiB. No network or IPC
 * transport is started. output_size is set to zero on failure. */
REMOTEKIT_SDK_API int remotekit_sdk_mojo_roundtrip(const void* input,
                                                   size_t size,
                                                   void* output,
                                                   size_t capacity,
                                                   size_t* output_size);
/* Forces a linked call into WebRTC's clock implementation. */
REMOTEKIT_SDK_API int remotekit_sdk_webrtc_time_millis(int64_t* value);

/* Control calls are synchronous worker-thread calls, never UI-thread calls.
 * name_utf8 is a NUL-terminated ASCII channel name (1..128 characters from
 * A-Z/a-z/0-9/underscore/hyphen/dot). Connect uses the OS named-pipe wait.
 * Handles belong to this SDK instance and are never reused. */
REMOTEKIT_SDK_API int remotekit_sdk_control_connect(const char* name_utf8, uint64_t* handle);
/* One raw UTF-8 JSON message/reply, at most 1 MiB each. Browser validates UTF-8.
 * timeout_ms must be 1..30000. Requests serialize per channel; independent
 * channels may run concurrently. Timeout bounds the active request, not queue
 * time. Close cancels active/queued requests; shutdown rejects new operations
 * and drains operation leases before destroying the SDK runtime.
 * Any error on an existing handle invalidates/closes that connection, including
 * invalid arguments, timeout, oversized response, or insufficient capacity.
 * BUFFER_TOO_SMALL reports the required size in output_size; other errors set
 * it to zero. Reconnect before retrying; replies cannot cross request boundaries.
 * Successful output is bytes only, without an appended NUL. */
REMOTEKIT_SDK_API int remotekit_sdk_control_request(uint64_t handle,
                                                    const void* input,
                                                    size_t size,
                                                    void* output,
                                                    size_t capacity,
                                                    size_t* output_size,
                                                    uint32_t timeout_ms);
REMOTEKIT_SDK_API int remotekit_sdk_control_close(uint64_t handle);

struct remotekit_sdk_token {
  uint64_t session, view, instance, document, focus;
};

#define REMOTEKIT_SDK_ABI_VERSION 2
#define REMOTEKIT_SDK_RENDER_SLOT_COUNT 4
struct remotekit_sdk_render_setup {
  uint32_t struct_size, width, height, mapping_size;
  uint64_t generation, mapping_handle;
  uint64_t ready_fence_handles[4], consumed_fence_handles[4], texture_handles[4];
  uint32_t adapter_luid_low;
  int32_t adapter_luid_high;
  char render_channel[129];
};
struct remotekit_sdk_render_identity {
  uint64_t generation, value;
  uint32_t slot, reserved;
};
struct remotekit_sdk_render_request {
  uint64_t generation, value;
  uint32_t slot, interval_us, force;
};
enum remotekit_sdk_render_event_type {
  REMOTEKIT_SDK_RENDER_REJECT = 1,
  REMOTEKIT_SDK_RENDER_FATAL = 2,
  REMOTEKIT_SDK_RENDER_STOPPED = 3,
  REMOTEKIT_SDK_RENDER_WAKE = 4
};
enum remotekit_sdk_render_reject_reason {
  REMOTEKIT_SDK_RENDER_IDLE = 1,
  REMOTEKIT_SDK_RENDER_NOT_READY = 2,
  REMOTEKIT_SDK_RENDER_STALE_GENERATION = 3,
  REMOTEKIT_SDK_RENDER_REJECT_STOPPED = 4
};
struct remotekit_sdk_render_event {
  uint32_t struct_size, type, reason, reserved;
  uint64_t generation, value;
  uint32_t slot, reserved2;
};
typedef void (*remotekit_sdk_render_callback)(void* context,
                                              const struct remotekit_sdk_render_event* event);
/* Claim the opaque one-use setup.render_channel token from a successful
 * open_render on this SDK's original live Control connection. No OS named pipe
 * or additional process link is opened. Control owns at most one unclaimed
 * endpoint: new open, close, retire or shutdown closes it. A claimed render pipe
 * has its own lifetime and remains owned until render_close.
 * Dedicated asynchronous channel. Callback runs on an SDK worker. It must not
 * call close/shutdown; dispatch those to another thread. render_begin only
 * enqueues a one-way request and does not imply acceptance/GPU completion.
 * At most one outstanding Begin per slot; BUSY leaves the request unsent.
 * Caller owns slot scheduling and fence waits.
 * Values start at 1 and strictly increase across all slots for this connection.
 * Fatal means retire the channel/generation; it never authorizes slot reuse.
 * WAKE is low-frequency idle demand, carrying the last Idle Reject identity.
 * It is neither a request terminal event nor GPU completion and clears no pending
 * request. Duplicate Wake is ignored; no Wake callback is delivered after Stop.
 * close is a callback barrier. No callback may run after it returns. */
REMOTEKIT_SDK_API int remotekit_sdk_render_connect(const char* name_utf8,
                                                   remotekit_sdk_render_callback callback,
                                                   void* context,
                                                   uint64_t* handle);
REMOTEKIT_SDK_API int remotekit_sdk_render_begin(uint64_t handle,
                                                 const struct remotekit_sdk_render_request* begin);
/* Local bookkeeping only; sends no IPC. Call after the matching slot ready
 * Fence actually completes. Reject clears its matching outstanding request
 * automatically. Unknown identities return DATA_MISMATCH. This releases no GPU
 * resource: slot reuse still requires encoder leases and consumed Fence. */
REMOTEKIT_SDK_API int remotekit_sdk_render_observe_signal(
    uint64_t handle,
    const struct remotekit_sdk_render_identity* identity);
/* Generation FIFO barrier, not a per-frame success notification. Sends Stop
 * once; same-generation repeats are idempotent. A successful stop forbids later
 * Begin calls. STOPPED callback follows all prior Reject callbacks and means
 * every prior Begin has a Reject or a GPU Signal queued. It does not prove GPU
 * completion; observe_signal still requires the matching real Fence.
 * Drain Stop/Stopped and actual fences before closing the pool/channel. */
REMOTEKIT_SDK_API int remotekit_sdk_render_stop(uint64_t handle, uint64_t generation);
/* Local callback barrier only. Does not send Stop or release GPU resources. */
REMOTEKIT_SDK_API int remotekit_sdk_render_close(uint64_t handle);

/* Worker-only helpers over control_request. JSON remains UTF-8 bytes with an
 * explicit length; the caller supplies the complete version/id envelope.
 * command returns OK iff the decoded reply has boolean ok=true. BUSY means the
 * browser did not accept the operation; retry only within the same valid token
 * and sequence, with a bounded deadline. Resource
 * handles in ignored replies are closed; use open_render to acquire resources.
 * command_token first zeroes token, then copies a valid reply.token even when
 * reply.ok=false (DATA_MISMATCH), allowing a caller to refresh focus generation.
 * A missing token leaves zeroes. Malformed tokens return DATA_MISMATCH.
 * The existing raw request connection-invalidation rules remain in effect. */
REMOTEKIT_SDK_API int remotekit_sdk_control_command(uint64_t handle,
                                                    const char* json,
                                                    size_t size,
                                                    uint32_t timeout_ms);
REMOTEKIT_SDK_API int remotekit_sdk_control_command_token(uint64_t handle,
                                                          const char* json,
                                                          size_t size,
                                                          uint32_t timeout_ms,
                                                          struct remotekit_sdk_token* token);
/* Initialize struct_size. consumer_pid must be this process, timeout 1..30000.
 * Opens then polls describe within one budget. All 13 returned Windows handles
 * are caller-owned. Mapping is SharedRenderMapping v2. Endpoint owns pacing.
 * A successful describe must attach exactly one empty Mojo message pipe. SDK
 * retains that endpoint under the original Control connection until one-use
 * render_connect claims its opaque token. Failure closes all reply attachments
 * and all decoded Windows resource handles; raw control rejects attachments. */
REMOTEKIT_SDK_API int remotekit_sdk_control_open_render(uint64_t handle,
                                                        uint32_t consumer_pid,
                                                        struct remotekit_sdk_render_setup* setup,
                                                        uint32_t timeout_ms);
/* Windows set-1 native scan code: ordinary 0x00xx, E0-prefixed 0xE0xx
 * (e.g. right Control 0xE01D), not a virtual-key or raw LPARAM. For ordinary
 * keyboard LPARAMs combine bits 16..23 with 0xE000 when extended bit 24 is set.
 * Returns Chromium DomCode's numeric value, or zero for unknown scan codes. */
REMOTEKIT_SDK_API uint32_t remotekit_sdk_windows_dom_code(uint32_t native_scan_code);
/* Worker thread, after initialize. keyboard_layout is the HWND thread's HKL
 * value; the calling worker's layout is restored before returning. Modifiers
 * use Blink WebInputEvent bits. Returns DomKey's numeric representation. */
REMOTEKIT_SDK_API uint64_t remotekit_sdk_windows_dom_key(uint32_t virtual_key,
                                                         uint32_t blink_modifiers,
                                                         uint64_t keyboard_layout);

#ifdef __cplusplus
}
#endif
#endif
