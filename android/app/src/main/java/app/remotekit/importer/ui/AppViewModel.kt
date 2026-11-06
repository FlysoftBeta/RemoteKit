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
import app.remotekit.importer.pairing.Pairing
import app.remotekit.importer.pairing.PairingCode
import app.remotekit.importer.payload.ImportPayload
import app.remotekit.importer.payload.ImportSite
import app.remotekit.importer.payload.httpUrl
import app.remotekit.importer.requireMessage
import app.remotekit.importer.requireMessageNotNull
import app.remotekit.importer.store.Draft
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

    data object Scan : Screen

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
    val store = runtime.store
    val profiles = runtime.profiles
    val mail = MailSender(application)
    val snapshot = store.snapshot
    val screen = MutableStateFlow<Screen>(Screen.Home)
    val selected = MutableStateFlow<Set<String>>(emptySet())
    val selecting = MutableStateFlow(false)
    val pendingPairing = MutableStateFlow<Pairing?>(null)
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

    fun pair(text: String): Boolean =
        try {
            val pairing = PairingCode.parse(text.trim())
            if (snapshot.value.pairing != null) pendingPairing.value = pairing
            else store.pair(pairing)
            screen.value = Screen.Home
            true
        } catch (error: Exception) {
            notify(errorText(error, R.string.invalid_pairing))
            false
        }

    fun confirmPairing() {
        pendingPairing.value?.let { store.pair(it) }
        pendingPairing.value = null
        clearSelection()
    }

    fun create(name: String, url: String): Boolean =
        try {
            requireMessage(snapshot.value.pairing != null) { R.string.pair_first }
            requireMessage(name.isNotBlank() && name.codePointCount(0, name.length) <= 128) {
                R.string.site_name_limit
            }
            httpUrl(url)
            val draft = store.createDraft(name.trim(), url)
            screen.value = Screen.Login(draft.id)
            true
        } catch (error: Exception) {
            notify(errorText(error, R.string.create_failed))
            false
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
            it.id in selected.value && it.isCurrent(snapshot.value.pairing)
        }

    fun completeLogin(
        draft: Draft,
        view: WebView,
        profile: Profile,
        unsupported: String,
        ready: String,
    ) {
        if (exporting.value) return
        viewModelScope.launch {
            exporting.value = true
            try {
                val pairing = requireMessageNotNull(snapshot.value.pairing) { R.string.pair_first }
                val url = Uri.parse(view.url ?: draft.url)
                val exporter = SessionExporters.forUrl(url)
                if (exporter == null) {
                    notify(unsupported)
                    return@launch
                }
                val capture = exporter.export(ExportScope(view, profile, url))
                val payload =
                    ImportPayload(
                        id = draft.id,
                        createdAt = System.currentTimeMillis(),
                        token = pairing.token,
                        device = snapshot.value.deviceName,
                        site = ImportSite(draft.name, url.toString()),
                        cookies = capture.cookies,
                        localStorage = capture.localStorage,
                    )
                val envelope =
                    withContext(Dispatchers.Default) { EnvelopeSealer().seal(payload, pairing) }
                store.ready(draft.id, pairing, url.toString(), envelope)
                screen.value = Screen.Home
                notify(ready)
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
        val pairing = snapshot.value.pairing ?: return
        val drafts = selectedReady()
        if (drafts.isEmpty()) return
        progress.value = drafts.map { SendProgress(it.id, it.name) }
        sending.value = true
        clearSelection()
        viewModelScope.launch {
            try {
                val items = drafts.map { draft ->
                    MailItem(draft.id, pairing.mailbox) { store.readEnvelope(draft) }
                }
                mail.sendBatch(items) { item, result ->
                    withContext(NonCancellable + Dispatchers.Main.immediate) {
                        var error =
                            result.exceptionOrNull()?.let { errorText(it, R.string.send_error) }
                        if (result.isSuccess) {
                            runCatching { profiles.destroy(item.id) }
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
                    runCatching { profiles.destroy(id) }
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
                snapshot.value.drafts.map { it.id }.forEach { profiles.destroy(it) }
                store.clearPairingAndDevice()
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
