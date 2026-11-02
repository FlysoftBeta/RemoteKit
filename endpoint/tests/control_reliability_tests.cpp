#include "remotekit/control_reliability.hpp"
#include "remotekit/navigation_export.hpp"
#include "remotekit/presentation_barrier.hpp"
#include <cstdlib>
#include <cstring>
#include <iostream>

#define CHECK(x) do {if(!(x)){std::cerr<<__LINE__<<" failed: " #x "\n";std::exit(1);}} while(false)
using Json=nlohmann::json;

void InputWireFailures() {
 uint64_t serial=0;int calls=0,retries=0,waits=0,exhausted=0;bool identity=true,expired=false;
 Json application;
 auto rpc=[&](const Json& request) {
  return remotekit::BrowserRpc(request,serial,[&](const std::string& encoded,std::vector<char>& bytes,size_t& count){
   const auto wire=Json::parse(encoded);CHECK(wire.at("sequence")=="41");CHECK(wire.at("version")==1);
   CHECK(wire.at("id")==++calls);
   const auto response=application.is_null()?(calls<3?Json{{"ok",false},{"code",6},{"error","busy"}}:Json{{"ok",true},{"accepted",true}}):application;
   const auto text=response.dump();count=text.size();std::memcpy(bytes.data(),text.data(),count);return 0;
  });
 };
 auto dispatch=[&] {
  return remotekit::RetryBrowserInput(Json{{"method","input"},{"sequence","41"}},rpc,[&]{return identity;},[&]{return expired;},
   [&]{++waits;},[&]{++retries;},[&]{++exhausted;});
 };
 CHECK(dispatch().at("ok")==true);CHECK(calls==3 && retries==2 && waits==2 && exhausted==0);
 // An accepted injection's later status is not a pre-admission BUSY.
 application={{"ok",true},{"accepted",true},{"injectionStatus","failed"},{"code",6}};
 CHECK(dispatch().at("accepted")==true);CHECK(calls==4 && retries==2);
 application={{"ok",false},{"code",3},{"error","rejected"}};
 CHECK(dispatch().at("code")==3);CHECK(calls==5 && retries==2);
 bool threw=false;try{remotekit::RequireBrowserOk(application);}catch(const std::runtime_error&){threw=true;}CHECK(threw);
 application={{"ok",false},{"code",6}};identity=false;
 CHECK(dispatch().at("error")=="input_identity_changed");CHECK(calls==6 && retries==2);
 identity=true;expired=true;CHECK(dispatch().at("code")==6);CHECK(exhausted==1 && calls==7);
 expired=false;const auto before=calls;CHECK(dispatch().at("code")==6);CHECK(calls-before==51 && exhausted==2);
 // Timeout is transport failure, never an application retry.
 threw=false;try{remotekit::BrowserRpc(Json::object(),serial,[](const auto&,auto&,auto&){return 7;});}
 catch(const std::runtime_error&){threw=true;}CHECK(threw);
}

void ControlBackpressure() {
 remotekit::ReliableControlOutbox box;box.Bind(1);
 std::vector<std::string> sent;std::string busy="mode";
 auto send=[&](const std::string& bytes){if(bytes==busy)return 6;sent.push_back(bytes);return 0;};
 box.Replace(1,"mode","layout1","prepare1");
 for(int i=0;i<100;++i)box.Flush(1,send);
 CHECK(sent.empty());box.Transient(1,"frame",send);CHECK(sent.empty());
 busy="layout1";box.Flush(1,send);CHECK(sent==std::vector<std::string>{"mode"});
 busy="prepare1";box.Flush(1,send);CHECK((sent==std::vector<std::string>{"mode","layout1"}));
 for(int i=0;i<100;++i) {
  box.Replace(1,"","layout1","prepare1");box.Flush(1,send);
 }
 CHECK((sent==std::vector<std::string>{"mode","layout1"})); // BUSY head never rewinds.
 // Superseding layout revokes the old pending prepare, even under long BUSY.
 box.Replace(1,"","layout2","prepare2");busy="prepare2";box.Flush(1,send);
 CHECK((sent==std::vector<std::string>{"mode","layout1","mode","layout2"}));
 busy="";box.Flush(1,send);CHECK(sent.back()=="prepare2");
 CHECK(std::find(sent.begin(),sent.end(),"prepare1")==sent.end());
 const auto admitted=sent.size();
 for(int i=0;i<100;++i){box.Replace(1,"","layout2","prepare2");box.Flush(1,send);}
 CHECK(sent.size()==admitted); // Identical transactions are already reliable.
 box.Replace(1,"","old-layout","old-prepare");box.Bind(2);box.Flush(1,send);
 box.Replace(1,"bad-mode","bad-layout","bad-prepare");
 const auto count=sent.size();box.Flush(2,send);CHECK(sent.size()==count);
 box.Replace(2,"mode2","layout3","prepare3");box.Flush(2,send);CHECK(sent.back()=="prepare3");
 // Outbox admission does not release the media gate; only matching ACK does.
 remotekit::PresentationBarrier gate;gate.Bind(2);gate.Mode(2,true);auto key=gate.Layout(3,4);CHECK(key);
 bool published=false;gate.Send(2,4,true,[&]{published=true;return true;});CHECK(!published);
 CHECK(gate.Ready(2,*key));gate.Send(2,4,true,[&]{published=true;return true;});CHECK(published);
}

void StableWireLayout() {
 Json raw={{"type","layout"},{"generation","6"},{"epoch","24"},{"views",Json::array()}};
 for(bool enabled:{false,true}) {
  const auto published=remotekit::LayoutCapabilities(raw,enabled);
  CHECK(published.at("clientGestures")==int(enabled));
  for(int tick=0;tick<100;++tick)CHECK(remotekit::LayoutCapabilities(raw,enabled)==published);
  CHECK(remotekit::LayoutCapabilities(raw,!enabled)!=published);
 }
}

struct ExportFixture {
 remotekit::NavigationExport exporter;
 Json current={{"view","1"},{"instance","3"},{"document","5"},{"navigationRevision","7"},{"close_state","open"}};
 Json saved={{"previous",true}};
 std::string incarnation="browser1";int begin=0,chunks=0,cancel=0,reads=0,writes=0;bool disk_fail=false;
 void Observe(){exporter.Observe(current,incarnation,true);}
 void Tick() {
  exporter.Tick(incarnation,[&](const auto& view)->Json{++reads;return current.is_object() && current.at("view")==view?current:Json();},[&](const Json& request)->Json {
   const auto method=request.at("method");
   if(method=="navigation.export.begin") {++begin;return {{"transfer","11"},{"size",std::to_string(3*256*1024)},{"navigationRevision","7"}};}
   if(method=="navigation.export.chunk") {++chunks;CHECK(request.at("length")==256*1024);return {{"data","fake-256KiB"}};}
   CHECK(method=="navigation.transfer.cancel");++cancel;return {{"ok",true}};
  },[](const auto&){return 256*1024;},[&](const auto& view,const Json& data){
   CHECK(view=="1");if(disk_fail)throw std::runtime_error("disk failure");++writes;saved=data;
  });
 }
};

void IncrementalExport() {
 ExportFixture f;f.Observe();CHECK(f.begin==0);f.Tick();CHECK(f.begin==1 && f.chunks==0);
 int other_session_commands=0;
 for(int i=0;i<3;++i) {
  f.Observe(); // Frequent snapshots cannot restart the active export.
  const auto before=f.chunks;f.Tick();CHECK(f.chunks==before+1);++other_session_commands;
  CHECK(f.saved.contains("previous"));CHECK(f.begin==1 && f.writes==0);
 }
 CHECK(other_session_commands==3);f.Tick();CHECK(f.writes==1 && f.cancel==1);
 CHECK(f.saved.at("chunks").size()==3 && !f.exporter.Pending());
 // Navigation, close, Browser incarnation and instance changes each cancel,
 // preserving the last atomically committed recovery state.
 for(int scenario=0;scenario<4;++scenario) {
  ExportFixture cancelled;cancelled.Observe();cancelled.Tick();cancelled.Tick();
  if(scenario==0)cancelled.current["navigationRevision"]="8";
  if(scenario==1)cancelled.current=nullptr;
  if(scenario==2)cancelled.incarnation="browser2";
  if(scenario==3)cancelled.current["instance"]="4";
  cancelled.Tick();CHECK(cancelled.cancel==1 && cancelled.chunks==1 && cancelled.writes==0);
  CHECK(cancelled.saved.contains("previous"));
 }
 ExportFixture forgotten;forgotten.Observe();forgotten.Tick();forgotten.exporter.Forget("1");forgotten.Tick();
 CHECK(forgotten.cancel==1 && forgotten.writes==0);
 ExportFixture failed;failed.Observe();for(int i=0;i<4;++i)failed.Tick();failed.disk_fail=true;
 bool threw=false;try{failed.Tick();}catch(const std::runtime_error&){threw=true;}
 CHECK(threw && failed.saved.contains("previous") && !failed.exporter.Pending());
 // Fairness between two views: bounded active transfer then next candidate.
 ExportFixture multiple;multiple.Observe();auto second=multiple.current;second["view"]="2";
 multiple.exporter.Observe(second,multiple.incarnation,true);
 for(int i=0;i<5;++i)multiple.Tick();CHECK(multiple.writes==1);
 // The second candidate vanished before selection; no stale begin is issued.
 multiple.Tick();CHECK(multiple.begin==1 && !multiple.exporter.Pending());
}
void TouchTerminal() {
 const Json accepted={{"ok",true},{"touchPending",true},{"touchSequenceId","physical-7"}};
 const Json command={{"session","1"},{"view","2"},{"instance","3"},{"document","4"},{"focus","5"},{"sequence","99"}};
 for(int scenario=0;scenario<8;++scenario) {
  int calls=0,waits=0,budget=20;bool current=true;
  auto result=remotekit::AwaitTouchTerminal(accepted,command,[&](const Json& query,int remaining)->Json {
   CHECK(query.at("method")=="input.touchStatus" && !query.contains("sequence"));
   CHECK(query.at("sequenceId")=="physical-7" && query.at("document")=="4" && remaining>0);
   ++calls;
   if(scenario==1)return {{"ok",false},{"pending",false},{"state","terminal-invalidated"},{"sequenceId","physical-7"}};
   if(scenario==6)return {{"ok",false},{"pending",false},{"state","terminal-invalidated"},{"sequenceId","different-owner"}};
   if(scenario==7)return {{"ok",false},{"pending",false},{"state","terminal-unconfirmed"},{"error","stale_touch_sequence"}};
   if(scenario==2)return {{"ok",false},{"pending",true},{"state","pending"}};
   if(scenario==3)current=false;
   if(scenario==5){budget=0;return {{"ok",true},{"pending",false},{"state","processed"}};}
   if(calls==1)return {{"ok",false},{"pending",true},{"state","pending"}};
   return {{"ok",true},{"pending",false},{"state","processed"}}; // Page consumption is still processed.
  },[&]{return scenario!=4 && current;},[&]{return budget;},[&]{++waits;budget-=10;});
  CHECK(result.value("ok",false)==(scenario==0));
  if(scenario==0)CHECK(calls==2 && waits==1 && result.at("touchPending")==false);
  if(scenario==1)CHECK(calls==1 && waits==0 && result.at("touchState")=="terminal-invalidated" && result.at("touchSequenceId")=="physical-7");
  if(scenario>=2)CHECK(result.value("state",std::string())=="terminal-unconfirmed" && !result.contains("touchState"));
  if(scenario==2)CHECK(calls==2 && result.at("error")=="touch_terminal_timeout");
  if(scenario==3)CHECK(calls==1 && waits==0);
  if(scenario==4)CHECK(calls==0);
  if(scenario==5)CHECK(calls==1 && result.at("error")=="touch_terminal_timeout");
 }
}
void OversizedBrowserReplyIsApplicationError() {
 uint64_t serial=72;
 const auto reply=remotekit::BrowserRpc(Json{{"method","snapshot"}},serial,
  [&](const std::string& encoded,std::vector<char>& buffer,size_t& count) {
   const auto request=Json::parse(encoded);CHECK(request.at("id")==73);
   // Exact bounded envelope emitted by Browser WriteControlResponse.
   const auto wire=Json{{"version",1},{"id",request.at("id")},{"ok",false},{"error","response_too_large"},
    {"message","Browser state is too large to synchronize. Close or change the affected page and retry."}}.dump();
   count=wire.size();std::memcpy(buffer.data(),wire.data(),count);return 0;
  });
 CHECK(reply.at("id")==73 && reply.at("error")=="response_too_large");
 bool rejected=false;
 try {remotekit::RequireBrowserOk(reply);}
 catch(const std::runtime_error& error) {rejected=std::string(error.what())=="browser: response_too_large";}
 CHECK(rejected);
 // A subsequent RPC can use the same live control rather than recreate Browser.
 const auto next=remotekit::BrowserRpc(Json{{"method","snapshot"}},serial,
  [&](const std::string& encoded,std::vector<char>& buffer,size_t& count) {
   const auto request=Json::parse(encoded);CHECK(request.at("id")==74);
   const auto wire=Json{{"id",74},{"ok",true}}.dump();count=wire.size();std::memcpy(buffer.data(),wire.data(),count);return 0;
  });
 CHECK(next.at("ok")==true);
}
int main(){OversizedBrowserReplyIsApplicationError();StableWireLayout();TouchTerminal();InputWireFailures();ControlBackpressure();IncrementalExport();std::cout<<"control reliability tests passed\n";}
