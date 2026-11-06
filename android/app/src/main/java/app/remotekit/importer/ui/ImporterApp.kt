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
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import app.remotekit.importer.BuildConfig
import app.remotekit.importer.R
import app.remotekit.importer.payload.httpUrl
import app.remotekit.importer.store.Draft
import app.remotekit.importer.store.DraftState
import kotlinx.coroutines.delay

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ImporterApp(vm: AppViewModel = viewModel()) {
    val screen by vm.screen.collectAsStateWithLifecycle()
    val pending by vm.pendingPairing.collectAsStateWithLifecycle()
    val progress by vm.progress.collectAsStateWithLifecycle()
    val sending by vm.sending.collectAsStateWithLifecycle()
    val cleaning by vm.cleaning.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(vm) { vm.messages.collect { snackbar.showSnackbar(it) } }
    if (!vm.supported || vm.startupError != null) {
        BlockingScreen(vm.startupError)
        return
    }
    Box(Modifier.fillMaxSize()) {
        when (val current = screen) {
            Screen.Home -> HomeScreen(vm)
            Screen.Settings -> SettingsScreen(vm)
            Screen.Scan -> ScanScreen(vm)
            is Screen.Login -> LoginScreen(vm, current.id)
        }
        SnackbarHost(
            snackbar,
            Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 80.dp),
        )
    }
    pending?.let {
        AlertDialog(
            onDismissRequest = { vm.pendingPairing.value = null },
            title = { Text(stringResource(R.string.replace_pair_title)) },
            text = { Text(stringResource(R.string.replace_pair_body)) },
            confirmButton = {
                TextButton(onClick = vm::confirmPairing) { Text(stringResource(R.string.confirm)) }
            },
            dismissButton = {
                TextButton(onClick = { vm.pendingPairing.value = null }) {
                    Text(stringResource(R.string.cancel))
                }
            },
        )
    }
    if (cleaning) {
        AlertDialog(
            onDismissRequest = {},
            title = { Text(stringResource(R.string.clearing_data)) },
            text = { LinearProgressIndicator(Modifier.fillMaxWidth()) },
            confirmButton = {},
        )
    }
    progress?.let { rows ->
        ModalBottomSheet(
            onDismissRequest = { if (!sending) vm.progress.value = null },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            sheetGesturesEnabled = !sending,
            properties = ModalBottomSheetProperties(shouldDismissOnBackPress = !sending),
            dragHandle = null,
        ) {
            Column(Modifier.fillMaxWidth().padding(24.dp)) {
                Text(
                    stringResource(if (sending) R.string.sending else R.string.send_complete),
                    style = MaterialTheme.typography.titleLarge,
                )
                LazyColumn(Modifier.weight(1f, fill = false).padding(vertical = 16.dp)) {
                    items(rows, key = { it.id }) { row ->
                        Row(
                            Modifier.fillMaxWidth().padding(vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(16.dp),
                        ) {
                            if (!row.finished) CircularProgressIndicator(Modifier.size(24.dp))
                            else
                                Text(
                                    if (row.error == null) "✓" else "!",
                                    color =
                                        if (row.error == null) MaterialTheme.colorScheme.primary
                                        else MaterialTheme.colorScheme.error,
                                )
                            Column(Modifier.weight(1f)) {
                                Text(row.name, style = MaterialTheme.typography.titleMedium)
                                Text(
                                    row.error
                                        ?: stringResource(
                                            if (row.finished) R.string.send_success
                                            else R.string.waiting
                                        ),
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            }
                        }
                    }
                }
                Button(
                    onClick = { vm.progress.value = null },
                    enabled = !sending,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(stringResource(R.string.close))
                }
            }
        }
    }
}

@Composable
private fun BlockingScreen(error: String?) {
    val context = LocalContext.current
    Surface(Modifier.fillMaxSize()) {
        Column(
            Modifier.safeDrawingPadding().padding(24.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                stringResource(R.string.webview_required),
                style = MaterialTheme.typography.headlineSmall,
            )
            Spacer(Modifier.height(16.dp))
            Text(
                if (error == null) stringResource(R.string.webview_required_body)
                else stringResource(R.string.startup_error, error)
            )
            Spacer(Modifier.height(24.dp))
            if (error == null)
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HomeScreen(vm: AppViewModel) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val selected by vm.selected.collectAsStateWithLifecycle()
    val selecting by vm.selecting.collectAsStateWithLifecycle()
    var paste by rememberSaveable { mutableStateOf(false) }
    var pairOptions by rememberSaveable { mutableStateOf(false) }
    var create by rememberSaveable { mutableStateOf(false) }
    var sendConfirm by rememberSaveable { mutableStateOf(false) }
    var deleteConfirm by rememberSaveable { mutableStateOf(false) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(60000)
            now = System.currentTimeMillis()
        }
    }
    BackHandler(selecting) { vm.clearSelection() }
    Scaffold(
        topBar = {
            if (selecting)
                TopAppBar(
                    title = { Text(stringResource(R.string.select_count, selected.size)) },
                    navigationIcon = {
                        TextButton(onClick = vm::clearSelection) {
                            Text(stringResource(R.string.close))
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
                        TextButton(onClick = { vm.screen.value = Screen.Settings }) {
                            Text(stringResource(R.string.settings))
                        }
                    },
                )
        },
        bottomBar = {
            if (selecting)
                BottomAppBar {
                    Button(
                        onClick = { sendConfirm = true },
                        enabled = vm.selectedReady().isNotEmpty(),
                        modifier = Modifier.padding(horizontal = 16.dp).weight(1f),
                    ) {
                        Text(stringResource(R.string.send_count, vm.selectedReady().size))
                    }
                    TextButton(
                        onClick = { deleteConfirm = true },
                        enabled = selected.isNotEmpty(),
                        modifier = Modifier.padding(end = 16.dp),
                    ) {
                        Text(stringResource(R.string.delete))
                    }
                }
        },
        floatingActionButton = {
            if (!selecting)
                ExtendedFloatingActionButton(
                    onClick = {
                        if (snapshot.pairing == null) pairOptions = true else create = true
                    }
                ) {
                    Text(stringResource(R.string.new_login))
                }
        },
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 104.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                ElevatedCard(Modifier.fillMaxWidth()) {
                    Column(
                        Modifier.padding(20.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        val pairing = snapshot.pairing
                        if (pairing == null) {
                            Text(
                                stringResource(R.string.pair_explanation),
                                style = MaterialTheme.typography.bodyLarge,
                            )
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Button(onClick = { vm.screen.value = Screen.Scan }) {
                                    Text(stringResource(R.string.scan_pair))
                                }
                                OutlinedButton(onClick = { paste = true }) {
                                    Text(stringResource(R.string.paste_pair))
                                }
                            }
                        } else {
                            Text(
                                "${pairing.user} @ ${pairing.server}",
                                style = MaterialTheme.typography.titleMedium,
                            )
                            Text(pairing.mailbox, style = MaterialTheme.typography.bodyMedium)
                            TextButton(onClick = { pairOptions = true }) {
                                Text(stringResource(R.string.repair))
                            }
                        }
                    }
                }
            }
            if (snapshot.drafts.isEmpty())
                item {
                    Text(
                        stringResource(R.string.empty_drafts),
                        Modifier.padding(24.dp),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            items(snapshot.drafts, key = { it.id }) { draft ->
                DraftCard(
                    draft,
                    selecting,
                    draft.id in selected,
                    draft.isCurrent(snapshot.pairing),
                    now,
                    onClick = {
                        if (selecting) vm.toggle(draft.id)
                        else if (snapshot.pairing == null) pairOptions = true
                        else vm.screen.value = Screen.Login(draft.id)
                    },
                    onLongClick = {
                        vm.selecting.value = true
                        vm.toggle(draft.id)
                    },
                )
            }
        }
    }
    if (pairOptions)
        AlertDialog(
            onDismissRequest = { pairOptions = false },
            title = { Text(stringResource(R.string.repair)) },
            text = { Text(stringResource(R.string.pair_explanation)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        pairOptions = false
                        vm.screen.value = Screen.Scan
                    }
                ) {
                    Text(stringResource(R.string.scan_pair))
                }
            },
            dismissButton = {
                TextButton(
                    onClick = {
                        pairOptions = false
                        paste = true
                    }
                ) {
                    Text(stringResource(R.string.paste_pair))
                }
            },
        )
    if (paste)
        PasteDialog(onDismiss = { paste = false }, onPair = { if (vm.pair(it)) paste = false })
    if (create)
        CreateSheet(
            onDismiss = { create = false },
            onCreate = { name, url -> if (vm.create(name, url)) create = false },
        )
    if (sendConfirm)
        ConfirmDialog(
            stringResource(R.string.send_confirm),
            stringResource(R.string.send_confirm_body, vm.selectedReady().size),
            onDismiss = { sendConfirm = false },
            onConfirm = {
                sendConfirm = false
                vm.sendSelected()
            },
        )
    if (deleteConfirm)
        ConfirmDialog(
            stringResource(R.string.delete),
            stringResource(R.string.delete_confirm, selected.size),
            onDismiss = { deleteConfirm = false },
            onConfirm = {
                deleteConfirm = false
                vm.deleteSelected()
            },
        )
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun DraftCard(
    draft: Draft,
    selecting: Boolean,
    selected: Boolean,
    current: Boolean,
    now: Long,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
) {
    Card(Modifier.fillMaxWidth().combinedClickable(onClick = onClick, onLongClick = onLongClick)) {
        Row(
            Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (selecting) Checkbox(checked = selected, onCheckedChange = { onClick() })
            else
                Surface(
                    Modifier.size(44.dp),
                    shape = CircleShape,
                    color = MaterialTheme.colorScheme.secondaryContainer,
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Text(
                            draft.name.take(1).uppercase(),
                            style = MaterialTheme.typography.titleLarge,
                        )
                    }
                }
            Column(Modifier.weight(1f)) {
                Text(
                    draft.name,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    Uri.parse(draft.url).host.orEmpty(),
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    relativeTime(now - draft.updatedAt),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                val status =
                    when {
                        draft.state is DraftState.LoggingIn -> stringResource(R.string.logging_in)
                        !current -> stringResource(R.string.pairing_changed)
                        draft.sendError != null ->
                            stringResource(R.string.send_failed, draft.sendError)
                        else -> stringResource(R.string.ready)
                    }
                SuggestionChip(
                    onClick = onClick,
                    label = { Text(status, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                )
            }
        }
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
private fun PasteDialog(onDismiss: () -> Unit, onPair: (String) -> Unit) {
    var code by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.paste_pair)) },
        text = {
            OutlinedTextField(
                value = code,
                onValueChange = { code = it },
                label = { Text(stringResource(R.string.pair_code)) },
                modifier = Modifier.fillMaxWidth(),
                minLines = 3,
                maxLines = 6,
            )
        },
        confirmButton = {
            TextButton(onClick = { onPair(code) }, enabled = code.isNotBlank()) {
                Text(stringResource(R.string.confirm))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) }
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CreateSheet(onDismiss: () -> Unit, onCreate: (String, String) -> Unit) {
    var name by rememberSaveable { mutableStateOf("") }
    var url by rememberSaveable { mutableStateOf("https://") }
    val validName = name.isNotBlank() && name.codePointCount(0, name.length) <= 128
    val validUrl = runCatching { httpUrl(url) }.isSuccess
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    ) {
        Column(
            Modifier.fillMaxWidth().imePadding().padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(stringResource(R.string.new_login), style = MaterialTheme.typography.titleLarge)
            OutlinedTextField(
                name,
                { name = it },
                Modifier.fillMaxWidth(),
                label = { Text(stringResource(R.string.site_name)) },
                singleLine = true,
                isError = name.isNotEmpty() && !validName,
            )
            OutlinedTextField(
                url,
                { url = it },
                Modifier.fillMaxWidth(),
                label = { Text(stringResource(R.string.start_url)) },
                singleLine = true,
                isError = url != "https://" && !validUrl,
            )
            Button(
                onClick = { onCreate(name, url) },
                enabled = validName && validUrl,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.create))
            }
        }
    }
}

@Composable
fun ConfirmDialog(title: String, text: String, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(text) },
        confirmButton = {
            TextButton(onClick = onConfirm) { Text(stringResource(R.string.confirm)) }
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
    var name by rememberSaveable(snapshot.deviceName) { mutableStateOf(snapshot.deviceName) }
    var clear by rememberSaveable { mutableStateOf(false) }
    BackHandler { vm.screen.value = Screen.Home }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings)) },
                navigationIcon = {
                    TextButton(onClick = { vm.screen.value = Screen.Home }) {
                        Text(stringResource(R.string.back))
                    }
                },
            )
        }
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding).imePadding(),
            contentPadding = PaddingValues(24.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            item {
                OutlinedTextField(
                    name,
                    { name = it },
                    Modifier.fillMaxWidth(),
                    label = { Text(stringResource(R.string.device_name)) },
                    singleLine = true,
                )
                TextButton(
                    onClick = {
                        runCatching { vm.store.setDeviceName(name.trim()) }
                            .onFailure(vm::notifyError)
                    },
                    enabled = name.isNotBlank() && name.codePointCount(0, name.length) <= 64,
                ) {
                    Text(stringResource(R.string.save))
                }
            }
            item {
                Text(stringResource(R.string.sender), style = MaterialTheme.typography.titleMedium)
                Text(
                    if (vm.mail.configured) "${BuildConfig.SMTP_FROM}\n${BuildConfig.SMTP_HOST}"
                    else stringResource(R.string.no_sender)
                )
            }
            item {
                OutlinedButton(onClick = { clear = true }) {
                    Text(stringResource(R.string.clear_all))
                }
            }
            item {
                Text(
                    stringResource(R.string.version, BuildConfig.VERSION_NAME),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
    if (clear)
        ConfirmDialog(
            stringResource(R.string.clear_all),
            stringResource(R.string.clear_confirm),
            onDismiss = { clear = false },
            onConfirm = {
                clear = false
                vm.clearAll()
            },
        )
}
