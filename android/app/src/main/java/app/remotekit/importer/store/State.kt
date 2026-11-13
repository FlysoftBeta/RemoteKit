package app.remotekit.importer.store

import app.remotekit.importer.protocol.*
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
sealed interface Pairing {
    @Serializable
    @SerialName("unpaired")
    data class Unpaired(val reason: String?) : app.remotekit.importer.store.Pairing

    @Serializable
    @SerialName("pairing")
    data class Pairing(val seq: Long) : app.remotekit.importer.store.Pairing

    @Serializable
    @SerialName("paired")
    data class Paired(val username: String) : app.remotekit.importer.store.Pairing

    @Serializable @SerialName("revoked") data object Revoked : app.remotekit.importer.store.Pairing
}

fun Pairing.authorized() = this is Pairing.Paired || this is Pairing.Pairing

@Serializable
sealed interface SendMode {
    @Serializable
    @SerialName("window")
    data class Window(val seconds: Int) : SendMode {
        init {
            require(seconds in setOf(0, 60, 300))
        }
    }

    @Serializable @SerialName("series") data object Series : SendMode
}

/** Where the next inbox poll resumes: the UID watermark within one UIDVALIDITY, else `since`. */
@Serializable
data class InboxCursor(
    val since: Long,
    val uidValidity: Long?,
    val uid: Long?,
    val cleanedAt: Long,
)

@Serializable
data class StoredDevice(val id: String, val publicKey: String, val encryptedPrivateKey: String)

@Serializable data class SiteRef(val name: String, val url: String, val icon: String?)

@Serializable
data class EventMeta(
    val seq: Long,
    val at: Long,
    val type: String,
    val requestId: String?,
    val firstSentAt: Long?,
    val lastSentAt: Long?,
    val sendError: String?,
    val retired: Boolean,
    val sealedBlob: String?,
    val hidden: Boolean,
)

@Serializable
data class ImportRequest(
    val id: String,
    val sites: List<SiteRef>,
    val createdAt: Long,
    val payloadBlob: String?,
    val cookies: Int,
    val storageItems: Int,
)

enum class RequestStatus(val label: String) {
    Queued("待发送"),
    Sent("已发送"),
    Received("已收到·等待写入"),
    Applied("已导入"),
    Failed("失败"),
    Discarded("已放弃"),
}

@Serializable
data class AppSnapshot(
    val v: Int,
    val device: StoredDevice,
    val deviceName: String,
    val pairing: Pairing,
    val nextDeviceSeq: Long,
    val outgoing: List<EventMeta>,
    val ackedByControl: Long,
    val appliedControlSeq: Long,
    val controlEvents: List<ControlEvent>,
    val buffered: List<String>,
    val requests: List<ImportRequest>,
    val pairBlob: String?,
    val sendMode: SendMode,
    val pendingProfileDeletions: Set<String>,
    val inbox: InboxCursor,
) {
    fun validate() {
        require(v == VERSION) { "不支持的本地数据版本：$v" }
        require(nextDeviceSeq > 0 && ackedByControl in 0 until nextDeviceSeq)
        require(appliedControlSeq >= 0)
        validateDeviceName(deviceName)
        require(outgoing.all { it.seq in 1 until nextDeviceSeq && it.at >= 0 })
        require(outgoing.zipWithNext().all { (a, b) -> b.seq == a.seq + 1 })
        require(outgoing.all { it.type in setOf("pair", "import", "withdraw") })
        controlEvents.forEach { ControlMessage(ack = 0, events = listOf(it)).validate() }
        require(controlEvents.all { it.seq <= appliedControlSeq })
        require(requests.all { it.createdAt >= 0 && it.cookies >= 0 && it.storageItems >= 0 })
        require(inbox.since >= 0 && inbox.cleanedAt >= 0)
        require(inbox.uidValidity == null || inbox.uidValidity > 0)
        require(inbox.uid == null || (inbox.uid >= 0 && inbox.uidValidity != null))
    }

    companion object {
        const val VERSION = 2
    }

    fun latestImport(id: String) = outgoing.lastOrNull { it.requestId == id && it.type == "import" }

    fun reply(id: String): ControlEvent? {
        val seq = latestImport(id)?.seq ?: return null
        return controlEvents.lastOrNull { it.ref() == seq }
    }

    fun status(id: String): RequestStatus =
        when (reply(id)) {
            is ControlEvent.ImportApplied -> RequestStatus.Applied
            is ControlEvent.ImportDiscarded -> RequestStatus.Discarded
            is ControlEvent.ImportFailed -> RequestStatus.Failed
            is ControlEvent.ImportReceived -> RequestStatus.Received
            else -> {
                val meta = latestImport(id)
                when {
                    meta?.retired == true || meta?.sendError != null -> RequestStatus.Failed
                    meta?.firstSentAt != null -> RequestStatus.Sent
                    else -> RequestStatus.Queued
                }
            }
        }

    fun retryable(id: String): Boolean {
        if (requests.none { it.id == id && it.payloadBlob != null }) return false
        val meta = latestImport(id) ?: return false
        return meta.retired ||
            meta.sendError != null ||
            (reply(id) as? ControlEvent.ImportFailed)?.retryable == true
    }

    fun mayBePending(id: String): Boolean =
        pairing !is Pairing.Revoked &&
            latestImport(id)?.retired != true &&
            reply(id) !is ControlEvent.ImportFailed &&
            status(id) !in setOf(RequestStatus.Applied, RequestStatus.Discarded)

    fun unfinished() =
        pairing is Pairing.Pairing ||
            requests.any { mayBePending(it.id) } ||
            outgoing.any { it.type == "withdraw" && !it.retired && it.seq > ackedByControl }
}

/** Pure stream reducer. Blob removal happens after the resulting snapshot is committed. */
fun AppSnapshot.applyMessage(message: ControlMessage): AppSnapshot? {
    message.validate()
    require(message.ack < nextDeviceSeq)
    val first = message.events.firstOrNull()
    if (first != null && first.seq > appliedControlSeq + 1) return null
    var state = copy(ackedByControl = maxOf(ackedByControl, message.ack))
    for (event in message.events) {
        if (event.seq == 0L) {
            val rejection = event as ControlEvent.PairRejected
            if ((state.pairing as? Pairing.Pairing)?.seq != rejection.ref) continue
            state =
                state.copy(
                    pairing = Pairing.Unpaired(rejection.reason),
                    pairBlob = null,
                    outgoing =
                        state.outgoing.map {
                            if (it.seq >= rejection.ref) it.copy(retired = true) else it
                        },
                    controlEvents = state.controlEvents + event,
                )
            continue
        }
        if (event.seq <= state.appliedControlSeq) continue
        state =
            state.copy(appliedControlSeq = event.seq, controlEvents = state.controlEvents + event)
        state =
            when (event) {
                is ControlEvent.Paired ->
                    if ((state.pairing as? Pairing.Pairing)?.seq == event.ref)
                        state.copy(pairing = Pairing.Paired(event.username), pairBlob = null)
                    else state
                is ControlEvent.Revoked ->
                    state.copy(
                        pairing = Pairing.Revoked,
                        pairBlob = null,
                        outgoing = state.outgoing.map { it.copy(retired = true) },
                    )
                is ControlEvent.ImportApplied ->
                    state.copy(
                        requests =
                            state.requests.map {
                                if (it.id == event.id) it.copy(payloadBlob = null) else it
                            }
                    )
                is ControlEvent.ImportDiscarded ->
                    state.copy(
                        requests =
                            state.requests.map {
                                if (it.id == event.id) it.copy(payloadBlob = null) else it
                            }
                    )
                else -> state
            }
    }
    return state
}
