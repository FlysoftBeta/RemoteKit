package app.remotekit.importer.export

import app.remotekit.importer.payload.ImportCookie
import app.remotekit.importer.payload.SameSite
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/**
 * Parses one line of `CookieManagerCompat.getCookieInfo`, which WebView builds with
 * `CanonicalCookie::BuildCookieAttributesLine`: `name=value; domain=…; path=…; expires=<HTTP
 * date>; secure; httponly; partitioned; samesite=…`. The domain is canonical: a leading dot marks
 * a domain cookie, otherwise the cookie is host-only.
 *
 * Returns null for nameless cookies, which the import contract cannot carry, and for partitioned
 * cookies, which would otherwise be written back unpartitioned.
 */
fun parseCookieInfo(line: String): ImportCookie? {
    val parts = line.split("; ")
    val pair = parts.first()
    if ('=' !in pair) return null
    val name = pair.substringBefore('=')
    if (name.isEmpty()) return null
    var domain: String? = null
    var path = "/"
    var expires: Long? = null
    var secure = false
    var httpOnly = false
    var sameSite = SameSite.Unspecified
    for (attribute in parts.drop(1)) {
        val key = attribute.substringBefore('=').lowercase()
        val value = attribute.substringAfter('=', "")
        when (key) {
            "domain" -> domain = value
            "path" -> path = value
            "expires" ->
                expires = ZonedDateTime.parse(value, DateTimeFormatter.RFC_1123_DATE_TIME)
                    .toInstant()
                    .toEpochMilli()
                    .coerceAtLeast(0)
            "secure" -> secure = true
            "httponly" -> httpOnly = true
            "partitioned" -> return null
            "samesite" ->
                sameSite =
                    when (value.lowercase()) {
                        "none" -> SameSite.None
                        "lax" -> SameSite.Lax
                        "strict" -> SameSite.Strict
                        else -> SameSite.Unspecified
                    }
        }
    }
    val host = domain?.takeIf(String::isNotEmpty) ?: return null
    return ImportCookie(
        name = name,
        value = pair.substringAfter('='),
        domain = host,
        path = path,
        hostOnly = !host.startsWith('.'),
        secure = secure,
        httpOnly = httpOnly,
        sameSite = sameSite,
        expires = expires,
    )
}
