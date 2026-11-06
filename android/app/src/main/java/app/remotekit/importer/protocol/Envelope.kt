package app.remotekit.importer.protocol

import app.remotekit.importer.R
import app.remotekit.importer.crypto.DeviceKey
import app.remotekit.importer.crypto.Hpke
import app.remotekit.importer.deployment.ContractJson
import app.remotekit.importer.requireMessage
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream
import kotlinx.serialization.encodeToString

object Envelope {
    const val MAX_ENVELOPE = 16 * 1024 * 1024
    const val MAX_PLAINTEXT = 32 * 1024 * 1024

    fun compressed(json: String): ByteArray {
        val bytes = json.toByteArray(Charsets.UTF_8)
        requireMessage(bytes.size <= MAX_PLAINTEXT) { R.string.payload_too_large }
        val output = ByteArrayOutputStream()
        GZIPOutputStream(output).use { it.write(bytes) }
        return output.toByteArray()
    }

    fun fits(message: DeviceMessage): Boolean =
        runCatching {
                compressed(ContractJson.encodeToString(message)).size + 77 + 16 <= MAX_ENVELOPE
            }
            .getOrDefault(false)

    fun seal(json: String, sender: DeviceKey, recipient: ByteArray): ByteArray {
        val compressed = compressed(json)
        requireMessage(compressed.size + 93 <= MAX_ENVELOPE) { R.string.envelope_too_large }
        val id = DeviceKey.keyId(recipient).chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        val aad = "RKSI".toByteArray(Charsets.US_ASCII) + byteArrayOf(2) + id + sender.publicKey
        val hpke = Hpke.suite()
        val context = hpke.setupAuthS(hpke.deserializePublicKey(recipient), Hpke.info, sender.pair)
        return aad + context.encapsulation + context.seal(aad, compressed)
    }

    fun open(bytes: ByteArray, recipient: DeviceKey, expectedSender: ByteArray): String {
        require(bytes.size in 93..MAX_ENVELOPE)
        require(bytes.copyOfRange(0, 5).contentEquals("RKSI".toByteArray() + byteArrayOf(2)))
        val id = bytes.copyOfRange(5, 13).joinToString("") { "%02x".format(it.toInt() and 255) }
        require(id == recipient.id)
        require(bytes.copyOfRange(13, 45).contentEquals(expectedSender))
        val hpke = Hpke.suite()
        val context =
            hpke.setupAuthR(
                bytes.copyOfRange(45, 77),
                recipient.pair,
                Hpke.info,
                hpke.deserializePublicKey(expectedSender),
            )
        val compressed = context.open(bytes.copyOfRange(0, 45), bytes.copyOfRange(77, bytes.size))
        val plain =
            GZIPInputStream(ByteArrayInputStream(compressed)).use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (true) {
                    val size = input.read(buffer)
                    if (size < 0) break
                    requireMessage(output.size() + size <= MAX_PLAINTEXT) {
                        R.string.payload_too_large
                    }
                    output.write(buffer, 0, size)
                }
                output.toByteArray()
            }
        return Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(plain))
            .toString()
    }
}
