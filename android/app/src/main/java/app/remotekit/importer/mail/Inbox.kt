package app.remotekit.importer.mail

import app.remotekit.importer.BuildConfig
import app.remotekit.importer.deployment.ContractJson
import app.remotekit.importer.protocol.ControlMessage
import app.remotekit.importer.protocol.Envelope
import app.remotekit.importer.store.AppStore
import com.sun.mail.imap.IMAPStore
import java.io.ByteArrayOutputStream
import java.util.Properties
import javax.mail.Flags
import javax.mail.Folder
import javax.mail.Multipart
import javax.mail.Part
import javax.mail.Session
import javax.mail.search.SubjectTerm

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
            val folder = it.getFolder("INBOX")
            folder.open(Folder.READ_WRITE)
            try {
                val subject = "RemoteKit session import to ${store.snapshot.value.device.id}"
                val messages = folder.search(SubjectTerm(subject))
                val decoded =
                    messages
                        .mapNotNull { mail ->
                            if (mail.subject != subject) return@mapNotNull null
                            val message =
                                try {
                                    require(
                                        mail.getHeader("X-RemoteKit-Import")?.singleOrNull() == "2"
                                    )
                                    val attachment = requireNotNull(attachment(mail))
                                    val json =
                                        Envelope.open(attachment, store.deviceKey(), controlPublic)
                                    ContractJson.decodeFromString<ControlMessage>(json).also {
                                        message ->
                                        message.validate()
                                    }
                                } catch (_: Exception) {
                                    mail.setFlag(Flags.Flag.DELETED, true)
                                    return@mapNotNull null
                                }
                            mail to message
                        }
                        .sortedBy { (_, message) -> message.events.firstOrNull()?.seq ?: 0 }
                for ((mail, message) in decoded) {
                    if (store.receive(message)) mail.setFlag(Flags.Flag.DELETED, true)
                }
                for ((mail, message) in decoded) {
                    if (
                        message.events.all { event ->
                            event.seq <= store.snapshot.value.appliedControlSeq
                        }
                    )
                        mail.setFlag(Flags.Flag.DELETED, true)
                }
                for (mail in folder.search(SubjectTerm("RemoteKit session import to "))) {
                    val date = mail.receivedDate ?: mail.sentDate ?: continue
                    if (
                        mail.subject?.startsWith("RemoteKit session import to ") == true &&
                            now - date.time > 30L * 24 * 60 * 60 * 1000
                    )
                        mail.setFlag(Flags.Flag.DELETED, true)
                }
            } finally {
                folder.close(true)
            }
        }
    }

    private fun attachment(part: Part): ByteArray? {
        if (part.fileName?.endsWith(".rksi") == true) {
            require(part.size <= Envelope.MAX_ENVELOPE * 2)
            return part.inputStream.use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    require(output.size() + count <= Envelope.MAX_ENVELOPE)
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
