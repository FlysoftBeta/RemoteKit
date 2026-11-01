#include "remotekit/qsv_session_pattern.hpp"
#include <cstdlib>
#include <iostream>
#include <string>

#define CHECK(x) do {if(!(x)){std::cerr<<__LINE__<<" failed: " #x "\n";std::exit(1);}}while(false)
template<class F> bool Rejects(F action) {try{action();return false;}catch(const std::invalid_argument&){return true;}}
int main() {
  using namespace remotekit;
  CHECK(ParseQsvLowPowerPattern("").empty());
  auto pattern=ParseQsvLowPowerPattern("on,on,off");
  CHECK(pattern==std::vector<uint32_t>({0x10,0x10,0x20}));
  for(const auto text:{",","on,",",off","on,,off","auto","ON"," on","off ","on,auto","1"})
    CHECK(Rejects([&]{ParseQsvLowPowerPattern(text);}));
  std::string maximum="on";for(int i=1;i<16;++i)maximum+=",off";
  CHECK(ParseQsvLowPowerPattern(maximum).size()==16);
  CHECK(Rejects([&]{ParseQsvLowPowerPattern(maximum+",on");}));
  ValidateQsvLowPowerPattern(pattern,"qsv",false);
  CHECK(Rejects([&]{ValidateQsvLowPowerPattern(pattern,"auto",false);}));
  CHECK(Rejects([&]{ValidateQsvLowPowerPattern(pattern,"nvenc",false);}));
  CHECK(Rejects([&]{ValidateQsvLowPowerPattern(pattern,"qsv",true);}));
  ValidateQsvLowPowerPattern({},"auto",true); // Empty leaves the single-value path intact.
  CHECK(QsvLowPowerPatternIndex("1",3)==0);
  CHECK(QsvLowPowerPatternIndex("2",3)==1);
  CHECK(QsvLowPowerPatternIndex("3",3)==2);
  CHECK(QsvLowPowerPatternIndex("4",3)==0);
  CHECK(QsvLowPowerPatternIndex("18446744073709551615",3)==2);
  CHECK(QsvLowPowerPatternIndex("18446744073709551615",16)==14);
  for(const auto text:{"","0","01","-1","+1","1 "," 1","1x","18446744073709551616"})
    CHECK(Rejects([&]{QsvLowPowerPatternIndex(text,3);}));
  CHECK(Rejects([&]{QsvLowPowerPatternIndex("1",0);}));
  CHECK(Rejects([&]{QsvLowPowerPatternIndex("1",17);}));
  // Assignment depends only on the persisted Session id, including after restart
  // or shuffled creation order. One Session's local choice cannot edit the pattern.
  for(const auto id:{"9","2","8","1","6","3"}) {
    const auto index=QsvLowPowerPatternIndex(id,pattern.size());
    const auto selected=pattern[index];auto local_pattern=pattern;local_pattern[index]=0;
    const auto restored=ParseQsvLowPowerPattern("on,on,off");
    CHECK(selected==restored[QsvLowPowerPatternIndex(id,restored.size())]);
    CHECK(pattern==restored);
  }
  std::cout<<"qsv Session pattern checks passed\n";
}
