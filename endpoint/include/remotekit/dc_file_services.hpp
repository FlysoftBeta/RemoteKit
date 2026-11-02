#pragma once
#include "remotekit/dc_services.hpp"
#include "remotekit/file_upload.hpp"
#include <condition_variable>
#include <cctype>
#include <functional>
#include <thread>
#include <vector>

namespace remotekit {
inline std::vector<std::uint8_t> DecodeFileChunk(const ServiceJson& value) {
 if(!value.is_string())throw std::runtime_error("invalid_file_chunk_encoding");
 const auto& text=value.get_ref<const std::string&>();
 if(text.empty() || text.size()>21848 || text.size()%4)throw std::runtime_error("invalid_file_chunk_encoding");
 auto digit=[](unsigned char c)->int {
  if(c>='A'&&c<='Z')return c-'A';if(c>='a'&&c<='z')return c-'a'+26;
  if(c>='0'&&c<='9')return c-'0'+52;if(c=='+')return 62;if(c=='/')return 63;return -1;
 };
 std::vector<std::uint8_t> bytes;bytes.reserve(text.size()/4*3);
 for(size_t i=0;i<text.size();i+=4) {
  const int a=digit(text[i]),b=digit(text[i+1]);
  const bool last=i+4==text.size(),pad2=text[i+2]=='=',pad3=text[i+3]=='=';
  const int c=pad2?0:digit(text[i+2]),d=pad3?0:digit(text[i+3]);
  if(a<0||b<0||c<0||d<0||((pad2||pad3)&&!last)||(pad2&&!pad3)||(pad2&&(b&15))||(pad3&&!pad2&&(c&3)))
   throw std::runtime_error("invalid_file_chunk_encoding");
  bytes.push_back(static_cast<std::uint8_t>((a<<2)|(b>>4)));
  if(!pad2)bytes.push_back(static_cast<std::uint8_t>((b<<4)|(c>>2)));
  if(!pad3)bytes.push_back(static_cast<std::uint8_t>((c<<6)|d));
 }
 if(bytes.size()>16384)throw std::runtime_error("file_chunk_too_large");
 return bytes;
}
inline bool FileRequestEnvelope(const ServiceJson& message,size_t bytes) {
 if(bytes>61440 || !message.is_object() || message.value("version",ServiceJson())!=1 ||
    !message.contains("requestId") || !BoundedServiceId(message["requestId"],36) ||
    message["requestId"].get_ref<const std::string&>().size()!=36 ||
    !message.contains("params") || !message["params"].is_object() ||
    !message["params"].contains("requestId") || !BoundedServiceId(message["params"]["requestId"]))return false;
 const auto& id=message["requestId"].get_ref<const std::string&>();
 for(size_t i=0;i<id.size();++i) {
  if(i==8||i==13||i==18||i==23){if(id[i]!='-')return false;}
  else if(!std::isxdigit(static_cast<unsigned char>(id[i])))return false;
 }
 const auto method=message.value("method",ServiceJson());
 if(method!="begin" && bytes>24576)return false;
 return method=="begin" || method=="chunk" || method=="commit" || method=="cancel" || method=="status";
}

// One Session-lifetime disk worker. No caller waits for it while holding a
// Session/Browser lock. Admission, receipts and replay history are bounded.
class DcFileServices {
 public:
 struct Job {uint64_t peer{},epoch{},control{};ServiceJson message;FileUploadStore::Binding binding;};
 using Execute=std::function<ServiceJson(const Job&)>;
 using Sweep=std::function<void()>;
 private:
 struct Receipt {std::string fingerprint;ServiceJson reply;bool chunk=false;};
 mutable std::mutex mutex_;std::mutex flush_mutex_;std::condition_variable wake_;std::thread worker_;
 bool stop_=false;uint64_t peer_=0,epoch_=0,control_=0;std::string connection_;
 std::map<std::string,FileUploadStore::Binding> authorized_;
 std::deque<Job> jobs_;std::map<std::string,Receipt> receipts_;std::deque<std::string> history_,outbox_;
 ServiceJson Reply(const ServiceJson& request,bool ok,const ServiceJson& value) {
  ServiceJson result={{"type","files.result"},{"version",1},{"requestId",request["requestId"]},{"ok",ok}};
  result[ok?"result":"error"]=value;return result;
 }
 public:
 ~DcFileServices(){Stop();}
 void Start(Execute execute,Sweep sweep) {
  worker_=std::thread([this,execute=std::move(execute),sweep=std::move(sweep)] {
   for(;;) {
    Job job;
    {std::unique_lock lock(mutex_);wake_.wait_for(lock,std::chrono::seconds(1),[&]{return stop_||!jobs_.empty();});
     if(stop_)return;if(!jobs_.empty()){job=std::move(jobs_.front());jobs_.pop_front();}}
    try{sweep();}catch(...){}
    if(!job.peer)continue;
    ServiceJson reply;
    try {if(!Current(job))throw std::runtime_error("file_transfer_interrupted");reply=Reply(job.message,true,execute(job));}
    catch(const std::exception& error){
     const std::string detail=error.what();
     const bool public_code=!detail.empty() && detail.size()<=128 && std::all_of(detail.begin(),detail.end(),[](unsigned char c){return (c>='a'&&c<='z') || (c>='0'&&c<='9') || c=='_';});
     reply=Reply(job.message,false,public_code?detail:"file_operation_failed"); // Filesystem errors can contain private absolute paths.
    }
    std::lock_guard lock(mutex_);
    if(job.peer!=peer_ || job.epoch!=epoch_)continue;
    const auto key=job.message["requestId"].get<std::string>();
    auto found=receipts_.find(key);if(found==receipts_.end())continue;
    found->second.reply=reply;history_.push_back(key);
    if(outbox_.size()<32)outbox_.push_back(reply.dump());
    while(history_.size()>128){receipts_.erase(history_.front());history_.pop_front();}
   }
  });
 }
 void Stop() {{std::lock_guard lock(mutex_);stop_=true;jobs_.clear();}wake_.notify_all();if(worker_.joinable())worker_.join();}
 void Bind(uint64_t peer,std::string connection={}) {
  std::lock_guard lock(mutex_);peer_=peer;++epoch_;connection_=std::move(connection);
  authorized_.clear();jobs_.clear();receipts_.clear();history_.clear();outbox_.clear();wake_.notify_all();
 }
 void Authorize(const std::string& connection,uint64_t control,const std::map<std::string,FileUploadStore::Binding>& requests) {
  std::lock_guard lock(mutex_);if(connection!=connection_ || !peer_)throw std::runtime_error("stale_file_authorization");
  control_=control;authorized_=requests;wake_.notify_all();
 }
 void RevokeAuthorization() {
  std::lock_guard lock(mutex_);++epoch_;authorized_.clear();jobs_.clear();receipts_.clear();history_.clear();outbox_.clear();wake_.notify_all();
 }
 bool Current(const Job& job) const {
  std::lock_guard lock(mutex_);if(job.peer!=peer_ || job.epoch!=epoch_ || !peer_)return false;
  const auto id=job.message["params"].value("requestId",std::string());
  const auto found=authorized_.find(id);return found!=authorized_.end() && found->second==job.binding;
 }
 void Admit(uint64_t peer,const ServiceJson& message) {
  std::lock_guard lock(mutex_);if(peer!=peer_ || !peer_)return;
  const auto key=message["requestId"].get<std::string>(),fingerprint=message.dump();
  auto failure=[&](const char* error){if(outbox_.size()<32)outbox_.push_back(Reply(message,false,error).dump());};
  const auto id=message["params"].value("requestId",std::string());const auto found=authorized_.find(id);
  if(found==authorized_.end()){failure("stale_file_request");return;}
  if(const auto found=receipts_.find(key);found!=receipts_.end()) {
   if(found->second.fingerprint!=fingerprint)failure("file_request_id_conflict");
   else if(!found->second.reply.is_null() && outbox_.size()<32)outbox_.push_back(found->second.reply.dump());
   return;
  }
  const bool chunk=message["method"]=="chunk";
  if(jobs_.size()>=8 || outbox_.size()>=24 || (chunk && std::count_if(receipts_.begin(),receipts_.end(),[](const auto& item){return item.second.chunk && item.second.reply.is_null();})>=4))
   {failure("file_transfer_busy");return;}
  receipts_.emplace(key,Receipt{fingerprint,nullptr,chunk});
  jobs_.push_back({peer,epoch_,control_,message,found->second});wake_.notify_one();
 }
 template<class Send> void Flush(uint64_t peer,Send send) {
  // SDK send synchronously marshals to its signaling thread. That thread can
  // concurrently call Admit: never hold the admission lock across SDK calls.
  std::unique_lock delivery(flush_mutex_,std::try_to_lock);if(!delivery.owns_lock())return;
  for(unsigned i=0;i<2;++i) {
   std::string encoded;uint64_t epoch;
   {std::lock_guard lock(mutex_);if(!peer || peer!=peer_ || outbox_.empty())return;epoch=epoch_;encoded=outbox_.front();}
   if(send(encoded)!=0)return;
   {std::lock_guard lock(mutex_);if(peer!=peer_ || epoch!=epoch_)return;if(!outbox_.empty())outbox_.pop_front();}
  }
 }
};
}
