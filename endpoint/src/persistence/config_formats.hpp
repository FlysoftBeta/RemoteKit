#pragma once
#include "persistence/format_migrations.hpp"
#include "cluster/node_files.hpp"
#include <regex>

namespace remotekit::config_formats {
inline void Key(const Json& value) {
  persisted::Require(bool(cluster::DecodeKey(persisted::Text(value))), "invalid identity key");
}
inline void Node(const Json& value) {
  using namespace persisted;
  Keys(value, {"version", "nodeId", "privateKey", "controlPublicKey"}, {"control"});
  Version(value.at("version"), 1);
  Require(cluster::ValidNodeId(Text(value.at("nodeId"))), "invalid node ID");
  Key(value.at("privateKey"));
  Key(value.at("controlPublicKey"));
  if (value.contains("control"))
    Require(bool(cluster::ParseControlUrl(Text(value.at("control")))), "invalid control URL");
}
inline void Manager(const Json& value) {
  using namespace persisted;
  Keys(value, {"version", "manifest", "checkIntervalMinutes"}, {"proxy"});
  Version(value.at("version"), 1);
  Text(value.at("manifest"), 1, 32768);
  Unsigned(value.at("checkIntervalMinutes"), 5, 1440);
  if (value.contains("proxy"))
    Text(value.at("proxy"), 1, 32768);
}
inline void Media(const Json& value, bool partial = false) {
  using namespace persisted;
  const auto names = {"encoder",        "fps",         "bitrate",     "maxBitrate",
                      "asyncDepth",     "gop",         "targetUsage", "qsvLowPower",
                      "bufferMs",       "rateControl", "idleIdrMs",   "maxEncodeWidth",
                      "maxEncodeHeight"};
  Require(value.is_object(), "invalid media object");
  for (const auto& [key, item] : value.items())
    Require(std::find(names.begin(), names.end(), key) != names.end(), "unknown media field");
  for (const auto name : names) {
    if (partial && !value.contains(name))
      continue;
    const auto& item = value.at(name);
    const std::string_view field(name);
    if (field == "encoder")
      Enum(item, {"auto", "qsv", "nvenc"});
    else if (field == "qsvLowPower")
      Enum(item, {"auto", "on", "off"});
    else if (field == "rateControl") {
      if (!item.is_null())
        Enum(item, {"cbr", "vbr"});
    } else if (item.is_null() && (field == "asyncDepth" || field == "gop" ||
                                  field == "targetUsage" || field == "bufferMs"))
      continue;
    else {
      uint64_t min = 1, max = UINT32_MAX;
      if (field == "fps")
        max = 120;
      else if (field == "bitrate") {
        min = 100000;
        max = 50000000;
      } else if (field == "maxBitrate") {
        min = 100000;
        max = 60000000;
      } else if (field == "asyncDepth")
        max = 8;
      else if (field == "gop")
        max = 65535;
      else if (field == "targetUsage")
        max = 7;
      else if (field == "bufferMs") {
        min = 50;
        max = 5000;
      } else if (field == "idleIdrMs")
        min = 0;
      else {
        min = 16;
        max = 4096;
      }
      Unsigned(item, min, max);
    }
  }
}
inline void Control(const Json& value) {
  using namespace persisted;
  Keys(value, {"version", "http", "storage", "media", "quotas", "nodes"}, {"sessionImport"});
  Version(value.at("version"), 1);
  const auto& http = value.at("http");
  Keys(http, {"listen", "origins"}, {"tls"});
  Text(http.at("listen"), 1, 32768);
  Array(http.at("origins"), 256);
  for (const auto& origin : http.at("origins"))
    Text(origin, 1, 32768);
  if (http.contains("tls")) {
    Keys(http.at("tls"), {"key", "cert"});
    Text(http.at("tls").at("key"), 1, 32768);
    Text(http.at("tls").at("cert"), 1, 32768);
  }
  Keys(value.at("storage"), {"database", "diagnostics", "logs"});
  for (const auto name : {"database", "diagnostics", "logs"})
    Text(value.at("storage").at(name), 1, 32768);
  Media(value.at("media"));
  Keys(value.at("quotas"), {"tenantObjectBytes"});
  if (!value.at("quotas").at("tenantObjectBytes").is_null())
    Unsigned(value.at("quotas").at("tenantObjectBytes"), 1, 9007199254740991ULL);
  Require(value.at("nodes").is_object(), "invalid nodes");
  for (const auto& [id, node] : value.at("nodes").items()) {
    Require(cluster::ValidNodeId(id), "invalid node ID");
    Keys(node, {"peer", "rtc", "limits"}, {"local", "remote", "media"});
    Require(node.contains("local") != node.contains("remote"), "expected local or remote node");
    Keys(node.at("peer"), {"listen", "address"});
    for (const auto name : {"listen", "address"})
      Text(node.at("peer").at(name), 1, 32768);
    Keys(node.at("rtc"), {"ports", "address"});
    for (const auto name : {"ports", "address"})
      if (!node.at("rtc").at(name).is_null())
        Text(node.at("rtc").at(name), 1, 32768);
    Keys(node.at("limits"), {"maxSessions", "diskReserveBytes", "sessionMemoryBytes"});
    for (const auto name : {"maxSessions", "diskReserveBytes", "sessionMemoryBytes"}) {
      const auto& limit = node.at("limits").at(name);
      if (!limit.is_null())
        Unsigned(limit, std::string_view(name) == "diskReserveBytes" ? 0 : 1,
                 std::string_view(name) == "maxSessions" ? 64 : 9007199254740991ULL);
    }
    if (node.contains("media"))
      Media(node.at("media"), true);
    if (node.contains("local")) {
      Keys(node.at("local"), {"root"}, {"executable"});
      Text(node.at("local").at("root"), 1, 32768);
      if (node.at("local").contains("executable"))
        Text(node.at("local").at("executable"), 1, 32768);
    } else {
      Keys(node.at("remote"), {"control"});
      Require(bool(cluster::ParseControlUrl(Text(node.at("remote").at("control")))),
              "invalid remote control URL");
    }
  }
  if (value.contains("sessionImport")) {
    const auto& mail = value.at("sessionImport");
    Keys(mail,
         {"mailbox", "imap", "smtp", "appMailbox", "folder", "pollSeconds", "replyWindowSeconds"});
    for (const auto name : {"mailbox", "appMailbox", "folder"})
      Text(mail.at(name), 1, 32768);
    for (const auto name : {"imap", "smtp"}) {
      const auto& server = mail.at(name);
      Keys(server, {"host", "port", "user", "password"});
      for (const auto field : {"host", "user", "password"})
        Text(server.at(field), 1, 32768);
      Unsigned(server.at("port"), 1, 65535);
    }
    Unsigned(mail.at("pollSeconds"), 15, 3600);
    Unsigned(mail.at("replyWindowSeconds"), 0, 600);
  }
}
inline void Owner(const Json& value) {
  using namespace persisted;
  Keys(value, {"version", "snapshotId"});
  Version(value.at("version"), 1);
  const auto& id = Text(value.at("snapshotId"), 38, 38);
  static const std::regex pattern(
      R"(\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\})");
  Require(std::regex_match(id, pattern), "invalid snapshot ID");
}
using Validator = void (*)(const Json&);
inline Result<Json> Decode(std::string_view bytes, Validator validate, persisted::Store store) {
  try {
    auto value = persisted::MigrateFormat(store, Json::parse(bytes));
    validate(value);
    return value;
  } catch (const std::exception& error) {
    return CorruptState(error.what());
  }
}
inline Result<std::string> Encode(const Json& value, Validator validate) {
  try {
    validate(value);
    return value.dump();
  } catch (const std::exception& error) {
    return CorruptState(error.what());
  }
}
}  // namespace remotekit::config_formats
