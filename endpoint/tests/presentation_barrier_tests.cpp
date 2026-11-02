#include "remotekit/presentation_barrier.hpp"
#include "remotekit/tail_refresh.hpp"
#include <cstdlib>
#include <future>
#include <iostream>
#include <thread>
#define CHECK(x) do {if(!(x)){std::cerr<<__LINE__<<" failed: " #x "\n";std::exit(1);}}while(false)
using Gate=remotekit::PresentationBarrier;
int main() {
 Gate gate;int published=0;
 auto send=[&](uint64_t peer,uint64_t epoch,bool key=true) {
  return gate.Send(peer,epoch,key,[&]{++published;return true;});
 };
 gate.Bind(1);CHECK(send(1,0)); // Legacy canvas requires no handshake.
 CHECK(!send(2,0));
 CHECK(!gate.Layout(3,7));
 auto first=gate.Mode(1,true);CHECK(first && first->epoch==7 && first->generation==3);
 CHECK(!send(1,7) && !send(1,6));
 auto wrong=*first;wrong.generation=4;CHECK(!gate.Ready(1,wrong));
 wrong=*first;wrong.epoch=8;CHECK(!gate.Ready(1,wrong));
 CHECK(!gate.Ready(2,*first));
 auto second=gate.Layout(3,8);CHECK(second && second->barrier>first->barrier);
 CHECK(!gate.Ready(1,*first)); // Out-of-order ACK never opens a new layout.
 CHECK(gate.Ready(1,*second));CHECK(!gate.Ready(1,*second));
 CHECK(!send(1,7)); // Old in-flight keyframe is rejected after the latest ACK.
 CHECK(!send(1,8,false)); // Dependencies were discarded while waiting.
 CHECK(gate.Send(1,8,true,[]{return false;})); // SDK failure does not open P frames.
 CHECK(!send(1,8,false));CHECK(send(1,8));CHECK(send(1,8,false));
 CHECK(!gate.Layout(3,7));CHECK(!gate.Layout(3,8)); // No rollback or focus-only prepare.
 CHECK(!gate.Mode(1,true));CHECK(send(1,8,false));

 // Actual encoded publication and layout replacement are a single critical
 // section: replacement cannot finish while the previous SDK send is running.
 std::promise<void> entered,release,updating;
 auto release_future=release.get_future().share();
 auto sending=std::async(std::launch::async,[&] {
  return gate.Send(1,8,false,[&]{entered.set_value();release_future.wait();return true;});
 });
 CHECK(entered.get_future().wait_for(std::chrono::seconds(2))==std::future_status::ready);
 auto update=std::async(std::launch::async,[&]{updating.set_value();return gate.Layout(4,9);});
 updating.get_future().wait();
 CHECK(update.wait_for(std::chrono::milliseconds(20))==std::future_status::timeout);
 release.set_value();CHECK(sending.get());auto third=update.get();CHECK(third);
 CHECK(!send(1,8) && !send(1,9));CHECK(gate.Ready(1,*third));CHECK(!send(1,8));

 // Model the worker's real post-Poll drop path: a failed TailRefresh and its
 // retained source lease must finish even when no encoded publication occurs.
 int leases=0;remotekit_rtc_frame source{};source.frame_id=42;source.layout_epoch=8;
 source.release_context=&leases;
 source.retain=[](void* p,uint64_t){++*static_cast<int*>(p);};
 source.release=[](void* p,uint64_t){--*static_cast<int*>(p);};
 auto attempt=std::make_shared<remotekit::TailIdrAttempt>();
 auto tail=remotekit::TailRefreshLease::Wrap(source,attempt);CHECK(leases==1);
 CHECK(remotekit::TailRefreshLease::BeginEncoding(tail));
 CHECK(!gate.Send(1,tail.layout_epoch,true,[&]{++published;return true;}));
 remotekit::TailRefreshLease::Finish(tail,false);tail.release(tail.release_context,tail.frame_id);
 CHECK(leases==0 && attempt->state()==remotekit::TailIdrAttempt::State::failed);

 gate.Mode(1,false);CHECK(!send(1,8,false)); // Canvas cancels ACK wait, preserves IDR recovery.
 CHECK(!send(1,9,false));CHECK(send(1,9));CHECK(send(1,9,false));
 gate.Mode(1,true);gate.Bind(2);CHECK(!send(1,9));CHECK(!gate.Ready(1,*third));
 CHECK(send(2,0,false));gate.Layout(4,10);auto fresh=gate.Mode(2,true);CHECK(fresh);
 CHECK(fresh->barrier>third->barrier);CHECK(!gate.Ready(2,*third));
 CHECK(gate.Ready(2,*fresh));CHECK(send(2,10));
 gate.Bind(0);CHECK(!send(2,10));
 gate.Bind(3);auto early=gate.Mode(3,true);CHECK(early && early->epoch==0);
 CHECK(!send(3,10)); // Negotiation before the first layout closes immediately.
 // Session suppresses this empty prepare; first real layout creates its key.
 auto initial=gate.Layout(5,11);CHECK(initial && initial->barrier>early->barrier);
 CHECK(!gate.Ready(3,*early));CHECK(gate.Ready(3,*initial));CHECK(send(3,11));
 std::cout<<"presentation barrier ordering, publication serialization and tail lease tests passed\n";
}
