#include "remotekit/shared_lease_retirement.hpp"
#include <map>
#include <iostream>
#include <stdexcept>
using remotekit::SharedLeaseRetirement;
void Require(bool condition){if(!condition)throw std::runtime_error("retirement test failed");}
int main() {
 try {
  SharedLeaseRetirement generation;
  std::map<uint64_t,unsigned> refs{{1,2},{2,1},{3,1}};
  generation.Observe(100,1);generation.Observe(107,2);generation.Observe(120,3);
  auto candidate=[&]{return generation.SafePrefix([&](uint64_t cookie){return refs.at(cookie)==0;});};
  refs[3]=0;refs[2]=0;Require(candidate()==99); // Out of order releases cannot pass oldest 100.
  generation.Commit(99,[](uint64_t){throw std::runtime_error("held record removed");});
  --refs[1];Require(candidate()==0); // latest/SDK's independent owner still blocks; no repeated signal.
  --refs[1];Require(candidate()==120); // Holes are legal; no invented values 101..106.
  unsigned released=0;
  // A failed consumed Signal, or consumed success followed by done failure,
  // does not commit the ledger. Runtime marks it untracked and stops retries.
  Require(generation.size()==3 && generation.retired_prefix()==99);
  Require(candidate()==120);
  generation.Commit(candidate(),[&](uint64_t){++released;});
  Require(released==3 && generation.size()==0 && generation.retired_prefix()==120);
  generation.Observe(143,4);refs[4]=1;Require(candidate()==142);
  generation.Commit(142,[](uint64_t){throw std::runtime_error("held record removed");});
  Require(candidate()==0);
  SharedLeaseRetirement next;
  next.Observe(1,1);Require(next.SafePrefix([](uint64_t){return true;})==1);
  Require(candidate()==0 && generation.retired_prefix()==142); // Distinct generation/late old cookie.
  next.Commit(1,[](uint64_t){});Require(next.retired_prefix()==1);
  refs[4]=0;Require(candidate()==143); // Close requires all refs before its GPU barrier.
  generation.Commit(143,[](uint64_t){});Require(generation.size()==0);
  bool rejected=false;try{generation.Observe(142,5);}catch(const std::logic_error&){rejected=true;}
  Require(rejected);
  SharedLeaseRetirement partial;partial.Observe(3,1);partial.Observe(9,2);
  Require(partial.SafePrefix([](uint64_t cookie){return cookie==1;})==8);
  partial.Commit(8,[](uint64_t){});Require(partial.size()==1 && partial.retired_prefix()==8);
  Require(partial.SafePrefix([](uint64_t){return false;})==0);
  SharedLeaseRetirement startup;startup.Observe(3,1);
  Require(startup.SafePrefix([](uint64_t){return false;})==2);
  startup.Commit(2,[](uint64_t){throw std::runtime_error("latest released early");});
  Require(startup.size()==1 && startup.SafePrefix([](uint64_t){return false;})==0);
  startup.Observe(4,2); // Skipped 1/2 are now reusable; latest3 may be replaced by4.
  Require(startup.SafePrefix([](uint64_t cookie){return cookie==1;})==3);
  startup.Commit(3,[](uint64_t cookie){Require(cookie==1);});
  Require(startup.size()==1 && startup.SafePrefix([](uint64_t){return false;})==0);
  Require(startup.SafePrefix([](uint64_t){return true;})==4);
  // A frozen producer's last publications can be unborrowed. CPU readiness,
  // then the oldest real reader, independently gate the final cumulative ack.
  SharedLeaseRetirement terminal;terminal.Observe(10,11);bool held=true;
  auto prefix=[&]{return terminal.SafePrefix([&](uint64_t cookie){Require(cookie==11);return !held;});};
  Require(!terminal.ObserveUnborrowedThrough(15,14));
  Require(!terminal.terminal_ready() && terminal.last_observed()==10 && prefix()==9);
  terminal.Commit(9,[](uint64_t){throw std::runtime_error("terminal freed reader early");});
  Require(!terminal.ObserveUnborrowedThrough(15,UINT64_MAX)); // device removal is not GPU completion
  Require(!terminal.terminal_ready() && prefix()==0);
  bool sealed=false;try{terminal.Observe(11,12);}catch(const std::logic_error&){sealed=true;}
  Require(sealed);
  Require(terminal.ObserveUnborrowedThrough(15,15));
  Require(terminal.terminal_ready() && terminal.last_observed()==15 && prefix()==0);
  held=false;Require(prefix()==15);
  unsigned real_retired=0;
  terminal.Commit(15,[&](uint64_t cookie){Require(cookie==11);++real_retired;});
  Require(real_retired==1 && terminal.size()==0 && terminal.retired_prefix()==15);
  SharedLeaseRetirement never_borrowed;
  Require(!never_borrowed.ObserveUnborrowedThrough(3,2));
  Require(never_borrowed.SafePrefix([](uint64_t){throw std::runtime_error("invented terminal lease");return true;})==0);
  Require(never_borrowed.ObserveUnborrowedThrough(3,3));
  Require(never_borrowed.SafePrefix([](uint64_t){return false;})==3);
  never_borrowed.Commit(3,[](uint64_t){throw std::runtime_error("invented terminal lease");});
  SharedLeaseRetirement fresh;fresh.Observe(1,1);
  Require(fresh.SafePrefix([](uint64_t){return true;})==1 && never_borrowed.retired_prefix()==3);
  bool changed=false;try{never_borrowed.ObserveUnborrowedThrough(4,4);}catch(const std::logic_error&){changed=true;}
  Require(changed);
  std::cout<<"shared lease ordered retirement passed\n";return 0;
 } catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
