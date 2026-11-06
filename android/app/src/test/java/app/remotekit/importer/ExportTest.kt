package app.remotekit.importer

import app.remotekit.importer.export.parseCookieInfo
import app.remotekit.importer.payload.ImportCookie
import app.remotekit.importer.payload.SameSite
import app.remotekit.importer.web.RequestLog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ExportTest {
    @Test
    fun parsesDomainCookieWithAllAttributes() {
        assertEquals(
            ImportCookie(
                name = "SID",
                value = "a=b",
                domain = ".example.com",
                path = "/account",
                hostOnly = false,
                secure = true,
                httpOnly = true,
                sameSite = SameSite.Lax,
                expires = 1_798_761_600_000,
            ),
            parseCookieInfo(
                "SID=a=b; domain=.example.com; path=/account; " +
                    "expires=Fri, 01 Jan 2027 00:00:00 GMT; secure; httponly; samesite=lax"
            ),
        )
    }

    @Test
    fun parsesHostOnlySessionCookie() {
        assertEquals(
            ImportCookie(
                name = "t",
                value = "",
                domain = "login.example.com",
                path = "/",
                hostOnly = true,
                secure = false,
                httpOnly = false,
                sameSite = SameSite.Unspecified,
                expires = null,
            ),
            parseCookieInfo("t=; domain=login.example.com; path=/"),
        )
    }

    @Test
    fun skipsCookiesTheContractCannotCarry() {
        assertNull(parseCookieInfo("nameless; domain=example.com; path=/"))
        assertNull(parseCookieInfo("=v; domain=example.com; path=/"))
        assertNull(parseCookieInfo("p=1; domain=example.com; path=/; secure; partitioned"))
    }

    @Test
    fun groupsRequestsByOriginWithinChosenSites() {
        val log = RequestLog()
        log.record("https://www.example.com/a/b?q=1")
        log.record("https://www.example.com:443/")
        log.record("http://login.example.com:8080/sso")
        log.record("https://cdn.other.net/x.js")
        log.record("data:text/plain,hi")
        assertEquals(
            mapOf(
                "https://www.example.com" to setOf("/a/b", "/"),
                "http://login.example.com:8080" to setOf("/sso"),
            ),
            log.within(setOf("example.com")),
        )
    }
}
