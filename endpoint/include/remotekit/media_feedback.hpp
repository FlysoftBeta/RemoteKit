#pragma once
#include <json.hpp>
#include <cmath>
#include <cctype>
#include <cstdint>
#include <mutex>
#include <set>
#include <string>

namespace remotekit {
// One latest receiver sample, separate from the input/event queues. Identity,
// sequence and local receive QPC are protected by the same lock.
class MediaFeedback {
 public:
  using Json=nlohmann::json;
  void Bind(uint64_t peer,std::string epoch,std::string generation,std::set<std::string> views={}) {
    std::lock_guard lock(mutex_);
    if(peer!=peer_ || epoch!=epoch_ || generation!=generation_ || views!=views_) {
      latest_=Json();received_qpc_=0;
      if(peer!=peer_)seq_=0;
    }
    peer_=peer;epoch_=std::move(epoch);generation_=std::move(generation);views_=std::move(views);
  }
  bool Receive(uint64_t peer,const Json& message,int64_t qpc,size_t bytes=0) {
    std::lock_guard lock(mutex_);
    auto reject=[&]{++rejected_;return false;};
    if(!peer_ || peer!=peer_ || epoch_.empty() || generation_.empty() || qpc<0 || bytes>16384 ||
       !message.is_object() || message.value("type",Json())!="media.feedback" ||
       !Integer(message,"version",1,1) || !Integer(message,"seq",1,9007199254740991.0) ||
       !message.contains("layoutEpoch") || message["layoutEpoch"]!=epoch_ ||
       !message.contains("outputGeneration") || message["outputGeneration"]!=generation_ ||
       !message.contains("visible") || !message["visible"].is_boolean() ||
       !Number(message,"windowMs",1,600000) || !Integer(message,"rafSamples",0,512) ||
       !message.contains("planes") || !message["planes"].is_array() || message["planes"].size()>64)return reject();
    const auto seq=static_cast<uint64_t>(message["seq"].get<double>());
    if(seq<=seq_)return reject();
    Json sample;
    for(const char* name:{"seq","layoutEpoch","outputGeneration","visible","windowMs","rafSamples"})sample[name]=message[name];
    for(const char* name:{"decodedFrames","videoFrames","packetsLost","framesDropped"}) {
      if(message.contains(name)) {
        if(!Integer(message,name,0,1000000000))return reject();
        sample[name]=message[name];
      }
    }
    if(message.contains("displayHzEstimate")) {
      if(!Number(message,"displayHzEstimate",10,250) || !message["visible"].get<bool>() ||
         message["rafSamples"].get<double>()<20)return reject();
      sample["displayHzEstimate"]=message["displayHzEstimate"];
    }
    if(message.contains("roundTripTimeMs")) {
      if(!Number(message,"roundTripTimeMs",0,60000))return reject();
      sample["roundTripTimeMs"]=message["roundTripTimeMs"];
    }
    std::set<std::string> seen;sample["planes"]=Json::array();
    for(const auto& plane:message["planes"]) {
      if(!plane.is_object() || !plane.contains("view") || !plane["view"].is_string())return reject();
      const auto view=plane["view"].get<std::string>();
      if(view.empty() || view.size()>128 || !views_.contains(view) || !seen.insert(view).second)return reject();
      Json item={{"view",view}};
      if(plane.contains("frames")) {
        if(!Integer(plane,"frames",0,1000000000))return reject();
        item["frames"]=plane["frames"];
      }
      sample["planes"].push_back(std::move(item));
    }
    if(!latest_.is_null())++replaced_;
    latest_=std::move(sample);seq_=seq;received_qpc_=qpc;++accepted_;return true;
  }
  Json Snapshot(int64_t now_qpc,int64_t frequency) const {
    std::lock_guard lock(mutex_);
    Json result={{"feedbackAccepted",accepted_},{"feedbackRejected",rejected_},{"feedbackReplaced",replaced_}};
    if(latest_.is_null())return result;
    if(frequency>0 && now_qpc>=received_qpc_)result["feedbackAgeMs"]=1000.0*(now_qpc-received_qpc_)/frequency;
    for(const auto& [key,value]:latest_.items()) {
      auto name=key;name[0]=static_cast<char>(std::toupper(static_cast<unsigned char>(name[0])));
      result["feedback"+name]=value;
    }
    return result;
  }
 private:
  static bool Number(const Json& object,const char* name,double minimum,double maximum) {
    if(!object.contains(name) || !object[name].is_number())return false;
    const double value=object[name].get<double>();return std::isfinite(value)&&value>=minimum&&value<=maximum;
  }
  static bool Integer(const Json& object,const char* name,double minimum,double maximum) {
    return Number(object,name,minimum,maximum) && std::floor(object[name].get<double>())==object[name].get<double>();
  }
  mutable std::mutex mutex_;
  uint64_t peer_=0,seq_=0,accepted_=0,rejected_=0,replaced_=0;
  std::string epoch_,generation_;std::set<std::string> views_;
  int64_t received_qpc_=0;Json latest_;
};
} // namespace remotekit
