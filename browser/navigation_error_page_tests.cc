#include "navigation_error_page.h"

#include <cstdlib>
#include <iostream>
#include <string>

namespace {
void Check(bool value) {
  if (!value)
    std::abort();
}
}  // namespace

int main() {
  using remotekit::browser::BuildNavigationErrorHtml;
  const std::string html = BuildNavigationErrorHtml(
      "https://example.test/中文?q=<&\"'>#</dd><script>alert(1)</script>",
      -102, "net::ERR_CONNECTION_REFUSED<&\"'>");
  Check(html.find("<title>无法打开此网页</title>") != std::string::npos);
  Check(html.find("https://example.test/中文?q=&lt;&amp;&quot;&#39;&gt;#&lt;/dd&gt;&lt;script&gt;alert(1)&lt;/script&gt;") !=
        std::string::npos);
  Check(html.find("net::ERR_CONNECTION_REFUSED&lt;&amp;&quot;&#39;&gt; (-102)") !=
        std::string::npos);
  Check(html.find("上方工具栏的刷新按钮重试") != std::string::npos);
  Check(html.find("default-src 'none'") != std::string::npos);
  for (const char* forbidden : {"<script", "<img", "<link", "<iframe", "<form",
                                "<button", "href=", "src=", "url(", "@import"})
    Check(html.find(forbidden) == std::string::npos);
  Check(BuildNavigationErrorHtml("", 7, "UNKNOWN_ERROR").find("UNKNOWN_ERROR (7)") !=
        std::string::npos);
  std::cout << "Navigation error document tests passed\n";
}
