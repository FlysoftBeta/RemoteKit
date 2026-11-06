package app.remotekit.importer

import app.remotekit.importer.crypto.*
import app.remotekit.importer.deployment.ContractJson
import app.remotekit.importer.payload.*
import app.remotekit.importer.protocol.*
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Base64
import java.util.zip.GZIPOutputStream
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.bouncycastle.crypto.AsymmetricCipherKeyPair
import org.bouncycastle.crypto.AsymmetricCipherKeyPairGenerator
import org.bouncycastle.crypto.KeyGenerationParameters
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import org.junit.Assert.*
import org.junit.Test

class ProtocolTest {
    private val prettyJson = Json {
        prettyPrint = true
        prettyPrintIndent = "    "
    }
    private val control = DeviceKey(ByteArray(32) { (it + 1).toByte() })
    private val device = DeviceKey(ByteArray(32) { (it + 33).toByte() })
    private val message =
        DeviceMessage(
            ack = 0,
            events =
                listOf(
                    DeviceEvent.Pair(
                        1,
                        1793900000000,
                        "student",
                        "test-password",
                        listOf("abandon", "ability", "able", "about", "above"),
                        "测试手机",
                    ),
                    DeviceEvent.Import(
                        2,
                        1793900001000,
                        "bf81f466-e992-48e5-a3d3-6b168556c471",
                        listOf(
                            ImportSite("示例站点", "https://www.example.com/account"),
                            ImportSite("示例论坛", "https://forum.example.org/"),
                        ),
                        listOf(
                            ImportCookie(
                                "SID",
                                "secret",
                                ".example.com",
                                "/",
                                false,
                                true,
                                true,
                                SameSite.Lax,
                                null,
                            )
                        ),
                        listOf(OriginStorage("https://www.example.com", listOf(listOf("key", "值")))),
                    ),
                ),
        )

    private fun fixture() = File(requireNotNull(System.getProperty("fixture.path")))

    private fun url64(bytes: ByteArray) =
        Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    @Test
    fun sealDeviceMessage() {
        val json = ContractJson.encodeToString(message)
        val bytes = Envelope.seal(json, device, control.publicKey)
        assertEquals(json, Envelope.open(bytes, control, device.publicKey))
        assertEquals(2, bytes[4].toInt())
        assertArrayEquals(device.publicKey, bytes.copyOfRange(13, 45))
    }

    /**
     * Sealing is randomized, so the committed fixture is written once (delete it to regenerate)
     * and afterwards only checked against the current keys and message.
     */
    @Test
    fun deviceFixtureMatches() {
        val file = fixture()
        if (!file.exists()) {
            val bytes = Envelope.seal(ContractJson.encodeToString(message), device, control.publicKey)
            val fixture = buildJsonObject {
                put("controlPrivate", url64(control.privateKey))
                put("controlPublic", url64(control.publicKey))
                put("controlKeyId", control.id)
                put("devicePrivate", url64(device.privateKey))
                put("devicePublic", url64(device.publicKey))
                put("deviceKeyId", device.id)
                put("envelope", Base64.getEncoder().encodeToString(bytes))
                put("message", ContractJson.encodeToJsonElement(message))
            }
            file.writeText(prettyJson.encodeToString(fixture) + "\n", Charsets.UTF_8)
        }
        val fixture = ContractJson.parseToJsonElement(file.readText(Charsets.UTF_8)).jsonObject
        assertEquals(url64(control.publicKey), fixture.getValue("controlPublic").jsonPrimitive.content)
        assertEquals(url64(device.publicKey), fixture.getValue("devicePublic").jsonPrimitive.content)
        assertEquals(ContractJson.encodeToJsonElement(message), fixture.getValue("message"))
        val envelope =
            Base64.getDecoder().decode(fixture.getValue("envelope").jsonPrimitive.content)
        assertEquals(
            ContractJson.parseToJsonElement(Envelope.open(envelope, control, device.publicKey)),
            fixture.getValue("message"),
        )
    }

    @Test
    fun openControlFixture() {
        val file = File(fixture().parentFile, "control-message-fixture.json")
        assertTrue("Control task must generate control-message-fixture.json", file.exists())
        val fixture = ContractJson.parseToJsonElement(file.readText(Charsets.UTF_8)).jsonObject
        val envelope =
            Base64.getDecoder().decode(fixture.getValue("envelope").jsonPrimitive.content)
        val json = Envelope.open(envelope, device, control.publicKey)
        val decoded = ContractJson.decodeFromString<ControlMessage>(json)
        decoded.validate()
        assertEquals(fixture.getValue("message"), ContractJson.parseToJsonElement(json))
    }

    @Test
    fun rejectsUnauthenticatedEnvelopes() {
        val bytes = Envelope.seal(ContractJson.encodeToString(message), device, control.publicKey)
        assertThrows(IllegalArgumentException::class.java) {
            Envelope.open(bytes, device, control.publicKey)
        }
        assertThrows(IllegalArgumentException::class.java) {
            Envelope.open(bytes, control, control.publicKey)
        }
        for (offset in listOf(0, 4, 5, 13, 45, 77, bytes.lastIndex)) {
            val damaged = bytes.copyOf()
            damaged[offset] = (damaged[offset].toInt() xor 1).toByte()
            assertThrows(Exception::class.java) {
                Envelope.open(damaged, control, device.publicKey)
            }
        }
        assertThrows(IllegalArgumentException::class.java) {
            Envelope.open(ByteArray(Envelope.MAX_ENVELOPE + 1), control, device.publicKey)
        }
        assertThrows(IllegalArgumentException::class.java) {
            Envelope.compressed("x".repeat(Envelope.MAX_PLAINTEXT + 1))
        }
    }

    @Test
    fun decompressionIsBounded() {
        val compressed = ByteArrayOutputStream()
        GZIPOutputStream(compressed).use { gzip ->
            val buffer = ByteArray(8192) { 32 }
            repeat(Envelope.MAX_PLAINTEXT / buffer.size + 1) { gzip.write(buffer) }
        }
        val id = device.id.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        val aad = "RKSI".toByteArray() + byteArrayOf(2) + id + control.publicKey
        val hpke = Hpke.suite()
        val context =
            hpke.setupAuthS(hpke.deserializePublicKey(device.publicKey), Hpke.info, control.pair)
        val envelope = aad + context.encapsulation + context.seal(aad, compressed.toByteArray())
        assertThrows(IllegalArgumentException::class.java) {
            Envelope.open(envelope, device, control.publicKey)
        }
    }

    @Test
    fun validatesMessageRangesAndPairFields() {
        message.validate()
        val pair = message.events.first() as DeviceEvent.Pair
        listOf(
                pair.copy(username = ""),
                pair.copy(username = "x".repeat(65)),
                pair.copy(password = ""),
                pair.copy(password = "x".repeat(257)),
                pair.copy(device = "x".repeat(65)),
                pair.copy(code = listOf("abandon")),
            )
            .forEach { invalid ->
                assertThrows(IllegalArgumentException::class.java) { invalid.validate() }
            }
        assertThrows(IllegalArgumentException::class.java) { message.copy(v = 1).validate() }
        assertThrows(IllegalArgumentException::class.java) { message.copy(ack = -1).validate() }
        assertThrows(IllegalArgumentException::class.java) {
            message.copy(events = listOf(pair.copy(seq = 0))).validate()
        }
        assertThrows(IllegalArgumentException::class.java) {
            message.copy(events = listOf(pair, pair.copy(seq = 3))).validate()
        }
        assertThrows(IllegalArgumentException::class.java) {
            ControlMessage(ack = 0, events = listOf(ControlEvent.PairRejected(1, 1, 1, "bad")))
                .validate()
        }
        assertThrows(IllegalArgumentException::class.java) {
            ControlMessage(
                    ack = 0,
                    events = listOf(ControlEvent.Revoked(1, 1), ControlEvent.Revoked(3, 1)),
                )
                .validate()
        }
    }

    @Test
    fun authKemKnownAnswer() {
        val vector =
            ContractJson.parseToJsonElement(
                    File(fixture().parentFile, "hpke-auth-vector.json").readText()
                )
                .jsonObject
        fun bytes(name: String): ByteArray =
            vector
                .getValue(name)
                .jsonPrimitive
                .content
                .chunked(2)
                .map { it.toInt(16).toByte() }
                .toByteArray()
        fun key(name: String): AsymmetricCipherKeyPair {
            val private = X25519PrivateKeyParameters(bytes(name))
            return AsymmetricCipherKeyPair(private.generatePublicKey(), private)
        }
        val kemClass = Class.forName("org.bouncycastle.crypto.hpke.DHKEM")
        val constructor =
            kemClass.getDeclaredConstructor(Short::class.javaPrimitiveType).apply {
                isAccessible = true
            }
        val kem = constructor.newInstance(0x20.toShort())
        val ephemeral = key("skEm")
        kemClass
            .getDeclaredField("kpGen")
            .apply { isAccessible = true }
            .set(
                kem,
                object : AsymmetricCipherKeyPairGenerator {
                    override fun init(parameters: KeyGenerationParameters) {}

                    override fun generateKeyPair() = ephemeral
                },
            )
        val parameter = Class.forName("org.bouncycastle.crypto.params.AsymmetricKeyParameter")
        val encap =
            kemClass
                .getDeclaredMethod("AuthEncap", parameter, AsymmetricCipherKeyPair::class.java)
                .apply { isAccessible = true }
        @Suppress("UNCHECKED_CAST")
        val result =
            encap.invoke(kem, X25519PublicKeyParameters(bytes("pkRm")), key("skSm"))
                as Array<ByteArray>
        assertArrayEquals(bytes("sharedSecret"), result[0])
        assertArrayEquals(bytes("enc"), result[1])
        val decap =
            kemClass
                .getDeclaredMethod(
                    "AuthDecap",
                    ByteArray::class.java,
                    AsymmetricCipherKeyPair::class.java,
                    parameter,
                )
                .apply { isAccessible = true }
        assertArrayEquals(
            bytes("sharedSecret"),
            decap.invoke(kem, bytes("enc"), key("skRm"), X25519PublicKeyParameters(bytes("pkSm")))
                as ByteArray,
        )
    }
}
