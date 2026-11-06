package app.remotekit.importer.ui

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import app.remotekit.importer.BuildConfig
import app.remotekit.importer.R
import app.remotekit.importer.account.validateAccount
import app.remotekit.importer.store.Draft
import app.remotekit.importer.store.DraftState
import app.remotekit.importer.store.SentRecord
import app.remotekit.importer.web.siteKey
import kotlinx.coroutines.delay

private enum class DraftStatus {
    LoggingIn,
    Ready,
    Reexport,
    Failed,
}

private fun Draft.status(current: Boolean): DraftStatus =
    when {
        state is DraftState.LoggingIn -> DraftStatus.LoggingIn
        !current -> DraftStatus.Reexport
        sendError != null -> DraftStatus.Failed
        else -> DraftStatus.Ready
    }

@Composable
private fun Draft.title(): String =
    if (sites.isEmpty()) stringResource(R.string.unfinished_login)
    else sites.joinToString("、") { it.name }

private fun Draft.place(): String =
    if (sites.isEmpty()) lastUrl?.let { Uri.parse(it).host }.orEmpty()
    else sites.joinToString(" · ") { site -> Uri.parse(site.url).host?.let(::siteKey).orEmpty() }

@OptIn(ExperimentalMaterial3Api::class)
internal val LocalSnackbar = staticCompositionLocalOf { SnackbarHostState() }

@Composable
fun ImporterApp(vm: AppViewModel = viewModel()) {
    val screen by vm.screen.collectAsStateWithLifecycle()
    val progress by vm.progress.collectAsStateWithLifecycle()
    val sending by vm.sending.collectAsStateWithLifecycle()
    val cleaning by vm.cleaning.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(vm) { vm.messages.collect { snackbar.showSnackbar(it) } }
    if (!vm.supported || vm.startupError != null || vm.deployment == null) {
        BlockingScreen(vm.startupError, vm.deployment == null)
        return
    }
    CompositionLocalProvider(LocalSnackbar provides snackbar) {
        when (val current = screen) {
            Screen.Home -> HomeScreen(vm)
            Screen.Settings -> SettingsScreen(vm)
            is Screen.Login -> LoginScreen(vm, current.id)
        }
    }
    if (cleaning) {
        AlertDialog(
            onDismissRequest = {},
            title = { Text(stringResource(R.string.clearing_data)) },
            text = { LinearProgressIndicator(Modifier.fillMaxWidth()) },
            confirmButton = {},
        )
    }
    progress?.let { rows -> SendSheet(rows, sending) { vm.progress.value = null } }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SendSheet(rows: List<SendProgress>, sending: Boolean, close: () -> Unit) {
    val done = rows.count { it.finished }
    val failed = rows.count { it.finished && it.error != null }
    ModalBottomSheet(
        onDismissRequest = { if (!sending) close() },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        sheetGesturesEnabled = !sending,
        properties = ModalBottomSheetProperties(shouldDismissOnBackPress = !sending),
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 24.dp)) {
            Text(
                when {
                    sending -> stringResource(R.string.sending)
                    failed == 0 -> stringResource(R.string.send_complete)
                    failed == rows.size -> stringResource(R.string.send_all_failed)
                    else -> stringResource(R.string.send_some_failed, failed)
                },
                style = MaterialTheme.typography.titleLarge,
            )
            Spacer(Modifier.height(12.dp))
            LinearProgressIndicator(
                progress = { if (rows.isEmpty()) 1f else done.toFloat() / rows.size },
                modifier = Modifier.fillMaxWidth(),
            )
            LazyColumn(Modifier.weight(1f, fill = false).padding(vertical = 8.dp)) {
                items(rows, key = { it.id }) { row ->
                    ListItem(
                        leadingContent = {
                            Box(Modifier.size(28.dp), contentAlignment = Alignment.Center) {
                                when {
                                    !row.finished ->
                                        CircularProgressIndicator(
                                            Modifier.size(22.dp),
                                            strokeWidth = 2.5.dp,
                                        )
                                    row.error == null ->
                                        Icon(
                                            Icons.Filled.CheckCircle,
                                            null,
                                            tint = MaterialTheme.colorScheme.primary,
                                        )
                                    else ->
                                        Icon(
                                            Icons.Filled.Warning,
                                            null,
                                            tint = MaterialTheme.colorScheme.error,
                                        )
                                }
                            }
                        },
                        headlineContent = { Text(row.name, maxLines = 1) },
                        supportingContent = {
                            Text(
                                row.error
                                    ?: stringResource(
                                        if (row.finished) R.string.send_success
                                        else R.string.waiting
                                    ),
                                color =
                                    if (row.error != null) MaterialTheme.colorScheme.error
                                    else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        },
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    )
                }
            }
            Button(onClick = close, enabled = !sending, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.close))
            }
        }
    }
}

@Composable
private fun BlockingScreen(error: String?, missingDeployment: Boolean) {
    val context = LocalContext.current
    Surface(Modifier.fillMaxSize()) {
        Column(
            Modifier.safeDrawingPadding().padding(32.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            IconBadge(Icons.Filled.Warning, MaterialTheme.colorScheme.errorContainer, 72.dp)
            Spacer(Modifier.height(24.dp))
            Text(
                stringResource(
                    when {
                        error != null -> R.string.app_name
                        missingDeployment -> R.string.no_deployment
                        else -> R.string.webview_required
                    }
                ),
                style = MaterialTheme.typography.headlineSmall,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(12.dp))
            Text(
                when {
                    error != null -> stringResource(R.string.startup_error, error)
                    missingDeployment -> stringResource(R.string.no_deployment_body)
                    else -> stringResource(R.string.webview_required_body)
                },
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            if (error == null && !missingDeployment) {
                Spacer(Modifier.height(24.dp))
                Button(
                    onClick = {
                        context.startActivity(
                            Intent(
                                Intent.ACTION_VIEW,
                                Uri.parse(
                                    "https://play.google.com/store/apps/details?id=com.google.android.webview"
                                ),
                            )
                        )
                    }
                ) {
                    Text(stringResource(R.string.update_webview))
                }
            }
        }
    }
}

@Composable
private fun IconBadge(icon: ImageVector, color: Color, size: Dp) {
    Surface(Modifier.size(size), shape = CircleShape, color = color) {
        Box(contentAlignment = Alignment.Center) {
            Icon(icon, null, Modifier.size(size * 0.45f), tint = contentColorFor(color))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HomeScreen(vm: AppViewModel) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val selected by vm.selected.collectAsStateWithLifecycle()
    val selecting by vm.selecting.collectAsStateWithLifecycle()
    var sendConfirm by rememberSaveable { mutableStateOf(false) }
    var deleteConfirm by rememberSaveable { mutableStateOf(false) }
    var accountSheet by rememberSaveable { mutableStateOf(false) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(60000)
            now = System.currentTimeMillis()
        }
    }
    BackHandler(selecting) { vm.clearSelection() }
    val statuses = snapshot.drafts.associate { it.id to it.status(it.isCurrent(vm.deployment, snapshot)) }
    val sendable = setOf(DraftStatus.Ready, DraftStatus.Failed)
    val ready = snapshot.drafts.filter { statuses[it.id] in sendable }
    val other = snapshot.drafts.filter { statuses[it.id] !in sendable }
    val scroll = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
    Scaffold(
        snackbarHost = { SnackbarHost(LocalSnackbar.current) },
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        topBar = {
            if (selecting)
                TopAppBar(
                    title = { Text(stringResource(R.string.select_count, selected.size)) },
                    navigationIcon = {
                        IconButton(onClick = vm::clearSelection) {
                            Icon(Icons.Filled.Close, stringResource(R.string.close))
                        }
                    },
                    actions = {
                        TextButton(
                            onClick = { vm.selected.value = snapshot.drafts.map { it.id }.toSet() }
                        ) {
                            Text(stringResource(R.string.select_all))
                        }
                    },
                )
            else
                LargeTopAppBar(
                    title = { Text(stringResource(R.string.home_title)) },
                    actions = {
                        IconButton(onClick = { vm.screen.value = Screen.Settings }) {
                            Icon(Icons.Filled.Settings, stringResource(R.string.settings))
                        }
                    },
                    scrollBehavior = scroll,
                )
        },
        bottomBar = {
            if (selecting)
                BottomAppBar(
                    actions = {
                        IconButton(
                            onClick = { deleteConfirm = true },
                            enabled = selected.isNotEmpty(),
                        ) {
                            Icon(Icons.Filled.Delete, stringResource(R.string.delete))
                        }
                    },
                    floatingActionButton = {
                        ExtendedFloatingActionButton(
                            onClick = {
                                if (vm.selectedReady().isNotEmpty()) sendConfirm = true
                            },
                            icon = { Icon(Icons.AutoMirrored.Filled.Send, null) },
                            text = {
                                Text(stringResource(R.string.send_count, vm.selectedReady().size))
                            },
                            elevation = FloatingActionButtonDefaults.bottomAppBarFabElevation(),
                        )
                    },
                )
            else if (ready.isNotEmpty())
                Surface(tonalElevation = 3.dp, shadowElevation = 3.dp) {
                    Row(
                        Modifier.fillMaxWidth()
                            .navigationBarsPadding()
                            .padding(horizontal = 16.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text(
                            stringResource(R.string.ready_summary, ready.size),
                            Modifier.weight(1f),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Button(
                            onClick = {
                                vm.selected.value = ready.map { it.id }.toSet()
                                sendConfirm = true
                            }
                        ) {
                            Icon(Icons.AutoMirrored.Filled.Send, null, Modifier.size(18.dp))
                            Spacer(Modifier.width(8.dp))
                            Text(stringResource(R.string.send_all))
                        }
                    }
                }
        },
        floatingActionButton = {
            if (!selecting)
                ExtendedFloatingActionButton(
                    onClick = vm::create,
                    icon = { Icon(Icons.Filled.Add, null) },
                    text = { Text(stringResource(R.string.new_login)) },
                )
        },
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp, 4.dp, 16.dp, 96.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item {
                AccountCard(
                    username = snapshot.account?.username,
                    server = vm.deployment?.server.orEmpty(),
                    onEdit = { accountSheet = true },
                )
            }
            if (snapshot.drafts.isEmpty()) item { EmptyState() }
            if (ready.isNotEmpty()) item { SectionLabel(stringResource(R.string.section_ready)) }
            items(ready, key = { it.id }) { draft ->
                DraftRow(vm, draft, statuses.getValue(draft.id), selecting, draft.id in selected, now)
            }
            if (other.isNotEmpty()) item { SectionLabel(stringResource(R.string.section_other)) }
            items(other, key = { it.id }) { draft ->
                DraftRow(vm, draft, statuses.getValue(draft.id), selecting, draft.id in selected, now)
            }
            if (snapshot.sent.isNotEmpty() && !selecting) {
                item { SectionLabel(stringResource(R.string.section_sent)) }
                item { SentCard(snapshot.sent.take(5), now) }
            }
        }
    }
    if (accountSheet) AccountSheet(vm) { accountSheet = false }
    if (sendConfirm)
        ConfirmDialog(
            stringResource(R.string.send_confirm),
            stringResource(R.string.send_confirm_body, vm.selectedReady().size),
            confirm = stringResource(R.string.send),
            onDismiss = {
                sendConfirm = false
                if (!selecting) vm.clearSelection()
            },
            onConfirm = {
                sendConfirm = false
                vm.sendSelected()
            },
        )
    if (deleteConfirm)
        ConfirmDialog(
            stringResource(R.string.delete),
            stringResource(R.string.delete_confirm, selected.size),
            confirm = stringResource(R.string.delete),
            destructive = true,
            onDismiss = { deleteConfirm = false },
            onConfirm = {
                deleteConfirm = false
                vm.deleteSelected()
            },
        )
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text,
        Modifier.padding(start = 4.dp, top = 16.dp, bottom = 4.dp),
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.primary,
    )
}

@Composable
private fun AccountCard(username: String?, server: String, onEdit: () -> Unit) {
    if (username == null) {
        Card(
            Modifier.fillMaxWidth(),
            colors =
                CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
        ) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.Person, null)
                    Spacer(Modifier.width(12.dp))
                    Text(
                        stringResource(R.string.account_setup_title),
                        style = MaterialTheme.typography.titleMedium,
                    )
                }
                Text(stringResource(R.string.account_prompt), style = MaterialTheme.typography.bodyMedium)
                Button(onClick = onEdit, modifier = Modifier.align(Alignment.End)) {
                    Text(stringResource(R.string.account_setup))
                }
            }
        }
        return
    }
    OutlinedCard(Modifier.fillMaxWidth()) {
        ListItem(
            leadingContent = {
                Surface(
                    Modifier.size(40.dp),
                    shape = CircleShape,
                    color = MaterialTheme.colorScheme.primaryContainer,
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Text(
                            username.take(1).uppercase(),
                            style = MaterialTheme.typography.titleMedium,
                            color = MaterialTheme.colorScheme.onPrimaryContainer,
                        )
                    }
                }
            },
            headlineContent = { Text(username, fontWeight = FontWeight.Medium) },
            supportingContent = { Text(server, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            trailingContent = {
                TextButton(onClick = onEdit) { Text(stringResource(R.string.modify)) }
            },
            colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        )
    }
}

@Composable
private fun EmptyState() {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 40.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        IconBadge(Icons.Filled.Lock, MaterialTheme.colorScheme.secondaryContainer, 64.dp)
        Spacer(Modifier.height(16.dp))
        Text(stringResource(R.string.empty_drafts), style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(20.dp))
        listOf(R.string.step_login, R.string.step_done, R.string.step_send).forEachIndexed {
            index,
            step ->
            Row(
                Modifier.fillMaxWidth().padding(vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Surface(
                    Modifier.size(24.dp),
                    shape = CircleShape,
                    color = MaterialTheme.colorScheme.surfaceVariant,
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Text("${index + 1}", style = MaterialTheme.typography.labelMedium)
                    }
                }
                Spacer(Modifier.width(12.dp))
                Text(
                    stringResource(step),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun DraftRow(
    vm: AppViewModel,
    draft: Draft,
    status: DraftStatus,
    selecting: Boolean,
    selected: Boolean,
    now: Long,
) {
    val onClick = {
        if (selecting) vm.toggle(draft.id) else vm.screen.value = Screen.Login(draft.id)
    }
    Surface(
        shape = MaterialTheme.shapes.large,
        color =
            if (selected) MaterialTheme.colorScheme.secondaryContainer
            else MaterialTheme.colorScheme.surfaceContainerLow,
        modifier =
            Modifier.fillMaxWidth()
                .combinedClickable(
                    onClick = onClick,
                    onLongClick = {
                        vm.selecting.value = true
                        vm.toggle(draft.id)
                    },
                ),
    ) {
        Row(
            Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            if (selecting) Checkbox(checked = selected, onCheckedChange = { onClick() })
            else SiteIcon(rememberIcon(draft.sites.firstOrNull()?.icon), draft.title(), 42.dp)
            Column(Modifier.weight(1f)) {
                Text(
                    draft.title(),
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    listOf(draft.place(), relativeTime(now - draft.updatedAt)).filter(String::isNotEmpty).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (status == DraftStatus.Failed && draft.sendError != null)
                    Text(
                        draft.sendError,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
            }
            StatusPill(status)
        }
    }
}

@Composable
private fun StatusPill(status: DraftStatus) {
    val colors = MaterialTheme.colorScheme
    val (text, background, foreground) =
        when (status) {
            DraftStatus.Ready ->
                Triple(R.string.ready, colors.primaryContainer, colors.onPrimaryContainer)
            DraftStatus.LoggingIn ->
                Triple(R.string.logging_in, colors.surfaceVariant, colors.onSurfaceVariant)
            DraftStatus.Reexport ->
                Triple(R.string.needs_reexport, colors.tertiaryContainer, colors.onTertiaryContainer)
            DraftStatus.Failed ->
                Triple(R.string.send_failed_short, colors.errorContainer, colors.onErrorContainer)
        }
    Surface(shape = CircleShape, color = background) {
        Text(
            stringResource(text),
            Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            style = MaterialTheme.typography.labelMedium,
            color = foreground,
        )
    }
}

@Composable
private fun relativeTime(age: Long): String =
    when {
        age < 60000 -> stringResource(R.string.just_now)
        age < 3600000 -> stringResource(R.string.minutes_ago, age / 60000)
        age < 86400000 -> stringResource(R.string.hours_ago, age / 3600000)
        else -> stringResource(R.string.days_ago, age / 86400000)
    }

@Composable
fun ConfirmDialog(
    title: String,
    text: String,
    confirm: String,
    destructive: Boolean = false,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(text) },
        confirmButton = {
            TextButton(
                onClick = onConfirm,
                colors =
                    if (destructive)
                        ButtonDefaults.textButtonColors(
                            contentColor = MaterialTheme.colorScheme.error
                        )
                    else ButtonDefaults.textButtonColors(),
            ) {
                Text(confirm)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) }
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsScreen(vm: AppViewModel) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    var accountSheet by rememberSaveable { mutableStateOf(false) }
    var name by rememberSaveable(snapshot.deviceName) { mutableStateOf(snapshot.deviceName) }
    var clear by rememberSaveable { mutableStateOf(false) }
    BackHandler { vm.screen.value = Screen.Home }
    Scaffold(
        snackbarHost = { SnackbarHost(LocalSnackbar.current) },
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings)) },
                navigationIcon = {
                    IconButton(onClick = { vm.screen.value = Screen.Home }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back))
                    }
                },
            )
        }
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding).imePadding(),
            contentPadding = PaddingValues(horizontal = 20.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { SectionLabel(stringResource(R.string.remotekit_account)) }
            item {
                ListItem(
                    leadingContent = { Icon(Icons.Filled.Person, null) },
                    headlineContent = {
                        Text(snapshot.account?.username ?: stringResource(R.string.account_unset))
                    },
                    supportingContent = {
                        Text(stringResource(R.string.account_hint, vm.deployment?.server.orEmpty()))
                    },
                    trailingContent = {
                        TextButton(onClick = { accountSheet = true }) {
                            Text(stringResource(R.string.modify))
                        }
                    },
                    colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                )
            }
            item { SectionLabel(stringResource(R.string.this_device)) }
            item {
                OutlinedTextField(
                    name,
                    { name = it },
                    Modifier.fillMaxWidth(),
                    label = { Text(stringResource(R.string.device_name)) },
                    supportingText = { Text(stringResource(R.string.device_name_hint)) },
                    singleLine = true,
                    trailingIcon = {
                        if (name != snapshot.deviceName)
                            TextButton(
                                onClick = {
                                    runCatching { vm.store.setDeviceName(name.trim()) }
                                        .onFailure(vm::notifyError)
                                },
                                enabled =
                                    name.isNotBlank() && name.codePointCount(0, name.length) <= 64,
                            ) {
                                Text(stringResource(R.string.save))
                            }
                    },
                )
            }
            item {
                OutlinedButton(
                    onClick = { clear = true },
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    colors =
                        ButtonDefaults.outlinedButtonColors(
                            contentColor = MaterialTheme.colorScheme.error
                        ),
                ) {
                    Text(stringResource(R.string.clear_all))
                }
            }
            item {
                Text(
                    stringResource(R.string.version, BuildConfig.VERSION_NAME),
                    Modifier.fillMaxWidth().padding(vertical = 16.dp),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
    if (accountSheet) AccountSheet(vm) { accountSheet = false }
    if (clear)
        ConfirmDialog(
            stringResource(R.string.clear_all),
            stringResource(R.string.clear_confirm),
            confirm = stringResource(R.string.clear),
            destructive = true,
            onDismiss = { clear = false },
            onConfirm = {
                clear = false
                vm.clearAll()
            },
        )
}

@Composable
private fun SentCard(records: List<SentRecord>, now: Long) {
    OutlinedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(vertical = 4.dp)) {
            records.forEach { record ->
                ListItem(
                    leadingContent = {
                        SiteIcon(
                            rememberIcon(record.sites.firstOrNull()?.icon),
                            record.sites.firstOrNull()?.name.orEmpty(),
                            36.dp,
                        )
                    },
                    headlineContent = {
                        Text(
                            record.sites.joinToString("、") { it.name },
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    },
                    supportingContent = {
                        Text(
                            stringResource(R.string.sent_at, relativeTime(now - record.sentAt)),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    },
                    colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                )
            }
            Text(
                stringResource(R.string.sent_hint),
                Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AccountSheet(vm: AppViewModel, close: () -> Unit) {
    val account =
        remember { runCatching { vm.store.account() }.onFailure(vm::notifyError).getOrNull() }
    var username by rememberSaveable { mutableStateOf(account?.username.orEmpty()) }
    var password by rememberSaveable { mutableStateOf(account?.password.orEmpty()) }
    var confirm by rememberSaveable { mutableStateOf(account?.password.orEmpty()) }
    var showPassword by remember { mutableStateOf(false) }
    val sending by vm.sending.collectAsStateWithLifecycle()
    val cleaning by vm.cleaning.collectAsStateWithLifecycle()
    val exporting by vm.exporting.collectAsStateWithLifecycle()
    val editable = !sending && !cleaning && !exporting
    val mismatch = confirm.isNotEmpty() && confirm != password
    val changed =
        username != account?.username.orEmpty() || password != account?.password.orEmpty()
    val valid =
        runCatching { validateAccount(username, password) }.isSuccess && confirm == password
    val save = {
        vm.saveAccount(username, password)
        close()
    }
    val transformation =
        if (showPassword) VisualTransformation.None else PasswordVisualTransformation()
    ModalBottomSheet(
        onDismissRequest = close,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    ) {
        Column(
            Modifier.fillMaxWidth().imePadding().padding(horizontal = 24.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                stringResource(R.string.remotekit_account),
                style = MaterialTheme.typography.titleLarge,
            )
            Text(
                stringResource(R.string.account_hint, vm.deployment?.server.orEmpty()),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedTextField(
                username,
                { username = it },
                Modifier.fillMaxWidth(),
                label = { Text(stringResource(R.string.username)) },
                singleLine = true,
                enabled = editable,
                keyboardOptions =
                    KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Ascii,
                        imeAction = ImeAction.Next,
                    ),
            )
            OutlinedTextField(
                password,
                { password = it },
                Modifier.fillMaxWidth(),
                label = { Text(stringResource(R.string.password)) },
                singleLine = true,
                enabled = editable,
                keyboardOptions =
                    KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Next),
                visualTransformation = transformation,
                trailingIcon = {
                    TextButton(
                        onClick = { showPassword = !showPassword },
                        modifier = Modifier.focusProperties { canFocus = false },
                    ) {
                        Text(
                            stringResource(
                                if (showPassword) R.string.hide_password else R.string.show_password
                            )
                        )
                    }
                },
            )
            OutlinedTextField(
                confirm,
                { confirm = it },
                Modifier.fillMaxWidth(),
                label = { Text(stringResource(R.string.password_confirm)) },
                singleLine = true,
                enabled = editable,
                isError = mismatch,
                supportingText = {
                    Text(
                        stringResource(
                            if (mismatch) R.string.password_mismatch
                            else R.string.password_unchecked
                        )
                    )
                },
                keyboardOptions =
                    KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { if (editable && changed && valid) save() }),
                visualTransformation = transformation,
            )
            if (account != null && changed)
                Text(
                    stringResource(R.string.account_change_warning),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.tertiary,
                )
            Button(
                onClick = save,
                enabled = editable && changed && valid,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.save_account))
            }
        }
    }
}
