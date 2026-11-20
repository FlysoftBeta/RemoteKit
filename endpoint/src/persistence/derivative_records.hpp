#pragma once
#include "persistence/strict_json.hpp"
#include "persistence/sqlite.hpp"
#include <set>

namespace remotekit {
struct DerivativeKey {
  std::string source, kind, parameters;
  bool operator==(const DerivativeKey&) const = default;
};
struct DerivativeRecord {
  std::string asset_id;
  Json metadata = Json::object();
};
namespace derivative_records {
inline constexpr unsigned kPhotoAlgorithmVersion = 1;
inline bool ObjectId(std::string_view id) {
  return id.size() == 64 && id.find_first_not_of("0123456789abcdef") == std::string_view::npos;
}
inline void Key(const DerivativeKey& key) {
  using persisted::Require;
  Require(ObjectId(key.source), "invalid derivative source ID");
  if (key.kind == "selection-transcode") {
    Require(key.parameters == "jpeg" || key.parameters == "png", "invalid selection transcode key");
  } else if (key.kind == "thumbnail") {
    Require(key.parameters == "320-v1:jpeg", "invalid thumbnail key");
  } else if (key.kind == "preview") {
    Require(key.parameters == "1280-q80-v1:webp" || key.parameters == "2560-q80-v1:webp",
            "invalid preview key");
  } else if (key.kind == "photo") {
    bool valid = false;
    for (const auto mode : {"photo", "scan"})
      for (const auto turns : {"auto", "0", "1", "2", "3"})
        valid |= key.parameters == std::string(mode) + "-" + turns + "-v" +
                                       std::to_string(kPhotoAlgorithmVersion) + ":webp";
    Require(valid, "invalid photo processing key");
  } else {
    Require(false, "invalid derivative kind");
  }
}
inline void Record(const DerivativeKey& key, const DerivativeRecord& record) {
  using namespace persisted;
  Key(key);
  Require(ObjectId(record.asset_id), "invalid derivative asset ID");
  const auto& metadata = record.metadata;
  if (key.kind != "photo") {
    Keys(metadata, {});
    return;
  }
  Keys(metadata, {"geometry", "quarterTurns", "orientation"});
  Unsigned(metadata.at("quarterTurns"), 0, 3);
  const auto& geometry = metadata.at("geometry");
  Keys(geometry, {"kind", "cropped"});
  Enum(geometry.at("kind"), {"unchanged", "deskew", "perspective"});
  Boolean(geometry.at("cropped"));
  const auto& orientation = metadata.at("orientation");
  Keys(orientation, {"turns", "state"});
  Unsigned(orientation.at("turns"), 0, 3);
  Enum(orientation.at("state"), {"none", "uncertain", "confident"});
  Require(orientation.at("turns") == metadata.at("quarterTurns"), "inconsistent photo turns");
}
inline Json DecodeMetadata(const std::string& bytes) {
  persisted::Require(bytes.size() <= 4096, "derivative metadata too large");
  std::vector<std::set<std::string>> objects;
  bool duplicate = false;
  const auto callback = [&](int, Json::parse_event_t event, Json& value) {
    if (event == Json::parse_event_t::object_start)
      objects.emplace_back();
    else if (event == Json::parse_event_t::object_end)
      objects.pop_back();
    else if (event == Json::parse_event_t::key)
      duplicate |= !objects.back().insert(value.get<std::string>()).second;
    return true;
  };
  auto metadata = Json::parse(bytes, callback, false);
  persisted::Require(!metadata.is_discarded() && !duplicate, "invalid derivative metadata JSON");
  return metadata;
}
inline Result<void> CheckStore(sqlite::Database& db) {
  try {
    auto selected = db.Prepare(
        "SELECT source_id,kind,parameters,asset_id,metadata,sequence FROM file_derivatives");
    if (!selected)
      return selected.error();
    auto query = std::move(selected).value();
    size_t count = 0, thumbnails = 0;
    for (;;) {
      auto row = query.Step();
      if (!row)
        return row.error();
      if (!row.value())
        return {};
      const DerivativeKey key{query.Text(0), query.Text(1), query.Text(2)};
      Record(key, {query.Text(3), DecodeMetadata(query.Text(4))});
      persisted::Require(!query.IsNull(5) && query.Int64(5) >= 0, "invalid derivative sequence");
      ++count;
      thumbnails += key.kind == "thumbnail";
      persisted::Require(count <= 1024 && thumbnails <= 256, "derivative cache exceeds bounds");
    }
  } catch (const std::exception& error) {
    return CorruptRecord(std::string("invalid derivative store: ") + error.what());
  }
}
inline Result<void> Trim(sqlite::Database& db) {
  auto trimmed = db.Execute(
      "DELETE FROM file_derivatives WHERE rowid IN (SELECT rowid FROM file_derivatives "
      "WHERE kind='thumbnail' ORDER BY sequence DESC,rowid DESC LIMIT -1 OFFSET 256)");
  if (!trimmed)
    return trimmed.error();
  return db.Execute(
      "DELETE FROM file_derivatives WHERE rowid IN (SELECT rowid FROM file_derivatives "
      "ORDER BY sequence DESC,rowid DESC LIMIT -1 OFFSET 1024)");
}
}  // namespace derivative_records
}  // namespace remotekit
