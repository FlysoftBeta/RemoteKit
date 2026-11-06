package app.remotekit.importer

import app.remotekit.importer.crypto.EnvelopeSealer
import app.remotekit.importer.pairing.*
import app.remotekit.importer.payload.*
import java.io.ByteArrayInputStream
import java.io.File
import java.util.Base64
import java.util.zip.GZIPInputStream
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.bouncycastle.crypto.InvalidCipherTextException
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.junit.Assert.*
import org.junit.Test

class ContractTest {
    private val fixtureJson = Json { prettyPrint = true }
    private val privateBytes = ByteArray(32) { (it + 1).toByte() }
    private val publicBytes = X25519PrivateKeyParameters(privateBytes).generatePublicKey().encoded
    private val pairing =
        Pairing(
            v = 1,
            server = "rk.example.com:8443",
            user = "student",
            mailbox = "import@example.com",
            key = PairingKey(sha256Hex(publicBytes).take(16), url64(publicBytes)),
            token = url64(ByteArray(32) { 42 }),
            browser =
                BrowserIdentity(
                    userAgent =
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/157.0.0.0 Safari/537.36",
                    platform = "Windows",
                    platformVersion = "19.0.0",
                    architecture = "x86",
                    bitness = "64",
                    wow64 = false,
                    model = "",
                    mobile = false,
                    brands = listOf(Brand("Google Chrome", "157"), Brand("Not=A?Brand", "24")),
                    fullVersionList =
                        listOf(
                            Brand("Google Chrome", "157.0.8103.15"),
                            Brand("Not=A?Brand", "24.0.0.0"),
                        ),
                ),
        )
    private val payload =
        ImportPayload(
            id = "bf81f466-e992-48e5-a3d3-6b168556c471",
            createdAt = 1793900000000,
            token = pairing.token,
            device = "测试手机",
            site = ImportSite("示例站点", "https://www.example.com/account"),
            cookies =
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
            localStorage =
                listOf(OriginStorage("https://www.example.com", listOf(listOf("key", "值")))),
        )

    @Test
    fun validPairing() {
        assertEquals(pairing, PairingCode.parse(code(pairing)))
    }

    @Test
    fun wrongPrefix() {
        rejects { PairingCode.parse(code(pairing).replaceFirst("RKP1:", "RKP2:")) }
    }

    @Test
    fun wrongKeyId() {
        rejects {
            PairingCode.parse(code(pairing.copy(key = pairing.key.copy(id = "0000000000000000"))))
        }
    }

    @Test
    fun malformedPairings() {
        rejects { PairingCode.parse(code(pairing) + "=") }
        rejects { PairingCode.parse(code(pairing.copy(token = "AA"))) }
        rejects {
            PairingCode.parse(code(pairing.copy(browser = pairing.browser.copy(mobile = true))))
        }
        rejects { PairingCode.parse(code(pairing.copy(mailbox = "Alice <import@example.com>"))) }
        rejects { PairingCode.parse(code(pairing.copy(v = 2))) }
    }

    @Test
    fun payloadShape() {
        val expected =
            """{
          "v":1,"id":"bf81f466-e992-48e5-a3d3-6b168556c471","createdAt":1793900000000,
          "token":"${pairing.token}","device":"测试手机",
          "site":{"name":"示例站点","url":"https://www.example.com/account"},
          "cookies":[{"name":"SID","value":"secret","domain":".example.com","path":"/",
            "hostOnly":false,"secure":true,"httpOnly":true,"sameSite":"lax","expires":null}],
          "localStorage":[{"origin":"https://www.example.com","items":[["key","值"]]}]
        }"""
        assertEquals(
            ContractJson.parseToJsonElement(expected),
            ContractJson.encodeToJsonElement(payload),
        )
        assertEquals(
            payload,
            ContractJson.decodeFromString<ImportPayload>(ContractJson.encodeToString(payload)),
        )
        SameSite.entries.forEach {
            assertEquals(
                it.name.lowercase(),
                ContractJson.encodeToJsonElement(it).jsonPrimitive.content,
            )
        }
    }

    @Test
    fun envelopeRoundTrip() {
        val envelope = EnvelopeSealer().seal(payload, pairing)
        assertArrayEquals("RKSI".toByteArray(), envelope.copyOfRange(0, 4))
        assertEquals(1, envelope[4].toInt())
        assertEquals(
            pairing.key.id,
            envelope.copyOfRange(5, 13).joinToString("") { "%02x".format(it.toInt() and 255) },
        )
        assertEquals(
            ContractJson.encodeToJsonElement(payload),
            ContractJson.parseToJsonElement(open(envelope)),
        )
    }

    @Test
    fun headerAndCiphertextTamperingFails() {
        val envelope = EnvelopeSealer().seal(payload, pairing)
        listOf(0, 4, 5, 12, 13, 44, 45, envelope.lastIndex).forEach { index ->
            val changed = envelope.clone()
            changed[index] = (changed[index].toInt() xor 1).toByte()
            assertThrows(InvalidCipherTextException::class.java) { open(changed) }
        }
    }

    @Test
    fun limits() {
        payload.validate()
        val cookie = payload.cookies.single()
        payload
            .copy(cookies = List(4096) { cookie.copy(name = "n", value = "a".repeat(4095)) })
            .validate()
        rejects { payload.copy(cookies = List(4097) { cookie }).validate() }
        rejects { payload.copy(cookies = listOf(cookie.copy(value = "é".repeat(2049)))).validate() }
        rejects { payload.copy(device = "a".repeat(65)).validate() }
        rejects { payload.copy(site = payload.site.copy(name = "a".repeat(129))).validate() }
        rejects { payload.copy(site = payload.site.copy(url = "file:///secret")).validate() }
        rejects {
            payload
                .copy(localStorage = listOf(OriginStorage("https://example.com/", emptyList())))
                .validate()
        }
        rejects {
            payload
                .copy(localStorage = listOf(OriginStorage("https://example.com:443", emptyList())))
                .validate()
        }
        rejects {
            payload
                .copy(
                    localStorage =
                        listOf(OriginStorage("https://example.com", listOf(listOf("only"))))
                )
                .validate()
        }
        rejects {
            payload
                .copy(
                    localStorage =
                        listOf(
                            OriginStorage(
                                "https://example.com",
                                listOf(listOf("k", "v".repeat(256 * 1024))),
                            )
                        )
                )
                .validate()
        }
        rejects {
            payload
                .copy(
                    localStorage =
                        List(257) { OriginStorage("https://s$it.example.com", emptyList()) }
                )
                .validate()
        }
        val largeItems = List(41) { listOf(it.toString(), "v".repeat(256 * 1024 - 10)) }
        rejects {
            payload
                .copy(localStorage = listOf(OriginStorage("https://example.com", largeItems)))
                .validate()
        }
        val chunk = "v".repeat(256 * 1024 - 10)
        val largePayload =
            payload.copy(
                localStorage =
                    List(4) { origin ->
                        OriginStorage(
                            "https://s$origin.example.com",
                            List(40) { listOf(it.toString(), chunk) },
                        )
                    }
            )
        rejects { EnvelopeSealer().seal(largePayload, pairing) }
        val random = java.util.Random(9180)
        val uncompressible =
            List(3) { origin ->
                OriginStorage(
                    "https://r$origin.example.com",
                    List(40) {
                        val bytes = ByteArray(190000).also(random::nextBytes)
                        listOf(it.toString(), Base64.getEncoder().encodeToString(bytes))
                    },
                )
            }
        rejects { EnvelopeSealer().seal(payload.copy(localStorage = uncompressible), pairing) }
    }

    @Test
    fun writeCrossImplementationFixture() {
        val envelope = EnvelopeSealer().seal(payload, pairing)
        val fixture = buildJsonObject {
            put("recipientPrivate", url64(privateBytes))
            put("recipientPublic", url64(publicBytes))
            put("keyId", pairing.key.id)
            put("envelope", Base64.getEncoder().encodeToString(envelope))
            put("payload", ContractJson.encodeToJsonElement(payload))
        }
        val file = File(requireNotNull(System.getProperty("fixture.path")))
        requireNotNull(file.parentFile).mkdirs()
        file.writeText(fixtureJson.encodeToString(fixture) + "\n", Charsets.UTF_8)
        assertEquals(ContractJson.encodeToString(payload), open(envelope))
    }

    private fun open(envelope: ByteArray): String {
        val hpke = EnvelopeSealer.suite()
        val recipient = hpke.deserializePrivateKey(privateBytes, publicBytes)
        val compressed =
            hpke.open(
                envelope.copyOfRange(13, 45),
                recipient,
                EnvelopeSealer.INFO,
                envelope.copyOfRange(0, 13),
                envelope.copyOfRange(45, envelope.size),
                null,
                null,
                null,
            )
        return GZIPInputStream(ByteArrayInputStream(compressed)).use {
            it.readBytes().toString(Charsets.UTF_8)
        }
    }

    private fun rejects(block: () -> Unit) {
        assertThrows(IllegalArgumentException::class.java, block)
    }

    private fun code(value: Pairing): String =
        "RKP1:" + url64(ContractJson.encodeToString(value).toByteArray(Charsets.UTF_8))

    private fun url64(bytes: ByteArray): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
}
