package app.remotekit.importer

import android.app.Application
import app.remotekit.importer.deployment.Deployment
import app.remotekit.importer.deployment.DeploymentConfig
import app.remotekit.importer.deployment.decodeBase64Url
import app.remotekit.importer.mail.Inbox
import app.remotekit.importer.mail.MailWork
import app.remotekit.importer.store.AppStore
import app.remotekit.importer.store.LocalDataException
import app.remotekit.importer.web.ProfileSessions
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

sealed interface LocalDataState {
    data class Ready(val store: AppStore) : LocalDataState

    data class Unreadable(val error: LocalDataException) : LocalDataState
}

class ImporterApplication : Application() {
    val mailMutex = Mutex()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    fun releaseProfile(id: String, failed: (Throwable) -> Unit) {
        scope.launch(Dispatchers.Main.immediate) {
            try {
                profiles.destroy(id)
            } catch (error: Exception) {
                failed(error)
            }
        }
    }

    suspend fun pollInbox() =
        withContext(Dispatchers.IO) {
            val deployment = deployment ?: return@withContext
            mailMutex.withLock { Inbox(store, decodeBase64Url(deployment.key.x25519, 32)).poll() }
        }

    lateinit var localData: LocalDataState
        private set

    val store: AppStore
        get() = (localData as LocalDataState.Ready).store

    lateinit var profiles: ProfileSessions
        private set

    var deployment: Deployment? = null
        private set

    var supported = false
        private set

    var startupError: String? = null
        private set

    override fun onCreate() {
        super.onCreate()
        runCatching {
            if ("deployment.json" in assets.list("").orEmpty()) {
                deployment =
                    assets.open("deployment.json").use {
                        DeploymentConfig.parse(it.readBytes())
                    }
            }
        }
            .onFailure { startupError = getString(R.string.invalid_deployment) }
        localData =
            try {
                LocalDataState.Ready(
                    AppStore(this, deployment?.let { decodeBase64Url(it.key.x25519, 32) })
                )
            } catch (error: LocalDataException) {
                LocalDataState.Unreadable(error)
            }
        if (localData is LocalDataState.Unreadable) return
        profiles = ProfileSessions(store)
        supported = profiles.supported()
        if (supported) {
            runCatching { profiles.deletePendingBeforeWebViews() }
                .onFailure {
                    startupError =
                        if (it is UserMessage) getString(it.textResource)
                        else it.message ?: it.javaClass.simpleName
                }
        }
        scope.launch {
            var queue: Pair<Long, app.remotekit.importer.store.SendMode>? = null
            store.snapshot.collect { state ->
                MailWork.periodic(this@ImporterApplication, state.unfinished())
                val current = state.nextDeviceSeq to state.sendMode
                if (queue != current) {
                    val replace = queue != null
                    queue = current
                    if (
                        state.outgoing.any {
                            !it.retired && it.seq > state.ackedByControl && it.lastSentAt == null
                        }
                    )
                        MailWork.queued(this@ImporterApplication, state.sendMode, replace)
                }
            }
        }
        scope.launch { runCatching { pollInbox() } }
    }
}
