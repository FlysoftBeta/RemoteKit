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

struct remotekit_sdk_atlas_setup {
  uint32_t struct_size, width, height, mapping_size;
  uint64_t generation, mapping_handle, ready_fence_handle, consumed_fence_handle;
  uint64_t texture_handles[3];
  uint32_t adapter_luid_low;
  int32_t adapter_luid_high;
};

/* Worker-only helpers over control_request. JSON remains UTF-8 bytes with an
 * explicit length; the caller supplies the complete version/id envelope.
 * command returns OK iff the decoded reply has boolean ok=true. BUSY means the
 * browser did not accept the operation; retry only within the same valid token
 * and sequence, with a bounded deadline. Resource
 * handles in ignored replies are closed; use open_atlas to acquire resources.
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
/* Initialize setup.struct_size=sizeof(setup). consumer_pid must equal this
 * process's PID, fps is 1..120, timeout_ms is 1..30000. Opens then polls every
 * 10ms within one timeout budget. The worker may block; never call on UI.
 * All six nonzero Windows handles in a successful result are caller-owned and
 * must each be closed exactly once with CloseHandle. Failure with a valid-size
 * setup leaves its resource fields zero and closes any decoded reply handles.
 * Binary mapping layout is SharedAtlasMapping version 1, three texture slots.
 * Resource issuance is not cancelled in the browser by a local polling timeout.
 * As with raw calls, time queued behind other SDK callers is not bounded. */
REMOTEKIT_SDK_API int remotekit_sdk_control_open_atlas(uint64_t handle,
                                                       uint32_t consumer_pid,
                                                       uint32_t fps,
                                                       struct remotekit_sdk_atlas_setup* setup,
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
