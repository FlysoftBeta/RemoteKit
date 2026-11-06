package app.remotekit.importer.crypto

import app.remotekit.importer.R
import app.remotekit.importer.deployment.ContractJson
import app.remotekit.importer.deployment.Deployment
import app.remotekit.importer.deployment.decodeBase64Url
import app.remotekit.importer.payload.ImportPayload
import app.remotekit.importer.requireMessage
import java.io.ByteArrayOutputStream
import java.util.zip.GZIPOutputStream
import kotlinx.serialization.encodeToString
import org.bouncycastle.crypto.hpke.HPKE

class EnvelopeSealer {
    fun seal(payload: ImportPayload, deployment: Deployment): ByteArray {
        payload.validate()
        val plaintext = ContractJson.encodeToString(payload).toByteArray(Charsets.UTF_8)
        requireMessage(plaintext.size <= MAX_PLAINTEXT) { R.string.payload_too_large }
        val compressed =
            ByteArrayOutputStream()
                .also { output ->
                    GZIPOutputStream(output).use { it.write(plaintext) }
                }
                .toByteArray()
        requireMessage(compressed.size + 61 <= MAX_ENVELOPE) { R.string.envelope_too_large }
        val keyId = deployment.key.id.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        requireMessage(keyId.size == 8) { R.string.key_id_length_error }
        val header = "RKSI".toByteArray(Charsets.US_ASCII) + byteArrayOf(1) + keyId
        val hpke = suite()
        val recipient = hpke.deserializePublicKey(decodeBase64Url(deployment.key.x25519, 32))
        val context = hpke.setupBaseS(recipient, INFO)
        return header + context.encapsulation + context.seal(header, compressed)
    }

    companion object {
        const val MAX_ENVELOPE = 16 * 1024 * 1024
        const val MAX_PLAINTEXT = 32 * 1024 * 1024
        val INFO: ByteArray
            get() = "RemoteKit session import v1".toByteArray(Charsets.UTF_8)

        fun suite() =
            HPKE(HPKE.mode_base, HPKE.kem_X25519_SHA256, HPKE.kdf_HKDF_SHA256, HPKE.aead_AES_GCM256)
    }
}
