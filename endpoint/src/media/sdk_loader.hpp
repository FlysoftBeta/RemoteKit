#pragma once
#include "remotekit_sdk.h"
#include "remotekit_rtc.h"
#include <windows.h>
#include <filesystem>
#include <stdexcept>
namespace remotekit::media {
struct Sdk {
 HMODULE module=nullptr;
 int (*encoder_drop)(uint64_t,uint32_t)=nullptr;
 int (*request_stats)(uint64_t)=nullptr;
 decltype(&remotekit_rtc_sample_clock) sample_clock=nullptr;
#define RK_SDK_FUNCTION(name) decltype(&name) name=nullptr;
 RK_SDK_FUNCTION(remotekit_sdk_initialize)
 RK_SDK_FUNCTION(remotekit_sdk_shutdown)
 RK_SDK_FUNCTION(remotekit_sdk_control_connect)
 RK_SDK_FUNCTION(remotekit_sdk_control_close)
 RK_SDK_FUNCTION(remotekit_sdk_control_request)
 RK_SDK_FUNCTION(remotekit_sdk_control_open_atlas)
 RK_SDK_FUNCTION(remotekit_rtc_get_receive_level)
 RK_SDK_FUNCTION(remotekit_rtc_set_playout_delay)
 RK_SDK_FUNCTION(remotekit_rtc_create)
 RK_SDK_FUNCTION(remotekit_rtc_close)
 RK_SDK_FUNCTION(remotekit_rtc_set_media_policy)
 RK_SDK_FUNCTION(remotekit_rtc_set_remote_description)
 RK_SDK_FUNCTION(remotekit_rtc_add_ice)
 RK_SDK_FUNCTION(remotekit_rtc_open_data_channel)
 RK_SDK_FUNCTION(remotekit_rtc_send_data)
 RK_SDK_FUNCTION(remotekit_rtc_submit_texture)
 RK_SDK_FUNCTION(remotekit_rtc_submit_audio)
 RK_SDK_FUNCTION(remotekit_rtc_encoded)
#undef RK_SDK_FUNCTION
 void Open(const std::filesystem::path& path) {
  module=LoadLibraryExW(path.c_str(),nullptr,LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
  if(!module)throw std::runtime_error("Cannot load SDK runtime beside browser: Windows "+std::to_string(GetLastError()));
#define RK_LOAD(name) name=reinterpret_cast<decltype(name)>(GetProcAddress(module,#name));if(!name)throw std::runtime_error("SDK missing " #name);
 RK_LOAD(remotekit_sdk_initialize) RK_LOAD(remotekit_sdk_shutdown)
 RK_LOAD(remotekit_sdk_control_connect) RK_LOAD(remotekit_sdk_control_close) RK_LOAD(remotekit_sdk_control_request)
 RK_LOAD(remotekit_sdk_control_open_atlas) RK_LOAD(remotekit_rtc_create) RK_LOAD(remotekit_rtc_close)
 RK_LOAD(remotekit_rtc_set_remote_description) RK_LOAD(remotekit_rtc_add_ice)
 RK_LOAD(remotekit_rtc_open_data_channel) RK_LOAD(remotekit_rtc_send_data)
 RK_LOAD(remotekit_rtc_get_receive_level)
 RK_LOAD(remotekit_rtc_set_media_policy)
 RK_LOAD(remotekit_rtc_set_playout_delay)
 RK_LOAD(remotekit_rtc_submit_texture) RK_LOAD(remotekit_rtc_encoded)
 RK_LOAD(remotekit_rtc_submit_audio)
#undef RK_LOAD
  sample_clock=reinterpret_cast<decltype(sample_clock)>(GetProcAddress(module,"remotekit_rtc_sample_clock"));
  request_stats=reinterpret_cast<decltype(request_stats)>(GetProcAddress(module,"remotekit_rtc_request_stats"));
  encoder_drop=reinterpret_cast<decltype(encoder_drop)>(GetProcAddress(module,"remotekit_rtc_encoder_drop"));
  if(remotekit_sdk_initialize()!=0)throw std::runtime_error("SDK initialization failed");
 }
 ~Sdk(){if(module){if(remotekit_sdk_shutdown)remotekit_sdk_shutdown();FreeLibrary(module);}}
};
}
