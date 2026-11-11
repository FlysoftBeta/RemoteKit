#pragma once
#include "files/file_library.hpp"
#include "rtc/dc_services.hpp"
#include "util/result_macros.hpp"
#include "persistence/session_db.hpp"
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
    const auto& binding = value.at("binding");
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
      selection.files.push_back({file.at("assetId").get<std::string>(),
                                 file.at("name").get<std::string>(),
                                 file.at("type").get<std::string>()});
    }
    return selection;
  } catch (const Json::exception& error) {
    return Error{ErrorCode::kInternal,
                 "invalid_selection_fields: json_exception_" + std::to_string(error.id)};
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
    if (!value.is_object())
      return CorruptState("invalid library record");
    if (table == LibraryTable::kSelections) {
      auto parsed = ParseSelection(id, value);
      if (!parsed)
        return CorruptState(parsed.error().message);
    } else if (table == LibraryTable::kAssets) {
      if (!HexId(id, 64) || !ValidSpec({"asset", value.at("type").get<std::string>(),
                                        value.at("size").get<uint64_t>()}))
        return CorruptState("invalid_asset_metadata");
      value.value("width", 0u);
      value.value("height", 0u);
    } else if (table == LibraryTable::kDrafts) {
      if (!HexId(id, 32) || !BoundedServiceId(value.at("operation").get<std::string>()) ||
          !ValidSpec({value.at("name").get<std::string>(), value.at("type").get<std::string>(),
                      value.at("size").get<uint64_t>()}) ||
          (!value.at("sealed").get<std::string>().empty() &&
           !HexId(value.at("sealed").get<std::string>(), 64)))
        return CorruptState("invalid_asset_draft");
      value.at("expires").get<int64_t>();
    } else {
      if (id.size() < 68 || !HexId(id.substr(0, 64), 64) || id[64] != '-' ||
          (id.substr(65) != "jpeg" && id.substr(65) != "png" && id.substr(65) != "webp") ||
          !HexId(value.at("assetId").get<std::string>(), 64))
        return CorruptState("invalid_derivative_record");
    }
    return {};
  } catch (const std::exception& error) {
    return CorruptState(std::string("invalid library record: ") + error.what());
  }
}
}  // namespace remotekit::library_records
