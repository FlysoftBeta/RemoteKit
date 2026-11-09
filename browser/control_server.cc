#include "remotekit/browser/control_server.h"
#include "browser/control_clipboard.h"
#include "remotekit/browser/control_response.h"
#include <vector>
#include "base/check.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/strings/string_util.h"

namespace remotekit::browser {
ControlServer::ControlServer(const std::string& name,
                             Handler handler,
                             AttachmentProvider attachment_provider,
                             base::OnceClosure disconnected)
    : handler_(std::move(handler)),
      attachment_provider_(std::move(attachment_provider)),
      disconnected_(std::move(disconnected)),
      watcher_(FROM_HERE, mojo::SimpleWatcher::ArmingPolicy::AUTOMATIC) {
  CHECK(!name.empty() && name.size() <= 128 && base::IsStringASCII(name));
  mojo::NamedPlatformChannel::Options options;
  options.server_name = mojo::NamedPlatformChannel::ServerNameFromUTF8(name);
  channel_ = std::make_unique<mojo::NamedPlatformChannel>(options);
  CHECK(channel_->server_endpoint().is_valid());
  pipe_ = connection_.Connect(channel_->TakeServerEndpoint());
  CHECK(pipe_.is_valid());
  CHECK_EQ(watcher_.Watch(pipe_.get(), MOJO_HANDLE_SIGNAL_READABLE,
                          base::BindRepeating(&ControlServer::OnReadable, base::Unretained(this))),
           MOJO_RESULT_OK);
}
ControlServer::~ControlServer() {
  Close();
}
void ControlServer::Close() {
  weak_factory_.InvalidateWeakPtrs();
  watcher_.Cancel();
  pipe_.reset();
  if (disconnected_)
    std::move(disconnected_).Run();
}
void ControlServer::OnReadable(MojoResult result) {
  if (result != MOJO_RESULT_OK) {
    Close();
    return;
  }
  // Bound work per UI turn. Automatic rearming schedules remaining messages.
  for (int count = 0; count < 16; ++count) {
    std::vector<uint8_t> data;
    auto read = mojo::ReadMessageRaw(pipe_.get(), &data, nullptr, MOJO_READ_MESSAGE_FLAG_NONE);
    if (read == MOJO_RESULT_SHOULD_WAIT)
      return;
    if (read != MOJO_RESULT_OK || data.size() > kClipboardJsonLimit) {
      Close();
      return;
    }
    const std::string request(data.begin(), data.end());
    auto parsed = base::JSONReader::ReadDict(request, base::JSON_PARSE_RFC, 32);
    if (data.size() > (parsed ? ControlRequestJsonLimit(*parsed) : kControlJsonLimit)) {
      Close();
      return;
    }
    if (!parsed) {
      SendReply({}, ControlResult::Failure(0, protocol::ErrorCode::kInvalidRequest,
                                           "Invalid control JSON"));
    } else {
      auto application_request = parsed->Clone();
      handler_.Run(*parsed, base::BindOnce(&ControlServer::SendReply, weak_factory_.GetWeakPtr(),
                                           std::move(application_request)));
    }
    if (!pipe_.is_valid())
      return;
  }
}
void ControlServer::SendReply(base::DictValue application_request, base::DictValue reply) {
  if (!WriteControlResponse(
          application_request, reply,
          base::BindRepeating(
              [](ControlServer* server, const base::DictValue* request,
                 const base::DictValue* response, std::string_view encoded, bool original_reply) {
                mojo::ScopedMessagePipeHandle endpoint;
                if (ShouldAttachRenderEndpoint(*request, *response, original_reply)) {
                  if (!server->attachment_provider_)
                    return false;
                  endpoint = server->attachment_provider_.Run(*request, *response);
                  if (!endpoint.is_valid())
                    return false;
                }
                const MojoHandle attached = endpoint.get().value();
                const auto result = mojo::WriteMessageRaw(
                    server->pipe_.get(), encoded.data(), encoded.size(),
                    endpoint.is_valid() ? &attached : nullptr, endpoint.is_valid() ? 1 : 0,
                    MOJO_WRITE_MESSAGE_FLAG_NONE);
                // Mojo consumes attached handles only on a successful write.
                // Failure destroys the local endpoint, then Close stops output.
                if (result == MOJO_RESULT_OK && endpoint.is_valid())
                  (void)endpoint.release();
                return result == MOJO_RESULT_OK;
              },
              base::Unretained(this), base::Unretained(&application_request),
              base::Unretained(&reply)))) {
    Close();
  }
}
}  // namespace remotekit::browser
