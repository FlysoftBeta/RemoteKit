#include <iostream>
#include <map>
#include "release/asset.hpp"
#include "release/codec.hpp"
#include "release/http.hpp"
#include "release/planner.hpp"
#include "release_fixtures.hpp"
using namespace remotekit;
using namespace remotekit::release;
using namespace release_test;
namespace {
std::string Id(char c) {
  return std::string(64, c);
}
Asset TestAsset(char salt, uint64_t size) {
  Asset asset{Id(salt), size, {}};
  for (uint64_t left = size; left;) {
    uint64_t n = std::min(left, kChunkSize);
    asset.slices.push_back({"https://example.test/slice", n + 16});
    left -= n;
  }
  return asset;
}
Manifest TestManifest(char id, uint64_t full = 0) {
  Manifest manifest{2, Id(id), "2026-11-09T12:00:00Z", {1024, Id('0')}, {}, {}};
  if (full)
    manifest.full = TestAsset('1', full);
  return manifest;
}
void Crypto() {
  Bytes salt, info;
  for (uint8_t i = 0; i < 13; ++i)
    salt.push_back(i);
  for (uint8_t i = 0xf0; i < 0xfa; ++i)
    info.push_back(i);
  auto derived =
      Hkdf(salt, Bytes(22, 0x0b), {reinterpret_cast<const char*>(info.data()), info.size()});
  Check(cluster::Hex(derived) == "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf",
        "RFC 5869 case 1");
  Key key = RandomKey(), wrong = RandomKey();
  auto manifest = TestManifest('a', 17);
  auto encrypted = EncryptManifest(manifest, key);
  Check(ToJson(DecryptManifest(encrypted, key)) == ToJson(manifest), "manifest round trip");
  Reject([&] { DecryptManifest(encrypted, wrong); }, "wrong manifest key accepted");
  encrypted[40] ^= 1;
  Reject([&] { DecryptManifest(encrypted, key); }, "tampered manifest accepted");
  manifest.format = 1;
  encrypted = EncryptManifest(manifest, key);
  Check(DecryptManifest(encrypted, key).format == 1, "format 1 round trip");
  manifest.patch = Patch{Id('b'), "https://example.test/previous", TestAsset('3', 10)};
  Reject([&] { EncryptManifest(manifest, key); }, "format 1 patch written");
  auto asset = TestAsset('2', kChunkSize + 3);
  Bytes plaintext(static_cast<size_t>(kChunkSize), 0x51);
  auto cipher = EncryptSlice(key, asset, 0, plaintext);
  Check(cipher.size() == 33554432 && DecryptSlice(key, asset, 0, cipher) == plaintext,
        "slice round trip");
  Reject([&] { DecryptSlice(key, asset, 1, cipher); }, "wrong slice index accepted");
  Reject([&] { DecryptSlice(wrong, asset, 0, cipher); }, "wrong slice key accepted");
  cipher[0] ^= 1;
  Reject([&] { DecryptSlice(key, asset, 0, cipher); }, "tampered slice accepted");
}
void Validation() {
  auto manifest = TestManifest('a', 17);
  auto valid = ToJson(manifest);
  Check(ParseManifest(valid.dump()).build_id == Id('a'), "valid manifest rejected");
  auto invalid = [&](Json value) {
    Reject([&] { ParseManifest(value.dump()); }, "invalid manifest accepted");
  };
  auto json = valid;
  json["format"] = 3u;
  invalid(json);
  json = valid;
  json["extra"] = true;
  invalid(json);
  json = valid;
  json["full"]["slices"][0]["size"] = 17u;
  invalid(json);
  json = valid;
  json["full"]["size"] = kChunkSize + 1;
  invalid(json);
  json = valid;
  json.erase("full");
  invalid(json);
  json = valid;
  json["buildId"] = Id('A');
  invalid(json);
  json = valid;
  json["payload"]["extra"] = 0;
  invalid(json);
  json = valid;
  json["full"]["slices"][0]["url"] = "https://user:password@example.test/file";
  invalid(json);
  json = valid;
  json["published"] = "2026-02-31T12:00:00Z";
  invalid(json);
  auto text = valid.dump();
  text.insert(1, "\"format\":1,");
  Reject([&] { ParseManifest(text); }, "duplicate JSON key accepted");
  for (auto url : {"file:///tmp/test", "https://user@example.test/",
                   "http://example.test/#fragment", "http://example.test/\\escape"})
    Check(!ValidUrl(url), "unsafe URL accepted");
}
void Planning() {
  std::map<std::string, Manifest> manifests;
  std::vector<std::string> fetched;
  auto fetch = [&](const std::string& url) {
    fetched.push_back(url);
    if (!manifests.contains(url))
      Fail(ErrorCode::kNotFound, "missing fixture manifest");
    return manifests.at(url);
  };
  auto latest = TestManifest('d', 100);
  latest.patch = Patch{Id('c'), "c", TestAsset('3', 10)};
  auto previous = TestManifest('c', 50);
  previous.patch = Patch{Id('b'), "b", TestAsset('4', 10)};
  auto oldest = TestManifest('b', 40);
  oldest.patch = Patch{Id('a'), "a", TestAsset('5', 10)};
  manifests = {{"latest", latest}, {"c", previous}, {"b", oldest}};
  auto plan = MakePlan("latest", {Id('c'), true, {}}, fetch);
  Check(plan.cost == 10 && plan.steps.size() == 1 && !plan.steps[0].full, "direct patch plan");
  plan = MakePlan("latest", {Id('a'), true, {}}, fetch);
  Check(
      plan.cost == 30 && plan.steps.size() == 3 && plan.steps.front().manifest.build_id == Id('b'),
      "chained patch plan");
  manifests["c"].format = 1;
  fetched.clear();
  plan = MakePlan("latest", {Id('a'), true, {}}, fetch);
  Check(plan.cost == 60 && plan.steps.size() == 2 && plan.steps.front().full &&
            plan.steps.front().manifest.format == 1 && fetched.size() == 2,
        "format 2 to format 1 full candidate and chain boundary");
  manifests["latest"].format = 1;
  fetched.clear();
  plan = MakePlan("latest", {Id('c'), true, {}}, fetch);
  Check(
      plan.cost == 100 && plan.steps.size() == 1 && plan.steps.front().full && fetched.size() == 1,
      "format 1 patch ignored");
  plan = MakePlan("latest", {Id('d'), true, {}}, fetch);
  Check(plan.steps.empty() && plan.cost == 0, "latest format 1 current build no-op");
  auto legacy = ToJson(latest);
  legacy["format"] = 1u;
  legacy["patch"]["manifest"] = "https://example.test/c";
  Check(ParseManifest(legacy.dump()).patch.has_value(), "format 1 patch strict decode");
  manifests["latest"] = latest;
  manifests["c"] = previous;
  manifests.erase("b");
  plan = MakePlan("latest", {Id('a'), true, {}}, fetch);
  Check(plan.cost == 60 && plan.steps.size() == 2 && plan.steps.front().full,
        "broken chain full fallback");
  manifests["c"].full = TestAsset('6', 5);
  fetched.clear();
  plan = MakePlan("latest", {Id('a'), true, {}}, fetch);
  Check(plan.cost == 15 && fetched.size() == 2, "cost cutoff prefers full");
  plan = MakePlan("latest", {Id('c'), true, {Id('3')}}, fetch);
  Check(plan.steps.size() == 1 && plan.steps.front().full, "excluded patch replans to full");
  plan = MakePlan("latest", {Id('c'), false, {}}, fetch);
  Check(plan.steps.front().full, "unusable base uses full");
  manifests["latest"].full.reset();
  manifests["latest"].patch.reset();
  try {
    MakePlan("latest", {}, fetch);
    throw std::runtime_error("missing path accepted");
  } catch (const Failure& failure) {
    Check(failure.error.code == ErrorCode::kNotFound, "no path error code");
  }
  manifests["latest"] = latest;
  manifests["latest"].full.reset();
  try {
    MakePlan("latest", {}, [&](const std::string& url) -> Manifest {
      if (url == "latest")
        return manifests["latest"];
      Fail(ErrorCode::kUnavailable, "fixture outage");
      return {};
    });
    throw std::runtime_error("outage swallowed");
  } catch (const Failure& failure) {
    Check(failure.error.code == ErrorCode::kUnavailable, "outage propagation");
  }
  unsigned count = 0;
  plan = MakePlan("walk", {}, [&](const std::string&) {
    auto manifest = TestManifest('a', count == 0 ? 1000 : 0);
    char build[65];
    snprintf(build, sizeof(build), "%064x", count++);
    manifest.build_id = build;
    snprintf(build, sizeof(build), "%064x", count);
    manifest.patch = Patch{build, "walk", TestAsset('2', 1)};
    return manifest;
  });
  Check(count == 64 && plan.steps.front().full, "manifest walk limit");
}
void Patches(const fs::path& root) {
  Bytes base(1024 * 1024);
  uint32_t random = 1;
  for (auto& byte : base) {
    random = random * 1664525 + 1013904223;
    byte = static_cast<uint8_t>(random >> 24);
  }
  Write(root / L"base", base);
  auto target = base;
  std::fill(target.begin() + 200, target.begin() + 250, 7);
  Write(root / L"target", target);
  Payload payload{target.size(), HashFile(root / L"target")};
  Diff(root / L"target", root / L"patch", root / L"base");
  auto patch = Read(root / L"patch");
  Check(patch.size() < target.size() / 10, "HDiffPatch did not reuse base");
  auto input = [&](const Consume& consume) {
    for (size_t i = 0; i < patch.size(); i += 7)
      consume(std::span(patch).subspan(i, std::min<size_t>(7, patch.size() - i)));
  };
  Decode(input, root / L"decoded", payload, root / L"base", root / L"temporary.hdiff");
  Check(HashFile(root / L"decoded") == payload.sha256, "single-stream patch round trip");
  Check(!fs::exists(root / L"temporary.hdiff"), "applied diff left on disk");
  auto rejected = [&](const Produce& producer) {
    try {
      Decode(producer, root / L"decoded", payload, root / L"base", root / L"temporary.hdiff");
      throw std::runtime_error("corrupt diff accepted");
    } catch (const Failure& failure) {
      Check(failure.error.code == ErrorCode::kRejected, "corrupt diff rejection code");
    }
  };
  auto corrupt = patch;
  patch[0] ^= 1;
  rejected(input);
  Check(!fs::exists(root / L"temporary.hdiff"), "rejected diff left on disk");
  patch = std::move(corrupt);
  patch.push_back(0);
  Reject(
      [&] { Decode(input, root / L"decoded", payload, root / L"base", root / L"temporary.hdiff"); },
      "trailing patch input accepted");
  patch.pop_back();
  patch.pop_back();
  Reject(
      [&] { Decode(input, root / L"decoded", payload, root / L"base", root / L"temporary.hdiff"); },
      "truncated patch accepted");
  Compress(root / L"target", root / L"full", 1, 2);
  auto full = Read(root / L"full");
  Payload doubled{payload.size * 2, {}};
  Decode(
      [&](const Consume& consume) {
        consume(full);
        consume(full);
      },
      root / L"decoded", doubled, {}, {});
  Check(Read(root / L"decoded").size() == doubled.size, "full concatenated zstd frames");
}
}  // namespace
int wmain(int argc, wchar_t** argv) {
  if (argc != 2)
    return 2;
  auto root = fs::path(argv[1]) / (L"release-format-" + std::to_wstring(GetCurrentProcessId()));
  try {
    fs::create_directories(root);
    Crypto();
    Validation();
    Planning();
    Patches(root);
    fs::remove_all(root);
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
