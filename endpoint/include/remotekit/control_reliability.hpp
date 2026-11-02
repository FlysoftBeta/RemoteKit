#pragma once
#include <json.hpp>
#include <array>
#include <deque>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

namespace remotekit {
using ControlJson = nlohmann::json;
// Compare exactly the wire layout, including capabilities added by Session.
// Omitting these fields from polling candidates creates perpetual replacement.
inline ControlJson LayoutCapabilities(ControlJson layout,bool client_gestures) {
 layout["clientGestures"]=client_gestures?1:0;return layout;
}
// The same wire adapter is used by Session and CPU failure-injection tests.
// Application rejection is a reply; only transport/protocol failure throws.
template<class Transport>
ControlJson BrowserRpc(ControlJson command,uint64_t& serial,Transport transport) {
 command["version"]=1;command["id"]=++serial;
 const auto encoded=command.dump();std::vector<char> buffer(1024*1024);size_t count=0;
 const int status=transport(encoded,buffer,count);
 if(status)throw std::runtime_error("browser request transport "+std::to_string(status));
 if(count>buffer.size())throw std::runtime_error("browser response exceeds bound");
 auto reply=ControlJson::parse(buffer.data(),buffer.data()+count);
 if(!reply.is_object() || !reply.contains("ok") || !reply["ok"].is_boolean())
  throw std::runtime_error("invalid browser response");
 return reply;
}
inline ControlJson RequireBrowserOk(ControlJson reply) {
 if(!reply.value("ok",false))throw std::runtime_error("browser: "+reply.value("error",std::string("command failed")));
 return reply;
}
template<class Rpc,class Current,class Expired,class Wait,class Retry,class Exhausted>
ControlJson RetryBrowserInput(const ControlJson& command,Rpc rpc,Current current,Expired expired,Wait wait,Retry retry,Exhausted exhausted) {
 auto reply=rpc(command);unsigned retries=0;
 while(!reply.value("ok",false) && reply.value("code",0)==6) {
  if(retries>=50 || expired()){exhausted();break;}
  if(!current())return {{"ok",false},{"error","input_identity_changed"}};
  wait();
  if(!current())return {{"ok",false},{"error","input_identity_changed"}};
  if(expired()){exhausted();break;}
  ++retries;retry();reply=rpc(command);
 }
 return reply;
}

// Poll only after admission: never replay a terminal input while waiting for ACK.
template<class Rpc,class Current,class Remaining,class Wait>
ControlJson AwaitTouchTerminal(ControlJson reply,const ControlJson& command,Rpc rpc,Current current,Remaining remaining,Wait wait) {
 ControlJson query={{"method","input.touchStatus"},{"sequenceId",reply.value("touchSequenceId",std::string())}};
 for(const auto* key:{"session","view","instance","document","focus"})if(command.contains(key))query[key]=command[key];
 while(true) {
  if(!current())return {{"ok",false},{"error","touch_terminal_identity_changed"},{"state","terminal-unconfirmed"}};
  const auto budget=remaining();
  if(budget<=0)return {{"ok",false},{"error","touch_terminal_timeout"},{"state","terminal-unconfirmed"}};
  auto status=rpc(query,budget);
  if(!current())return {{"ok",false},{"error","touch_terminal_identity_changed"},{"state","terminal-unconfirmed"}};
  if(remaining()<=0)return {{"ok",false},{"error","touch_terminal_timeout"},{"state","terminal-unconfirmed"}};
  if(status.value("state",std::string())=="processed" && status.value("ok",false)) {
   reply["touchPending"]=false;reply["touchState"]="processed";return reply;
  }
  if(status.value("state",std::string())!="pending"){
   status["ok"]=false;
   if(status.value("state",std::string())=="terminal-invalidated" &&
      status.value("sequenceId",std::string())==query.value("sequenceId",std::string())) {
    status["touchState"]="terminal-invalidated";status["touchSequenceId"]=query["sequenceId"];
   } else {status["state"]="terminal-unconfirmed";status.erase("touchState");status.erase("touchSequenceId");}
   return status;
  }
  wait();
 }
}

// Only the latest layout transaction is retained (at most mode/layout/prepare).
// Serialize replacement and actual admission so an old prepare can never be
// admitted after a newer layout. BUSY leaves the head in place for the next tick.
class ReliableControlOutbox {
 public:
 void Bind(uint64_t peer) {std::lock_guard lock(mutex_);peer_=peer;pending_.clear();mode_.clear();transaction_={};}
 void Replace(uint64_t peer,std::string mode,std::string layout,std::string prepare) {
  std::lock_guard lock(mutex_);if(!peer || peer!=peer_)return;
  if(!mode.empty())mode_=std::move(mode);
  const std::array<std::string,3> transaction{mode_,layout,prepare};
  // Admission is reliable for this peer. Identical polling observations must
  // neither replay admitted messages nor rewind a partially admitted head.
  if(transaction==transaction_)return;
  transaction_=transaction;
  pending_.clear();
  if(!mode_.empty())pending_.push_back(mode_);
  if(!layout.empty())pending_.push_back(std::move(layout));
  if(!prepare.empty())pending_.push_back(std::move(prepare));
 }
 template<class Send> void Flush(uint64_t peer,Send send) {
  std::lock_guard lock(mutex_);if(!peer || peer!=peer_)return;
  for(size_t sent=0;sent<3 && !pending_.empty();++sent) {
   if(send(pending_.front())!=0)return;
   pending_.pop_front();
  }
 }
 template<class Send> void Transient(uint64_t peer,const std::string& bytes,Send send,bool low_priority=true) {
  std::lock_guard lock(mutex_);
  if(peer && peer==peer_ && (!low_priority || pending_.empty()))send(bytes);
 }
 private:
 std::mutex mutex_;uint64_t peer_=0;std::string mode_;std::deque<std::string> pending_;
 std::array<std::string,3> transaction_;
};
}
