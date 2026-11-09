#pragma once
#include "common.hpp"
#include <map>
namespace remotekit::release {
inline std::string Utf8(const std::wstring& value) {
  if (value.empty())
    return {};
  int n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                              static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  Require(n > 0, "invalid command argument encoding");
  std::string out(n, '\0');
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
                      out.data(), n, nullptr, nullptr);
  return out;
}
class Options {
 public:
  Options(int argc,
          wchar_t** argv,
          std::initializer_list<std::wstring> names,
          std::initializer_list<std::wstring> flags = {}) {
    for (int i = 2; i < argc; ++i) {
      std::wstring argument = argv[i];
      Require(argument.starts_with(L"--"), "expected --name=value");
      auto equals = argument.find(L'=');
      auto key = argument.substr(2, equals == argument.npos ? equals : equals - 2);
      bool flag = std::find(flags.begin(), flags.end(), key) != flags.end();
      Require(flag || std::find(names.begin(), names.end(), key) != names.end(),
              "unknown command option");
      Require((flag && equals == argument.npos) ||
                  (!flag && equals != argument.npos && equals + 1 < argument.size()),
              "invalid command option");
      Require(values_.emplace(key, flag ? L"1" : argument.substr(equals + 1)).second,
              "duplicate command option");
    }
  }
  bool Has(const std::wstring& key) const { return values_.contains(key); }
  const std::wstring& Get(const std::wstring& key) const {
    auto it = values_.find(key);
    Require(it != values_.end(), "missing required command option");
    return it->second;
  }
  std::string Text(const std::wstring& key) const { return Utf8(Get(key)); }
  fs::path Path(const std::wstring& key) const {
    return fs::absolute(fs::path(Get(key))).lexically_normal();
  }

 private:
  std::map<std::wstring, std::wstring> values_;
};
}  // namespace remotekit::release
