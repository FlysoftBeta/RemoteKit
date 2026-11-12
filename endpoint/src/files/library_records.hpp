#pragma once
#include "files/file_library.hpp"
#include "rtc/dc_services.hpp"
#include "util/result_macros.hpp"
#include "persistence/session_db.hpp"
#include "persistence/session_documents.hpp"
#include <algorithm>
namespace remotekit::library_records {
using State = FileLibrary::Selection::State;
using Json = ServiceJson;
constexpr uint64_t kFileBytes = 256ull * 1024 * 1024;
inline bool HexId(const std::string& id, std::size_t size) {
  return id.size() == size && std::all_of(id.begin(), id.end(), [](char c) {
           return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
         });
}
inline const char* StateName(State state) {
  switch (state) {
    case State::pending:
      return "pending";
    case State::submitted:
      return "submitted";
    case State::selected:
      return "selected";
    case State::cancelled:
      return "cancelled";
  }
  throw std::logic_error("invalid selection enum");
}
inline Result<State> ParseState(const std::string& state) {
  for (const auto value : {State::pending, State::submitted, State::selected, State::cancelled})
    if (state == StateName(value))
      return value;
  return Error{ErrorCode::kInvalidRequest, "invalid_selection_state"};
}
inline Result<FileLibrary::Selection> ParseSelection(const std::string& id, const Json& value) {
  if (!HexId(id, 32))
    return Error{ErrorCode::kInternal, "invalid_selection_id"};
  if (value.is_discarded())
    return Error{ErrorCode::kInternal, "invalid_selection_json"};
  try {
    using namespace persisted;
    Keys(value, {"requestId", "binding", "state", "accept", "limits", "files"});
    Text(value.at("requestId"), 1, 128);
    const auto& binding = value.at("binding");
    Keys(binding, {"browserIncarnation", "view", "instance", "document", "request"});
    Text(binding.at("browserIncarnation"), 1, 128);
    for (const auto name : {"view", "instance", "document", "request"})
      session_documents::Counter(binding.at(name), true);
    Array(value.at("accept"), 256);
    for (const auto& accept : value.at("accept"))
      Text(accept, 0, 255);
    Keys(value.at("limits"), {"maxFileBytes", "maxBatchBytes", "maxFiles"});
    Unsigned(value.at("limits").at("maxFileBytes"), 1, kFileBytes);
    Unsigned(value.at("limits").at("maxBatchBytes"), 1, 512ull * 1024 * 1024);
    Unsigned(value.at("limits").at("maxFiles"), 1, 64);
    RK_ASSIGN_OR_RETURN(state, ParseState(value.at("state").get<std::string>()));
    FileLibrary::Selection selection{
        id,
        value.at("requestId").get<std::string>(),
        {binding.at("browserIncarnation").get<std::string>(), binding.at("view").get<std::string>(),
         binding.at("instance").get<std::string>(), binding.at("document").get<std::string>(),
         binding.at("request").get<std::string>()},
        {},
        state};
    selection.accept = value.at("accept").get<std::vector<std::string>>();
    const auto& limits = value.at("limits");
    selection.limits.file_bytes = limits.at("maxFileBytes").get<std::uint64_t>();
    selection.limits.batch_bytes = limits.at("maxBatchBytes").get<std::uint64_t>();
    selection.limits.files = limits.at("maxFiles").get<std::size_t>();
    const auto& files = value.at("files");
    if (!files.is_array() || files.empty() || files.size() > 64)
      return Error{ErrorCode::kInternal, "invalid_selection_files"};
    for (const auto& file : files) {
      Keys(file, {"assetId", "name", "type"});
      Require(HexId(Text(file.at("assetId")), 64), "invalid selection asset ID");
      Text(file.at("name"), 1, 1024);
      Text(file.at("type"), 0, 255);
      selection.files.push_back({file.at("assetId").get<std::string>(),
                                 file.at("name").get<std::string>(),
                                 file.at("type").get<std::string>()});
    }
    return selection;
  } catch (const std::exception& error) {
    return CorruptRecord(std::string("invalid selection: ") + error.what());
  }
}
inline bool ValidSpec(const FileUploadStore::Spec& spec) {
  if (spec.name.empty() || spec.name == "." || spec.name == ".." || spec.name.size() > 1024 ||
      spec.type.size() > 255 || spec.size > kFileBytes)
    return false;
  for (const unsigned char c : spec.name)
    if (c < 32 || c == '/' || c == '\\' || c == ':')
      return false;
  for (const unsigned char c : spec.type)
    if (c < 32 || c >= 127)
      return false;
  return true;
}

inline Result<void> Validate(LibraryTable table, const std::string& id, const Json& value) {
  try {
    using namespace persisted;
    if (!value.is_object())
      return CorruptRecord("invalid library record");
    if (table == LibraryTable::kSelections) {
      auto parsed = ParseSelection(id, value);
      if (!parsed)
        return CorruptRecord(parsed.error().message);
    } else if (table == LibraryTable::kAssets) {
      Keys(value, {"size", "type"}, {"assetId", "width", "height"});
      Unsigned(value.at("size"), 0, kFileBytes);
      Text(value.at("type"), 0, 255);
      if (value.contains("assetId"))
        Require(value.at("assetId") == id, "asset identity mismatch");
      Require(value.contains("width") == value.contains("height"), "incomplete asset dimensions");
      for (const auto name : {"width", "height"})
        if (value.contains(name))
          Unsigned(value.at(name), 1, 32768);
      if (!HexId(id, 64) || !ValidSpec({"asset", value.at("type").get<std::string>(),
                                        value.at("size").get<uint64_t>()}))
        return CorruptRecord("invalid_asset_metadata");
    } else if (table == LibraryTable::kDrafts) {
      Keys(value, {"operation", "name", "type", "size", "expires", "sealed"});
      Text(value.at("operation"), 1, 128);
      Text(value.at("name"), 1, 1024);
      Text(value.at("type"), 0, 255);
      Text(value.at("sealed"), 0, 64);
      Unsigned(value.at("size"), 0, kFileBytes);
      Unsigned(value.at("expires"));
      if (!HexId(id, 32) || !BoundedServiceId(value.at("operation").get<std::string>()) ||
          !ValidSpec({value.at("name").get<std::string>(), value.at("type").get<std::string>(),
                      value.at("size").get<uint64_t>()}) ||
          (!value.at("sealed").get<std::string>().empty() &&
           !HexId(value.at("sealed").get<std::string>(), 64)))
        return CorruptRecord("invalid_asset_draft");
      value.at("expires").get<int64_t>();
    } else {
      Keys(value, {"assetId"});
      Text(value.at("assetId"), 64, 64);
      if (id.size() < 68 || !HexId(id.substr(0, 64), 64) || id[64] != '-' ||
          (id.substr(65) != "jpeg" && id.substr(65) != "png" && id.substr(65) != "webp") ||
          !HexId(value.at("assetId").get<std::string>(), 64))
        return CorruptRecord("invalid_derivative_record");
    }
    return {};
  } catch (const std::exception& error) {
    return CorruptRecord(std::string("invalid library record: ") + error.what());
  }
}
}  // namespace remotekit::library_records
