#include "remotekit/product_authorization.hpp"

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
  using Gate = remotekit::ProductAuthorization;
  using Decision = Gate::Decision;
  Gate gate;
  gate.Bind(true);
  CHECK(!gate.Stamp());
  CHECK(gate.Check(0, true) == Decision::reject);
  CHECK(gate.Check(1, false) == Decision::change);
  gate.Commit(1, false);
  CHECK(gate.Check(1, false) == Decision::unchanged);
  CHECK(gate.Check(1, true) == Decision::reject);

  CHECK(gate.Check(2, true) == Decision::change);
  gate.Open();
  gate.Commit(2, true);
  const auto first = gate.Stamp();
  CHECK(gate.Current(first));
  CHECK(gate.Check(2, true) == Decision::unchanged);
  CHECK(gate.Check(2, false) == Decision::reject);

  // Management loss revokes old queue stamps and cannot be replayed away.
  gate.Close();
  CHECK(!gate.Current(first));
  CHECK(gate.Check(2, true) == Decision::reject);
  CHECK(gate.Check(2, false) == Decision::reject);
  CHECK(gate.Check(1, true) == Decision::reject);
  CHECK(gate.Check(3, true) == Decision::change);
  gate.Open();
  gate.Commit(3, true);
  const auto second = gate.Stamp();
  CHECK(gate.Current(second) && !gate.Current(first));

  gate.Bind(true);
  CHECK(!gate.Current(second));
  CHECK(gate.Check(1, true) == Decision::change);
  gate.Bind(false);
  CHECK(gate.Stamp() && !gate.Current(second));
  CHECK(gate.Check(1, true) == Decision::reject);
}
