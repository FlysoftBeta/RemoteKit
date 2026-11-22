#pragma once
#include <deque>
#include <string>
#include <string_view>
#include <utility>
#include <vector>
#include "mojo/public/cpp/system/message_pipe.h"
namespace remotekit::sdk {
// A claimed endpoint with the messages Browser had already queued on it.
struct ClaimedRenderEndpoint {
  bool is_valid() const { return pipe.is_valid(); }
  mojo::ScopedMessagePipeHandle pipe;
  std::deque<std::vector<uint8_t>> early;
};
// A Control connection owns one unclaimed endpoint. All methods are called
// under SDKState::lock. Claim transfers ownership; control closure then has no
// ownership of the independent render pipe. No second process link is created.
class PendingRenderEndpoint {
 public:
  // Browser queues ObservedChanged as soon as its generation exists, before
  // this side claims the endpoint. Those messages are kept, in order, for the
  // reader; they are not a reason to reject the setup.
  static constexpr size_t kMaxEarlyMessages = 64;
  void Reset() {
    endpoint_.reset();
    early_.clear();
    token_.clear();
  }
  bool Install(std::string token, std::vector<mojo::ScopedHandle> attachments) {
    Reset();
    if (token.empty() || token.size() > 128 || attachments.size() != 1 ||
        !attachments.front().is_valid())
      return false;
    // A message-pipe read validates the handle's actual Mojo type. Wrong
    // types, peer closure and handle-carrying messages reject the setup.
    const auto raw = mojo::MessagePipeHandle(attachments.front().get().value());
    std::deque<std::vector<uint8_t>> early;
    for (;;) {
      std::vector<uint8_t> bytes;
      std::vector<mojo::ScopedHandle> nested;
      const auto read = mojo::ReadMessageRaw(raw, &bytes, &nested, MOJO_READ_MESSAGE_FLAG_NONE);
      if (read == MOJO_RESULT_SHOULD_WAIT)
        break;
      if (read != MOJO_RESULT_OK || !nested.empty() || early.size() == kMaxEarlyMessages)
        return false;
      early.push_back(std::move(bytes));
    }
    early_ = std::move(early);
    endpoint_ = mojo::ScopedMessagePipeHandle(
        mojo::MessagePipeHandle(attachments.front().release().value()));
    token_ = std::move(token);
    return true;
  }
  bool Matches(std::string_view token) const { return endpoint_.is_valid() && token_ == token; }
  ClaimedRenderEndpoint Claim(std::string_view token) {
    if (!Matches(token))
      return {};
    token_.clear();
    return {std::move(endpoint_), std::exchange(early_, {})};
  }

 private:
  std::string token_;
  mojo::ScopedMessagePipeHandle endpoint_;
  std::deque<std::vector<uint8_t>> early_;
};
}  // namespace remotekit::sdk
