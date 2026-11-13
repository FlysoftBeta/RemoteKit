package app.remotekit.importer

import app.remotekit.importer.crypto.*
import app.remotekit.importer.deployment.ContractJson
import app.remotekit.importer.mail.Inbox
import app.remotekit.importer.mail.Outbox
import app.remotekit.importer.payload.*
import app.remotekit.importer.protocol.*
import app.remotekit.importer.store.*
import app.remotekit.importer.ui.AppActions
import app.remotekit.importer.ui.Screen
import app.remotekit.importer.ui.ScreenNavigation
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.SocketTimeoutException
import java.util.Properties
import javax.activation.DataHandler
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec
import javax.mail.Flags
import javax.mail.MessagingException
import javax.mail.Session
import javax.mail.internet.MimeMessage
import javax.mail.util.ByteArrayDataSource
import kotlinx.serialization.json.*
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
    private val sites = listOf(SiteRef("Site", "https://example.com/", null))
    private val words = listOf("abandon", "ability", "able", "about", "above")

    private class TestCipher : BlobCipher {
        var key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

        override fun encrypt(bytes: ByteArray): ByteArray {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key)
            return cipher.iv + cipher.doFinal(bytes)
        }

        var readFailure: Exception? = null

        override fun decrypt(bytes: ByteArray): ByteArray {
            readFailure?.let { throw it }
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
        val events = mails.flatMap {
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
        assertEquals(Pairing.Unpaired(null), store.snapshot.value.pairing)
        assertTrue(store.snapshot.value.requests.isEmpty())
    }

    private fun rejectedState(bytes: ByteArray) {
        val dir = temporary.newFolder()
        val state = File(dir, "state.json").apply { writeBytes(bytes) }
        val blob =
            File(dir, "blobs/retained").apply {
                requireNotNull(parentFile).mkdirs()
                writeText("retained")
            }
        val backup = File(dir, "state.json.bak").apply { writeText("backup") }
        val pending = File(dir, "state.json.new").apply { writeText("pending") }
        val error =
            assertThrows(LocalDataException::class.java) {
                AppStore(dir, TestCipher(), "phone", control.publicKey)
            }
        assertNotNull(error.cause)
        assertArrayEquals(bytes, state.readBytes())
        assertEquals("retained", blob.readText())
        assertEquals("backup", backup.readText())
        assertEquals("pending", pending.readText())
    }

    @Test
    fun unknownVersionsAndMissingFieldsPreserveState() {
        val dir = temporary.newFolder()
        AppStore(dir, TestCipher(), "phone", control.publicKey)
        val valid = ContractJson.parseToJsonElement(File(dir, "state.json").readText()).jsonObject
        for (version in listOf(1, 3)) {
            rejectedState(
                JsonObject(valid + ("v" to JsonPrimitive(version))).toString().toByteArray()
            )
        }
        for (field in valid.keys) {
            rejectedState(JsonObject(valid - field).toString().toByteArray())
        }
        for (field in listOf("pairing", "sendMode", "inbox", "device")) {
            val nested = valid.getValue(field).jsonObject
            for (key in nested.keys.filter { it != "type" }) {
                val changed = JsonObject(valid + (field to JsonObject(nested - key)))
                rejectedState(changed.toString().toByteArray())
            }
        }
    }

    @Test
    fun malformedStateAndUnknownFieldsPreserveState() {
        val dir = temporary.newFolder()
        AppStore(dir, TestCipher(), "phone", control.publicKey)
        val valid = ContractJson.parseToJsonElement(File(dir, "state.json").readText()).jsonObject
        rejectedState("{broken".toByteArray())
        rejectedState(byteArrayOf(0xc3.toByte(), 0x28))
        rejectedState(JsonObject(valid + ("unknown" to JsonPrimitive(1))).toString().toByteArray())
        rejectedState(
            JsonObject(valid + ("nextDeviceSeq" to JsonPrimitive(0))).toString().toByteArray()
        )
        rejectedState(
            JsonObject(valid + ("ackedByControl" to JsonPrimitive(1))).toString().toByteArray()
        )
        val inbox = JsonObject(valid.getValue("inbox").jsonObject + ("unknown" to JsonNull))
        rejectedState(JsonObject(valid + ("inbox" to inbox)).toString().toByteArray())
    }

    @Test
    fun missingNestedEventAndSiteFieldsPreserveState() {
        val dir = temporary.newFolder()
        val store = AppStore(dir, TestCipher(), "phone", control.publicKey)
        pair(store)
        store.addImport(payload, sites)
        val valid = ContractJson.parseToJsonElement(File(dir, "state.json").readText()).jsonObject
        val outgoing = valid.getValue("outgoing").jsonArray
        val event = outgoing.first().jsonObject
        for (field in event.keys) {
            val events = JsonArray(listOf(JsonObject(event - field)) + outgoing.drop(1))
            rejectedState(JsonObject(valid + ("outgoing" to events)).toString().toByteArray())
        }
        val requests = valid.getValue("requests").jsonArray
        val request = requests.single().jsonObject
        val site = request.getValue("sites").jsonArray.single().jsonObject
        val changed =
            JsonObject(request + ("sites" to JsonArray(listOf(JsonObject(site - "icon")))))
        rejectedState(
            JsonObject(valid + ("requests" to JsonArray(listOf(changed)))).toString().toByteArray()
        )
    }

    @Test
    fun unreadableStateIsPreserved() {
        val dir = temporary.newFolder()
        val state = File(dir, "state.json").apply { mkdir() }
        val retained = File(state, "retained").apply { writeText("retained") }
        val blob =
            File(dir, "blobs/retained").apply {
                requireNotNull(parentFile).mkdirs()
                writeText("blob")
            }
        assertThrows(LocalDataException::class.java) {
            AppStore(dir, TestCipher(), "phone", control.publicKey)
        }
        assertEquals("retained", retained.readText())
        assertEquals("blob", blob.readText())
    }

    private fun mail(bytes: ByteArray): MimeMessage =
        MimeMessage(Session.getInstance(Properties())).apply {
            setHeader("X-RemoteKit-Import", "2")
            dataHandler = DataHandler(ByteArrayDataSource(bytes, "application/octet-stream"))
            fileName = "reply.rksi"
        }

    @Test
    fun invalidMailIsDeletedAndValidRepliesAreDecoded() {
        val store = store()
        val inbox = Inbox(store, control.publicKey)
        val json = """{"v":2,"ack":0,"events":[]}"""
        val envelope = Envelope.seal(json, control, store.deviceKey().publicKey)
        val valid = mail(envelope)
        assertEquals(ControlMessage(ack = 0, events = emptyList()), inbox.readMessage(valid))
        assertFalse(valid.isSet(Flags.Flag.DELETED))
        val invalid =
            listOf(
                mail(byteArrayOf(1, 2)),
                mail(
                    envelope.copyOf().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }
                ),
                mail(Envelope.seal(json, control, control.publicKey)),
                mail(Envelope.seal(json, store.deviceKey(), store.deviceKey().publicKey)),
                mail(Envelope.seal("{}", control, store.deviceKey().publicKey)),
                mail(envelope).apply { setHeader("X-RemoteKit-Import", "1") },
            )
        for (message in invalid) {
            assertNull(inbox.readMessage(message))
            assertTrue(message.isSet(Flags.Flag.DELETED))
        }
    }

    @Test
    fun headerAttachmentAndKeyReadFailuresKeepMailAndPropagate() {
        val dir = temporary.newFolder()
        val cipher = TestCipher()
        val store = AppStore(dir, cipher, "phone", control.publicKey)
        val inbox = Inbox(store, control.publicKey)
        val headerError = MessagingException("IMAP header read", SocketTimeoutException("timeout"))
        val header =
            object : MimeMessage(Session.getInstance(Properties())) {
                override fun getHeader(name: String): Array<String>? = throw headerError
            }
        assertSame(
            headerError,
            assertThrows(MessagingException::class.java) { inbox.readMessage(header) },
        )
        assertFalse(header.isSet(Flags.Flag.DELETED))
        for (failure in listOf(IOException("attachment read"), SocketTimeoutException("timeout"))) {
            val attachment =
                object : MimeMessage(Session.getInstance(Properties())) {
                        override fun getInputStream(): InputStream =
                            object : InputStream() {
                                override fun read(): Int = throw failure
                            }
                    }
                    .apply {
                        setHeader("X-RemoteKit-Import", "2")
                        fileName = "reply.rksi"
                    }
            assertSame(
                failure,
                assertThrows(IOException::class.java) { inbox.readMessage(attachment) },
            )
            assertFalse(attachment.isSet(Flags.Flag.DELETED))
        }
        val message =
            mail(
                Envelope.seal(
                    """{"v":2,"ack":0,"events":[]}""",
                    control,
                    store.deviceKey().publicKey,
                )
            )
        val keyError = IllegalStateException("key unavailable")
        cipher.readFailure = keyError
        assertSame(
            keyError,
            assertThrows(IllegalStateException::class.java) { inbox.readMessage(message) },
        )
        assertFalse(message.isSet(Flags.Flag.DELETED))
    }

    @Test
    fun timelineDeletionReportsWriteFailureAndPreservesEvents() {
        val dir = temporary.newFolder()
        val store = AppStore(dir, TestCipher(), "phone", control.publicKey)
        pair(store)
        store.addImport(payload, sites)
        store.deleteRequest(payload.id)
        val state = store.snapshot.value
        val bytes = File(dir, "state.json").readBytes()
        val failures = mutableListOf<Exception>()
        val actions = AppActions(store) { failures.add(it) }
        val blocked = File(dir, "state.json.new").apply { mkdir() }
        for (event in state.outgoing.filter { it.type in setOf("pair", "withdraw") }) {
            actions.hideEvent(event.seq)
            assertEquals(state, store.snapshot.value)
            assertArrayEquals(bytes, File(dir, "state.json").readBytes())
        }
        assertEquals(2, failures.size)
        assertTrue(failures.all { it is IOException })
        assertTrue(blocked.delete())
        actions.hideEvent(1)
        actions.hideEvent(3)
        assertTrue(store.snapshot.value.outgoing.filter { it.type != "import" }.all { it.hidden })
        assertEquals(2, failures.size)
    }

    @Test
    fun loginProfileEndsOnlyWhenTheScreenChanges() {
        val released = mutableListOf<String>()
        val navigation = ScreenNavigation { released.add(it) }
        navigation.navigate(Screen.Login("first"))
        assertEquals(Screen.Login("first"), navigation.screen.value)
        navigation.navigate(Screen.Login("first"))
        assertTrue(released.isEmpty())
        navigation.navigate(Screen.Home)
        navigation.navigate(Screen.Home)
        assertEquals(listOf("first"), released)
        navigation.navigate(Screen.Login("second"))
        navigation.navigate(Screen.Settings)
        assertEquals(listOf("first", "second"), released)
        navigation.navigate(Screen.Login("third"))
        navigation.navigate(Screen.Login("fourth"))
        assertEquals(listOf("first", "second", "third"), released)
    }

    @Test
    fun outboxSchedulingResendAndEmptySync() {
        assertEquals(60, Outbox.delaySeconds(SendMode.Window(60)))
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
