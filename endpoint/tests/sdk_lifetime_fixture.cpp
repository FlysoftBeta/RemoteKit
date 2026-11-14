#include <windows.h>

extern "C" __declspec(dllexport) int FixtureShutdown() {
  return 0;
}
