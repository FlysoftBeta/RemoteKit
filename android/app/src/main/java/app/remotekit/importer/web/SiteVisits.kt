package app.remotekit.importer.web

import android.graphics.Bitmap
import android.net.Uri
import android.util.Base64
import androidx.core.graphics.scale
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** One site the user reached in a login browser, keyed by its best-effort registrable domain. */
data class SiteVisit(
    val key: String,
    val url: String,
    val title: String? = null,
    val siteName: String? = null,
    val icon: Bitmap? = null,
    val seen: Long,
) {
    val name: String
        get() = inferSiteName(key, siteName, title)

    val searchEngine: Boolean
        get() = mainLabel(key) in SearchEngines.labels
}

/** Top-level navigation history of one login browser. Lives as long as the view model. */
class SiteVisits {
    private val mutable = MutableStateFlow<List<SiteVisit>>(emptyList())
    val visits: StateFlow<List<SiteVisit>> = mutable.asStateFlow()
    val requests = RequestLog()

    fun navigated(url: String) {
        requests.record(url)
        val key = keyOf(url) ?: return
        val now = System.currentTimeMillis()
        val current = mutable.value.find { it.key == key }
        val next = current?.copy(url = url, seen = now) ?: SiteVisit(key, url, seen = now)
        mutable.value = listOf(next) + mutable.value.filterNot { it.key == key }
    }

    fun title(url: String?, title: String?) = change(url) {
        it.copy(title = title?.trim()?.takeIf(String::isNotEmpty) ?: it.title)
    }

    fun siteName(url: String?, name: String?) = change(url) {
        it.copy(siteName = name?.trim()?.takeIf(String::isNotEmpty) ?: it.siteName)
    }

    fun icon(url: String?, icon: Bitmap?) = change(url) { it.copy(icon = icon ?: it.icon) }

    private fun change(url: String?, transform: (SiteVisit) -> SiteVisit) {
        val key = url?.let(::keyOf) ?: return
        mutable.value = mutable.value.map { if (it.key == key) transform(it) else it }
    }

    private fun keyOf(url: String): String? {
        val uri = Uri.parse(url)
        if (uri.scheme != "http" && uri.scheme != "https") return null
        return uri.host?.takeIf(String::isNotBlank)?.let(::siteKey)
    }
}

object SearchEngines {
    data class Engine(val name: String, val home: String, val query: String)

    val all =
        listOf(
            Engine("Bing", "https://www.bing.com/", "https://www.bing.com/search?q="),
            Engine("百度", "https://www.baidu.com/", "https://www.baidu.com/s?wd="),
            Engine("Google", "https://www.google.com/", "https://www.google.com/search?q="),
        )
    val labels = setOf("bing", "baidu", "google")

    fun search(engine: Engine, text: String): String = engine.query + Uri.encode(text.trim())
}

/** Returns an http(s) URL when the omnibox text looks like an address rather than a query. */
fun addressOf(text: String): String? {
    val trimmed = text.trim()
    if (trimmed.isEmpty() || trimmed.any(Char::isWhitespace)) return null
    val withScheme = if ("://" in trimmed) trimmed else "https://$trimmed"
    val uri = Uri.parse(withScheme)
    val host = uri.host ?: return null
    if (uri.scheme != "http" && uri.scheme != "https") return null
    val hostLike =
        host == "localhost" ||
            host.matches(Regex("[0-9.]+")) ||
            host.matches(Regex("([a-z0-9-]+\\.)+[a-z][a-z0-9-]+", RegexOption.IGNORE_CASE))
    return if (hostLike) withScheme else null
}

private val genericSecondLevel = setOf("com", "net", "org", "edu", "gov", "ac", "co", "or", "ne", "go", "mil")

/** Approximates the registrable domain without a public-suffix list. */
fun siteKey(host: String): String {
    val normalized = host.lowercase().trimEnd('.')
    if (normalized.matches(Regex("[0-9.]+")) || ':' in normalized) return normalized
    val labels = normalized.split('.')
    if (labels.size <= 2) return normalized
    val keep = if (labels.last().length == 2 && labels[labels.size - 2] in genericSecondLevel) 3 else 2
    return labels.takeLast(keep).joinToString(".")
}

private fun mainLabel(key: String): String = key.substringBefore('.')

private val titleSeparators = Regex("\\s+[-–—|:_·]\\s+|\\s*[|｜·–—]\\s*")

/**
 * Best-effort display name: the page's declared site name, otherwise the title segment that
 * names the domain, otherwise a short title, otherwise the domain label.
 */
fun inferSiteName(key: String, siteName: String?, title: String?): String {
    siteName?.trim()?.takeIf { it.isNotEmpty() && it.length <= 40 }?.let { return it }
    val label = mainLabel(key)
    val text = title?.trim().orEmpty()
    if (text.isNotEmpty()) {
        val parts = text.split(titleSeparators).map(String::trim).filter(String::isNotEmpty)
        parts
            .filter { it.lowercase().replace(" ", "").contains(label) }
            .minByOrNull(String::length)
            ?.takeIf { it.length <= 40 }
            ?.let { return it }
        if (parts.size > 1 && parts.last().length <= 30) return parts.last()
        if (text.length <= 24) return text
    }
    return label.replaceFirstChar(Char::uppercaseChar)
}

/** Script whose result is the page's declared site name, or an empty string. */
const val SITE_NAME_SCRIPT =
    "(function(){function m(s){var e=document.querySelector(s);return e&&e.content||''}" +
        "return m('meta[property=\"og:site_name\"]')||m('meta[name=\"application-name\"]')" +
        "||m('meta[name=\"apple-mobile-web-app-title\"]')})()"

fun encodeIcon(icon: Bitmap): String {
    val size = 64
    val scaled = if (icon.width > size || icon.height > size) icon.scale(size, size) else icon
    val output = ByteArrayOutputStream()
    scaled.compress(Bitmap.CompressFormat.PNG, 100, output)
    return Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
}
