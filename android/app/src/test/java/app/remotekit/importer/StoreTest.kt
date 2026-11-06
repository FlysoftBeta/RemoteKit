package app.remotekit.importer

import app.remotekit.importer.crypto.*
import app.remotekit.importer.deployment.ContractJson
import app.remotekit.importer.mail.Outbox
import app.remotekit.importer.payload.*
import app.remotekit.importer.protocol.*
import app.remotekit.importer.store.*
import java.io.File
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class StoreTest {
    @get:Rule val temporary = TemporaryFolder()
    private val control = DeviceKey(ByteArray(32) { (it + 1).toByte() })
    private val payload =
        ImportPayload(
            "bf81f466-e992-48e5-a3d3-6b168556c471",
            listOf(ImportSite("Site", "https://example.com/")),
            emptyList(),
            emptyList(),
        )
    private val sites = listOf(SiteRef("Site", "https://example.com/"))
    private val words = listOf("abandon", "ability", "able", "about", "above")

    private class TestCipher : BlobCipher {
        var key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

        override fun encrypt(bytes: ByteArray): ByteArray {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key)
            return cipher.iv + cipher.doFinal(bytes)
        }

        override fun decrypt(bytes: ByteArray): ByteArray {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            return cipher.doFinal(bytes.copyOfRange(12, bytes.size))
        }

        override fun deleteKey() {
            key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        }
    }

    private fun store() = AppStore(temporary.newFolder(), TestCipher(), "phone", control.publicKey)

    private fun pair(store: AppStore) {
        store.pair("student", "secret-password", words, "phone", 1000)
    }

    private fun paired(store: AppStore) {
        store.receive(
            ControlMessage(ack = 1, events = listOf(ControlEvent.Paired(1, 2000, 1, "student")))
        )
    }

    @Test
    fun gateAndPairingTransitions() {
        val store = store()
        assertFalse(store.authorized())
        assertThrows(IllegalStateException::class.java) { store.addImport(payload, sites) }
        pair(store)
        assertTrue(store.authorized())
        store.addImport(payload, sites)
        store.receive(
            ControlMessage(
                ack = 0,
                events = listOf(ControlEvent.PairRejected(0, 3000, 1, "rejected")),
            )
        )
        assertEquals(Pairing.Unpaired("rejected"), store.snapshot.value.pairing)
        assertFalse(store.authorized())
        assertNull(store.snapshot.value.pairBlob)
        assertTrue(store.snapshot.value.retryable(payload.id))
        assertThrows(IllegalStateException::class.java) { store.retry(payload.id) }
        store.pair("student", "secret-password", words, "phone")
        store.retry(payload.id)
        store.receive(
            ControlMessage(ack = 4, events = listOf(ControlEvent.Paired(1, 4000, 3, "student")))
        )
        assertEquals(Pairing.Paired("student"), store.snapshot.value.pairing)
        store.receive(ControlMessage(ack = 4, events = listOf(ControlEvent.Revoked(2, 5000))))
        assertFalse(store.authorized())
        assertEquals(Pairing.Revoked, store.snapshot.value.pairing)
    }

    @Test
    fun gapsSurviveRestartAndDuplicatesAreIgnored() {
        val dir = temporary.newFolder()
        val cipher = TestCipher()
        var store = AppStore(dir, cipher, "phone", control.publicKey)
        pair(store)
        store.addImport(payload, sites)
        val applied =
            ControlMessage(
                ack = 2,
                events =
                    listOf(
                        ControlEvent.ImportApplied(
                            3,
                            5000,
                            2,
                            payload.id,
                            Counts(1, 0),
                            Counts(2, 1),
                        )
                    ),
            )
        assertFalse(store.receive(applied))
        assertEquals(0L, store.snapshot.value.appliedControlSeq)
        assertEquals(0L, store.snapshot.value.ackedByControl)
        store = AppStore(dir, cipher, "phone", control.publicKey)
        paired(store)
        store.receive(
            ControlMessage(
                ack = 2,
                events = listOf(ControlEvent.ImportReceived(2, 4000, 2, payload.id)),
            )
        )
        assertEquals(3L, store.snapshot.value.appliedControlSeq)
        assertEquals(RequestStatus.Applied, store.snapshot.value.status(payload.id))
        assertNull(store.snapshot.value.requests.single().payloadBlob)
        assertTrue(store.snapshot.value.buffered.isEmpty())
        assertTrue(store.receive(applied))
        assertEquals(3, store.snapshot.value.controlEvents.size)
    }

    @Test
    fun seqZeroRejectionBypassesGapsAndOnlyMatchesInFlightPair() {
        val store = store()
        pair(store)
        store.receive(ControlMessage(ack = 0, events = listOf(ControlEvent.Revoked(5, 1000))))
        store.receive(
            ControlMessage(
                ack = 0,
                events = listOf(ControlEvent.PairRejected(0, 2000, 9, "wrong-ref")),
            )
        )
        assertTrue(store.authorized())
        val rejection =
            ControlMessage(
                ack = 0,
                events = listOf(ControlEvent.PairRejected(0, 2000, 1, "failed")),
            )
        store.receive(rejection)
        store.receive(rejection)
        assertEquals(0L, store.snapshot.value.appliedControlSeq)
        assertEquals(1, store.snapshot.value.controlEvents.size)
        assertEquals(Pairing.Unpaired("failed"), store.snapshot.value.pairing)
    }

    @Test
    fun failureRetryAndDiscardRemovePayload() {
        val store = store()
        pair(store)
        paired(store)
        store.addImport(payload, sites)
        store.receive(
            ControlMessage(
                ack = 2,
                events = listOf(ControlEvent.ImportFailed(2, 3000, 2, payload.id, "busy", true)),
            )
        )
        assertTrue(store.snapshot.value.retryable(payload.id))
        store.retry(payload.id)
        assertEquals(
            payload.id,
            store.event(store.snapshot.value.outgoing.last()).let { it as DeviceEvent.Import }.id,
        )
        store.receive(
            ControlMessage(
                ack = 3,
                events = listOf(ControlEvent.ImportDiscarded(3, 4000, 3, payload.id)),
            )
        )
        assertNull(store.snapshot.value.requests.single().payloadBlob)
        assertFalse(store.snapshot.value.retryable(payload.id))
    }

    @Test
    fun deletionKeepsImmutableWireSequenceThenWithdraws() {
        val store = store()
        pair(store)
        store.addImport(payload, sites)
        store.deleteRequest(payload.id)
        assertTrue(store.snapshot.value.requests.isEmpty())
        assertEquals(
            listOf(1L, 2L, 3L),
            Outbox.messages(store, control.publicKey, 1000, true).flatMap { it.sequences },
        )
        val mails = Outbox.messages(store, control.publicKey, 1000, true)
        val events =
            mails.flatMap {
                ContractJson.decodeFromString<DeviceMessage>(
                        Envelope.open(it.envelope, control, store.deviceKey().publicKey)
                    )
                    .events
            }
        assertTrue(events[1] is DeviceEvent.Import)
        assertTrue(events[2] is DeviceEvent.Withdraw)
    }

    @Test
    fun stateContainsNoSecretsAndResetRotatesKey() {
        val dir = temporary.newFolder()
        val cipher = TestCipher()
        val store = AppStore(dir, cipher, "phone", control.publicKey)
        pair(store)
        store.addImport(
            payload.copy(
                cookies =
                    listOf(
                        ImportCookie(
                            "SID",
                            "cookie-secret",
                            "example.com",
                            "/",
                            true,
                            true,
                            true,
                            SameSite.Lax,
                            null,
                        )
                    )
            ),
            sites,
        )
        assertFalse(File(dir, "state.json").readText().contains("secret"))
        dir.walkTopDown()
            .filter { it.isFile }
            .forEach {
                assertFalse(it.readBytes().toString(Charsets.UTF_8).contains("secret-password"))
                assertFalse(it.readBytes().toString(Charsets.UTF_8).contains("cookie-secret"))
            }
        val id = store.deviceKey().id
        store.clearAll()
        assertNotEquals(id, store.deviceKey().id)
        assertEquals(Pairing.Unpaired(), store.snapshot.value.pairing)
        assertTrue(store.snapshot.value.requests.isEmpty())
    }

    @Test
    fun v1StateIsDiscarded() {
        val dir = temporary.newFolder()
        File(dir, "state.json")
            .writeText("""{"drafts":[{"id":"old"}],"account":{"username":"old"}}""")
        File(dir, "envelopes").mkdir()
        File(dir, "envelopes/old.rksi").writeText("old")
        val store = AppStore(dir, TestCipher(), "phone", control.publicKey)
        assertFalse(File(dir, "envelopes").exists())
        assertEquals(2, store.snapshot.value.v)
        assertTrue(store.snapshot.value.outgoing.isEmpty())
    }

    @Test
    fun outboxSchedulingResendAndEmptySync() {
        assertEquals(60, Outbox.delaySeconds(SendMode.Window()))
        assertEquals(0, Outbox.delaySeconds(SendMode.Window(0)))
        assertEquals(300, Outbox.delaySeconds(SendMode.Window(300)))
        assertNull(Outbox.delaySeconds(SendMode.Series))
        val store = store()
        pair(store)
        store.sent(setOf(1), 1000)
        store.addImport(payload, sites, 2000)
        assertEquals(listOf(2L), Outbox.select(store.snapshot.value, 3_600_999).map { it.seq })
        assertEquals(listOf(1L, 2L), Outbox.select(store.snapshot.value, 3_601_000).map { it.seq })
        assertEquals(listOf(1L, 2L), Outbox.select(store.snapshot.value, 2000, true).map { it.seq })
        paired(store)
        store.receive(ControlMessage(ack = 2, events = emptyList()))
        val mails = Outbox.messages(store, control.publicKey, 3000, true)
        assertEquals(1, mails.size)
        val message =
            ContractJson.decodeFromString<DeviceMessage>(
                Envelope.open(mails.single().envelope, control, store.deviceKey().publicKey)
            )
        assertTrue(message.events.isEmpty())
        assertEquals(1L, message.ack)
        assertTrue(Outbox.messages(store, control.publicKey, 3000, false).isEmpty())
    }

    @Test
    fun splittingPreservesContiguousRanges() {
        val events = (1L..7L).map { DeviceEvent.Withdraw(it, 1000, payload.id) }
        val split = Outbox.split(events, 9) { it.events.size <= 3 }
        assertEquals(
            listOf(listOf(1L, 2L, 3L), listOf(4L, 5L, 6L), listOf(7L)),
            split.map { it.events.map { event -> event.seq } },
        )
        assertTrue(split.all { it.ack == 9L })
        assertThrows(IllegalArgumentException::class.java) { Outbox.split(events, 0) { false } }
    }
}
