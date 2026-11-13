package app.remotekit.importer.store

import android.content.Context
import android.os.Build
import app.remotekit.importer.crypto.*
import app.remotekit.importer.deployment.ContractJson
import app.remotekit.importer.payload.ImportPayload
import app.remotekit.importer.protocol.*
import java.io.File
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.nio.file.StandardCopyOption
import java.util.Base64
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.encodeToString

class LocalDataException(cause: Exception) :
    Exception("${cause.javaClass.simpleName}: ${cause.message ?: "读取失败"}", cause)

class AppStore(
    private val directory: File,
    private val cipher: BlobCipher,
    private val defaultDeviceName: String,
    private val controlPublic: ByteArray? = null,
) {
    constructor(
        context: Context,
        controlPublic: ByteArray?,
    ) : this(context.filesDir, LocalCipher(), Build.MODEL.take(64), controlPublic)

    private val stateFile = File(directory, "state.json")
    private val blobs = File(directory, "blobs")
    private val mutable = MutableStateFlow(read())
    val snapshot = mutable.asStateFlow()

    init {
        cleanupBlobs()
    }

    private fun fresh(): AppSnapshot {
        val key = DeviceKey.generate()
        val now = System.currentTimeMillis()
        return AppSnapshot(
            v = AppSnapshot.VERSION,
            device =
                StoredDevice(key.id, base64(key.publicKey), base64(cipher.encrypt(key.privateKey))),
            deviceName = defaultDeviceName,
            pairing = Pairing.Unpaired(null),
            nextDeviceSeq = 1,
            outgoing = emptyList(),
            ackedByControl = 0,
            appliedControlSeq = 0,
            controlEvents = emptyList(),
            buffered = emptyList(),
            requests = emptyList(),
            pairBlob = null,
            sendMode = SendMode.Window(60),
            pendingProfileDeletions = emptySet(),
            inbox = InboxCursor(now, null, null, now),
        )
    }

    private fun read(): AppSnapshot {
        directory.mkdirs()
        val text =
            try {
                Files.newBufferedReader(stateFile.toPath(), Charsets.UTF_8).use { it.readText() }
            } catch (_: NoSuchFileException) {
                return fresh().also(::write)
            } catch (error: Exception) {
                throw LocalDataException(error)
            }
        return try {
            ContractJson.decodeFromString<AppSnapshot>(text).also { it.validate() }
        } catch (error: Exception) {
            throw LocalDataException(error)
        }
    }

    private fun atomicWrite(file: File, bytes: ByteArray) {
        file.parentFile?.mkdirs()
        val temporary = File(file.parentFile, file.name + ".new")
        temporary.outputStream().use { stream ->
            stream.write(bytes)
            stream.fd.sync()
        }
        Files.move(
            temporary.toPath(),
            file.toPath(),
            StandardCopyOption.ATOMIC_MOVE,
            StandardCopyOption.REPLACE_EXISTING,
        )
    }

    private fun write(state: AppSnapshot) =
        atomicWrite(stateFile, ContractJson.encodeToString(state).toByteArray(Charsets.UTF_8))

    @Synchronized
    private fun update(transform: (AppSnapshot) -> AppSnapshot) {
        val transformed = transform(mutable.value)
        val next =
            transformed.copy(
                outgoing =
                    transformed.outgoing.map {
                        if (it.seq <= transformed.ackedByControl || it.retired)
                            it.copy(sealedBlob = null)
                        else it
                    }
            )
        write(next)
        mutable.value = next
        cleanupBlobs()
    }

    private fun cleanupBlobs() {
        val state = mutable.value
        val live =
            state.buffered +
                listOfNotNull(state.pairBlob) +
                state.requests.mapNotNull { it.payloadBlob } +
                state.outgoing.mapNotNull { it.sealedBlob }
        blobs.listFiles()?.filter { it.name !in live }?.forEach { it.delete() }
    }

    private fun blob(bytes: ByteArray): String {
        val id = UUID.randomUUID().toString()
        atomicWrite(File(blobs, id), cipher.encrypt(bytes))
        return id
    }

    private inline fun <reified T> save(value: T) =
        blob(ContractJson.encodeToString(value).toByteArray(Charsets.UTF_8))

    private inline fun <reified T> load(id: String): T =
        ContractJson.decodeFromString(
            cipher.decrypt(File(blobs, id).readBytes()).toString(Charsets.UTF_8)
        )

    @Synchronized
    fun deviceKey() =
        DeviceKey(
            cipher.decrypt(Base64.getDecoder().decode(snapshot.value.device.encryptedPrivateKey))
        )

    fun authorized() = snapshot.value.pairing.authorized()

    private fun requireAuthorization() {
        check(authorized()) { "请先配对设备" }
    }

    private fun metadata(event: DeviceEvent, type: String, id: String? = null): EventMeta {
        val message = DeviceMessage(ack = snapshot.value.appliedControlSeq, events = listOf(event))
        message.validate()
        val sealed = controlPublic?.let {
            blob(Envelope.seal(ContractJson.encodeToString(message), deviceKey(), it))
        }
        return EventMeta(
            seq = event.seq,
            at = event.at,
            type = type,
            requestId = id,
            firstSentAt = null,
            lastSentAt = null,
            sendError = null,
            retired = false,
            sealedBlob = sealed,
            hidden = false,
        )
    }

    @Synchronized
    fun pair(
        username: String,
        password: String,
        code: List<String>,
        device: String,
        now: Long = System.currentTimeMillis(),
    ) {
        check(snapshot.value.pairing is Pairing.Unpaired)
        val event =
            DeviceEvent.Pair(
                snapshot.value.nextDeviceSeq,
                now,
                username,
                password,
                code.map { it.trim().lowercase() },
                device,
            )
        event.validate()
        val content = save<DeviceEvent>(event)
        val meta = metadata(event, "pair")
        update {
            it.copy(
                pairing = Pairing.Pairing(event.seq),
                pairBlob = content,
                deviceName = device,
                nextDeviceSeq = event.seq + 1,
                outgoing = it.outgoing + meta,
            )
        }
    }

    @Synchronized
    fun addImport(
        payload: ImportPayload,
        sites: List<SiteRef>,
        now: Long = System.currentTimeMillis(),
    ) {
        requireAuthorization()
        payload.validate()
        val event = payload.event(snapshot.value.nextDeviceSeq, now)
        val content = save(payload)
        val meta = metadata(event, "import", payload.id)
        val request =
            ImportRequest(
                payload.id,
                sites,
                now,
                content,
                payload.cookies.size,
                payload.localStorage.sumOf { it.items.size },
            )
        update {
            it.copy(
                nextDeviceSeq = event.seq + 1,
                outgoing = it.outgoing + meta,
                requests = it.requests + request,
            )
        }
    }

    @Synchronized
    fun retry(id: String, now: Long = System.currentTimeMillis()) {
        requireAuthorization()
        check(snapshot.value.retryable(id))
        val request = snapshot.value.requests.single { it.id == id }
        val event =
            load<ImportPayload>(requireNotNull(request.payloadBlob))
                .event(snapshot.value.nextDeviceSeq, now)
        val meta = metadata(event, "import", id)
        update { it.copy(nextDeviceSeq = event.seq + 1, outgoing = it.outgoing + meta) }
    }

    @Synchronized
    fun deleteRequest(id: String, now: Long = System.currentTimeMillis()) {
        val state = snapshot.value
        val pending = state.mayBePending(id)
        if (pending) requireAuthorization()
        val event = if (pending) DeviceEvent.Withdraw(state.nextDeviceSeq, now, id) else null
        val meta = event?.let { metadata(it, "withdraw", id) }
        update {
            it.copy(
                requests = it.requests.filterNot { request -> request.id == id },
                outgoing = it.outgoing + listOfNotNull(meta),
                nextDeviceSeq = it.nextDeviceSeq + if (pending) 1 else 0,
            )
        }
    }

    @Synchronized
    fun event(meta: EventMeta): DeviceEvent? =
        when (meta.type) {
            "pair" ->
                snapshot.value.pairBlob
                    ?.let { load<DeviceEvent>(it) }
                    ?.takeIf { it.seq == meta.seq }
            "import" ->
                snapshot.value.requests
                    .find { it.id == meta.requestId }
                    ?.payloadBlob
                    ?.let { load<ImportPayload>(it).event(meta.seq, meta.at) }
            "withdraw" -> DeviceEvent.Withdraw(meta.seq, meta.at, requireNotNull(meta.requestId))
            else -> error("未知事件")
        }

    @Synchronized
    fun sealed(meta: EventMeta): ByteArray =
        cipher.decrypt(File(blobs, requireNotNull(meta.sealedBlob)).readBytes())

    @Synchronized
    fun receive(message: ControlMessage): Boolean {
        message.validate()
        val next = snapshot.value.applyMessage(message)
        if (next == null) {
            val existing = snapshot.value.buffered.any { load<ControlMessage>(it) == message }
            if (!existing) {
                val content = save(message)
                update { it.copy(buffered = it.buffered + content) }
            }
            return false
        }
        update { next }
        while (true) {
            val state = snapshot.value
            val ready = state.buffered.firstOrNull { state.applyMessage(load(it)) != null } ?: break
            val applied = requireNotNull(state.applyMessage(load(ready)))
            update { applied.copy(buffered = applied.buffered - ready) }
        }
        return true
    }

    fun advanceInbox(cursor: InboxCursor) = update { it.copy(inbox = cursor) }

    fun sent(sequences: Set<Long>, now: Long = System.currentTimeMillis()) = update { state ->
        state.copy(
            outgoing =
                state.outgoing.map {
                    if (it.seq in sequences)
                        it.copy(
                            firstSentAt = it.firstSentAt ?: now,
                            lastSentAt = now,
                            sendError = null,
                        )
                    else it
                }
        )
    }

    fun sendFailed(sequences: Set<Long>, reason: String) = update { state ->
        state.copy(
            outgoing =
                state.outgoing.map { if (it.seq in sequences) it.copy(sendError = reason) else it }
        )
    }

    fun setDeviceName(name: String) {
        validateDeviceName(name)
        update { it.copy(deviceName = name) }
    }

    fun hideEvent(seq: Long) = update { state ->
        state.copy(
            outgoing = state.outgoing.map { if (it.seq == seq) it.copy(hidden = true) else it }
        )
    }

    fun setSendMode(mode: SendMode) = update { it.copy(sendMode = mode) }

    fun beginDestroy(id: String) = update {
        it.copy(pendingProfileDeletions = it.pendingProfileDeletions + id)
    }

    fun profileDeleted(id: String) = update {
        it.copy(pendingProfileDeletions = it.pendingProfileDeletions - id)
    }

    @Synchronized
    fun clearAll() {
        directory.listFiles()?.forEach { check(it.deleteRecursively()) }
        cipher.deleteKey()
        val next = fresh()
        write(next)
        mutable.value = next
    }

    private fun base64(bytes: ByteArray) = Base64.getEncoder().encodeToString(bytes)
}
