package app.remotekit.importer

import app.remotekit.importer.deployment.*
import app.remotekit.importer.payload.*
import java.util.Base64
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.junit.Assert.*
import org.junit.Test

class ContractTest {
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
    fun validationLimits() {
        payload.validate()
        rejects { payload.copy(id = "bad").validate() }
        rejects { payload.copy(sites = emptyList()).validate() }
        rejects {
            payload
                .copy(sites = List(17) { ImportSite("site", "https://s$it.example.com") })
                .validate()
        }
        rejects {
            payload.copy(sites = listOf(payload.sites.first(), payload.sites.first())).validate()
        }
        rejects {
            payload
                .copy(sites = listOf(ImportSite("x".repeat(129), "https://example.com")))
                .validate()
        }
        rejects { payload.copy(sites = listOf(ImportSite("site", "file:///tmp"))).validate() }
        val cookie = payload.cookies.single()
        rejects { payload.copy(cookies = List(4097) { cookie }).validate() }
        rejects { payload.copy(cookies = listOf(cookie.copy(value = "x".repeat(4096)))).validate() }
        rejects { payload.copy(cookies = listOf(cookie.copy(hostOnly = true))).validate() }
        rejects { payload.copy(cookies = listOf(cookie.copy(expires = -1))).validate() }
        rejects { payload.copy(cookies = listOf(cookie.copy(path = "bad"))).validate() }
        rejects {
            payload
                .copy(
                    localStorage =
                        List(257) { OriginStorage("https://s$it.example.com", emptyList()) }
                )
                .validate()
        }
        rejects {
            payload.copy(localStorage = List(2) { payload.localStorage.single() }).validate()
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
                        listOf(OriginStorage("https://example.com", listOf(listOf("key"))))
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
                                listOf(listOf("key", "\\".repeat(131072))),
                            )
                        )
                )
                .validate()
        }
        val item = "x".repeat(256 * 1024 - 20)
        rejects {
            payload
                .copy(
                    localStorage =
                        listOf(
                            OriginStorage(
                                "https://example.com",
                                List(41) { listOf(it.toString(), item) },
                            )
                        )
                )
                .validate()
        }
    }

    private fun rejects(block: () -> Unit) {
        assertThrows(IllegalArgumentException::class.java, block)
    }

    private fun config(value: Deployment) =
        ContractJson.encodeToString(value).toByteArray(Charsets.UTF_8)

    private fun url64(bytes: ByteArray) =
        Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
}
