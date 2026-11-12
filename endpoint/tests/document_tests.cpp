#include "documents/document_types.hpp"
#include "documents/office_converter.hpp"
#include "documents/pdf_renderer.hpp"
#include "documents/render_archive.hpp"
#include "documents/render_queue.hpp"

#include <windows.h>
#include <io.h>
#include <json.hpp>

#include <atomic>
#include <chrono>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <stdexcept>

namespace {
namespace fs = std::filesystem;
using namespace remotekit;
using namespace remotekit::documents;
using Json = nlohmann::json;

void Check(bool condition, const char* message) {
  if (!condition)
    throw std::runtime_error(message);
}

template <class T>
T Take(Result<T> result) {
  if (!result)
    throw std::runtime_error(result.error().message);
  return std::move(result).value();
}

void Success(Result<void> result) {
  if (!result)
    throw std::runtime_error(result.error().message);
}

Bytes Read(const fs::path& file) {
  std::ifstream stream(file, std::ios::binary);
  Check(stream.good(), "fixture missing");
  return Bytes(std::istreambuf_iterator<char>(stream), {});
}

void Write(const fs::path& file, const Bytes& data) {
  std::ofstream stream(file, std::ios::binary);
  stream.write(reinterpret_cast<const char*>(data.data()), data.size());
  Check(stream.good(), "cannot write fixture");
}

Bytes Text(std::string_view text) {
  return Bytes(text.begin(), text.end());
}

uint64_t Get(const Bytes& bytes, size_t offset, size_t count) {
  Check(offset + count <= bytes.size(), "test ZIP out of bounds");
  uint64_t value = 0;
  for (size_t i = 0; i < count; ++i)
    value |= uint64_t{bytes[offset + i]} << (i * 8);
  return value;
}

void Put(Bytes& bytes, uint64_t value, size_t count) {
  for (size_t i = 0; i < count; ++i)
    bytes.push_back(i < 8 ? static_cast<uint8_t>(value >> (i * 8)) : 0);
}

void Set(Bytes& bytes, size_t offset, uint64_t value, size_t count) {
  for (size_t i = 0; i < count; ++i)
    bytes.at(offset + i) = static_cast<uint8_t>(value >> (i * 8));
}

uint32_t Crc(const Bytes& data) {
  uint32_t crc = 0xffffffff;
  for (auto byte : data) {
    crc ^= byte;
    for (int bit = 0; bit < 8; ++bit)
      crc = (crc >> 1) ^ (0xedb88320 & (0u - (crc & 1)));
  }
  return ~crc;
}

struct ZipEntry {
  std::string name;
  Bytes bytes;
};

// A small, standard ZIP64 writer also used to generate the OOXML inputs. CRCs
// are real so the fixtures can be consumed by LibreOffice and external tools.
Bytes Zip(const std::vector<ZipEntry>& entries) {
  Bytes data;
  std::vector<size_t> offsets;
  for (const auto& entry : entries) {
    offsets.push_back(data.size());
    Put(data, 0x04034b50, 4);
    Put(data, 45, 2);
    Put(data, 0x0800, 2);
    Put(data, 0, 6);
    Put(data, Crc(entry.bytes), 4);
    Put(data, 0xffffffff, 4);
    Put(data, 0xffffffff, 4);
    Put(data, entry.name.size(), 2);
    Put(data, 20, 2);
    data.insert(data.end(), entry.name.begin(), entry.name.end());
    Put(data, 1, 2);
    Put(data, 16, 2);
    Put(data, entry.bytes.size(), 8);
    Put(data, entry.bytes.size(), 8);
    data.insert(data.end(), entry.bytes.begin(), entry.bytes.end());
  }
  size_t central = data.size();
  for (size_t i = 0; i < entries.size(); ++i) {
    const auto& entry = entries[i];
    Put(data, 0x02014b50, 4);
    Put(data, 45, 2);
    Put(data, 45, 2);
    Put(data, 0x0800, 2);
    Put(data, 0, 6);
    Put(data, Crc(entry.bytes), 4);
    Put(data, 0xffffffff, 4);
    Put(data, 0xffffffff, 4);
    Put(data, entry.name.size(), 2);
    Put(data, 28, 2);
    Put(data, 0, 10);
    Put(data, 0xffffffff, 4);
    data.insert(data.end(), entry.name.begin(), entry.name.end());
    Put(data, 1, 2);
    Put(data, 24, 2);
    Put(data, entry.bytes.size(), 8);
    Put(data, entry.bytes.size(), 8);
    Put(data, offsets[i], 8);
  }
  size_t zip64 = data.size();
  Put(data, 0x06064b50, 4);
  Put(data, 44, 8);
  Put(data, 45, 2);
  Put(data, 45, 2);
  Put(data, 0, 8);
  Put(data, entries.size(), 8);
  Put(data, entries.size(), 8);
  Put(data, zip64 - central, 8);
  Put(data, central, 8);
  Put(data, 0x07064b50, 4);
  Put(data, 0, 4);
  Put(data, zip64, 8);
  Put(data, 1, 4);
  Put(data, 0x06054b50, 4);
  Put(data, 0, 4);
  Put(data, 0xffff, 2);
  Put(data, 0xffff, 2);
  Put(data, 0xffffffff, 4);
  Put(data, 0xffffffff, 4);
  Put(data, 0, 2);
  return data;
}

std::vector<ZipEntry> Entries(const Bytes& zip) {
  std::vector<ZipEntry> result;
  size_t at = 0;
  while (Get(zip, at, 4) == 0x04034b50) {
    size_t name = static_cast<size_t>(Get(zip, at + 26, 2));
    size_t extra = static_cast<size_t>(Get(zip, at + 28, 2));
    size_t size = static_cast<size_t>(Get(zip, at + 30 + name + 4, 8));
    size_t offset = at + 30 + name + extra;
    result.push_back({std::string(zip.begin() + at + 30, zip.begin() + at + 30 + name),
                      Bytes(zip.begin() + offset, zip.begin() + offset + size)});
    at = offset + size;
  }
  return result;
}

struct Bundle {
  std::vector<ZipEntry> objects;
  Json manifest;
  explicit Bundle(const Bytes& zip) {
    for (auto& entry : Entries(zip)) {
      if (entry.name == "manifest.json")
        manifest = Json::parse(entry.bytes);
      else
        objects.push_back(std::move(entry));
    }
  }
  Bytes Build(const std::function<void(Json&)>& change = {}) const {
    auto json = manifest;
    std::map<std::string, size_t> offsets;
    size_t offset = 0;
    for (const auto& object : objects) {
      offsets[object.name] = offset + 50 + object.name.size();
      offset += 50 + object.name.size() + object.bytes.size();
    }
    for (auto& resource : json["resources"])
      resource["storedOffset"] = offsets.at(resource["path"]);
    if (!json["dictionary"].is_null())
      json["dictionary"]["storedOffset"] = offsets.at(json["dictionary"]["path"]);
    if (change)
      change(json);
    auto entries = objects;
    entries.push_back({"manifest.json", Text(json.dump())});
    return Zip(entries);
  }
};

Result<RenderArchive> Open(const Bytes& data) {
  auto source = std::make_shared<const Bytes>(data);
  return RenderArchive::Open(
      [source](uint64_t offset, size_t length) -> Result<Bytes> {
        if (offset > source->size() || length > source->size() - offset)
          return Error{ErrorCode::kRejected, "range outside test source"};
        return Bytes(source->begin() + offset, source->begin() + offset + length);
      },
      data.size());
}

void Reject(const Bytes& zip, ErrorCode code = ErrorCode::kInternal) {
  auto result = Open(zip);
  Check(!result && result.error().code == code, "malformed archive accepted");
}

void ArchiveTests(const fs::path& fixtures) {
  auto bytes = Read(fixtures / "document.zip");
  auto archive = Take(Open(bytes));
  auto info = Take(archive.Info());
  Check(info.pages.size() == 1 && info.pages[0].ordinal == 0 && info.pages[0].width == 400 &&
            info.pages[0].height == 267 && info.pages[0].id == "page:1",
        "incorrect page metadata");
  auto html = Take(archive.Resource(info.pages[0].document));
  Check(html.first == "text/html" &&
            std::string(html.second.begin(), html.second.end()).find("RemoteKit") !=
                std::string::npos,
        "page HTML did not decode");
  Check(Take(archive.Resource(info.shared[0])).first == "text/css", "stylesheet did not decode");
  auto absent = archive.Resource("unknown");
  Check(!absent && absent.error().code == ErrorCode::kNotFound, "unknown resource accepted");

  auto dictionary_bytes = Read(fixtures / "document-dictionary.zip");
  Bundle dictionary_bundle(dictionary_bytes);
  Check(!dictionary_bundle.manifest["dictionary"].is_null(),
        "dictionary fixture has no dictionary");
  auto dictionary_archive = Take(Open(dictionary_bytes));
  Check(Take(dictionary_archive.Info()).pages.size() == 32, "dictionary pages missing");
  for (const auto& object : dictionary_bundle.manifest["resources"])
    Take(dictionary_archive.Resource(object["contentId"]));

  Bundle bundle(bytes);
  Take(Open(bundle.Build()));
  auto repeated = Take(Open(bundle.Build([](Json& m) {
    auto shared = m["document"]["shared"][0];
    m["document"]["items"][0]["dependencies"] = Json::array({shared, shared});
  })));
  Check(Take(repeated.Info()).pages[0].dependencies.size() == 1,
        "a resource drawn twice on a page was not listed once");
  auto central = static_cast<size_t>(Get(bytes, bytes.size() - 42 + 8, 8));
  central = static_cast<size_t>(Get(bytes, central + 48, 8));
  auto bad_method = bytes;
  Set(bad_method, central + 10, 8, 2);
  Reject(bad_method);
  auto local_method = bytes;
  Set(local_method, 8, 8, 2);
  Reject(local_method);
  auto unsafe = bundle.objects;
  unsafe[0].name = "../manifest.json";
  Reject(Zip(unsafe));
  auto duplicate = bundle.objects;
  duplicate.push_back(duplicate.front());
  Reject(Zip(duplicate));
  Reject(bundle.Build([](Json& m) {
    m["resources"][0]["storedOffset"] = m["resources"][0]["storedOffset"].get<uint64_t>() + 1;
  }));
  Reject(bundle.Build([](Json& m) { m["resources"][0]["storedSize"] = 1; }));
  Reject(bundle.Build([](Json& m) { m["resources"][0]["rawSize"] = 67108865; }),
         ErrorCode::kRejected);
  Reject(bundle.Build([](Json& m) { m.erase("format"); }));
  Reject(bundle.Build([](Json& m) { m["unknown"] = true; }));
  Reject(bundle.Build([](Json& m) { m["format"] = 7; }));
  Reject(bundle.Build([](Json& m) { m["format"] = "other"; }));
  Reject(bundle.Build(
      [](Json& m) { m["document"]["items"][0]["dependencies"] = Json::array({"missing"}); }));
  Reject(bundle.Build([](Json& m) {
    auto page = m["document"]["items"][0];
    m["document"]["items"] = Json::array();
    for (size_t i = 0; i < 20001; ++i)
      m["document"]["items"].push_back(page);
  }),
         ErrorCode::kRejected);
  Reject(Zip({{"manifest.json", Bytes(8 * 1024 * 1024 + 1, ' ')}}), ErrorCode::kRejected);
  for (size_t length : {size_t{0}, size_t{21}, bytes.size() - 1})
    Reject(Bytes(bytes.begin(), bytes.begin() + length));
  auto bad_zip64 = bytes;
  Set(bad_zip64, bytes.size() - 34, UINT64_MAX, 8);
  Reject(bad_zip64);
  auto encrypted = bytes;
  Set(encrypted, central + 8, 0x0801, 2);
  Reject(encrypted);
  auto local_name = bytes;
  local_name[30] = 'x';
  Reject(local_name);
  auto hash = bundle;
  auto old = hash.manifest["resources"][0]["contentId"].get<std::string>();
  auto replacement = std::string(64, '0');
  hash.objects[0].name = "objects/" + replacement + ".zst";
  auto json = hash.manifest.dump();
  for (size_t at = 0; (at = json.find(old, at)) != json.npos; at += replacement.size())
    json.replace(at, old.size(), replacement);
  hash.manifest = Json::parse(json);
  auto mismatched = Take(Open(hash.Build()));
  auto resource = mismatched.Resource(replacement);
  Check(!resource && resource.error().message == "document resource hash mismatch",
        "SHA-256 mismatch accepted");
  auto identity = bundle;
  const auto raw = Text("identity resource");
  auto id = Sha256Hex(raw);
  identity.objects.push_back({"objects/" + id, raw});
  identity.manifest["resources"].push_back({{"contentId", id},
                                            {"mime", "image/webp"},
                                            {"encoding", "identity"},
                                            {"rawSize", raw.size()},
                                            {"storedSize", raw.size()},
                                            {"path", "objects/" + id}});
  Check(Take(Take(Open(identity.Build())).Resource(id)).second == raw,
        "identity resource corrupted");
  dictionary_bundle.objects[0].bytes[0] ^= 1;
  Reject(dictionary_bundle.Build());
  auto read_error = RenderArchive::Open(
      [](uint64_t, size_t) -> Result<Bytes> {
        return Error{ErrorCode::kUnavailable, "object range unavailable"};
      },
      bytes.size());
  Check(!read_error && read_error.error().code == ErrorCode::kUnavailable, "range error lost");
}

void TypeTests() {
  const auto ole = Bytes{0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1};
  for (auto extension : {"doc", "dot", "wps", "ppt", "pps", "pot", "dps", "xls", "et"})
    Check(DetectDocument(std::string("file.") + extension, ole).type != DocumentType::kUnsupported,
          "OLE type rejected");
  for (auto extension :
       {"docx", "docm", "dotx", "odt", "pptx", "ppsx", "potx", "odp", "xlsx", "xlsm", "ods"})
    Check(DetectDocument(std::string("file.") + extension, Text("PK\x03\x04")).type !=
              DocumentType::kUnsupported,
          "ZIP Office type rejected");
  Check(DetectDocument("renamed.bin", Text("%PDF-1.7")).type == DocumentType::kPdf,
        "PDF magic ignored");
  Check(DetectDocument("file.DOCX", Text("PK\x03\x04")).extension == ".docx",
        "extension not normalized");
  Check(DetectDocument("file.rtf", Text("{\\rtf1")).extension == ".rtf", "RTF not recognized");
  Check(DetectDocument("file.txt", Text("hello\n中文")).type == DocumentType::kText,
        "UTF-8 text rejected");
  Check(DetectDocument("file.csv", Text("one,two\n1,2")).type == DocumentType::kSpreadsheet,
        "CSV rejected");
  Check(DetectDocument("file.txt", Bytes{0xff, 0xfe, 0x00, 0x4e}).type == DocumentType::kText,
        "UTF-16 text rejected");
  for (auto name : {"file.png", "file.mp3", "file.mp4", "file.zip", "file.exe"})
    Check(DetectDocument(name, Text("PK\x03\x04")).type == DocumentType::kUnsupported,
          "non-document accepted");
  for (const auto& magic : {Text("\x89PNG\r\n"), Text("RIFF1234WEBP"), Text("ID3")}) {
    Check(DetectDocument("renamed.docx", magic).type == DocumentType::kUnsupported,
          "false Office signature accepted");
    Check(DetectDocument("renamed.pdf", magic).type == DocumentType::kUnsupported,
          "false PDF signature accepted");
  }
  Check(DetectDocument("corrupt.docx", Text("corrupt")).type == DocumentType::kWriter,
        "corrupt Office input did not reach converter");
  for (auto name : {"file.wps", "file.et", "file.dps"})
    Check(DetectDocument(name, Text("PK\x03\x04")).type != DocumentType::kUnsupported,
          "ZIP WPS document rejected");
}

void QueueTests() {
  std::mutex mutex;
  std::condition_variable entered;
  std::promise<void> release;
  auto gate = release.get_future().share();
  size_t running = 0;
  std::atomic<size_t> calls = 0;
  RenderQueue queue([&](size_t slot, const std::string& id, const fs::path&,
                        const std::string&) -> Result<RenditionResult> {
    Check(slot < 2, "invalid worker slot");
    ++calls;
    {
      std::lock_guard lock(mutex);
      ++running;
      entered.notify_one();
    }
    gate.wait();
    return RenditionResult{fs::path(id + ".zip"), 7};
  });
  auto first = queue.Submit("first", {}, "test.docx");
  auto duplicate = queue.Submit("first", {}, "different.docx");
  auto second = queue.Submit("second", {}, "test.docx");
  {
    std::unique_lock lock(mutex);
    if (!entered.wait_for(lock, std::chrono::seconds(5), [&] { return running == 2; })) {
      release.set_value();
      throw std::runtime_error("two workers did not start");
    }
  }
  std::vector<RenderQueue::Future> pending;
  for (size_t i = 0; i < 64; ++i)
    pending.push_back(queue.Submit("queued-" + std::to_string(i), {}, "test.pdf"));
  auto overflow = queue.Submit("overflow", {}, "test.pdf").get();
  auto duplicate_when_full = queue.Submit("first", {}, "test.pdf");
  auto missing_id = queue.Submit("", {}, "test.pdf").get();
  auto active_calls = calls.load();
  release.set_value();
  Check(!overflow && overflow.error().code == ErrorCode::kBusy, "queue bound ignored");
  Check(!missing_id && missing_id.error().code == ErrorCode::kInvalidRequest, "empty ID accepted");
  Check(active_calls == 2, "more than two jobs started");
  Check(Take(first.get()).archive == Take(duplicate.get()).archive &&
            Take(first.get()).archive == Take(duplicate_when_full.get()).archive,
        "duplicate result not shared");
  Take(second.get());
  for (auto& future : pending)
    Take(future.get());
  Check(calls == 66, "duplicate rendition executed");

  RenderQueue failing([](size_t, const std::string&, const fs::path&,
                         const std::string&) -> Result<RenditionResult> {
    throw std::runtime_error("worker failure");
  });
  auto failure = failing.Render("exception", {}, "test.pdf");
  Check(!failure && failure.error().code == ErrorCode::kInternal, "worker exception escaped");
}

void ProcessTests(const fs::path& output) {
  TemporaryDirectory directory(output);
  std::wstring self(32768, L'\0');
  self.resize(GetModuleFileNameW(nullptr, self.data(), static_cast<DWORD>(self.size())));
  Success(RunTool(self, {L"--probe", L"space \"quote\" \\ end\\"}, directory.path(),
                  {{L"RK_DOCUMENT_TEST", L"present"}}));
  auto timed = RunTool(self, {L"--sleep"}, directory.path(), {}, std::chrono::milliseconds(80));
  Check(!timed && timed.error().code == ErrorCode::kRejected &&
            timed.error().reason == remotekit::ErrorReason::kDocumentTooComplex,
        "tool timeout not enforced");
  auto crashed = RunTool(self, {L"--crash-probe"}, directory.path());
  Check(!crashed && crashed.error().code == ErrorCode::kRejected &&
            crashed.error().reason == remotekit::ErrorReason::kDocumentCorrupt,
        "tool crash lost content classification");
  auto missing = RunTool(directory.path() / "missing.exe", {}, directory.path());
  Check(!missing && missing.error().code == ErrorCode::kUnavailable, "missing tool accepted");
  FILE* capture = nullptr;
  Check(_wfopen_s(&capture, (directory.path() / "failure.log").c_str(), L"wb") == 0,
        "cannot capture failure log");
  fflush(stderr);
  const int saved_stderr = _dup(_fileno(stderr));
  Check(saved_stderr >= 0 && _dup2(_fileno(capture), _fileno(stderr)) == 0,
        "cannot redirect failure log");
  auto failure = RunTool(self, {L"--failure-probe"}, directory.path());
  fflush(stderr);
  _dup2(saved_stderr, _fileno(stderr));
  _close(saved_stderr);
  fclose(capture);
  Check(!failure && failure.error().code == ErrorCode::kRejected, "tool failure accepted");
  auto log_bytes = Read(directory.path() / "failure.log");
  const std::string log(log_bytes.begin(), log_bytes.end());
  const auto record = nlohmann::json::parse(log);
  Check(record.at("ev") == "document.tool_failed" &&
            record.at("tool") == "endpoint_documents_tests.exe" && record.at("exitCode") == "37" &&
            record.at("stderrTail").get<std::string>().find("Error: final diagnostic") != log.npos,
        "tool failure lacks exit code or stderr tail");
  for (auto secret : {"private-source.docx", "private document text", "stdout secret", "early"})
    Check(log.find(secret) == log.npos, "tool failure leaks private output or reads log head");
  Check(FileUrl(directory.path() / L"中文 #%.docx").find(L"%23%25") != std::wstring::npos,
        "profile URL not escaped");
}

Bytes Docx() {
  return Zip(
      {{"[Content_Types].xml",
        Text(
            R"(<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>)")},
       {"_rels/.rels",
        Text(
            R"(<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>)")},
       {"word/document.xml",
        Text(
            R"(<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>RemoteKit 文档预览</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>)")}});
}

Bytes Pptx() {
  return Zip(
      {{"[Content_Types].xml",
        Text(
            R"(<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>)")},
       {"_rels/.rels",
        Text(
            R"(<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>)")},
       {"ppt/presentation.xml",
        Text(
            R"(<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>)")},
       {"ppt/_rels/presentation.xml.rels",
        Text(
            R"(<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>)")},
       {"ppt/slides/slide1.xml", Text(
                                     R"(<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="7315200" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="2800"/><a:t>RemoteKit 幻灯片预览</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>)")}});
}

void ObjectTypeTests(const fs::path& output) {
  TemporaryDirectory directory(output);
  const auto source = directory.path() / "object-without-extension";
  Write(source, Docx());
  Check(Take(DetectDocumentFile(source, std::string_view{})).extension == ".docx",
        "object DOCX detection");
  Write(source, Pptx());
  Check(Take(DetectDocumentFile(source, std::string_view{})).extension == ".pptx",
        "object PPTX detection");
  Write(source, Text("%PDF-1.7\n"));
  Check(Take(DetectDocumentFile(source, std::string_view{})).type == DocumentType::kPdf,
        "object PDF detection");
  Write(source, Text("MZunsupported"));
  Check(Take(DetectDocumentFile(source, std::string_view{})).type == DocumentType::kUnsupported,
        "binary object accepted as document");
  Write(source, Text("plain text\n"));
  Check(Take(DetectDocumentFile(source, std::string_view{})).type == DocumentType::kText,
        "object text detection");
  auto corrupt = Docx();
  corrupt.resize(corrupt.size() - 50);
  Write(source, corrupt);
  Check(Take(DetectDocumentFile(source, std::string_view{})).type == DocumentType::kUnsupported,
        "truncated object ZIP accepted");
  auto truncated = Docx();
  truncated.resize(100);
  Write(source, truncated);
  for (const auto mime :
       {"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/vnd.oasis.opendocument.text", "application/pdf", "application/msword",
        "application/vnd.ms-powerpoint"}) {
    auto detected = DetectDocumentFile(source, mime);
    Check(!detected && detected.error().code == ErrorCode::kRejected &&
              detected.error().reason == ErrorReason::kDocumentCorrupt,
          "declared truncated document not corrupt");
  }
  Check(Take(DetectDocumentFile(source, "application/octet-stream")).type ==
            DocumentType::kUnsupported,
        "octet-stream truncated ZIP not unsupported");
  auto named = DetectDocumentFile(source, DetectDocument("truncated.DOCX", {}));
  Check(!named && named.error().reason == ErrorReason::kDocumentCorrupt,
        "render queue name hint lost");
  Write(source, Bytes{0x00, 0x01, 0x02, 0xff});
  Check(Take(DetectDocumentFile(source, "application/octet-stream")).type ==
            DocumentType::kUnsupported,
        "random binary accepted");
  Write(source, Docx());
  Check(Take(DetectDocumentFile(source, "application/octet-stream")).extension == ".docx",
        "content sniff did not win over unknown declaration");
  Check(Take(DetectDocumentFile(source, "application/pdf")).extension == ".docx",
        "content sniff did not win over conflicting declaration");
}

void ValidateRendition(const RenditionResult& result) {
  Check(result.size == fs::file_size(result.archive) && result.size > 0,
        "archive result size incorrect");
  auto archive = Take(RenderArchive::OpenFile(result.archive));
  auto info = Take(archive.Info());
  Check(!info.pages.empty(), "rendition has no pages");
  bool chinese = false;
  for (const auto& page : info.pages) {
    auto html = Take(archive.Resource(page.document));
    Check(html.first == "text/html", "rendition HTML missing");
    chinese |= std::string(html.second.begin(), html.second.end()).find("预") != std::string::npos;
    for (const auto& dependency : page.dependencies)
      Take(archive.Resource(dependency));
  }
  Check(chinese, "Chinese text missing from rendition");
}

int Integration(const fs::path& output, const fs::path& tools) {
  if (!fs::is_regular_file(tools / "libreoffice/program/soffice.com") ||
      !fs::is_regular_file(tools / "pdfrender/pdfrender.exe")) {
    std::cout << "SKIP: document tools absent\n";
    return 77;
  }
  TemporaryDirectory directory(output);
  auto docx = directory.path() / L"中文 odd # name.docx";
  auto pptx = directory.path() / L"幻灯片.pptx";
  Write(docx, Docx());
  Write(pptx, Pptx());
  const auto fixtures = fs::path(__FILE__).parent_path() / "fixtures";
  auto rich_docx = directory.path() / L"课程 表格 图片.docx";
  auto saved_docx = directory.path() / "libreoffice.docx";
  fs::copy_file(fixtures / "document.docx", rich_docx);
  fs::copy_file(fixtures / "document-libreoffice.docx", saved_docx);
  for (const auto& source : {rich_docx, saved_docx})
    Check(Take(DetectDocumentFile(source, std::string_view{})).extension == ".docx",
          "committed DOCX detection");
  OfficeConverter converter(directory.path(), tools);
  PdfRenderer renderer(tools);
  for (const auto& [source, type] :
       std::vector<std::pair<fs::path, DocumentType>>{{docx, DocumentType::kWriter},
                                                      {rich_docx, DocumentType::kWriter},
                                                      {saved_docx, DocumentType::kWriter},
                                                      {pptx, DocumentType::kPresentation},
                                                      {docx, DocumentType::kWriter}}) {
    TemporaryDirectory job(directory.path());
    auto pdf = job.path() / "input.pdf";
    auto zip = job.path() / "render.zip";
    auto start = std::chrono::steady_clock::now();
    Success(converter.Convert(source, {type, source.extension().string()},
                              type == DocumentType::kWriter ? 0 : 1, pdf));
    auto converted = std::chrono::steady_clock::now();
    Success(renderer.Render(pdf, zip));
    auto rendered = std::chrono::steady_clock::now();
    ValidateRendition({zip, fs::file_size(zip)});
    if (source == rich_docx) {
      fs::copy_file(pdf, output / "document.pdf", fs::copy_options::overwrite_existing);
      fs::copy_file(zip, output / "document-render.zip", fs::copy_options::overwrite_existing);
    }
    const auto pages = Take(Take(RenderArchive::OpenFile(zip)).Info()).pages.size();
    std::cout << source.extension().string() << " conversion_ms="
              << std::chrono::duration_cast<std::chrono::milliseconds>(converted - start).count()
              << " render_ms="
              << std::chrono::duration_cast<std::chrono::milliseconds>(rendered - converted).count()
              << " pages=" << pages << '\n';
    RenderQueue queue(directory.path(), tools);
    auto pdf_result = Take(queue.Render("pdf-bypass", pdf, "source.pdf"));
    ValidateRendition(pdf_result);
  }
  Check(fs::exists(directory.path() / "documents/profiles/slot-0/user") &&
            fs::exists(directory.path() / "documents/profiles/slot-1/user"),
        "warm worker profiles missing");
  RenderQueue queue(directory.path(), tools);
  auto first = queue.Submit("same-source", docx, "document.docx");
  auto second = queue.Submit("same-source", docx, "document.docx");
  auto slide = queue.Submit("slides", pptx, "presentation.pptx");
  auto result = Take(first.get());
  Check(result.archive == Take(second.get()).archive, "real conversion duplicate not shared");
  ValidateRendition(result);
  ValidateRendition(Take(slide.get()));
  auto invalid = directory.path() / "corrupt.pdf";
  Write(invalid, Text("%PDF-1.7 corrupt"));
  auto rejected = queue.Render("corrupt", invalid, "corrupt.pdf");
  Check(!rejected && rejected.error().code == ErrorCode::kRejected, "corrupt PDF accepted");
  Write(invalid, Text("PK\x03\x04 corrupt"));
  auto corrupt_office = queue.Render("corrupt-office", invalid, "corrupt.docx");
  Check(!corrupt_office && corrupt_office.error().code == ErrorCode::kRejected &&
            corrupt_office.error().reason == ErrorReason::kDocumentCorrupt,
        "corrupt Office input accepted");
  TemporaryDirectory encrypted(directory.path());
  auto source = encrypted.path() / "input.docx";
  fs::copy_file(docx, source);
  Success(RunTool(
      tools / "libreoffice/program/soffice.com",
      {L"-env:UserInstallation=" + FileUrl(directory.path() / "documents/profiles/slot-0"),
       L"--headless", L"--norestore", L"--nolockcheck", L"--nodefault", L"--nologo",
       L"--convert-to",
       LR"(pdf:writer_pdf_Export:{"EncryptFile":{"type":"boolean","value":"true"},"DocumentOpenPassword":{"type":"string","value":"fixture-password"}})",
       L"--outdir", encrypted.path().wstring(), source.wstring()},
      encrypted.path()));
  Check(fs::is_regular_file(encrypted.path() / "input.pdf"), "encrypted PDF generation failed");
  auto password = queue.Render("password-protected", encrypted.path() / "input.pdf", "secret.pdf");
  Check(!password && password.error().code == ErrorCode::kRejected &&
            password.error().message == "password-protected document",
        "password protection not reported");
  auto broken_entries = Entries(Docx());
  for (auto& entry : broken_entries)
    if (entry.name == "word/document.xml")
      entry.bytes = Text("<w:document><broken");
  auto broken = directory.path() / "broken.docx";
  Write(broken, Zip(broken_entries));
  auto broken_result = queue.Render("broken-xml", broken, "broken.docx");
  Check(!broken_result && broken_result.error().code == ErrorCode::kRejected &&
            broken_result.error().reason == ErrorReason::kDocumentCorrupt,
        "corrupt XML in valid DOCX ZIP not corrupt");
  std::cout << "corrupt-xml.docx: rejected/document_corrupt\n";
  auto truncated = Read(rich_docx);
  truncated.resize(100);
  Write(broken, truncated);
  auto truncated_result = queue.Render("truncated-docx", broken, "truncated.docx");
  Check(!truncated_result && truncated_result.error().reason == ErrorReason::kDocumentCorrupt,
        "truncated DOCX not corrupt");
  std::cout << "truncated-100-bytes.docx: rejected/document_corrupt\n";
  auto renamed = Take(queue.Render("renamed-docx", rich_docx, "renamed.bin"));
  ValidateRendition(renamed);
  std::cout << "valid-docx-renamed.bin: DOCX/ready\n";
  Write(broken, Bytes{0x00, 0x01, 0x02, 0xff});
  auto unsupported = queue.Render("binary", broken, "random.bin");
  Check(!unsupported && unsupported.error().code == ErrorCode::kRejected &&
            unsupported.error().reason == ErrorReason::kDocumentUnsupported,
        "unsupported input accepted");
  std::cout << "random.bin: rejected/document_unsupported\n";
  RenderQueue absent(directory.path(), directory.path() / "missing-tools");
  auto unavailable = absent.Render("missing-tool", docx, "test.docx");
  Check(!unavailable && unavailable.error().code == ErrorCode::kUnavailable,
        "missing converter not unavailable");
  return 0;
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc >= 2 && std::wstring_view(argv[1]) == L"--failure-probe") {
    std::cout << "stdout secret\n";
    std::cerr << "Error: early\n" << std::string(70000, 'x') << '\n';
    for (int i = 0; i < 8; ++i)
      std::cerr << "Error: private value 'private document text' at "
                   "\"C:\\private\\private-source.docx\"\n";
    std::cerr << "private document text\nError: final diagnostic\n";
    return 37;
  }
  if (argc >= 2 && std::wstring_view(argv[1]) == L"--sleep") {
    Sleep(10000);
    return 0;
  }
  if (argc >= 2 && std::wstring_view(argv[1]) == L"--probe") {
    wchar_t value[32]{};
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    JOBOBJECT_BASIC_UI_RESTRICTIONS ui{};
    DWORD bytes = 1;
    char input = 0;
    if (!QueryInformationJobObject(nullptr, JobObjectExtendedLimitInformation, &limits,
                                   sizeof(limits), nullptr) ||
        !QueryInformationJobObject(nullptr, JobObjectBasicUIRestrictions, &ui, sizeof(ui),
                                   nullptr) ||
        limits.JobMemoryLimit != 2ULL * 1024 * 1024 * 1024 ||
        !(limits.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) ||
        ui.UIRestrictionsClass != 0xff ||
        !ReadFile(GetStdHandle(STD_INPUT_HANDLE), &input, 1, &bytes, nullptr) || bytes != 0)
      return 5;
    return argc == 3 && std::wstring_view(argv[2]) == L"space \"quote\" \\ end\\" &&
                   GetEnvironmentVariableW(L"RK_DOCUMENT_TEST", value, 32) &&
                   std::wstring_view(value) == L"present"
               ? 0
               : 4;
  }
  if (argc == 2 && std::wstring_view(argv[1]) == L"--crash-probe") {
    TerminateProcess(GetCurrentProcess(), EXCEPTION_ACCESS_VIOLATION);
    return 1;
  }
  try {
    if (argc == 4 && std::wstring_view(argv[1]) == L"--integration")
      return Integration(fs::absolute(argv[2]), fs::absolute(argv[3]));
    Check(argc == 3, "usage: document_tests fixtures output");
    fs::create_directories(argv[2]);
    ArchiveTests(argv[1]);
    TypeTests();
    ObjectTypeTests(fs::absolute(argv[2]));
    QueueTests();
    ProcessTests(fs::absolute(argv[2]));
    std::cout << "document archive, detection, queue and process checks complete\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
