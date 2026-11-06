package app.remotekit.importer.protocol

import app.remotekit.importer.R
import app.remotekit.importer.payload.*
import app.remotekit.importer.requireMessage
import java.util.UUID
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
sealed interface DeviceEvent {
    val seq: Long
    val at: Long

    @Serializable
    @SerialName("pair")
    data class Pair(
        override val seq: Long,
        override val at: Long,
        val username: String,
        val password: String,
        val code: List<String>,
        val device: String,
    ) : DeviceEvent {
        fun validate() {
            requireMessage(username.codePointCount(0, username.length) in 1..64) {
                R.string.username_limit
            }
            requireMessage(password.codePointCount(0, password.length) in 1..256) {
                R.string.password_limit
            }
            validateDeviceName(device)
            require(code.size == 5 && code.all { it.matches(Regex("[a-z]+")) })
        }
    }

    @Serializable
    @SerialName("import")
    data class Import(
        override val seq: Long,
        override val at: Long,
        val id: String,
        val sites: List<ImportSite>,
        val cookies: List<ImportCookie>,
        val localStorage: List<OriginStorage>,
    ) : DeviceEvent {
        fun payload() = ImportPayload(id, sites, cookies, localStorage)
    }

    @Serializable
    @SerialName("withdraw")
    data class Withdraw(override val seq: Long, override val at: Long, val id: String) :
        DeviceEvent
}

fun validateDeviceName(name: String) {
    requireMessage(name.isNotBlank() && name.codePointCount(0, name.length) <= 64) {
        R.string.device_name_limit
    }
}

fun ImportPayload.event(seq: Long, at: Long) =
    DeviceEvent.Import(seq, at, id, sites, cookies, localStorage)

@Serializable data class Counts(val applied: Int, val rejected: Int)

@Serializable
sealed interface ControlEvent {
    val seq: Long
    val at: Long

    @Serializable
    @SerialName("paired")
    data class Paired(
        override val seq: Long,
        override val at: Long,
        val ref: Long,
        val username: String,
    ) : ControlEvent

    @Serializable
    @SerialName("pairRejected")
    data class PairRejected(
        override val seq: Long,
        override val at: Long,
        val ref: Long,
        val reason: String,
    ) : ControlEvent

    @Serializable
    @SerialName("importReceived")
    data class ImportReceived(
        override val seq: Long,
        override val at: Long,
        val ref: Long,
        val id: String,
    ) : ControlEvent

    @Serializable
    @SerialName("importApplied")
    data class ImportApplied(
        override val seq: Long,
        override val at: Long,
        val ref: Long,
        val id: String,
        val cookies: Counts,
        val localStorage: Counts,
    ) : ControlEvent

    @Serializable
    @SerialName("importFailed")
    data class ImportFailed(
        override val seq: Long,
        override val at: Long,
        val ref: Long,
        val id: String,
        val reason: String,
        val retryable: Boolean,
    ) : ControlEvent

    @Serializable
    @SerialName("importDiscarded")
    data class ImportDiscarded(
        override val seq: Long,
        override val at: Long,
        val ref: Long,
        val id: String,
    ) : ControlEvent

    @Serializable
    @SerialName("revoked")
    data class Revoked(override val seq: Long, override val at: Long) : ControlEvent
}

fun ControlEvent.ref(): Long? =
    when (this) {
        is ControlEvent.Paired -> ref
        is ControlEvent.PairRejected -> ref
        is ControlEvent.ImportReceived -> ref
        is ControlEvent.ImportApplied -> ref
        is ControlEvent.ImportFailed -> ref
        is ControlEvent.ImportDiscarded -> ref
        is ControlEvent.Revoked -> null
    }

@Serializable
data class DeviceMessage(val v: Int = 2, val ack: Long, val events: List<DeviceEvent>) {
    fun validate() {
        require(v == 2 && ack >= 0)
        require(events.all { it.seq > 0 && it.at >= 0 })
        require(events.zipWithNext().all { (a, b) -> b.seq == a.seq + 1 })
        events.forEach { event ->
            when (event) {
                is DeviceEvent.Pair -> event.validate()
                is DeviceEvent.Import -> event.payload().validate()
                is DeviceEvent.Withdraw -> {
                    val uuid = UUID.fromString(event.id)
                    require(
                        uuid.version() == 4 && uuid.variant() == 2 && uuid.toString() == event.id
                    )
                }
            }
        }
    }
}

@Serializable
data class ControlMessage(val v: Int = 2, val ack: Long, val events: List<ControlEvent>) {
    fun validate() {
        require(v == 2 && ack >= 0)
        require(events.all { it.at >= 0 && (it.seq > 0 || it is ControlEvent.PairRejected) })
        require(events.none { it is ControlEvent.PairRejected && it.seq != 0L })
        require(
            events.none { it.seq == 0L } ||
                (events.size == 1 && events.single() is ControlEvent.PairRejected)
        )
        require(events.zipWithNext().all { (a, b) -> b.seq == a.seq + 1 })
        events.forEach {
            require(it.ref()?.let { ref -> ref > 0 } != false)
            if (it is ControlEvent.ImportApplied) {
                require(
                    listOf(
                            it.cookies.applied,
                            it.cookies.rejected,
                            it.localStorage.applied,
                            it.localStorage.rejected,
                        )
                        .all { n -> n >= 0 }
                )
            }
        }
    }
}
