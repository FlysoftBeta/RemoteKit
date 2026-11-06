package app.remotekit.importer.ui

import android.app.Application
import android.net.Uri
import android.webkit.WebView
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.webkit.Profile
import app.remotekit.importer.ImporterApplication
import app.remotekit.importer.R
import app.remotekit.importer.UserMessage
import app.remotekit.importer.crypto.EnvelopeSealer
import app.remotekit.importer.export.ExportScope
import app.remotekit.importer.export.SessionExporters
import app.remotekit.importer.mail.MailItem
import app.remotekit.importer.mail.MailSender
import app.remotekit.importer.payload.ImportPayload
import app.remotekit.importer.payload.ImportSite
import app.remotekit.importer.payload.OriginStorage
import app.remotekit.importer.requireMessage
import app.remotekit.importer.requireMessageNotNull
import app.remotekit.importer.store.Draft
import app.remotekit.importer.store.SiteRef
import app.remotekit.importer.web.SiteVisit
import app.remotekit.importer.web.SiteVisits
import app.remotekit.importer.web.encodeIcon
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

sealed interface Screen {
    data object Home : Screen

    data object Settings : Screen

    data class Login(val id: String) : Screen
}

data class SendProgress(
    val id: String,
    val name: String,
    val finished: Boolean = false,
    val error: String? = null,
)

class AppViewModel(application: Application) : AndroidViewModel(application) {
    private val runtime = application as ImporterApplication
    val deployment = runtime.deployment
    val store = runtime.store
    val profiles = runtime.profiles
    val mail = MailSender(application)
    val snapshot = store.snapshot
    val screen = MutableStateFlow<Screen>(Screen.Home)
    val selected = MutableStateFlow<Set<String>>(emptySet())
    val selecting = MutableStateFlow(false)
    val progress = MutableStateFlow<List<SendProgress>?>(null)
    val sending = MutableStateFlow(false)
    val exporting = MutableStateFlow(false)
    val cleaning = MutableStateFlow(false)
    private val notifications = Channel<String>(Channel.BUFFERED)
    val messages = notifications.receiveAsFlow()
    val startupError = runtime.startupError
    val supported = runtime.supported

    fun notify(message: String) {
        notifications.trySend(message)
    }

    private fun text(id: Int): String = getApplication<Application>().getString(id)

    fun errorText(error: Throwable, fallback: Int = R.string.operation_failed): String =
        if (error is UserMessage) text(error.textResource) else error.message ?: text(fallback)

    fun notifyError(error: Throwable) = notify(errorText(error))

    fun saveAccount(username: String, password: String) {
        try {
            requireMessage(!sending.value && !exporting.value && !cleaning.value)
            store.setAccount(username, password)
            clearSelection()
            notify(text(R.string.account_saved))
        } catch (error: Exception) {
            notifyError(error)
        }
    }

    private val history = mutableMapOf<String, SiteVisits>()

    /** Navigation history of a login browser; survives leaving and reopening the login screen. */
    fun visits(id: String): SiteVisits = history.getOrPut(id) { SiteVisits() }

    private suspend fun destroy(id: String) {
        history.remove(id)
        profiles.destroy(id)
    }

    fun create() {
        try {
            screen.value = Screen.Login(store.createDraft().id)
        } catch (error: Exception) {
            notify(errorText(error, R.string.create_failed))
        }
    }

    fun toggle(id: String) {
        selected.value = if (id in selected.value) selected.value - id else selected.value + id
    }

    fun clearSelection() {
        selecting.value = false
        selected.value = emptySet()
    }

    fun selectedReady(): List<Draft> =
        snapshot.value.drafts.filter {
            it.id in selected.value && it.isCurrent(deployment, snapshot.value)
        }

    fun exportSites(
        draft: Draft,
        view: WebView,
        profile: Profile,
        chosen: List<SiteVisit>,
        done: () -> Unit,
    ) {
        if (exporting.value || chosen.isEmpty()) return
        viewModelScope.launch {
            exporting.value = true
            try {
                val deployment = requireMessageNotNull(deployment) { R.string.no_deployment }
                val accountRevision = snapshot.value.accountRevision
                val account = requireMessageNotNull(store.account()) { R.string.account_required }
                requireMessage(mail.configured) { R.string.no_sender }
                val captures =
                    chosen.map { visit ->
                        val url = Uri.parse(visit.url)
                        val exporter =
                            requireMessageNotNull(SessionExporters.forUrl(url)) {
                                R.string.unsupported_export
                            }
                        exporter.export(ExportScope(view, profile, url))
                    }
                val sites = chosen.map { SiteRef(it.name, it.url, it.icon?.let(::encodeIcon)) }
                val payload =
                    ImportPayload(
                        id = draft.id,
                        createdAt = System.currentTimeMillis(),
                        username = account.username,
                        password = account.password,
                        device = snapshot.value.deviceName,
                        sites = sites.map { ImportSite(it.name, it.url) },
                        cookies =
                            captures
                                .flatMap { it.cookies }
                                .associateBy { Triple(it.name, it.domain, it.path) }
                                .values
                                .toList(),
                        localStorage =
                            captures
                                .flatMap { it.localStorage }
                                .groupBy { it.origin }
                                .map { (origin, parts) ->
                                    OriginStorage(
                                        origin,
                                        parts
                                            .flatMap { it.items }
                                            .associateBy { it[0] }
                                            .values
                                            .toList(),
                                    )
                                },
                    )
                val envelope =
                    withContext(Dispatchers.Default) { EnvelopeSealer().seal(payload, deployment) }
                store.leftAt(draft.id, view.url)
                store.ready(draft.id, deployment, accountRevision, sites, envelope)
                screen.value = Screen.Home
                notify(text(R.string.ready_snackbar))
                done()
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                notify(errorText(error, R.string.export_failed))
            } finally {
                exporting.value = false
            }
        }
    }

    fun sendSelected() {
        if (sending.value || cleaning.value) return
        val deployment = deployment ?: return
        val drafts = selectedReady()
        if (drafts.isEmpty()) return
        progress.value = drafts.map { SendProgress(it.id, it.sites.joinToString("、") { site -> site.name }) }
        sending.value = true
        clearSelection()
        viewModelScope.launch {
            try {
                val items = drafts.map { draft ->
                    MailItem(draft.id, deployment.mailbox) { store.readEnvelope(draft, deployment) }
                }
                mail.sendBatch(items) { item, result ->
                    withContext(NonCancellable + Dispatchers.Main.immediate) {
                        var error =
                            result.exceptionOrNull()?.let { errorText(it, R.string.send_error) }
                        if (result.isSuccess) {
                            drafts.find { it.id == item.id }?.let(store::recordSent)
                            runCatching { destroy(item.id) }
                                .onFailure {
                                    error =
                                        getApplication<Application>()
                                            .getString(
                                                R.string.sent_cleanup_error,
                                                errorText(it, R.string.cleanup_error),
                                            )
                                }
                        } else {
                            val reason = error ?: text(R.string.send_error)
                            error = reason
                            store.sendFailed(item.id, reason)
                        }
                        progress.value =
                            progress.value?.map {
                                if (it.id == item.id) it.copy(finished = true, error = error)
                                else it
                            }
                    }
                }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                progress.value =
                    progress.value?.map {
                        if (it.finished) it
                        else it.copy(finished = true, error = errorText(error, R.string.send_error))
                    }
                drafts
                    .filter { draft ->
                        progress.value?.any { it.id == draft.id && it.error != null } == true
                    }
                    .filter { draft -> snapshot.value.drafts.any { it.id == draft.id } }
                    .forEach { store.sendFailed(it.id, errorText(error, R.string.send_error)) }
            } finally {
                sending.value = false
            }
        }
    }

    fun deleteSelected() {
        if (cleaning.value || sending.value) return
        val ids = selected.value
        cleaning.value = true
        clearSelection()
        viewModelScope.launch {
            try {
                ids.forEach { id ->
                    runCatching { destroy(id) }
                        .onFailure { notify(errorText(it, R.string.cleanup_error)) }
                }
            } finally {
                cleaning.value = false
            }
        }
    }

    fun clearAll() {
        if (cleaning.value || sending.value) return
        cleaning.value = true
        viewModelScope.launch {
            try {
                store.clearAccountAndDevice()
                snapshot.value.drafts.map { it.id }.forEach { destroy(it) }
                clearSelection()
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                notify(errorText(error, R.string.cleanup_error))
            } finally {
                cleaning.value = false
            }
        }
    }
}
