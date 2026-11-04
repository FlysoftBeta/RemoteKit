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
 CHECK(EncodeFileChunk({})=="");
 CHECK(EncodeFileChunk({'a','b'})=="YWI=");
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
 services.Stop();
 DcFileServices library;
 entered=false;hold=false;executions=0;
 library.Start([&](const DcFileServices::Job& job) {
  const auto n=++executions;entered=true;
  while(hold)std::this_thread::sleep_for(std::chrono::milliseconds(1));
  return ServiceJson{{"sequence",n},{"current",library.Current(job)}};
 },[]{});
 library.Bind(9,"library-peer");
 auto asset=Request("00000000-0000-4000-8000-000000000003","photo.thumbnail");
 asset["params"]["requestId"]="library";
 asset["params"]["assetId"]=std::string(64,'a');
 CHECK(FileRequestEnvelope(asset,asset.dump().size()));
 auto chooser_asset=asset;chooser_asset["params"]["requestId"]="opaque";
 auto library_commit=asset;library_commit["method"]="selection.commit";
 replies.clear();
 const auto drain=[&]{
  library.Flush(9,[&](const std::string& wire){replies.push_back(ServiceJson::parse(wire));return 0;});
 };
 library.Authorize("library-peer",99,{{"opaque",binding}});
 library.Admit(9,asset);drain();CHECK(replies.back()["error"]=="stale_file_request");
 library.Authorize("library-peer",99,{{"opaque",binding}},true);
 library.Admit(9,chooser_asset);library.Admit(9,library_commit);drain();
 CHECK(replies.size()==3 && replies.back()["error"]=="stale_file_request");
 hold=true;library.Admit(9,asset);Until([&]{return entered.load();});
 library.Authorize("library-peer",99,{},true); // Retire chooser only.
 hold=false;
 Until([&]{drain();return replies.size()==4;});
 CHECK(replies.back()["result"]["current"]==true);
 asset["requestId"]="00000000-0000-4000-8000-000000000004";
 hold=true;entered=false;library.Admit(9,asset);Until([&]{return entered.load();});
 library.Authorize("library-peer",99,{},false);
 library.Authorize("library-peer",99,{},true);
 library.Admit(9,asset);hold=false;
 Until([&]{drain();return replies.size()==5;});
 CHECK(replies.back()["result"]["sequence"]==3 && replies.back()["result"]["current"]==true);
 library.Stop();
 std::cout<<"DC file admission, strict base64, receipts and peer retirement passed\n";
}
