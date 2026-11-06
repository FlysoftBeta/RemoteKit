package app.remotekit.importer.export

import android.net.Uri
import android.webkit.WebView
import androidx.webkit.Profile
import app.remotekit.importer.payload.ImportCookie
import app.remotekit.importer.payload.OriginStorage

interface SessionExporter {
    fun supports(url: Uri): Boolean

    suspend fun export(scope: ExportScope): SessionCapture
}

class ExportScope(val webView: WebView, val profile: Profile, val url: Uri)

data class SessionCapture(val cookies: List<ImportCookie>, val localStorage: List<OriginStorage>)

object SessionExporters {
    val all: List<SessionExporter> = emptyList()

    fun forUrl(url: Uri): SessionExporter? = all.firstOrNull { it.supports(url) }
}
