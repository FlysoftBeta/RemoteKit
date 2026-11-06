package app.remotekit.importer.store

import android.content.Context
import android.os.Build
import android.util.AtomicFile
import app.remotekit.importer.R
import app.remotekit.importer.account.Account
import app.remotekit.importer.account.AccountCipher
import app.remotekit.importer.account.validateAccount
import app.remotekit.importer.deployment.ContractJson
import app.remotekit.importer.deployment.Deployment
import app.remotekit.importer.requireMessage
import java.io.File
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

@Serializable
sealed interface DraftState {
    @Serializable @SerialName("LoggingIn") data object LoggingIn : DraftState

    @Serializable
    @SerialName("Ready")
    data class Ready(val deploymentKeyId: String, val accountRevision: Long) : DraftState
}

/** A site chosen for import. [icon] is a base64 PNG of at most 64 px, kept only for display. */
@Serializable data class SiteRef(val name: String, val url: String, val icon: String? = null)

@Serializable
data class Draft(
    val id: String,
    val updatedAt: Long,
    val lastUrl: String? = null,
    val sites: List<SiteRef> = emptyList(),
    val state: DraftState = DraftState.LoggingIn,
    val sendError: String? = null,
) {
    fun isCurrent(deployment: Deployment?, snapshot: AppSnapshot): Boolean =
        deployment != null &&
            snapshot.account != null &&
            state is DraftState.Ready &&
            state.deploymentKeyId == deployment.key.id &&
            state.accountRevision == snapshot.accountRevision
}

@Serializable data class SentRecord(val sites: List<SiteRef>, val sentAt: Long)

@Serializable data class StoredAccount(val username: String, val encryptedPassword: String)

@Serializable
data class AppSnapshot(
    val account: StoredAccount? = null,
    val accountRevision: Long = 0,
    val deviceName: String = Build.MODEL.take(64),
    val drafts: List<Draft> = emptyList(),
    val pendingProfileDeletions: Set<String> = emptySet(),
    val sent: List<SentRecord> = emptyList(),
)

class AppStore(context: Context) {
    private val accountCipher = AccountCipher()
    private val stateFile = AtomicFile(File(context.filesDir, "state.json"))
    private val envelopes = File(context.filesDir, "envelopes").apply { mkdirs() }
    private val mutable = MutableStateFlow(read())
    val snapshot: StateFlow<AppSnapshot> = mutable.asStateFlow()

    init {
        val ids = mutable.value.drafts.filter { it.state is DraftState.Ready }.map { it.id }.toSet()
        envelopes.listFiles()?.filter { it.nameWithoutExtension !in ids }?.forEach { it.delete() }
        val missing =
            mutable.value.drafts.filter {
                it.state is DraftState.Ready && !envelopeFile(it.id).exists()
            }
        if (missing.isNotEmpty())
            update {
                it.copy(
                    drafts =
                        it.drafts.map { draft ->
                            if (draft in missing) draft.copy(state = DraftState.LoggingIn)
                            else draft
                        }
                )
            }
    }

    private fun read(): AppSnapshot =
        if (stateFile.baseFile.exists() || File(stateFile.baseFile.path + ".bak").exists()) {
            stateFile.openRead().use {
                ContractJson.decodeFromString<AppSnapshot>(it.readBytes().toString(Charsets.UTF_8))
            }
        } else AppSnapshot()

    @Synchronized
    private fun update(transform: (AppSnapshot) -> AppSnapshot) {
        val next = transform(mutable.value)
        val stream = stateFile.startWrite()
        try {
            stream.write(ContractJson.encodeToString(next).toByteArray(Charsets.UTF_8))
            stateFile.finishWrite(stream)
        } catch (error: Exception) {
            stateFile.failWrite(stream)
            throw error
        }
        mutable.value = next
    }

    fun account(): Account? =
        snapshot.value.account?.let {
            Account(it.username, accountCipher.decrypt(it.encryptedPassword))
        }

    fun setAccount(username: String, password: String) {
        validateAccount(username, password)
        val current = account()
        if (current?.username == username && current.password == password) return
        val encrypted = accountCipher.encrypt(password)
        update {
            it.copy(
                account = StoredAccount(username, encrypted),
                accountRevision = it.accountRevision + 1,
            )
        }
    }

    fun setDeviceName(name: String) {
        requireMessage(name.isNotBlank() && name.codePointCount(0, name.length) <= 64) {
            R.string.device_name_limit
        }
        update { it.copy(deviceName = name) }
    }

    fun createDraft(): Draft {
        val draft = Draft(UUID.randomUUID().toString(), System.currentTimeMillis())
        update { it.copy(drafts = listOf(draft) + it.drafts) }
        return draft
    }

    fun leftAt(id: String, url: String?) {
        if (url == null || snapshot.value.drafts.none { it.id == id && it.lastUrl != url }) return
        update { state ->
            state.copy(drafts = state.drafts.map { if (it.id == id) it.copy(lastUrl = url) else it })
        }
    }

    private fun envelopeFile(id: String): File {
        requireMessage(UUID.fromString(id).toString() == id)
        return File(envelopes, "$id.rksi")
    }

    fun readEnvelope(draft: Draft, deployment: Deployment): ByteArray {
        requireMessage(draft.isCurrent(deployment, snapshot.value)) { R.string.account_reexport }
        return envelopeFile(draft.id).readBytes()
    }

    fun ready(
        id: String,
        deployment: Deployment,
        accountRevision: Long,
        sites: List<SiteRef>,
        envelope: ByteArray,
    ) {
        val file = AtomicFile(envelopeFile(id))
        val output = file.startWrite()
        try {
            output.write(envelope)
            file.finishWrite(output)
        } catch (error: Exception) {
            file.failWrite(output)
            throw error
        }
        update { state ->
            requireMessage(state.account != null && state.accountRevision == accountRevision) {
                R.string.account_reexport
            }
            state.copy(
                drafts =
                    state.drafts.map {
                        if (it.id == id)
                            it.copy(
                                sites = sites,
                                updatedAt = System.currentTimeMillis(),
                                state = DraftState.Ready(deployment.key.id, accountRevision),
                                sendError = null,
                            )
                        else it
                    }
            )
        }
    }

    fun sendFailed(id: String, reason: String) = update { state ->
        state.copy(
            drafts = state.drafts.map { if (it.id == id) it.copy(sendError = reason) else it }
        )
    }

    fun recordSent(draft: Draft) = update {
        it.copy(sent = (listOf(SentRecord(draft.sites, System.currentTimeMillis())) + it.sent).take(20))
    }

    fun beginDestroy(id: String) {
        update {
            it.copy(
                drafts = it.drafts.filterNot { draft -> draft.id == id },
                pendingProfileDeletions = it.pendingProfileDeletions + id,
            )
        }
        val file = envelopeFile(id)
        AtomicFile(file).delete()
        requireMessage(
            !file.exists() &&
                !File(file.path + ".new").exists() &&
                !File(file.path + ".bak").exists()
        ) {
            R.string.envelope_delete_error
        }
    }

    fun profileDeleted(id: String) = update {
        it.copy(pendingProfileDeletions = it.pendingProfileDeletions - id)
    }

    fun clearAccountAndDevice() {
        update {
            it.copy(
                account = null,
                accountRevision = it.accountRevision + 1,
                deviceName = Build.MODEL.take(64),
                sent = emptyList(),
            )
        }
        accountCipher.deleteKey()
    }
}
