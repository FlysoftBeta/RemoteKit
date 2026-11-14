#pragma once
#include <algorithm>
#include <regex>
#include <string>

// Ignore examples in literals and comments when checking executable driver code.
inline std::string DriverCode(std::string text) {
  const auto blank = [&](size_t begin, size_t end) {
    for (auto i = begin; i < end; ++i)
      if (text[i] != '\n')
        text[i] = ' ';
  };
  for (size_t i = 0; i < text.size();) {
    const auto begin = i;
    if (text.compare(i, 2, "//") == 0) {
      i = text.find('\n', i + 2);
      if (i == std::string::npos)
        i = text.size();
    } else if (text.compare(i, 2, "/*") == 0) {
      i = text.find("*/", i + 2);
      i = i == std::string::npos ? text.size() : i + 2;
    } else if (text.compare(i, 2, "R\"") == 0) {
      const auto opening = text.find('(', i + 2);
      if (opening == std::string::npos)
        return {};
      const auto delimiter = ")" + text.substr(i + 2, opening - i - 2) + "\"";
      i = text.find(delimiter, opening + 1);
      i = i == std::string::npos ? text.size() : i + delimiter.size();
    } else if (text[i] == '\"' || text[i] == '\'') {
      const auto quote = text[i++];
      while (i < text.size()) {
        if (text[i] == '\\')
          i += std::min<size_t>(2, text.size() - i);
        else if (text[i++] == quote)
          break;
      }
    } else {
      ++i;
      continue;
    }
    blank(begin, i);
  }
  return text;
}
inline bool DirectPrimitiveDriver(const std::string& source) {
  const auto code = DriverCode(source);
  for (const auto* pattern : {R"(\bRetryUnit\s+\w+\s*[({;=])", R"(\bRetryUnit\s*[({])",
                              R"(\bRetryUnit::(?:Fail|Success|Restore|Ready|Input)\b)",
                              R"(\bnew\s+(?:remotekit::)?RetryUnit\b)",
                              R"(\bmake_(?:shared|unique)\s*<\s*(?:remotekit::)?RetryUnit\s*>)",
                              R"(\b(?:using\s+\w+\s*=|typedef)\s*(?:remotekit::)?RetryUnit\b)",
                              R"((?:\.|->)\s*(?:Fail|Success|Restore|Ready|Input)\s*\()"})
    if (std::regex_search(code, std::regex(pattern)))
      return true;
  return false;
}
