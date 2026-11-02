#ifndef REMOTEKIT_BROWSER_NAVIGATION_ERROR_PAGE_H_
#define REMOTEKIT_BROWSER_NAVIGATION_ERROR_PAGE_H_

#include <string>
#include <string_view>

namespace remotekit::browser {

// Inputs only enter HTML text nodes, never URLs, attributes, CSS or scripts.
inline std::string EscapeNavigationErrorText(std::string_view text) {
  std::string escaped;
  escaped.reserve(text.size());
  for (char value : text) {
    switch (value) {
      case '&': escaped += "&amp;"; break;
      case '<': escaped += "&lt;"; break;
      case '>': escaped += "&gt;"; break;
      case '"': escaped += "&quot;"; break;
      case '\'': escaped += "&#39;"; break;
      default: escaped += value; break;
    }
  }
  return escaped;
}

// Used by the renderer's real error-document commit. It has no requests,
// scripts or retry action, so it cannot bypass navigation/repost policy.
inline std::string BuildNavigationErrorHtml(std::string_view failed_url,
                                           int error_code,
                                           std::string_view error_name) {
  return std::string(R"HTML(<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>无法打开此网页</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,"Microsoft YaHei",sans-serif}
body{margin:0;background:#f5f7fa;color:#20252d}
main{box-sizing:border-box;max-width:720px;margin:12vh auto;padding:32px}
h1{font-size:26px;line-height:1.4;margin:0 0 20px}
p{line-height:1.7}dl{margin:28px 0}dt{font-size:14px;color:#596473}
dd{margin:8px 0 20px;overflow-wrap:anywhere;white-space:pre-wrap;unicode-bidi:plaintext}
.code{font-family:ui-monospace,Consolas,monospace;font-size:14px}
@media(prefers-color-scheme:dark){body{background:#20242b;color:#ecedf0}dt{color:#b4bcc8}}
</style></head><body><main>
<h1>无法打开此网页</h1>
<p>网页加载失败。请检查网址和网络连接，然后使用上方工具栏的刷新按钮重试。</p>
<dl><dt>失败网址</dt><dd dir="auto">)HTML") +
         EscapeNavigationErrorText(failed_url) +
         "</dd><dt>错误标识</dt><dd class=\"code\" dir=\"ltr\">" +
         EscapeNavigationErrorText(error_name) + " (" +
         std::to_string(error_code) + ")</dd></dl></main></body></html>";
}

}  // namespace remotekit::browser

#endif  // REMOTEKIT_BROWSER_NAVIGATION_ERROR_PAGE_H_
