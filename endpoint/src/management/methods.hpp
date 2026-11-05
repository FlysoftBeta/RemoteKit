#pragma once
#include "common.hpp"
#include "remotekit/error.hpp"
namespace remotekit {
class Session;
class ManagementMethods {
 public:
  using Handler = Result<Json> (*)(Session&, const Json&);
  static Handler Find(const std::string& name);
};
}  // namespace remotekit
