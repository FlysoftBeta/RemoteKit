#pragma once
#include "remotekit/browser/sdk/sdk_internal.h"
namespace remotekit::sdk {
HANDLE NativeHandle(uint64_t value);
int ReplyStatus(const base::DictValue&, remotekit_sdk_failure*);
bool ValidHandle(uint64_t value);
bool StringUint64(const base::DictValue&, std::string_view, uint64_t*);
// Every identified resource handle in a decoded reply has already been
// duplicated into this process. Keep ownership through all validation paths;
// only the 13 successfully returned handles are released to the caller.
class ReplyHandles {
 public:
  explicit ReplyHandles(const base::DictValue& reply);
  ~ReplyHandles();
  void Transfer(const remotekit_sdk_render_setup& setup);

 private:
  void Add(const base::Value* value);
  void Collect(const base::DictValue& dict);
  std::set<uint64_t> owned_;
};

}  // namespace remotekit::sdk
