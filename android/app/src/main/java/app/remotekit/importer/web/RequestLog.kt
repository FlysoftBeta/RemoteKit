package app.remotekit.importer.web

import java.net.URI
import java.util.concurrent.ConcurrentHashMap

/**
 * Every http(s) URL one login browser requested, grouped by origin. Export queries cookies at
 * these URLs, so cookies scoped to a subdomain or a path are found where the site used them.
 * Thread-safe: requests are recorded from WebView's network thread.
 */
class RequestLog {
    private val origins = ConcurrentHashMap<String, MutableSet<String>>()

    fun record(url: String) {
        val uri = runCatching { URI(url) }.getOrNull() ?: return
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") return
        val host = uri.host?.lowercase()?.takeIf(String::isNotBlank) ?: return
        val defaultPort = if (scheme == "https") 443 else 80
        val port = if (uri.port == -1 || uri.port == defaultPort) "" else ":${uri.port}"
        val paths = origins.computeIfAbsent("$scheme://$host$port") { ConcurrentHashMap.newKeySet() }
        if (paths.size < PATHS_PER_ORIGIN) paths.add(uri.rawPath?.takeIf(String::isNotEmpty) ?: "/")
    }

    /** Origins whose host belongs to one of [sites] (site keys), with the paths requested there. */
    fun within(sites: Set<String>): Map<String, Set<String>> =
        origins.entries
            .filter { siteKey(URI(it.key).host) in sites }
            .associate { it.key to it.value.toSet() }

    private companion object {
        // Bounds cookie queries on sites that request many distinct resource paths.
        const val PATHS_PER_ORIGIN = 256
    }
}
