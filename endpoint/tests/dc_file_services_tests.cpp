#include "remotekit/dc_file_services.hpp"
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <thread>
using namespace remotekit;
#define CHECK(value) do {if(!(value)){std::cerr<<__LINE__<<": " #value "\n";std::exit(1);}}while(false)
template<class F> bool Throws(F f){try{f();}catch(...){return true;}return false;}
template<class F> void Until(F ready){const auto end=std::chrono::steady_clock::now()+std::chrono::seconds(3);while(!ready()){CHECK(std::chrono::steady_clock::now()<end);std::this_thread::sleep_for(std::chrono::milliseconds(1));}}
ServiceJson Request(const char* id,const char* method="status") {
 return {{"type","files.request"},{"version",1},{"requestId",id},{"method",method},{"params",{{"requestId","opaque"}}}};
}
int main() {
 CHECK(DecodeFileChunk("YWJj")==std::vector<std::uint8_t>({'a','b','c'}));
 CHECK(DecodeFileChunk("YQ==")==std::vector<std::uint8_t>({'a'}));
 CHECK(DecodeFileChunk("YWI=")==std::vector<std::uint8_t>({'a','b'}));
 for(const auto* text:{"","a","====","YQ=+","YQ==YQ==","YR==","YWJ="," YQ=","!!!!"})CHECK(Throws([&]{DecodeFileChunk(text);}));
 CHECK(Throws([]{DecodeFileChunk(std::string(21848,'A'));}));
 const auto a=Request("00000000-0000-4000-8000-000000000001");
 CHECK(FileRequestEnvelope(a,a.dump().size()));CHECK(!FileRequestEnvelope(a,24577));
 auto malformed=a;malformed["requestId"]="g0000000-0000-4000-8000-000000000001";CHECK(!FileRequestEnvelope(malformed,512));
 DcFileServices services;std::atomic<unsigned> executions=0,sweeps=0;std::atomic<bool> hold=false,entered=false;
 services.Start([&](const DcFileServices::Job& job) {
  ++executions;entered=true;while(hold)std::this_thread::sleep_for(std::chrono::milliseconds(1));
  CHECK(job.control==99);return ServiceJson{{"state","selected"}};
 },[&]{++sweeps;});
 services.Bind(7,"connection");
 FileUploadStore::Binding binding{"browser","1","1","1","1"};
 services.Authorize("connection",99,{{"opaque",binding}});
 std::vector<ServiceJson> replies;
 auto flush=[&](bool busy=false){services.Flush(7,[&](const std::string& text){if(busy)return 1;replies.push_back(ServiceJson::parse(text));return 0;});};
 services.Admit(7,a);Until([&]{flush(true);return executions.load()==1;});
 Until([&]{flush();return !replies.empty();});CHECK(replies.back()["ok"]==true);
 services.Admit(7,a);Until([&]{flush();return replies.size()==2;});CHECK(executions==1);
 // SDK signaling can reenter admission while a synchronous send is active.
 // This must not require the lock held by Flush's caller.
 services.Admit(7,a);
 services.Flush(7,[&](const std::string& text){services.Admit(7,a);replies.push_back(ServiceJson::parse(text));return 0;});
 CHECK(executions==1);
 auto conflict=a;conflict["method"]="cancel";services.Admit(7,conflict);flush();CHECK(replies.back()["error"]=="file_request_id_conflict");
 // Document/navigation authorization changes invalidate queued work and sweep
 // independently of media. An old peer cannot discover a new peer's receipts.
 services.Authorize("connection",99,{});
 auto b=Request("00000000-0000-4000-8000-000000000002");services.Admit(7,b);flush();CHECK(replies.back()["error"]=="stale_file_request");
 services.Authorize("connection",99,{{"opaque",binding}});
 hold=true;entered=false;services.Admit(7,b);Until([&]{return entered.load();});
 const auto count=replies.size();services.Bind(8,"replacement");hold=false;
 Until([&]{return sweeps.load()>=2;});services.Flush(8,[&](const std::string& text){replies.push_back(ServiceJson::parse(text));return 0;});CHECK(replies.size()==count);
 CHECK(Throws([&]{services.Authorize("connection",99,{{"opaque",binding}});}));
 services.Admit(7,a);services.Flush(8,[&](const std::string&){CHECK(false);return 0;});
 services.Stop();std::cout<<"DC file admission, strict base64, receipts and peer retirement passed\n";
}
