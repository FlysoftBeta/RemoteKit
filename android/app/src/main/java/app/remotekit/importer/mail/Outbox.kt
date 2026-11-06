package app.remotekit.importer.mail

import app.remotekit.importer.deployment.ContractJson
import app.remotekit.importer.protocol.*
import app.remotekit.importer.store.*
import kotlinx.serialization.encodeToString

object Outbox {
    fun delaySeconds(mode: SendMode): Int? = (mode as? SendMode.Window)?.seconds

    fun select(state: AppSnapshot, now: Long, sync: Boolean = false): List<EventMeta> {
        val unacked = state.outgoing.filter { it.seq > state.ackedByControl && !it.retired }
        val oldestSent = unacked.firstOrNull()?.lastSentAt
        return if (sync || (oldestSent != null && now - oldestSent >= 3_600_000)) unacked
        else unacked.filter { it.lastSentAt == null }
    }

    fun split(
        events: List<DeviceEvent>,
        ack: Long,
        fits: (DeviceMessage) -> Boolean = Envelope::fits,
    ): List<DeviceMessage> {
        val result = mutableListOf<DeviceMessage>()
        var batch = emptyList<DeviceEvent>()
        for (event in events) {
            if (
                batch.isNotEmpty() &&
                    (event.seq != batch.last().seq + 1 ||
                        !fits(DeviceMessage(ack = ack, events = batch + event)))
            ) {
                result += DeviceMessage(ack = ack, events = batch)
                batch = emptyList()
            }
            require(fits(DeviceMessage(ack = ack, events = listOf(event)))) { "单个事件超过信封限制" }
            batch = batch + event
        }
        if (batch.isNotEmpty()) result += DeviceMessage(ack = ack, events = batch)
        return result
    }

    fun messages(
        store: AppStore,
        control: ByteArray,
        now: Long,
        sync: Boolean,
    ): List<OutgoingMail> {
        val state = store.snapshot.value
        val selected = select(state, now, sync)
        val result = mutableListOf<OutgoingMail>()
        var replayedSealedEvent = false
        var batch = mutableListOf<DeviceEvent>()
        fun flush() {
            split(batch, state.appliedControlSeq).forEach { message ->
                message.validate()
                result +=
                    OutgoingMail(
                        message.events.map { it.seq }.toSet(),
                        Envelope.seal(
                            ContractJson.encodeToString(message),
                            store.deviceKey(),
                            control,
                        ),
                    )
            }
            batch = mutableListOf()
        }
        for (meta in selected) {
            val event = store.event(meta)
            if (event != null) batch += event
            else {
                flush()
                result += OutgoingMail(setOf(meta.seq), store.sealed(meta))
                replayedSealedEvent = true
            }
        }
        flush()
        // A retained envelope carries its original ack. Send the current ack alongside it.
        if ((result.isEmpty() && sync) || replayedSealedEvent) {
            result +=
                OutgoingMail(
                    emptySet(),
                    Envelope.seal(
                        ContractJson.encodeToString(
                            DeviceMessage(ack = state.appliedControlSeq, events = emptyList())
                        ),
                        store.deviceKey(),
                        control,
                    ),
                )
        }
        return result
    }
}

data class OutgoingMail(val sequences: Set<Long>, val envelope: ByteArray)
