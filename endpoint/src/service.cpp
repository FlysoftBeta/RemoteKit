#include "media/atlas_pool.hpp"
#include "media/encoder_worker.hpp"
#include "media/sdk_loader.hpp"
#include "media/audio_ring.hpp"
#include "remotekit/file_upload.hpp"
#include "remotekit/core.hpp"
#include "remotekit/sampling.hpp"
#include "remotekit/idle_idr.hpp"
#include "remotekit/tail_refresh.hpp"
#include "remotekit/media_feedback.hpp"
#include "remotekit/adaptive_fps.hpp"
#include "remotekit/capture_clock.hpp"
#include "remotekit/atlas_dimensions.hpp"
#include "remotekit/atlas_plan.hpp"
#include "remotekit/coordinate_readiness.hpp"
#include "remotekit/input_sequence.hpp"
#include "remotekit/presentation_barrier.hpp"
#include <charconv>
#include <json.hpp>
#include <windows.h>
#include <mmsystem.h>
#include <wincrypt.h>
#include <objbase.h>
#include <fcntl.h>
#include <io.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <mutex>
#include <set>
#include <sstream>
#include <thread>
#include <atomic>
#include <array>
using Json=nlohmann::json;
using namespace remotekit::media;
namespace fs=std::filesystem;
namespace {
std::string Env(const char* key,std::string fallback={}) {const char* v=std::getenv(key);return v?v:fallback;}
fs::path Utf8Path(const std::string& value){return fs::u8path(value);}
std::string Utf8(const fs::path& path){auto v=path.u8string();return {reinterpret_cast<const char*>(v.data()),v.size()};}
std::wstring Quote(const std::wstring& value) {
 std::wstring result=L"\"";size_t slashes=0;
 for(auto c:value){if(c==L'\\'){++slashes;continue;}if(c==L'\"'){result.append(slashes*2+1,L'\\');result+=c;}
  else{result.append(slashes,L'\\');result+=c;}slashes=0;}
 result.append(slashes*2,L'\\');return result+L"\"";
}
void SaveJson(const fs::path& path,const Json& value) {
 fs::create_directories(path.parent_path());auto temporary=path;temporary+=L".new";
 {std::ofstream file(temporary,std::ios::binary);file<<value.dump(2);if(!file)throw std::runtime_error("state write failed");}
 if(!MoveFileExW(temporary.c_str(),path.c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH))
  throw std::runtime_error("state commit failed");
}
Json LoadJson(const fs::path& path,Json fallback=Json::object()) {
 std::ifstream file(path,std::ios::binary);if(!file)return fallback;Json result;file>>result;return result;
}
std::string Required(const Json& object,const char* name) {
 if(!object.contains(name)||!object[name].is_string()||object[name].get<std::string>().empty())
  throw std::runtime_error(std::string("required string: ")+name);
 return object[name].get<std::string>();
}
std::string NewIncarnation() {
 GUID value{};if(FAILED(CoCreateGuid(&value)))throw std::runtime_error("browser incarnation generation failed");
 const auto* bytes=reinterpret_cast<const unsigned char*>(&value);std::string result;
 for(size_t i=0;i<sizeof(value);++i){result+="0123456789abcdef"[bytes[i]>>4];result+="0123456789abcdef"[bytes[i]&15];}
 return result;
}
std::string ViewId(const Json& request) {
 auto id=Required(request,"viewId");
 if(id.size()>20||id[0]=='0'||!std::all_of(id.begin(),id.end(),[](char c){return c>='0'&&c<='9';}))
  throw std::runtime_error("viewId must be nonzero uint64 decimal");
 try{if(std::stoull(id)==0)throw std::runtime_error("invalid viewId");}catch(...){throw std::runtime_error("viewId out of uint64 range");}
 return id;
}
size_t DecodedSize(const std::string& text) {
 DWORD size=0;
 if(!CryptStringToBinaryA(text.data(),static_cast<DWORD>(text.size()),CRYPT_STRING_BASE64,nullptr,&size,nullptr,nullptr))
  throw std::runtime_error("invalid navigation base64");
 std::vector<BYTE> bytes(size);
 if(!CryptStringToBinaryA(text.data(),static_cast<DWORD>(text.size()),CRYPT_STRING_BASE64,bytes.data(),&size,nullptr,nullptr))
  throw std::runtime_error("invalid navigation bytes");
 return size;
}
struct Options {
 fs::path browser,data,browser_trace_directory;
 std::string encoder="qsv",browser_enable_features,browser_disable_features,browser_direct_composition="auto",browser_host_scale="auto",browser_render_host="offscreen";EncoderSettings encoding;
 uint32_t idle_idr_ms=150,max_encode_width=4096,max_encode_height=4096,browser_render_fps=0;
 uint32_t atlas_allocation_alignment=16;
 bool adaptive_fps=false;
 std::string atlas_input="auto";
 bool qsv_low_power_explicit=false;
 int32_t rtc_playout_max_ms=-1;
 Options() {
  wchar_t executable[32768]{};GetModuleFileNameW(nullptr,executable,32768);
  browser=Utf8Path(Env("REMOTEKIT_BROWSER",Utf8(fs::path(executable).parent_path()/"remotekit_browser.exe")));
  data=Utf8Path(Env("REMOTEKIT_DATA_PATH",Env("LOCALAPPDATA",".")+"/RemoteKit/streaming"));
  encoder=Env("REMOTEKIT_ENCODER","qsv");encoding.bitrate=36000000;encoding.max_bitrate=48000000;
 }
 void Parse(int argc,char** argv) {
  for(int i=1;i<argc;++i){std::string arg=argv[i];auto equal=arg.find('=');
   if(equal==std::string::npos)throw std::runtime_error("arguments require --name=value");
   auto key=arg.substr(0,equal),value=arg.substr(equal+1);
   if(key=="--browser")browser=Utf8Path(value);else if(key=="--data-path")data=Utf8Path(value);
   else if(key=="--browser-enable-features")browser_enable_features=value;
   else if(key=="--browser-disable-features")browser_disable_features=value;
   else if(key=="--browser-direct-composition"){
    if(value!="auto"&&value!="off")throw std::runtime_error("browser-direct-composition must be auto or off");
    browser_direct_composition=value;
   }
   else if(key=="--browser-host-scale"){
    if(value!="auto"&&value!="1")throw std::runtime_error("browser-host-scale must be auto or 1");
    browser_host_scale=value;
   }
   else if(key=="--browser-render-host"){
    if(value!="offscreen"&&value!="window")throw std::runtime_error("browser-render-host must be offscreen or window");
    browser_render_host=value;
   }
   else if(key=="--browser-render-fps"){
    if(value.empty()||!std::all_of(value.begin(),value.end(),[](char c){return c>='0'&&c<='9';})||std::stoul(value)>60)
     throw std::runtime_error("browser-render-fps must be an integer in 0..60");
    browser_render_fps=std::stoul(value);
   }
   else if(key=="--adaptive-fps") {
    if(value!="off"&&value!="on")throw std::runtime_error("adaptive-fps must be off or on");
    adaptive_fps=value=="on";
   }
   else if(key=="--browser-trace-dir")browser_trace_directory=Utf8Path(value);
   else if(key=="--encoder")encoder=value;
   else if(key=="--atlas-input") {
    if(value!="auto"&&value!="copy"&&value!="shared")throw std::runtime_error("atlas-input must be auto, copy or shared");
    atlas_input=value;
   }
   else if(key=="--qsv-vpp"){
    if(value!="external"&&value!="async")throw std::runtime_error("qsv-vpp must be external or async");
    encoding.qsv_async_vpp=value=="async";
   }
   else if(key=="--atlas-alignment"){
    if(value!="1"&&value!="16")throw std::runtime_error("atlas-alignment must be 1 or 16");
    atlas_allocation_alignment=value=="16"?16:1;
   }
   else if(key=="--fps")encoding.fps=std::stoul(value);
   else if(key=="--bitrate")encoding.bitrate=std::stoul(value);
   else if(key=="--max-bitrate")encoding.max_bitrate=std::stoul(value);
   else if(key=="--async-depth")encoding.async_depth=std::stoul(value);
   else if(key=="--gop")encoding.gop=std::stoul(value);
   else if(key=="--target-usage"){encoding.target_usage=std::stoul(value);encoding.target_usage_explicit=true;}
   else if(key=="--qsv-low-power"){
    if(value!="auto"&&value!="on"&&value!="off")throw std::runtime_error("qsv-low-power must be auto, on or off");
    encoding.qsv_low_power=value=="on"?0x10u:(value=="off"?0x20u:0u);
    qsv_low_power_explicit=true;encoding.qsv_low_power_explicit=true;
   }
   else if(key=="--buffer-ms")encoding.buffer_ms=std::stoul(value);
   else if(key=="--rate-control"){if(value!="cbr"&&value!="vbr")throw std::runtime_error("rate-control must be cbr or vbr");encoding.vbr=value=="vbr";encoding.rate_control_explicit=true;}
   else if(key=="--idle-idr-ms")idle_idr_ms=std::stoul(value);
   else if(key=="--rtc-playout-max-ms"){
    size_t parsed=0;rtc_playout_max_ms=std::stoi(value,&parsed);
    if(parsed!=value.size())throw std::runtime_error("rtc-playout-max-ms must be an integer");
   }
   else if(key=="--max-encode-width")max_encode_width=std::stoul(value);
   else if(key=="--max-encode-height")max_encode_height=std::stoul(value);
   else throw std::runtime_error("unknown endpoint argument: "+key);
  }
  if((encoder!="auto"&&encoder!="qsv"&&encoder!="nvenc")||encoding.fps<1||encoding.fps>120||
     encoding.async_depth<1||encoding.async_depth>8||encoding.target_usage<1||encoding.target_usage>7||
     encoding.bitrate<100000||encoding.bitrate>50000000||encoding.max_bitrate>60000000||encoding.bitrate>encoding.max_bitrate||
     encoding.gop<1||encoding.gop>65535||encoding.buffer_ms<50||encoding.buffer_ms>5000||
     max_encode_width<16||max_encode_height<16||max_encode_width>4096||max_encode_height>4096)
   throw std::runtime_error("invalid encoder settings");
  browser=fs::absolute(browser);data=fs::absolute(data);
  if(encoding.qsv_async_vpp && (encoder!="qsv" || atlas_allocation_alignment!=16))
   throw std::runtime_error("qsv-vpp=async requires encoder=qsv and atlas-alignment=16");
  if(atlas_input=="shared" && (encoder!="qsv" || encoding.qsv_async_vpp || encoding.async_depth!=1))
   throw std::runtime_error("atlas-input=shared requires encoder=qsv, qsv-vpp=external and async-depth=1");
  if(atlas_input=="auto")atlas_input=encoder=="qsv"&&!encoding.qsv_async_vpp&&encoding.async_depth==1?"shared":"copy";
  if(!qsv_low_power_explicit && encoder!="nvenc")encoding.qsv_low_power=0x10u;
  if(encoder=="nvenc"&&encoding.qsv_low_power)throw std::runtime_error("qsv-low-power requires qsv or auto encoder");
  if(rtc_playout_max_ms!=-1&&(rtc_playout_max_ms<0||rtc_playout_max_ms>40950||rtc_playout_max_ms%10))
   throw std::runtime_error("rtc-playout-max-ms must be -1 or a multiple of 10 in 0..40950");
  if(adaptive_fps && !browser_render_fps && encoding.fps>60)
   throw std::runtime_error("adaptive-fps=on with fps>60 requires browser-render-fps in 1..60");
 }
};
struct Session {
 Sdk& sdk;Options options;std::string tenant,id;fs::path directory;
 HANDLE process=nullptr,job=nullptr;std::atomic<uint64_t> control{0};int request_id=0;
 bool producer_stop_pending=false;
 bool process_in_job=false;
 std::string browser_incarnation,process_incarnation;
 remotekit::FileUploadStore file_uploads;
 std::mutex rpc_mutex;
 std::map<std::string,Json> desired;
 int atlas_width=1920,atlas_height=1080;float atlas_scale=1;
 AtlasPool pool;std::thread media_thread;std::atomic<bool> stop_media{false};
 AudioRing audio_ring;std::thread audio_thread;std::atomic<bool> stop_audio{false};
 std::atomic<uint64_t> audio_gaps{0},audio_submitted{0},audio_rejected{0};
 remotekit::CoordinateReadiness coordinate_readiness;
 std::atomic<uint64_t> peer{0};std::string connection;
 std::shared_ptr<EncoderStats> stats=std::make_shared<EncoderStats>();
 remotekit::MediaFeedback media_feedback;
 std::mutex adaptive_mutex;remotekit::AdaptiveFps adaptive;
 std::mutex budget_control_mutex;std::condition_variable budget_wake;std::thread budget_thread;
 std::atomic<bool> budget_eligible{false};std::atomic<uint64_t> budget_epoch{0};
 bool stop_budget=false,adaptive_applied_known=false;
 struct BudgetRequest {uint64_t epoch;uint32_t target;};
 std::optional<BudgetRequest> pending_budget;
 std::mutex encoder_mutex;std::map<uint64_t,std::unique_ptr<EncoderWorker>> encoders;
 ComPtr<ID3D11Device> encoder_device;
 struct Event{uint32_t type;std::string bytes,auxiliary;int32_t value;uint64_t peer;};
 std::mutex event_mutex;std::condition_variable event_wake;std::deque<Event> events;
 std::mutex signal_mutex;std::string answer,rtc_error;bool ice_complete=false;
 std::atomic<bool> trickle_signals{false};std::deque<Event> signal_events;bool signal_overflow=false;
 std::condition_variable signal_wake;
 std::mutex input_mutex;std::condition_variable input_wake;std::deque<Event> input_queue;
 remotekit::InputSequence input_sequence;
 std::thread input_thread;std::atomic<bool> stop_input{false};
 std::atomic<uint64_t> input_rejected{0},input_coalesced{0};
 std::atomic<uint64_t> input_busy_retries{0},input_busy_exhausted{0};
 Json layout;std::atomic<bool> data_open{false};
 Json site_preferences=Json::object();
 std::mutex media_policy_mutex;Json requested_media_policy=nullptr;
 std::atomic<uint32_t> policy_fps{0},policy_bitrate{0},policy_max{0};
 std::atomic<uint32_t> policy_requested_fps{0},policy_source_width{0},policy_source_height{0};
 std::atomic<bool> policy_prefer_resolution{false};
 std::atomic<double> capture_clock_uncertainty_ms{0};
 Json durable_events=Json::array();uint64_t next_event=1;
 std::set<std::string> observed_closed;
 std::atomic<bool> output_suspended{false},has_visible_output{false},reconciliation_pending{false};
 int64_t next_reconciliation=0;
 std::string current_geometry;
 std::map<std::pair<uint64_t,uint64_t>,uint64_t> publication_epochs;
 std::atomic<uint64_t> layout_epoch{0};
 remotekit::PresentationBarrier presentation;
 std::atomic<uint32_t> receive_level{0};
 enum class ConnectionPhase : size_t {answer,first_candidate,gather_complete,connected,data_open,output_open_start,output_open_end,source_frame,submit,encoder_configure_start,encoder_configure_end,encoded,count};
 std::atomic<int64_t> connection_started_qpc{0};
 std::array<std::atomic<int64_t>,static_cast<size_t>(ConnectionPhase::count)> connection_phases{};
 void MarkConnection(ConnectionPhase phase) {
  auto& stamp=connection_phases[static_cast<size_t>(phase)];
  if(!stamp.load()) {int64_t empty=0;stamp.compare_exchange_strong(empty,QpcNow());}
 }
 Json ConnectionTimings() const {
  constexpr const char* names[]={"answerReady","firstCandidate","gatherComplete","connected","dataChannelOpen","outputOpenStart","outputOpenEnd","firstSourceFrame","firstSubmit","encoderConfigureStart","encoderConfigureEnd","firstEncoded"};
  const auto started=connection_started_qpc.load();Json phases=Json::object();
  if(started)for(size_t i=0;i<connection_phases.size();++i)if(const auto at=connection_phases[i].load();at>=started)phases[names[i]]=1000.0*(at-started)/QpcFrequency();
  return phases;
 }
 std::atomic<bool> refresh_connected{false};
 std::atomic<int64_t> last_media_refresh_qpc{0};
 // MediaLoop snapshots the policy once per iteration so layout and texture
 // submission cannot use different sampling budgets during a policy update.
 uint32_t sampling_fps=60;
 uint32_t SamplingFps() const {return sampling_fps;}
 std::atomic<bool> rtc_connected{false};
 std::atomic<uint32_t> effective_idle_ms{150};
 std::atomic<double> source_interval_ms{0},last_tail_age_ms{0};
 std::atomic<uint64_t> tail_submissions{0},tail_completions{0};
 remotekit::MediaSampling sampling;
 std::shared_ptr<ServerTrace> trace;
 std::map<std::string,std::string> recovery_revisions;
 struct Recovery {
  std::string phase="load",error,transfer;
  Json saved;
  size_t chunk=0;uint64_t offset=0,buffer_bytes=0;
  int64_t deadline=0,next_poll=0;
  bool Pending() const {return phase!="complete" && phase!="fallback_started" && phase!="failed";}
 };
 std::map<std::string,Recovery> recoveries;
 std::string recovery_cursor;
 Session(Sdk& api,const Options& opts,std::string tenant_id,std::string session_id):sdk(api),options(opts),
   tenant(std::move(tenant_id)),id(std::move(session_id)),directory(options.data/"sessions"/id),file_uploads(directory/"uploads"),
   adaptive(options.adaptive_fps,options.browser_render_fps?options.browser_render_fps:options.encoding.fps) {
  effective_idle_ms=std::min(1000u,options.idle_idr_ms);
  trace=ServerTrace::Create(tenant,id);pool.SetTrace(trace);
  fs::create_directories(directory);
  auto saved=LoadJson(directory/"views.json",Json::array());
  site_preferences=LoadJson(directory/"site-preferences.json",Json::object());
  auto event_state=LoadJson(directory/"events.json",{{"next",1},{"events",Json::array()}});
  next_event=event_state.value("next",uint64_t(1));durable_events=event_state.value("events",Json::array());
  for(auto& view:saved)desired[ViewId(view)]=view;
  bool reconciled_closed=false;
  for(const auto& event:durable_events)if(event.value("type",std::string())=="view.closed")
   reconciled_closed=desired.erase(event.at("viewId").get<std::string>())!=0 || reconciled_closed;
  if(reconciled_closed)Save();
  budget_thread=std::thread([this]{BudgetLoop();});
 }
 ~Session(){
  StopBudget();
  try{Stop();}catch(...){fprintf(stderr,"session shutdown unfinished; atlas resources retained\n");}
  // Final OS handle cleanup is not proof of process exit. AtlasPool retains
  // any unsafe generation when its own destructor cannot establish a drain.
  if(job){CloseHandle(job);job=nullptr;}
  if(process){CloseHandle(process);process=nullptr;}
 }
 void Save(){Json values=Json::array();for(auto& [view,config]:desired)values.push_back(config);SaveJson(directory/"views.json",values);}
 void SaveEvents(){SaveJson(directory/"events.json",{{"next",next_event},{"events",durable_events}});}
 void RecordClosed(const std::string& view,const std::string& reason) {
  if(!observed_closed.contains(view)) {
   const bool recorded=std::any_of(durable_events.begin(),durable_events.end(),[&](const Json& event){
    return event.value("type",std::string())=="view.closed" && event.value("viewId",std::string())==view;
   });
   if(!recorded) {
    if(durable_events.size()>=256)throw std::runtime_error("closed event backlog full; acknowledge events before reconciliation");
    auto closed_events=durable_events;
    closed_events.push_back({{"eventId",std::to_string(next_event)},{"type","view.closed"},{"viewId",view},{"reason",reason}});
    SaveJson(directory/"events.json",{{"next",next_event+1},{"events",closed_events}});
    durable_events=std::move(closed_events);++next_event;
   }
   // Event is durable first. A crash before the second save is repaired by
   // constructor replay, which removes these IDs before starting a Browser.
   if(desired.contains(view)) {
    Json remaining=Json::array();for(const auto& [view_id,config]:desired)if(view_id!=view)remaining.push_back(config);
    SaveJson(directory/"views.json",remaining);desired.erase(view);
   }
   observed_closed.insert(view);
  }
  recoveries.erase(view);recovery_revisions.erase(view);fs::remove(directory/"recovery"/(view+".json"));
 }
 void AckClosed(const Json& views) {
  if(!views.empty())Rpc({{"method","view.closed.ack"},{"session",id},{"views",views},{"browserIncarnation",browser_incarnation}});
 }
 Json Rpc(Json command) {
  std::lock_guard lock(rpc_mutex);
  if(!control)throw std::runtime_error("browser control unavailable");
  command["version"]=1;command["id"]=++request_id;
  std::string encoded=command.dump();std::vector<char> response(1024*1024);size_t count=0;
  int status=sdk.remotekit_sdk_control_request(control,encoded.data(),encoded.size(),response.data(),response.size(),&count,10000);
  if(status!=0){control=0;throw std::runtime_error("browser request transport "+std::to_string(status)+
    " method="+command.value("method",std::string())+" "+ProcessDiagnostic()+
    " browser_log="+Utf8(directory/"browser.log"));}
  Json result=Json::parse(response.data(),response.data()+count);
  if(!result.value("ok",false))throw std::runtime_error("browser: "+result.value("error",std::string("command failed")));
  return result;
 }
 bool Alive() const{return process&&WaitForSingleObject(process,0)==WAIT_TIMEOUT;}
 bool ProducerExited() const{return process&&WaitForSingleObject(process,0)==WAIT_OBJECT_0;}
 std::string ProcessDiagnostic() const {
  if(!process)return "process=absent";
  std::ostringstream detail;detail<<"pid="<<GetProcessId(process);
  const auto wait=WaitForSingleObject(process,0);
  detail<<" process="<<(wait==WAIT_TIMEOUT?"running":wait==WAIT_OBJECT_0?"exited":"query-failed");
  if(wait==WAIT_FAILED)detail<<" wait_windows="<<GetLastError();
  DWORD code=0;
  if(GetExitCodeProcess(process,&code))detail<<" exit_code=0x"<<std::hex<<code;
  else detail<<" exit_query_windows="<<GetLastError();
  return detail.str();
 }
 void Start() {
  if(!producer_stop_pending && Alive()&&control)return;
  if(!Stop())throw std::runtime_error("previous browser termination unfinished; retry the retained producer before restart");
  job=CreateJobObjectW(nullptr,nullptr);if(!job)throw std::runtime_error("CreateJobObject failed");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits)))throw std::runtime_error("job limits failed");
  std::string channel="RemoteKit.service."+std::to_string(GetCurrentProcessId())+"."+id+"."+std::to_string(QpcNow());
  browser_incarnation=NewIncarnation();
  std::wstring command=Quote(options.browser.wstring());
  auto append=[&](std::wstring arg){command+=L" "+Quote(arg);};
  append(L"--control-channel="+std::wstring(channel.begin(),channel.end()));
  append(L"--browser-incarnation="+std::wstring(browser_incarnation.begin(),browser_incarnation.end()));
  append(L"--session-id="+std::wstring(id.begin(),id.end()));
  append(L"--tenant-id="+std::wstring(id.begin(),id.end()));
  append(L"--data-path="+directory.wstring());
  append(L"--atlas-width=1920");append(L"--atlas-height=1080");
  append(L"--remotekit-render-host="+std::wstring(options.browser_render_host.begin(),options.browser_render_host.end()));
  if(options.browser_direct_composition=="off")append(L"--disable-direct-composition");
  if(options.browser_host_scale=="1")append(L"--force-device-scale-factor=1");
  if(!options.browser_enable_features.empty())
   append(L"--enable-features="+std::wstring(options.browser_enable_features.begin(),options.browser_enable_features.end()));
  if(!options.browser_disable_features.empty())
   append(L"--disable-features="+std::wstring(options.browser_disable_features.begin(),options.browser_disable_features.end()));
  if(!options.browser_trace_directory.empty()) {
   fs::create_directories(options.browser_trace_directory);
   const auto file=options.browser_trace_directory/("session-"+id+"-"+std::to_string(QpcNow())+".json");
   append(L"--trace-startup=gpu.capture,viz,gpu,toplevel,toplevel.flow,disabled-by-default-gpu.service,disabled-by-default-gpu.device");
   append(L"--trace-startup-duration=16");append(L"--trace-startup-format=json");
   append(L"--trace-startup-file="+file.wstring());
   append(L"--trace-startup-record-mode=record-until-full");
   append(L"--default-trace-buffer-size-limit-in-kb=32768");
  }
  fprintf(stderr,"session %s browser command %s\n",id.c_str(),Utf8(fs::path(command)).c_str());
  STARTUPINFOW startup{};startup.cb=sizeof(startup);startup.dwFlags=STARTF_USESHOWWINDOW;startup.wShowWindow=SW_HIDE;
  PROCESS_INFORMATION info{};
  if(!CreateProcessW(options.browser.c_str(),command.data(),nullptr,nullptr,FALSE,CREATE_SUSPENDED|CREATE_NO_WINDOW,
       nullptr,options.browser.parent_path().c_str(),&startup,&info))throw std::runtime_error("browser launch Windows "+std::to_string(GetLastError()));
  process=info.hProcess;
  process_incarnation=browser_incarnation;
  process_in_job=false;
  if(!AssignProcessToJobObject(job,process)) {
   const auto error=GetLastError();CloseHandle(info.hThread);
   // This exact process was created suspended by us and never joined the job.
   // Terminating the empty job cannot release it. Retain the process handle
   // for Stop's confirmation/retry even if the targeted termination fails.
   const bool terminated=TerminateProcess(process,1)!=FALSE;
   const auto waited=WaitForSingleObject(process,5000);
   fprintf(stderr,"unassigned browser cleanup terminated=%d wait=%lu\n",terminated,waited);
   throw std::runtime_error("browser job assignment Windows "+std::to_string(error)+" "+ProcessDiagnostic());
  }
  process_in_job=true;
  if(ResumeThread(info.hThread)==DWORD(-1)) {
   const auto error=GetLastError();CloseHandle(info.hThread);
   throw std::runtime_error("browser resume Windows "+std::to_string(error)+" "+ProcessDiagnostic());
  }
  CloseHandle(info.hThread);
  fprintf(stderr,"session %s browser launched pid %lu browser_log=%s\n",id.c_str(),GetProcessId(process),Utf8(directory/"browser.log").c_str());
  const auto started=QpcNow(),deadline=started+QpcFrequency()*15;
  int status=1;unsigned attempts=0;
  while(Alive()&&QpcNow()<deadline) {
   uint64_t connected_control=0;
   ++attempts;
   status=sdk.remotekit_sdk_control_connect(channel.c_str(),&connected_control);
   if(status==0)control=connected_control;
   if(status==0)break;std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
  if(status!=0||!control)throw std::runtime_error("browser control connect failed "+std::to_string(status)+
    " "+ProcessDiagnostic()+" elapsed_ms="+std::to_string((QpcNow()-started)*1000/QpcFrequency())+
    " attempts="+std::to_string(attempts)+" browser_log="+Utf8(directory/"browser.log"));
  fprintf(stderr,"session %s browser pid %lu\n",id.c_str(),GetProcessId(process));
  observed_closed.clear();
  recovery_revisions.clear();recoveries.clear();recovery_cursor.clear();
  Rpc({{"method","session.sitePreferences"},{"session",id},{"sites",site_preferences}});
  if(!desired.empty()) {
   // Hidden construction never requires the previous/final atlas to fit an
   // intermediate set of specs. One transaction applies the complete layout.
   for(auto& [view,config]:desired)CreateView(config,true);
   GeometryConfig(DesiredGeometry());
  }
  reconciliation_pending=false;
 }
 Json BrowserSnapshot(){return Rpc({{"method","snapshot"}});}
 struct Geometry {int width=16,height=16;float scale=1;};
 Geometry DesiredGeometry() {
  std::vector<remotekit::PackItem> items;float scale=.5f;
  for(auto& [view,config]:desired) {
   if(!config.value("visible",false))continue;
   const auto device=config.value("device",Json::object());
   int w=config.value("width",device.value("width",1440));
   int h=config.value("height",device.value("height",900));
   if(w<1||h<1||w>8192||h>8192)throw std::runtime_error("invalid viewport dimensions");
   items.push_back({std::stoull(view),w,h,1.0});
   scale=std::max(scale,device.value("deviceScaleFactor",1.0f));
  }
  const auto plan=remotekit::PlanAtlas(items,items.empty()?1.f:scale,options.atlas_allocation_alignment);
  if(!plan)throw std::runtime_error("visible source atlas cannot be packed within the aligned 16-megapixel/8192-pixel resource budget");
  return {plan->width,plan->height,plan->scale};
 }
 bool PauseOutput() {
  DisableBudget();
  const bool active=peer.load()!=0;
  if(active){stop_media=true;event_wake.notify_all();if(media_thread.joinable())media_thread.join();}
  InvalidateLayout("output-paused");
  try{Rpc({{"method","output.close"}});}
  catch(const std::exception& error){fprintf(stderr,"output close unfinished: %s; resources retained until producer stop confirmed\n",error.what());}
  return active;
 }
 void GeometryConfig(const Geometry& value) {
  if(!remotekit::AtlasAllocationDimensions(value.width,value.height,value.scale,options.atlas_allocation_alignment))
   throw std::runtime_error("source atlas exceeds the aligned 16-megapixel/8192-pixel resource budget");
  Json configs=Json::array();
  bool visible_output=false;
  for(const auto& [view,config]:desired) {
   const auto device=config.value("device",Json::object());
   const bool visible=!Recovering(view)&&config.value("visible",false);visible_output|=visible;
   configs.push_back({{"session",id},{"view",view},
     {"width",config.value("width",device.value("width",1440))},
     {"height",config.value("height",device.value("height",900))},
     {"device",device.value("mode",std::string("desktop"))},
     {"device_scale_factor",device.value("deviceScaleFactor",1.0f)},
     {"visible",visible}});
  }
  Rpc({{"method","output.configure"},{"width",value.width},{"height",value.height},{"viewConfigs",std::move(configs)},
       {"device_scale",value.scale},{"allocation_alignment",options.atlas_allocation_alignment},
       {"fps",policy_fps.load()?policy_fps.load():options.encoding.fps},{"render_fps",policy_fps.load()?policy_fps.load():options.browser_render_fps}});
  atlas_width=value.width;atlas_height=value.height;atlas_scale=value.scale;
  has_visible_output=visible_output;
  {std::lock_guard lock(adaptive_mutex);adaptive.Applied(adaptive.requested());adaptive_applied_known=true;
   adaptive.Reset(1000.0*QpcNow()/QpcFrequency(),AdaptiveCounters());}
 }
 void RefitOutput() {
  const auto geometry=DesiredGeometry();
  if(!reconciliation_pending && geometry.width==atlas_width&&geometry.height==atlas_height&&geometry.scale==atlas_scale)return;
  ReconcileOutput();
 }
 void ResumeOutput(bool active) {
  if(!active)return;
  OpenOutput();layout=Json();stop_media=false;
  media_thread=std::thread([this]{MediaLoop();});
  EnableBudget();
 }
 void ReconcileOutput() {
  const bool active=PauseOutput();
  try{GeometryConfig(DesiredGeometry());Save();ResumeOutput(active);reconciliation_pending=false;}
  catch(...) {reconciliation_pending=true;next_reconciliation=QpcNow()+QpcFrequency();output_suspended=true;throw;}
 }
 Json ApplyView(const Json& config,bool create,bool recovering=false) {
  auto view=ViewId(config);auto old=desired.find(view);
  Json previous=old==desired.end()?Json():old->second;
  auto normalized=[](Json value){value.erase("id");value.erase("method");return value;};
  if(!previous.is_null() && normalized(previous)==normalized(config)) {
   if(reconciliation_pending || (output_suspended && has_visible_output && rtc_connected))ReconcileOutput();
   return {{"accepted",true},{"completed",true}};
  }
  bool source_applied=false;
  desired[view]=config;Geometry geometry;
  try{geometry=DesiredGeometry();}catch(...){if(previous.is_null())desired.erase(view);else desired[view]=previous;throw;}
  const bool active=PauseOutput();
  try {
   Json result={{"accepted",true},{"completed",true}};
   if(create){result=CreateView(config,recovering);source_applied=true;}
   GeometryConfig(geometry);
   source_applied=true;
   reconciliation_pending=true;Save();ResumeOutput(active);reconciliation_pending=false;return result;
  } catch(const std::exception& failure) {
   const std::string original=failure.what();
   // Before commit the candidate can be discarded. After a source/adoption
   // commit the accepted desired state must survive persistence/media failure.
   if(!source_applied){if(previous.is_null())desired.erase(view);else desired[view]=previous;}
   reconciliation_pending=true;next_reconciliation=QpcNow()+QpcFrequency();output_suspended=true;
   {std::lock_guard lock(stats->mutex);stats->error=original;}
   throw;
  }
 }
 Json CreateView(const Json& config,bool recovering=false) {
  auto view=ViewId(config);auto device=config.value("device",Json::object());
  std::string mode=device.is_object()?device.value("mode",std::string("desktop")):std::string("desktop");
  Json request={{"method","view.create"},{"session",id},{"view",view},{"url",recovering && fs::exists(directory/"recovery"/(view+".json")) ? std::string("about:blank") : config.value("url",std::string("about:blank"))},
    {"width",config.value("width",device.value("width",1440))},{"height",config.value("height",device.value("height",900))},
    {"device",mode},{"visible",false}};
  if(!recovering && config.value("method",std::string())=="view.adopt") {
   request["method"]="view.adopt";request["provisionalId"]=Required(config,"provisionalId");
  }
  if(device.contains("deviceScaleFactor"))request["device_scale_factor"]=device["deviceScaleFactor"];
  if(recovering && fs::exists(directory/"recovery"/(view+".json")))request["visible"]=false;
  auto result=Rpc(request);
  if(recovering && fs::exists(directory/"recovery"/(view+".json")))recoveries[view]=Recovery{};
  return result;
 }
 bool Recovering(const std::string& view) const {
  const auto found=recoveries.find(view);return found!=recoveries.end() && found->second.Pending();
 }
 Json RecoveryStatus(const Recovery& recovery) const {
  return {{"pending",recovery.Pending()},{"phase",recovery.phase},{"error",recovery.error}};
 }
 Json RecoverySnapshot() const {
  Json views=Json::object();bool pending=false;
  for(const auto& [view,recovery]:recoveries){views[view]=RecoveryStatus(recovery);pending|=recovery.Pending();}
  return {{"pending",pending},{"views",std::move(views)}};
 }
 bool CancelRecovery(const std::string& view) {
  auto found=recoveries.find(view);if(found==recoveries.end())return false;
  const bool pending=found->second.Pending();const auto transfer=found->second.transfer;
  recoveries.erase(found);recovery_revisions.erase(view);
  if(!transfer.empty() && control) {
   try{Rpc({{"method","navigation.transfer.cancel"},{"session",id},{"view",view},{"transfer",transfer}});}
   catch(const std::exception& error){fprintf(stderr,"recovery transfer cancel: %s\n",error.what());}
  }
  return pending;
 }
 // Called only by the JSONL dispatcher. One phase/one selected view per turn;
 // never sleep or poll inside a phase. Media/input workers do not own this map.
 void MaintainRecovery() {
  if(reconciliation_pending && Alive() && control && !producer_stop_pending && QpcNow()>=next_reconciliation) {
   try{ReconcileOutput();}catch(const std::exception& error){fprintf(stderr,"session %s reconciliation: %s\n",id.c_str(),error.what());}
   return;
  }
  if(recoveries.empty() || !Alive() || !control || producer_stop_pending)return;
  auto selected=recoveries.upper_bound(recovery_cursor);
  const auto now=QpcNow();
  for(size_t count=0;count<recoveries.size();++count) {
   if(selected==recoveries.end())selected=recoveries.begin();
   if(selected->second.Pending() && selected->second.next_poll<=now)break;
   ++selected;
  }
  if(selected==recoveries.end() || !selected->second.Pending() || selected->second.next_poll>now)return;
  const auto view=selected->first;recovery_cursor=view;auto& task=selected->second;
  if(!desired.contains(view)){CancelRecovery(view);return;}
  try {
   if(task.phase=="load") {
    const auto path=directory/"recovery"/(view+".json");
    const auto file_bytes=fs::file_size(path);
    if(file_bytes>96*1024*1024)throw std::runtime_error("navigation recovery file exceeds bound");
    uint64_t buffered=0;for(const auto& [key,recovery]:recoveries)buffered+=recovery.buffer_bytes;
    if(buffered+file_bytes>96*1024*1024){task.next_poll=now+QpcFrequency()/20;return;}
    task.saved=LoadJson(path);const auto size=std::stoull(task.saved.at("size").get<std::string>());
    if(!size || size>64*1024*1024 || !task.saved.at("chunks").is_array() || task.saved["chunks"].size()>256)
     throw std::runtime_error("invalid navigation recovery size/chunks");
    task.buffer_bytes=file_bytes;
    task.phase="settling";task.deadline=now+QpcFrequency();
   } else if(task.phase=="settling" || task.phase=="waiting") {
    const auto snapshot=BrowserSnapshot();const Json* current=nullptr;
    for(const auto& session:snapshot.at("sessions"))for(const auto& candidate:session.at("views"))
     if(candidate.value("view",std::string())==view)current=&candidate;
    if(!current || current->value("close_state",std::string())=="closed") {CancelRecovery(view);return;}
    if(task.phase=="settling") {
     if(!current->value("loading",false) || now>=task.deadline)task.phase="unload";
    } else if(!current->value("pending",true)) {
     const auto last=current->value("last_lifecycle",Json::object());
     if(current->value("actual",-1)!=0 || !last.value("succeeded",false))
      throw std::runtime_error(last.value("detail",std::string("navigation recovery failed")));
     task.phase="visible";
    } else if(now>=task.deadline)throw std::runtime_error("navigation recovery did not finish");
    task.next_poll=now+QpcFrequency()/20;
   } else if(task.phase=="unload") {
    Rpc({{"method","lifecycle"},{"session",id},{"view",view},{"action","unload"}});task.phase="begin";
   } else if(task.phase=="begin") {
    auto reply=Rpc({{"method","navigation.import.begin"},{"session",id},{"view",view},{"size",task.saved.at("size")}});
    task.transfer=reply.at("transfer");task.phase="chunks";
   } else if(task.phase=="chunks") {
    if(task.chunk==task.saved.at("chunks").size()){task.phase="commit";return;}
    const auto& chunk=task.saved["chunks"][task.chunk];const auto bytes=chunk.at("bytes").get<uint64_t>();
    if(!bytes || bytes>256*1024 || DecodedSize(chunk.at("data").get<std::string>())!=bytes)
     throw std::runtime_error("invalid navigation recovery chunk");
    Rpc({{"method","navigation.import.chunk"},{"session",id},{"view",view},{"transfer",task.transfer},
         {"offset",std::to_string(task.offset)},{"data",chunk.at("data")}});
    task.offset+=bytes;++task.chunk;
   } else if(task.phase=="commit") {
    Rpc({{"method","navigation.import.commit"},{"session",id},{"view",view},{"transfer",task.transfer}});
    task.transfer.clear();task.saved=nullptr;task.buffer_bytes=0;task.phase="restore";
   } else if(task.phase=="restore") {
    Rpc({{"method","lifecycle"},{"session",id},{"view",view},{"action","restore"}});
    task.phase="waiting";task.deadline=now+QpcFrequency()*11;
   } else if(task.phase=="visible") {
    task.phase="complete";
    try{ReconcileOutput();}catch(const std::exception& error){task.error=error.what();}
   } else if(task.phase=="fallback") {
    // Fresh GET of the product URL, never automatic replay of imported POST.
    Rpc({{"method","view.recreate"},{"session",id},{"view",view},
         {"url",desired.at(view).value("url",std::string("about:blank"))}});
    task.saved=nullptr;task.buffer_bytes=0;task.transfer.clear();task.phase="fallback_started";
    try{ReconcileOutput();}catch(const std::exception& error){task.error+="; output reconciliation: "+std::string(error.what());}
   }
  } catch(const std::exception& error) {
   fprintf(stderr,"session %s view %s navigation recovery: %s\n",id.c_str(),view.c_str(),error.what());
   task.error=error.what();task.saved=nullptr;task.buffer_bytes=0;task.phase=task.phase=="fallback"?"failed":"fallback";
  }
 }
 void CaptureNavigation(const Json& browser_view) {
  if(!browser_view.contains("navigationRevision")||browser_view.value("loading",false)||browser_view.value("pending",false))return;
  const std::string view=browser_view.at("view"),revision=browser_view.at("navigationRevision");
  if(Recovering(view) || recovery_revisions[view]==revision)return;
  try {
   auto begin=Rpc({{"method","navigation.export.begin"},{"session",id},{"view",view}});
   auto transfer=begin.at("transfer");uint64_t size=std::stoull(begin.at("size").get<std::string>()),offset=0;
   Json chunks=Json::array();
   while(offset<size) {
    const auto count=std::min<uint64_t>(size-offset,256*1024);
    auto chunk=Rpc({{"method","navigation.export.chunk"},{"session",id},{"view",view},
      {"transfer",transfer},{"offset",std::to_string(offset)},{"length",count}});
    if(DecodedSize(chunk.at("data").get<std::string>())!=count)throw std::runtime_error("navigation export chunk length mismatch");
    chunks.push_back({{"data",chunk.at("data")},{"bytes",count}});offset+=count;
   }
   Rpc({{"method","navigation.transfer.cancel"},{"session",id},{"view",view},{"transfer",transfer}});
   SaveJson(directory/"recovery"/(view+".json"),{{"size",std::to_string(size)},{"chunks",chunks},{"navigationRevision",begin.at("navigationRevision")}});
   recovery_revisions[view]=begin.at("navigationRevision").get<std::string>();
  }catch(const std::exception& error){fprintf(stderr,"navigation save: %s\n",error.what());}
 }
 remotekit::AdaptiveFps::Counters AdaptiveCounters() const {
  return {stats->completed.load(),stats->pending_replaced.load(),stats->queue_wait_us.load(),stats->queue_wait_samples.load()};
 }
 // Caller holds media_policy_mutex. The existing SDK policy updates sender
 // limits; workers and Browser source budgets use the same codec-limited FPS.
 void ApplyMediaCeiling(uint32_t fps,uint32_t bitrate,uint32_t maximum) {
  const bool fps_changed=policy_fps.load()!=fps;
  const auto old_fps=policy_fps.load(),old_bitrate=policy_bitrate.load(),old_maximum=policy_max.load();
  // SDK SetParameters can synchronously reconfigure the external encoder.
  // Its callback must already observe the new legal codec ceiling.
  policy_fps=fps;policy_bitrate=bitrate;policy_max=maximum;
  if(peer && sdk.remotekit_rtc_set_media_policy(peer,bitrate,maximum,fps)!=0) {
   policy_fps=old_fps;policy_bitrate=old_bitrate;policy_max=old_maximum;throw std::runtime_error("RTC media policy rejected");
  }
  {std::lock_guard lock(encoder_mutex);for(auto& [encoder,worker]:encoders)worker->Policy(bitrate,maximum,fps);}
  if(fps_changed) {std::lock_guard lock(adaptive_mutex);adaptive=remotekit::AdaptiveFps(true,fps);
   adaptive.Reset(1000.0*QpcNow()/QpcFrequency(),AdaptiveCounters());adaptive_applied_known=false;
   pending_budget=BudgetRequest{budget_epoch.load(),fps};}
  EnableBudget();budget_wake.notify_one();
 }
 void RecomputeCodecCeiling(uint32_t width,uint32_t height) {
  std::lock_guard lock(media_policy_mutex);
  policy_source_width=width;policy_source_height=height;
  const auto requested=policy_requested_fps.load();if(!requested)return;
  const auto nominal=std::min(requested,options.encoding.fps);
  const auto fps=remotekit::PreferredH264FrameRate(width,height,nominal,receive_level.load(),policy_prefer_resolution.load(),options.max_encode_width,options.max_encode_height);
  if(fps!=policy_fps.load())ApplyMediaCeiling(fps,policy_bitrate.load(),policy_max.load());
 }
 void ObserveAdaptiveFps(double now,const remotekit::SharedAtlasFrame& metadata,bool delivered,bool decision) {
  if(!options.adaptive_fps && !policy_fps.load())return;
  remotekit::AdaptiveFps::Feedback feedback;
  if(decision) {
   const auto sample=media_feedback.Snapshot(QpcNow(),QpcFrequency());
   feedback.seq=sample.value("feedbackSeq",uint64_t(0));
   feedback.visible=sample.value("feedbackVisible",false);
   if(sample.contains("feedbackAgeMs"))feedback.age_ms=sample["feedbackAgeMs"].get<double>();
   if(sample.contains("feedbackDisplayHzEstimate"))feedback.display_hz=sample["feedbackDisplayHzEstimate"].get<double>();
   if(sample.contains("feedbackRoundTripTimeMs"))feedback.rtt_ms=sample["feedbackRoundTripTimeMs"].get<double>();
   // Receiver packetsLost is already a per-feedback-window delta; RTT is ms.
   if(sample.contains("feedbackPacketsLost"))feedback.lost=sample["feedbackPacketsLost"].get<uint64_t>();
  }
  const auto latency=delivered?pool.capture_to_ready_ms():std::optional<double>{};
  std::lock_guard lock(adaptive_mutex);
  if(delivered)adaptive.ObserveSource(metadata.generation,metadata.capture_time_us,now,latency);
  if(decision && adaptive.Step(now,AdaptiveCounters(),feedback) && budget_eligible.load()) {
   pending_budget=BudgetRequest{budget_epoch.load(),adaptive.target()};budget_wake.notify_one();
  }
 }
 void DisableBudget() {
  std::lock_guard control_lock(budget_control_mutex);
  budget_eligible=false;++budget_epoch;
  std::lock_guard policy_lock(adaptive_mutex);pending_budget.reset();
 }
 void EnableBudget() {
  if((!options.adaptive_fps && !policy_fps.load()) || output_suspended)return;
  std::lock_guard control_lock(budget_control_mutex);budget_eligible=true;
 }
 void StopBudget() {
  {std::lock_guard lock(adaptive_mutex);stop_budget=true;pending_budget.reset();}
  budget_wake.notify_all();if(budget_thread.joinable())budget_thread.join();
 }
 void BudgetLoop() {
  int64_t last_attempt=0;
  while(true) {
   BudgetRequest request;
   {std::unique_lock lock(adaptive_mutex);
    budget_wake.wait(lock,[&]{return stop_budget || pending_budget.has_value();});
    if(stop_budget)return;
    // Cover a slow RPC followed by an already queued decision; sends still
    // remain at least 500ms apart. This is a single replaceable request slot.
    const auto now=QpcNow();
    if(last_attempt && now-last_attempt<QpcFrequency()/2) {
     budget_wake.wait_for(lock,std::chrono::duration<double>(.5-double(now-last_attempt)/QpcFrequency()),[&]{return stop_budget;});
     if(stop_budget)return;if(!pending_budget)continue;
    }
    request=*pending_budget;pending_budget.reset();}
   std::lock_guard control_lock(budget_control_mutex);
   if(!budget_eligible.load() || request.epoch!=budget_epoch.load())continue;
   {std::lock_guard policy_lock(adaptive_mutex);
    if(stop_budget)return;
    // Re-read the latest target after taking the configuration eligibility lock.
    request.target=adaptive.target();
    if(request.target==adaptive.applied() && adaptive_applied_known)continue;}
   last_attempt=QpcNow();
   try {
     Rpc({{"method","output.configure"},{"fps",policy_fps.load()?policy_fps.load():options.encoding.fps},{"render_fps",request.target}});
    std::lock_guard policy_lock(adaptive_mutex);adaptive.Applied(request.target);adaptive_applied_known=true;
   }catch(const std::exception& error) {
    std::lock_guard policy_lock(adaptive_mutex);adaptive.Failed(error.what());
   }
  }
 }
 Json Stats() {
  auto value=stats->Snapshot();
  Json requested_policy;{std::lock_guard lock(media_policy_mutex);requested_policy=requested_media_policy;}
  value["mediaPolicy"]={{"requested",requested_policy},{"applied",{
    {"targetFps",nullptr},
    {"bitrateKbps",value.value("appliedBitrate",Json(nullptr))},
    {"maxBitrateKbps",value.value("appliedMaxBitrate",Json(nullptr))},
    {"adaptive",policy_fps.load()!=0 || options.adaptive_fps},
    {"codecTargetFps",policy_fps.load()?Json(policy_fps.load()):Json(nullptr)},
    {"preferResolution",policy_prefer_resolution.load()},
    {"fpsLimitation",policy_fps.load() && policy_fps.load()<std::min(policy_requested_fps.load(),options.encoding.fps)?"receiver-level-macroblock-rate":policy_fps.load() && policy_fps.load()<policy_requested_fps.load()?"encoder-cadence-limit":"none"}}}};
  if(!value["mediaPolicy"]["applied"]["bitrateKbps"].is_null())value["mediaPolicy"]["applied"]["bitrateKbps"]=value["mediaPolicy"]["applied"]["bitrateKbps"].get<uint32_t>()/1000;
  if(!value["mediaPolicy"]["applied"]["maxBitrateKbps"].is_null())value["mediaPolicy"]["applied"]["maxBitrateKbps"]=value["mediaPolicy"]["applied"]["maxBitrateKbps"].get<uint32_t>()/1000;
  value["configuredIdleIdrMs"]=options.idle_idr_ms;
  value["connectionTimingMs"]=ConnectionTimings();
  value["connectionTimingOrigin"]="endpoint-offer-monotonic";
  value["connectionTimingConnectionId"]=connection;
  value["qsvVpp"]=options.encoding.qsv_async_vpp?"async":"external";
  value["atlasAllocationAlignment"]=options.atlas_allocation_alignment;
  value["reconciliationPending"]=reconciliation_pending.load();
  value.update(media_feedback.Snapshot(QpcNow(),QpcFrequency()));
  {std::lock_guard lock(adaptive_mutex);
   value["mediaPolicy"]["applied"]["targetFps"]=adaptive_applied_known?Json(adaptive.applied()):Json(nullptr);
   value["adaptiveFps"]={{"enabled",adaptive.enabled()},{"requestedLimit",adaptive.requested()},
     {"effectiveLimit",adaptive.ceiling()},{"targetRenderFps",adaptive.target()},
     {"actualAppliedRenderFps",adaptive_applied_known?Json(adaptive.applied()):Json(nullptr)},
     {"reason",adaptive.reason()},{"error",adaptive.error()}};
   value["adaptiveFps"]["feedbackAgeMs"]=value.value("feedbackAgeMs",Json(nullptr));}
  const auto feedback_age=value.value("feedbackAgeMs",Json(nullptr));
  value["adaptiveFps"]["displayLimit"]=!feedback_age.is_null() && feedback_age.get<double>()<=5000 &&
    value.value("feedbackVisible",false) && value.contains("feedbackDisplayHzEstimate")?
      Json(static_cast<uint32_t>(std::ceil(value["feedbackDisplayHzEstimate"].get<double>()))):Json(nullptr);
  value["audio"]={{"submitted",audio_submitted.load()},{"gaps",audio_gaps.load()},{"rejected",audio_rejected.load()}};
  value["rtcPlayoutDelayRequested"]={{"minMs",options.rtc_playout_max_ms<0?-1:0},
                                     {"maxMs",options.rtc_playout_max_ms}};
  value["effectiveIdleIdrMs"]=effective_idle_ms.load();value["tailIdrSubmissions"]=tail_submissions.load();
  value["tailIdrCompletions"]=tail_completions.load();
  const auto interval=source_interval_ms.load(),age=last_tail_age_ms.load();
  value["sourceFrameIntervalMs"]=interval>0?Json(interval):Json(nullptr);
  value["atlasReadyGateEnabled"]=pool.ready_gate_enabled();
  value["encoderSelection"]=options.encoder;
  value["atlasInput"]=options.atlas_input;
  value["atlasSharedBorrows"]=pool.shared_borrows();
  value["atlasSharedHeldSlots"]=pool.shared_held_slots();
  value["atlasSharedRetiredPrefix"]=pool.shared_retired_prefix();
  value["atlasReadyGateDeferredPolls"]=pool.ready_gate_deferred_polls();
  value["atlasReadyGateDeferredFrames"]=pool.ready_gate_deferred_frames();
  value["lastTailAfterSourceMs"]=age>0?Json(age):Json(nullptr);return value;
 }
 Json InactiveSnapshot() {
  // Only a signaled process handle proves producer exit. Retire its GPU state
  // through the existing stop boundary; observing a Session never launches it.
  if(ProducerExited())Stop();
  return {{"sessionId",id},{"browserPid",0},{"views",Json::array()},
   {"pendingPopups",Json::array()},{"events",durable_events},{"running",false},{"browserIncarnation",nullptr},{"stats",Stats()},{"recovery",RecoverySnapshot()}};
 }
 Json Snapshot(bool output_diagnostics=false) {
  if(!Alive() || producer_stop_pending)return InactiveSnapshot();
  try {
  auto snapshot=BrowserSnapshot();Json views=Json::array(),closed_acks=Json::array();bool removed=false;
  for(auto& session:snapshot.at("sessions"))for(auto& view:session.at("views")) {
   std::string view_id=view.at("view");
   if(view.value("close_state",std::string())=="closed") {
    removed|=desired.contains(view_id);RecordClosed(view_id,view.value("close_reason",std::string("closed")));
    closed_acks.push_back(view_id);
    continue;
   }
   Json item=view;item["viewId"]=view_id;
   if(const auto recovery=recoveries.find(view_id);recovery!=recoveries.end()) {
    item["recovery"]=RecoveryStatus(recovery->second);
    item["browserPending"]=item.value("pending",false);
    // Includes Endpoint import/restore work. actual and browserPending retain
    // the observed Browser state while Control can avoid a conflicting thaw.
    item["pending"]=item.value("pending",false)||recovery->second.Pending();
    if(recovery->second.Pending()){item["browserDesired"]=item["desired"];item["desired"]=0;}
   }
   auto requests=Rpc({{"method","page.requests"},{"session",id},{"view",view_id}});
   if(view.value("close_state",std::string())=="closing")AddCloseRequest(item,requests);
   item["pageRequests"]=requests.value("requests",requests);
   CaptureNavigation(view);views.push_back(std::move(item));
  }
  if(removed)RefitOutput();
  AckClosed(closed_acks);
  // Explicit, read-only diagnostic sampling; routine Control snapshots do not
  // add an output RPC. Preserve the normal snapshot if output is unavailable.
  Json output_status;
  if(output_diagnostics) {
   try{output_status=Rpc({{"method","output.status"}});}
   catch(...){output_status={{"ok",false},{"error","output_status_unavailable"}};}
  }
  return {{"sessionId",id},{"browserPid",process?GetProcessId(process):0},{"views",views},
   {"pendingPopups",snapshot.at("sessions").at(0).value("pendingPopups",Json::array())},
   {"events",durable_events},{"running",true},{"browserIncarnation",browser_incarnation},{"stats",Stats()},{"recovery",RecoverySnapshot()},{"outputDiagnostics",std::move(output_status)}};
  }catch(...) {
   // A producer can exit between the liveness check and any snapshot RPC.
   // Preserve desired views and confirmed events; an exit is not window.close.
   if(!control || ProducerExited())return InactiveSnapshot();
   throw;
  }
 }
 static void AddCloseRequest(Json& output,const Json& requests) {
  // page.requests wraps its snapshot in "requests". Handle its documented
  // pending list without relying on JSON field order.
  const Json* data=&requests;
  if(requests.contains("requests"))data=&requests["requests"];
  if(!data->contains("pending"))return;
  for(auto& pending:(*data)["pending"]) {
   if(pending.value("kind",std::string())=="beforeunload" || pending.value("beforeunload",false)) {
    output["pending_close"]={{"requestId",pending.at("request")}};
    output["requestId"]=pending.at("request");output["pending"]=true;return;
   }
  }
 }
 bool Stop() {
  recoveries.clear();recovery_cursor.clear();recovery_revisions.clear();reconciliation_pending=false;
  has_visible_output=false;
  browser_incarnation.clear();
  producer_stop_pending=process || job;
  ClosePeer();
  if(control){sdk.remotekit_sdk_control_close(control);control=0;}
  // Keep the job/process identity until this exact process is confirmed gone.
  // Closing the job first would lose the retry identity after a stop timeout.
  if(job && !TerminateJobObject(job,0))
   fprintf(stderr,"producer job termination request failed (Windows=%lu); waiting for retained process\n",GetLastError());
  if(process) {
   if(!process_in_job && WaitForSingleObject(process,0)==WAIT_TIMEOUT && !TerminateProcess(process,1))
    fprintf(stderr,"unassigned producer termination failed (Windows=%lu); retaining exact process\n",GetLastError());
   const auto exited=WaitForSingleObject(process,5000);
   if(exited==WAIT_OBJECT_0) {
    file_uploads.ConfirmBrowserStopped(process_incarnation);process_incarnation.clear();
    // A crash may leave the last mapping status Running. Preserve confirmed
    // producer termination on retained generations before closing its handle.
    std::string error;
    if(!pool.Close(error,true))fprintf(stderr,"pool close after producer exit unfinished: %s\n",error.c_str());
   } else {
    fprintf(stderr,"producer termination not confirmed (wait=%lu); process/job identity and atlas resources retained\n",exited);
    return false;
   }
   CloseHandle(process);process=nullptr;process_in_job=false;
  }
  if(job){CloseHandle(job);job=nullptr;}
  producer_stop_pending=false;
  // A new browser may restart its local generation counters at one. Its
  // resources/documents still belong to a new presentation incarnation.
  current_geometry.clear();publication_epochs.clear();
  {std::lock_guard lock(adaptive_mutex);adaptive_applied_known=false;}
  return true;
 }
 static void EventCallback(void* context,uint64_t peer,uint32_t type,const void* bytes,size_t size,
                           const char* auxiliary,int32_t value) {
  auto* self=static_cast<Session*>(context);
  Event event{type,std::string(static_cast<const char*>(bytes?bytes:""),size),auxiliary?auxiliary:"",value,peer};
  if(peer==self->peer.load()) {
   if(type==REMOTEKIT_RTC_SDP_ANSWER)self->MarkConnection(ConnectionPhase::answer);
   else if(type==REMOTEKIT_RTC_ICE)self->MarkConnection(ConnectionPhase::first_candidate);
   else if(type==REMOTEKIT_RTC_ICE_COMPLETE)self->MarkConnection(ConnectionPhase::gather_complete);
   else if(type==REMOTEKIT_RTC_STATE && value==2)self->MarkConnection(ConnectionPhase::connected);
   else if(type==REMOTEKIT_RTC_DATA_STATE && value==1)self->MarkConnection(ConnectionPhase::data_open);
  }
  if(type==REMOTEKIT_RTC_DATA) {
   auto message=Json::parse(event.bytes,nullptr,false);
    if(message.is_object() && message.value("type",Json())=="media.refresh") {
     if(peer==self->peer.load() && size<=256) {
      const auto now=QpcNow();auto previous=self->last_media_refresh_qpc.load();
      if((!previous || now-previous>=QpcFrequency()) && self->last_media_refresh_qpc.compare_exchange_strong(previous,now)) {
       self->refresh_connected=true;self->event_wake.notify_one();
      }
     }
     return;
    }
   if(message.is_object() && message.value("type",Json())=="media.feedback") {
    self->media_feedback.Receive(peer,message,QpcNow(),size);return;
   }
  }
   if(type==REMOTEKIT_RTC_SDP_ANSWER || type==REMOTEKIT_RTC_ICE || type==REMOTEKIT_RTC_ICE_COMPLETE || type==REMOTEKIT_RTC_ERROR) {
   std::lock_guard lock(self->signal_mutex);
    if(self->trickle_signals && !self->signal_overflow) {
     if(self->signal_events.size()<256)self->signal_events.push_back(event);
     else {self->signal_events.clear();self->signal_overflow=true;self->signal_events.push_back(Event{REMOTEKIT_RTC_ERROR,"RTC signaling queue exceeded bound","",0,peer});}
    }
   if(type==REMOTEKIT_RTC_ICE_COMPLETE){self->answer=event.bytes;self->ice_complete=true;}
    else if(type==REMOTEKIT_RTC_ERROR)self->rtc_error=event.bytes;
   self->signal_wake.notify_all();
  }
  {std::lock_guard lock(self->event_mutex);if(self->events.size()<1024)self->events.push_back(std::move(event));}
  self->event_wake.notify_all();
 }
 static int CreateEncoder(void* context,uint64_t encoder_peer,uint64_t encoder) {
  auto* self=static_cast<Session*>(context);std::lock_guard lock(self->encoder_mutex);
  self->encoders.emplace(encoder,std::make_unique<EncoderWorker>(self->sdk,encoder,self->encoder_device.Get(),
         self->options.encoder,self->options.encoding,self->stats,
      [self,encoder_peer,first_encoded=true](uint32_t timestamp,uint64_t epoch,size_t encoded_bytes,bool keyframe,const remotekit_rtc_frame& source) mutable {
       if(first_encoded) {if(encoder_peer==self->peer.load())self->MarkConnection(ConnectionPhase::encoded);first_encoded=false;}
       // Enqueue only: signaling-thread destroy joins this encoder worker.
       Json message={{"type","frame"},{"rtpTimestamp",timestamp},{"layoutEpoch",std::to_string(epoch)},
                     {"encodedBytes",encoded_bytes},{"keyframe",keyframe}};
       LARGE_INTEGER before{},after{};FILETIME utc{};
       QueryPerformanceCounter(&before);GetSystemTimePreciseAsFileTime(&utc);QueryPerformanceCounter(&after);
       ULARGE_INTEGER ticks{};ticks.LowPart=utc.dwLowDateTime;ticks.HighPart=utc.dwHighDateTime;
       if(auto clock=remotekit::MapCaptureClock(source.capture_qpc,source.qpc_frequency,before.QuadPart,after.QuadPart,
           double(ticks.QuadPart-116444736000000000ULL)/10000.0,self->capture_clock_uncertainty_ms.load())) {
        message["captureWallTimeMs"]=clock->wall_ms;message["captureMonotonicMs"]=clock->monotonic_ms;
        message["captureClockUncertaintyMs"]=clock->uncertainty_ms;message["sourceCaptureId"]=std::to_string(source.capture_qpc);
       }
       std::lock_guard event_lock(self->event_mutex);
       if(self->events.size()<1024)self->events.push_back(Event{0x10000,message.dump(),"",0,encoder_peer});
       self->event_wake.notify_one();
      },self->trace,encoder_peer,
      [self,encoder_peer](const remotekit_rtc_frame& source,bool keyframe,const std::function<bool()>& send) {
       return self->presentation.Send(encoder_peer,source.layout_epoch,keyframe,send);
      }));return 0;
 }
 static int ConfigureEncoder(void* context,uint64_t encoder,const remotekit_rtc_encoder_config* config) {
  auto* self=static_cast<Session*>(context);std::lock_guard lock(self->encoder_mutex);
  auto found=self->encoders.find(encoder);if(found==self->encoders.end())return 1;
  auto limited=*config;if(self->policy_fps){
   limited.fps=limited.fps?std::min(limited.fps,self->policy_fps.load()):self->policy_fps.load();
   limited.bitrate_bps=std::min(limited.bitrate_bps,self->policy_bitrate.load());}
  // SetParameters may reconfigure the previous encoded dimensions before the
  // next resized source frame arrives. Never initialize that old geometry at
  // an FPS exceeding its negotiated macroblock rate during the transition.
  limited.fps=remotekit::PreferredH264FrameRate(limited.width,limited.height,limited.fps,limited.h264_level_idc,true,
                                              self->options.max_encode_width,self->options.max_encode_height);
  self->MarkConnection(ConnectionPhase::encoder_configure_start);
  const bool ok=found->second->Configure(limited);
  self->MarkConnection(ConnectionPhase::encoder_configure_end);
  if(ok)found->second->Policy(self->policy_bitrate,self->policy_max,self->policy_fps);return ok?0:1;
 }
 static int Encode(void* context,uint64_t encoder,const remotekit_rtc_frame* frame,int key) {
  auto* self=static_cast<Session*>(context);std::lock_guard lock(self->encoder_mutex);
  // A source-queue timeout/new source can supersede a tail before Encode runs.
  // Reject that old tag before GPU work; independent PLI requests already went
  // through Keyframe() and remain pending on the worker.
  if(!remotekit::TailRefreshLease::BeginEncoding(*frame))return REMOTEKIT_SDK_BUSY;
  auto found=self->encoders.find(encoder);
  if(found!=self->encoders.end()&&found->second->Enqueue(*frame,key!=0 || remotekit::TailRefreshLease::From(*frame)))return 0;
  remotekit::TailRefreshLease::Finish(*frame,false);return REMOTEKIT_SDK_BUSY;
 }
 static void Rates(void* context,uint64_t encoder,uint32_t bitrate,uint32_t fps) {
  auto* self=static_cast<Session*>(context);std::lock_guard lock(self->encoder_mutex);
  auto found=self->encoders.find(encoder);if(found!=self->encoders.end())found->second->Rates(bitrate,fps);
 }
 static void Keyframe(void* context,uint64_t encoder) {
  auto* self=static_cast<Session*>(context);std::lock_guard lock(self->encoder_mutex);
  auto found=self->encoders.find(encoder);if(found!=self->encoders.end())found->second->Keyframe();
 }
 static void DestroyEncoder(void* context,uint64_t encoder) {
  auto* self=static_cast<Session*>(context);std::unique_ptr<EncoderWorker> worker;
  {std::lock_guard lock(self->encoder_mutex);auto found=self->encoders.find(encoder);
   if(found!=self->encoders.end()){worker=std::move(found->second);self->encoders.erase(found);}}
  if(worker)worker->Stop();
 }
 void OpenOutput(bool preserve_visibility=false) {
  MarkConnection(ConnectionPhase::output_open_start);
  // GPU resources are initialized by the first capture. With no subscribed
  // view there is no capture to wait for; keep RTC/DataChannel alive instead.
  // MediaLoop's resource replacement uses its existing subscription state.
  // Control may already be changing desired before PauseOutput joins us.
  if(!preserve_visibility)output_suspended=!has_visible_output.load();
  if(output_suspended || !rtc_connected)return;
  remotekit_rtc_clock_sample clock{};clock.struct_size=sizeof(clock);
  if(sdk.sample_clock && sdk.sample_clock(&clock)==0){pool.SetClock(clock);if(trace)trace->SdkClock(clock);}
  remotekit_sdk_atlas_setup setup{};setup.struct_size=sizeof(setup);
  int result;
  {std::lock_guard lock(rpc_mutex);result=sdk.remotekit_sdk_control_open_atlas(control,GetCurrentProcessId(),policy_fps.load()?policy_fps.load():options.encoding.fps,&setup,15000);}
  if(result!=0) {
   // The SDK's DATA_MISMATCH also covers a browser-side non-pending error.
   // Preserve the producer's actual status/error rather than infer device loss.
   try{fprintf(stderr,"session %s atlas open failed sdk=%d desired=%dx%d@%.3f browser=%s\n",
       id.c_str(),result,atlas_width,atlas_height,atlas_scale,Rpc({{"method","output.status"}}).dump().c_str());}
   catch(const std::exception& diagnostic){fprintf(stderr,"session %s atlas open failed sdk=%d status_query=%s\n",id.c_str(),result,diagnostic.what());}
   throw std::runtime_error("output open SDK "+std::to_string(result));
  }
  capture_clock_uncertainty_ms=pool.clock_uncertainty_us()/1000;
  pool.SetSharedInput(options.atlas_input=="shared");
  std::string error;if(!pool.Open(setup,std::min(16u,options.encoding.async_depth+4),error))throw std::runtime_error(error);
  {std::lock_guard lock(encoder_mutex);encoder_device=pool.Device();}
  MarkConnection(ConnectionPhase::output_open_end);
 }
 void Send(const Json& message) {
  auto handle=peer.load();if(!handle||!data_open)return;
  auto encoded=message.dump();sdk.remotekit_rtc_send_data(handle,encoded.data(),encoded.size(),0);
 }
 void SendPrepare(const remotekit::PresentationBarrier::Key& key) {
  Send({{"type","presentation.prepare"},{"version",1},{"barrierId",std::to_string(key.barrier)},
        {"outputGeneration",std::to_string(key.generation)},{"layoutEpoch",std::to_string(key.epoch)}});
 }
 static bool PresentationNumber(const Json& message,const char* field,uint64_t& result) {
  const auto found=message.find(field);if(found==message.end() || !found->is_string())return false;
  const auto& value=found->get_ref<const std::string&>();
  if(value.empty() || (value.size()>1 && value[0]=='0'))return false;
  const auto parsed=std::from_chars(value.data(),value.data()+value.size(),result);
  return parsed.ec==std::errc{} && parsed.ptr==value.data()+value.size();
 }
 bool PresentationMessage(const Event& event) {
  const auto message=Json::parse(event.bytes,nullptr,false);
  if(!message.is_object())return false;
  const auto type=message.value("type",Json());
  if(type!="media.presentation" && type!="presentation.ready")return false;
  if(event.bytes.size()>512 || message.value("version",Json())!=1)return true;
  if(type=="media.presentation") {
   const auto backend=message.value("backend",Json());
   if(backend!="video" && backend!="canvas")return true;
   const auto key=presentation.Mode(event.peer,backend=="video");
   // Mode() installs the gate before any video support confirmation leaves.
   Send({{"type","presentation.mode"},{"version",1},{"backend",backend}});
   if(!layout.empty()) {Send(layout);if(key)SendPrepare(*key);}
   if(backend=="canvas")refresh_connected=true;
  } else {
   remotekit::PresentationBarrier::Key key;
   if(PresentationNumber(message,"barrierId",key.barrier) &&
      PresentationNumber(message,"outputGeneration",key.generation) &&
      PresentationNumber(message,"layoutEpoch",key.epoch) && presentation.Ready(event.peer,key))refresh_connected=true;
  }
  return true;
 }
 void PublishLayout(Json next,uint64_t epoch) {
  // Serialize replacement with the last encoded publication, including old
  // hardware jobs already in flight. Metadata is sent only after gate closure.
  const auto prepare=presentation.Layout(std::stoull(next.at("generation").get<std::string>()),epoch);
  std::map<std::string,bool> ready;
  std::set<std::string> feedback_views;
  for(const auto& view:next.at("views"))feedback_views.insert(view.at("id").get<std::string>());
  media_feedback.Bind(peer.load(),next.at("epoch").get<std::string>(),next.at("generation").get<std::string>(),std::move(feedback_views));
  for(const auto& view:next.at("views"))ready[view.at("id").get<std::string>()]=!view.value("stale",false);
  coordinate_readiness.Set(epoch,std::move(ready));
  layout=std::move(next);Send(layout);if(prepare)SendPrepare(*prepare);
 }
 void InvalidateLayout(const char* reason) {
  current_geometry=std::string("invalid:")+reason;
  publication_epochs.clear();
  const auto epoch=layout_epoch.fetch_add(1)+1;
  PublishLayout({{"type","layout"},{"generation","0"},{"width",16},{"height",16},
    {"mediaScale",1},{"views",Json::array()},{"epoch",std::to_string(epoch)}},epoch);
 }
 Json Layout(const remotekit::SharedAtlasFrame& frame) {
  auto fit=remotekit::FitH264Sampling(frame.width_pixels,frame.height_pixels,SamplingFps(),receive_level.load(),options.max_encode_width,options.max_encode_height);
  if(!fit.width)fit={frame.width_pixels,frame.height_pixels,1};
  Json views=Json::array();
  for(uint32_t i=0;i<frame.view_count;++i){auto& v=frame.views[i];
   views.push_back({{"id",std::to_string(v.webview_id)},{"session",std::to_string(v.session_id)},
    {"instance",std::to_string(v.instance_generation)},{"document",std::to_string(v.document_generation)},
    {"focus",std::to_string(v.focus_generation)},
    {"x",std::lround(v.x_pixels*fit.scale)},{"y",std::lround(v.y_pixels*fit.scale)},
    {"width",std::lround((v.x_pixels+v.width_pixels)*fit.scale)-std::lround(v.x_pixels*fit.scale)},
    {"height",std::lround((v.y_pixels+v.height_pixels)*fit.scale)-std::lround(v.y_pixels*fit.scale)},
    {"deviceScaleFactor",v.page_device_scale_factor},
    {"mediaScale",fit.scale*v.atlas_pixels_per_dip/v.page_device_scale_factor},
    {"stale",(v.reserved&remotekit::kSharedAtlasViewStale)!=0}});}
  return {{"type","layout"},{"generation",std::to_string(frame.generation)},
          {"width",fit.width},{"height",fit.height},{"mediaScale",fit.scale},{"views",views}};
 }
 std::string GeometryKey(const remotekit::SharedAtlasFrame& frame) {
  auto value=Layout(frame);
  for(auto& view:value["views"])view.erase("focus");
  return value.dump();
 }
 uint64_t ObserveLayout(const remotekit::SharedAtlasFrame& frame) {
  const auto key=GeometryKey(frame);
  if(key!=current_geometry){current_geometry=key;layout_epoch.fetch_add(1);}
  publication_epochs[{frame.generation,frame.frame_id}]=layout_epoch.load();
  while(publication_epochs.size()>256)publication_epochs.erase(publication_epochs.begin());
  return layout_epoch.load();
 }
 uint64_t FrameEpoch(const remotekit::SharedAtlasFrame& frame) const {
  const auto found=publication_epochs.find({frame.generation,frame.frame_id});
  return found==publication_epochs.end()?0:found->second;
 }
 void ReplyInput(Json reply,const Json& request) {
  const bool focus=request.is_object()&&request.value("type",Json())=="focus";
  reply["type"]=focus?"focus":"input.result";
  if(focus) {
   reply["focusRequestId"]=request.value("focusRequestId",Json());
   reply["layoutEpoch"]=request.value("layoutEpoch",Json());
  } else if(request.is_object() && request.contains("sequence")) {
   reply["clientSequence"]=request["sequence"];
  }
  Send(reply);
 }
 void HandleData(const Event& event) {
  if(event.value!=0 || event.peer!=peer.load())return;
  auto command=Json::parse(event.bytes,nullptr,false);if(command.is_discarded()||!command.is_object())return;
  auto type=command.value("type",std::string());
  if(type!="input"&&type!="focus")return;
  const auto request=command;
  const auto request_epoch=layout_epoch.load();
  if(command.value("layoutEpoch",std::string())!=std::to_string(request_epoch)) {
   ++input_rejected;ReplyInput({{"ok",false},{"error","stale_layout_epoch"}},request);return;
  }
  command.erase("layoutEpoch");command.erase("focusRequestId");
  if(command.value("session",std::string())!=id) {
   ++input_rejected;ReplyInput({{"ok",false},{"error","wrong_session"}},request);return;
  }
  if(type=="input" && command.contains("event") && command["event"].is_object()) {
   const auto event_type=command["event"].value("type",std::string());
   if((event_type=="mouse"||event_type=="wheel"||event_type=="touch") &&
      !coordinate_readiness.Allows(command.value("view",std::string()),request_epoch)) {
    ++input_rejected;ReplyInput({{"ok",false},{"error","view_not_ready"}},request);return;
   }
  }
  command["method"]=type;command.erase("type");
  if(type=="input") {
   const auto sequence=input_sequence.NextBrowser();
   if(!sequence){++input_rejected;ReplyInput({{"ok",false},{"error","input_sequence_exhausted"}},request);return;}
   command["sequence"]=std::to_string(*sequence);
  }
  if(command.contains("outputGeneration")){command["output_generation"]=command["outputGeneration"];command.erase("outputGeneration");}
  // This connection is already bound to this Session by authenticated Control.
  // The browser validates membership and all token/sequence/output generations.
   try {
    auto reply=Rpc(command);
    // Browser BUSY is explicitly pre-admission. Keep this sequence and the
    // serial input worker until accepted or bounded failure; accepted async
    // TouchInjectionStatus failures must never replay the gesture.
    const auto deadline=QpcNow()+QpcFrequency()/4;
    unsigned retries=0;
    while(type=="input" && !reply.value("ok",false) && reply.value("code",0)==6) {
     if(retries>=50 || QpcNow()>=deadline){++input_busy_exhausted;break;}
     if(stop_input || event.peer!=peer.load() || request_epoch!=layout_epoch.load()) {
      reply={{"ok",false},{"error","input_identity_changed"}};break;
     }
     std::this_thread::sleep_for(std::chrono::milliseconds(5));
     if(stop_input || event.peer!=peer.load() || request_epoch!=layout_epoch.load()) {
      reply={{"ok",false},{"error","input_identity_changed"}};break;
     }
     ++retries;++input_busy_retries;reply=Rpc(command);
    }
    if(type=="input")reply["browserSequence"]=command["sequence"];
    ReplyInput(std::move(reply),request);
   }
  catch(const std::exception& error){ReplyInput({{"ok",false},{"error",error.what()}},request);}
 }
 void QueueInput(const Event& event) {
  std::lock_guard lock(input_mutex);
  if(event.peer!=peer.load() || event.value!=0)return;
  auto parsed=Json::parse(event.bytes,nullptr,false);
  // Validate arrival order before move coalescing can replace a newer packet.
  // The Browser keeps its independent Session counter across RTC reconnects.
  if(parsed.is_object() && parsed.value("type",Json())=="input" &&
     (!parsed.contains("sequence") || !parsed["sequence"].is_string() ||
      !input_sequence.Admit(event.peer,parsed["sequence"].get<std::string>()))) {
   ++input_rejected;ReplyInput({{"ok",false},{"error","stale_client_sequence"}},parsed);return;
  }
  bool move=!parsed.is_discarded()&&parsed.value("type",std::string())=="input"&&parsed.contains("event")&&
    parsed["event"].value("type",std::string())=="mouse"&&parsed["event"].value("action",std::string())=="move";
  if(move&&!input_queue.empty()) {
   auto before=Json::parse(input_queue.back().bytes,nullptr,false);
   if(input_queue.back().peer==event.peer&&!before.is_discarded()&&before.value("view",std::string())==parsed.value("view",std::string())&&
      before.contains("event")&&before["event"].value("type",std::string())=="mouse"&&
      before["event"].value("action",std::string())=="move") {
    input_queue.back()=event;++input_coalesced;input_wake.notify_one();return;
   }
  }
  if(input_queue.size()>=256) {
   ++input_rejected;ReplyInput({{"ok",false},{"error","input_queue_busy"}},parsed);return;
  }
  input_queue.push_back(event);input_wake.notify_one();
 }
 void InputLoop() {
  while(true) {
   Event event;
   {std::unique_lock lock(input_mutex);input_wake.wait(lock,[&]{return stop_input||!input_queue.empty();});
    if(stop_input)break;event=std::move(input_queue.front());input_queue.pop_front();}
   try{HandleData(event);}catch(const std::exception& error){++input_rejected;ReplyInput({{"ok",false},{"error",error.what()}},Json::parse(event.bytes,nullptr,false));}
  }
 }
 void MediaLoop() {
  remotekit_rtc_frame latest{};int64_t last_stats=QpcNow();
  uint64_t previous_encoded=stats->completed.load(),previous_bytes=stats->bytes.load(),previous_copies=pool.copied_frames();
  uint64_t previous_delivered=pool.delivered_frames();
  bool stream_started=false;remotekit::IdleIdrPolicy idle(options.idle_idr_ms);
  bool pending_latest=false;int64_t next_codec_submit_qpc=0;
  bool first_source=true,first_submit=true;
  unsigned consecutive_reconfigures=0;
  std::shared_ptr<remotekit::TailIdrAttempt> tail_attempt;
  double next_tail_attempt_ms=0;
  uint64_t adaptive_generation=0;double next_adaptive_ms=0;
  {std::lock_guard lock(adaptive_mutex);adaptive.Reset(1000.0*QpcNow()/QpcFrequency(),AdaptiveCounters());}
  constexpr double tail_retry_ms=250;
  effective_idle_ms=idle.delay_ms();source_interval_ms=0;
  while(!stop_media) {
   const auto requested_fps=policy_fps.load();
   sampling_fps=requested_fps?std::min(requested_fps,options.encoding.fps):options.encoding.fps;
   std::deque<Event> incoming;
   {std::lock_guard lock(event_mutex);incoming.swap(events);}
   for(auto& event:incoming) {
    if(event.peer!=peer.load())continue;
    if(event.type==0x10000) {
     auto message=Json::parse(event.bytes,nullptr,false);if(!message.is_discarded())Send(message);
    } else if(event.type==REMOTEKIT_RTC_STATS) {
     auto sample=Json::parse(event.bytes,nullptr,false);
     if(sample.is_object()) {std::lock_guard lock(stats->mutex);stats->sender_rtc_stats=std::move(sample);}
    } else if(event.type==REMOTEKIT_RTC_REFRESH_REQUEST) {
     refresh_connected=true;
    } else if(event.type==REMOTEKIT_RTC_STATE) {
     const bool connected=event.value==2;
     if(connected!=rtc_connected.exchange(connected)) {
      if(tail_attempt)tail_attempt->CancelWaiting();
      tail_attempt.reset();
      if(latest.release)latest.release(latest.release_context,latest.frame_id);
      latest={};stream_started=false;next_tail_attempt_ms=0;
      InvalidateLayout(connected?"rtc-resuming":"rtc-disconnected");
      try {
       if(connected) {OpenOutput();refresh_connected=true;}
       else Rpc({{"method","output.close"}});
      } catch(const std::exception& failure) {
       {std::lock_guard lock(stats->mutex);stats->error=failure.what();}
       InvalidateLayout("rtc-output-error");
       try{Rpc({{"method","output.close"}});}catch(const std::exception& close_error) {
        fprintf(stderr,"session %s fatal output stop: %s\n",id.c_str(),close_error.what());
       }
       fprintf(stderr,"session %s RTC output: %s\n",id.c_str(),failure.what());
       return;
      }
     }
    } else if(event.type==REMOTEKIT_RTC_DATA_STATE) {
     const bool opened=event.value==1;
     if(opened&&!data_open.exchange(opened))refresh_connected=true;
     if(!opened)data_open=false;
     if(data_open&&!layout.empty())Send(layout);
    } else if(event.type==REMOTEKIT_RTC_DATA) {
     try{if(!PresentationMessage(event))QueueInput(event);}catch(const std::exception& error){++input_rejected;Send({{"type","input.result"},{"ok",false},{"error",error.what()}});}
    }
    else if(event.type==REMOTEKIT_RTC_ERROR)fprintf(stderr,"RTC %s: %s\n",id.c_str(),event.bytes.c_str());
   }
   if(!rtc_connected) {
    std::unique_lock lock(event_mutex);
    event_wake.wait_for(lock,std::chrono::milliseconds(20),[&]{return stop_media||!events.empty();});
    continue;
   }
   remotekit_rtc_frame frame{};remotekit::SharedAtlasFrame metadata{};std::string error;
   auto result=output_suspended?AtlasPool::Result::idle:pool.Poll(frame,metadata,error);
   if(first_source && result==AtlasPool::Result::ready){MarkConnection(ConnectionPhase::source_frame);first_source=false;}
   if(result==AtlasPool::Result::reconfigure) {
    InvalidateLayout("reconfigure");
    if(tail_attempt)tail_attempt->CancelWaiting();
    tail_attempt.reset();
    if(latest.release)latest.release(latest.release_context,latest.frame_id);
    latest={};stream_started=false;next_tail_attempt_ms=0;
    idle=remotekit::IdleIdrPolicy(options.idle_idr_ms);
    effective_idle_ms=idle.delay_ms();source_interval_ms=0;last_tail_age_ms=0;
    adaptive_generation=0;next_adaptive_ms=0;
    try {
     if(++consecutive_reconfigures>3)throw std::runtime_error("atlas repeatedly requested reconfiguration before a frame");
     if(stop_media.load())break;
     // Rpc and OpenOutput each acquire rpc_mutex independently. PauseOutput
     // sets stop_media and joins without holding it; never nest those locks.
     Rpc({{"method","output.close"}});
     if(stop_media.load())break;
     // Open retires the old generation, preserving all SDK/worker leases and
     // their GPU consumed barriers. RTC and WebContents keep their identity.
     OpenOutput(true);
     if(stop_media.load())break;
     previous_copies=pool.copied_frames();previous_delivered=pool.delivered_frames();
     previous_encoded=stats->completed.load();previous_bytes=stats->bytes.load();
     last_stats=QpcNow();refresh_connected=true;
     {std::lock_guard lock(encoder_mutex);for(auto& [encoder,worker]:encoders)worker->Keyframe();}
     continue;
    } catch(const std::exception& failure) {
     error=std::string("atlas reconfigure failed: ")+failure.what();
     result=AtlasPool::Result::error;
    }
   }
   if(result==AtlasPool::Result::error) {
    InvalidateLayout("fatal");
    try{Rpc({{"method","output.close"}});}catch(const std::exception& close_error) {
     fprintf(stderr,"session %s fatal output stop: %s\n",id.c_str(),close_error.what());
    }
    {std::lock_guard lock(stats->mutex);stats->error=error;}
    fprintf(stderr,"session %s media: %s\n",id.c_str(),error.c_str());break;
   }
   const auto current_metadata=output_suspended?remotekit::SharedAtlasFrame{}:pool.LatestMetadata();
   if(current_metadata.generation) {
    try {RecomputeCodecCeiling(current_metadata.width_pixels,current_metadata.height_pixels);sampling_fps=policy_fps.load()?policy_fps.load():options.encoding.fps;}
    catch(const std::exception& failure) {if(frame.release)frame.release(frame.release_context,frame.frame_id);std::lock_guard lock(stats->mutex);stats->error=failure.what();break;}
   }
   if(output_suspended) {
    if(current_geometry!="invalid:no-visible-views")InvalidateLayout("no-visible-views");
   }
   if(current_metadata.generation) {
    auto next=Layout(current_metadata);const auto epoch=ObserveLayout(current_metadata);next["epoch"]=std::to_string(epoch);
    if(next!=layout)PublishLayout(std::move(next),epoch);
   }
   const auto handle=peer.load();const auto now=QpcNow();const double now_ms=1000.0*now/QpcFrequency();
   if(options.adaptive_fps || policy_fps.load()) {
    if(current_metadata.generation && current_metadata.generation!=adaptive_generation) {
     adaptive_generation=current_metadata.generation;
     std::lock_guard lock(adaptive_mutex);adaptive.Reset(now_ms,AdaptiveCounters());
    }
    const bool decide=now_ms>=next_adaptive_ms;
    ObserveAdaptiveFps(now_ms,metadata,result==AtlasPool::Result::ready,decide);
    if(decide)next_adaptive_ms=now_ms+500;
   }
   if(tail_attempt) {
    using State=remotekit::TailIdrAttempt::State;
    if(now_ms>=next_tail_attempt_ms)tail_attempt->CancelWaiting();
    const auto state=tail_attempt->state();
    if(state==State::succeeded && idle.CompleteRefresh(now_ms,true)) {
     ++tail_completions;last_tail_age_ms=idle.age_ms(now_ms);
    }
    if(state!=State::source_wait && state!=State::encoding)tail_attempt.reset();
   }
   const bool tail_ready=idle.TailDue(now_ms)&&!tail_attempt&&now_ms>=next_tail_attempt_ms;
   const bool cadence_limited=policy_requested_fps.load() && sampling_fps<std::min(policy_requested_fps.load(),options.encoding.fps);
   const bool cadence_due=!cadence_limited || now>=next_codec_submit_qpc;
   if(result==AtlasPool::Result::ready) {
    consecutive_reconfigures=0;
    if(idle.Observe(metadata.generation,metadata.frame_id,metadata.capture_time_us,now_ms)) {
     if(tail_attempt)tail_attempt->CancelWaiting();
     tail_attempt.reset();next_tail_attempt_ms=0;
     effective_idle_ms=idle.delay_ms();source_interval_ms=idle.interval_ms();
    }
    frame.layout_epoch=FrameEpoch(metadata);
    sampling=remotekit::FitH264Sampling(frame.width,frame.height,SamplingFps(),receive_level.load(),options.max_encode_width,options.max_encode_height);
    if(sampling.width){frame.width=sampling.width;frame.height=sampling.height;}
    if(latest.release)latest.release(latest.release_context,latest.frame_id);
    latest=frame;latest.retain(latest.release_context,latest.frame_id);
     if(!cadence_due) {
      pending_latest=true;frame.release(frame.release_context,frame.frame_id);
     } else {
    const bool refresh=refresh_connected.exchange(false);
    if(refresh) {
     std::lock_guard lock(encoder_mutex);for(auto& [encoder,worker]:encoders)worker->Keyframe();
    }
    RK_SERVER_TRACE(trace,"rtc_submit_begin",TraceIds::Frame(frame),rk_record.peer=handle;rk_record.reason="fresh";);
     if(first_submit){MarkConnection(ConnectionPhase::submit);first_submit=false;}
    const int submit_status=(!handle||!receive_level.load())?REMOTEKIT_SDK_INVALID_STATE:sdk.remotekit_rtc_submit_texture(handle,&frame);
    RK_SERVER_TRACE(trace,"rtc_submit_return",TraceIds::Frame(frame),rk_record.peer=handle;rk_record.reason="fresh";rk_record.status=submit_status;);
    if(submit_status!=0) {
     frame.release(frame.release_context,frame.frame_id);
     if(refresh)refresh_connected=true;
     } else {stream_started=true;pending_latest=false;if(cadence_limited)next_codec_submit_qpc=QpcNow()+(QpcFrequency()+sampling_fps-1)/sampling_fps;}
     }
   } else if(handle && receive_level.load() && latest.release &&
              cadence_due && latest.layout_epoch==layout_epoch.load() &&
              (!stream_started || pending_latest || refresh_connected.load() || tail_ready)) {
    const bool tail=tail_ready;
    const bool refresh=refresh_connected.exchange(false);
     if(tail || refresh || !stream_started) {std::lock_guard lock(encoder_mutex);for(auto& [encoder,worker]:encoders)worker->Keyframe();}
    auto repeat=latest;
    // latest already carries the encoded dimensions and epoch of its actual
    // texture. LatestMetadata may describe a newer publication whose copy or
    // ready fence has not completed; never relabel an older texture with it.
    if(tail) {
     tail_attempt=std::make_shared<remotekit::TailIdrAttempt>();
     next_tail_attempt_ms=now_ms+tail_retry_ms;
     repeat=remotekit::TailRefreshLease::Wrap(repeat,tail_attempt);
    } else repeat.retain(repeat.release_context,repeat.frame_id);
    // Tail IDR retains content epoch and capture time. SDK assigns a fresh
    // submit/RTP timestamp independently.
    RK_SERVER_TRACE(trace,"rtc_submit_begin",TraceIds::Frame(repeat),rk_record.peer=handle;rk_record.reason=tail?"tail":"refresh";);
    const int submit_status=sdk.remotekit_rtc_submit_texture(handle,&repeat);
    RK_SERVER_TRACE(trace,"rtc_submit_return",TraceIds::Frame(repeat),rk_record.peer=handle;rk_record.reason=tail?"tail":"refresh";rk_record.status=submit_status;);
    if(submit_status!=0) {
     repeat.release(repeat.release_context,repeat.frame_id);
     if(refresh)refresh_connected=true;
     } else {stream_started=true;pending_latest=false;if(cadence_limited)next_codec_submit_qpc=QpcNow()+(QpcFrequency()+sampling_fps-1)/sampling_fps;if(tail)++tail_submissions;}
   }
   if(now-last_stats>=QpcFrequency()) {
    if(trace)trace->WallClock();
    if(handle && sdk.request_stats)sdk.request_stats(handle);
    auto report=Stats();report["type"]="stats";
    const double seconds=static_cast<double>(now-last_stats)/QpcFrequency();
    const auto encoded=stats->completed.load(),bytes=stats->bytes.load(),copies=pool.copied_frames();
    report["encodedFps"]=(encoded-previous_encoded)/seconds;
    report["encodedBitrateBps"]=8.0*(bytes-previous_bytes)/seconds;
    report["atlasCopies"]=copies;report["atlasCopyFps"]=(copies-previous_copies)/seconds;
    const auto delivered=pool.delivered_frames();
    report["atlasDeliveredFrames"]=delivered;report["atlasDeliveredFps"]=(delivered-previous_delivered)/seconds;
    previous_delivered=delivered;
    previous_encoded=encoded;previous_bytes=bytes;previous_copies=copies;
    report["atlasPoolDrops"]=pool.drops();report["lastGpuCopyMs"]=pool.shared_input()?Json(nullptr):Json(pool.last_copy_ms());
    report["sourceWidth"]=current_metadata.width_pixels;report["sourceHeight"]=current_metadata.height_pixels;
    report["sourceAtlasWidth"]=current_metadata.width_pixels;report["sourceAtlasHeight"]=current_metadata.height_pixels;
    report["encodedWidth"]=sampling.width;report["encodedHeight"]=sampling.height;report["mediaScale"]=sampling.scale;
    report["negotiatedReceiveLevel"]=receive_level.load();report["samplingFpsBudget"]=SamplingFps();
    report["resolutionLimitation"]=sampling.limitation;
    report["samplingMaxFrameMacroblocks"]=sampling.max_frame_macroblocks;
    report["samplingMaxMacroblocksPerSecond"]=sampling.max_macroblocks_per_second;
    report["receiveLevel"]=receive_level.load();
    report["inputRejected"]=input_rejected.load();report["inputCoalesced"]=input_coalesced.load();
    report["inputBusyRetries"]=input_busy_retries.load();report["inputBusyExhausted"]=input_busy_exhausted.load();
    {std::lock_guard lock(input_mutex);report["inputQueue"]=input_queue.size();}
    const auto latency=pool.capture_to_ready_ms();
    report["captureToReadyMs"]=latency?Json(*latency):Json(nullptr);
    report["captureClock"]=latency?"measured SDK TimeTicks to QPC mapping":"unavailable";
    report["clockUncertaintyUs"]=pool.clock_uncertainty_us();
    Send(report);last_stats=now;
   }
   std::unique_lock lock(event_mutex);event_wake.wait_for(lock,std::chrono::milliseconds(1),[&]{return stop_media||!events.empty();});
  }
  if(tail_attempt)tail_attempt->CancelWaiting();
  if(latest.release)latest.release(latest.release_context,latest.frame_id);
 }
 Json Offer(const Json& request) {
  Start();ClosePeer();
  for(auto& phase:connection_phases)phase=0;connection_started_qpc=QpcNow();
  connection=Required(request,"connectionId");
  {std::lock_guard lock(signal_mutex);answer.clear();rtc_error.clear();ice_complete=false;signal_events.clear();signal_overflow=false;}
  trickle_signals=request.value("trickle",false);
  remotekit_rtc_options config{};config.struct_size=sizeof(config);config.abi_version=REMOTEKIT_RTC_ABI_VERSION;
  config.context=this;config.event=EventCallback;config.encoder.struct_size=sizeof(config.encoder);
  config.encoder.create=CreateEncoder;config.encoder.configure=ConfigureEncoder;config.encoder.encode=Encode;
  config.encoder.set_rates=Rates;config.encoder.request_keyframe=Keyframe;config.encoder.destroy=DestroyEncoder;
  config.min_bitrate_bps=500000;config.start_bitrate_bps=policy_bitrate.load()?policy_bitrate.load():options.encoding.bitrate;config.max_bitrate_bps=policy_max.load()?policy_max.load():options.encoding.max_bitrate;
  uint64_t handle=0;
  if(sdk.remotekit_rtc_create(&config,&handle)!=0)throw std::runtime_error("RTC create failed");
  if(policy_fps && sdk.remotekit_rtc_set_media_policy(handle,policy_bitrate,policy_max,policy_fps)!=0){sdk.remotekit_rtc_close(handle);throw std::runtime_error("RTC media policy rejected");}
  receive_level=0;refresh_connected=false;presentation.Bind(handle);peer=handle;input_sequence.Bind(handle);stop_media=false;data_open=false;layout=Json();
  last_media_refresh_qpc=0;
  if(options.rtc_playout_max_ms>=0) {
   const int status=sdk.remotekit_rtc_set_playout_delay(handle,0,options.rtc_playout_max_ms);
   if(status!=0){ClosePeer();throw std::runtime_error("RTC playout delay rejected (SDK "+std::to_string(status)+")");}
  }
  auto sdp=Required(request,"sdp");
  if(sdk.remotekit_rtc_set_remote_description(handle,1,sdp.data(),sdp.size())!=0) {
   ClosePeer();throw std::runtime_error("RTC remote offer rejected");
  }
  if(sdp.find("m=audio ")!=std::string::npos) {
   try{OpenAudio();}catch(...){ClosePeer();throw;}
  }
  if(trickle_signals) {
   uint32_t level=0;
   if(sdk.remotekit_rtc_get_receive_level(handle,&level)!=0 || !level) {
    ClosePeer();throw std::runtime_error("peer has no compatible receiving H264 level");
   }
   receive_level=level;
   stop_input=false;input_thread=std::thread([this]{InputLoop();});
   media_thread=std::thread([this]{MediaLoop();});EnableBudget();
   return {{"accepted",true},{"pending",true},{"connectionId",connection}};
  }
  std::unique_lock lock(signal_mutex);
  signal_wake.wait_for(lock,std::chrono::seconds(20),[&]{return ice_complete||!rtc_error.empty();});
  if(!ice_complete){auto error=rtc_error.empty()?"ICE gathering timed out":rtc_error;lock.unlock();ClosePeer();throw std::runtime_error(error);}
  const auto gathered_answer=answer;lock.unlock();
  uint32_t level=0;
  if(sdk.remotekit_rtc_get_receive_level(handle,&level)!=0 || !level) {
    ClosePeer();throw std::runtime_error("peer has no compatible receiving H264 level");
  }
  receive_level=level;
  stop_input=false;input_thread=std::thread([this]{InputLoop();});
  media_thread=std::thread([this]{MediaLoop();});
  EnableBudget();
  event_wake.notify_all();
  return {{"sdp",gathered_answer},{"type","answer"},{"connectionId",connection}};
 }
 // Only the dispatcher writes JSONL. SDK callback threads never write stdout.
 void FlushSignals() {
  std::deque<Event> pending;
  {std::lock_guard lock(signal_mutex);pending.swap(signal_events);}
  for(const auto& event:pending) {
   if(!trickle_signals || !peer.load() || event.peer!=peer.load())continue;
   Json signal;
   if(event.type==REMOTEKIT_RTC_SDP_ANSWER)signal={{"type","answer"},{"sdp",event.bytes}};
   else if(event.type==REMOTEKIT_RTC_ICE)signal={{"type","ice"},{"candidate",{{"candidate",event.bytes},{"sdpMid",event.auxiliary},{"sdpMLineIndex",event.value}}}};
   else if(event.type==REMOTEKIT_RTC_ICE_COMPLETE)signal={{"type","complete"}};
   else if(event.type==REMOTEKIT_RTC_ERROR)signal={{"type","error"},{"message",event.bytes}};
   else continue;
   std::cout<<Json({{"event","rtc.signal"},{"tenantId",tenant},{"connectionId",connection},{"signal",signal}}).dump()<<'\n'<<std::flush;
  }
 }
 void ClosePeer() {
  const bool had_audio=audio_ring.IsOpen();
  stop_audio=true;
  if(audio_thread.joinable())audio_thread.join();
  if(had_audio && control && Alive())try{Rpc({{"method","audio.close"}});}catch(const std::exception& error){fprintf(stderr,"audio close: %s\n",error.what());}
  audio_ring.Close();
  trickle_signals=false;
  DisableBudget();
  stop_input=true;input_wake.notify_all();if(input_thread.joinable())input_thread.join();
  stop_media=true;event_wake.notify_all();if(media_thread.joinable())media_thread.join();
  rtc_connected=false;
  presentation.Bind(0);
  InvalidateLayout("rtc-closed");
  {std::lock_guard lock(input_mutex);input_queue.clear();input_sequence.Bind(0);}
  auto handle=peer.exchange(0);
  media_feedback.Bind(0,"","");
  if(handle)sdk.remotekit_rtc_close(handle);
  std::map<uint64_t,std::unique_ptr<EncoderWorker>> remaining;
  {std::lock_guard lock(encoder_mutex);remaining.swap(encoders);}remaining.clear();
  // Freeze the producer before snapshotting its final publication. Otherwise
  // a consumed acknowledgement could permit another unobserved old frame.
  bool producer_exited=ProducerExited();
  bool producer_frozen=producer_exited;
  if(control && !producer_exited) {
   try{Rpc({{"method","output.close"}});producer_frozen=true;}
   catch(const std::exception& error){fprintf(stderr,"pool close unfinished: producer stop failed: %s\n",error.what());}
  }
  // A failed/slow RPC can coincide with process exit. WAIT_FAILED and a
  // missing handle are never evidence that a producer stopped publishing.
  producer_exited=producer_exited || ProducerExited();
  producer_frozen=producer_frozen || producer_exited;
  // No handle also permits retrying a proof already stored on an old State;
  // it does not authorize accepting a Running publication without that proof.
  if(producer_frozen || !process) {
   std::string error;if(!pool.Close(error,producer_exited))fprintf(stderr,"pool close: %s\n",error.c_str());
  } else fprintf(stderr,"pool close unfinished: producer not confirmed stopped; resources retained\n");
  data_open=false;connection.clear();
  {std::lock_guard lock(stats->mutex);stats->sender_rtc_stats=nullptr;}
  {std::lock_guard lock(event_mutex);events.clear();}
  if(trace)trace->Flush();
 }
 void OpenAudio() {
  const uint64_t generation=static_cast<uint64_t>(QpcNow());
  const std::string name="Local\\RemoteKit.audio."+browser_incarnation+"."+std::to_string(generation);
  audio_ring.Open(name,generation,std::stoull(id));
  try {Rpc({{"method","audio.open"},{"mapping",name},{"generation",std::to_string(generation)},{"session",id}});}
  catch(...) {audio_ring.Close();throw;}
  audio_gaps=0;audio_submitted=0;audio_rejected=0;stop_audio=false;
  audio_thread=std::thread([this,generation]{
   uint64_t gaps=0,stale=0;
   while(!stop_audio.load()) {
    remotekit::AudioPacket packet{};
    if(!audio_ring.Poll(packet,gaps)) {std::this_thread::sleep_for(std::chrono::milliseconds(2));continue;}
    audio_gaps=gaps+stale;
    const auto handle=peer.load();
    if(!handle || !rtc_connected.load())continue;
    // Bound age independently of the video encoder and never await its queue.
    if(QpcNow()-packet.first_sample_qpc>QpcFrequency()/20) {++stale;audio_gaps=gaps+stale;continue;}
    const int status=sdk.remotekit_rtc_submit_audio(handle,packet.pcm,480,generation,packet.sequence,
      packet.sample_index,packet.first_sample_qpc,packet.discontinuity);
    if(status==0)++audio_submitted;else ++audio_rejected;
   }
  });
 }
 using FileBinding=remotekit::FileUploadStore::Binding;
 FileBinding ParseFileBinding(const Json& value) {
  return {Required(value,"browserIncarnation"),Required(value,"view"),Required(value,"instance"),Required(value,"document"),Required(value,"request")};
 }
 Json FileBrowserCommand(const FileBinding& binding,const char* method) {
  if(!Alive() || !control || producer_stop_pending || binding.browser_incarnation!=browser_incarnation ||
     !desired.contains(binding.view))throw std::runtime_error("stale_file_request_target");
  return {{"method",method},{"session",id},{"view",binding.view},{"instance",binding.instance},
    {"document",binding.document},{"request",binding.request}};
 }
 Json FileStatus(const std::string& upload,const FileBinding& binding) {
  const auto* batch=file_uploads.Find(upload);
  if(!batch || !(batch->binding==binding))throw std::runtime_error("unknown_file_upload");
  if(batch->state==remotekit::FileUploadStore::State::selected)
   return {{"uploadId",upload},{"state","selected"},{"pending",false},{"selected",true}};
  auto status=Rpc(FileBrowserCommand(binding,"page.fileStatus"));
  const auto state=status.value("state",std::string("unknown"));
  if(state=="selected")file_uploads.MarkSelected(upload);
  else if(state=="cancelled")file_uploads.DiscardUnselected(upload);
  Json result={{"uploadId",upload},{"state",state},{"pending",state=="pending" || state=="validating"},{"selected",state=="selected"}};
  if(status.contains("error"))result["error"]=status["error"];
  return result;
 }
 Json FileCommand(const std::string& method,const Json& request) {
  if(method=="session.files.revoke") {file_uploads.RevokeUncommitted();return {{"accepted",true}};}
  if(method=="session.files.cancel") {
   const auto upload=request.value("uploadId",std::string());
   if(request.value("cancelRequest",false)) {
    const auto binding=ParseFileBinding(request.at("binding"));
    if(!upload.empty()) {
     const auto status=FileStatus(upload,binding);
     if(status.value("state",std::string())=="selected" || status.value("state",std::string())=="cancelled")return status;
    }
    auto status=Rpc(FileBrowserCommand(binding,"page.fileStatus"));
    const auto state=status.value("state",std::string());
    if(state=="pending" || state=="validating") {
     auto command=FileBrowserCommand(binding,"page.reply");command["file_only"]=true;command["accept"]=false;
     Rpc(command);
    }
    if(!upload.empty())return FileStatus(upload,binding);
    status=Rpc(FileBrowserCommand(binding,"page.fileStatus"));
    return {{"accepted",true},{"state",status.value("state",std::string("unknown"))}};
   }
   if(upload.empty()){file_uploads.RevokeUncommitted();return {{"accepted",true}};}
   const auto* batch=file_uploads.Find(upload);
   if(!batch)return {{"accepted",true},{"state","cancelled"}};
   if(!file_uploads.Cancel(upload))return FileStatus(upload,batch->binding);
   return {{"accepted",true},{"state","cancelled"}};
  }
  const auto binding=ParseFileBinding(request.at("binding"));
  if(method=="session.files.begin") {
   if(Rpc(FileBrowserCommand(binding,"page.fileStatus")).value("state",std::string())!="pending")
    throw std::runtime_error("file_request_not_pending");
   const auto& values=request.at("files");
   if(!values.is_array() || values.empty() || values.size()>64)throw std::runtime_error("invalid_file_count");
   std::vector<remotekit::FileUploadStore::Spec> specs;
   for(const auto& value:values) {
    if(!value.at("size").is_number_unsigned() &&
       (!value.at("size").is_number_integer() || value.at("size").get<int64_t>()<0))throw std::runtime_error("invalid_file_size");
    specs.push_back({Required(value,"name"),value.value("type",std::string()),value.at("size").get<uint64_t>()});
   }
   const auto& batch=file_uploads.Begin(binding,specs);Json files=Json::array();
   for(const auto& file:batch.files)files.push_back({{"ticket",file.ticket},{"path",Utf8(file.path)}});
   return {{"uploadId",batch.id},{"files",files}};
  }
  const auto upload=Required(request,"uploadId");
  if(method=="session.files.status")return FileStatus(upload,binding);
  if(method!="session.files.commit")throw std::runtime_error("unknown_file_upload_method");
  const auto* existing=file_uploads.Find(upload);
  if(!existing || !(existing->binding==binding))throw std::runtime_error("unknown_file_upload");
  if(existing->state==remotekit::FileUploadStore::State::submitted || existing->state==remotekit::FileUploadStore::State::selected)
   return FileStatus(upload,binding);
  if(Rpc(FileBrowserCommand(binding,"page.fileStatus")).value("state",std::string())!="pending")
   throw std::runtime_error("file_request_not_pending");
  const auto& batch=file_uploads.Seal(upload,binding);Json files=Json::array();
  for(const auto& file:batch.files)files.push_back({{"path",Utf8(file.path)},{"displayName",file.name}});
  auto command=FileBrowserCommand(binding,"page.reply");command["file_only"]=true;command["accept"]=true;command["files"]=files;
  file_uploads.MarkSubmitted(upload); // An RPC timeout can occur after Browser received these paths.
  Rpc(command);
  return FileStatus(upload,binding);
 }
 Json Command(const Json& request) {
  const auto method=Required(request,"method");
  if(method.starts_with("session.files."))return FileCommand(method,request);
  if(method=="session.ensure"){Start();return {{"sessionId",id},{"browserPid",GetProcessId(process)},{"running",true},{"accepted",true},{"browserIncarnation",browser_incarnation},{"recovery",RecoverySnapshot()}};}
  if(method=="session.snapshot")return Snapshot(request.value("outputDiagnostics",false));
  if(method=="session.events.ack") {
   const auto ids=request.at("eventIds");
   if(!ids.is_array() || ids.size()>256)throw std::runtime_error("invalid event ids");
   std::set<std::string> acknowledged;
   for(const auto& value:ids){if(!value.is_string())throw std::runtime_error("invalid event id");acknowledged.insert(value.get<std::string>());}
   Json remaining=Json::array();
   for(const auto& event:durable_events)if(!acknowledged.contains(event.at("eventId").get<std::string>()))remaining.push_back(event);
   durable_events=std::move(remaining);SaveEvents();return {{"accepted",true},{"remaining",durable_events.size()}};
  }
  if(method=="session.mediaPolicy") {
   auto number=[&](const char* key,uint32_t low,uint32_t high){const auto& v=request.at(key);
    if(!v.is_number_integer() || v.get<int64_t>()<low || v.get<int64_t>()>high)throw std::runtime_error(std::string("invalid media policy ")+key);return v.get<uint32_t>();};
   const auto fps=number("targetFps",1,60),bitrate=number("bitrateKbps",100,50000)*1000,maximum=number("maxBitrateKbps",100,60000)*1000;
   if(bitrate>maximum || request.at("adaptive")!=true)throw std::runtime_error("invalid media policy");
   const bool prefer=request.value("preferResolution",false);
   {
    std::lock_guard lock(media_policy_mutex);
    const auto effective=remotekit::PreferredH264FrameRate(policy_source_width.load(),policy_source_height.load(),std::min(fps,options.encoding.fps),receive_level.load(),prefer,options.max_encode_width,options.max_encode_height);
    if(policy_requested_fps!=fps || policy_fps!=effective || policy_bitrate!=bitrate || policy_max!=maximum || policy_prefer_resolution!=prefer) {
     policy_requested_fps=fps;policy_prefer_resolution=prefer;
     requested_media_policy={{"targetFps",fps},{"bitrateKbps",bitrate/1000},{"maxBitrateKbps",maximum/1000},{"adaptive",true},{"preferResolution",prefer}};
     ApplyMediaCeiling(effective,bitrate,maximum);
    }
   }
   if(request.value("refresh",false)){refresh_connected=true;event_wake.notify_one();}
   std::lock_guard lock(adaptive_mutex);
   return {{"accepted",true},{"applied",Alive()&&control!=0&&adaptive_applied_known}};
  }

  if(method=="session.sitePreferences") {
   const auto sites=request.at("sites");
   if(!sites.is_object() || sites.size()>4096)throw std::runtime_error("invalid site preferences");
   for(auto& [origin,value]:sites.items()) {
    if(origin.size()>2048 || !(origin.starts_with("https://") || origin.starts_with("http://")) ||
       !value.is_object() || !value.contains("tabletUa") || !value["tabletUa"].is_boolean())
     throw std::runtime_error("invalid site preference");
   }
   if(Alive()&&control)Rpc({{"method","session.sitePreferences"},{"session",id},{"sites",sites}});
   site_preferences=sites;SaveJson(directory/"site-preferences.json",site_preferences);
   return {{"accepted",true},{"applied",Alive()&&control!=0}};
  }
  if(method=="rtc.offer")return Offer(request);
  if(method=="rtc.close") {
   if(request.value("connectionId",std::string())==connection)ClosePeer();
   return {{"closed",true}};
  }
  if(method=="rtc.ice") {
   if(request.value("connectionId",std::string())!=connection||!peer)throw std::runtime_error("stale RTC connection");
   auto ice=request.at("candidate");if(ice.is_null())return Json::object();
   auto candidate=ice.value("candidate",std::string()),mid=ice.value("sdpMid",std::string("0"));
   if(sdk.remotekit_rtc_add_ice(peer.load(),mid.c_str(),ice.value("sdpMLineIndex",0),candidate.data(),candidate.size())!=0)
    throw std::runtime_error("ICE candidate rejected");
   return Json::object();
  }
  const bool page_reply=method=="view.page.reply" || method=="view.close.reply";
  if(page_reply && (!Alive() || !control || producer_stop_pending || browser_incarnation.empty() ||
     request.value("browserIncarnation",std::string())!=browser_incarnation))
   throw std::runtime_error("stale_browser_incarnation");
  const bool require_running=page_reply || ((method=="view.configure" || method=="view.lifecycle") && request.value("requireRunning",false));
  if(require_running) {
   if(!Alive() || !control || producer_stop_pending)throw std::runtime_error("browser not running; guarded maintenance cannot start it");
  } else Start();
  auto view=ViewId(request);
  if(method=="view.ensure" || method=="view.adopt") {
   if(!desired.contains(view) && durable_events.size()+desired.size()>=256)
    throw std::runtime_error("closed event capacity reserved; acknowledge events before creating views");
   if(method=="view.adopt" && desired.contains(view)) {
    if(desired.at(view).value("provisionalId",std::string())!=Required(request,"provisionalId"))
     throw std::runtime_error("view already belongs to another popup");
    return {{"accepted",true},{"completed",true}};
   }
   if(desired.contains(view))return ApplyView(request,false);
   return ApplyView(request,true);
  }
  if(method=="view.close") {
   CancelRecovery(view);
   const auto snapshot=BrowserSnapshot();Json identity={{"browserIncarnation",browser_incarnation}};
   for(const auto& session:snapshot.at("sessions"))for(const auto& current:session.at("views"))
    if(current.value("view",std::string())==view && current.contains("instance") && current.contains("document")) {
     identity["instance"]=current["instance"];identity["document"]=current["document"];
    }
   auto result=Rpc({{"method","view.close"},{"session",id},{"view",view},{"force",request.value("force",false)}});
   bool closed=result.value("completed",false);
   if(closed){RecordClosed(view,"requested");AckClosed(Json::array({view}));RefitOutput();identity["closed"]=true;identity["completed"]=true;return identity;}
   auto requests=Rpc({{"method","page.requests"},{"session",id},{"view",view}});
   Json output={{"accepted",true},{"pageRequests",requests.value("requests",requests)}};
   output.update(identity);
   AddCloseRequest(output,requests);return output;
  }
  if(method=="view.close.reply") {
   auto close_request_id=Required(request,"requestId");
   if(!request.contains("accept") || !request["accept"].is_boolean())throw std::runtime_error("accept boolean required");
   auto result=Rpc({{"method","page.reply"},{"session",id},{"view",view},{"request",close_request_id},{"accept",request["accept"]},
      {"instance",Required(request,"instance")},{"document",Required(request,"document")},{"close_only",true}});
   return {{"accepted",true},{"browser",result}};
  }
  if(method=="view.page.reply") {
   if(!desired.contains(view))throw std::runtime_error("view not found");
   if(!request.contains("accept") || !request["accept"].is_boolean())
    throw std::runtime_error("accept boolean required");
   Json command={{"method","page.reply"},{"session",id},{"view",view},
    {"request",Required(request,"requestId")},{"instance",Required(request,"instance")},
    {"document",Required(request,"document")},{"accept",request["accept"]},{"dialog_only",true}};
   if(request.contains("text")) {
    if(!request["text"].is_string() || request["text"].get_ref<const std::string&>().size()>16384)
     throw std::runtime_error("invalid or oversized dialog text");
    command["text"]=request["text"];
   }
   return {{"accepted",true},{"browser",Rpc(command)}};
  }
  if(method=="view.command") {
   const auto action=Required(request,"command");
   if(action!="back"&&action!="forward"&&action!="reload"&&action!="stop")throw std::runtime_error("unsupported page command");
   if(CancelRecovery(view)) {
    Rpc({{"method","view.recreate"},{"session",id},{"view",view},
         {"url",desired.at(view).value("url",std::string("about:blank"))}});
    fs::remove(directory/"recovery"/(view+".json"));ReconcileOutput();
   }
   return Rpc({{"method","page.command"},{"session",id},{"view",view},{"action",action}});
  }
  if(method=="view.lifecycle") {
   const auto action=Required(request,"action");
   if(action!="discard" && action!="restore")throw std::runtime_error("unsupported lifecycle action");
   if(Recovering(view))return {{"accepted",true},{"pending",true},{"completed",false},{"recovery",RecoveryStatus(recoveries.at(view))}};
   return Rpc({{"method","lifecycle"},{"session",id},{"view",view},{"action",action}});
  }
  if(method=="view.navigate") {
   const auto url=Required(request,"url");
   const bool cancelled=CancelRecovery(view);
   auto result=Rpc({{"method",cancelled?"view.recreate":"navigate"},{"session",id},{"view",view},{"url",url}});
   fs::remove(directory/"recovery"/(view+".json"));recovery_revisions.erase(view);
   if(desired.contains(view)){desired[view]["url"]=request["url"];Save();}
   if(cancelled)ReconcileOutput();
   return result;
  }
  if(method=="view.configure") {
   if(!desired.contains(view))throw std::runtime_error("view not found");
   auto config=desired.at(view);
   for(auto& [key,value]:request.items())if(key!="id"&&key!="method"&&key!="requireRunning")config[key]=value;
   return ApplyView(config,false);
  }
  throw std::runtime_error("unknown endpoint method: "+method);
 }
};
// stdin may remain idle for minutes while navigation completion still needs
// progress. The reader owns only its queue; Session state stays on dispatcher.
class ServiceRequests {
 std::mutex mutex_;std::condition_variable wake_;std::deque<std::string> queue_;
 bool stopping_=false,eof_=false;std::thread reader_;
 public:
 ServiceRequests():reader_([this]{
  std::string line;
  while(std::getline(std::cin,line)) {
   std::unique_lock lock(mutex_);
   wake_.wait(lock,[&]{return stopping_||queue_.size()<256;});
   if(stopping_)break;
   queue_.push_back(std::move(line));wake_.notify_all();
  }
  {std::lock_guard lock(mutex_);eof_=true;}wake_.notify_all();
 }){}
 ~ServiceRequests() {
  {std::lock_guard lock(mutex_);stopping_=true;}wake_.notify_all();
  // Cancel a synchronous stdin pipe read on shutdown. Repeating closes the
  // small race between the reader checking stopping_ and entering ReadFile.
  while(WaitForSingleObject(reader_.native_handle(),20)==WAIT_TIMEOUT)
   CancelSynchronousIo(reader_.native_handle());
  reader_.join();
 }
 bool Next(std::string& line,bool& eof) {
  std::unique_lock lock(mutex_);
  wake_.wait_for(lock,std::chrono::milliseconds(20),[&]{return eof_||!queue_.empty();});
  eof=eof_&&queue_.empty();
  if(queue_.empty())return false;
  line=std::move(queue_.front());queue_.pop_front();wake_.notify_all();return true;
 }
};
}
int main(int argc,char** argv) {
 _setmode(_fileno(stdin),_O_BINARY);_setmode(_fileno(stdout),_O_BINARY);
 try {
  struct TimerResolution {TimerResolution(){timeBeginPeriod(1);}~TimerResolution(){timeEndPeriod(1);}} timer_resolution;
  Options options;options.Parse(argc,argv);fs::create_directories(options.data);
  Sdk sdk;sdk.Open(options.browser.parent_path()/"remotekit_sdk.dll");
  auto registry=LoadJson(options.data/"sessions.json",{{"next",1},{"tenants",Json::object()}});
  std::map<std::string,std::unique_ptr<Session>> sessions;
  ServiceRequests requests;std::string maintenance_cursor,line;
  while(true) {
   bool eof=false;const bool received=requests.Next(line,eof);if(eof)break;
   if(received) {
   if(line.size()>1024*1024){std::cout<<Json({{"id",nullptr},{"ok",false},{"error","request exceeds 1 MiB"}}).dump()<<'\n'<<std::flush;continue;}
   Json request=Json::parse(line,nullptr,false),response={{"id",request.is_object()?request.value("id",Json(nullptr)):Json(nullptr)}};
   bool shutdown=false;
   try {
    if(!request.is_object())throw std::runtime_error("invalid JSON request");
    auto method=Required(request,"method");
    if(method=="shutdown"){sessions.clear();response["result"]={{"closed",true}};shutdown=true;}
    else {
     auto tenant=Required(request,"tenantId");
     if(tenant.size()>128||!std::all_of(tenant.begin(),tenant.end(),[](char c){return isalnum(static_cast<unsigned char>(c))||c=='-'||c=='_';}))
      throw std::runtime_error("invalid tenant identity");
     if(!sessions.contains(tenant)) {
      if(!registry["tenants"].contains(tenant)) {
       uint64_t id=registry["next"].get<uint64_t>();registry["next"]=id+1;
       registry["tenants"][tenant]=std::to_string(id);SaveJson(options.data/"sessions.json",registry);
      }
      sessions.emplace(tenant,std::make_unique<Session>(sdk,options,tenant,registry["tenants"][tenant].get<std::string>()));
     }
     response["result"]=sessions.at(tenant)->Command(request);
    }
    response["ok"]=true;
   }catch(const std::exception& error){response["ok"]=false;response["error"]=error.what();fprintf(stderr,"endpoint: %s\n",error.what());}
   std::cout<<response.dump()<<'\n'<<std::flush;if(shutdown)break;
   }
    for(auto& [tenant,session]:sessions)session->FlushSignals();
    // Round-robin Sessions even when no more JSONL calls arrive. A single
   // recovery step never contains a navigation completion wait.
   if(!sessions.empty()) {
    auto selected=sessions.upper_bound(maintenance_cursor);if(selected==sessions.end())selected=sessions.begin();
    maintenance_cursor=selected->first;selected->second->MaintainRecovery();
   }
  }
  sessions.clear();return 0;
 }catch(const std::exception& error){fprintf(stderr,"endpoint startup: %s\n",error.what());return 1;}
}
