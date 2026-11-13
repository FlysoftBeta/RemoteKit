#include "remotekit/browser/sdk/sdk_internal.h"
#include "ui/events/event_constants.h"
#include "ui/events/keycodes/dom/keycode_converter.h"
// Chromium's layout-aware Windows key translation is private to ui/events.
#include "ui/events/keycodes/platform_key_map_win.h"  // nogncheck

using namespace remotekit::sdk;
namespace remotekit::sdk {
SDKState& State() {
  static base::NoDestructor<SDKState> state;
  return *state;
}
void RunPoolLifecycle(SDKState& state, bool start) {
  base::WaitableEvent done;
  state.io_thread->task_runner()->PostTask(
      FROM_HERE, base::BindOnce(
                     [](bool start_pool, base::WaitableEvent* completed) {
                       if (start_pool) {
                         base::ThreadPoolInstance::CreateAndStartWithDefaultParams("RemoteKitSDK");
                       } else {
                         base::ThreadPoolInstance::Get()->Shutdown();
                         // Shutdown leaves Chromium workers alive; a loadable SDK requires
                         // the complete join barrier before DLL unload.
                         base::ThreadPoolInstance::Get()->JoinForTesting();
                         base::ThreadPoolInstance::Set(nullptr);
                       }
                       completed->Signal();
                     },
                     start, base::Unretained(&done)));
  done.Wait();
}
}  // namespace remotekit::sdk
// Internal lifetime handshake serializes peer creation/teardown with shutdown.
int RemoteKitSdkBeginRtc() {
  auto& state = State();
  std::lock_guard lock(state.lock);
  if (state.phase != SDKPhase::kRunning)
    return REMOTEKIT_SDK_INVALID_STATE;
  ++state.rtc_peers;
  return REMOTEKIT_SDK_OK;
}
void RemoteKitSdkEndRtc() {
  auto& state = State();
  std::lock_guard lock(state.lock);
  --state.rtc_peers;
}

uint32_t remotekit_sdk_abi_version(void) {
  return REMOTEKIT_SDK_ABI_VERSION;
}

int remotekit_sdk_initialize(void) {
  auto& state = State();
  std::lock_guard<std::mutex> lock(state.lock);
  if (state.phase == SDKPhase::kStopped || state.phase == SDKPhase::kStopping)
    return REMOTEKIT_SDK_INVALID_STATE;
  if (state.phase == SDKPhase::kRunning)
    return REMOTEKIT_SDK_OK;
  state.at_exit = std::make_unique<base::AtExitManager>();
  mojo::core::Configuration configuration;
  configuration.is_broker_process = true;
  mojo::core::Init(configuration);
  state.io_thread = std::make_unique<base::Thread>("RemoteKit SDK Mojo IO");
  base::Thread::Options options;
  options.message_pump_type = base::MessagePumpType::IO;
  if (!state.io_thread->StartWithOptions(std::move(options))) {
    state.io_thread.reset();
    mojo::core::ShutDown();
    state.at_exit.reset();
    state.phase = SDKPhase::kStopped;
    return REMOTEKIT_SDK_INVALID_STATE;
  }
  if (!base::ThreadPoolInstance::Get()) {
    RunPoolLifecycle(state, true);
    state.owns_thread_pool = true;
  }
  state.ipc_support = std::make_unique<mojo::core::ScopedIPCSupport>(
      state.io_thread->task_runner(), mojo::core::ScopedIPCSupport::ShutdownPolicy::CLEAN);
  state.phase = SDKPhase::kRunning;
  return REMOTEKIT_SDK_OK;
}

int remotekit_sdk_shutdown(void) {
  auto& state = State();
  std::unique_lock lock(state.lock);
  if (state.phase != SDKPhase::kRunning)
    return REMOTEKIT_SDK_INVALID_STATE;
  if (state.rtc_peers || !state.render_channels.empty())
    return REMOTEKIT_SDK_INVALID_STATE;
  state.phase = SDKPhase::kStopping;
  for (auto& [id, channel] : state.channels) {
    channel->closed.store(true, std::memory_order_release);
    channel->pending_render.Reset();
  }
  auto channels = std::move(state.channels);
  lock.unlock();
  // In-flight calls keep their channel alive and observe cancellation in the
  // receive loop. No thread closes a pipe while another is reading/writing it.
  channels.clear();
  lock.lock();
  state.idle.wait(lock, [&] { return state.operations == 0; });
  lock.unlock();
  state.ipc_support.reset();
  if (state.owns_thread_pool) {
    RunPoolLifecycle(state, false);
    state.owns_thread_pool = false;
  }
  state.io_thread->Stop();
  state.io_thread.reset();
  mojo::core::ShutDown();
  lock.lock();
  state.at_exit.reset();
  state.phase = SDKPhase::kStopped;
  return REMOTEKIT_SDK_OK;
}

int remotekit_sdk_mojo_roundtrip(const void* input,
                                 size_t size,
                                 void* output,
                                 size_t capacity,
                                 size_t* output_size) {
  if (!output_size)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  *output_size = 0;
  if (size > kMaxMessageSize || capacity < size || (size && (!input || !output))) {
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  }
  // SAFETY: the C ABI requires input/output to designate buffers of the stated
  // sizes. The checks above reject null nonempty buffers and insufficient output
  // capacity. All subsequent comparison/copy operations remain bounded spans.
  const auto input_bytes = UNSAFE_BUFFERS(base::span(static_cast<const uint8_t*>(input), size));
  auto output_bytes = UNSAFE_BUFFERS(base::span(static_cast<uint8_t*>(output), size));
  OperationLease lease;
  if (!lease)
    return REMOTEKIT_SDK_INVALID_STATE;
  mojo::ScopedMessagePipeHandle first;
  mojo::ScopedMessagePipeHandle second;
  if (mojo::CreateMessagePipe(nullptr, &first, &second) != MOJO_RESULT_OK)
    return REMOTEKIT_SDK_MOJO_ERROR;
  if (mojo::WriteMessageRaw(first.get(), input, size, nullptr, 0, MOJO_WRITE_MESSAGE_FLAG_NONE) !=
      MOJO_RESULT_OK) {
    return REMOTEKIT_SDK_MOJO_ERROR;
  }
  std::vector<uint8_t> received;
  if (mojo::ReadMessageRaw(second.get(), &received, nullptr, MOJO_READ_MESSAGE_FLAG_NONE) !=
      MOJO_RESULT_OK) {
    return REMOTEKIT_SDK_MOJO_ERROR;
  }
  if (base::span(received) != input_bytes) {
    return REMOTEKIT_SDK_DATA_MISMATCH;
  }
  if (mojo::WriteMessageRaw(second.get(), received.data(), received.size(), nullptr, 0,
                            MOJO_WRITE_MESSAGE_FLAG_NONE) != MOJO_RESULT_OK) {
    return REMOTEKIT_SDK_MOJO_ERROR;
  }
  std::vector<uint8_t> returned;
  if (mojo::ReadMessageRaw(first.get(), &returned, nullptr, MOJO_READ_MESSAGE_FLAG_NONE) !=
      MOJO_RESULT_OK) {
    return REMOTEKIT_SDK_MOJO_ERROR;
  }
  if (base::span(returned) != input_bytes) {
    return REMOTEKIT_SDK_DATA_MISMATCH;
  }
  output_bytes.copy_from(returned);
  *output_size = size;
  return REMOTEKIT_SDK_OK;
}

int remotekit_sdk_webrtc_time_millis(int64_t* value) {
  if (!value)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  OperationLease lease;
  if (!lease)
    return REMOTEKIT_SDK_INVALID_STATE;
  *value = webrtc::TimeMillis();
  return REMOTEKIT_SDK_OK;
}

uint32_t remotekit_sdk_windows_dom_code(uint32_t native_scan_code) {
  if (native_scan_code > static_cast<uint32_t>(std::numeric_limits<int>::max()))
    return 0;
  return static_cast<uint32_t>(
      ui::KeycodeConverter::NativeKeycodeToDomCode(static_cast<int>(native_scan_code)));
}
uint64_t remotekit_sdk_windows_dom_key(uint32_t virtual_key,
                                       uint32_t blink_modifiers,
                                       uint64_t keyboard_layout) {
  if (virtual_key > 255)
    return 0;
  int flags = 0;
  if (blink_modifiers & 1)
    flags |= ui::EF_SHIFT_DOWN;
  if (blink_modifiers & 2)
    flags |= ui::EF_CONTROL_DOWN;
  if (blink_modifiers & 4)
    flags |= ui::EF_ALT_DOWN;
  if (blink_modifiers & 512)
    flags |= ui::EF_CAPS_LOCK_ON;
  const HKL current = GetKeyboardLayout(0);
  const HKL requested = reinterpret_cast<HKL>(static_cast<uintptr_t>(keyboard_layout));
  const bool change = requested && requested != current;
  if (change && !ActivateKeyboardLayout(requested, 0))
    return 0;
  const auto key = ui::PlatformKeyMap::DomKeyFromKeyboardCode(
      static_cast<ui::KeyboardCode>(virtual_key), &flags);
  if (change)
    ActivateKeyboardLayout(current, 0);
  return static_cast<uint64_t>(key);
}
