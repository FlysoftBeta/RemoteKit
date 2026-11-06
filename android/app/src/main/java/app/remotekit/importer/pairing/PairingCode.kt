package app.remotekit.importer.pairing

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
data class Pairing(
    val v: Int,
    val server: String,
    val user: String,
    val mailbox: String,
    val key: PairingKey,
    val token: String,
    val browser: BrowserIdentity,
) {
    val tokenHash: String
        get() = sha256Hex(decodeBase64Url(token, 32))
}

@Serializable data class PairingKey(val id: String, val x25519: String)

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

object PairingCode {
    fun parse(text: String): Pairing {
        requireMessage(text.startsWith("RKP1:")) { R.string.pairing_prefix_error }
        requireMessage(text.length <= 65536) { R.string.pairing_too_long }
        val bytes = decodeBase64Url(text.substring(5))
        val json =
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes))
                .toString()
        val pairing = ContractJson.decodeFromString<Pairing>(json)
        requireMessage(pairing.v == 1) { R.string.pairing_version_error }
        requireMessage(pairing.server.isNotBlank() && pairing.user.isNotBlank()) {
            R.string.pairing_empty_identity
        }
        requireMessage(
            pairing.server.none { it.isWhitespace() || it.isISOControl() || it in "/?#@" }
        ) {
            R.string.pairing_invalid_server
        }
        requireMessage(pairing.user.none { it.isISOControl() }) { R.string.pairing_invalid_user }
        val address = InternetAddress(pairing.mailbox, true)
        address.validate()
        requireMessage(
            address.address == pairing.mailbox &&
                address.personal == null &&
                pairing.mailbox.none { it.isWhitespace() }
        ) {
            R.string.pairing_invalid_mailbox
        }
        val publicKey = decodeBase64Url(pairing.key.x25519, 32)
        requireMessage(publicKey.any { it != 0.toByte() }) { R.string.pairing_invalid_key }
        requireMessage(
            pairing.key.id.matches(Regex("[0-9a-f]{16}")) &&
                pairing.key.id == sha256Hex(publicKey).take(16)
        ) {
            R.string.pairing_key_id_error
        }
        decodeBase64Url(pairing.token, 32)
        val browser = pairing.browser
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
        return pairing
    }
}
