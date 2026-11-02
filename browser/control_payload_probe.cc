// CPU-only: calls the exact production response writer and accept exporter.
#include "remotekit/browser/control_response.h"
#include "remotekit/browser/file_chooser_accept.h"

#include <cstdio>

#include "base/at_exit.h"
#include "base/check.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"

namespace {
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
  const auto writer = base::BindRepeating(
      [](std::string* output, int* write_count, std::string_view encoded) {
        *output = encoded;
        ++*write_count;
        return true;
      }, base::Unretained(&wire), base::Unretained(&writes));
  CHECK(remotekit::browser::WriteControlResponse(request, reply, writer));
  CHECK(original && wire == *original && writes == 1);
  reply.Set("data", std::string(1024 * 1024, 'x'));
  // Success here is the same return tested before ControlServer closes its pipe.
  CHECK(remotekit::browser::WriteControlResponse(request, reply, writer));
  CHECK(writes == 2 && wire.size() < 512);
  const auto error = base::JSONReader::ReadDict(wire, base::JSON_PARSE_RFC);
  CHECK(error && error->FindInt("id") == 73 && error->FindInt("version") == 1);
  CHECK(error->FindBool("ok") == false);
  CHECK(error->FindString("error") && *error->FindString("error") == "response_too_large");
  CHECK(error->FindString("message") && !error->FindString("message")->empty());
  // No truncation or mutation of the original reply/operation data.
  CHECK(reply.FindBool("ok") == true && reply.FindString("data")->size() == 1024 * 1024);
  reply.Remove("data");
  request.Set("id", 74);
  reply.Set("id", 74);
  CHECK(remotekit::browser::WriteControlResponse(request, reply, writer));
  CHECK(writes == 3 && wire == *base::WriteJson(reply));
  // Actual failed writes still take the transport failure path.
  CHECK(!remotekit::browser::WriteControlResponse(request, reply,
      base::BindRepeating([](std::string_view) { return false; })));
}
void AcceptHints() {
  using remotekit::browser::ExportFileChooserAcceptHints;
  const std::vector<std::u16string> normal{u"image/*", u"application/pdf", u".tar.gz", u".照片"};
  const auto exported = ExportFileChooserAcceptHints(normal);
  CHECK(!exported.omitted && exported.types.size() == 4);
  CHECK(exported.types[0].GetString() == "image/*");
  CHECK(exported.types[2].GetString() == ".tar.gz");
  const auto invalid = ExportFileChooserAcceptHints({u".", u"not-a-mime", u".a,b", u"image/png;foo=bar", u".txt"});
  CHECK(invalid.omitted && invalid.types.size() == 1 && invalid.types[0].GetString() == ".txt");
  std::vector<std::u16string> declarations{u"." + std::u16string(86, u'中'), u"." + std::u16string(255, u'a'), u".png"};
  const auto bytes = ExportFileChooserAcceptHints(declarations);
  CHECK(bytes.omitted && bytes.types.size() == 2);
  CHECK(bytes.types[0].GetString().size() == 256);
  const auto malformed = ExportFileChooserAcceptHints({std::u16string{u'.', char16_t(0xd800)}, u".jpg"});
  CHECK(malformed.omitted && malformed.types.size() == 1 && malformed.types[0].GetString() == ".jpg");
  const auto all = ExportFileChooserAcceptHints(std::vector<std::u16string>(64, u"." + std::u16string(255, u'a')));
  CHECK(all.omitted && all.types.size() < 64);
  CHECK(base::WriteJson(all.types)->size() <= 16 * 1024);
  // Escaping contributes to the actual aggregate JSON budget as well.
  const auto escaped = ExportFileChooserAcceptHints(std::vector<std::u16string>(64, u"." + std::u16string(255, u'"')));
  CHECK(escaped.omitted && escaped.types.size() < all.types.size());
  CHECK(base::WriteJson(escaped.types)->size() <= 16 * 1024);
  const auto count = ExportFileChooserAcceptHints(std::vector<std::u16string>(65, u".txt"));
  CHECK(count.omitted && count.types.size() == 64);
  CHECK(!ExportFileChooserAcceptHints({}).omitted);
}
}  // namespace
int main() {
  base::AtExitManager at_exit;
  Responses();
  AcceptHints();
  std::puts("control payload CPU probe passed");
  return 0;
}
