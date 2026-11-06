package app.remotekit.importer.web

import android.content.Context
import android.net.Uri
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.webkit.Profile
import androidx.webkit.ProfileStore
import androidx.webkit.UserAgentMetadata
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.remotekit.importer.deployment.BrowserIdentity
import app.remotekit.importer.store.AppStore
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

class ProfileSessions(private val store: AppStore) {
    private val loaded = mutableMapOf<String, Profile>()

    fun supported(): Boolean =
        WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE) &&
            WebViewFeature.isFeatureSupported(WebViewFeature.USER_AGENT_METADATA) &&
            WebViewFeature.isFeatureSupported(WebViewFeature.GET_COOKIE_INFO)

    fun deletePendingBeforeWebViews() {
        val profiles = ProfileStore.getInstance()
        val names = profiles.allProfileNames.filter { it != "Default" }
        (names + store.snapshot.value.pendingProfileDeletions).distinct().forEach { id ->
            profiles.deleteProfile(id)
            store.profileDeleted(id)
        }
    }

    fun create(context: Context, id: String, identity: BrowserIdentity): Pair<WebView, Profile> {
        store.beginDestroy(id)
        val profile = ProfileStore.getInstance().getOrCreateProfile(id)
        loaded[id] = profile
        val view = WebView(context)
        WebViewCompat.setProfile(view, id)
        view.settings.apply {
            userAgentString = identity.userAgent
            javaScriptEnabled = true
            domStorageEnabled = true
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            allowFileAccess = false
            allowContentAccess = false
        }
        val full = identity.fullVersionList.associateBy { it.brand }
        val brands =
            identity.brands.map {
                UserAgentMetadata.BrandVersion.Builder()
                    .setBrand(it.brand)
                    .setMajorVersion(it.version)
                    .setFullVersion(full.getValue(it.brand).version)
                    .build()
            }
        val metadata =
            UserAgentMetadata.Builder()
                .setBrandVersionList(brands)
                .setPlatform(identity.platform)
                .setPlatformVersion(identity.platformVersion)
                .setArchitecture(identity.architecture)
                .setBitness(identity.bitness.toInt())
                .setWow64(identity.wow64)
                .setModel(identity.model)
                .setMobile(identity.mobile)
                .build()
        WebSettingsCompat.setUserAgentMetadata(view.settings, metadata)
        profile.cookieManager.setAcceptThirdPartyCookies(view, true)
        return view to profile
    }

    suspend fun destroy(id: String) =
        withContext(Dispatchers.Main.immediate) {
            store.beginDestroy(id)
            val profiles = ProfileStore.getInstance()
            val profile = loaded[id] ?: profiles.getProfile(id)?.also { loaded[id] = it }
            if (profile != null) {
                suspendCancellableCoroutine { continuation ->
                    profile.cookieManager.removeAllCookies {
                        if (continuation.isActive) continuation.resume(Unit)
                    }
                }
                profile.cookieManager.flush()
                profile.webStorage.deleteAllData()
            }
            try {
                profiles.deleteProfile(id)
                loaded.remove(id)
                store.profileDeleted(id)
            } catch (_: IllegalStateException) {
                // A loaded profile cannot be unloaded by destroying its WebView. Retry at startup.
            }
        }
}

open class LoginChromeClient : WebChromeClient() {
    override fun onShowFileChooser(
        webView: WebView,
        filePathCallback: ValueCallback<Array<Uri>>,
        fileChooserParams: FileChooserParams,
    ): Boolean {
        filePathCallback.onReceiveValue(null)
        return true
    }
}
