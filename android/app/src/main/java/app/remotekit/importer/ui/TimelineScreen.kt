package app.remotekit.importer.ui

import android.graphics.BitmapFactory
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import app.remotekit.importer.protocol.*
import app.remotekit.importer.store.*
import java.text.DateFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Base64
import java.util.Date
import kotlinx.coroutines.delay

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TimelineScreen(vm: AppViewModel) {
    val state by vm.snapshot.collectAsStateWithLifecycle()
    val refreshing by vm.refreshing.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val unfinished = state.unfinished()
    LaunchedEffect(lifecycle, unfinished) {
        if (unfinished)
            lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
                while (true) {
                    delay(60_000)
                    vm.poll()
                }
            }
    }
    val pending =
        state.outgoing.count {
            !it.retired && it.seq > state.ackedByControl && it.lastSentAt == null
        }
    val visible =
        state.outgoing.asReversed().filter { meta ->
            !meta.hidden &&
                (meta.type != "import" || state.requests.any { it.id == meta.requestId })
        }
    val days = visible.groupBy { day(it.at) }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("会话导入") },
                actions = {
                    IconButton(onClick = vm::sync, enabled = !refreshing) {
                        Icon(Icons.Filled.Refresh, "同步")
                    }
                    IconButton(onClick = { vm.screen.value = Screen.Settings }) {
                        Icon(Icons.Filled.Settings, "设置")
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(LocalSnackbar.current) },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = vm::create,
                icon = { Icon(Icons.Filled.Add, null) },
                text = { Text("新建登录") },
            )
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = vm::poll,
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
            LazyColumn(
                Modifier.fillMaxSize(),
                contentPadding = PaddingValues(16.dp, 4.dp, 16.dp, 112.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item { ConnectionHeader(state, vm.deployment?.server.orEmpty()) }
                if (!vm.supported)
                    item {
                        Banner(
                            Icons.Filled.Warning,
                            "需要更新 Android System WebView 才能打开网站登录。",
                            Tone.Error,
                        )
                    }
                if (state.sendMode is SendMode.Series && pending > 0)
                    item { SeriesBar(pending) { vm.send() } }
                if (visible.isEmpty()) item { EmptyState() }
                days.forEach { (date, events) ->
                    item(key = "day-$date") { SectionLabel(dayLabel(date)) }
                    items(events, key = { it.seq }) { meta -> RequestCard(state, meta, vm) }
                }
            }
        }
    }
}

@Composable
private fun ConnectionHeader(state: AppSnapshot, server: String) {
    val colors = MaterialTheme.colorScheme
    Surface(
        color = colors.surfaceContainerLow,
        shape = RoundedCornerShape(20.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            val pairMeta = (state.pairing as? Pairing.Pairing)?.let { p -> state.outgoing.find { it.seq == p.seq } }
            val pairFailed = pairMeta?.sendError != null
            when (state.pairing) {
                is Pairing.Paired ->
                    IconBadge(Icons.Filled.Check, 40.dp, colors.primaryContainer, colors.onPrimaryContainer)
                is Pairing.Pairing if pairFailed ->
                    IconBadge(Icons.Filled.Warning, 40.dp, colors.errorContainer, colors.onErrorContainer)
                // Static on purpose: the reply can take a day when RemoteKit is offline.
                is Pairing.Pairing ->
                    IconBadge(Icons.Filled.Email, 40.dp, colors.secondaryContainer, colors.onSecondaryContainer)
                else ->
                    IconBadge(Icons.Filled.Lock, 40.dp, colors.errorContainer, colors.onErrorContainer)
            }
            Column(Modifier.weight(1f)) {
                val (title, detail) =
                    when (val pairing = state.pairing) {
                        is Pairing.Paired -> "已连接 · ${pairing.username}" to server
                        is Pairing.Pairing ->
                            when {
                                pairFailed -> "配对请求没能发出" to "展开下方记录可以重试"
                                pairMeta?.firstSentAt == null ->
                                    "配对请求等待发送" to "稍后会自动发出"
                                else ->
                                    "配对请求已发出" to
                                        "RemoteKit 处理后会回信，可能要等一段时间。可以先离开，回信到达后这里会更新。"
                            }
                        is Pairing.Unpaired -> "未配对" to (pairing.reason ?: server)
                        Pairing.Revoked -> "设备已被移除" to "清除本机数据后可以重新配对"
                    }
                Text(title, style = MaterialTheme.typography.titleSmall)
                Text(
                    detail,
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun SeriesBar(pending: Int, onSend: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.secondaryContainer,
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            Modifier.padding(start = 16.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "$pending 个事件攒着，完成这一组操作后一起发送",
                Modifier.weight(1f),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSecondaryContainer,
            )
            FilledTonalButton(onClick = onSend) {
                Icon(Icons.AutoMirrored.Filled.Send, null, Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("发送")
            }
        }
    }
}

@Composable
private fun Banner(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String, tone: Tone) {
    val (background, foreground) = tone.colors()
    Surface(color = background, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
        Row(
            Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Icon(icon, null, tint = foreground)
            Text(text, style = MaterialTheme.typography.bodyMedium, color = foreground)
        }
    }
}

@Composable
private fun EmptyState() {
    val colors = MaterialTheme.colorScheme
    Column(
        Modifier.fillMaxWidth().padding(top = 48.dp, start = 24.dp, end = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        IconBadge(Icons.Filled.Add, 64.dp, colors.surfaceContainerHigh, colors.onSurfaceVariant)
        Spacer(Modifier.height(4.dp))
        Text("还没有登录记录", style = MaterialTheme.typography.titleMedium)
        Text(
            "点「新建登录」打开网站完成登录，登录状态会发送到 RemoteKit，手机上不留数据。",
            style = MaterialTheme.typography.bodyMedium,
            color = colors.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}

private enum class Tone {
    Neutral,
    Progress,
    Success,
    Error;

    @Composable
    fun colors(): Pair<Color, Color> {
        val colors = MaterialTheme.colorScheme
        val dark = colors.surface.luminance() < 0.5f
        return when (this) {
            Neutral -> colors.surfaceContainerHighest to colors.onSurfaceVariant
            Progress -> colors.secondaryContainer to colors.onSecondaryContainer
            Success ->
                if (dark) Color(0xFF1F4D2C) to Color(0xFFB7EFC0)
                else Color(0xFFD4F1D9) to Color(0xFF0E5225)
            Error -> colors.errorContainer to colors.onErrorContainer
        }
    }

    @Composable
    fun accent(): Color {
        val colors = MaterialTheme.colorScheme
        val dark = colors.surface.luminance() < 0.5f
        return when (this) {
            Neutral -> colors.outline
            Progress -> colors.primary
            Success -> if (dark) Color(0xFF7FD48F) else Color(0xFF2E7D3E)
            Error -> colors.error
        }
    }
}

private fun Color.luminance() = 0.2126f * red + 0.7152f * green + 0.0722f * blue

private fun replyText(event: ControlEvent): String =
    when (event) {
        is ControlEvent.Paired -> "配对成功，账户 ${event.username}"
        is ControlEvent.PairRejected -> event.reason
        is ControlEvent.ImportReceived -> "RemoteKit 已收到，等待写入浏览器"
        is ControlEvent.ImportApplied ->
            buildString {
                append("已写入浏览器：Cookie ${event.cookies.applied} 项")
                if (event.cookies.rejected > 0) append("（${event.cookies.rejected} 项被拒绝）")
                append("，本地存储 ${event.localStorage.applied} 项")
                if (event.localStorage.rejected > 0)
                    append("（${event.localStorage.rejected} 项被拒绝）")
            }
        is ControlEvent.ImportFailed -> event.reason
        is ControlEvent.ImportDiscarded -> "已在 RemoteKit 放弃"
        is ControlEvent.Revoked -> "设备已被 RemoteKit 移除"
    }

private fun replyTone(event: ControlEvent): Tone =
    when (event) {
        is ControlEvent.Paired,
        is ControlEvent.ImportApplied -> Tone.Success
        is ControlEvent.ImportReceived -> Tone.Progress
        is ControlEvent.ImportDiscarded -> Tone.Neutral
        is ControlEvent.PairRejected,
        is ControlEvent.ImportFailed,
        is ControlEvent.Revoked -> Tone.Error
    }

@Composable
private fun RequestCard(state: AppSnapshot, meta: EventMeta, vm: AppViewModel) {
    var expanded by remember(meta.seq) { mutableStateOf(false) }
    var deleting by remember(meta.seq) { mutableStateOf(false) }
    val colors = MaterialTheme.colorScheme
    val request = state.requests.find { it.id == meta.requestId }
    val replies = state.controlEvents.filter { it.ref() == meta.seq }.sortedBy { it.at }
    val title =
        when (meta.type) {
            "pair" -> "配对这台手机"
            "withdraw" -> "撤回导入"
            else -> request?.sites?.joinToString("、") { it.name } ?: "导入"
        }
    val (status, tone) =
        when (replies.lastOrNull()) {
            is ControlEvent.ImportApplied -> "已导入" to Tone.Success
            is ControlEvent.Paired -> "已配对" to Tone.Success
            is ControlEvent.ImportReceived -> "等待写入" to Tone.Progress
            is ControlEvent.ImportDiscarded -> "已放弃" to Tone.Neutral
            is ControlEvent.ImportFailed,
            is ControlEvent.PairRejected -> "失败" to Tone.Error
            else ->
                when {
                    meta.retired || meta.sendError != null -> "失败" to Tone.Error
                    meta.firstSentAt != null -> "已发送" to Tone.Progress
                    else -> "待发送" to Tone.Neutral
                }
        }
    val retry =
        when {
            request != null &&
                state.latestImport(request.id)?.seq == meta.seq &&
                state.retryable(request.id) -> { -> vm.retry(request.id) }
            meta.type != "import" && meta.sendError != null -> { -> vm.send() }
            else -> null
        }
    ElevatedCard(
        onClick = { expanded = !expanded },
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.elevatedCardColors(containerColor = colors.surfaceContainerLow),
        elevation = CardDefaults.elevatedCardElevation(defaultElevation = 0.dp),
        shape = RoundedCornerShape(20.dp),
    ) {
        Column(Modifier.padding(16.dp).animateContentSize()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Leading(meta, request)
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        title,
                        style = MaterialTheme.typography.titleMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        listOfNotNull(
                                clock(meta.at),
                                request?.let { "Cookie ${it.cookies} · 存储 ${it.storageItems}" },
                            )
                            .joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.width(8.dp))
                StatusPill(status, tone)
            }
            val sendError = meta.sendError
            if (replies.isNotEmpty() || sendError != null)
                Column(
                    Modifier.padding(start = 19.dp, top = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    replies.forEach { reply -> ReplyLine(replyText(reply), clock(reply.at), replyTone(reply)) }
                    if (sendError != null) ReplyLine("发送失败：$sendError", null, Tone.Error)
                }
            AnimatedVisibility(expanded) {
                Column(Modifier.padding(top = 14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    HorizontalDivider(color = colors.outlineVariant)
                    Spacer(Modifier.height(4.dp))
                    request?.sites?.forEach { site -> Detail(site.name, site.url) }
                    Detail("创建", full(meta.at))
                    meta.firstSentAt?.let { Detail("首次发送", full(it)) }
                    meta.lastSentAt?.takeIf { it != meta.firstSentAt }?.let { Detail("最近发送", full(it)) }
                    Detail("事件序号", "#${meta.seq}")
                    replies.forEach { Detail("回信 #${it.seq}", full(it.at)) }
                    Row(
                        Modifier.fillMaxWidth().padding(top = 6.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
                    ) {
                        TextButton(
                            onClick = { deleting = true },
                            colors = ButtonDefaults.textButtonColors(contentColor = colors.error),
                        ) {
                            Icon(Icons.Filled.Delete, null, Modifier.size(18.dp))
                            Spacer(Modifier.width(6.dp))
                            Text("删除")
                        }
                        if (retry != null)
                            FilledTonalButton(onClick = retry) {
                                Icon(Icons.Filled.Refresh, null, Modifier.size(18.dp))
                                Spacer(Modifier.width(6.dp))
                                Text("重试")
                            }
                    }
                }
            }
            if (!expanded)
                Icon(
                    Icons.Filled.KeyboardArrowDown,
                    "展开",
                    Modifier.align(Alignment.CenterHorizontally).size(20.dp),
                    tint = colors.outline,
                )
            else
                Icon(
                    Icons.Filled.KeyboardArrowUp,
                    "收起",
                    Modifier.align(Alignment.CenterHorizontally).size(20.dp),
                    tint = colors.outline,
                )
        }
    }
    if (deleting) {
        val pendingImport = request != null && meta.type == "import" && state.mayBePending(request.id)
        ConfirmDialog(
            title = "删除这条记录？",
            text =
                if (pendingImport) "RemoteKit 还没有写入这次登录。删除会同时通知 RemoteKit 撤回。"
                else "只从这台手机的时间线中移除，不影响 RemoteKit 上已导入的数据。",
            confirm = "删除",
            destructive = true,
            onDismiss = { deleting = false },
            onConfirm = {
                deleting = false
                if (request != null && meta.type == "import") vm.delete(request.id)
                else vm.store.hideEvent(meta.seq)
            },
        )
    }
}

@Composable
private fun Leading(meta: EventMeta, request: ImportRequest?) {
    val colors = MaterialTheme.colorScheme
    when {
        meta.type == "pair" ->
            IconBadge(Icons.Filled.Lock, 40.dp, colors.primaryContainer, colors.onPrimaryContainer)
        meta.type == "withdraw" ->
            IconBadge(Icons.Filled.Delete, 40.dp, colors.surfaceContainerHighest, colors.onSurfaceVariant)
        request != null && request.sites.size > 1 ->
            Box(Modifier.size(40.dp)) {
                request.sites.take(2).forEachIndexed { index, site ->
                    Box(
                        Modifier.align(if (index == 0) Alignment.TopStart else Alignment.BottomEnd)
                            .border(2.dp, colors.surfaceContainerLow, CircleShape)
                            .padding(2.dp)
                    ) {
                        RequestSiteIcon(site, 26.dp)
                    }
                }
            }
        request != null && request.sites.isNotEmpty() -> RequestSiteIcon(request.sites.first(), 40.dp)
        else -> IconBadge(Icons.AutoMirrored.Filled.Send, 40.dp, colors.surfaceContainerHighest, colors.onSurfaceVariant)
    }
}

@Composable
private fun StatusPill(text: String, tone: Tone) {
    val (background, foreground) = tone.colors()
    Surface(color = background, shape = CircleShape) {
        Text(
            text,
            Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            style = MaterialTheme.typography.labelMedium,
            color = foreground,
        )
    }
}

@Composable
private fun ReplyLine(text: String, time: String?, tone: Tone) {
    Row(verticalAlignment = Alignment.Top) {
        Box(
            Modifier.padding(top = 6.dp).size(8.dp).background(tone.accent(), CircleShape)
        )
        Spacer(Modifier.width(12.dp))
        Text(
            text,
            Modifier.weight(1f),
            style = MaterialTheme.typography.bodyMedium,
        )
        if (time != null) {
            Spacer(Modifier.width(8.dp))
            Text(
                time,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
    }
}

@Composable
private fun Detail(label: String, value: String) {
    Row {
        Text(
            label,
            Modifier.width(88.dp),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(value, style = MaterialTheme.typography.bodySmall)
    }
}

private val zone: ZoneId = ZoneId.systemDefault()

private fun day(at: Long): LocalDate = Instant.ofEpochMilli(at).atZone(zone).toLocalDate()

private fun dayLabel(date: LocalDate): String {
    val today = LocalDate.now(zone)
    return when (date) {
        today -> "今天"
        today.minusDays(1) -> "昨天"
        else ->
            date.format(
                DateTimeFormatter.ofPattern(if (date.year == today.year) "M月d日" else "yyyy年M月d日")
            )
    }
}

private fun clock(at: Long): String =
    Instant.ofEpochMilli(at).atZone(zone).format(DateTimeFormatter.ofPattern("HH:mm"))

private fun full(at: Long): String =
    DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(at))

@Composable
private fun RequestSiteIcon(site: SiteRef, size: androidx.compose.ui.unit.Dp) {
    val bitmap =
        remember(site.icon) {
            site.icon?.let { encoded ->
                runCatching {
                        val bytes = Base64.getDecoder().decode(encoded)
                        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
                    }
                    .getOrNull()
            }
        }
    SiteIcon(bitmap, site.name, size)
}
