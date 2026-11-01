#include "media/encoder_worker.hpp"
#include <cstdlib>
#include <iostream>
#include <limits>
#include <thread>
#include <vector>
#define CHECK(x) do {if(!(x)){std::cerr<<__LINE__<<" failed: " #x "\n";std::exit(1);}}while(false)
int main() {
  remotekit::media::EncoderStats stats;
  auto zero=stats.Snapshot();
  for(const char* key:{"encodePending","encodeInflight","pendingReplaced","hardwareBusy","pausedDrops","errorDrops",
                       "inactiveDrops","cancelledDrops","queueWaitUs","queueWaitSamples"})CHECK(zero[key]==0);
  CHECK(zero["lastEncodeMs"].is_null());
  CHECK(zero["requestedTargetUsage"].is_null() && zero["appliedTargetUsage"].is_null());
  stats.requested_target_usage=7;stats.applied_target_usage=6;
  stats.pending=1;stats.inflight=4;stats.pending_replaced=2;stats.hardware_busy=3;
  stats.paused_drops=5;stats.error_drops=6;stats.inactive_drops=7;stats.cancelled_drops=8;
  stats.queue_wait_us=std::numeric_limits<uint64_t>::max();stats.queue_wait_samples=9;
  auto sample=stats.Snapshot();
  CHECK(sample["requestedTargetUsage"]==7 && sample["appliedTargetUsage"]==6);
  CHECK(sample["encodePending"]==1 && sample["encodeInflight"]==4);
  CHECK(sample["pendingReplaced"]==2 && sample["hardwareBusy"]==3);
  CHECK(sample["pausedDrops"]==5 && sample["errorDrops"]==6 && sample["inactiveDrops"]==7 && sample["cancelledDrops"]==8);
  CHECK(sample["queueWaitUs"].get<uint64_t>()==std::numeric_limits<uint64_t>::max() && sample["queueWaitSamples"]==9);
  CHECK(sample["encodeDropped"]==0); // Busy observations are not silently folded into drop totals.
  stats.pending=0;stats.inflight=0;
  std::atomic<bool> start=false;std::atomic<unsigned> done=0;
  std::vector<std::thread> workers;
  for(unsigned worker=0;worker<4;++worker)workers.emplace_back([&] {
    while(!start.load())std::this_thread::yield();
    for(unsigned n=0;n<1000;++n) {++stats.pending;--stats.pending;++stats.inflight;--stats.inflight;}
    ++done;
  });
  start=true;
  do {sample=stats.Snapshot();CHECK(sample["encodePending"].get<uint64_t>()<=4 && sample["encodeInflight"].get<uint64_t>()<=4);}while(done.load()!=4);
  for(auto& worker:workers)worker.join();
  sample=stats.Snapshot();CHECK(sample["encodePending"]==0 && sample["encodeInflight"]==0);
  std::cout<<"encoder atomic stats snapshot tests passed\n";
}
