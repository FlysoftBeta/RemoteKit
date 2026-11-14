#pragma once
#include "persistence/format_migrations.hpp"
#include "util/retry_unit.hpp"
#include "persistence/durable_json.hpp"

namespace remotekit::document_job_formats {
inline Result<Json> Decode(std::string_view bytes) {
  try {
    auto record = persisted::MigrateFormat(persisted::Store::kDocumentJob, Json::parse(bytes));
    persisted::Keys(record, {"version", "buildId", "retry"});
    persisted::Version(record.at("version"), 1);
    persisted::Text(record.at("buildId"), 0, 128);
    const auto& retry = record.at("retry");
    persisted::Keys(retry, {"state", "attempt", "retryAt", "input", "error"});
    persisted::Unsigned(retry.at("attempt"), 0, UINT32_MAX);
    persisted::Unsigned(retry.at("retryAt"));
    persisted::Text(retry.at("input"));
    auto restored = RetryUnit::Validate(retry);
    if (!restored)
      return CorruptState(restored.error().message);
    return record;
  } catch (const std::exception& error) {
    return CorruptState(error.what());
  }
}
inline Result<void> Write(const fs::path& path, const Json& record) {
  const auto validated = Decode(record.dump());
  if (!validated)
    return validated.error();
  return WriteDurableJson(path, validated.value());
}
}  // namespace remotekit::document_job_formats
