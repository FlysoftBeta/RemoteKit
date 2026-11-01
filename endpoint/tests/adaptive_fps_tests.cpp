#include "remotekit/adaptive_fps.hpp"
#include <cstdlib>
#include <iostream>

#define CHECK(x) do {if(!(x)){std::cerr<<__LINE__<<" failed: " #x "\n";std::exit(1);}}while(false)
using Policy=remotekit::AdaptiveFps;
struct Fixture {
  Policy policy{true,60};Policy::Counters counters;int64_t capture=0;
  void Window(double now,double latency=10,uint64_t replacements=0,const Policy::Feedback& feedback={}) {
    for(int i=0;i<3;++i)policy.ObserveSource(1,++capture,now-30+i*10,latency);
    counters.completed+=3;counters.replaced+=replacements;counters.wait_us+=3000;counters.wait_samples+=3;
    policy.Step(now,counters,feedback);
  }
};
int main() {
  { // Tail publication IDs cannot create activity with the same capture identity.
    Fixture f;f.policy.Reset(0,{});
    for(int n=1;n<=10;++n) {
      f.policy.ObserveSource(1,1,n*500,200);f.policy.Step(n*500,{},{});
    }
    CHECK(f.policy.target()==60);
  }
  { // Two pressured windows, then three healthy windows and a two-second cooldown.
    Fixture f;f.policy.Reset(0,{});f.Window(500,50);CHECK(f.policy.target()==60);
    f.Window(1000,50);CHECK(f.policy.target()==48);CHECK(f.policy.applied()==60);
    f.policy.Failed("transport error");CHECK(f.policy.applied()==60 && !f.policy.error().empty());
    f.policy.Applied(48);CHECK(f.policy.error().empty());
    f.Window(1500);f.Window(2000);f.Window(2500);CHECK(f.policy.target()==48);
    f.Window(3000);CHECK(f.policy.target()==50);
  }
  { // A newly measured extreme capture delay may lower immediately.
    Fixture f;f.policy.Reset(0,{});f.Window(500,101);CHECK(f.policy.target()==48);
    f.policy.Applied(48);f.policy.Step(1000,f.counters,{});CHECK(f.policy.target()==48);
    CHECK(f.policy.reason()=="inactive"); // Stale latency never keeps reducing.
  }
  { // Display cap is rounded up; stale/hidden feedback restores the request ceiling.
    Fixture f;Policy::Feedback sample;sample.seq=1;sample.age_ms=1;
    sample.visible=true;sample.display_hz=29.2;
    f.policy.Step(500,{},sample);CHECK(f.policy.ceiling()==30 && f.policy.target()==30);
    f.policy.Applied(30);sample.age_ms=5001;
    f.policy.Step(1000,{},sample);CHECK(f.policy.ceiling()==60 && f.policy.target()==30);
    sample.age_ms=1;sample.visible=false;f.policy.Step(1500,{},sample);CHECK(f.policy.ceiling()==60);
  }
  { // Missing RTT or missing loss cannot invent network pressure; baseline uses ms.
    Fixture f;Policy::Feedback sample;sample.seq=1;sample.age_ms=0;sample.rtt_ms=10;
    f.Window(500,10,0,sample);sample.seq=2;sample.rtt_ms=50;
    f.Window(1000,10,0,sample);CHECK(f.policy.target()==60);
    sample.seq=3;sample.lost=1;f.Window(1500,10,0,sample);CHECK(f.policy.target()==60);
    sample.seq=4;f.Window(2000,10,0,sample);CHECK(f.policy.target()==48);
  }
  { // A replay of a single network window must not count twice.
    Fixture f;Policy::Feedback sample;sample.seq=1;sample.age_ms=0;sample.rtt_ms=10;sample.lost=0;
    f.Window(500,10,0,sample);sample.seq=2;sample.rtt_ms=50;sample.lost=1;
    f.Window(1000,10,0,sample);f.Window(1500,10,0,sample);CHECK(f.policy.target()==60);
    f.Window(2000,10,0,sample);sample.seq=3;
    f.Window(2500,10,0,sample);CHECK(f.policy.target()==48); // 1500ms receiver cadence.
  }
  { // Missing/expired feedback clears network hysteresis without inventing loss.
    Fixture f;Policy::Feedback sample;sample.seq=1;sample.age_ms=0;sample.rtt_ms=10;sample.lost=0;
    f.Window(500,10,0,sample);sample.seq=2;sample.rtt_ms=50;sample.lost=1;
    f.Window(1000,10,0,sample);sample.age_ms=5001;f.Window(1500,10,0,sample);
    sample.age_ms=0;sample.seq=3;f.Window(2000,10,0,sample);CHECK(f.policy.target()==60);
    sample.seq=4;sample.lost.reset();f.Window(2500,10,0,sample);
    sample.seq=5;sample.lost=1;f.Window(3000,10,0,sample);CHECK(f.policy.target()==60);
  }
  { // Static network samples do not accumulate load-pressure decisions.
    Fixture f;Policy::Feedback sample;sample.seq=1;sample.age_ms=0;sample.rtt_ms=10;sample.lost=0;
    f.policy.Step(500,{},sample);sample.seq=2;sample.rtt_ms=50;sample.lost=1;
    f.policy.Step(1000,{},sample);sample.seq=3;f.policy.Step(1500,{},sample);
    sample.seq=4;f.Window(2000,10,0,sample);CHECK(f.policy.target()==60);
  }
  { // Replacement ratio alone causes pressure; unrelated counter activity is insufficient.
    Fixture f;f.Window(500,10,1);CHECK(f.policy.target()==60);
    f.Window(1000,10,1);CHECK(f.policy.target()==48);
  }
  { // Reset cumulative counters without unsigned deltas or inherited pressure.
    Fixture f;f.Window(500,50);f.counters={};
    f.policy.Step(1000,f.counters,{});CHECK(f.policy.target()==60);
    CHECK(f.policy.reason()=="counter_reset");f.Window(1500,50);CHECK(f.policy.target()==60);
    f.Window(2000,50);CHECK(f.policy.target()==48);f.policy.Applied(48);
    f.policy.Reset(2500,f.counters);CHECK(f.policy.target()==60 && f.policy.applied()==48);
    CHECK(f.policy.ceiling()==60 && f.policy.reason()=="reset");
  }
  { // Replacement pressure and minimum budget; disabled means no decisions.
    Policy low(true,6);Policy::Counters c;
    for(int n=1;n<=5;++n) {
      for(int i=0;i<3;++i)low.ObserveSource(1,n*3+i+1,n*500-i,200);
      c.replaced+=3;low.Step(n*500,c,{});low.Applied(low.target());
    }
    CHECK(low.target()==6);
    Policy disabled(false,60);Policy::Feedback sample;sample.seq=1;sample.age_ms=0;
    sample.visible=true;sample.display_hz=30;
    CHECK(!disabled.Step(1000,{},sample));CHECK(disabled.target()==60);
  }
  std::cout<<"adaptive fps policy checks passed\n";
}
