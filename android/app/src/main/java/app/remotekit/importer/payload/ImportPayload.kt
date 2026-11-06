package app.remotekit.importer.payload

import app.remotekit.importer.R
import app.remotekit.importer.account.validateAccount
import app.remotekit.importer.deployment.ContractJson
import app.remotekit.importer.requireMessage
import java.net.URI
import java.util.UUID
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

@Serializable
enum class SameSite {
    @SerialName("unspecified") Unspecified,
    @SerialName("none") None,
    @SerialName("lax") Lax,
    @SerialName("strict") Strict,
}

@Serializable
data class ImportCookie(
    val name: String,
    val value: String,
    val domain: String,
    val path: String,
    val hostOnly: Boolean,
    val secure: Boolean,
    val httpOnly: Boolean,
    val sameSite: SameSite,
    val expires: Long?,
)

@Serializable data class OriginStorage(val origin: String, val items: List<List<String>>)

@Serializable data class ImportSite(val name: String, val url: String)

@Serializable
data class ImportPayload(
    val v: Int = 1,
    val id: String,
    val createdAt: Long,
    val username: String,
    val password: String,
    val device: String,
    val sites: List<ImportSite>,
    val cookies: List<ImportCookie>,
    val localStorage: List<OriginStorage>,
) {
    fun validate() {
        requireMessage(v == 1) { R.string.payload_version_error }
        val uuid = UUID.fromString(id)
        requireMessage(uuid.version() == 4 && uuid.variant() == 2 && uuid.toString() == id) {
            R.string.payload_invalid_uuid
        }
        requireMessage(createdAt >= 0) { R.string.payload_invalid_time }
        validateAccount(username, password)
        requireMessage(device.isNotBlank() && device.codePointCount(0, device.length) <= 64) {
            R.string.device_name_limit
        }
        requireMessage(sites.size in 1..16 && sites.map { it.url }.distinct().size == sites.size) {
            R.string.site_count_limit
        }
        sites.forEach { site ->
            requireMessage(
                site.name.isNotBlank() && site.name.codePointCount(0, site.name.length) <= 128
            ) {
                R.string.site_name_limit
            }
            httpUrl(site.url)
        }
        requireMessage(cookies.size <= 4096) { R.string.cookie_count_limit }
        cookies.forEach {
            requireMessage(utf8Size(it.name) + utf8Size(it.value) <= 4096) {
                R.string.cookie_size_limit
            }
            requireMessage(
                it.name.isNotEmpty() && it.domain.isNotBlank() && it.path.startsWith('/')
            ) {
                R.string.cookie_invalid
            }
            requireMessage(!it.hostOnly || !it.domain.startsWith('.')) {
                R.string.cookie_host_only_error
            }
            requireMessage(it.expires == null || it.expires >= 0) { R.string.cookie_expiry_error }
        }
        requireMessage(
            localStorage.size <= 256 &&
                localStorage.map { it.origin }.distinct().size == localStorage.size
        ) {
            R.string.origin_count_limit
        }
        localStorage.forEach { storage ->
            val uri = httpUrl(storage.origin)
            val defaultPort = if (uri.scheme == "https") 443 else 80
            val port = if (uri.port == -1 || uri.port == defaultPort) "" else ":${uri.port}"
            requireMessage(storage.origin == "${uri.scheme}://${uri.host.lowercase()}$port") {
                R.string.origin_invalid
            }
            var total = 0L
            storage.items.forEach {
                requireMessage(it.size == 2) { R.string.storage_pair_error }
                val size = utf8Size(it[0]) + utf8Size(it[1])
                requireMessage(
                    ContractJson.encodeToString(it).toByteArray(Charsets.UTF_8).size <= 256 * 1024
                ) {
                    R.string.storage_item_limit
                }
                total += size
            }
            requireMessage(total <= 10 * 1024 * 1024) { R.string.storage_origin_limit }
        }
    }
}

fun httpUrl(text: String): URI {
    val uri = URI(text)
    requireMessage(
        uri.scheme in listOf("http", "https") &&
            !uri.host.isNullOrBlank() &&
            uri.rawUserInfo == null &&
            uri.port in -1..65535
    ) {
        R.string.invalid_url
    }
    return uri
}

private fun utf8Size(text: String): Int = text.toByteArray(Charsets.UTF_8).size
