package app.remotekit.importer

import app.remotekit.importer.web.inferSiteName
import app.remotekit.importer.web.siteKey
import org.junit.Assert.assertEquals
import org.junit.Test

class SiteNameTest {
    @Test
    fun siteKeys() {
        assertEquals("github.com", siteKey("github.com"))
        assertEquals("github.com", siteKey("Gist.GitHub.com."))
        assertEquals("example.edu.cn", siteKey("pass.sso.example.edu.cn"))
        assertEquals("example.co.uk", siteKey("www.example.co.uk"))
        assertEquals("google.com.hk", siteKey("www.google.com.hk"))
        assertEquals("example.io", siteKey("app.example.io"))
        assertEquals("10.0.0.5", siteKey("10.0.0.5"))
    }

    @Test
    fun siteNames() {
        assertEquals("学习通", inferSiteName("chaoxing.com", "学习通", "用户登录"))
        assertEquals("GitHub", inferSiteName("github.com", null, "Sign in to GitHub · GitHub"))
        assertEquals(
            "GitHub",
            inferSiteName("github.com", null, "GitHub: Let’s build from here · GitHub"),
        )
        assertEquals("统一身份认证", inferSiteName("example.edu.cn", null, "登录 - 统一身份认证"))
        assertEquals("百度一下，你就知道", inferSiteName("baidu.com", null, "百度一下，你就知道"))
        assertEquals(
            "Example",
            inferSiteName("example.com", null, "A very long marketing title without any separators"),
        )
        assertEquals("Example", inferSiteName("example.com", " ", null))
    }
}
