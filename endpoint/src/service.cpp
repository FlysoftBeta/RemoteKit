#include "media/atlas_pool.hpp"
#include "media/encoder_worker.hpp"
#include "media/sdk_loader.hpp"
#include "remotekit/core.hpp"
#include "remotekit/sampling.hpp"
#include "remotekit/idle_idr.hpp"
#include <json.hpp>
#include <windows.h>
#include <mmsystem.h>
#include <wincrypt.h>
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
 fs::path browser,data;
 std::string encoder="auto";EncoderSettings encoding;
 uint32_t idle_idr_ms=150,max_encode_width=4096,max_encode_height=4096;
 int32_t rtc_playout_max_ms=-1;
 Options() {
  wchar_t executable[32768]{};GetModuleFileNameW(nullptr,executable,32768);
  browser=Utf8Path(Env("REMOTEKIT_BROWSER",Utf8(fs::path(executable).parent_path()/"remotekit_browser.exe")));
  data=Utf8Path(Env("REMOTEKIT_DATA_PATH",Env("LOCALAPPDATA",".")+"/RemoteKit/streaming"));
  encoder=Env("REMOTEKIT_ENCODER","auto");encoding.bitrate=18000000;encoding.max_bitrate=40000000;
 }
 void Parse(int argc,char** argv) {
  for(int i=1;i<argc;++i){std::string arg=argv[i];auto equal=arg.find('=');
   if(equal==std::string::npos)throw std::runtime_error("arguments require --name=value");
   auto key=arg.substr(0,equal),value=arg.substr(equal+1);
   if(key=="--browser")browser=Utf8Path(value);else if(key=="--data-path")data=Utf8Path(value);
   else if(key=="--encoder")encoder=value;
   else if(key=="--fps")encoding.fps=std::stoul(value);
   else if(key=="--bitrate")encoding.bitrate=std::stoul(value);
   else if(key=="--max-bitrate")encoding.max_bitrate=std::stoul(value);
   else if(key=="--async-depth")encoding.async_depth=std::stoul(value);
   else if(key=="--gop")encoding.gop=std::stoul(value);
   else if(key=="--target-usage"){encoding.target_usage=std::stoul(value);encoding.target_usage_explicit=true;}
   else if(key=="--qsv-low-power"){
    if(value!="auto"&&value!="on"&&value!="off")throw std::runtime_error("qsv-low-power must be auto, on or off");
    encoding.qsv_low_power=value=="on"?0x10u:(value=="off"?0x20u:0u);
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
     encoding.bitrate<100000||encoding.bitrate>50000000||encoding.max_bitrate>60000000||
     encoding.gop<1||encoding.gop>65535||encoding.buffer_ms<50||encoding.buffer_ms>5000||
     max_encode_width<16||max_encode_height<16||max_encode_width>4096||max_encode_height>4096)
   throw std::runtime_error("invalid encoder settings");
  browser=fs::absolute(browser);data=fs::absolute(data);
  if(encoder=="nvenc"&&encoding.qsv_low_power)throw std::runtime_error("qsv-low-power requires qsv or auto encoder");
  if(rtc_playout_max_ms!=-1&&(rtc_playout_max_ms<0||rtc_playout_max_ms>40950||rtc_playout_max_ms%10))
   throw std::runtime_error("rtc-playout-max-ms must be -1 or a multiple of 10 in 0..40950");
 }
};
struct Session {
 Sdk& sdk;const Options& options;std::string tenant,id;fs::path directory;
 HANDLE process=nullptr,job=nullptr;uint64_t control=0;int request_id=0;
 std::mutex rpc_mutex;
 std::map<std::string,Json> desired;
 int atlas_width=1920,atlas_height=1080;float atlas_scale=1;
 AtlasPool pool;std::thread media_thread;std::atomic<bool> stop_media{false};
 std::atomic<uint64_t> peer{0};std::string connection;
 std::shared_ptr<EncoderStats> stats=std::make_shared<EncoderStats>();
 std::mutex encoder_mutex;std::map<uint64_t,std::unique_ptr<EncoderWorker>> encoders;
 ComPtr<ID3D11Device> encoder_device;
 struct Event{uint32_t type;std::string bytes,auxiliary;int32_t value;uint64_t peer;};
 std::mutex event_mutex;std::condition_variable event_wake;std::deque<Event> events;
 std::mutex signal_mutex;std::string answer,rtc_error;bool ice_complete=false;
 std::condition_variable signal_wake;
 std::mutex input_mutex;std::condition_variable input_wake;std::deque<Event> input_queue;
 std::thread input_thread;std::atomic<bool> stop_input{false};
 std::atomic<uint64_t> input_rejected{0},input_coalesced{0};
 Json layout;std::atomic<bool> data_open{false};
 bool output_suspended=false;
 std::string current_geometry;
 std::map<std::pair<uint64_t,uint64_t>,uint64_t> publication_epochs;
 std::atomic<uint64_t> layout_epoch{0};
 std::atomic<uint32_t> receive_level{0};
 std::atomic<bool> refresh_connected{false};
 std::atomic<uint32_t> effective_idle_ms{150};
 std::atomic<double> source_interval_ms{0},last_tail_age_ms{0};
 std::atomic<uint64_t> tail_submissions{0};
 remotekit::MediaSampling sampling;
 std::map<std::string,std::string> recovery_documents;
 Session(Sdk& api,const Options& opts,std::string tenant_id,std::string session_id):sdk(api),options(opts),
   tenant(std::move(tenant_id)),id(std::move(session_id)),directory(options.data/"sessions"/id) {
  effective_idle_ms=std::min(1000u,options.idle_idr_ms);
  fs::create_directories(directory);
  auto saved=LoadJson(directory/"views.json",Json::array());
  for(auto& view:saved)desired[ViewId(view)]=view;
 }
 ~Session(){Stop();}
 void Save(){Json values=Json::array();for(auto& [view,config]:desired)values.push_back(config);SaveJson(directory/"views.json",values);}
 Json Rpc(Json command) {
  std::lock_guard lock(rpc_mutex);
  if(!control)throw std::runtime_error("browser control unavailable");
  command["version"]=1;command["id"]=++request_id;
  std::string encoded=command.dump();std::vector<char> response(1024*1024);size_t count=0;
  int status=sdk.remotekit_sdk_control_request(control,encoded.data(),encoded.size(),response.data(),response.size(),&count,10000);
  if(status!=0){control=0;throw std::runtime_error("browser request transport "+std::to_string(status));}
  Json result=Json::parse(response.data(),response.data()+count);
  if(!result.value("ok",false))throw std::runtime_error("browser: "+result.value("error",std::string("command failed")));
  return result;
 }
 bool Alive() const{return process&&WaitForSingleObject(process,0)==WAIT_TIMEOUT;}
 void Start() {
  if(Alive()&&control)return;
  Stop();
  job=CreateJobObjectW(nullptr,nullptr);if(!job)throw std::runtime_error("CreateJobObject failed");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits)))throw std::runtime_error("job limits failed");
  std::string channel="RemoteKit.service."+std::to_string(GetCurrentProcessId())+"."+id+"."+std::to_string(QpcNow());
  std::wstring command=Quote(options.browser.wstring());
  auto append=[&](std::wstring arg){command+=L" "+Quote(arg);};
  append(L"--control-channel="+std::wstring(channel.begin(),channel.end()));
  append(L"--session-id="+std::wstring(id.begin(),id.end()));
  append(L"--tenant-id="+std::wstring(id.begin(),id.end()));
  append(L"--data-path="+directory.wstring());
  append(L"--atlas-width=1920");append(L"--atlas-height=1080");
  STARTUPINFOW startup{};startup.cb=sizeof(startup);startup.dwFlags=STARTF_USESHOWWINDOW;startup.wShowWindow=SW_HIDE;
  PROCESS_INFORMATION info{};
  if(!CreateProcessW(options.browser.c_str(),command.data(),nullptr,nullptr,FALSE,CREATE_SUSPENDED|CREATE_NO_WINDOW,
       nullptr,options.browser.parent_path().c_str(),&startup,&info))throw std::runtime_error("browser launch Windows "+std::to_string(GetLastError()));
  process=info.hProcess;
  if(!AssignProcessToJobObject(job,process)||ResumeThread(info.hThread)==DWORD(-1)) {
   CloseHandle(info.hThread);throw std::runtime_error("browser job/start failed");
  }
  CloseHandle(info.hThread);
  auto deadline=QpcNow()+QpcFrequency()*15;
  int status=1;
  while(Alive()&&QpcNow()<deadline) {
   status=sdk.remotekit_sdk_control_connect(channel.c_str(),&control);
   if(status==0)break;std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
  if(status!=0||!control)throw std::runtime_error("browser control connect failed "+std::to_string(status));
  fprintf(stderr,"session %s browser pid %lu\n",id.c_str(),GetProcessId(process));
  if(!desired.empty()) {
   // Expand to all desired visible planes before recreation. No decoder exists
   // yet; one final configure below chooses the exact current output extent.
   auto geometry=DesiredGeometry();Geometry expanded=geometry;
   expanded.width=std::max(geometry.width,atlas_width);expanded.height=std::max(geometry.height,atlas_height);
   GeometryConfig(expanded);
   for(auto& [view,config]:desired)CreateView(config,true);
   GeometryConfig(geometry);
  }
 }
 Json BrowserSnapshot(){return Rpc({{"method","snapshot"}});}
 struct Geometry {int width=16,height=16;float scale=1;};
 Geometry DesiredGeometry() {
  Geometry value;int width=0,height=0;
  for(auto& [view,config]:desired) {
   if(!config.value("visible",false))continue;
   const auto device=config.value("device",Json::object());
   int w=config.value("width",device.value("width",1440));
   int h=config.value("height",device.value("height",900));
   if(w<1||h<1||w>8192||h>8192)throw std::runtime_error("invalid viewport dimensions");
   width+=w+8;height=std::max(height,h+8);
   value.scale=std::max(value.scale,device.value("deviceScaleFactor",1.0f));
  }
  value.width=std::max(16,width);value.height=std::max(16,height);
  const uint64_t pixels=uint64_t(std::ceil(value.width*value.scale))*uint64_t(std::ceil(value.height*value.scale));
  if(value.scale<0.5||value.scale>4 || value.width>8192 || value.height>8192 || value.width*value.scale>8192 || value.height*value.scale>8192 ||
     pixels>16777216)throw std::runtime_error("visible source atlas exceeds the 16-megapixel/8192-pixel resource budget");
  return value;
 }
 bool PauseOutput() {
  const bool active=peer.load()!=0;
  if(active){stop_media=true;event_wake.notify_all();if(media_thread.joinable())media_thread.join();}
  try{Rpc({{"method","output.close"}});}catch(const std::exception&){}
  return active;
 }
 void GeometryConfig(const Geometry& value) {
  Rpc({{"method","output.configure"},{"width",value.width},{"height",value.height},
       {"device_scale",value.scale},{"fps",options.encoding.fps}});
  atlas_width=value.width;atlas_height=value.height;atlas_scale=value.scale;
 }
 void RefitOutput() {
  const auto geometry=DesiredGeometry();
  if(geometry.width==atlas_width&&geometry.height==atlas_height&&geometry.scale==atlas_scale)return;
  const bool active=PauseOutput();
  try{GeometryConfig(geometry);ResumeOutput(active);}catch(...){
   try{ResumeOutput(active);}catch(const std::exception&){}throw;
  }
 }
 void ResumeOutput(bool active) {
  if(!active)return;
  OpenOutput();layout=Json();stop_media=false;
  media_thread=std::thread([this]{MediaLoop();});
 }
 Json ApplyView(const Json& config,bool create,bool recovering=false) {
  auto view=ViewId(config);auto old=desired.find(view);
  Json previous=old==desired.end()?Json():old->second;
  auto normalized=[](Json value){value.erase("id");value.erase("method");return value;};
  if(!previous.is_null() && normalized(previous)==normalized(config))return {{"accepted",true},{"completed",true}};
  desired[view]=config;Geometry geometry;
  try{geometry=DesiredGeometry();}catch(...){if(previous.is_null())desired.erase(view);else desired[view]=previous;throw;}
  const bool active=PauseOutput();
  try {
   Geometry expanded=geometry;expanded.width=std::max(geometry.width,atlas_width);
   expanded.height=std::max(geometry.height,atlas_height);
   GeometryConfig(expanded);
   Json result;
   if(create)result=CreateView(config,recovering);
   else {
    const auto device=config.value("device",Json::object());
    Json request={{"method","view.configure"},{"session",id},{"view",view},
     {"width",config.value("width",device.value("width",1440))},
     {"height",config.value("height",device.value("height",900))},
     {"device",device.value("mode",std::string("desktop"))},{"visible",config.value("visible",false)}};
    if(device.contains("deviceScaleFactor"))request["device_scale_factor"]=device["deviceScaleFactor"];
    result=Rpc(request);
   }
   GeometryConfig(geometry);Save();ResumeOutput(active);return result;
  } catch(...) {
   if(previous.is_null())desired.erase(view);else desired[view]=previous;
   try{ResumeOutput(active);}catch(const std::exception& error){fprintf(stderr,"output resume: %s\n",error.what());}
   throw;
  }
 }
 Json CreateView(const Json& config,bool recovering=false) {
  auto view=ViewId(config);auto device=config.value("device",Json::object());
  std::string mode=device.is_object()?device.value("mode",std::string("desktop")):std::string("desktop");
  Json request={{"method","view.create"},{"session",id},{"view",view},{"url",recovering && fs::exists(directory/"recovery"/(view+".json")) ? std::string("about:blank") : config.value("url",std::string("about:blank"))},
    {"width",config.value("width",device.value("width",1440))},{"height",config.value("height",device.value("height",900))},
    {"device",mode},{"visible",config.value("visible",false)}};
  if(device.contains("deviceScaleFactor"))request["device_scale_factor"]=device["deviceScaleFactor"];
  auto result=Rpc(request);
  if(recovering)RestoreNavigation(view);
  return result;
 }
 void RestoreNavigation(const std::string& view) {
  const auto path=directory/"recovery"/(view+".json");if(!fs::exists(path))return;
  try {
   auto saved=LoadJson(path);
   for(int attempt=0;attempt<100;++attempt) {
    bool settled=false;
    auto snapshot=BrowserSnapshot();
    for(auto& session:snapshot["sessions"])for(auto& current:session["views"])
     if(current.value("view",std::string())==view && !current.value("loading",false))settled=true;
    if(settled)break;std::this_thread::sleep_for(std::chrono::milliseconds(10));
   }
   Rpc({{"method","lifecycle"},{"session",id},{"view",view},{"action","unload"}});
   auto begin=Rpc({{"method","navigation.import.begin"},{"session",id},{"view",view},{"size",saved.at("size")}});
   auto transfer=begin.at("transfer");uint64_t offset=0;
   for(auto& chunk:saved.at("chunks")) {
    Rpc({{"method","navigation.import.chunk"},{"session",id},{"view",view},{"transfer",transfer},
         {"offset",std::to_string(offset)},{"data",chunk.at("data")}});
    offset+=chunk.at("bytes").get<uint64_t>();
   }
   Rpc({{"method","navigation.import.commit"},{"session",id},{"view",view},{"transfer",transfer}});
   Rpc({{"method","lifecycle"},{"session",id},{"view",view},{"action","restore"}});
   bool restored=false;
   const auto deadline=QpcNow()+QpcFrequency()*11;
   while(QpcNow()<deadline && !restored) {
    auto snapshot=BrowserSnapshot();
    for(auto& session:snapshot["sessions"])for(auto& current:session["views"])
     if(current.value("view",std::string())==view && !current.value("pending",true) && current.value("actual",-1)==0)restored=true;
    if(!restored)std::this_thread::sleep_for(std::chrono::milliseconds(20));
   }
   if(!restored)throw std::runtime_error("navigation recovery did not finish");
   Rpc({{"method","visible"},{"session",id},{"view",view},{"visible",desired.at(view).value("visible",false)}});
  } catch(const std::exception& error) {
   fprintf(stderr,"session %s view %s navigation recovery: %s\n",id.c_str(),view.c_str(),error.what());
   // Reconstruct from product URL with a fresh GET, never replay a saved POST.
   Rpc({{"method","view.recreate"},{"session",id},{"view",view},
        {"url",desired.at(view).value("url",std::string("about:blank"))}});
  }
 }
 void CaptureNavigation(const Json& browser_view) {
  if(!browser_view.contains("document")||browser_view.value("loading",false)||browser_view.value("pending",false))return;
  const std::string view=browser_view.at("view"),document=browser_view.at("document");
  if(recovery_documents[view]==document)return;
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
   SaveJson(directory/"recovery"/(view+".json"),{{"size",std::to_string(size)},{"chunks",chunks}});
   recovery_documents[view]=document;
  }catch(const std::exception& error){fprintf(stderr,"navigation save: %s\n",error.what());}
 }
 Json Stats() {
  auto value=stats->Snapshot();value["configuredIdleIdrMs"]=options.idle_idr_ms;
  value["rtcPlayoutDelayRequested"]={{"minMs",options.rtc_playout_max_ms<0?-1:0},
                                     {"maxMs",options.rtc_playout_max_ms}};
  value["effectiveIdleIdrMs"]=effective_idle_ms.load();value["tailIdrSubmissions"]=tail_submissions.load();
  const auto interval=source_interval_ms.load(),age=last_tail_age_ms.load();
  value["sourceFrameIntervalMs"]=interval>0?Json(interval):Json(nullptr);
  value["lastTailAfterSourceMs"]=age>0?Json(age):Json(nullptr);return value;
 }
 Json Snapshot() {
  Start();auto snapshot=BrowserSnapshot();Json views=Json::array();bool removed=false;
  for(auto& session:snapshot.at("sessions"))for(auto& view:session.at("views")) {
   std::string view_id=view.at("view");
   if(view.value("close_state",std::string())=="closed") {
    if(desired.erase(view_id)){removed=true;Save();fs::remove(directory/"recovery"/(view_id+".json"));}
    continue;
   }
   Json item=view;item["viewId"]=view_id;
   auto requests=Rpc({{"method","page.requests"},{"session",id},{"view",view_id}});
   AddCloseRequest(item,requests);
   CaptureNavigation(view);views.push_back(std::move(item));
  }
  if(removed)RefitOutput();
  return {{"sessionId",id},{"browserPid",process?GetProcessId(process):0},{"views",views},{"running",Alive()},{"stats",Stats()}};
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
 void Stop() {
  ClosePeer();
  if(control){sdk.remotekit_sdk_control_close(control);control=0;}
  if(job){CloseHandle(job);job=nullptr;}
  if(process){WaitForSingleObject(process,5000);CloseHandle(process);process=nullptr;}
  // A new browser may restart its local generation counters at one. Its
  // resources/documents still belong to a new presentation incarnation.
  current_geometry.clear();publication_epochs.clear();
 }
 static void EventCallback(void* context,uint64_t peer,uint32_t type,const void* bytes,size_t size,
                           const char* auxiliary,int32_t value) {
  auto* self=static_cast<Session*>(context);
  Event event{type,std::string(static_cast<const char*>(bytes?bytes:""),size),auxiliary?auxiliary:"",value,peer};
  if(type==REMOTEKIT_RTC_ICE_COMPLETE || type==REMOTEKIT_RTC_ERROR) {
   std::lock_guard lock(self->signal_mutex);
   if(type==REMOTEKIT_RTC_ICE_COMPLETE){self->answer=event.bytes;self->ice_complete=true;}
   else self->rtc_error=event.bytes;
   self->signal_wake.notify_all();
  }
  {std::lock_guard lock(self->event_mutex);if(self->events.size()<1024)self->events.push_back(std::move(event));}
  self->event_wake.notify_all();
 }
 static int CreateEncoder(void* context,uint64_t encoder_peer,uint64_t encoder) {
  auto* self=static_cast<Session*>(context);std::lock_guard lock(self->encoder_mutex);
  self->encoders.emplace(encoder,std::make_unique<EncoderWorker>(self->sdk,encoder,self->encoder_device.Get(),
         self->options.encoder,self->options.encoding,self->stats,
      [self,encoder_peer](uint32_t timestamp,uint64_t epoch,size_t encoded_bytes,bool keyframe) {
       // Enqueue only: signaling-thread destroy joins this encoder worker.
       Json message={{"type","frame"},{"rtpTimestamp",timestamp},{"layoutEpoch",std::to_string(epoch)},
                     {"encodedBytes",encoded_bytes},{"keyframe",keyframe}};
       std::lock_guard event_lock(self->event_mutex);
       if(self->events.size()<1024)self->events.push_back(Event{0x10000,message.dump(),"",0,encoder_peer});
       self->event_wake.notify_one();
      }));return 0;
 }
 static int ConfigureEncoder(void* context,uint64_t encoder,const remotekit_rtc_encoder_config* config) {
  auto* self=static_cast<Session*>(context);std::lock_guard lock(self->encoder_mutex);
  auto found=self->encoders.find(encoder);return found!=self->encoders.end()&&found->second->Configure(*config)?0:1;
 }
 static int Encode(void* context,uint64_t encoder,const remotekit_rtc_frame* frame,int key) {
  auto* self=static_cast<Session*>(context);std::lock_guard lock(self->encoder_mutex);
  auto found=self->encoders.find(encoder);return found!=self->encoders.end()&&found->second->Enqueue(*frame,key!=0)?0:REMOTEKIT_SDK_BUSY;
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
 void OpenOutput() {
  // GPU resources are initialized by the first capture. With no subscribed
  // view there is no capture to wait for; keep RTC/DataChannel alive instead.
  output_suspended=std::none_of(desired.begin(),desired.end(),[](const auto& entry){
   return entry.second.value("visible",false);
  });
  if(output_suspended)return;
  remotekit_rtc_clock_sample clock{};clock.struct_size=sizeof(clock);
  if(sdk.sample_clock && sdk.sample_clock(&clock)==0)pool.SetClock(clock);
  remotekit_sdk_atlas_setup setup{};setup.struct_size=sizeof(setup);
  int result;
  {std::lock_guard lock(rpc_mutex);result=sdk.remotekit_sdk_control_open_atlas(control,GetCurrentProcessId(),options.encoding.fps,&setup,15000);}
  if(result!=0)throw std::runtime_error("output open SDK "+std::to_string(result));
  std::string error;if(!pool.Open(setup,std::min(16u,options.encoding.async_depth+4),error))throw std::runtime_error(error);
  {std::lock_guard lock(encoder_mutex);encoder_device=pool.Device();}
 }
 void Send(const Json& message) {
  auto handle=peer.load();if(!handle||!data_open)return;
  auto encoded=message.dump();sdk.remotekit_rtc_send_data(handle,encoded.data(),encoded.size(),0);
 }
 Json Layout(const remotekit::SharedAtlasFrame& frame) {
  auto fit=remotekit::FitH264Sampling(frame.width_pixels,frame.height_pixels,options.encoding.fps,receive_level.load(),options.max_encode_width,options.max_encode_height);
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
  for(auto& view:value["views"]) {view.erase("focus");view.erase("stale");}
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
  }
  Send(reply);
 }
 void HandleData(const Event& event) {
  if(event.value!=0 || event.peer!=peer.load())return;
  auto command=Json::parse(event.bytes,nullptr,false);if(command.is_discarded()||!command.is_object())return;
  auto type=command.value("type",std::string());
  if(type!="input"&&type!="focus")return;
  const auto request=command;
  if(command.value("layoutEpoch",std::string())!=std::to_string(layout_epoch.load())) {
   ++input_rejected;ReplyInput({{"ok",false},{"error","stale_layout_epoch"}},request);return;
  }
  command.erase("layoutEpoch");command.erase("focusRequestId");
  if(command.value("session",std::string())!=id) {
   ++input_rejected;ReplyInput({{"ok",false},{"error","wrong_session"}},request);return;
  }
  command["method"]=type;command.erase("type");
  if(command.contains("outputGeneration")){command["output_generation"]=command["outputGeneration"];command.erase("outputGeneration");}
  // This connection is already bound to this Session by authenticated Control.
  // The browser validates membership and all token/sequence/output generations.
  try {ReplyInput(Rpc(command),request);}
  catch(const std::exception& error){ReplyInput({{"ok",false},{"error",error.what()}},request);}
 }
 void QueueInput(const Event& event) {
  std::lock_guard lock(input_mutex);
  auto parsed=Json::parse(event.bytes,nullptr,false);
  bool move=!parsed.is_discarded()&&parsed.value("type",std::string())=="input"&&parsed.contains("event")&&
    parsed["event"].value("type",std::string())=="mouse"&&parsed["event"].value("action",std::string())=="move";
  if(move&&!input_queue.empty()) {
   auto before=Json::parse(input_queue.back().bytes,nullptr,false);
   if(!before.is_discarded()&&before.value("view",std::string())==parsed.value("view",std::string())&&
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
  remotekit_rtc_frame latest{};int64_t last_update=QpcNow(),last_stats=last_update;
  uint64_t previous_encoded=stats->completed.load(),previous_bytes=stats->bytes.load(),previous_copies=pool.copied_frames();
  bool idle_sent=false,stream_started=false;remotekit::IdleIdrPolicy idle(options.idle_idr_ms);
  effective_idle_ms=idle.delay_ms();source_interval_ms=0;
  while(!stop_media) {
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
    } else if(event.type==REMOTEKIT_RTC_STATE && event.value==2) {
     refresh_connected=true;
    } else if(event.type==REMOTEKIT_RTC_DATA_STATE) {
     const bool opened=event.value==1;
     if(opened&&!data_open.exchange(opened))refresh_connected=true;
     if(!opened)data_open=false;
     if(data_open&&!layout.empty())Send(layout);
    } else if(event.type==REMOTEKIT_RTC_DATA) {
     try{QueueInput(event);}catch(const std::exception& error){++input_rejected;Send({{"type","input.result"},{"ok",false},{"error",error.what()}});}
    }
    else if(event.type==REMOTEKIT_RTC_ERROR)fprintf(stderr,"RTC %s: %s\n",id.c_str(),event.bytes.c_str());
   }
   remotekit_rtc_frame frame{};remotekit::SharedAtlasFrame metadata{};std::string error;
   auto result=output_suspended?AtlasPool::Result::idle:pool.Poll(frame,metadata,error);
   if(result==AtlasPool::Result::error) {
    {std::lock_guard lock(stats->mutex);stats->error=error;}
    fprintf(stderr,"session %s media: %s\n",id.c_str(),error.c_str());break;
   }
   const auto current_metadata=output_suspended?remotekit::SharedAtlasFrame{}:pool.LatestMetadata();
   if(output_suspended) {
    if(current_geometry!="no-visible-views"){current_geometry="no-visible-views";layout_epoch.fetch_add(1);}
    Json empty={{"type","layout"},{"generation","0"},{"width",16},{"height",16},
                {"mediaScale",1},{"views",Json::array()},{"epoch",std::to_string(layout_epoch.load())}};
    if(empty!=layout){layout=std::move(empty);Send(layout);}
   }
   if(current_metadata.generation) {
    auto next=Layout(current_metadata);next["epoch"]=std::to_string(ObserveLayout(current_metadata));
    if(next!=layout){layout=next;Send(layout);}
   }
   const auto handle=peer.load();const auto now=QpcNow();
   if(result==AtlasPool::Result::ready) {
    frame.layout_epoch=FrameEpoch(metadata);
    sampling=remotekit::FitH264Sampling(frame.width,frame.height,options.encoding.fps,receive_level.load(),options.max_encode_width,options.max_encode_height);
    if(sampling.width){frame.width=sampling.width;frame.height=sampling.height;}
    if(latest.release)latest.release(latest.release_context,latest.frame_id);
    latest=frame;latest.retain(latest.release_context,latest.frame_id);
    if(refresh_connected.exchange(false)) {
     std::lock_guard lock(encoder_mutex);for(auto& [encoder,worker]:encoders)worker->Keyframe();
    }
    if(!handle || !receive_level.load() || sdk.remotekit_rtc_submit_texture(handle,&frame)!=0)frame.release(frame.release_context,frame.frame_id);
    stream_started=receive_level.load()!=0;
    if(idle.Observe(metadata.generation,metadata.frame_id,metadata.capture_time_us,
                    1000.0*now/QpcFrequency())) {
     last_update=now;idle_sent=false;effective_idle_ms=idle.delay_ms();source_interval_ms=idle.interval_ms();
    }
   } else if(handle && receive_level.load() && latest.release &&
             (!stream_started || refresh_connected.load() || (!idle_sent && idle.delay_ms() &&
              now-last_update>=QpcFrequency()*idle.delay_ms()/1000))) {
    const bool tail=stream_started&&!refresh_connected.load()&&!idle_sent&&idle.delay_ms()&&
        now-last_update>=QpcFrequency()*idle.delay_ms()/1000;
    refresh_connected=false;
    {std::lock_guard lock(encoder_mutex);for(auto& [encoder,worker]:encoders)worker->Keyframe();}
    auto repeat=latest;
    sampling=remotekit::FitH264Sampling(current_metadata.width_pixels,current_metadata.height_pixels,
                                      options.encoding.fps,receive_level.load(),options.max_encode_width,options.max_encode_height);
    if(sampling.width){repeat.width=sampling.width;repeat.height=sampling.height;}
    if(!stream_started)repeat.layout_epoch=FrameEpoch(current_metadata);
    repeat.retain(repeat.release_context,repeat.frame_id);
    // Tail IDR retains content epoch and capture time. SDK assigns a fresh
    // submit/RTP timestamp independently.
    if(sdk.remotekit_rtc_submit_texture(handle,&repeat)!=0)repeat.release(repeat.release_context,repeat.frame_id);
    else if(tail){++tail_submissions;last_tail_age_ms=1000.0*(now-last_update)/QpcFrequency();}
    stream_started=true;idle_sent=true;
   }
   if(now-last_stats>=QpcFrequency()) {
    if(handle && sdk.request_stats)sdk.request_stats(handle);
    auto report=Stats();report["type"]="stats";
    const double seconds=static_cast<double>(now-last_stats)/QpcFrequency();
    const auto encoded=stats->completed.load(),bytes=stats->bytes.load(),copies=pool.copied_frames();
    report["encodedFps"]=(encoded-previous_encoded)/seconds;
    report["encodedBitrateBps"]=8.0*(bytes-previous_bytes)/seconds;
    report["atlasCopies"]=copies;report["atlasCopyFps"]=(copies-previous_copies)/seconds;
    previous_encoded=encoded;previous_bytes=bytes;previous_copies=copies;
    report["atlasPoolDrops"]=pool.drops();report["lastGpuCopyMs"]=pool.last_copy_ms();
    report["sourceWidth"]=current_metadata.width_pixels;report["sourceHeight"]=current_metadata.height_pixels;
    report["sourceAtlasWidth"]=current_metadata.width_pixels;report["sourceAtlasHeight"]=current_metadata.height_pixels;
    report["encodedWidth"]=sampling.width;report["encodedHeight"]=sampling.height;report["mediaScale"]=sampling.scale;
    report["receiveLevel"]=receive_level.load();
    report["inputRejected"]=input_rejected.load();report["inputCoalesced"]=input_coalesced.load();
    {std::lock_guard lock(input_mutex);report["inputQueue"]=input_queue.size();}
    const auto latency=pool.capture_to_ready_ms();
    report["captureToReadyMs"]=latency?Json(*latency):Json(nullptr);
    report["captureClock"]=latency?"measured SDK TimeTicks to QPC mapping":"unavailable";
    report["clockUncertaintyUs"]=pool.clock_uncertainty_us();
    Send(report);last_stats=now;
   }
   std::unique_lock lock(event_mutex);event_wake.wait_for(lock,std::chrono::milliseconds(1),[&]{return stop_media||!events.empty();});
  }
  if(latest.release)latest.release(latest.release_context,latest.frame_id);
 }
 Json Offer(const Json& request) {
  Start();ClosePeer();OpenOutput();
  connection=Required(request,"connectionId");
  {std::lock_guard lock(signal_mutex);answer.clear();rtc_error.clear();ice_complete=false;}
  remotekit_rtc_options config{};config.struct_size=sizeof(config);config.abi_version=REMOTEKIT_RTC_ABI_VERSION;
  config.context=this;config.event=EventCallback;config.encoder.struct_size=sizeof(config.encoder);
  config.encoder.create=CreateEncoder;config.encoder.configure=ConfigureEncoder;config.encoder.encode=Encode;
  config.encoder.set_rates=Rates;config.encoder.request_keyframe=Keyframe;config.encoder.destroy=DestroyEncoder;
  config.min_bitrate_bps=500000;config.start_bitrate_bps=options.encoding.bitrate;config.max_bitrate_bps=options.encoding.max_bitrate;
  uint64_t handle=0;
  if(sdk.remotekit_rtc_create(&config,&handle)!=0)throw std::runtime_error("RTC create failed");
  receive_level=0;refresh_connected=false;peer=handle;stop_media=false;data_open=false;layout=Json();
  if(options.rtc_playout_max_ms>=0) {
   const int status=sdk.remotekit_rtc_set_playout_delay(handle,0,options.rtc_playout_max_ms);
   if(status!=0){ClosePeer();throw std::runtime_error("RTC playout delay rejected (SDK "+std::to_string(status)+")");}
  }
  auto sdp=Required(request,"sdp");
  if(sdk.remotekit_rtc_set_remote_description(handle,1,sdp.data(),sdp.size())!=0) {
   ClosePeer();throw std::runtime_error("RTC remote offer rejected");
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
  event_wake.notify_all();
  return {{"sdp",gathered_answer},{"type","answer"},{"connectionId",connection}};
 }
 void ClosePeer() {
  stop_input=true;input_wake.notify_all();if(input_thread.joinable())input_thread.join();
  stop_media=true;event_wake.notify_all();if(media_thread.joinable())media_thread.join();
  {std::lock_guard lock(input_mutex);input_queue.clear();}
  auto handle=peer.exchange(0);if(handle)sdk.remotekit_rtc_close(handle);
  std::map<uint64_t,std::unique_ptr<EncoderWorker>> remaining;
  {std::lock_guard lock(encoder_mutex);remaining.swap(encoders);}remaining.clear();
  std::string error;if(!pool.Close(error))fprintf(stderr,"pool close: %s\n",error.c_str());
  data_open=false;connection.clear();
  {std::lock_guard lock(stats->mutex);stats->sender_rtc_stats=nullptr;}
  {std::lock_guard lock(event_mutex);events.clear();}
  if(control){try{Rpc({{"method","output.close"}});}catch(const std::exception&){}}
 }
 Json Command(const Json& request) {
  const auto method=Required(request,"method");
  if(method=="session.ensure"){Start();return {{"sessionId",id},{"browserPid",GetProcessId(process)},{"running",true}};}
  if(method=="session.snapshot")return Snapshot();
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
  Start();auto view=ViewId(request);
  if(method=="view.ensure") {
   if(desired.contains(view))return ApplyView(request,false);
   return ApplyView(request,true);
  }
  if(method=="view.close") {
   auto result=Rpc({{"method","view.close"},{"session",id},{"view",view},{"force",request.value("force",false)}});
   bool closed=result.value("completed",false);
   if(closed){desired.erase(view);Save();fs::remove(directory/"recovery"/(view+".json"));RefitOutput();return {{"closed",true}};}
   Json output={{"accepted",true}};AddCloseRequest(output,Rpc({{"method","page.requests"},{"session",id},{"view",view}}));return output;
  }
  if(method=="view.close.reply") {
   auto close_request_id=Required(request,"requestId");
   auto result=Rpc({{"method","page.reply"},{"session",id},{"view",view},{"request",close_request_id},{"accept",request.at("accept")}});
   return {{"accepted",true},{"browser",result}};
  }
  if(method=="view.command") {
   const auto action=Required(request,"command");
   if(action!="back"&&action!="forward"&&action!="reload"&&action!="stop")throw std::runtime_error("unsupported page command");
   return Rpc({{"method","page.command"},{"session",id},{"view",view},{"action",action}});
  }
  if(method=="view.navigate") {
   auto result=Rpc({{"method","navigate"},{"session",id},{"view",view},{"url",Required(request,"url")}});
   if(desired.contains(view)){desired[view]["url"]=request["url"];Save();}return result;
  }
  if(method=="view.configure") {
   if(!desired.contains(view))throw std::runtime_error("view not found");
   auto config=desired.at(view);
   for(auto& [key,value]:request.items())if(key!="id"&&key!="method")config[key]=value;
   return ApplyView(config,false);
  }
  throw std::runtime_error("unknown endpoint method: "+method);
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
  std::string line;
  while(std::getline(std::cin,line)) {
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
  sessions.clear();return 0;
 }catch(const std::exception& error){fprintf(stderr,"endpoint startup: %s\n",error.what());return 1;}
}
