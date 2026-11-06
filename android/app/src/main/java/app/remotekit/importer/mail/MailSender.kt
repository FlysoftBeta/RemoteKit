package app.remotekit.importer.mail

import app.remotekit.importer.BuildConfig
import java.util.Date
import java.util.Properties
import javax.activation.DataHandler
import javax.mail.Message
import javax.mail.Session
import javax.mail.internet.InternetAddress
import javax.mail.internet.MimeBodyPart
import javax.mail.internet.MimeMessage
import javax.mail.internet.MimeMultipart
import javax.mail.util.ByteArrayDataSource

class MailSender {
    val configured: Boolean
        get() =
            listOf(
                    BuildConfig.SMTP_HOST,
                    BuildConfig.SMTP_USERNAME,
                    BuildConfig.SMTP_PASSWORD,
                    BuildConfig.SMTP_FROM,
                )
                .all { it.isNotBlank() } &&
                ((BuildConfig.SMTP_SECURITY == "tls" && BuildConfig.SMTP_PORT == "465") ||
                    (BuildConfig.SMTP_SECURITY == "starttls" && BuildConfig.SMTP_PORT == "587"))

    fun sendBatch(
        keyId: String,
        mailbox: String,
        items: List<OutgoingMail>,
        sent: (OutgoingMail) -> Unit,
    ) {
        check(configured) { "未内置发件邮箱" }
        if (items.isEmpty()) return
        val properties =
            Properties().apply {
                setProperty("mail.smtp.auth", "true")
                setProperty("mail.smtp.ssl.checkserveridentity", "true")
                setProperty("mail.smtp.ssl.protocols", "TLSv1.2 TLSv1.3")
                setProperty("mail.smtp.connectiontimeout", "20000")
                setProperty("mail.smtp.timeout", "30000")
                setProperty("mail.smtp.writetimeout", "30000")
                setProperty("mail.smtp.ssl.enable", (BuildConfig.SMTP_SECURITY == "tls").toString())
                setProperty(
                    "mail.smtp.starttls.enable",
                    (BuildConfig.SMTP_SECURITY == "starttls").toString(),
                )
                setProperty(
                    "mail.smtp.starttls.required",
                    (BuildConfig.SMTP_SECURITY == "starttls").toString(),
                )
            }
        val session = Session.getInstance(properties)
        session.getTransport("smtp").use { transport ->
            transport.connect(
                BuildConfig.SMTP_HOST,
                BuildConfig.SMTP_PORT.toInt(),
                BuildConfig.SMTP_USERNAME,
                BuildConfig.SMTP_PASSWORD,
            )
            for (item in items) {
                val message =
                    MimeMessage(session).apply {
                        setFrom(InternetAddress(BuildConfig.SMTP_FROM))
                        setRecipient(Message.RecipientType.TO, InternetAddress(mailbox, true))
                        setSubject("RemoteKit session import to $keyId", "UTF-8")
                        setHeader("X-RemoteKit-Import", "2")
                        sentDate = Date()
                        setContent(
                            MimeMultipart().apply {
                                addBodyPart(
                                    MimeBodyPart().apply {
                                        setText("RemoteKit 加密会话消息。附件由接收方处理。", "UTF-8")
                                    }
                                )
                                addBodyPart(
                                    MimeBodyPart().apply {
                                        dataHandler =
                                            DataHandler(
                                                ByteArrayDataSource(
                                                    item.envelope,
                                                    "application/octet-stream",
                                                )
                                            )
                                        fileName = "message.rksi"
                                        disposition = MimeBodyPart.ATTACHMENT
                                        setHeader("Content-Transfer-Encoding", "base64")
                                    }
                                )
                            }
                        )
                        saveChanges()
                    }
                transport.sendMessage(message, message.allRecipients)
                sent(item)
            }
        }
    }
}
