#include "remotekit/capture_clock.hpp"
#include <cstdlib>
#include <iostream>
#define CHECK(x) do {if(!(x)){std::cerr<<__LINE__<<" failed: " #x "\n";std::exit(1);}}while(false)
int main(){
 auto first=remotekit::MapCaptureClock(9000,1000,9998,10002,1700000000000.0,0.25);
 CHECK(first && first->wall_ms==1699999999000.0 && first->monotonic_ms==9000);
 CHECK(std::abs(first->uncertainty_ms-2.251)<.00001);
 auto tail=remotekit::MapCaptureClock(9000,1000,11998,12002,1700000002000.0,0.25);
 CHECK(tail && tail->wall_ms==first->wall_ms && tail->monotonic_ms==first->monotonic_ms);
 CHECK(!remotekit::MapCaptureClock(0,1000,9998,10002,0,0));
 CHECK(!remotekit::MapCaptureClock(10003,1000,9998,10002,0,0));
 CHECK(!remotekit::MapCaptureClock(9000,0,9998,10002,0,0));
 CHECK(!remotekit::MapCaptureClock(9000,1000,10002,9998,0,0));
 CHECK(!remotekit::MapCaptureClock(9000,1000,9998,10002,0,-1));
 std::cout<<"capture clock mapping tests passed\n";
}
