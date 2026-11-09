#include "manifest.hpp"
#include "http.hpp"
#include <chrono>

namespace remotekit::release {
namespace {
std::string Url(const Json& json) {
  Require(json.is_string() && ValidUrl(json.get_ref<const std::string&>()),
          "expected absolute HTTP URL without credentials");
  return json.get<std::string>();
}
Asset ParseAsset(const Json& json) {
  Keys(json, {"salt", "size", "slices"});
  Asset asset{HexString(json["salt"]), Unsigned(json["size"]), {}};
  Require(asset.size > 0, "asset must not be empty");
  uint64_t count = 1 + (asset.size - 1) / kChunkSize;
  Require(count <= UINT32_MAX && json["slices"].is_array() && json["slices"].size() == count,
          "invalid asset slice count");
  uint64_t remaining = asset.size;
  for (auto& slice : json["slices"]) {
    Keys(slice, {"url", "size"});
    uint64_t size = std::min(kChunkSize, remaining);
    Require(Unsigned(slice["size"]) == size + 16, "invalid asset slice size");
    asset.slices.push_back({Url(slice["url"]), size + 16});
    remaining -= size;
  }
  return asset;
}
Json AssetJson(const Asset& asset) {
  Json slices = Json::array();
  for (auto& slice : asset.slices)
    slices.push_back({{"url", slice.url}, {"size", slice.size}});
  return {{"salt", asset.salt}, {"size", asset.size}, {"slices", slices}};
}
void Published(const std::string& value) {
  Require(value.size() == 20 && value[4] == '-' && value[7] == '-' && value[10] == 'T' &&
              value[13] == ':' && value[16] == ':' && value[19] == 'Z',
          "invalid published timestamp");
  for (size_t i = 0; i < value.size(); ++i)
    if (i != 4 && i != 7 && i != 10 && i != 13 && i != 16 && i != 19)
      Require(value[i] >= '0' && value[i] <= '9', "invalid published timestamp");
  auto number = [&](size_t start, size_t count) { return std::stoi(value.substr(start, count)); };
  using namespace std::chrono;
  Require(year_month_day(year(number(0, 4)), month(number(5, 2)), day(number(8, 2))).ok() &&
              number(11, 2) < 24 && number(14, 2) < 60 && number(17, 2) < 60,
          "invalid published timestamp");
}
}  // namespace
Manifest ParseManifest(std::string_view text) {
  auto json = ParseJson(text);
  Keys(json, {"format", "buildId", "published", "payload"}, {"patch", "full"});
  Require(Unsigned(json["format"]) == 1, "unsupported release format");
  Require(json["published"].is_string(), "invalid published timestamp");
  Manifest manifest;
  manifest.build_id = HexString(json["buildId"]);
  manifest.published = json["published"].get<std::string>();
  Published(manifest.published);
  Keys(json["payload"], {"size", "sha256"});
  manifest.payload = {Unsigned(json["payload"]["size"]), HexString(json["payload"]["sha256"])};
  Require(manifest.payload.size > 0 && manifest.payload.size <= INT64_MAX, "invalid payload size");
  if (json.contains("patch")) {
    auto& patch = json["patch"];
    Keys(patch, {"from", "manifest", "asset"});
    manifest.patch =
        Patch{HexString(patch["from"]), Url(patch["manifest"]), ParseAsset(patch["asset"])};
    Require(manifest.patch->from != manifest.build_id, "patch refers to itself");
  }
  if (json.contains("full"))
    manifest.full = ParseAsset(json["full"]);
  Require(manifest.patch.has_value() || manifest.full.has_value(), "release has no asset");
  return manifest;
}
Json ToJson(const Manifest& manifest) {
  Json json{{"format", 1u},
            {"buildId", manifest.build_id},
            {"published", manifest.published},
            {"payload", {{"size", manifest.payload.size}, {"sha256", manifest.payload.sha256}}}};
  if (manifest.patch)
    json["patch"] = {{"from", manifest.patch->from},
                     {"manifest", manifest.patch->manifest},
                     {"asset", AssetJson(manifest.patch->asset)}};
  if (manifest.full)
    json["full"] = AssetJson(*manifest.full);
  return json;
}
Bytes EncryptManifest(const Manifest& manifest, const Key& key) {
  auto text = ToJson(manifest).dump();
  ParseManifest(text);
  Require(text.size() <= 1024 * 1024 - 53, "release manifest too large");
  auto salt = RandomKey();
  Bytes out{'R', 'K', 'R', 'M', 1};
  out.insert(out.end(), salt.begin(), salt.end());
  auto derived = Hkdf(salt, key, "remotekit release manifest v1");
  std::array<uint8_t, 12> nonce{};
  auto cipher =
      Seal(derived, nonce, out, {reinterpret_cast<const uint8_t*>(text.data()), text.size()});
  SecureZeroMemory(derived.data(), derived.size());
  out.insert(out.end(), cipher.begin(), cipher.end());
  return out;
}
Manifest DecryptManifest(std::span<const uint8_t> envelope, const Key& key) {
  Require(
      envelope.size() >= 53 && envelope.size() <= 1024 * 1024 &&
          std::equal(envelope.begin(), envelope.begin() + 5, Bytes{'R', 'K', 'R', 'M', 1}.begin()),
      "invalid release manifest envelope");
  auto derived = Hkdf(envelope.subspan(5, 32), key, "remotekit release manifest v1");
  std::array<uint8_t, 12> nonce{};
  auto text = Open(derived, nonce, envelope.first(37), envelope.subspan(37));
  SecureZeroMemory(derived.data(), derived.size());
  auto manifest = ParseManifest({reinterpret_cast<const char*>(text.data()), text.size()});
  SecureZeroMemory(text.data(), text.size());
  return manifest;
}
}  // namespace remotekit::release
