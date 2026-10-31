#pragma once
#ifdef _WIN32
#include <windows.h>
#include <memory>
#include <optional>
#include <string>

namespace remotekit {
// Native demo adapter. All Mojo calls run on its worker; the window sequence
// only polls shared metadata and submits GPU work and input tasks.
class AtlasClient {
 public:
  AtlasClient(HWND window, std::wstring sdk_path, std::string channel);
  ~AtlasClient();
  bool Start();
  void Poll();
  void Resize();
  // Configuration message only (e.g. WM_SIZE minimization), never per frame.
  void SetOutputEnabled(bool enabled);
  bool ready() const;
  const std::wstring& error() const;
  std::optional<LRESULT> HandleMessage(UINT message, WPARAM wparam, LPARAM lparam);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
}  // namespace remotekit
#endif
