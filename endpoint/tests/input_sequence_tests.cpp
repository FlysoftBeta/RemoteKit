#include "input/input_sequence.hpp"
#include <cstdlib>
#include <iostream>

#define CHECK(x)                                    \
  do {                                              \
    if (!(x)) {                                     \
      std::cerr << __LINE__ << " failed: " #x "\n"; \
      std::exit(1);                                 \
    }                                               \
  } while (false)
int main() {
  remotekit::InputSequence sequence;
  CHECK(!sequence.Admit(1, "1"));
  sequence.Bind(1);
  for (auto invalid : {"", "0", "-1", "+1", "1x", "18446744073709551616"})
    CHECK(!sequence.Admit(1, invalid));
  CHECK(!sequence.Admit(2, "999"));
  CHECK(sequence.Admit(1, "1"));
  CHECK(sequence.NextBrowser() == 1);
  CHECK(!sequence.Admit(1, "1"));
  CHECK(sequence.Admit(1, "10"));
  CHECK(!sequence.Admit(1, "9"));      // Check before coalescing mouse moves.
  CHECK(sequence.NextBrowser() == 2);  // Client gaps do not control Browser IDs.
  sequence.Bind(0);
  CHECK(!sequence.Admit(1, "11"));
  sequence.Bind(2);                   // A reloaded Viewer starts at one, same Browser survives.
  CHECK(!sequence.Admit(1, "1000"));  // Late old-peer callbacks cannot poison it.
  CHECK(sequence.Admit(2, "1"));
  CHECK(sequence.NextBrowser() == 3);
  CHECK(!sequence.Admit(2, "1"));
  CHECK(sequence.Admit(2, "2"));
  CHECK(sequence.NextBrowser() == 4);
  std::cout << "input sequence tests passed\n";
}
