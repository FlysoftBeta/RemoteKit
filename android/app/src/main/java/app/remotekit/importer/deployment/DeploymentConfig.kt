package app.remotekit.importer.deployment

import app.remotekit.importer.R
import app.remotekit.importer.requireMessage
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.util.Base64
import javax.mail.internet.InternetAddress
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

val ContractJson = Json {
    encodeDefaults = true
    explicitNulls = true
}

fun decodeBase64Url(text: String, size: Int? = null): ByteArray {
    requireMessage(text.matches(Regex("[A-Za-z0-9_-]+"))) { R.string.invalid_base64 }
    val bytes = Base64.getUrlDecoder().decode(text)
    requireMessage(Base64.getUrlEncoder().withoutPadding().encodeToString(bytes) == text) {
        R.string.noncanonical_base64
    }
    requireMessage(size == null || bytes.size == size) { R.string.key_length_error }
    return bytes
}

fun sha256Hex(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") {
        "%02x".format(it.toInt() and 255)
    }

@Serializable
data class Deployment(
    val v: Int,
    val server: String,
    val mailbox: String,
    val key: DeploymentKey,
    val browser: BrowserIdentity,
)

@Serializable data class DeploymentKey(val id: String, val x25519: String)

@Serializable data class Brand(val brand: String, val version: String)

@Serializable
data class BrowserIdentity(
    val userAgent: String,
    val platform: String,
    val platformVersion: String,
    val architecture: String,
    val bitness: String,
    val wow64: Boolean,
    val model: String,
    val mobile: Boolean,
    val brands: List<Brand>,
    val fullVersionList: List<Brand>,
)

object DeploymentConfig {
    fun parse(bytes: ByteArray): Deployment {
        requireMessage(bytes.size <= 65536) { R.string.deployment_too_long }
        val json =
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes))
                .toString()
        val deployment = ContractJson.decodeFromString<Deployment>(json)
        requireMessage(deployment.v == 1) { R.string.deployment_version_error }
        requireMessage(deployment.server.isNotBlank()) {
            R.string.deployment_empty_identity
        }
        requireMessage(
            deployment.server.none { it.isWhitespace() || it.isISOControl() || it in "/?#@" }
        ) {
            R.string.deployment_invalid_server
        }
        val address = InternetAddress(deployment.mailbox, true)
        address.validate()
        requireMessage(
            address.address == deployment.mailbox &&
                address.personal == null &&
                deployment.mailbox.none { it.isWhitespace() }
        ) {
            R.string.deployment_invalid_mailbox
        }
        val publicKey = decodeBase64Url(deployment.key.x25519, 32)
        requireMessage(publicKey.any { it != 0.toByte() }) { R.string.deployment_invalid_key }
        requireMessage(
            deployment.key.id.matches(Regex("[0-9a-f]{16}")) &&
                deployment.key.id == sha256Hex(publicKey).take(16)
        ) {
            R.string.deployment_key_id_error
        }
        val browser = deployment.browser
        requireMessage(browser.platform == "Windows" && !browser.mobile) {
            R.string.browser_not_windows
        }
        requireMessage(
            browser.userAgent.isNotBlank() && browser.userAgent.none { it.isISOControl() }
        ) {
            R.string.browser_invalid_ua
        }
        requireMessage(browser.platformVersion.isNotBlank() && browser.architecture.isNotBlank()) {
            R.string.browser_incomplete
        }
        requireMessage(browser.bitness in listOf("32", "64")) { R.string.browser_invalid_bitness }
        requireMessage(browser.brands.isNotEmpty() && browser.fullVersionList.isNotEmpty()) {
            R.string.browser_empty_brands
        }
        requireMessage(
            (browser.brands + browser.fullVersionList).all {
                it.brand.isNotBlank() && it.version.isNotBlank()
            }
        ) {
            R.string.browser_invalid_brands
        }
        requireMessage(
            browser.brands.map { it.brand }.toSet() ==
                browser.fullVersionList.map { it.brand }.toSet()
        ) {
            R.string.browser_brands_mismatch
        }
        return deployment
    }
}
