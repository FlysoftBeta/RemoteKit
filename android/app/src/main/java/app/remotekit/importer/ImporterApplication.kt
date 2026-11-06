package app.remotekit.importer

import android.app.Application
import app.remotekit.importer.store.AppStore
import app.remotekit.importer.web.ProfileSessions

class ImporterApplication : Application() {
    lateinit var store: AppStore
        private set

    lateinit var profiles: ProfileSessions
        private set

    var supported = false
        private set

    var startupError: String? = null
        private set

    override fun onCreate() {
        super.onCreate()
        store = AppStore(this)
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
    }
}
