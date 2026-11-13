package app.remotekit.importer.mail

import app.remotekit.importer.BuildConfig
import app.remotekit.importer.deployment.ContractJson
import app.remotekit.importer.protocol.ControlMessage
import app.remotekit.importer.protocol.Envelope
import app.remotekit.importer.store.AppStore
import app.remotekit.importer.store.InboxCursor
import com.sun.mail.imap.IMAPFolder
import com.sun.mail.imap.IMAPStore
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.Date
import java.util.Properties
import javax.mail.FetchProfile
import javax.mail.Flags
import javax.mail.Folder
import javax.mail.Message
import javax.mail.Multipart
import javax.mail.Part
import javax.mail.Session
import javax.mail.UIDFolder
import javax.mail.search.ComparisonTerm
import javax.mail.search.ReceivedDateTerm
import org.bouncycastle.crypto.InvalidCipherTextException

private const val RETENTION_MS = 30L * 24 * 60 * 60 * 1000
private const val CLEANUP_INTERVAL_MS = 24L * 60 * 60 * 1000
// Tolerates clock skew between the phone and the mail server's INTERNALDATE.
private const val CLOCK_MARGIN_MS = 10L * 60 * 1000

private sealed interface InboxResult {
    data object Invalid : InboxResult

    data class Decoded(val message: ControlMessage) : InboxResult
}

private class InvalidAttachment : Exception()

class Inbox(private val store: AppStore, private val controlPublic: ByteArray) {
    fun poll(now: Long = System.currentTimeMillis()) {
        check(
            BuildConfig.IMAP_HOST.isNotBlank() &&
                BuildConfig.IMAP_PORT == "993" &&
                BuildConfig.IMAP_USERNAME.isNotBlank() &&
                BuildConfig.IMAP_PASSWORD.isNotBlank()
        ) {
            "未内置收件邮箱"
        }
        val properties =
            Properties().apply {
                setProperty("mail.imaps.ssl.enable", "true")
                setProperty("mail.imaps.ssl.checkserveridentity", "true")
                setProperty("mail.imaps.ssl.protocols", "TLSv1.2 TLSv1.3")
                setProperty("mail.imaps.connectiontimeout", "20000")
                setProperty("mail.imaps.timeout", "30000")
                setProperty("mail.imaps.writetimeout", "30000")
            }
        val mailbox = Session.getInstance(properties).getStore("imaps") as IMAPStore
        mailbox.use {
            it.connect(
                BuildConfig.IMAP_HOST,
                993,
                BuildConfig.IMAP_USERNAME,
                BuildConfig.IMAP_PASSWORD,
            )
            if (it.hasCapability("ID")) it.id(mapOf("name" to "RemoteKit", "version" to "2"))
            val folder = it.getFolder("INBOX") as IMAPFolder
            folder.open(Folder.READ_WRITE)
            try {
                store.advanceInbox(read(folder, now))
            } finally {
                folder.close(true)
            }
        }
    }

    /** Handles the messages that arrived since the cursor and returns the cursor to save. */
    private fun read(folder: IMAPFolder, now: Long): InboxCursor {
        val cursor = store.snapshot.value.inbox
        val validity = folder.uidValidity
        val resume = cursor.uidValidity == validity && cursor.uid != null
        // Within one UIDVALIDITY only UIDs above the watermark are new. Otherwise (first poll, or
        // the server renumbered) scan by date from the cursor time; SUBJECT searches are not used
        // because some providers (NetEase) answer them with nothing.
        val messages =
            if (resume)
                folder.getMessagesByUID(cursor.uid + 1, UIDFolder.LASTUID).filter {
                    // `n:*` also returns the newest message when nothing is above n.
                    folder.getUID(it) > cursor.uid
                }
            else
                folder
                    .search(
                        ReceivedDateTerm(ComparisonTerm.GE, Date(cursor.since - CLOCK_MARGIN_MS))
                    )
                    .toList()
        folder.fetch(
            messages.toTypedArray(),
            FetchProfile().apply {
                add(FetchProfile.Item.ENVELOPE)
                add(UIDFolder.FetchProfileItem.UID)
            },
        )
        var highest = if (resume) cursor.uid else folder.uidNext.takeIf { it > 0 }?.minus(1)
        val subject = "RemoteKit session import to ${store.snapshot.value.device.id}"
        val decoded =
            messages
                .mapNotNull { mail ->
                    highest = maxOf(highest ?: 0, folder.getUID(mail))
                    if (!resume && (mail.receivedDate?.time ?: 0) < cursor.since - CLOCK_MARGIN_MS)
                        return@mapNotNull null
                    if (mail.subject != subject) return@mapNotNull null
                    readMessage(mail)?.let { mail to it }
                }
                .sortedBy { (_, message) -> message.events.firstOrNull()?.seq ?: 0 }
        // A message ahead of a gap is kept encrypted in the store, so every handled mail goes.
        for ((mail, message) in decoded) {
            store.receive(message)
            mail.setFlag(Flags.Flag.DELETED, true)
        }
        val cleanup = now - cursor.cleanedAt >= CLEANUP_INTERVAL_MS
        if (cleanup)
            for (mail in
                folder.search(ReceivedDateTerm(ComparisonTerm.LT, Date(now - RETENTION_MS)))) {
                if (mail.subject?.startsWith("RemoteKit session import to ") == true)
                    mail.setFlag(Flags.Flag.DELETED, true)
            }
        return InboxCursor(
            since = now,
            uidValidity = validity,
            uid = highest,
            cleanedAt = if (cleanup) now else cursor.cleanedAt,
        )
    }

    internal fun readMessage(mail: Message): ControlMessage? =
        when (val result = decode(mail)) {
            InboxResult.Invalid -> {
                mail.setFlag(Flags.Flag.DELETED, true)
                null
            }
            is InboxResult.Decoded -> result.message
        }

    private fun decode(mail: Message): InboxResult {
        if (mail.getHeader("X-RemoteKit-Import")?.singleOrNull() != "2") return InboxResult.Invalid
        val bytes =
            try {
                attachment(mail) ?: return InboxResult.Invalid
            } catch (_: InvalidAttachment) {
                return InboxResult.Invalid
            }
        // IMAP reads and local key access must succeed before classifying the envelope.
        val key = store.deviceKey()
        return try {
            val json = Envelope.open(bytes, key, controlPublic)
            InboxResult.Decoded(
                ContractJson.decodeFromString<ControlMessage>(json).also { it.validate() }
            )
        } catch (_: IllegalArgumentException) {
            InboxResult.Invalid
        } catch (_: InvalidCipherTextException) {
            InboxResult.Invalid
        } catch (_: IOException) {
            // Only in-memory decompression and UTF-8 decoding happen in this block.
            InboxResult.Invalid
        }
    }

    private fun attachment(part: Part): ByteArray? {
        if (part.fileName?.endsWith(".rksi") == true) {
            if (part.size > Envelope.MAX_ENVELOPE * 2) throw InvalidAttachment()
            return part.inputStream.use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    if (output.size() + count > Envelope.MAX_ENVELOPE) throw InvalidAttachment()
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            }
        }
        if (part.isMimeType("multipart/*")) {
            val multipart = part.content as Multipart
            for (index in 0 until multipart.count) {
                attachment(multipart.getBodyPart(index))?.let {
                    return it
                }
            }
        }
        return null
    }
}
