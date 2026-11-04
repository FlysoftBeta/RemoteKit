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
struct TestBurstAnalyzer {
 PhotoBurstDecision Observe(const std::string& frame,std::span<const std::uint8_t>,
                            const std::vector<std::string>&,const PhotoCancelled& cancelled) {
  CHECK(!cancelled());
  return Decide(frame);
 }
 PhotoBurstDecision Finish(const std::vector<std::string>& available) {return Decide(available.front());}
 static PhotoBurstDecision Decide(const std::string& frame) {
  return {frame,{frame},{{frame,0.75}},false,false,"test"};
 }
};
void CheckBursts() {
 PhotoBurstSessions<TestBurstAnalyzer> bursts;
 const auto live=[] {return false;};
 const auto begin=[&] {return bursts.Execute(11,"photo.burst.begin",{},live)["burstId"].get<std::string>();};
 const auto first=begin(),second=begin();
 CHECK(first!=second);
 CHECK(Throws(begin));
 auto sample=[&](const std::string& frame,const std::vector<std::string>& available,
                 const std::string& data="YWJj") {
  return bursts.Execute(11,"photo.burst.sample",{{"burstId",first},{"frameId",frame},
                         {"availableFrameIds",available},{"data",data}},live);
 };
 CHECK(Throws([&] {sample("1",{"1","future"});}));
 CHECK(Throws([&] {sample("1",{"1","1"});}));
 CHECK(Throws([&] {sample("1",{"1","2","3","4"});}));
 CHECK(Throws([&] {sample("invalid\n",{"invalid\n"});}));
 const auto decision=sample("1",{"1"});
 CHECK(decision["selectedFrameId"]=="1" && decision["keepFrameIds"].size()==1 && decision["candidates"][0]["score"]==0.75);
 CHECK(Throws([&] {sample("1",{"1"},"ZGVm");}));
 CHECK(sample("2",{"1","2"})["selectedFrameId"]=="2");
 CHECK(sample("3",{"2","3"})["selectedFrameId"]=="3");
 CHECK(Throws([&] {sample("4",{"1","4"});}));
 for(unsigned i=4;i<=20;++i) {
  const auto id=std::to_string(i);
  CHECK(sample(id,{id})["selectedFrameId"]==id);
 }
 CHECK(Throws([&] {sample("21",{"21"});}));
 const ServiceJson end={{"burstId",first},{"availableFrameIds",{"20"}}};
 const auto result=bursts.Execute(11,"photo.burst.end",end,live);
 CHECK(result["selectedFrameId"]=="20");
 CHECK(bursts.Execute(11,"photo.burst.end",end,live)==result);
 CHECK(Throws([&] {bursts.Execute(12,"photo.burst.end",end,live);}));
 auto conflict=end;conflict["availableFrameIds"]={"19"};
 CHECK(Throws([&] {bursts.Execute(11,"photo.burst.end",conflict,live);}));
 const ServiceJson cancel={{"burstId",second}};
 CHECK(bursts.Execute(12,"photo.burst.cancel",cancel,live)["cancelled"]==true);
 const auto third=begin();
 CHECK(Throws(begin));
 CHECK(bursts.Execute(11,"photo.burst.cancel",cancel,live)["cancelled"]==true);
 CHECK(bursts.Execute(11,"photo.burst.cancel",cancel,live)["cancelled"]==true);
 const ServiceJson empty_end={{"burstId",third},{"availableFrameIds",ServiceJson::array()}};
 for(int i=0;i<2;++i) {
  try {
   bursts.Execute(11,"photo.burst.end",empty_end,live);
   CHECK(false);
  } catch(const std::runtime_error& error) {CHECK(std::string(error.what())=="photo_burst_no_samples");}
 }
 const auto expiring=begin();
 bursts.Sweep([](uint64_t){return true;},decltype(bursts)::Clock::now()+std::chrono::seconds(6));
 CHECK(Throws([&] {bursts.Execute(11,"photo.burst.end",{{"burstId",expiring},{"availableFrameIds",ServiceJson::array()}},live);}));
 bursts.Sweep([](uint64_t){return false;});
 CHECK(Throws([&] {bursts.Execute(11,"photo.burst.end",end,live);}));
}
int main() {
 CheckBursts();
 CHECK(DecodeFileChunk("YWJj")==std::vector<std::uint8_t>({'a','b','c'}));
 CHECK(DecodeFileChunk("YQ==")==std::vector<std::uint8_t>({'a'}));
 CHECK(DecodeFileChunk("YWI=")==std::vector<std::uint8_t>({'a','b'}));
 CHECK(EncodeFileChunk({})=="");
 CHECK(EncodeFileChunk({'a','b'})=="YWI=");
 for(const auto* text:{"","a","====","YQ=+","YQ==YQ==","YR==","YWJ="," YQ=","!!!!"})CHECK(Throws([&]{DecodeFileChunk(text);}));
 CHECK(Throws([]{DecodeFileChunk(std::string(21848,'A'));}));
 const auto a=Request("00000000-0000-4000-8000-000000000001");
 CHECK(FileRequestEnvelope(a,a.dump().size()));CHECK(!FileRequestEnvelope(a,24577));
 auto burst_request=a;burst_request["params"]["requestId"]="library";burst_request["method"]="photo.burst.sample";
 CHECK(FileRequestEnvelope(burst_request,61440));CHECK(!FileRequestEnvelope(burst_request,61441));
 for(const auto method:{"photo.burst.begin","photo.burst.end","photo.burst.cancel","photo.process","asset.chunk","asset.describe"}) {
  auto small=burst_request;small["method"]=method;
  CHECK(FileRequestEnvelope(small,24576));CHECK(!FileRequestEnvelope(small,24577));
 }
 constexpr auto sample_bytes=PhotoBurstSessions<TestBurstAnalyzer>::kMaxSampleBytes;
 CHECK(DecodeFileChunk(EncodeFileChunk(std::vector<std::uint8_t>(sample_bytes)),sample_bytes).size()==sample_bytes);
 CHECK(Throws([&] {DecodeFileChunk(EncodeFileChunk(std::vector<std::uint8_t>(sample_bytes+1)),sample_bytes);}));
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
 auto asset=Request("00000000-0000-4000-8000-000000000003","photo.burst.sample");
 asset["params"]["requestId"]="library";
 asset["params"]["burstId"]="test-burst";
 CHECK(FileRequestEnvelope(asset,asset.dump().size()));
 auto chooser_asset=asset;chooser_asset["params"]["requestId"]="opaque";
 auto chooser_describe=chooser_asset;chooser_describe["method"]="asset.describe";
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
 library.Authorize("library-peer",99,{{"opaque",binding}},true);
 chooser_describe["requestId"]="00000000-0000-4000-8000-000000000005";
 library.Admit(9,chooser_describe);drain();
 CHECK(replies.size()==6 && replies.back()["error"]=="stale_file_request");
 chooser_describe["params"]["requestId"]="library";
 library.Admit(9,chooser_describe);
 Until([&]{drain();return replies.size()==7;});
 CHECK(replies.back()["ok"]==true);
 library.Stop();
 std::cout<<"DC file admission, strict base64, receipts and peer retirement passed\n";
}
