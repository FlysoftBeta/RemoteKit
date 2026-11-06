package app.remotekit.importer.export

import android.content.Context
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.CookieManagerCompat
import androidx.webkit.Profile
import androidx.webkit.WebViewCompat
import app.remotekit.importer.deployment.ContractJson
import app.remotekit.importer.payload.ImportCookie
import app.remotekit.importer.payload.OriginStorage
import kotlin.coroutines.resume
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

data class SessionCapture(val cookies: List<ImportCookie>, val localStorage: List<OriginStorage>)

/** Reads the cookies and localStorage a login browser's profile holds for a set of origins. */
class SessionExporter(private val context: Context, private val profile: Profile) {
    /** [origins] maps each serialized origin to the URL paths the login browser requested there. */
    suspend fun export(origins: Map<String, Set<String>>): SessionCapture {
        val manager = withContext(Dispatchers.Main) { profile.cookieManager }
        val cookies = withContext(Dispatchers.IO) { cookies(manager, origins) }
        return SessionCapture(cookies, localStorage(origins.keys.sorted()))
    }

    private fun cookies(
        manager: CookieManager,
        origins: Map<String, Set<String>>,
    ): List<ImportCookie> =
        origins
            .flatMap { (origin, paths) ->
                paths.flatMap { CookieManagerCompat.getCookieInfo(manager, origin + it) }
            }
            .distinct()
            .mapNotNull(::parseCookieInfo)
            .associateBy { Triple(it.name, it.domain, it.path) }
            .values
            .toList()

    /**
     * Opens an empty document for each origin in a hidden WebView on the same profile, so storage
     * is read without network requests or site scripts.
     */
    private suspend fun localStorage(origins: List<String>): List<OriginStorage> =
        withContext(Dispatchers.Main) {
            val view = WebView(context)
            WebViewCompat.setProfile(view, profile.name)
            view.settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = false
                allowContentAccess = false
            }
            var loading: CancellableContinuation<Unit>? = null
            view.webViewClient =
                object : WebViewClient() {
                    override fun onPageFinished(view: WebView, url: String?) {
                        loading?.takeIf { it.isActive }?.resume(Unit)
                        loading = null
                    }
                }
            try {
                origins.mapNotNull { origin ->
                    withTimeout(LOAD_TIMEOUT_MS) {
                        suspendCancellableCoroutine { continuation ->
                            loading = continuation
                            view.loadDataWithBaseURL("$origin/", BLANK, "text/html", "utf-8", null)
                        }
                    }
                    read(view).takeIf(List<List<String>>::isNotEmpty)?.let {
                        OriginStorage(origin, it)
                    }
                }
            } finally {
                loading = null
                view.stopLoading()
                view.destroy()
            }
        }

    private suspend fun read(view: WebView): List<List<String>> {
        val result = suspendCancellableCoroutine { continuation ->
            view.evaluateJavascript(READ_STORAGE) { continuation.resume(it) }
        }
        val json = ContractJson.decodeFromString<String?>(result) ?: return emptyList()
        return ContractJson.decodeFromString(json)
    }

    private companion object {
        const val LOAD_TIMEOUT_MS = 10_000L
        const val BLANK = "<!doctype html><title></title>"
        const val READ_STORAGE =
            "(function(){try{var s=localStorage,r=[];for(var i=0;i<s.length;i++){" +
                "var k=s.key(i);r.push([k,s.getItem(k)])}return JSON.stringify(r)}" +
                "catch(e){return null}})()"
    }
}
