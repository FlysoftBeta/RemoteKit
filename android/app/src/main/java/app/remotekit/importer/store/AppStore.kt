package app.remotekit.importer.store

import android.content.Context
import android.os.Build
import android.util.AtomicFile
import app.remotekit.importer.R
import app.remotekit.importer.pairing.ContractJson
import app.remotekit.importer.pairing.Pairing
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
    data class Ready(val pairingKeyId: String, val tokenHash: String) : DraftState
}

@Serializable
data class Draft(
    val id: String,
    val name: String,
    val url: String,
    val updatedAt: Long,
    val state: DraftState = DraftState.LoggingIn,
    val sendError: String? = null,
) {
    fun isCurrent(pairing: Pairing?): Boolean =
        pairing != null &&
            state is DraftState.Ready &&
            state.pairingKeyId == pairing.key.id &&
            state.tokenHash == pairing.tokenHash
}

@Serializable
data class AppSnapshot(
    val pairing: Pairing? = null,
    val deviceName: String = Build.MODEL.take(64),
    val drafts: List<Draft> = emptyList(),
    val pendingProfileDeletions: Set<String> = emptySet(),
)

class AppStore(context: Context) {
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

    fun pair(pairing: Pairing) = update { it.copy(pairing = pairing) }

    fun setDeviceName(name: String) {
        requireMessage(name.isNotBlank() && name.codePointCount(0, name.length) <= 64) {
            R.string.device_name_limit
        }
        update { it.copy(deviceName = name) }
    }

    fun createDraft(name: String, url: String): Draft {
        val draft = Draft(UUID.randomUUID().toString(), name, url, System.currentTimeMillis())
        update { it.copy(drafts = listOf(draft) + it.drafts) }
        return draft
    }

    private fun envelopeFile(id: String): File {
        requireMessage(UUID.fromString(id).toString() == id)
        return File(envelopes, "$id.rksi")
    }

    fun readEnvelope(draft: Draft): ByteArray = envelopeFile(draft.id).readBytes()

    fun ready(id: String, pairing: Pairing, url: String, envelope: ByteArray) {
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
            requireMessage(state.pairing == pairing) { R.string.pairing_reexport }
            state.copy(
                drafts =
                    state.drafts.map {
                        if (it.id == id)
                            it.copy(
                                url = url,
                                updatedAt = System.currentTimeMillis(),
                                state = DraftState.Ready(pairing.key.id, pairing.tokenHash),
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

    fun clearPairingAndDevice() = update {
        it.copy(pairing = null, deviceName = Build.MODEL.take(64))
    }
}
