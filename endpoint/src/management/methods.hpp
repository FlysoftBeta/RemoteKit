#pragma once
#include "util/common.hpp"
#include "util/error.hpp"
namespace remotekit {
class Session;
class ManagementMethods {
 public:
  using Handler = Result<Json> (*)(Session&, const Json&);
  static Handler Find(const std::string& name);
};
}  // namespace remotekit
