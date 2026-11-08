// CPU-only: calls the exact production response writer and accept exporter.
#include "remotekit/browser/control_response.h"
#include "browser/control_input_codec.h"
#include "browser/control_clipboard.h"
#include "browser/signin_result.h"
#include "remotekit/browser/file_chooser_accept.h"

#include <cstdio>

#include "base/at_exit.h"
#include "base/check.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"

namespace {
void SignInResults() {
  using namespace remotekit::browser;
  CHECK(ValidSignInPurpose("changyan") && ValidSignInPurpose("xinjiaoyu"));
  CHECK(!ValidSignInPurpose("") && !ValidSignInPurpose("other"));
  net::HttpRequestHeaders headers;
  const GURL api("https://www.xinjiaoyu.com/api/v3/student/info");
  CHECK(!XinjiaoyuSignInResult(api, headers));
  headers.SetHeader("Authorization", "JBY example");
  CHECK(!XinjiaoyuSignInResult(api, headers));
  headers.SetHeader("AccessToken", "example");
  headers.SetHeader("Cookie", "must-not-leave-browser");
  for (const auto* name :
       {"user-agent", "accept-language", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"})
    headers.SetHeader(name, "identity");
  auto result = XinjiaoyuSignInResult(api, headers);
  CHECK(result && result->size() == 7 && !result->contains("cookie"));
  for (const auto* url : {"https://www.xinjiaoyu.com/api/v3/server_system/system/code",
                          "https://www.xinjiaoyu.com/api/v3/server_system/auth/login",
                          "http://www.xinjiaoyu.com/api/v3/student/info",
                          "https://www.xinjiaoyu.com.evil.test/api/v3/student/info",
                          "https://www.xinjiaoyu.com:444/api/v3/student/info",
                          "https://www.xinjiaoyu.com/api/v30/student/info"})
    CHECK(!XinjiaoyuSignInResult(GURL(url), headers));
  headers.SetHeader("Authorization", "Bearer example");
  CHECK(!XinjiaoyuSignInResult(api, headers));
  headers.SetHeader("Authorization", "JBY " + std::string(8192, 'x'));
  CHECK(!XinjiaoyuSignInResult(api, headers));
  auto done = ChangyanSignInResult(
      GURL("remotekit-signin://changyan/"
           "done?lot_number=a&captcha_output=b%2Bc&pass_token=d&gen_time=1&cookie=ignore"));
  CHECK(done && done->size() == 4 && *done->FindString("captcha_output") == "b+c");
  CHECK(!ChangyanSignInResult(GURL("remotekit-signin://changyan/done?lot_number=a")));
  CHECK(!ChangyanSignInResult(
      GURL("https://changyan/done?lot_number=a&captcha_output=b&pass_token=c&gen_time=1")));
  CHECK(SignInNavigationUrl(GURL("remotekit-signin://changyan/done?secret=value")) ==
        "remotekit-signin://changyan/done");
}

void ControlContract() {
  using namespace remotekit;
  using namespace remotekit::browser;
  base::DictValue clipboard;
  clipboard.Set("revision", "18446744073709551615");
  clipboard.Set("text", "clipboard text");
  clipboard.Set("html", "<p>clipboard text</p>");
  CHECK(ValidClipboardWrite(clipboard));
  for (const auto* revision : {"", "01", "-1", "18446744073709551616"}) {
    clipboard.Set("revision", revision);
    CHECK(!ValidClipboardWrite(clipboard));
  }
  clipboard.Set("revision", "0");
  clipboard.Remove("html");
  CHECK(!ValidClipboardWrite(clipboard));
  auto busy = ControlResult::Failure(19, protocol::ErrorCode::busy, "Page request pending");
  CHECK(busy.FindBool("ok") == false && busy.FindInt("code") == 6);
  CHECK(*busy.FindString("error") == "busy" &&
        *busy.FindString("detail") == "Page request pending");
  base::DictValue subsystem;
  subsystem.Set("ok", false);
  subsystem.Set("error", "page_manager_destroyed");
  const auto failure = ControlResult::FromFields(20, std::move(subsystem));
  CHECK(failure.FindBool("ok") == false && failure.FindInt("code").has_value());
  CHECK(failure.FindString("detail"));
  auto fields = failure.Clone();
  fields.Set("id", 20);
  ControlResult result(std::move(fields));
  auto normalized = std::move(result).TakeFields();
  CHECK(normalized.FindInt("id") == 20);
  CHECK(normalized.FindInt("code") == static_cast<int>(protocol::ErrorCode::internal));
  CHECK(normalized.FindBool("ok") == false);

  base::DictValue wire;
  wire.Set("instance", "1");
  wire.Set("document", "1");
  wire.Set("focus", "1");
  wire.Set("sequence", "1");
  base::DictValue touch;
  touch.Set("type", "touch");
  touch.Set("action", "cancel");
  touch.Set("points", base::ListValue());
  wire.Set("event", touch.Clone());
  CHECK(!DecodeControlInput(wire, 1, 1));
  touch.Set("gestureMode", "legacy");
  wire.Set("event", touch.Clone());
  CHECK(!DecodeControlInput(wire, 1, 1));
  touch.Set("gestureMode", "client-v1");
  touch.Set("gestures", base::ListValue());
  touch.Set("clockMode", "arrival-fallback");
  touch.Set("sequenceId", "gesture-1");
  touch.Set("sampleElapsedUs", 0);
  wire.Set("event", std::move(touch));
  CHECK(DecodeControlInput(wire, 1, 1));
  wire.Set("event", base::DictValue()
                        .Set("type", "selection_command")
                        .Set("menu", "18446744073709551615")
                        .Set("command", "copy"));
  CHECK(DecodeControlInput(wire, 1, 1));
  wire.FindDict("event")->Set("command", "contextMenu");
  CHECK(DecodeControlInput(wire, 1, 1));
  wire.FindDict("event")->Set("type", "context_command");
  for (const auto* command : {"undo", "redo", "cut", "copy", "paste", "selectAll",
                              "copyLinkAddress", "copyImage", "copyImageAddress", "dismiss"}) {
    wire.FindDict("event")->Set("command", command);
    CHECK(DecodeControlInput(wire, 1, 1));
  }
  wire.FindDict("event")->Set("command", "contextMenu");
  CHECK(!DecodeControlInput(wire, 1, 1));
  wire.FindDict("event")->Set("command", "copy");
  wire.FindDict("event")->Set("menu", "01");
  CHECK(!DecodeControlInput(wire, 1, 1));
  wire.Set("event", base::DictValue()
                        .Set("type", "gesture")
                        .Set("gestureMode", "client-v1")
                        .Set("sequenceId", "touch-1")
                        .Set("action", "longPress")
                        .Set("sampleElapsedUs", 500000)
                        .Set("x", 10)
                        .Set("y", 20));
  CHECK(DecodeControlInput(wire, 1, 1));
  wire.FindDict("event")->Remove("x");
  CHECK(!DecodeControlInput(wire, 1, 1));

  wire.Set("event", base::DictValue()
                        .Set("type", "mouse")
                        .Set("action", "down")
                        .Set("x", 10)
                        .Set("y", 20)
                        .Set("button", 1)
                        .Set("pen", base::DictValue()
                                        .Set("id", 4294967295.0)
                                        .Set("pressure", 0.6)
                                        .Set("tiltX", 20)
                                        .Set("tiltY", -30)
                                        .Set("twist", 90)
                                        .Set("eraser", true)));
  const auto pen_input = DecodeControlInput(wire, 1, 1);
  CHECK(pen_input);
  const auto& pen = std::get<MouseInput>(pen_input.value.payload).pen;
  CHECK(pen && pen->id == UINT32_MAX && pen->pressure == 0.6 && pen->tilt_x == 20 &&
        pen->tilt_y == -30 && pen->twist == 90 && pen->eraser);
  wire.FindDict("event")->FindDict("pen")->Set("pressure", 2);
  CHECK(!DecodeControlInput(wire, 1, 1));

  const auto contact = base::DictValue()
                           .Set("id", 1)
                           .Set("x", 10)
                           .Set("y", 20)
                           .Set("pressure", 0.5)
                           .Set("width", 18)
                           .Set("height", 24);
  wire.Set("event",
           base::DictValue()
               .Set("type", "touch")
               .Set("action", "move")
               .Set("gestureMode", "client-v1")
               .Set("gestures", base::ListValue())
               .Set("clockMode", "arrival-fallback")
               .Set("sequenceId", "touch-1")
               .Set("sampleElapsedUs", 100)
               .Set("points", base::ListValue().Append(contact.Clone()))
               .Set("samples", base::ListValue().Append(
                                   base::DictValue()
                                       .Set("sampleElapsedUs", 50)
                                       .Set("points", base::ListValue().Append(contact.Clone())))));
  const auto touch_input = DecodeControlInput(wire, 1, 1);
  CHECK(touch_input);
  const auto& decoded_touch = std::get<TouchInput>(touch_input.value.payload);
  CHECK(decoded_touch.points[0].width == 18 && decoded_touch.points[0].height == 24);
  CHECK(decoded_touch.samples[0].points[0].width == 18 &&
        decoded_touch.samples[0].points[0].height == 24);
}
void Responses() {
  base::DictValue request;
  request.Set("id", 73);
  base::DictValue reply;
  reply.Set("version", 1);
  reply.Set("id", 73);
  reply.Set("ok", true);
  const auto original = base::WriteJson(reply);
  std::string wire;
  int writes = 0;
  bool original_reply = false;
  const auto writer = base::BindRepeating(
      [](std::string* output, int* write_count, bool* original, std::string_view encoded,
         bool is_original) {
        *output = encoded;
        ++*write_count;
        *original = is_original;
        return true;
      },
      base::Unretained(&wire), base::Unretained(&writes), base::Unretained(&original_reply));
  CHECK(remotekit::browser::WriteControlResponse(request, reply, writer));
  CHECK(original && wire == *original && writes == 1 && original_reply);
  reply.Set("data", std::string(1024 * 1024, 'x'));
  // Success here is the same return tested before ControlServer closes its pipe.
  CHECK(remotekit::browser::WriteControlResponse(request, reply, writer));
  CHECK(writes == 2 && wire.size() < 512 && !original_reply);
  const auto error = base::JSONReader::ReadDict(wire, base::JSON_PARSE_RFC);
  CHECK(error && error->FindInt("id") == 73 && error->FindInt("version") == 1);
  CHECK(error->FindBool("ok") == false);
  CHECK(error->FindString("error") && *error->FindString("error") == "resource_limit");
  CHECK(error->FindString("detail") && !error->FindString("detail")->empty());
  // No truncation or mutation of the original reply/operation data.
  CHECK(reply.FindBool("ok") == true && reply.FindString("data")->size() == 1024 * 1024);
  reply.Remove("data");
  request.Set("id", 74);
  reply.Set("id", 74);
  CHECK(remotekit::browser::WriteControlResponse(request, reply, writer));
  CHECK(writes == 3 && wire == *base::WriteJson(reply) && original_reply);
  // Actual failed writes still take the transport failure path.
  CHECK(!remotekit::browser::WriteControlResponse(
      request, reply, base::BindRepeating([](std::string_view, bool) { return false; })));
}
void RenderEndpointResponses() {
  base::DictValue request;
  request.Set("method", "output.describe");
  base::DictValue reply;
  reply.Set("ok", true);
  reply.Set("render_channel", "opaque-token");
  int attachments = 0;
  const auto writer = base::BindRepeating(
      [](const base::DictValue* request, const base::DictValue* reply, int* count, std::string_view,
         bool original_reply) {
        if (remotekit::browser::ShouldAttachRenderEndpoint(*request, *reply, original_reply))
          ++*count;
        return true;
      },
      base::Unretained(&request), base::Unretained(&reply), base::Unretained(&attachments));
  CHECK(remotekit::browser::WriteControlResponse(request, reply, writer));
  CHECK(attachments == 1);
  // The original object still claims success/token, but the actual serialized
  // reply is the bounded error fallback and must never export its endpoint.
  reply.Set("data", std::string(1024 * 1024, 'x'));
  CHECK(remotekit::browser::WriteControlResponse(request, reply, writer));
  CHECK(attachments == 1);
  reply.Remove("data");
  reply.Set("error", "endpoint_already_delivered");
  CHECK(remotekit::browser::WriteControlResponse(request, reply, writer));
  CHECK(attachments == 1);
  reply.Remove("error");
  reply.Set("ok", false);
  CHECK(remotekit::browser::WriteControlResponse(request, reply, writer));
  CHECK(attachments == 1);
  reply.Set("ok", true);
  reply.Remove("render_channel");
  CHECK(remotekit::browser::WriteControlResponse(request, reply, writer));
  CHECK(attachments == 1);
  reply.Set("render_channel", "opaque-token");
  request.Set("method", "output.open");
  CHECK(remotekit::browser::WriteControlResponse(request, reply, writer));
  CHECK(attachments == 1);
  request.Set("method", "output.describe");
  CHECK(remotekit::browser::WriteControlResponse(request, reply, writer));
  CHECK(attachments == 2);
}
void AcceptHints() {
  using remotekit::browser::ExportFileChooserAcceptHints;
  const std::vector<std::u16string> normal{u"image/*", u"application/pdf", u".tar.gz", u".照片"};
  const auto exported = ExportFileChooserAcceptHints(normal);
  CHECK(!exported.omitted && exported.types.size() == 4);
  CHECK(exported.types[0].GetString() == "image/*");
  CHECK(exported.types[2].GetString() == ".tar.gz");
  const auto invalid =
      ExportFileChooserAcceptHints({u".", u"not-a-mime", u".a,b", u"image/png;foo=bar", u".txt"});
  CHECK(invalid.omitted && invalid.types.size() == 1 && invalid.types[0].GetString() == ".txt");
  std::vector<std::u16string> declarations{u"." + std::u16string(86, u'中'),
                                           u"." + std::u16string(255, u'a'), u".png"};
  const auto bytes = ExportFileChooserAcceptHints(declarations);
  CHECK(bytes.omitted && bytes.types.size() == 2);
  CHECK(bytes.types[0].GetString().size() == 256);
  const auto malformed =
      ExportFileChooserAcceptHints({std::u16string{u'.', char16_t(0xd800)}, u".jpg"});
  CHECK(malformed.omitted && malformed.types.size() == 1 &&
        malformed.types[0].GetString() == ".jpg");
  const auto all = ExportFileChooserAcceptHints(
      std::vector<std::u16string>(64, u"." + std::u16string(255, u'a')));
  CHECK(all.omitted && all.types.size() < 64);
  CHECK(base::WriteJson(all.types)->size() <= 16 * 1024);
  // Escaping contributes to the actual aggregate JSON budget as well.
  const auto escaped = ExportFileChooserAcceptHints(
      std::vector<std::u16string>(64, u"." + std::u16string(255, u'"')));
  CHECK(escaped.omitted && escaped.types.size() < all.types.size());
  CHECK(base::WriteJson(escaped.types)->size() <= 16 * 1024);
  const auto count = ExportFileChooserAcceptHints(std::vector<std::u16string>(65, u".txt"));
  CHECK(count.omitted && count.types.size() == 64);
  CHECK(!ExportFileChooserAcceptHints({}).omitted);
}
}  // namespace
int main() {
  base::AtExitManager at_exit;
  SignInResults();
  ControlContract();
  Responses();
  RenderEndpointResponses();
  AcceptHints();
  std::puts("control payload CPU probe passed");
  return 0;
}
