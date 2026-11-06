package app.remotekit.importer

import app.remotekit.importer.crypto.EnvelopeSealer
import app.remotekit.importer.deployment.*
import app.remotekit.importer.payload.*
import app.remotekit.importer.store.AppSnapshot
import app.remotekit.importer.store.Draft
import app.remotekit.importer.store.DraftState
import app.remotekit.importer.store.SiteRef
import app.remotekit.importer.store.StoredAccount
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
    private val deployment =
        Deployment(
            v = 1,
            server = "rk.example.com:8443",
            mailbox = "import@example.com",
            key = DeploymentKey(sha256Hex(publicBytes).take(16), url64(publicBytes)),
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
            username = "student",
            password = "test-password",
            device = "测试手机",
            sites =
                listOf(
                    ImportSite("示例站点", "https://www.example.com/account"),
                    ImportSite("示例论坛", "https://forum.example.org/"),
                ),
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
    fun validDeployment() {
        assertEquals(deployment, DeploymentConfig.parse(config(deployment)))
    }

    @Test
    fun wrongKeyId() {
        rejects {
            DeploymentConfig.parse(
                config(deployment.copy(key = deployment.key.copy(id = "0000000000000000")))
            )
        }
    }

    @Test
    fun malformedDeployments() {
        rejects {
            DeploymentConfig.parse(
                config(deployment.copy(browser = deployment.browser.copy(mobile = true)))
            )
        }
        rejects {
            DeploymentConfig.parse(config(deployment.copy(mailbox = "Alice <import@example.com>")))
        }
        rejects { DeploymentConfig.parse(config(deployment.copy(v = 2))) }
    }

    @Test
    fun strictDeploymentConfig() {
        val json = ContractJson.encodeToJsonElement(deployment).jsonObject
        rejects {
            DeploymentConfig.parse(config(deployment.copy(server = "https://rk.example.com")))
        }
        rejects {
            DeploymentConfig.parse(
                config(deployment.copy(key = deployment.key.copy(x25519 = "AA")))
            )
        }
        rejects {
            DeploymentConfig.parse(
                config(deployment.copy(key = deployment.key.copy(x25519 = url64(ByteArray(32)))))
            )
        }
        rejects {
            DeploymentConfig.parse(
                config(
                    deployment.copy(key = deployment.key.copy(x25519 = deployment.key.x25519 + "="))
                )
            )
        }
        rejects { DeploymentConfig.parse(ByteArray(65537) { 32 }) }
        rejects {
            DeploymentConfig.parse(
                ContractJson.encodeToString(JsonObject(json + ("extra" to JsonPrimitive(true))))
                    .toByteArray()
            )
        }
        rejects {
            DeploymentConfig.parse(
                ContractJson.encodeToString(JsonObject(json - "browser")).toByteArray()
            )
        }
        assertThrows(java.nio.charset.CharacterCodingException::class.java) {
            DeploymentConfig.parse(byteArrayOf(0xc3.toByte(), 0x28))
        }
    }

    @Test
    fun accountRevisionRequiresReexport() {
        val snapshot =
            AppSnapshot(
                account = StoredAccount("student", "encrypted"),
                accountRevision = 1,
                deviceName = "phone",
            )
        val draft =
            Draft(
                payload.id,
                payload.createdAt,
                sites = payload.sites.map { SiteRef(it.name, it.url) },
                state = DraftState.Ready(deployment.key.id, 1),
            )
        assertTrue(draft.isCurrent(deployment, snapshot))
        assertFalse(draft.isCurrent(deployment, snapshot.copy(accountRevision = 2)))
        assertFalse(draft.isCurrent(deployment, snapshot.copy(account = null)))
        assertFalse(
            draft.isCurrent(
                deployment.copy(key = deployment.key.copy(id = "0000000000000000")),
                snapshot,
            )
        )
        assertFalse(draft.copy(state = DraftState.LoggingIn).isCurrent(deployment, snapshot))
        val restored = ContractJson.decodeFromString<Draft>(ContractJson.encodeToString(draft))
        assertTrue(restored.isCurrent(deployment, snapshot))
        assertFalse(ContractJson.encodeToString(draft).contains(payload.password))
    }

    @Test
    fun payloadShape() {
        val expected =
            """{
          "v":1,"id":"bf81f466-e992-48e5-a3d3-6b168556c471","createdAt":1793900000000,
          "username":"student","password":"test-password","device":"测试手机",
          "sites":[{"name":"示例站点","url":"https://www.example.com/account"},{"name":"示例论坛","url":"https://forum.example.org/"}],
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
        val envelope = EnvelopeSealer().seal(payload, deployment)
        assertArrayEquals("RKSI".toByteArray(), envelope.copyOfRange(0, 4))
        assertEquals(1, envelope[4].toInt())
        assertEquals(
            deployment.key.id,
            envelope.copyOfRange(5, 13).joinToString("") { "%02x".format(it.toInt() and 255) },
        )
        assertEquals(
            ContractJson.encodeToJsonElement(payload),
            ContractJson.parseToJsonElement(open(envelope)),
        )
    }

    @Test
    fun headerAndCiphertextTamperingFails() {
        val envelope = EnvelopeSealer().seal(payload, deployment)
        listOf(0, 4, 5, 12, 13, 44, 45, envelope.lastIndex).forEach { index ->
            val changed = envelope.clone()
            changed[index] = (changed[index].toInt() xor 1).toByte()
            assertThrows(InvalidCipherTextException::class.java) { open(changed) }
        }
    }

    @Test
    fun limits() {
        payload.validate()
        payload.copy(username = "u".repeat(64), password = "p".repeat(256)).validate()
        payload.copy(username = "u", password = "p").validate()
        payload
            .copy(username = "\uD83D\uDE00".repeat(64), password = "\uD83D\uDE00".repeat(256))
            .validate()
        rejects { payload.copy(username = "").validate() }
        rejects { payload.copy(password = "").validate() }
        rejects { payload.copy(username = "u".repeat(65)).validate() }
        rejects { payload.copy(password = "p".repeat(257)).validate() }
        val cookie = payload.cookies.single()
        payload
            .copy(cookies = List(4096) { cookie.copy(name = "n", value = "a".repeat(4095)) })
            .validate()
        rejects { payload.copy(cookies = List(4097) { cookie }).validate() }
        rejects { payload.copy(cookies = listOf(cookie.copy(value = "é".repeat(2049)))).validate() }
        rejects { payload.copy(device = "a".repeat(65)).validate() }
        val site = payload.sites.first()
        rejects { payload.copy(sites = listOf(site.copy(name = "a".repeat(129)))).validate() }
        rejects { payload.copy(sites = listOf(site.copy(url = "file:///secret"))).validate() }
        rejects { payload.copy(sites = emptyList()).validate() }
        rejects { payload.copy(sites = listOf(site, site)).validate() }
        rejects {
            payload
                .copy(sites = List(17) { site.copy(url = "https://s$it.example.com/") })
                .validate()
        }
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
        val escaped = listOf("k", "\u0000".repeat(44000))
        rejects {
            payload
                .copy(localStorage = listOf(OriginStorage("https://example.com", listOf(escaped))))
                .validate()
        }
        val boundary = listOf("k", "v".repeat(256 * 1024 - 8))
        payload
            .copy(localStorage = listOf(OriginStorage("https://example.com", listOf(boundary))))
            .validate()
        rejects {
            payload
                .copy(
                    localStorage =
                        listOf(
                            OriginStorage(
                                "https://example.com",
                                listOf(listOf("k", boundary[1] + "v")),
                            )
                        )
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
        rejects { EnvelopeSealer().seal(largePayload, deployment) }
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
        rejects { EnvelopeSealer().seal(payload.copy(localStorage = uncompressible), deployment) }
    }

    @Test
    fun writeCrossImplementationFixture() {
        val envelope = EnvelopeSealer().seal(payload, deployment)
        val fixture = buildJsonObject {
            put("recipientPrivate", url64(privateBytes))
            put("recipientPublic", url64(publicBytes))
            put("keyId", deployment.key.id)
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

    private fun config(value: Deployment): ByteArray =
        ContractJson.encodeToString(value).toByteArray(Charsets.UTF_8)

    private fun url64(bytes: ByteArray): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
}
