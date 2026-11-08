#pragma once

#include <optional>
#include <string>

#include "base/json/json_writer.h"
#include "base/values.h"
#include "net/base/url_util.h"
#include "net/http/http_request_headers.h"
#include "protocol/control.h"
#include "url/gurl.h"

namespace remotekit::browser {
inline std::string SignInNavigationUrl(const GURL& url) {
  if (!url.SchemeIs("remotekit-signin") || url.path() != "/done")
    return url.spec();
  GURL::Replacements replacements;
  replacements.ClearQuery();
  replacements.ClearRef();
  return url.ReplaceComponents(replacements).spec();
}

inline bool ValidSignInPurpose(const std::string& purpose) {
  return purpose == "xinjiaoyu" || purpose == "changyan";
}

inline bool SignInResultFits(const base::DictValue& result) {
  const auto json = base::WriteJson(result);
  return json && json->size() <= protocol::kMaxSignInResultBytes;
}

inline std::optional<base::DictValue> XinjiaoyuSignInResult(
    const GURL& url,
    const net::HttpRequestHeaders& headers) {
  if (url.scheme() != "https" || url.host() != "www.xinjiaoyu.com" ||
      url.EffectiveIntPort() != 443 || !url.path().starts_with("/api/v3/") ||
      url.path() == "/api/v3/server_system/system/code" ||
      url.path() == "/api/v3/server_system/auth/login")
    return std::nullopt;
  const auto authorization = headers.GetHeader("authorization");
  const auto access_token = headers.GetHeader("accesstoken");
  if (!authorization || !authorization->starts_with("JBY ") || !access_token ||
      access_token->empty())
    return std::nullopt;
  base::DictValue result;
  for (const auto* name : {"authorization", "accesstoken", "user-agent", "accept-language",
                           "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"}) {
    if (auto value = headers.GetHeader(name))
      result.Set(name, *value);
  }
  return SignInResultFits(result) ? std::make_optional(std::move(result)) : std::nullopt;
}

inline std::optional<base::DictValue> ChangyanSignInResult(const GURL& url) {
  if (url.scheme() != "remotekit-signin" || url.host() != "changyan" || url.path() != "/done")
    return std::nullopt;
  base::DictValue result;
  for (const auto* name : {"lot_number", "captcha_output", "pass_token", "gen_time"}) {
    std::string value;
    if (!net::GetValueForKeyInQuery(url, name, &value) || value.empty())
      return std::nullopt;
    result.Set(name, std::move(value));
  }
  return SignInResultFits(result) ? std::make_optional(std::move(result)) : std::nullopt;
}
}  // namespace remotekit::browser
