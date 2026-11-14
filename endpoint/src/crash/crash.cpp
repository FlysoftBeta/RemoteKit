#include "crash/crash.hpp"
#include "util/log.hpp"
#include <windows.h>
#include <dbghelp.h>
#include <tlhelp32.h>
#include <signal.h>
#include <crtdbg.h>
#include <array>
#include <cstdio>
#include <limits>
#include <string>
#include <vector>

namespace remotekit {
namespace {
struct Handle {
  HANDLE value = nullptr;
  ~Handle() {
    if (value && value != INVALID_HANDLE_VALUE)
      CloseHandle(value);
  }
};
struct Shared {
  DWORD pid, thread;
  volatile LONG handling;
  EXCEPTION_POINTERS* pointers;
  wchar_t root[32768];
  char proc[64];
};
Shared* shared = nullptr;
HANDLE signal_event = nullptr, handler_process = nullptr;
LONG WINAPI Filter(EXCEPTION_POINTERS* pointers) {
  if (!shared)
    return EXCEPTION_CONTINUE_SEARCH;
  if (InterlockedCompareExchange(&shared->handling, 1, 0) == 0) {
    shared->pointers = pointers;
    shared->thread = GetCurrentThreadId();
    MemoryBarrier();
    SetEvent(signal_event);
  }
  WaitForSingleObject(handler_process, INFINITE);
  TerminateProcess(GetCurrentProcess(), pointers->ExceptionRecord->ExceptionCode);
  return EXCEPTION_EXECUTE_HANDLER;
}
void RaiseInvalidParameter(const wchar_t*, const wchar_t*, const wchar_t*, unsigned, uintptr_t) {
  RaiseException(0xC000000D, EXCEPTION_NONCONTINUABLE, 0, nullptr);
}
void RaisePurecall() {
  RaiseException(0xC000000D, EXCEPTION_NONCONTINUABLE, 0, nullptr);
}
void RaiseAbort(int) {
  RaiseException(0xC0000409, EXCEPTION_NONCONTINUABLE, 0, nullptr);
}
std::string Hex(DWORD64 value) {
  char text[32];
  snprintf(text, sizeof(text), "0x%llx", static_cast<unsigned long long>(value));
  return text;
}
std::string Address(HANDLE process, DWORD64 address, bool symbols) {
  IMAGEHLP_MODULE64 module{};
  module.SizeOfStruct = sizeof(module);
  std::string name = "unknown";
  DWORD64 base = 0;
  if (SymGetModuleInfo64(process, address, &module)) {
    name = module.ModuleName;
    base = module.BaseOfImage;
  }
  if (symbols) {
    alignas(SYMBOL_INFO) std::array<char, sizeof(SYMBOL_INFO) + MAX_SYM_NAME> storage{};
    auto* symbol = reinterpret_cast<SYMBOL_INFO*>(storage.data());
    symbol->SizeOfStruct = sizeof(SYMBOL_INFO);
    symbol->MaxNameLen = MAX_SYM_NAME;
    DWORD64 displacement = 0;
    if (SymFromAddr(process, address, &displacement, symbol))
      return name + "!" + symbol->Name + "+" + Hex(displacement);
  }
  return name + "+" + Hex(address - base);
}
void SuspendHost(DWORD pid) {
  Handle snapshot{CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)};
  THREADENTRY32 entry{sizeof(entry)};
  if (!Thread32First(snapshot.value, &entry))
    return;
  do {
    if (entry.th32OwnerProcessID == pid) {
      Handle thread{OpenThread(THREAD_SUSPEND_RESUME, FALSE, entry.th32ThreadID)};
      if (thread.value)
        SuspendThread(thread.value);
    }
  } while (Thread32Next(snapshot.value, &entry));
}
void RecordCrash(const Shared& state, HANDLE process) {
  SuspendHost(state.pid);
  EXCEPTION_POINTERS pointers{};
  EXCEPTION_RECORD exception{};
  CONTEXT context{};
  if (!ReadProcessMemory(process, state.pointers, &pointers, sizeof(pointers), nullptr) ||
      !ReadProcessMemory(process, pointers.ExceptionRecord, &exception, sizeof(exception),
                         nullptr) ||
      !ReadProcessMemory(process, pointers.ContextRecord, &context, sizeof(context), nullptr)) {
    TerminateProcess(process, 0xC0000005);
    return;
  }
  const fs::path root(state.root);
  SYSTEMTIME local{};
  GetLocalTime(&local);
  char timestamp[32];
  snprintf(timestamp, sizeof(timestamp), "%04u%02u%02uT%02u%02u%02u", local.wYear, local.wMonth,
           local.wDay, local.wHour, local.wMinute, local.wSecond);
  const auto relative =
      fs::path("crashes") / state.proc /
      (std::string(state.proc) + "-" + std::to_string(state.pid) + "-" + timestamp + ".dmp");
  std::error_code error;
  fs::create_directories((root / relative).parent_path(), error);
  Handle dump{CreateFileW((root / relative).c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                          CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr)};
  MINIDUMP_EXCEPTION_INFORMATION info{state.thread, state.pointers, TRUE};
  const auto flags = static_cast<MINIDUMP_TYPE>(
      MiniDumpNormal | MiniDumpWithIndirectlyReferencedMemory | MiniDumpWithThreadInfo);
  const bool dumped =
      dump.value != INVALID_HANDLE_VALUE &&
      MiniDumpWriteDump(process, state.pid, dump.value, flags, &info, nullptr, nullptr);
  SymSetOptions(SYMOPT_UNDNAME | SYMOPT_DEFERRED_LOADS | SYMOPT_LOAD_LINES |
                SYMOPT_FAIL_CRITICAL_ERRORS | SYMOPT_NO_PROMPTS);
  std::wstring symbol_path;
  Handle modules{CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, state.pid)};
  MODULEENTRY32W module{sizeof(module)};
  if (Module32FirstW(modules.value, &module)) {
    do {
      if (!symbol_path.empty())
        symbol_path += L";";
      symbol_path += fs::path(module.szExePath).parent_path().wstring();
    } while (Module32NextW(modules.value, &module));
  }
  const bool initialized = SymInitializeW(process, symbol_path.c_str(), TRUE) != FALSE;
  const auto fault_address = reinterpret_cast<DWORD64>(exception.ExceptionAddress);
  Json stack = Json::array({Address(process, fault_address, true)});
  STACKFRAME64 frame{};
#if defined(_M_X64)
  frame.AddrPC.Offset = context.Rip;
  frame.AddrFrame.Offset = context.Rbp;
  frame.AddrStack.Offset = context.Rsp;
  constexpr DWORD machine = IMAGE_FILE_MACHINE_AMD64;
#else
#error RemoteKit crash handler requires x64
#endif
  frame.AddrPC.Mode = frame.AddrFrame.Mode = frame.AddrStack.Mode = AddrModeFlat;
  Handle thread{OpenThread(THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION, FALSE, state.thread)};
  for (unsigned i = 0; initialized && i < 64; ++i) {
    if (!StackWalk64(machine, process, thread.value, &frame, &context, nullptr,
                     SymFunctionTableAccess64, SymGetModuleBase64, nullptr) ||
        !frame.AddrPC.Offset)
      break;
    if (frame.AddrPC.Offset != fault_address || stack.size() > 1)
      stack.push_back(Address(process, frame.AddrPC.Offset, true));
  }
  const auto address = Address(process, fault_address, false);
  if (initialized)
    SymCleanup(process);
  // A crash record remains available even when ordinary logging exhausted its budget.
  DailyLog log(root, state.proc, state.pid, LogClock::now, 64 * 1024 * 1024,
               std::numeric_limits<uint64_t>::max());
  log.Write(LogLevel::kError, "process.crashed",
            {{"code", exception.ExceptionCode},
             {"codeName", ExceptionCodeName(exception.ExceptionCode)},
             {"address", address},
             {"stack", std::move(stack)},
             {"threadId", state.thread},
             {"dump", dumped ? Json(relative.generic_string()) : Json(nullptr)}});
  TerminateProcess(process, exception.ExceptionCode);
}
void Handler(const std::wstring& name) {
  Handle mapping{OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, name.c_str())};
  if (!mapping.value)
    return;
  auto* state =
      static_cast<Shared*>(MapViewOfFile(mapping.value, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(Shared)));
  if (!state)
    return;
  Handle event{OpenEventW(SYNCHRONIZE, FALSE, (name + L".crash").c_str())};
  Handle ready{OpenEventW(EVENT_MODIFY_STATE, FALSE, (name + L".ready").c_str())};
  Handle host{OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_DUP_HANDLE |
                              PROCESS_TERMINATE | SYNCHRONIZE,
                          FALSE, state->pid)};
  if (event.value && ready.value && host.value) {
    SetEvent(ready.value);
    HANDLE waits[] = {host.value, event.value};
    if (WaitForMultipleObjects(2, waits, FALSE, INFINITE) == WAIT_OBJECT_0 + 1) {
      try {
        RecordCrash(*state, host.value);
      } catch (...) {
        TerminateProcess(host.value, 0xC0000005);
      }
    }
  }
  UnmapViewOfFile(state);
}
}  // namespace
bool RunCrashHandler(int argc, wchar_t** argv) {
  if (argc != 2 || !std::wstring_view(argv[1]).starts_with(L"--crash-handler="))
    return false;
  Handler(argv[1] + 16);
  return true;
}
bool RunCrashHandler(int argc, char** argv) {
  if (argc != 2 || !std::string_view(argv[1]).starts_with("--crash-handler="))
    return false;
  const std::string name(argv[1] + 16);
  Handler(std::wstring(name.begin(), name.end()));
  return true;
}
void InstallCrashHandler(const fs::path& logs_root, std::string_view proc) {
  const auto unavailable = [] {
    LogError(LogLevel::kWarn, "crash.handler_unavailable",
             WithOsError(ErrorCode::kUnavailable, "cannot start crash handler",
                         OsError::Kind::kWin32, GetLastError()));
  };
  const auto name = L"Local\\RemoteKit.crash." + std::to_wstring(GetCurrentProcessId()) + L"." +
                    std::to_wstring(GetTickCount64());
  Handle mapping{CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0,
                                    sizeof(Shared), name.c_str())};
  Handle event{CreateEventW(nullptr, TRUE, FALSE, (name + L".crash").c_str())};
  Handle ready{CreateEventW(nullptr, TRUE, FALSE, (name + L".ready").c_str())};
  if (!mapping.value || !event.value || !ready.value) {
    unavailable();
    return;
  }
  auto* state =
      static_cast<Shared*>(MapViewOfFile(mapping.value, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(Shared)));
  if (!state) {
    unavailable();
    return;
  }
  state->pid = GetCurrentProcessId();
  const auto root = fs::absolute(logs_root).wstring();
  if (root.size() >= std::size(state->root) || proc.size() >= std::size(state->proc)) {
    UnmapViewOfFile(state);
    unavailable();
    return;
  }
  wcscpy_s(state->root, root.c_str());
  memcpy(state->proc, proc.data(), proc.size());
  state->proc[proc.size()] = 0;
  wchar_t executable[32768];
  GetModuleFileNameW(nullptr, executable, std::size(executable));
  auto command = L"\"" + std::wstring(executable) + L"\" --crash-handler=" + name;
  STARTUPINFOW startup{sizeof(startup)};
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(executable, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
                      nullptr, nullptr, &startup, &process)) {
    UnmapViewOfFile(state);
    unavailable();
    return;
  }
  CloseHandle(process.hThread);
  HANDLE waits[] = {ready.value, process.hProcess};
  if (WaitForMultipleObjects(2, waits, FALSE, 10000) != WAIT_OBJECT_0) {
    TerminateProcess(process.hProcess, 1);
    CloseHandle(process.hProcess);
    UnmapViewOfFile(state);
    unavailable();
    return;
  }
  // These handles and the mapping stay alive for the host's lifetime.
  shared = state;
  signal_event = event.value;
  event.value = nullptr;
  handler_process = process.hProcess;
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
  ULONG guarantee = 64 * 1024;
  SetThreadStackGuarantee(&guarantee);
  SetUnhandledExceptionFilter(Filter);
  _set_invalid_parameter_handler(RaiseInvalidParameter);
  _set_purecall_handler(RaisePurecall);
  _set_abort_behavior(0, _WRITE_ABORT_MSG | _CALL_REPORTFAULT);
  signal(SIGABRT, RaiseAbort);
}
}  // namespace remotekit
