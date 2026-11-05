#pragma once
#include <string>
#include <string_view>
#include <utility>
#include <vector>
#include "mojo/public/cpp/system/message_pipe.h"
namespace remotekit::sdk {
// A Control connection owns one unclaimed endpoint. All methods are called
// under SDKState::lock. Claim transfers ownership; control closure then has no
// ownership of the independent render pipe. No second process link is created.
class PendingRenderEndpoint {
 public:
  void Reset() {
    endpoint_.reset();
    token_.clear();
  }
  bool Install(std::string token, std::vector<mojo::ScopedHandle> attachments) {
    Reset();
    if (token.empty() || token.size() > 128 || attachments.size() != 1 ||
        !attachments.front().is_valid())
      return false;
    // A message-pipe read validates the handle's actual Mojo type. The new
    // endpoint must be empty: Browser sends nothing before the first Begin.
    // Invalid types, peer closure or unsolicited messages reject the setup.
    std::vector<uint8_t> bytes;
    std::vector<mojo::ScopedHandle> nested;
    const auto raw = mojo::MessagePipeHandle(attachments.front().get().value());
    if (mojo::ReadMessageRaw(raw, &bytes, &nested, MOJO_READ_MESSAGE_FLAG_NONE) !=
        MOJO_RESULT_SHOULD_WAIT)
      return false;
    endpoint_ = mojo::ScopedMessagePipeHandle(
        mojo::MessagePipeHandle(attachments.front().release().value()));
    token_ = std::move(token);
    return true;
  }
  bool Matches(std::string_view token) const { return endpoint_.is_valid() && token_ == token; }
  mojo::ScopedMessagePipeHandle Claim(std::string_view token) {
    if (!Matches(token))
      return {};
    token_.clear();
    return std::move(endpoint_);
  }

 private:
  std::string token_;
  mojo::ScopedMessagePipeHandle endpoint_;
};
}  // namespace remotekit::sdk
