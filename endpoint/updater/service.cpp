#include "service.hpp"

namespace remotekit::updater {
namespace {
Service selected{};
fs::path service_root;
HANDLE stop_event = nullptr;
SERVICE_STATUS_HANDLE status_handle = nullptr;
SERVICE_STATUS status{};
void Status(DWORD state, DWORD code = 0, DWORD hint = 0) {
  status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
  status.dwCurrentState = state;
  status.dwControlsAccepted =
      state == SERVICE_RUNNING ? SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN : 0;
  status.dwWin32ExitCode = code;
  status.dwServiceSpecificExitCode = code == ERROR_SERVICE_SPECIFIC_ERROR ? 1 : 0;
  status.dwWaitHint = hint;
  status.dwCheckPoint = (state == SERVICE_START_PENDING || state == SERVICE_STOP_PENDING) ? 1 : 0;
  SetServiceStatus(status_handle, &status);
}
DWORD WINAPI Control(DWORD code, DWORD, void*, void*) {
  if (code == SERVICE_CONTROL_STOP || code == SERVICE_CONTROL_SHUTDOWN) {
    Status(SERVICE_STOP_PENDING, 0, 65000);
    SetEvent(stop_event);
  } else if (code == SERVICE_CONTROL_INTERROGATE)
    SetServiceStatus(status_handle, &status);
  return NO_ERROR;
}
void WINAPI ServiceMain(DWORD, wchar_t**) {
  Handle stop(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  stop_event = stop.value;
  status_handle = RegisterServiceCtrlHandlerExW(selected.name, Control, nullptr);
  if (!status_handle)
    return;
  Status(SERVICE_START_PENDING, 0, 5000);
  Status(SERVICE_RUNNING);
  int code = 1;
  try {
    code = selected.supervise(service_root, stop.value, true);
  } catch (...) {
  }
  Status(SERVICE_STOPPED, code ? ERROR_SERVICE_SPECIFIC_ERROR : NO_ERROR);
  stop_event = nullptr;
}
struct ServiceHandle {
  SC_HANDLE value;
  ~ServiceHandle() {
    if (value)
      CloseServiceHandle(value);
  }
};
Error Failure(const char* message) {
  return {ErrorCode::kUnavailable, message};
}
}  // namespace
int RunService(const fs::path& root, const Service& service) {
  selected = service;
  service_root = root;
  SERVICE_TABLE_ENTRYW table[] = {{const_cast<wchar_t*>(selected.name), ServiceMain},
                                  {nullptr, nullptr}};
  return StartServiceCtrlDispatcherW(table) ? 0 : 1;
}
Result<void> InstallService(const fs::path& root, const Service& specification) {
  fs::create_directories(root);
  auto target = root / specification.executable, source = ExecutablePath();
  if (!fs::exists(target) || !fs::equivalent(target, source))
    if (!CopyFileW(source.c_str(), target.c_str(), FALSE))
      return Failure("cannot copy service executable");
  ServiceHandle manager{OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CREATE_SERVICE)};
  if (!manager.value)
    return Failure("cannot open service manager");
  auto command = Quote(target.wstring()) + L" service --root=" + Quote(root.wstring());
  // SC_ACTION_RESTART failure actions require SERVICE_START on the handle.
  ServiceHandle service{CreateServiceW(
      manager.value, specification.name, specification.display_name,
      SERVICE_CHANGE_CONFIG | SERVICE_START | DELETE, SERVICE_WIN32_OWN_PROCESS,
      SERVICE_AUTO_START, SERVICE_ERROR_NORMAL, command.c_str(), nullptr, nullptr, nullptr, nullptr,
      nullptr)};
  if (!service.value)
    return Failure("cannot register supervisor service");
  SC_ACTION action{SC_ACTION_RESTART, 5000};
  SERVICE_FAILURE_ACTIONSW recovery{};
  recovery.dwResetPeriod = 86400;
  recovery.cActions = 1;
  recovery.lpsaActions = &action;
  SERVICE_FAILURE_ACTIONS_FLAG flag{TRUE};
  if (!ChangeServiceConfig2W(service.value, SERVICE_CONFIG_FAILURE_ACTIONS, &recovery) ||
      !ChangeServiceConfig2W(service.value, SERVICE_CONFIG_FAILURE_ACTIONS_FLAG, &flag)) {
    DeleteService(service.value);
    return Failure("cannot configure service recovery");
  }
  return {};
}
Result<void> UninstallService(const Service& specification) {
  ServiceHandle manager{OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT)};
  if (!manager.value)
    return Failure("cannot open service manager");
  ServiceHandle service{OpenServiceW(manager.value, specification.name,
                                     DELETE | SERVICE_STOP | SERVICE_QUERY_STATUS)};
  if (!service.value)
    return Failure("cannot open supervisor service");
  SERVICE_STATUS state{};
  ControlService(service.value, SERVICE_CONTROL_STOP, &state);
  if (!DeleteService(service.value))
    return Failure("cannot remove supervisor service");
  return {};
}
}  // namespace remotekit::updater
