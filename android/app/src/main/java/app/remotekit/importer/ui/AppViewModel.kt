package app.remotekit.importer.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.webkit.Profile
import app.remotekit.importer.ImporterApplication
import app.remotekit.importer.UserMessage
import app.remotekit.importer.export.SessionExporter
import app.remotekit.importer.mail.MailWork
import app.remotekit.importer.payload.*
import app.remotekit.importer.store.*
import app.remotekit.importer.web.*
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.sync.withLock

sealed interface Screen {
    data object Home : Screen

    data object Settings : Screen

    data class Login(val id: String) : Screen
}

internal class ScreenNavigation(private val leaveLogin: (String) -> Unit) {
    private val current = MutableStateFlow<Screen>(Screen.Home)
    val screen = current.asStateFlow()

    fun navigate(next: Screen) {
        val previous = current.value
        if (previous == next) return
        current.value = next
        if (previous is Screen.Login) leaveLogin(previous.id)
    }
}

internal class AppActions(private val store: AppStore, private val failed: (Exception) -> Unit) {
    operator fun invoke(block: () -> Unit) {
        try {
            block()
        } catch (error: Exception) {
            failed(error)
        }
    }

    fun hideEvent(seq: Long) = invoke { store.hideEvent(seq) }
}

class AppViewModel(application: Application) : AndroidViewModel(application) {
    private val runtime = application as ImporterApplication
    val deployment = runtime.deployment
    val store = runtime.store
    val profiles = runtime.profiles
    val snapshot = store.snapshot
    private val navigation = ScreenNavigation(::leaveLogin)
    val screen = navigation.screen
    val exporting = MutableStateFlow(false)
    val cleaning = MutableStateFlow(false)
    val refreshing = MutableStateFlow(false)
    private val notifications = Channel<String>(Channel.BUFFERED)
    val messages = notifications.receiveAsFlow()
    val startupError = runtime.startupError
    val supported = runtime.supported
    private val visits = mutableMapOf<String, SiteVisits>()
    val wordlist = application.assets.open("wordlist.txt").bufferedReader().use { it.readLines() }

    fun visits(id: String): SiteVisits = visits.getOrPut(id) { SiteVisits() }

    fun navigate(next: Screen) = navigation.navigate(next)

    fun notify(message: String) {
        notifications.trySend(message)
    }

    fun errorText(error: Throwable): String =
        if (error is UserMessage) getApplication<Application>().getString(error.textResource)
        else error.message ?: "操作失败"

    private val action = AppActions(store) { notify(errorText(it)) }

    fun authorize(): Boolean {
        if (store.authorized()) return true
        navigate(Screen.Home)
        return false
    }

    fun pair(username: String, password: String, code: List<String>, device: String) = action {
        check(code.all { it.trim().lowercase() in wordlist }) { "请选择词表中的配对码" }
        store.pair(username, password, code, device)
        navigate(Screen.Home)
    }

    fun create() = action {
        if (!authorize()) return@action
        check(deployment != null) { "未内置部署配置" }
        check(supported) { "请更新 Android System WebView" }
        val id = UUID.randomUUID().toString()
        store.beginDestroy(id)
        navigate(Screen.Login(id))
    }

    private fun leaveLogin(id: String) {
        visits.remove(id)
        runtime.releaseProfile(id) { notify(errorText(it)) }
    }

    fun exportSites(id: String, profile: Profile, chosen: List<SiteVisit>, done: () -> Unit) {
        if (exporting.value || chosen.isEmpty() || !authorize()) return
        viewModelScope.launch {
            exporting.value = true
            try {
                val origins = visits(id).requests.within(chosen.map { it.key }.toSet())
                val capture = SessionExporter(getApplication(), profile).export(origins)
                val sites = chosen.map { SiteRef(it.name, it.url, it.icon?.let(::encodeIcon)) }
                val payload =
                    ImportPayload(
                        id = UUID.randomUUID().toString(),
                        sites = sites.map { ImportSite(it.name, it.url) },
                        cookies = capture.cookies,
                        localStorage = capture.localStorage,
                    )
                withContext(Dispatchers.IO) { store.addImport(payload, sites) }
                done()
                navigate(Screen.Home)
                notify("导入请求已排队")
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                notify(errorText(error))
            } finally {
                exporting.value = false
            }
        }
    }

    fun retry(id: String) = action { if (authorize()) store.retry(id) }

    fun delete(id: String) = action {
        if (!store.authorized() && snapshot.value.mayBePending(id)) {
            authorize()
        } else store.deleteRequest(id)
    }

    fun hideEvent(seq: Long) = action.hideEvent(seq)

    fun send(sync: Boolean = false) {
        MailWork.send(getApplication(), sync = sync)
    }

    fun sync() {
        send(sync = true)
        poll()
    }

    fun poll() {
        if (refreshing.value) return
        refreshing.value = true
        viewModelScope.launch {
            try {
                runtime.pollInbox()
            } catch (error: Exception) {
                notify(errorText(error))
            } finally {
                refreshing.value = false
            }
        }
    }

    fun saveSettings(name: String, mode: SendMode) = action {
        store.setDeviceName(name)
        store.setSendMode(mode)
        navigate(Screen.Home)
    }

    fun clearAll() {
        if (cleaning.value) return
        cleaning.value = true
        viewModelScope.launch {
            try {
                MailWork.cancel(getApplication())
                runtime.mailMutex.withLock {
                    val pending = snapshot.value.pendingProfileDeletions.toList()
                    pending.forEach { profiles.destroy(it) }
                    val deferred = snapshot.value.pendingProfileDeletions
                    withContext(Dispatchers.IO) {
                        getApplication<Application>().cacheDir.listFiles()?.forEach {
                            check(it.deleteRecursively())
                        }
                        store.clearAll()
                    }
                    deferred.forEach { store.beginDestroy(it) }
                    visits.clear()
                    navigate(Screen.Home)
                }
            } catch (error: Exception) {
                notify(errorText(error))
            } finally {
                cleaning.value = false
            }
        }
    }
}
