package app.remotekit.importer.mail

import android.content.Context
import androidx.work.*
import app.remotekit.importer.ImporterApplication
import app.remotekit.importer.deployment.decodeBase64Url
import app.remotekit.importer.store.SendMode
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

object MailWork {
    private const val SEND = "session-import-outbox"
    private const val POLL = "session-import-inbox"
    private val network =
        Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun queued(context: Context, mode: SendMode, replace: Boolean = true) {
        val delay = Outbox.delaySeconds(mode)
        if (delay == null) {
            if (replace) WorkManager.getInstance(context).cancelUniqueWork(SEND)
        } else send(context, delay.toLong(), replace = replace)
    }

    fun send(context: Context, delay: Long = 0, sync: Boolean = false, replace: Boolean = true) {
        val request =
            OneTimeWorkRequestBuilder<SendWorker>()
                .setConstraints(network)
                .setInitialDelay(delay, TimeUnit.SECONDS)
                .setInputData(workDataOf("sync" to sync))
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
                .build()
        WorkManager.getInstance(context)
            .enqueueUniqueWork(
                SEND,
                if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP,
                request,
            )
    }

    fun periodic(context: Context, unfinished: Boolean) {
        val manager = WorkManager.getInstance(context)
        if (!unfinished) manager.cancelUniqueWork(POLL)
        else
            manager.enqueueUniquePeriodicWork(
                POLL,
                ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<InboxWorker>(15, TimeUnit.MINUTES)
                    .setConstraints(network)
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
                    .build(),
            )
    }

    fun cancel(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(SEND)
        WorkManager.getInstance(context).cancelUniqueWork(POLL)
    }
}

class SendWorker(context: Context, parameters: WorkerParameters) :
    CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result =
        withContext(Dispatchers.IO) {
            val runtime = applicationContext as ImporterApplication
            val deployment = runtime.deployment ?: return@withContext Result.failure()
            runtime.mailMutex.withLock {
                val selected =
                    Outbox.select(
                        runtime.store.snapshot.value,
                        System.currentTimeMillis(),
                        inputData.getBoolean("sync", false),
                    )
                try {
                    val items =
                        Outbox.messages(
                            runtime.store,
                            decodeBase64Url(deployment.key.x25519, 32),
                            System.currentTimeMillis(),
                            inputData.getBoolean("sync", false),
                        )
                    MailSender().sendBatch(deployment.key.id, deployment.mailbox, items) {
                        runtime.store.sent(it.sequences)
                    }
                    Result.success()
                } catch (error: Exception) {
                    if (error is kotlinx.coroutines.CancellationException) throw error
                    runtime.store.sendFailed(
                        selected
                            .filter { meta ->
                                runtime.store.snapshot.value.outgoing
                                    .find { it.seq == meta.seq }
                                    ?.lastSentAt == meta.lastSentAt
                            }
                            .map { it.seq }
                            .toSet(),
                        error.message ?: "发送失败",
                    )
                    Result.retry()
                }
            }
        }
}

class InboxWorker(context: Context, parameters: WorkerParameters) :
    CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result =
        withContext(Dispatchers.IO) {
            val runtime = applicationContext as ImporterApplication
            try {
                runtime.pollInbox()
                Result.success()
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                Result.retry()
            }
        }
}
