#pragma once
#include "remotekit/shared_render_slots.h"
#include <json.hpp>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <deque>
#include <istream>
#include <map>
#include <mutex>
#include <string>

namespace remotekit {
using ServiceJson=nlohmann::json;
inline bool BoundedServiceId(const ServiceJson& value,size_t maximum=128) {
 return value.is_string() && !value.get_ref<const std::string&>().empty() &&
   value.get_ref<const std::string&>().size()<=maximum &&
   std::all_of(value.get_ref<const std::string&>().begin(),value.get_ref<const std::string&>().end(),
    [](unsigned char c){return c>=33 && c<=126;});
}
inline bool ProductActionEnvelope(const ServiceJson& message,size_t bytes) {
 if(bytes>33792 || !message.is_object() || message.value("version",ServiceJson())!=1 ||
    !message.contains("operationId") || !BoundedServiceId(message["operationId"],36) ||
    !message.contains("operationGeneration") || !BoundedServiceId(message["operationGeneration"]) ||
    !message.contains("action") || !message["action"].is_object() || message["action"].dump().size()>32768)return false;
 const auto& id=message["operationId"].get_ref<const std::string&>();
 if(id.size()!=36)return false;
 for(size_t i=0;i<id.size();++i) {
  if(i==8 || i==13 || i==18 || i==23){if(id[i]!='-')return false;}
  else if(!((id[i]>='0'&&id[i]<='9') || (id[i]>='a'&&id[i]<='f') || (id[i]>='A'&&id[i]<='F')))return false;
 }
 const auto type=message["action"].value("type",ServiceJson());
 static const char* allowed[]={"window.create","window.activate","window.close","window.layout","tab.create",
  "tab.activate","tab.close","tab.move","tab.navigate","tab.command","tab.files","settings.update","page.reply","site.set"};
 return std::any_of(std::begin(allowed),std::end(allowed),[&](const char* value){return type==value;});
}

// Routing receipts only: Control owns operation semantics and product state.
// Together requests, outstanding receipts and replies occupy at most 64 slots.
// No operation is replayed across a management disconnect or a peer replacement.
class DirectServices {
 struct Pending {ServiceJson message;double since;bool dispatched=false;};
 mutable std::mutex mutex_;uint64_t peer_=0;std::string connection_;
 std::map<std::string,Pending> pending_;std::deque<std::string> results_;
 std::string editable_;ServiceJson editable_value_;uint64_t editable_revision_=0;
 static std::string Key(const ServiceJson& value) {
  return value.at("operationGeneration").get<std::string>()+"\n"+value.at("operationId").get<std::string>();
 }
 ServiceJson Failure(const ServiceJson& request,const char* error,bool unknown=false) const {
  return {{"type","product.result"},{"version",1},{"operationId",request.at("operationId")},
   {"connectionId",connection_},{"operationGeneration",request.at("operationGeneration")},{"ok",unknown},{"error",error},
   {"result",{{"operationId",request.at("operationId")},{"operationGeneration",request.at("operationGeneration")},
    {"status",unknown?"unknown":"rejected"},{"error",error}}}};
 }
 public:
 void Bind(uint64_t peer,std::string connection={}) {
  std::lock_guard lock(mutex_);peer_=peer;connection_=std::move(connection);pending_.clear();results_.clear();editable_.clear();editable_value_=nullptr;editable_revision_=0;
 }
 bool Admit(uint64_t peer,const ServiceJson& message,double now) {
  std::lock_guard lock(mutex_);if(!peer || peer!=peer_)return false;
  const auto key=Key(message);if(pending_.contains(key))return true;
  if(pending_.size()+results_.size()>=64)return false;
  pending_.emplace(key,Pending{message,now});return true;
 }
 template<class Dispatch> void DispatchPending(uint64_t peer,double now,Dispatch dispatch) {
  std::lock_guard lock(mutex_);if(!peer || peer!=peer_)return;
  unsigned budget=8;
  for(auto it=pending_.begin();it!=pending_.end();) {
   auto& item=it->second;
   if(now-item.since>=15000) {
    // Once forwarded, a timeout cannot prove rejection. Return a queryable
    // uncertain receipt; never replay the operation to obtain another reply.
    results_.push_back(Failure(item.message,item.dispatched?"control_result_unknown":"control_unavailable",item.dispatched).dump());it=pending_.erase(it);continue;
   }
   if(!item.dispatched && budget) {
    --budget;
    if(!dispatch(item.message)) {
     results_.push_back(Failure(item.message,"control_unavailable").dump());it=pending_.erase(it);continue;
    }
    item.dispatched=true;
   }
   ++it;
  }
 }
 bool Result(uint64_t peer,const ServiceJson& message) {
  std::lock_guard lock(mutex_);if(!peer || peer!=peer_ || message.dump().size()>16384)return false;
  const auto found=pending_.find(Key(message));if(found==pending_.end())return false;
  auto result=message;result["type"]="product.result";result["version"]=1;
  results_.push_back(result.dump());pending_.erase(found);return true;
 }
 void RefreshEditable() {
  std::lock_guard lock(mutex_);editable_value_=nullptr;editable_.clear();
 }
 void Editable(uint64_t peer,const SharedAtlasFrame& frame,bool output_suspended=false) {
  std::lock_guard lock(mutex_);if(!peer || peer!=peer_)return;
  if(!output_suspended && (!frame.generation ||
      (frame.status!=SharedAtlasStatus::kStarting && frame.status!=SharedAtlasStatus::kRunning) ||
      frame.view_count>kSharedAtlasMaxViews))return;
  const SharedAtlasView* selected=nullptr;
  for(uint32_t i=0;!output_suspended && i<frame.view_count;++i) {
   const auto& view=frame.views[i];
   if(view.text_input.target_id && (view.text_input.flags&kAtlasTextInputActive)) {
    selected=&view;break;
   }
  }
  ServiceJson value={{"view",nullptr},{"editable",{{"type",0},{"flags",0},{"active",false},{"target","0"},
   {"selectionStart",0},{"selectionEnd",0},{"compositionStart",0},{"compositionEnd",0},
   {"caretX",0},{"caretY",0},{"caretWidth",0},{"caretHeight",0}}}};
  if(selected) {
   const auto& view=*selected;const auto& input=view.text_input;
   value["view"]={{"session",std::to_string(view.session_id)},{"id",std::to_string(view.webview_id)},
    {"instance",std::to_string(view.instance_generation)},{"document",std::to_string(view.document_generation)},
    {"focus",std::to_string(view.focus_generation)}};
   auto finite=[](float v){return std::isfinite(v)?v:0.0f;};
   value["editable"]={{"type",input.type},{"flags",input.flags},{"active",true},
    {"target",std::to_string(input.target_id)},
    {"selectionStart",input.selection_start},{"selectionEnd",input.selection_end},
    {"compositionStart",input.composition_start},{"compositionEnd",input.composition_end},
    {"caretX",finite(input.caret_x)},{"caretY",finite(input.caret_y)},
    {"caretWidth",finite(input.caret_width)},{"caretHeight",finite(input.caret_height)}};
  }
  if(value==editable_value_)return;
  editable_value_=value;value["type"]="input.editable";value["version"]=1;value["revision"]=std::to_string(++editable_revision_);
  editable_=value.dump();
 }
 template<class Send> void Flush(uint64_t peer,Send send) {
  std::lock_guard lock(mutex_);if(!peer || peer!=peer_)return;
  for(unsigned n=0;n<4 && !results_.empty();++n) {
   if(send(results_.front())!=0)return;results_.pop_front();
  }
  if(!editable_.empty() && send(editable_)==0)editable_.clear();
 }
};

// Consume a too-long line completely without retaining its tail. Return a
// fixed invalid request so the caller can report an error and read the next line.
inline bool ReadServiceLine(std::istream& input,std::string& line) {
 line.clear();bool overflow=false,any=false;char c;
 while(input.get(c)) {
  any=true;if(c=='\n')break;
  if(line.size()<1024*1024)line+=c;else overflow=true;
 }
 if(overflow)line="{\"method\":\"__oversized_request\"}";
 return any;
}
}
