package app.remotekit.importer.mail

import android.content.Context
import app.remotekit.importer.BuildConfig
import app.remotekit.importer.R
import app.remotekit.importer.UserMessage
import java.util.Properties
import javax.activation.DataHandler
import javax.mail.AuthenticationFailedException
import javax.mail.Message
import javax.mail.Session
import javax.mail.Transport
import javax.mail.internet.InternetAddress
import javax.mail.internet.MimeBodyPart
import javax.mail.internet.MimeMessage
import javax.mail.internet.MimeMultipart
import javax.mail.util.ByteArrayDataSource
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

data class MailItem(val id: String, val mailbox: String, val readEnvelope: () -> ByteArray)

class MailSender(private val context: Context) {
    val configured: Boolean
        get() =
            listOf(
                    BuildConfig.SMTP_HOST,
                    BuildConfig.SMTP_PORT,
                    BuildConfig.SMTP_USERNAME,
                    BuildConfig.SMTP_PASSWORD,
                    BuildConfig.SMTP_FROM,
                )
                .all { it.isNotBlank() } &&
                ((BuildConfig.SMTP_SECURITY == "tls" && BuildConfig.SMTP_PORT == "465") ||
                    (BuildConfig.SMTP_SECURITY == "starttls" && BuildConfig.SMTP_PORT == "587"))

    suspend fun sendBatch(items: List<MailItem>, onEach: suspend (MailItem, Result<Unit>) -> Unit) =
        withContext(Dispatchers.IO) {
            if (!configured) {
                items.forEach { onEach(it, Result.failure(UserMessage(R.string.no_sender))) }
                return@withContext
            }
            val properties =
                Properties().apply {
                    setProperty("mail.smtp.auth", "true")
                    setProperty("mail.smtp.host", BuildConfig.SMTP_HOST)
                    setProperty("mail.smtp.port", BuildConfig.SMTP_PORT)
                    setProperty("mail.smtp.ssl.checkserveridentity", "true")
                    setProperty("mail.smtp.ssl.protocols", "TLSv1.2 TLSv1.3")
                    setProperty("mail.smtp.connectiontimeout", "20000")
                    setProperty("mail.smtp.timeout", "30000")
                    setProperty("mail.smtp.writetimeout", "30000")
                    setProperty(
                        "mail.smtp.ssl.enable",
                        (BuildConfig.SMTP_SECURITY == "tls").toString(),
                    )
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
            var transport: Transport? = null
            var connectionError: Throwable? = null
            try {
                try {
                    transport =
                        session.getTransport("smtp").apply {
                            connect(
                                BuildConfig.SMTP_HOST,
                                BuildConfig.SMTP_PORT.toInt(),
                                BuildConfig.SMTP_USERNAME,
                                BuildConfig.SMTP_PASSWORD,
                            )
                        }
                } catch (error: Exception) {
                    connectionError = UserMessage(
                        if (error is AuthenticationFailedException) R.string.mail_auth_failed
                        else R.string.mail_unreachable
                    )
                }
                for (item in items) {
                    val failedConnection = connectionError
                    val result =
                        if (failedConnection != null) Result.failure(failedConnection)
                        else
                            runCatching {
                                val message =
                                    MimeMessage(session).apply {
                                        setFrom(InternetAddress(BuildConfig.SMTP_FROM))
                                        setRecipient(
                                            Message.RecipientType.TO,
                                            InternetAddress(item.mailbox, true),
                                        )
                                        setSubject("RemoteKit session import ${item.id}", "UTF-8")
                                        setHeader("X-RemoteKit-Import", "1")
                                        setContent(
                                            MimeMultipart().apply {
                                                addBodyPart(
                                                    MimeBodyPart().apply {
                                                        setText(
                                                            context.getString(R.string.mail_body),
                                                            "UTF-8",
                                                        )
                                                    }
                                                )
                                                addBodyPart(
                                                    MimeBodyPart().apply {
                                                        dataHandler =
                                                            DataHandler(
                                                                ByteArrayDataSource(
                                                                    item.readEnvelope(),
                                                                    "application/octet-stream",
                                                                )
                                                            )
                                                        fileName = "${item.id}.rksi"
                                                        disposition = MimeBodyPart.ATTACHMENT
                                                        setHeader(
                                                            "Content-Transfer-Encoding",
                                                            "base64",
                                                        )
                                                    }
                                                )
                                            }
                                        )
                                        saveChanges()
                                    }
                                transport!!.sendMessage(message, message.allRecipients)
                            }
                    val mapped =
                        result.exceptionOrNull()?.let {
                            Result.failure<Unit>(
                                if (it is UserMessage) it
                                else if (transport?.isConnected != true)
                                    UserMessage(R.string.mail_unreachable)
                                else UserMessage(R.string.mail_rejected)
                            )
                        } ?: result
                    if (mapped.isFailure && transport?.isConnected != true)
                        connectionError = mapped.exceptionOrNull()
                    onEach(item, mapped)
                }
            } finally {
                runCatching { transport?.close() }
            }
        }
}
