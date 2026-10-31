#include "remotekit/atlas_client.hpp"
#ifdef _WIN32
#include <imm.h>
#include <windowsx.h>
#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <deque>
#include <filesystem>
#include <limits>
#include <map>
#include <mutex>
#include <thread>
#include <utility>
#include "remotekit/atlas_consumer.hpp"
#include "remotekit_sdk.h"

namespace remotekit {
namespace {
std::string JsonText(const std::wstring& text) {
  if (text.empty())
    return "\"\"";
  const int count =
      WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()),
                          nullptr, 0, nullptr, nullptr);
  if (!count)
    return "\"\"";
  std::string utf8(count, '\0');
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()),
                      utf8.data(), count, nullptr, nullptr);
  std::string result = "\"";
  constexpr char hex[] = "0123456789abcdef";
  for (unsigned char c : utf8) {
    if (c == '"' || c == '\\') {
      result += '\\';
      result += c;
    } else if (c < 32) {
      result += "\\u00";
      result += hex[c >> 4];
      result += hex[c & 15];
    } else
      result += c;
  }
  return result + '"';
}
std::uint32_t Modifiers() {
  std::uint32_t value = 0;
  if (GetKeyState(VK_SHIFT) & 0x8000)
    value |= 1;
  if (GetKeyState(VK_CONTROL) & 0x8000)
    value |= 2;
  if (GetKeyState(VK_MENU) & 0x8000)
    value |= 4;
  if ((GetKeyState(VK_LWIN) | GetKeyState(VK_RWIN)) & 0x8000)
    value |= 8;
  if (GetKeyState(VK_LBUTTON) & 0x8000)
    value |= 64;
  if (GetKeyState(VK_MBUTTON) & 0x8000)
    value |= 128;
  if (GetKeyState(VK_RBUTTON) & 0x8000)
    value |= 256;
  if (GetKeyState(VK_XBUTTON1) & 0x8000)
    value |= 1u << 20;
  if (GetKeyState(VK_XBUTTON2) & 0x8000)
    value |= 1u << 21;
  if (GetKeyState(VK_CAPITAL) & 1)
    value |= 512;
  if (GetKeyState(VK_NUMLOCK) & 1)
    value |= 1024;
  return value;
}
struct Target {
  SharedAtlasView view{};
  double x = 0, y = 0;
  std::uint64_t output_generation = 0;
  explicit operator bool() const { return view.webview_id != 0 && output_generation != 0; }
};
struct Task {
  Target target;
  std::string event;
  bool focus = false, blur = false, coalesce = false;
  std::uint32_t scan_code = 0;
  bool key = false, key_up = false, repeat = false, character = false;
  std::uint32_t virtual_key = 0, modifiers = 0;
  std::uint32_t dom_virtual_key = 0;
  std::uint64_t keyboard_layout = 0;
  std::wstring text;
  std::uint64_t epoch = 0;
};
double WindowScale(HWND window) {
  const UINT dpi = GetDpiForWindow(window);
  return static_cast<double>(dpi ? dpi : 96) / 96.0;
}
void CloseSetupHandles(remotekit_sdk_atlas_setup& setup) {
  for (auto& value : setup.texture_handles)
    if (value)
      CloseHandle(reinterpret_cast<HANDLE>(static_cast<uintptr_t>(std::exchange(value, 0))));
  for (auto* value :
       {&setup.mapping_handle, &setup.ready_fence_handle, &setup.consumed_fence_handle})
    if (*value)
      CloseHandle(reinterpret_cast<HANDLE>(static_cast<uintptr_t>(std::exchange(*value, 0))));
  setup = {};
}
}  // namespace

struct AtlasClient::Impl {
  HWND window;
  std::wstring sdk_path;
  std::string channel;
  AtlasConsumer consumer;
  HMODULE sdk_module = nullptr;  // Unload only after worker TLS destructors ran.
  std::thread worker;
  std::mutex mutex;
  std::condition_variable wake;
  std::deque<Task> tasks;
  bool stopping = false, started = false, have_setup = false, attached = false;
  enum class Phase { starting, active, draining, waiting_setup, failed };
  Phase phase = Phase::starting;  // HWND sequence only.
  bool restart_pending = false, restart_ready = false, configure_pending = false;
  bool accept_input = false, desired_enabled = true, blur_pending = false;
  bool ui_attached = false, enabled_applied = false, output_enabled = true;
  bool open_failed = false, shutdown_close_safe = false;
  int open_failure_status = REMOTEKIT_SDK_OK;
  double desired_scale = 1.0, window_scale = 1.0;
  std::uint64_t configuration_revision = 1, setup_revision = 0, task_epoch = 1,
                worker_generation = 0;
  unsigned gpu_rebuilds = 0;
  std::chrono::steady_clock::time_point drain_started;
  remotekit_sdk_atlas_setup setup{};
  std::wstring worker_error, error;
  Target focused, captured, touch_target;
  std::map<UINT32, Target> touches;
  wchar_t high_surrogate = 0;
  int click_button = 0, click_count = 0;
  DWORD click_time = 0;
  POINT click_position{};
  std::map<int, int> pressed_click_counts;
  std::uint64_t click_view = 0, click_generation = 0;

  Impl(HWND hwnd, std::wstring path, std::string name)
      : window(hwnd), sdk_path(std::move(path)), channel(std::move(name)) {}

  ~Impl() {
    attached = false;
    PauseInputs();
    const bool drained = consumer.Close();
    {
      std::lock_guard lock(mutex);
      ui_attached = false;
      shutdown_close_safe = drained;
      stopping = true;
    }
    wake.notify_all();
    if (worker.joinable())
      worker.join();
    if (have_setup)
      CloseSetupHandles(setup);
    if (sdk_module)
      FreeLibrary(std::exchange(sdk_module, nullptr));
  }

  Target HitTest(int x, int y) const {
    if (!attached)
      return {};
    const auto rect = consumer.GetContentRect();
    const auto frame = consumer.GetLastFrame();
    if (x < rect.left || y < rect.top || x >= rect.right || y >= rect.bottom ||
        rect.right <= rect.left || rect.bottom <= rect.top)
      return {};
    const double ax =
        static_cast<double>(x - rect.left) * frame.width_pixels / (rect.right - rect.left);
    const double ay =
        static_cast<double>(y - rect.top) * frame.height_pixels / (rect.bottom - rect.top);
    for (std::uint32_t i = 0; i < frame.view_count; ++i) {
      const auto& view = frame.views[i];
      if ((view.reserved & kSharedAtlasViewStale) || view.device_scale_factor <= 0)
        continue;
      if (ax >= view.x_pixels && ay >= view.y_pixels && ax < view.x_pixels + view.width_pixels &&
          ay < view.y_pixels + view.height_pixels)
        return {view, (ax - view.x_pixels) / view.device_scale_factor,
                (ay - view.y_pixels) / view.device_scale_factor, frame.generation};
    }
    return {};
  }
  Target PositionFor(const Target& target, int x, int y) const {
    const auto rect = consumer.GetContentRect();
    const auto frame = consumer.GetLastFrame();
    if (!attached || frame.generation != target.output_generation)
      return {};
    Target result = target;
    if (rect.right > rect.left && rect.bottom > rect.top && target.view.device_scale_factor > 0) {
      result.x =
          (static_cast<double>(x - rect.left) * frame.width_pixels / (rect.right - rect.left) -
           target.view.x_pixels) /
          target.view.device_scale_factor;
      result.y =
          (static_cast<double>(y - rect.top) * frame.height_pixels / (rect.bottom - rect.top) -
           target.view.y_pixels) /
          target.view.device_scale_factor;
    }
    return result;
  }
  void Enqueue(Task task) {
    if (!task.target || !attached || !error.empty())
      return;
    const auto frame = consumer.GetLastFrame();
    if (task.target.output_generation != frame.generation)
      return;
    if (!task.blur) {
      bool current = false;
      for (std::uint32_t i = 0; i < frame.view_count; ++i) {
        const auto& view = frame.views[i];
        if (view.webview_id == task.target.view.webview_id &&
            view.session_id == task.target.view.session_id &&
            !(view.reserved & kSharedAtlasViewStale) &&
            view.instance_generation == task.target.view.instance_generation &&
            view.document_generation == task.target.view.document_generation) {
          current = true;
          break;
        }
      }
      if (!current)
        return;
    }
    {
      std::lock_guard lock(mutex);
      if (stopping || !worker_error.empty() || !accept_input ||
          task.target.output_generation != worker_generation)
        return;
      task.epoch = task_epoch;
      if (task.coalesce && !tasks.empty() && tasks.back().coalesce &&
          tasks.back().target.view.webview_id == task.target.view.webview_id &&
          tasks.back().target.output_generation == task.target.output_generation)
        tasks.back() = std::move(task);
      else if (tasks.size() < 2048)
        tasks.push_back(std::move(task));
      else {
        tasks.clear();
        task.event.clear();
        task.blur = true;
        task.focus = false;
        tasks.push_back(std::move(task));
      }
    }
    wake.notify_one();
  }
  void Focus(Target target) {
    if (focused && focused.view.webview_id != target.view.webview_id) {
      Task old;
      old.target = focused;
      old.blur = true;
      Enqueue(std::move(old));
    }
    focused = target;
    Task task;
    task.target = target;
    task.focus = true;
    Enqueue(std::move(task));
  }
  void Text(const wchar_t* type, const std::wstring& text) {
    Task task;
    task.target = focused;
    std::wstring kind(type);
    task.event = "{\"type\":" + JsonText(kind) + ",\"text\":" + JsonText(text);
    if (kind == L"ime_set")
      task.event += ",\"selection_start\":" + std::to_string(text.size()) +
                    ",\"selection_end\":" + std::to_string(text.size());
    task.event += '}';
    Enqueue(std::move(task));
  }
  void SetWorkerError(std::wstring message) {
    std::lock_guard lock(mutex);
    worker_error = std::move(message);
  }
  void PauseInputs() {
    {
      std::lock_guard lock(mutex);
      accept_input = false;
      tasks.clear();
      ++task_epoch;
      blur_pending = true;
    }
    focused = {};
    captured = {};
    touch_target = {};
    touches.clear();
    high_surrogate = 0;
    pressed_click_counts.clear();
    click_button = click_count = 0;
    if (GetCapture() == window)
      ReleaseCapture();
    if (HIMC context = ImmGetContext(window)) {
      ImmNotifyIME(context, NI_COMPOSITIONSTR, CPS_CANCEL, 0);
      ImmReleaseContext(window, context);
    }
    wake.notify_one();
  }
  void Stop(std::wstring reason) {
    attached = false;
    phase = Phase::failed;
    error = std::move(reason);
    PauseInputs();
    const bool drained = consumer.Close();
    {
      std::lock_guard lock(mutex);
      ui_attached = false;
      shutdown_close_safe = drained;
      stopping = true;
    }
    wake.notify_one();
  }
  void FinishDrain() {
    if (phase != Phase::draining)
      return;
    if (consumer.Close()) {
      // Pending SDK handles have not been imported into a consumer device.
      // Close them before allowing another producer generation to be opened.
      {
        std::lock_guard lock(mutex);
        if (have_setup) {
          CloseSetupHandles(setup);
          have_setup = false;
        }
        restart_ready = true;
      }
      phase = Phase::waiting_setup;
      wake.notify_one();
    } else if (std::chrono::steady_clock::now() - drain_started >= std::chrono::seconds(3)) {
      Stop(L"Atlas GPU reads did not drain within 3 seconds; resources retained, rebuild stopped");
    }
  }
  void BeginRestart(bool gpu_failure, std::wstring reason = {}) {
    if (phase == Phase::failed)
      return;
    if (phase == Phase::draining)
      return;
    if (gpu_failure && gpu_rebuilds >= 3) {
      Stop(L"Atlas GPU rebuild limit (3) reached: " + reason);
      return;
    }
    if (gpu_failure)
      ++gpu_rebuilds;
    attached = false;
    PauseInputs();
    {
      std::lock_guard lock(mutex);
      ui_attached = false;
      enabled_applied = false;
      restart_pending = true;
      restart_ready = false;
      open_failed = false;
    }
    phase = Phase::draining;
    drain_started = std::chrono::steady_clock::now();
    FinishDrain();
  }
  void UpdateImeGeometry() {
    if (!attached || !focused)
      return;
    const auto frame = consumer.GetLastFrame();
    const auto rect = consumer.GetContentRect();
    if (frame.generation != focused.output_generation)
      return;
    if (!frame.width_pixels || !frame.height_pixels)
      return;
    for (std::uint32_t i = 0; i < frame.view_count; ++i) {
      const auto& view = frame.views[i];
      const auto& input = view.text_input;
      if (view.webview_id != focused.view.webview_id || (view.reserved & kSharedAtlasViewStale) ||
          view.instance_generation != focused.view.instance_generation ||
          view.document_generation != focused.view.document_generation ||
          (input.flags & (kAtlasTextInputActive | kAtlasTextInputCaretValid)) !=
              (kAtlasTextInputActive | kAtlasTextInputCaretValid))
        continue;
      auto map_x = [&](float x) {
        return rect.left + static_cast<LONG>((view.x_pixels + x * view.device_scale_factor) *
                                             (rect.right - rect.left) / frame.width_pixels);
      };
      auto map_y = [&](float y) {
        return rect.top + static_cast<LONG>((view.y_pixels + y * view.device_scale_factor) *
                                            (rect.bottom - rect.top) / frame.height_pixels);
      };
      HIMC context = ImmGetContext(window);
      if (!context)
        return;
      COMPOSITIONFORM composition{};
      composition.dwStyle = CFS_POINT;
      composition.ptCurrentPos = {map_x(input.caret_x), map_y(input.caret_y + input.caret_height)};
      ImmSetCompositionWindow(context, &composition);
      CANDIDATEFORM candidate{};
      candidate.dwStyle = CFS_EXCLUDE;
      candidate.ptCurrentPos = composition.ptCurrentPos;
      candidate.rcArea = {map_x(input.caret_x), map_y(input.caret_y),
                          map_x(input.caret_x + input.caret_width),
                          map_y(input.caret_y + input.caret_height)};
      ImmSetCandidateWindow(context, &candidate);
      ImmReleaseContext(window, context);
      return;
    }
  }
  void Run() {
    HMODULE module =
        LoadLibraryExW(sdk_path.c_str(), nullptr,
                       LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
    if (!module) {
      SetWorkerError(L"Could not load RemoteKit SDK runtime");
      return;
    }
    sdk_module = module;
    auto initialize = reinterpret_cast<decltype(&remotekit_sdk_initialize)>(
        GetProcAddress(module, "remotekit_sdk_initialize"));
    auto shutdown = reinterpret_cast<decltype(&remotekit_sdk_shutdown)>(
        GetProcAddress(module, "remotekit_sdk_shutdown"));
    auto connect = reinterpret_cast<decltype(&remotekit_sdk_control_connect)>(
        GetProcAddress(module, "remotekit_sdk_control_connect"));
    auto close = reinterpret_cast<decltype(&remotekit_sdk_control_close)>(
        GetProcAddress(module, "remotekit_sdk_control_close"));
    auto open = reinterpret_cast<decltype(&remotekit_sdk_control_open_atlas)>(
        GetProcAddress(module, "remotekit_sdk_control_open_atlas"));
    auto command = reinterpret_cast<decltype(&remotekit_sdk_control_command_token)>(
        GetProcAddress(module, "remotekit_sdk_control_command_token"));
    auto dom_code = reinterpret_cast<decltype(&remotekit_sdk_windows_dom_code)>(
        GetProcAddress(module, "remotekit_sdk_windows_dom_code"));
    using DomKeyFunction = std::uint64_t (*)(std::uint32_t, std::uint32_t, std::uint64_t);
    auto dom_key =
        reinterpret_cast<DomKeyFunction>(GetProcAddress(module, "remotekit_sdk_windows_dom_key"));
    if (!initialize || !shutdown || !connect || !close || !open || !command || !dom_code ||
        !dom_key) {
      SetWorkerError(L"RemoteKit SDK does not support shared atlas");
      FreeLibrary(std::exchange(sdk_module, nullptr));
      return;
    }
    std::uint64_t handle = 0;
    bool initialized = initialize() == REMOTEKIT_SDK_OK;
    if (!initialized) {
      SetWorkerError(L"Could not initialize RemoteKit SDK");
      return;
    }
    int status = REMOTEKIT_SDK_CHANNEL_CLOSED;
    for (int attempt = 0; attempt < 200; ++attempt) {
      {
        std::lock_guard lock(mutex);
        if (stopping)
          break;
      }
      status = connect(channel.c_str(), &handle);
      if (status == REMOTEKIT_SDK_OK)
        break;
      std::unique_lock lock(mutex);
      wake.wait_for(lock, std::chrono::milliseconds(25), [&] { return stopping; });
    }
    if (status != REMOTEKIT_SDK_OK) {
      SetWorkerError(L"Could not connect RemoteKit control channel");
      shutdown();
      return;
    }
    std::map<std::uint64_t, remotekit_sdk_token> tokens;
    std::uint64_t sequence = 0;
    int request_id = 100000;
    std::uint64_t active_generation = 0, last_generation = 0;
    std::optional<remotekit_sdk_token> remote_focus;
    auto envelope = [&](const char* method, const std::string& fields) {
      if (++request_id == 0x7fffffff)
        request_id = 100000;
      return "{\"version\":1,\"id\":" + std::to_string(request_id) + ",\"method\":\"" + method +
             '"' + fields + '}';
    };
    auto control = [&](const char* method, const std::string& fields,
                       remotekit_sdk_token* reply = nullptr) {
      const auto json = envelope(method, fields);
      remotekit_sdk_token ignored{};
      return command(handle, json.data(), json.size(), 2000, reply ? reply : &ignored);
    };
    auto blur = [&]() -> int {
      if (!remote_focus)
        return REMOTEKIT_SDK_OK;
      const auto token = *remote_focus;
      remote_focus.reset();
      int result =
          control("focus", ",\"session\":\"" + std::to_string(token.session) + "\",\"view\":\"" +
                               std::to_string(token.view) + "\",\"instance\":\"" +
                               std::to_string(token.instance) + "\",\"document\":\"" +
                               std::to_string(token.document) + "\",\"focused\":false");
      return result == REMOTEKIT_SDK_DATA_MISMATCH ? REMOTEKIT_SDK_OK : result;
    };
    auto create_output = [&](bool rebuild) {
      double scale;
      bool enabled;
      std::uint64_t revision;
      if (rebuild) {
        status = control("output.close", "");
        if (status != REMOTEKIT_SDK_OK) {
          SetWorkerError(L"output.close failed; new generation was not opened (SDK " +
                         std::to_wstring(status) + L")");
          return false;
        }
      }
      {
        // The producer may need a real first capture to allocate resources.
        // A minimized client defers opening rather than timing out an open
        // that can never receive its first frame. Once open is in flight,
        // later disabled configuration remains queued until that handshake.
        std::unique_lock lock(mutex);
        wake.wait(lock,[&] { return stopping || desired_enabled; });
        if(stopping) return false;
        if(restart_pending && restart_ready) {
          // Additional DPI changes while closed need no second generation.
          restart_pending=false; restart_ready=false;
        }
        scale=desired_scale; enabled=desired_enabled; revision=configuration_revision;
        configure_pending=false;
      }
      status = control("output.configure", ",\"device_scale\":" + std::to_string(scale) +
                                               ",\"enabled\":" + (enabled ? "true" : "false") +
                                               ",\"fps\":30");
      if (status != REMOTEKIT_SDK_OK) {
        SetWorkerError(L"output.configure failed (SDK " + std::to_wstring(status) + L")");
        return false;
      }
      remotekit_sdk_atlas_setup local{};
      local.struct_size = sizeof(local);
      status = open(handle, GetCurrentProcessId(), 30, &local, 10000);
      if (status != REMOTEKIT_SDK_OK) {
        if (status == REMOTEKIT_SDK_DATA_MISMATCH) {
          std::lock_guard lock(mutex);
          open_failed = true;
          open_failure_status = status;
          accept_input = false;
          worker_generation = 0;
          status = REMOTEKIT_SDK_OK;
          return true;  // UI performs the same closed-consumer handoff before retry.
        }
        SetWorkerError(L"Atlas setup transport failed; reconnect is disabled (SDK " +
                       std::to_wstring(status) + L")");
        return false;
      }
      if (local.generation <= last_generation) {
        CloseSetupHandles(local);
        SetWorkerError(L"Atlas resource generation did not advance");
        return false;
      }
      active_generation = last_generation = local.generation;
      tokens.clear();
      remote_focus.reset();
      bool discard_setup = false;
      {
        std::lock_guard lock(mutex);
        worker_generation = active_generation;
        discard_setup = stopping || restart_pending || revision != configuration_revision;
        if (!discard_setup) {
          if (have_setup)
            CloseSetupHandles(setup);
          setup = local;
          have_setup = true;
          setup_revision = revision;
          enabled_applied = enabled && desired_enabled;
        }
      }
      if (discard_setup)
        CloseSetupHandles(local);
      return true;
    };
    bool running = create_output(false);
    while (running && status == REMOTEKIT_SDK_OK) {
      Task task;
      bool rebuild = false, configure = false, should_blur = false, enabled = true;
      {
        std::unique_lock lock(mutex);
        wake.wait(lock, [&] {
          return stopping || blur_pending || (restart_pending && restart_ready) ||
                 (configure_pending && !restart_pending) || (accept_input && !tasks.empty());
        });
        if (stopping)
          break;
        should_blur = std::exchange(blur_pending, false);
        enabled = desired_enabled;
        if (restart_pending && restart_ready) {
          rebuild = true;
          restart_pending = false;
          restart_ready = false;
          configure_pending = false;
          accept_input = false;
          tasks.clear();
        } else if (configure_pending && !restart_pending) {
          configure = true;
          configure_pending = false;
        } else if (accept_input && !tasks.empty()) {
          task = std::move(tasks.front());
          tasks.pop_front();
        }
      }
      if (should_blur) {
        status = blur();
        if (status != REMOTEKIT_SDK_OK) {
          SetWorkerError(L"RemoteKit control channel failed while blurring; reconnect is disabled");
          break;
        }
      }
      if (rebuild) {
        running = create_output(true);
        continue;
      }
      if (configure) {
        status = control("output.configure", std::string(",\"enabled\":") +
                                                 (enabled ? "true" : "false") + ",\"fps\":30");
        if (status != REMOTEKIT_SDK_OK) {
          SetWorkerError(L"Live output configuration failed (SDK " + std::to_wstring(status) +
                         L")");
          break;
        }
        {
          std::lock_guard lock(mutex);
          enabled_applied = enabled && desired_enabled;
          accept_input = ui_attached && enabled_applied && !restart_pending;
        }
        continue;
      }
      if (!task.target)
        continue;
      {
        std::lock_guard lock(mutex);
        if (!accept_input || restart_pending || task.epoch != task_epoch ||
            task.target.output_generation != active_generation)
          continue;
      }
      const auto& view = task.target.view;
      auto& token = tokens[view.webview_id];
      if (token.instance != view.instance_generation ||
          token.document != view.document_generation || view.focus_generation > token.focus) {
        token = {view.session_id, view.webview_id, view.instance_generation,
                 view.document_generation, view.focus_generation};
      }
      const std::string target_fields = ",\"session\":\"" + std::to_string(token.session) +
                                        "\",\"view\":\"" + std::to_string(token.view) +
                                        "\",\"output_generation\":\"" +
                                        std::to_string(task.target.output_generation) + '"';
      std::string fields;
      if (task.focus || task.blur)
        fields = target_fields + ",\"instance\":\"" + std::to_string(token.instance) +
                 "\",\"document\":\"" + std::to_string(token.document) +
                 "\",\"focused\":" + (task.focus ? "true" : "false");
      else {
        if (task.key)
          task.event =
              "{\"type\":\"key\",\"action\":\"" +
              std::string(task.character ? "char"
                          : task.key_up  ? "up"
                                         : "down") +
              (task.character ? "\",\"text\":" + JsonText(task.text) +
                                    ",\"unmodified_text\":" + JsonText(task.text)
                              : "\"") +
              ",\"physical_code\":" + std::to_string(task.scan_code) +
              ",\"windows_key_code\":" + std::to_string(task.virtual_key) +
              ",\"dom_code\":" + std::to_string(dom_code(task.scan_code)) + ",\"dom_key\":\"" +
              std::to_string(dom_key(task.character ? task.dom_virtual_key : task.virtual_key,
                                     task.modifiers, task.keyboard_layout)) +
              "\",\"modifiers\":" + std::to_string(task.modifiers) +
              ",\"repeat\":" + (task.repeat ? "true}" : "false}");
        fields = target_fields + ",\"instance\":\"" + std::to_string(token.instance) +
                 "\",\"document\":\"" + std::to_string(token.document) + "\",\"focus\":\"" +
                 std::to_string(token.focus) + "\",\"sequence\":\"" + std::to_string(++sequence) +
                 "\",\"event\":" + task.event;
      }
      remotekit_sdk_token reply{};
      const auto packet = envelope(task.focus || task.blur ? "focus" : "input", fields);
      const auto sent_token = token;
      bool busy_deadline = false;
      const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
      for (;;) {
        const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
                                   deadline - std::chrono::steady_clock::now())
                                   .count();
        if (remaining <= 0) {
          // BUSY is a valid reply, so this connection is still usable for
          // cleanup. A transport timeout below is different and never retried.
          blur();
          SetWorkerError(L"Input remained busy for 2 seconds; packet dropped and focus released");
          busy_deadline = true;
          status = REMOTEKIT_SDK_TIMEOUT;
          break;
        }
        reply = {};
        status =
            command(handle, packet.data(), packet.size(),
                    static_cast<std::uint32_t>(std::min<std::int64_t>(2000, remaining)), &reply);
        if (status != REMOTEKIT_SDK_BUSY)
          break;
        const bool reply_has_token = reply.view != 0;
        if (reply_has_token &&
            (reply.session != sent_token.session || reply.view != sent_token.view ||
             reply.instance != sent_token.instance || reply.document != sent_token.document ||
             reply.focus != sent_token.focus)) {
          status = REMOTEKIT_SDK_DATA_MISMATCH;
          break;
        }
        std::unique_lock lock(mutex);
        if (stopping || !accept_input || restart_pending || task.epoch != task_epoch ||
            task.target.output_generation != worker_generation) {
          status = REMOTEKIT_SDK_DATA_MISMATCH;
          break;
        }
        wake.wait_for(lock, std::chrono::milliseconds(4), [&] {
          return stopping || !accept_input || restart_pending || task.epoch != task_epoch;
        });
        if (stopping || !accept_input || restart_pending || task.epoch != task_epoch) {
          status = REMOTEKIT_SDK_DATA_MISMATCH;
          break;
        }
      }
      if (reply.view == token.view && reply.session == token.session)
        token = reply;
      if (status == REMOTEKIT_SDK_OK && task.focus)
        remote_focus = token;
      if (status == REMOTEKIT_SDK_OK && task.blur && remote_focus &&
          remote_focus->view == token.view)
        remote_focus.reset();
      // A stale document/focus is an expected rejected input; never replay it.
      if (status == REMOTEKIT_SDK_DATA_MISMATCH)
        status = REMOTEKIT_SDK_OK;
      else if (status != REMOTEKIT_SDK_OK && !busy_deadline)
        SetWorkerError(L"RemoteKit control channel failed; reconnect is disabled");
    }
    // No SDK call is made from the UI thread, including teardown.
    if (status == REMOTEKIT_SDK_OK) {
      const int blurred = blur();
      bool close_safe = false;
      {
        std::lock_guard lock(mutex);
        close_safe = shutdown_close_safe;
      }
      if (blurred == REMOTEKIT_SDK_OK && close_safe)
        control("output.close", "");
    }
    if (handle)
      close(handle);
    shutdown();
  }
};

AtlasClient::AtlasClient(HWND window, std::wstring path, std::string channel)
    : impl_(std::make_unique<Impl>(window, std::move(path), std::move(channel))) {}
AtlasClient::~AtlasClient() = default;
bool AtlasClient::Start() {
  if (impl_->started)
    return false;
  impl_->started = true;
  impl_->window_scale = WindowScale(impl_->window);
  {
    std::lock_guard lock(impl_->mutex);
    impl_->desired_scale = impl_->window_scale;
  }
  impl_->worker = std::thread([this] { impl_->Run(); });
  return true;
}
bool AtlasClient::ready() const {
  return impl_->attached;
}
const std::wstring& AtlasClient::error() const {
  return impl_->error;
}
void AtlasClient::Resize() {
  auto& p = *impl_;
  const bool resized = !p.attached || p.consumer.Resize();
  const double scale = WindowScale(p.window);
  const bool dpi_changed = scale != p.window_scale;
  if (dpi_changed) {
    p.window_scale = scale;
    std::lock_guard lock(p.mutex);
    p.desired_scale = scale;
    ++p.configuration_revision;
  }
  if (!resized)
    p.BeginRestart(true, p.consumer.LastError());
  else if (dpi_changed && p.started)
    p.BeginRestart(false);
}
void AtlasClient::SetOutputEnabled(bool enabled) {
  auto& p = *impl_;
  if (p.output_enabled == enabled)
    return;
  p.output_enabled = enabled;
  if (!enabled)
    p.PauseInputs();
  {
    std::lock_guard lock(p.mutex);
    p.desired_enabled = enabled;
    p.configure_pending = true;
    p.enabled_applied = false;
    p.accept_input = false;
  }
  p.wake.notify_one();
}
void AtlasClient::Poll() {
  auto& p = *impl_;
  remotekit_sdk_atlas_setup setup{};
  bool have = false, open_failure = false, restart_pending = false, enabled_applied = false;
  std::uint64_t setup_revision = 0, current_revision = 0;
  int failed_status = 0;
  std::wstring worker_error;
  {
    std::lock_guard lock(p.mutex);
    worker_error = p.worker_error;
    if (p.have_setup) {
      setup = p.setup;
      p.setup = {};
      p.have_setup = false;
      have = true;
      setup_revision = p.setup_revision;
    }
    current_revision = p.configuration_revision;
    restart_pending = p.restart_pending;
    open_failure = std::exchange(p.open_failed, false);
    failed_status = p.open_failure_status;
    enabled_applied = p.enabled_applied && p.desired_enabled;
  }
  if (!worker_error.empty()) {
    if (have)
      CloseSetupHandles(setup);
    if (p.phase != Impl::Phase::failed)
      p.Stop(std::move(worker_error));
    else
      p.consumer.Close();  // A previous failed close is now a nonblocking query.
    return;
  }
  if (p.phase == Impl::Phase::failed) {
    if (have)
      CloseSetupHandles(setup);
    p.consumer.Close();
    return;
  }
  if (open_failure && !restart_pending) {
    if (have) {
      CloseSetupHandles(setup);
      have = false;
    }
    p.BeginRestart(true, L"Atlas setup failed (SDK " + std::to_wstring(failed_status) + L")");
  }
  if (have && (setup_revision != current_revision || p.phase == Impl::Phase::draining)) {
    CloseSetupHandles(setup);
    have = false;
    if (p.phase != Impl::Phase::draining)
      p.BeginRestart(false);
  }
  if (p.phase == Impl::Phase::draining) {
    p.FinishDrain();
    return;
  }
  if (have) {
    if (p.attached) {
      CloseSetupHandles(setup);
      p.Stop(L"Unexpected second atlas setup while a consumer is active");
      return;
    }
    AtlasConsumerSetup native;
    native.mapping = reinterpret_cast<HANDLE>(setup.mapping_handle);
    native.ready_fence = reinterpret_cast<HANDLE>(setup.ready_fence_handle);
    native.consumed_fence = reinterpret_cast<HANDLE>(setup.consumed_fence_handle);
    for (int i = 0; i < 3; ++i)
      native.textures[i] = reinterpret_cast<HANDLE>(setup.texture_handles[i]);
    native.adapter_luid = {setup.adapter_luid_low, setup.adapter_luid_high};
    native.generation = setup.generation;
    native.width = setup.width;
    native.height = setup.height;
    p.attached = p.consumer.Open(p.window, native);
    if (!p.attached) {
      p.BeginRestart(true, p.consumer.LastError());
      return;
    }
    p.phase = Impl::Phase::active;
    {
      std::lock_guard lock(p.mutex);
      p.ui_attached = true;
      enabled_applied = p.enabled_applied && p.desired_enabled;
      p.accept_input = enabled_applied && !p.restart_pending;
    }
  }
  if (p.attached && enabled_applied && p.consumer.PollAndPresent() == AtlasPollResult::error) {
    p.BeginRestart(true, p.consumer.LastError());
    return;
  }
  if (p.attached && enabled_applied)
    p.UpdateImeGeometry();
}

std::optional<LRESULT> AtlasClient::HandleMessage(UINT message, WPARAM wparam, LPARAM lparam) {
  auto& p = *impl_;
  if (message == WM_IME_SETCONTEXT)
    return DefWindowProcW(p.window, message, wparam,
                          lparam & ~static_cast<LPARAM>(ISC_SHOWUICOMPOSITIONWINDOW));
  if (message == WM_IME_STARTCOMPOSITION)
    return 0;
  if (!p.attached)
    return std::nullopt;
  if (message == WM_PAINT) {
    PAINTSTRUCT paint{};
    BeginPaint(p.window, &paint);
    EndPaint(p.window, &paint);
    p.consumer.RequestRepaint();
    return 0;
  }
  if (message == WM_ERASEBKGND)
    return 1;
  if (!p.output_enabled)
    return std::nullopt;
  if (message == WM_KILLFOCUS || message == WM_CANCELMODE) {
    Task task;
    task.target = p.focused;
    task.blur = true;
    p.Enqueue(std::move(task));
    p.focused = {};
    p.captured = {};
    p.touches.clear();
    p.touch_target = {};
    p.high_surrogate = 0;
    p.pressed_click_counts.clear();
    p.click_button = p.click_count = 0;
    ReleaseCapture();
    return 0;
  }
  if (message == WM_KEYDOWN || message == WM_KEYUP || message == WM_SYSKEYDOWN ||
      message == WM_SYSKEYUP) {
    Task task;
    task.target = p.focused;
    task.key = true;
    task.key_up = message == WM_KEYUP || message == WM_SYSKEYUP;
    task.virtual_key = static_cast<std::uint32_t>(wparam);
    task.scan_code = (static_cast<std::uint32_t>(lparam) >> 16) & 0xff;
    if (lparam & (1LL << 24))
      task.scan_code |= 0xe000;
    task.modifiers = Modifiers();
    task.repeat = !task.key_up && (lparam & (1LL << 30));
    task.keyboard_layout =
        static_cast<std::uint64_t>(reinterpret_cast<uintptr_t>(GetKeyboardLayout(0)));
    p.Enqueue(std::move(task));
    return 0;
  }
  if (message == WM_CHAR || message == WM_SYSCHAR) {
    const auto character = static_cast<wchar_t>(wparam);
    if (character >= 0xd800 && character <= 0xdbff)
      p.high_surrogate = character;
    else {
      std::wstring text;
      if (character >= 0xdc00 && character <= 0xdfff) {
        if (p.high_surrogate) {
          text += p.high_surrogate;
          text += character;
        }
      } else
        text += character;
      p.high_surrogate = 0;
      if (!text.empty()) {
        Task task;
        task.target = p.focused;
        task.key = true;
        task.character = true;
        task.text = std::move(text);
        task.virtual_key = static_cast<std::uint32_t>(task.text.front());
        task.scan_code = (static_cast<std::uint32_t>(lparam) >> 16) & 0xff;
        if (lparam & (1LL << 24))
          task.scan_code |= 0xe000;
        HKL layout = GetKeyboardLayout(0);
        task.keyboard_layout = static_cast<std::uint64_t>(reinterpret_cast<uintptr_t>(layout));
        task.dom_virtual_key = MapVirtualKeyExW(task.scan_code, MAPVK_VSC_TO_VK_EX, layout);
        task.modifiers = Modifiers();
        task.repeat = (lparam & (1LL << 30)) != 0;
        p.Enqueue(std::move(task));
      }
    }
    return 0;
  }
  if (message == WM_IME_COMPOSITION) {
    HIMC context = ImmGetContext(p.window);
    if (context) {
      auto read = [&](DWORD kind) {
        const LONG bytes = ImmGetCompositionStringW(context, kind, nullptr, 0);
        if (bytes <= 0 || bytes > 65536 || bytes % sizeof(wchar_t))
          return std::wstring{};
        std::wstring text(static_cast<size_t>(bytes) / sizeof(wchar_t), L'\0');
        ImmGetCompositionStringW(context, kind, text.data(), bytes);
        return text;
      };
      if (lparam & GCS_RESULTSTR)
        p.Text(L"ime_commit", read(GCS_RESULTSTR));
      if (lparam & GCS_COMPSTR) {
        const auto text = read(GCS_COMPSTR);
        LONG cursor = ImmGetCompositionStringW(context, GCS_CURSORPOS, nullptr, 0);
        cursor = std::clamp<LONG>(cursor, 0, static_cast<LONG>(text.size()));
        Task task;
        task.target = p.focused;
        task.event = "{\"type\":\"ime_set\",\"text\":" + JsonText(text) +
                     ",\"selection_start\":" + std::to_string(cursor) +
                     ",\"selection_end\":" + std::to_string(cursor) + '}';
        p.Enqueue(std::move(task));
      }
      ImmReleaseContext(p.window, context);
    }
    return 0;
  }
  if (message == WM_IME_CHAR)
    return 0;
  if (message == WM_IME_ENDCOMPOSITION) {
    Task task;
    task.target = p.focused;
    task.event = "{\"type\":\"ime_finish\"}";
    p.Enqueue(std::move(task));
    return 0;
  }
  if (message == WM_POINTERDOWN || message == WM_POINTERUPDATE || message == WM_POINTERUP ||
      message == WM_POINTERCAPTURECHANGED) {
    POINTER_TOUCH_INFO info{};
    const UINT32 id = GET_POINTERID_WPARAM(wparam);
    if (!GetPointerTouchInfo(id, &info))
      return std::nullopt;
    POINT point = info.pointerInfo.ptPixelLocation;
    ScreenToClient(p.window, &point);
    const bool down = message == WM_POINTERDOWN;
    const bool end = message == WM_POINTERUP || message == WM_POINTERCAPTURECHANGED;
    if (down && p.touches.empty()) {
      p.touch_target = p.HitTest(point.x, point.y);
      p.Focus(p.touch_target);
    }
    if (!p.touch_target)
      return 0;
    if (down)
      p.touches[id] = p.touch_target;
    if (!p.touches.contains(id))
      return 0;
    const auto target = p.PositionFor(p.touch_target, point.x, point.y);
    Task task;
    task.target = target;
    const char* action = message == WM_POINTERCAPTURECHANGED ? "cancel"
                         : down                              ? "start"
                         : end                               ? "end"
                                                             : "move";
    const double pressure = (info.touchMask & TOUCH_MASK_PRESSURE) ? info.pressure / 1024.0 : .5;
    task.event = "{\"type\":\"touch\",\"action\":\"" + std::string(action) +
                 "\",\"points\":[{\"id\":" + std::to_string(id) +
                 ",\"x\":" + std::to_string(target.x) + ",\"y\":" + std::to_string(target.y) +
                 ",\"pressure\":" + std::to_string(pressure) + "}]}";
    p.Enqueue(std::move(task));
    if (message == WM_POINTERCAPTURECHANGED)
      p.touches.clear();
    else if (end)
      p.touches.erase(id);
    if (p.touches.empty())
      p.touch_target = {};
    return 0;
  }
  const bool mouse = message >= WM_MOUSEFIRST && message <= WM_MOUSELAST;
  if (mouse) {
    // Touch is handled through WM_POINTER, so discard promoted mouse messages.
    if ((GetMessageExtraInfo() & 0xffffff80) == 0xff515780)
      return 0;
    int x = GET_X_LPARAM(lparam), y = GET_Y_LPARAM(lparam);
    if (message == WM_MOUSEWHEEL || message == WM_MOUSEHWHEEL) {
      POINT point{x, y};
      ScreenToClient(p.window, &point);
      x = point.x;
      y = point.y;
    }
    const bool down = message == WM_LBUTTONDOWN || message == WM_RBUTTONDOWN ||
                      message == WM_MBUTTONDOWN || message == WM_LBUTTONDBLCLK ||
                      message == WM_RBUTTONDBLCLK || message == WM_MBUTTONDBLCLK ||
                      message == WM_XBUTTONDOWN || message == WM_XBUTTONDBLCLK;
    const bool up = message == WM_LBUTTONUP || message == WM_RBUTTONUP || message == WM_MBUTTONUP ||
                    message == WM_XBUTTONUP;
    Target target = p.captured ? p.PositionFor(p.captured, x, y) : p.HitTest(x, y);
    if (!target)
      return 0;
    if (down) {
      SetFocus(p.window);
      p.Focus(target);
      p.captured = target;
      SetCapture(p.window);
    }
    Task task;
    task.target = target;
    const auto xy = ",\"x\":" + std::to_string(target.x) + ",\"y\":" + std::to_string(target.y);
    if (message == WM_MOUSEWHEEL || message == WM_MOUSEHWHEEL) {
      const double delta = static_cast<short>(HIWORD(wparam));
      task.event = "{\"type\":\"wheel\"" + xy +
                   ",\"dx\":" + std::to_string(message == WM_MOUSEHWHEEL ? delta : 0.) +
                   ",\"dy\":" + std::to_string(message == WM_MOUSEWHEEL ? delta : 0.) +
                   ",\"modifiers\":" + std::to_string(Modifiers()) + '}';
    } else if (down || up || message == WM_MOUSEMOVE) {
      const int button =
          (message == WM_LBUTTONDOWN || message == WM_LBUTTONUP || message == WM_LBUTTONDBLCLK) ? 1
          : (message == WM_MBUTTONDOWN || message == WM_MBUTTONUP || message == WM_MBUTTONDBLCLK)
              ? 2
          : (message == WM_RBUTTONDOWN || message == WM_RBUTTONUP || message == WM_RBUTTONDBLCLK)
              ? 3
          : (message == WM_XBUTTONDOWN || message == WM_XBUTTONUP || message == WM_XBUTTONDBLCLK)
              ? (GET_XBUTTON_WPARAM(wparam) == XBUTTON1 ? 4 : 5)
              : 0;
      int clicks = 0;
      if (down) {
        const DWORD now = static_cast<DWORD>(GetMessageTime());
        const bool repeated =
            button == p.click_button && target.view.webview_id == p.click_view &&
            target.output_generation == p.click_generation &&
            now - p.click_time <= GetDoubleClickTime() &&
            std::abs(x - p.click_position.x) <= GetSystemMetrics(SM_CXDOUBLECLK) / 2 &&
            std::abs(y - p.click_position.y) <= GetSystemMetrics(SM_CYDOUBLECLK) / 2;
        p.click_count = repeated && p.click_count < 3 ? p.click_count + 1 : 1;
        p.click_button = button;
        p.click_position = {x, y};
        p.click_time = now;
        p.click_view = target.view.webview_id;
        p.click_generation = target.output_generation;
        clicks = p.click_count;
        p.pressed_click_counts[button] = clicks;
      } else if (up) {
        auto previous = p.pressed_click_counts.find(button);
        clicks = previous != p.pressed_click_counts.end() ? previous->second : 1;
        p.pressed_click_counts.erase(button);
      }
      task.coalesce = message == WM_MOUSEMOVE;
      task.event = "{\"type\":\"mouse\",\"action\":\"" +
                   std::string(down ? "down"
                               : up ? "up"
                                    : "move") +
                   '"' + xy + ",\"button\":" + std::to_string(button) +
                   ",\"click_count\":" + std::to_string(clicks) +
                   ",\"modifiers\":" + std::to_string(Modifiers()) + '}';
    } else
      return std::nullopt;
    p.Enqueue(std::move(task));
    if (up && !(wparam & (MK_LBUTTON | MK_MBUTTON | MK_RBUTTON | MK_XBUTTON1 | MK_XBUTTON2))) {
      p.captured = {};
      ReleaseCapture();
    }
    return 0;
  }
  return std::nullopt;
}
}  // namespace remotekit
#endif
